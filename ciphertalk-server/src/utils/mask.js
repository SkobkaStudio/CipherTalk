/**
 * Маскирование персональных данных в ответах API.
 * Телефон и email чужих пользователей не должны светить в чате.
 */

function maskPhone(phone) {
  const s = String(phone || '');
  if (!s) return '';
  if (s.length <= 4) return '••••';
  return s.slice(0, Math.min(3, s.length - 2)) + '••••' + s.slice(-2);
}

function maskEmail(email) {
  const s = String(email || '');
  if (!s) return '';
  const at = s.indexOf('@');
  if (at < 1) return '••••';
  const name = s.slice(0, at);
  const domain = s.slice(at);
  return name.slice(0, Math.min(2, name.length)) + '•••' + domain;
}

module.exports = { maskPhone, maskEmail };
