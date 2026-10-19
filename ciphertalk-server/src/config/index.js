require('dotenv').config();
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '../..');

// Разрешение относительных путей относительно корня сервера,
// чтобы БД и загрузки не разъезжались при запуске из другой директории.
function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(SERVER_ROOT, p);
}

// Жёсткий лимит вложения (можно только уменьшить через MAX_FILE_SIZE)
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Демо-номера: сравниваем по цифрам, чтобы "+7 903..." и "7903..." совпадали.
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

module.exports = {
  serverRoot: SERVER_ROOT,
  clientPath: path.join(SERVER_ROOT, 'public'),

  port: parseInt(process.env.PORT, 10) || 3000,
  dbFile: resolveFromRoot(process.env.DB_FILE || './ciphertalk-db.json'),
  uploadsPath: resolveFromRoot(process.env.UPLOADS_DIR || './uploads'),

  maxFileSize: Math.min(
    parseInt(process.env.MAX_FILE_SIZE, 10) || MAX_UPLOAD_BYTES,
    MAX_UPLOAD_BYTES
  ),
  maxJsonBody: 2 * 1024 * 1024,
  wsMaxPayload: 512 * 1024,
  maxMessageLength: 100 * 1000,

  saveInterval: parseInt(process.env.SAVE_INTERVAL, 10) || 10000,
  saveDebounce: 250,
  onlinePingInterval: parseInt(process.env.ONLINE_PING_INTERVAL, 10) || 30000,
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL, 10) || 30000,

  codeExpiryMinutes: parseInt(process.env.CODE_EXPIRY_MINUTES, 10) || 5,
  codeMaxAttempts: 5,
  sendCodeCooldownMs: 60000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH, 10) || 6,
  usernameMinLength: parseInt(process.env.USERNAME_MIN_LENGTH, 10) || 3,

  // Ключ AES-256-GCM для шифрования данных на диске.
  // Если не задан — генерируется при первом запуске и хранится в БД.
  encryptionKey: process.env.ENCRYPTION_KEY || '',

  // Демо-режим: «чит-код». Любой номер из DEMO_PHONES (список через запятую)
  // пропускает SMS и сразу пускает в чат с тестовыми контактами (Алиса, Боб).
  // Включён по умолчанию, отключается переменной DEMO_MODE=0 (для продакшена).
  demoMode: process.env.DEMO_MODE !== '0',
  demoPhone: process.env.DEMO_PHONE || '1234567,79039952506',
  demoCode: process.env.DEMO_CODE || '0000'
};

// Список демо-номеров (нормализованные цифры) и проверка телефона на демо-режим.
module.exports.demoPhones = module.exports.demoPhone.split(',').map(normalizePhone).filter(Boolean);
module.exports.isDemoPhone = (phone) =>
  module.exports.demoMode && module.exports.demoPhones.includes(normalizePhone(phone));
