'use strict';

// ==================== ПУБЛИЧНЫЕ ID (Telegram-подобные) ====================
// Каждому пользователю выдаётся 8-значный id: 00000001 … 99999999
// (внутренний счётчик users: 1, 2, 3 …). Собеседник видит уже свой id.
// Группы и каналы получают отрицательный 14-значный id:
// -00000000000001 … -99999999999999 (внутренний счётчик chats: 1, 2, 3 …).
// URL чата: https://ciphertalk.cloudpub.ru/<публичный id> — например
// /00000001 для пользователя №1 и /-00000000000001 для первой группы.

const USER_ID_DIGITS = 8;                    // 00000001 … 99999999
const CHAT_ID_DIGITS = 14;                   // -00000000000001 … -99999999999999
const MAX_USER_INTERNAL_ID = 99999999;       // 10^8 - 1
const MAX_CHAT_INTERNAL_ID = 99999999999999; // 10^14 - 1

// Типы чатов, получающие отрицательный публичный id.
// 'private' — не в списке: публичный id личного чата совпадает с id собеседника.
const NEGATIVE_CHAT_TYPES = new Set(['group', 'supergroup', 'channel']);

function padDigits(n, digits) { // eslint-disable-line no-unused-vars
  let s = String(Math.abs(Math.trunc(Number(n) || 0)));
  if (s.length < digits) s = '0'.repeat(digits - s.length) + s;
  return s;
}

/** Внутренний id пользователя -> «00000001». */
function formatUserId(internalId) {
  const n = Number(internalId);
  if (!Number.isInteger(n) || n <= 0) return '';
  return padDigits(n, USER_ID_DIGITS);
}

/** Внутренний id чата -> «-00000000000001» (группы/каналы) или «00000001» (личные/избранное). */
function formatChatId(internalId, type) {
  const n = Number(internalId);
  if (!Number.isInteger(n) || n <= 0) return '';
  if (NEGATIVE_CHAT_TYPES.has(type)) return '-' + padDigits(n, CHAT_ID_DIGITS);
  return padDigits(n, USER_ID_DIGITS);
}

function isNegativeChatToken(token) {
  return /^-\d{1,14}$/.test(String(token));
}

function isUserToken(token) {
  return /^\d{1,8}$/.test(String(token));
}

/**
 * Токен из URL -> внутренний id пользователя (или null).
 * Работает и с дополненными нулями ('00000001'), и с сырыми числами ('1').
 */
function publicIdToUserId(token) {
  const t = String(token == null ? '' : token).trim();
  if (!/^\d{1,8}$/.test(t)) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Разбирает токен из URL (/00000001, /35742553, /-00000000000001 …)
 * во внутренний числовой id. Возвращает null, если токен не похож на id.
 */
function parsePublicId(token) {
  const t = decodeURIComponent(String(token || '')).trim();
  if (isNegativeChatToken(t)) return -Number(BigInt(t)); // -1n -> -1
  if (isUserToken(t)) {
    const n = Number(t);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Обратное преобразование: строка из адресной строки -> внутренний id.
 *  - «-00000000000001» -> -1  (id группы/канала)
 *  - «00000001»        -> 1   (id пользователя или личного чата с этим пользователем)
 */
function publicTokenToInternal(token) {
  return parsePublicId(token);
}

// ==================== ДЕТЕРМИНИРОВАННЫЕ ID ЛИЧНЫХ ЧАТОВ ====================
// Как в Telegram: внутренний id личного чата = -(min(a,b) * MULT + max(a,b)),
// где a и b — внутренние id собеседников. Публичный id личного чата для
// каждого участника = публичный 8-значный id собеседника, поэтому ссылка
// https://…/00000002 у обоих пользователей ведёт в один и тот же диалог.
const PRIVATE_CHAT_MULT = 1000000; // 1e6 — запас под id до 999999

function privateChatInternalId(userA, userB) {
  const a = Number(userA), b = Number(userB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) return null;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return -(lo * PRIVATE_CHAT_MULT + hi);
}

function privateChatMembersFromInternalId(negativeChatId) {
  const cid = Number(negativeChatId);
  if (!Number.isInteger(cid) || cid >= 0) return null;
  const abs = -cid;
  const lo = Math.floor(abs / PRIVATE_CHAT_MULT);
  const hi = abs % PRIVATE_CHAT_MULT;
  if (lo <= 0 || hi <= 0 || hi > lo) return null;
  return [lo, hi];
}

module.exports = {
  USER_ID_DIGITS,
  CHAT_ID_DIGITS,
  MAX_USER_INTERNAL_ID,
  MAX_CHAT_INTERNAL_ID,
  NEGATIVE_CHAT_TYPES,
  PRIVATE_CHAT_MULT,
  padDigits,
  formatUserId,
  formatChatId,
  parsePublicId,
  publicTokenToInternal,
  isNegativeChatToken,
  isUserToken,
  publicIdToUserId,
  privateChatInternalId,
  privateChatMembersFromInternalId
};
