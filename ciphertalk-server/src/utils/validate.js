const { MIN_USERNAME_LENGTH, MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH, MIN_NAME_LENGTH } = require('../config/constants');

function isValidUsername(value) {
  const clean = String(value || '').replace(/^@/, '').toLowerCase();
  if (clean.length < MIN_USERNAME_LENGTH || clean.length > MAX_USERNAME_LENGTH) return false;
  return /^[a-z0-9_]+$/.test(clean);
}

function isValidPassword(value) {
  if (!value) return false;
  return String(value).length >= MIN_PASSWORD_LENGTH;
}

function isValidMessage(value) {
  if (!value) return false;
  const len = String(value).length;
  return len > 0 && len <= 100000;
}

module.exports = { isValidUsername, isValidPassword, isValidMessage };
