require('dotenv').config();
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '../..');

// Разрешение относительных путей относительно корня сервера,
// чтобы БД и загрузки не разъезжались при запуске из другой директории.
function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(SERVER_ROOT, p);
}

// Жёсткий лимит вложения (можно только уменьшить через MAX_FILE_SIZE)
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Пути к файлам данных вычисляются один раз, чтобы БД, ключ БД и ключ OTP
// не разъезжались при смене DB_FILE.
const DB_FILE = resolveFromRoot(process.env.DB_FILE || './ciphertalk-db.json');

module.exports = {
  serverRoot: SERVER_ROOT,
  clientPath: path.join(SERVER_ROOT, 'public'),

  port: parseInt(process.env.PORT, 10) || 3000,
  dbFile: DB_FILE,
  // Отдельный ключ шифрования SQLite-файла (SQLCipher, 0600).
  dbKeyFile: resolveFromRoot(process.env.DB_KEY_FILE || (DB_FILE + '.dbkey')),
  // Шифровать SQLite at-rest через SQLCipher. Отключается только явно: DB_ENCRYPTION=false
  dbEncryption: process.env.DB_ENCRYPTION !== 'false',
  uploadsPath: resolveFromRoot(process.env.UPLOADS_DIR || './uploads'),
  // Файлы стикеров (публичные картинки): storage/stickers/<pack_id>/<sticker_id>.<ext>
  stickersPath: path.join(SERVER_ROOT, process.env.STICKERS_DIR || 'storage/stickers'),

  maxFileSize: Math.min(
    parseInt(process.env.MAX_FILE_SIZE, 10) || MAX_UPLOAD_BYTES,
    MAX_UPLOAD_BYTES
  ),
  maxJsonBody: 10 * 1024 * 1024,
  wsMaxPayload: 1024 * 1024,
  maxMessageLength: 100 * 1000,

  saveInterval: parseInt(process.env.SAVE_INTERVAL, 10) || 10000,
  saveDebounce: 250,
  onlinePingInterval: parseInt(process.env.ONLINE_PING_INTERVAL, 10) || 30000,
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL, 10) || 30000,

  // Телефон создателя проекта: такой аккаунт получает золотую галочку владельца.
  ownerPhone: process.env.OWNER_PHONE || '+79039952506',

  codeExpiryMinutes: parseInt(process.env.CODE_EXPIRY_MINUTES, 10) || 5,
  codeMaxAttempts: 5,
  sendCodeCooldownMs: 60000,
  loginMaxAttempts: 8,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH, 10) || 6,
  usernameMinLength: parseInt(process.env.USERNAME_MIN_LENGTH, 10) || 3,

  // Ключ AES-256-GCM для шифрования данных на диске.
  // Если не задан — генерируется при первом запуске и хранится в БД.
  encryptionKey: process.env.ENCRYPTION_KEY || '',

  // Секрет HMAC для подписи JWT. Если не задан — генерируется в
  // <db>.jwt-secret с правами 600 и переиспользуется после рестартов.
  jwtSecret: process.env.JWT_SECRET || '',

  // Секрет HMAC для подписанных URL приватных стикеров (?exp=&uid=&sig=).
  // Если пусто — stickerService генерирует и сохраняет в <dbFile>.sticker-secret (0600),
  // по аналогии с jwtSecret.
  stickerUrlSecret: process.env.STICKER_URL_SECRET || '',

  // SMS-провайдер для кодов подтверждения.
  // console — только для разработки (в production код в логи не пишется),
  // http — generic HTTP API, twilio — Twilio Messages API.
  sms: {
    provider: (process.env.SMS_PROVIDER || 'console').toLowerCase(),
    // Разрешить вывод кода в консоль в production (только для тестов!)
    consoleAllowed: process.env.SMS_CONSOLE_ALLOW === 'true',
    apiUrl: process.env.SMS_API_URL || '',
    apiToken: process.env.SMS_API_TOKEN || '',
    textTemplate: process.env.SMS_TEXT_TEMPLATE || 'CipherTalk: ваш код {code}',
    timeoutMs: parseInt(process.env.SMS_TIMEOUT_MS, 10) || 10000,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_FROM || ''
  },

  // ICE-серверы для WebRTC (STUN + опциональный TURN)
  ice: {
    stunUrls: (process.env.STUN_URLS ||
      'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
      .split(',').map(s => s.trim()).filter(Boolean),
    turnUrl: process.env.TURN_URL || '',
    turnUsername: process.env.TURN_USERNAME || '',
    turnCredential: process.env.TURN_CREDENTIAL || '',
    // static-auth-secret coturn: клиенту выдаются временные учётные данные
    turnSecret: process.env.TURN_SECRET || '',
    turnTtlSeconds: parseInt(process.env.TURN_TTL_SECONDS, 10) || 3600
  }
};
