/**
 * Признак аккаунта создателя CipherTalk.
 *
 * Телефон владельца задаётся через OWNER_PHONE (см. .env), по умолчанию —
 * номер создателя проекта. Сравниваем только цифры, чтобы +7 / 8 и пробелы
 * не влияли на результат.
 */
const config = require('../config');
const { getCreator } = require('./creators');

function phoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 && digits[0] === '8' ? '7' + digits.slice(1) : digits;
}

function isOwnerPhone(phone) {
  const owner = phoneDigits(config.ownerPhone);
  const candidate = phoneDigits(phone);
  return !!owner && !!candidate && owner === candidate;
}

function isOwnerUser(user) {
  if (!user) return false;
  return user.is_owner === 1 || user.is_owner === true || isOwnerPhone(user.phone);
}

/**
 * Уровень короны разработчика: 'gold' | 'silver' | 'bronze' | null.
 * Корона выдаётся СТРОГО по номеру телефона из creators.js (не по id).
 * Телефон владельца (OWNER_PHONE) гарантированно даёт золотую корону.
 */
function creatorLevelFor(user) {
  if (!user) return null;
  const c = getCreator(user.phone);
  if (c) return c.level;
  if (isOwnerPhone(user.phone)) return 'gold';
  return null;
}

module.exports = { phoneDigits, isOwnerPhone, isOwnerUser, creatorLevelFor };
