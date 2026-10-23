#!/usr/bin/env node
/**
 * Супервизор публичного туннеля (Cloudflare Tunnel).
 *
 * Задачи:
 *  1) держит cloudflared запущенным (рестарт при падении, backoff);
 *  2) перехватывает выданный публичный URL и сохраняет его в .public-url,
 *     чтобы сервер и клиент всегда знали актуальный адрес;
 *  3) периодически проверяет, что туннель действительно отвечает, и
 *     перезапускает его, если адрес перестал работать;
 *  4) умеет работать в двух режимах:
 *       - quick  — `cloudflared tunnel --url ...` (адрес случайный, меняется
 *                  при каждом перезапуске; работает без аккаунта);
 *       - named  — `cloudflared tunnel run <name>` (постоянный адрес
 *                  вида https://messenger.example.com; нужен аккаунт
 *                  Cloudflare и домен в его DNS).
 *
 * Запуск: node scripts/tunnel.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'cloudflared');
const STATE_FILE = path.join(ROOT, '.public-url');
const ORIGIN = process.env.TUNNEL_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`;
const NAMED_TUNNEL = process.env.TUNNEL_NAME || '';
// TUNNEL_MODE: quick (по умолчанию) | named (постоянный адрес)
const TUNNEL_MODE = (process.env.TUNNEL_MODE || (NAMED_TUNNEL ? 'named' : 'quick')).toLowerCase();
const CF_DIR = path.join(os.homedir(), '.cloudflared');
const CF_CONFIG = path.join(CF_DIR, 'config.yml');

// Проверка доступности туннеля
const CHECK_INTERVAL_MS = parseInt(process.env.TUNNEL_CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000;
const MAX_FAILURES = 3;

let child = null;
let restarts = 0;
let failures = 0;
let currentUrl = null;
let lastState = { url: null, mode: null, updatedAt: null };

function log(...args) {
  console.log(`[tunnel ${new Date().toISOString()}]`, ...args);
}

/** Читает имя named-туннеля и hostname из конфига cloudflared. */
function readNamedConfig() {
  if (!fs.existsSync(CF_CONFIG)) return null;
  try {
    const raw = fs.readFileSync(CF_CONFIG, 'utf8');
    const tunnel = raw.match(/^\s*tunnel:\s*(\S+)/m);
    const host = raw.match(/^\s*hostname:\s*(\S+)/m);
    if (!tunnel) return null;
    return { name: tunnel[1], hostname: host ? host[1] : null };
  } catch (e) {
    return null;
  }
}

/** Пишет состояние атомарно, чтобы читатели никогда не увидели половину файла. */
function writeState(url, mode) {
  const payload = {
    url,
    mode,
    updatedAt: new Date().toISOString(),
    origin: ORIGIN
  };
  const tmp = `${STATE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    lastState = payload;
    log('публичный адрес:', url, `(${mode})`);
  } catch (e) {
    log('не удалось сохранить состояние:', e.message);
  }
}

/** Ищет публичный адрес в выводе cloudflared. */
function extractUrl(text) {
  const m = text.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com/i);
  return m ? m[0].replace(/\/$/, '') : null;
}

function start() {
  if (!fs.existsSync(BIN)) {
    log('НЕТ БИНАРНИКА:', BIN);
    process.exit(1);
  }

  const cfg = TUNNEL_MODE === 'named' ? (NAMED_TUNNEL ? { name: NAMED_TUNNEL } : readNamedConfig()) : null;
  const named = cfg;
  const mode = named ? 'named' : 'quick';
  const args = named
    ? ['tunnel', '--no-autoupdate', 'run', named.name]
    : ['tunnel', '--no-autoupdate', '--url', ORIGIN];

  if (TUNNEL_MODE === 'named' && !named) {
    log('РЕЖИМ named, но туннель не найден. Укажите TUNNEL_NAME или выполните npm run tunnel:setup');
  }
  log('режим:', mode, '| origin:', ORIGIN, named ? `| туннель: ${named.name}` : '');

  // В named-режиме адрес известен заранее (из ingress-правила конфига)
  if (named && named.hostname) {
    currentUrl = `https://${named.hostname}`;
    writeState(currentUrl, mode);
  }
  child = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const onChunk = (buf) => {
    const text = buf.toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // cloudflared v2026 печатает JSON-логи, поэтому ищем адрес в любой строке
      const url = extractUrl(line);
      if (url && url !== currentUrl) {
        currentUrl = url;
        writeState(url, mode);
      }
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('exit', (code, signal) => {
    log('cloudflared завершился:', `code=${code}`, `signal=${signal}`);
    child = null;
    currentUrl = null;
    restarts++;
    const delay = Math.min(60_000, 2000 * Math.min(restarts, 10));
    log(`перезапуск через ${Math.round(delay / 1000)} с`);
    setTimeout(start, delay);
  });

  child.on('error', (e) => log('ошибка запуска:', e.message));
}

/** Проверяет, что публичный адрес отвечает. */
async function checkReachability() {
  if (!currentUrl) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${currentUrl}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    log('туннель отвечает:', currentUrl);
    failures = 0;
  } catch (e) {
    failures++;
    log('туннель не отвечает:', e.message, `(ошибок подряд: ${failures}/${MAX_FAILURES})`);
    if (failures >= MAX_FAILURES && child) {
      log('перезапускаю cloudflared');
      failures = 0;
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
  }
}

process.on('SIGTERM', () => { if (child) child.kill('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { if (child) child.kill('SIGINT'); process.exit(0); });

start();
setInterval(checkReachability, CHECK_INTERVAL_MS);

// Периодически дублируем состояние, даже если адрес не менялся:
// так сервер подхватит его после перезапуска.
setInterval(() => {
  if (currentUrl && lastState.url !== currentUrl) writeState(currentUrl, lastState.mode || 'quick');
}, 30_000);

log('супервизор запущен');
