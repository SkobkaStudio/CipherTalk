require('dotenv').config();
const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  dbFile: process.env.DB_FILE || './ciphertalk-db.json',
  uploadsDir: process.env.UPLOADS_DIR || './uploads',
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 2 * 1024 * 1024 * 1024,
  saveInterval: parseInt(process.env.SAVE_INTERVAL) || 10000,
  onlinePingInterval: parseInt(process.env.ONLINE_PING_INTERVAL) || 30000,
  codeExpiryMinutes: parseInt(process.env.CODE_EXPIRY_MINUTES) || 5,
  passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH) || 6,
  usernameMinLength: parseInt(process.env.USERNAME_MIN_LENGTH) || 3,
  uploadsPath: path.join(__dirname, '../../uploads')
};