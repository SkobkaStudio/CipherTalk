const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');

const PREFIX = 'CTV1'; // формат: CTV1.<iv>.<tag>.<ciphertext> (все base64)
const SALT = 'CipherTalk-at-rest';

/**
 * Шифрование данных на диске: AES-256-GCM (96-bit IV, auth tag 128-bit).
 * Ключ берётся из ENCRYPTION_KEY (scrypt), иначе генерируется при первом
 * запуске и лежит в отдельном файле <db>.key с правами 600.
 */
class EncryptionService {
  constructor() {
    this._key = null;
  }

  getKey() {
    if (this._key) return this._key;

    if (config.encryptionKey) {
      this._key = crypto.scryptSync(String(config.encryptionKey), SALT, 32);
      return this._key;
    }

    const keyFile = config.dbFile + '.key';
    try {
      if (fs.existsSync(keyFile)) {
        const hex = fs.readFileSync(keyFile, 'utf8').trim();
        if (/^[0-9a-f]{64}$/i.test(hex)) {
          this._key = Buffer.from(hex, 'hex');
          return this._key;
        }
      }
      const key = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
      this._key = key;
      return this._key;
    } catch (e) {
      console.error('Не удалось прочитать/создать ключ шифрования:', e.message);
      throw e;
    }
  }

  encryptMessage(message, key = this.getKey()) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(message), 'utf8'), cipher.final()]);
    return [
      PREFIX,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64')
    ].join('.');
  }

  decryptMessage(payload, key = this.getKey()) {
    if (typeof payload !== 'string' || payload.indexOf(PREFIX + '.') !== 0) {
      return payload;
    }
    try {
      const parts = payload.split('.');
      if (parts.length !== 4) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
      decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64')),
        decipher.final()
      ]).toString('utf8');
    } catch (e) {
      return null;
    }
  }

  isEncrypted(payload) {
    return typeof payload === 'string' && payload.indexOf(PREFIX + '.') === 0;
  }

  safeCompare(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  hashPassword(password, iterations = 100000) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
    return `pbkdf2-sha512$${iterations}$${salt}$${hash}`;
  }

  verifyPassword(password, stored) {
    if (!stored) return false;

    let salt, hash, iterations;
    if (stored.startsWith('pbkdf2-sha512$')) {
      const parts = stored.split('$');
      if (parts.length !== 4) return false;
      iterations = parseInt(parts[1], 10);
      salt = parts[2];
      hash = parts[3];
    } else {
      const legacy = stored.split(':');
      if (legacy.length !== 2) return false;
      salt = legacy[0];
      hash = legacy[1];
      iterations = 10000;
    }

    const test = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
    return this.safeCompare(test, hash);
  }

  generateToken() {
    return crypto.randomBytes(32).toString('base64url');
  }

  hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  /**
   * Криптографически стойкие одноразовые коды (Math.random() предсказуем).
   */
  randomDigits(length = 6) {
    const digits = [];
    for (let i = 0; i < length; i++) {
      digits.push(crypto.randomInt(0, 10));
    }
    return digits.join('');
  }

  randomBytes(length = 32) {
    return crypto.randomBytes(length);
  }
}

module.exports = new EncryptionService();
