const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const { getDatabase } = require('../db/database');
const Session = require('../models/Session');
const encryptionService = require('./encryptionService');

/**
 * Сессии: клиент получает подписанный JWT (HS256), в БД хранится только
 * SHA-256 хеш токена. JWT даёт проверяемую подпись и срок жизни, а запись
 * в БД — возможность мгновенного отзыва (logout) и список устройств.
 * Приватный ключ подписи на диск не попадает: только секрет HMAC.
 */
class SessionService {
  constructor() {
    this.db = getDatabase();
    this._secret = null;
  }

  getSecret() {
    if (this._secret) return this._secret;
    if (config.jwtSecret) {
      this._secret = Buffer.from(String(config.jwtSecret), 'utf8');
      return this._secret;
    }
    const file = config.dbFile + '.jwt-secret';
    try {
      if (fs.existsSync(file)) {
        const hex = fs.readFileSync(file, 'utf8').trim();
        if (!/^[0-9a-f]{64}$/i.test(hex)) {
          // Не подменяем повреждённый секрет случайным: это молча разлогинило
          // бы все сессии. Лучше явная ошибка при старте/выдаче токена.
          throw new Error(`Файл JWT-секрета повреждён: ${file}`);
        }
        this._secret = Buffer.from(hex, 'hex');
        return this._secret;
      }
      const secret = crypto.randomBytes(32);
      fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
      this._secret = secret;
      return this._secret;
    } catch (e) {
      console.error('Не удалось прочитать/создать JWT-секрет:', e.message);
      throw e;
    }
  }

  signJwt(session) {
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const header = enc({ alg: 'HS256', typ: 'JWT' });
    const now = Math.floor(Date.now() / 1000);
    const payload = enc({
      sub: session.user_id,
      sid: session.id,
      iat: now,
      exp: Math.floor(session.expires_at / 1000),
      iss: 'ciphertalk'
    });
    const data = `${header}.${payload}`;
    const sig = crypto.createHmac('sha256', this.getSecret()).update(data).digest('base64url');
    return `${data}.${sig}`;
  }

  verifyJwt(token) {
    if (typeof token !== 'string' || token.split('.').length !== 3) return null;
    const [header, payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', this.getSecret())
      .update(`${header}.${payload}`)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      if (head.alg !== 'HS256') return null;
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data || data.iss !== 'ciphertalk') return null;
      if (typeof data.exp !== 'number' || data.exp * 1000 <= Date.now()) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  create(userId, meta = {}) {
    const id = this.db.nextId('sessions');
    const session = new Session({
      id,
      user_id: userId,
      token_hash: '',
      user_agent: String(meta.userAgent || '').slice(0, 200)
    });
    const token = this.signJwt(session);
    session.token_hash = encryptionService.hashToken(token);
    this.db.sessions.push(session);
    this.db.markDirty();
    return { token, session };
  }

  verify(token) {
    if (!token) return null;

    let session = null;
    const jwt = this.verifyJwt(token);
    if (jwt) {
      session = this.db.sessions.find(s => s.id === Number(jwt.sid));
      if (!session || session.user_id !== Number(jwt.sub)) return null;
      // Подпись верна, но сессия могла быть отозвана: сверяем хеш токена.
      if (session.token_hash !== encryptionService.hashToken(token)) return null;
    } else {
      // Совместимость с сессиями, выданными до перехода на JWT.
      const hash = encryptionService.hashToken(token);
      session = this.db.sessions.find(s => s.token_hash === hash);
    }
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
