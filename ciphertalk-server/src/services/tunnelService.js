/**
 * Публичный адрес мессенджера.
 *
 * Туннель (Cloudflare) живёт отдельным процессом и пишет свой актуальный
 * адрес в файл .public-url. Сервер читает этот файл и отдаёт адрес
 * клиенту (экран входа, настройки) — чтобы пользователь мог открыть
 * мессенджер с любого устройства и любой сети.
 *
 * Файл читается с кэшем: обращение к диску не должно быть на каждом запросе.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const STATE_FILE = process.env.PUBLIC_URL_FILE
  ? (path.isAbsolute(process.env.PUBLIC_URL_FILE)
      ? process.env.PUBLIC_URL_FILE
      : path.join(config.serverRoot, process.env.PUBLIC_URL_FILE))
  : path.join(config.serverRoot, '.public-url');

const CACHE_MS = 5000;

class TunnelService {
  constructor() {
    this.stateFile = STATE_FILE;
    this.cached = null;
    this.cachedAt = 0;
  }

  /**
   * Актуальное состояние туннеля:
   * { url, mode, updatedAt, available }.
   * url === null — туннель не запущен (или ещё не поднялся).
   */
  getState() {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < CACHE_MS) return this.cached;

    let state = { url: null, mode: null, updatedAt: null, available: false };
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.url === 'string' && /^https:\/\//.test(parsed.url)) {
        state = {
          url: parsed.url.replace(/\/$/, ''),
          mode: parsed.mode || 'quick',
          updatedAt: parsed.updatedAt || null,
          available: true
        };
      }
    } catch (e) {
      // Файла ещё нет — туннель не поднялся
    }

    this.cached = state;
    this.cachedAt = now;
    return state;
  }

  /** Только адрес (или null). */
  getUrl() {
    const s = this.getState();
    return s.available ? s.url : null;
  }

  /** Сбрасывает кэш (после перезапуска туннеля). */
  invalidate() {
    this.cached = null;
    this.cachedAt = 0;
  }
}

module.exports = new TunnelService();
module.exports.TunnelService = TunnelService;
module.exports.STATE_FILE = STATE_FILE;
