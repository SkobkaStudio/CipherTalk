#!/usr/bin/env node
/**
 * Настройка ПОСТОЯННОГО публичного адреса (Cloudflare named tunnel).
 *
 * Quick-туннель (режим по умолчанию) выдаёт случайный адрес и меняет его при
 * каждом перезапуске. Чтобы адрес был постоянным (https://messenger.example.com),
 * нужен аккаунт Cloudflare и домен, управляемый через его DNS.
 *
 * Что делает скрипт:
 *   1) проверяет бинарник cloudflared;
 *   2) выполняет `cloudflared tunnel login` (откроется браузер) — один раз;
 *   3) создаёт туннель `cloudflared tunnel create <имя>`;
 *   4) привязывает домен `cloudflared tunnel route dns <имя> <хост>`;
 *   5) пишет ~/.cloudflared/config.yml с ingress-правилом на локальный порт.
 *
 * Запуск: npm run tunnel:setup -- [имя-туннеля] [домен]
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'cloudflared');
const CF_DIR = path.join(os.homedir(), '.cloudflared');
const CF_CONFIG = path.join(CF_DIR, 'config.yml');
const CERT = path.join(CF_DIR, 'cert.pem');
const ORIGIN = process.env.TUNNEL_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`;

function log(...a) { console.log('[tunnel-setup]', ...a); }
function fail(msg) { console.error('[tunnel-setup] ОШИБКА:', msg); process.exit(1); }

function run(args, opts = {}) {
  const res = spawnSync(BIN, args, { stdio: 'inherit', ...opts });
  if (res.error) fail(res.error.message);
  return res.status === 0;
}

function ask(question, fallback = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const value = (answer || '').trim() || fallback;
      resolve(value);
    });
  });
}

async function main() {
  if (!fs.existsSync(BIN)) {
    fail(`Нет бинарника ${BIN}. Скопируйте cloudflared в ciphertalk-server/bin/ или установите его в PATH.`);
  }

  const argName = process.argv[2];
  const argHost = process.argv[3];

  log('=== Постоянный публичный адрес (Cloudflare named tunnel) ===');
  log('Понадобится аккаунт Cloudflare и домен, DNS которого обслуживает Cloudflare.');
  log('');

  // 1. Авторизация
  if (!fs.existsSync(CERT)) {
    log('Не найден сертификат Cloudflare. Откроется браузер — войдите в аккаунт Cloudflare.');
    log('Если браузер не открылся, выполните вручную: cloudflared tunnel login');
    if (!run(['tunnel', 'login'])) fail('Не удалось авторизоваться в Cloudflare');
  } else {
    log('Сертификат Cloudflare найден:', CERT);
  }

  // 2. Имя туннеля
  const name = argName || await ask('Имя туннеля [ciphertalk]: ', 'ciphertalk');

  // 3. Создание туннеля (если ещё не создан)
  const credPath = path.join(CF_DIR, `${name}.json`);
  if (fs.existsSync(credPath)) {
    log('Туннель уже создан:', name);
  } else {
    log('Создаём туннель:', name);
    if (!run(['tunnel', 'create', name])) fail('Не удалось создать туннель');
  }

  // 4. Домен
  const host = argHost || await ask('Домен для входа (например messenger.example.com): ');
  if (!host) fail('Нужен домен — без него будет только случайный адрес quick-туннеля');

  log('Привязываем домен:', host);
  if (!run(['tunnel', 'route', 'dns', name, host])) {
    log('ВНИМАНИЕ: не удалось создать DNS-запись. Создайте её вручную в панели Cloudflare:');
    log(`  CNAME ${host} -> ${name}.cfargotunnel.com`);
  }

  // 5. Конфиг cloudflared
  fs.mkdirSync(CF_DIR, { recursive: true });
  const config =
    `tunnel: ${name}\n` +
    `credentials-file: ${credPath}\n` +
    `ingress:\n` +
    `  - hostname: ${host}\n` +
    `    service: ${ORIGIN}\n` +
    `  - service: http_status:404\n`;
  fs.writeFileSync(CF_CONFIG, config, { mode: 0o600 });
  log('Конфиг записан:', CF_CONFIG);

  log('');
  log('Готово. Запуск в постоянном режиме:');
  log(`  TUNNEL_MODE=named TUNNEL_NAME=${name} node scripts/tunnel.js`);
  log('или через pm2:');
  log(`  pm2 restart ciphertalk-tunnel --update-env  (с TUNNEL_NAME=${name} в окружении)`);
  log(`Публичный адрес: https://${host}`);
}

main().catch((e) => fail(e.message));
