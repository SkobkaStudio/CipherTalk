const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');

/**
 * Шифрование файла базы данных at-rest (AES-256-GCM).
 *
 * Формат файла: CTVDB1.<iv>.<tag>.<ciphertext> (base64).
 * Ключ — отдельный файл <db>.dbkey (32 байта, hex, права 600).
 * Ключ НЕ связан с ключом OTP (encryptionService) и не с JWT-секретом:
 * их ротация не должна ломать базу.
 *
 * Fail-closed:
 * - повреждённый ключ → исключение, файл не перезаписывается;
 * - ключ отсутствует, а база зашифрована → исключение (данные недоступны);
 * - база в старом открытом виде → читается как есть и мигрирует в зашифрованную
 *   при первом сохранении.
 */
const PREFIX = 'CTVDB1';

class DbEncryptionService {
  constructor() {
    this._key = null;
  }

  getKey() {
    if (this._key) return this._key;

    const keyFile = config.dbKeyFile;

    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (!/^[0-9a-f]{64}$/i.test(hex)) {
        throw new Error(`Файл ключа шифрования БД повреждён: ${keyFile}`);
      }
      this._key = Buffer.from(hex, 'hex');
      return this._key;
    }

    // Ключа нет. Если база уже зашифрована — расшифровать её нечем.
    if (fs.existsSync(config.dbFile)) {
      const head = this._readHead(config.dbFile);
      if (this.isEncryptedFile(head)) {
        throw new Error(
          `Файл ключа БД не найден (${keyFile}), а база зашифрована — восстановите ключ из резервной копии`
        );
      }
    }

    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    try { fs.chmodSync(keyFile, 0o600); } catch (e) { /* не критично */ }
    this._key = key;
    return this._key;
  }

  _readHead(file, bytes = 32) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(bytes);
        const read = fs.readSync(fd, buf, 0, bytes, 0);
        return buf.slice(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      return '';
    }
  }

  isEncryptedFile(text) {
    return typeof text === 'string' && text.indexOf(PREFIX + '.') === 0;
  }

  encryptFile(text, key = this.getKey()) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return [
      PREFIX,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64')
    ].join('.');
  }

  decryptFile(payload, key = this.getKey()) {
    if (typeof payload !== 'string' || !this.isEncryptedFile(payload)) {
      throw new Error('Файл БД не является зашифрованным (нет префикса CTVDB1)');
    }
    const parts = payload.split('.');
    if (parts.length !== 4) throw new Error('Некорректный формат зашифрованной БД');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
      decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64')),
        decipher.final()
      ]).toString('utf8');
    } catch (e) {
      throw new Error('Не удалось расшифровать БД: неверный ключ или повреждённые данные');
    }
  }

  /**
   * Читает файл БД в текстовом виде (расшифровывая при необходимости).
   * Возвращает { text, encrypted }.
   */
  readDatabaseFile(file = config.dbFile) {
    const raw = fs.readFileSync(file, 'utf8');
    if (this.isEncryptedFile(raw)) {
      return { text: this.decryptFile(raw), encrypted: true };
    }
    return { text: raw, encrypted: false };
  }
}

module.exports = new DbEncryptionService();
