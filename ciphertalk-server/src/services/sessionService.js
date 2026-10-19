const { getDatabase } = require('../db/database');
const Session = require('../models/Session');
const encryptionService = require('./encryptionService');

/**
 * Сессии: клиент получает opaque-токен, в БД хранится только SHA-256 хеш,
 * поэтому утечка дампа БД не даёт чужой сессии.
 */
class SessionService {
  constructor() {
    this.db = getDatabase();
  }

  create(userId, meta = {}) {
    const token = encryptionService.generateToken();
    const session = new Session({
      id: this.db.nextId('sessions'),
      user_id: userId,
      token_hash: encryptionService.hashToken(token),
      user_agent: String(meta.userAgent || '').slice(0, 200)
    });
    this.db.sessions.push(session);
    this.db.markDirty();
    return { token, session };
  }

  verify(token) {
    if (!token) return null;
    const hash = encryptionService.hashToken(token);
    const session = this.db.sessions.find(s => s.token_hash === hash);
    if (!session) return null;
    if (session.isExpired()) {
      this.revokeToken(token);
      return null;
    }
    const user = this.db.findUserById(session.user_id);
    if (!user) return null;
    return { session, user };
  }

  revokeToken(token) {
    if (!token) return false;
    try {
      return this.db.deleteSessionByHash(encryptionService.hashToken(token));
    } catch (e) {
      return false;
    }
  }

  purgeExpired() {
    this.db.purgeExpiredSessions();
  }
}

module.exports = new SessionService();
