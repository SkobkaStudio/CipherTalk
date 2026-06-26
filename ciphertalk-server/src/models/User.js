const crypto = require('crypto');

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

  static hashPassword(password, salt) {
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  static verifyPassword(password, stored) {
    if (!stored) return false;
    const [salt, hash] = stored.split(':');
    const testHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return hash === testHash;
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
    const data = this.toJSON();
    delete data.password_hash;
    return data;
  }
}

module.exports = User;