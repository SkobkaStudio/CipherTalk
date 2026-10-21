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
  maxJsonBody: 10 * 1024 * 1024,
  wsMaxPayload: 1024 * 1024,
  maxMessageLength: 100 * 1000,

  saveInterval: parseInt(process.env.SAVE_INTERVAL, 10) || 10000,
  saveDebounce: 250,
  onlinePingInterval: parseInt(process.env.ONLINE_PING_INTERVAL, 10) || 30000,
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL, 10) || 30000,

  codeExpiryMinutes: parseInt(process.env.CODE_EXPIRY_MINUTES, 10) || 5,
  codeMaxAttempts: 5,
  sendCodeCooldownMs: 60000,
  loginMaxAttempts: 8,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH, 10) || 6,
  usernameMinLength: parseInt(process.env.USERNAME_MIN_LENGTH, 10) || 3,

  // Ключ AES-256-GCM для шифрования данных на диске.
  // Если не задан — генерируется при первом запуске и хранится в БД.
  encryptionKey: process.env.ENCRYPTION_KEY || ''
};
