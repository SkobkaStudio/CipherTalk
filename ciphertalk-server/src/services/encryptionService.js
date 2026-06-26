const crypto = require('crypto');

class EncryptionService {
  hashPassword(password, salt) {
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  verifyPassword(password, stored) {
    if (!stored) return false;
    const [salt, hash] = stored.split(':');
    const testHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return hash === testHash;
  }

  generateSalt() {
    return crypto.randomBytes(16).toString('hex');
  }

  // Для будущего использования (E2E шифрование)
  encryptMessage(message, publicKey) {
    // Здесь будет реализация шифрования
    return message;
  }

  decryptMessage(encrypted, privateKey) {
    // Здесь будет реализация дешифрования
    return encrypted;
  }
}

module.exports = new EncryptionService();