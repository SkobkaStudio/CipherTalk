/**
 * Признак аккаунта создателя CipherTalk.
 *
 * Телефон владельца задаётся через OWNER_PHONE (см. .env), по умолчанию —
 * номер создателя проекта. Сравниваем только цифры, чтобы +7 / 8 и пробелы
 * не влияли на результат.
 */
const config = require('../config');

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

module.exports = { phoneDigits, isOwnerPhone, isOwnerUser };
