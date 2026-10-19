const encryptionService = require('../services/encryptionService');

class User {
  constructor(data) {
    this.id = data.id;
    this.phone = data.phone;
    this.first_name = data.first_name || '';
    this.last_name = data.last_name || '';
    this.name = data.name || `${data.first_name || ''} ${data.last_name || ''}`.trim();
    this.username = data.username || '';
    this.avatar = data.avatar || '';
    this.public_key = data.public_key || '';
    this.password_hash = data.password_hash || '';
    this.online = data.online || 0;
    this.last_seen = data.last_seen || 0;
    this.created_at = data.created_at || Date.now();
  }

  // Единый источник хеширования паролей (AES-независимо, PBKDF2-SHA512)
  static hashPassword(password) {
    return encryptionService.hashPassword(password);
  }

  static verifyPassword(password, stored) {
    return encryptionService.verifyPassword(password, stored);
  }

  setPassword(password) {
    this.password_hash = User.hashPassword(password);
  }

  verifyPassword(password) {
    return User.verifyPassword(password, this.password_hash);
  }

  toJSON() {
    return {
      id: this.id,
      phone: this.phone,
      first_name: this.first_name,
      last_name: this.last_name,
      name: this.name,
      username: this.username,
      avatar: this.avatar,
      public_key: this.public_key,
      online: this.online,
      last_seen: this.last_seen,
      created_at: this.created_at
    };
  }

  toSafeJSON() {
    return this.toJSON();
  }
}

module.exports = User;
