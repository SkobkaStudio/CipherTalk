const encryptionService = require('../services/encryptionService');
const { getCrownLevelByPhone } = require('../utils/crowns');
const { formatUserId } = require('../utils/ids');

class User {
  constructor(data) {
    this.id = data.id;
    // Публичный 8-значный id («00000001»). Для старых записей без колонки
    // вычисляется из внутреннего id, чтобы клиент всегда видел единый формат.
    this.public_id = data.public_id || (data.id ? formatUserId(data.id) : '');
    this.phone = data.phone || '';
    this.email = data.email || '';
    this.first_name = data.first_name || '';
    this.last_name = data.last_name || '';
    this.name = data.name || `${data.first_name || ''} ${data.last_name || ''}`.trim();
    this.username = data.username || '';
    this.avatar = data.avatar || '';
    this.bio = data.bio || '';
    this.public_key = data.public_key || '';
    this.password_hash = data.password_hash || '';
    this.online = data.online || 0;
    this.last_seen = data.last_seen || 0;
    this.hide_online = data.hide_online || 0;
    // Короны — только по номеру телефона (src/config/crowns.json).
    this.crown_level = getCrownLevelByPhone(this.phone);
    this.is_owner = this.crown_level === 'gold' ? 1 : 0;
    this.created_at = data.created_at || Date.now();
  }

  /** Аккаунт создателя CipherTalk (золотая корона по номеру телефона). */
  isOwner() {
    return getCrownLevelByPhone(this.phone) === 'gold';
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
      public_id: this.public_id,
      phone: this.phone,
      email: this.email || '',
      first_name: this.first_name,
      last_name: this.last_name,
      name: this.name,
      username: this.username,
      avatar: this.avatar,
      bio: this.bio || '',
      public_key: this.public_key,
      password_hash: this.password_hash || '',
      online: this.online,
      last_seen: this.last_seen,
      hide_online: this.hide_online || 0,
      crown_level: getCrownLevelByPhone(this.phone),
      is_owner: getCrownLevelByPhone(this.phone) === 'gold' ? 1 : 0,
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
