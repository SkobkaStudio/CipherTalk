'use strict';

/**
 * Короны CipherTalk — ТОЛЬКО по номеру телефона.
 *
 * Единый источник правды — файл src/config/crowns.json:
 *   { "+79991234567": "gold", "+79997654321": "silver" }
 * Ключ — номер телефона (сравниваются только цифры, формат не важен),
 * значение — уровень: 'gold' | 'silver' | 'bronze'.
 *
 * Дополнительно OWNER_PHONE из .env получает золотую корону.
 *
 * Файл перечитывается автоматически при изменении (fs.watch + проверка mtime),
 * поэтому перезапуск сервера после правки crowns.json не требуется.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LEVELS = new Set(['gold', 'silver', 'bronze']);

// нормализованные цифры телефона -> уровень
let byDigits = new Map();
let lastStat = '';
let watcher = null;

/** Только цифры телефона; 8(9xx) -> 7(9xx). Короткие/мусорные значения -> ''. */
function phoneDigits(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (!digits) return '';
  const fixed = digits.length === 11 && digits[0] === '8' ? '7' + digits.slice(1) : digits;
  // Мусор/короткие записи игнорируем, чтобы случайное «123» не дало совпадение.
  return fixed.length >= 10 ? fixed : '';
}

function loadFromFile() {
  const next = new Map();
  try {
    const raw = fs.readFileSync(config.crownsFile, 'utf8');
    const json = JSON.parse(raw);
    for (const [phone, level] of Object.entries(json)) {
      if (typeof phone !== 'string' || phone.startsWith('_')) continue;
      const lv = String(level || '').trim().toLowerCase();
      const key = phoneDigits(phone);
      if (!key) continue;
      if (!LEVELS.has(lv)) {
        console.warn(`[crowns] пропущен неизвестный уровень "${level}" для ${phone}`);
        continue;
      }
      next.set(key, lv);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[crowns] не удалось прочитать crowns.json:', err.message);
    }
  }
  // OWNER_PHONE (.env) — всегда золото, поверх файла.
  const owner = phoneDigits(config.ownerPhone);
  if (owner) next.set(owner, 'gold');
  byDigits = next;
}

function statKey() {
  try {
    const st = fs.statSync(config.crownsFile);
    return `${st.mtimeMs}:${st.size}`;
  } catch (_) {
    return '';
  }
}

/** Перечитать файл, если он изменился с последней проверки. */
function reloadIfChanged() {
  const s = statKey();
  if (s !== lastStat) {
    lastStat = s;
    loadFromFile();
  }
}

function startWatcher() {
  try {
    const dir = path.dirname(config.crownsFile);
    const base = path.basename(config.crownsFile);
    watcher = fs.watch(dir, (event, filename) => {
      if (filename === base) {
        // debounce: редакторы часто пишут файл несколько раз подряд
        clearTimeout(watcher._t);
        watcher._t = setTimeout(() => {
          lastStat = '';
          reloadIfChanged();
        }, 150);
      }
    });
    watcher.on('error', () => {});
  } catch (_) {
    // fs.watch недоступен — не страшно, есть проверка mtime при каждом запросе.
  }
}

loadFromFile();
lastStat = statKey();
startWatcher();

/** Уровень короны по номеру телефона или null. */
function getCrownLevelByPhone(phone) {
  reloadIfChanged();
  const key = phoneDigits(phone);
  if (!key) return null;
  return byDigits.get(key) || null;
}

/** Уровень короны по объекту пользователя/участника. */
function getCrownLevel(user) {
  if (!user) return null;
  return getCrownLevelByPhone(user.phone);
}

/** Есть ли у пользователя корона (золото = владелец). */
function isCrowned(user) {
  return getCrownLevel(user) !== null;
}

/**
 * Признак владельца проекта. Совпадает с прежней семантикой is_owner,
 * но без зашитых номеров: true только если телефон в crowns.json имеет
 * уровень gold (или это OWNER_PHONE из .env).
 */
function isOwnerUser(user) {
  if (!user) return false;
  if (getCrownLevel(user) === 'gold') return true;
  return user.is_owner === 1 || user.is_owner === true;
}

/**
 * Обогатить объект пользователя полями для клиента.
 * ВАЖНО: вызывайте только там, где телефон не маскируется (маска ломает сверку).
 * Мутирует и возвращает тот же объект.
 */
function withCrown(user) {
  if (!user || typeof user !== 'object') return user;
  const level = getCrownLevel(user);
  if (level) {
    user.crown_level = level;
    user.creator_level = level; // обратная совместимость со старым кодом
    if (level === 'gold') user.is_owner = 1;
  } else {
    delete user.crown_level;
    delete user.creator_level;
  }
  return user;
}

module.exports = {
  LEVELS,
  phoneDigits,
  getCrownLevelByPhone,
  getCrownLevel,
  isCrowned,
  isOwnerUser,
  withCrown,
};
