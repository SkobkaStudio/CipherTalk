/**
 * Автоудаление сообщений: TTL задаётся клиентом при отправке,
 * сервер хранит абсолютное время и сам вычищает просроченные сообщения.
 */
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 24 * 60 * 60;

function normalizeTtlSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const seconds = Math.floor(n);
  if (seconds < MIN_TTL_SECONDS || seconds > MAX_TTL_SECONDS) return 0;
  return seconds;
}

function expiresAtFor(ttlSeconds, now = Date.now()) {
  const ttl = normalizeTtlSeconds(ttlSeconds);
  return ttl ? now + ttl * 1000 : null;
}

function isExpired(message, now = Date.now()) {
  return !!(message && message.expires_at && message.expires_at <= now);
}

module.exports = {
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  normalizeTtlSeconds,
  expiresAtFor,
  isExpired
};
