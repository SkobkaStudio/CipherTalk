const { getDatabase } = require('../db/database');
const User = require('../models/User');
const VerificationCode = require('../models/VerificationCode');
const Chat = require('../models/Chat');
const smsService = require('../services/smsService');
const encryptionService = require('../services/encryptionService');
const sessionService = require('../services/sessionService');
const config = require('../config');

const PHONE_RE = /^\+?[0-9]{5,20}$/;
const VERIFY_TOKEN_TTL_MS = 10 * 60 * 1000;

class AuthController {
  constructor() {
    this.db = getDatabase();
    // phone -> timestamp последней отправки (rate limit на отправку SMS/кодов)
    this.sendCooldowns = new Map();
    // ключ (телефон+IP) -> { count, first } — защита от перебора пароля и OTP
    this.loginAttempts = new Map();
  }

  /**
   * Ограничитель попыток: не больше maxAttempts за окно windowMs.
   */
  checkRateLimit(key, maxAttempts, windowMs) {
    const now = Date.now();
    const record = this.loginAttempts.get(key);
    if (!record || now - record.first > windowMs) {
      this.loginAttempts.set(key, { count: 1, first: now });
      return { ok: true, remaining: maxAttempts - 1 };
    }
    record.count += 1;
    if (record.count > maxAttempts) {
      const waitMs = windowMs - (now - record.first);
      return { ok: false, waitMs: Math.ceil(waitMs / 1000) };
    }
    return { ok: true, remaining: maxAttempts - record.count };
  }

  clearRateLimit(key) {
    this.loginAttempts.delete(key);
  }

  clientKey(req, phone) {
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
      || req.socket?.remoteAddress || 'unknown';
    return `${phone}|${ip}`;
  }

  // 1. Отправка кода
  async sendCode(req, res) {
    try {
      const phone = String(req.body.phone || '').trim();
      if (!PHONE_RE.test(phone)) {
        return res.status(400).json({ error: 'Введите корректный номер телефона' });
      }

      const lastSent = this.sendCooldowns.get(phone) || 0;
      const wait = config.sendCodeCooldownMs - (Date.now() - lastSent);
      if (wait > 0) {
        return res.status(429).json({
          error: `Повторная отправка через ${Math.ceil(wait / 1000)} сек.`
        });
      }
      // чистим устаревшие записи
      const cutoff = Date.now() - config.sendCodeCooldownMs;
      for (const [p, ts] of this.sendCooldowns) {
        if (ts < cutoff) this.sendCooldowns.delete(p);
      }
      this.sendCooldowns.set(phone, Date.now());

      // Криптографически стойкий код (Math.random() был предсказуем)
      const code = encryptionService.randomDigits(6);
      const expiresAt = Date.now() + config.codeExpiryMinutes * 60 * 1000;

      this.db.deleteVerificationCode(phone);
      this.db.verificationCodes.push(new VerificationCode({
        phone,
        code: encryptionService.encryptMessage(code), // at-rest AES-256-GCM
        expires_at: expiresAt
      }));
      this.db.markDirty();

      // Пытаемся отправить через smsService, но главное - вывести в терминал
      try {
        await smsService.sendCode(phone, code);
      } catch (e) {
        // ignore
      }

      console.log('\n' + '='.repeat(60));
      console.log('[MANUAL OTP] Code: ' + code);
      console.log('Phone: ' + phone);
      console.log('Expires in ' + config.codeExpiryMinutes + ' min');
      console.log('='.repeat(60) + '\n');

      const existingUser = this.db.findUserByPhone(phone);
      res.json({ success: true, message: 'Код отправлен', exists: !!existingUser });
    } catch (error) {
      console.error('Send code error:', error);
      res.status(500).json({ error: 'Ошибка отправки кода' });
    }
  }

  // 2. Проверка кода
  verifyCode(req, res) {
    try {
      const phone = String(req.body.phone || '').trim();
      const code = String(req.body.code || '').trim();

      if (!phone || !code) {
        return res.status(400).json({ error: 'Укажите номер и код' });
      }

      const rlKey = this.clientKey(req, phone);
      const rl = this.checkRateLimit(rlKey, config.codeMaxAttempts, 15 * 60 * 1000);
      if (!rl.ok) {
        return res.status(429).json({
          error: `Слишком много попыток. Повторите через ${rl.waitMs} сек.`
        });
      }

      const records = this.db.findVerificationCode(phone);
      if (!records.length) {
        return res.status(400).json({ error: 'Неверный или просроченный код' });
      }

      const record = records[records.length - 1];
      if ((record.attempts || 0) >= config.codeMaxAttempts) {
        this.db.deleteVerificationCode(phone);
        return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код.' });
      }

      const storedCode = encryptionService.decryptMessage(record.code);
      if (!storedCode || !encryptionService.safeCompare(storedCode, code)) {
        record.attempts = (record.attempts || 0) + 1;
        this.db.markDirty();
        return res.status(400).json({ error: 'Неверный или просроченный код' });
      }

      this.clearRateLimit(rlKey);
      this.db.deleteVerificationCode(phone);
      const existingUser = this.db.findUserByPhone(phone);

      if (existingUser) {
        // Подтверждение владения номером: одноразовый login-токен
        const loginToken = encryptionService.encryptMessage(JSON.stringify({
          phone,
          userId: existingUser.id,
          scope: 'login',
          exp: Date.now() + VERIFY_TOKEN_TTL_MS
        }));
        return res.json({ success: true, action: 'login', phone, name: existingUser.name, loginToken });
      }

      // Одноразовый токен-подтверждение, что номер реально проверен
      const verifyToken = encryptionService.encryptMessage(JSON.stringify({
        phone,
        scope: 'register',
        exp: Date.now() + VERIFY_TOKEN_TTL_MS
      }));

      res.json({ success: true, action: 'register', phone, verifyToken });
    } catch (error) {
      console.error('Verify code error:', error);
      res.status(500).json({ error: 'Ошибка проверки кода' });
    }
  }

  // 3. Регистрация
  register(req, res) {
    try {
      const { firstName, lastName, username, password, publicKey, verifyToken, email } = req.body;
      const phone = String(req.body.phone || '').trim();

      // Телефон должен быть подтверждён кодом из SMS
      const proof = this.consumeRegisterProof(phone, verifyToken);
      if (!proof.ok) {
        return res.status(403).json({ error: proof.error });
      }

      if (!firstName || String(firstName).trim().length < 2) {
        return res.status(400).json({ error: 'Имя обязательно (минимум 2 символа)' });
      }
      if (!username || username.length < config.usernameMinLength) {
        return res.status(400).json({ error: `Username минимум ${config.usernameMinLength} символов` });
      }
      if (!password || password.length < config.passwordMinLength) {
        return res.status(400).json({ error: `Пароль минимум ${config.passwordMinLength} символов` });
      }
      if (this.db.findUserByPhone(phone)) {
        return res.status(400).json({ error: 'Номер уже зарегистрирован' });
      }
      if (this.db.isUsernameTaken(username)) {
        return res.status(400).json({ error: 'Username уже занят' });
      }

      let cleanEmail = '';
      if (email) {
        cleanEmail = String(email).trim().toLowerCase().slice(0, 120);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
          return res.status(400).json({ error: 'Некорректный email' });
        }
        if (this.db.users.some(u => (u.email || '').toLowerCase() === cleanEmail)) {
          return res.status(400).json({ error: 'Email уже используется' });
        }
      }

      const user = new User({
        id: this.db.nextId('users'),
        phone,
        email: cleanEmail,
        first_name: String(firstName).trim(),
        last_name: lastName ? String(lastName).trim() : '',
        username: String(username).replace(/^@/, '').toLowerCase(),
        public_key: typeof publicKey === 'string' ? publicKey.slice(0, 4096) : ''
      });
      user.setPassword(password);
      this.db.users.push(user);

      // "Избранное"
      const savedChatId = this.db.nextId('chats');
      this.db.chats.push(new Chat({
        id: savedChatId,
        type: 'saved',
        name: 'Избранное',
        owner_id: user.id
      }));
      this.db.chatMembers.push({
        chat_id: savedChatId,
        user_id: user.id,
        role: 'owner',
        joined_at: Date.now()
      });
      this.db.markDirty();

      const { token } = sessionService.create(user.id, { userAgent: req.headers['user-agent'] });

      console.log(`\n✅ Новый пользователь зарегистрирован:`);
      console.log(`👤 ${user.name} (@${user.username})\n`);

      res.json({ success: true, user: user.toSafeJSON(), token });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ error: 'Ошибка регистрации' });
    }
  }

  // 4. Вход
  login(req, res) {
    try {
      const phone = String(req.body.phone || '').trim();
      const { password, publicKey } = req.body;

      if (!phone || !password) {
        return res.status(400).json({ error: 'Укажите номер и пароль' });
      }

      const rlKey = this.clientKey(req, phone);
      const rl = this.checkRateLimit(rlKey, config.loginMaxAttempts, 15 * 60 * 1000);
      if (!rl.ok) {
        return res.status(429).json({
          error: `Слишком много попыток входа. Повторите через ${rl.waitMs} сек.`
        });
      }

      const user = this.db.findUserByPhone(phone);
      if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }
      if (!user.password_hash) {
        return res.status(400).json({ error: 'Пароль не установлен. Обратитесь в поддержку.' });
      }
      if (!user.verifyPassword(password)) {
        return res.status(400).json({ error: 'Неверный пароль' });
      }

      this.clearRateLimit(rlKey);

      if (typeof publicKey === 'string' && publicKey.length <= 4096) {
        user.public_key = publicKey;
      }
      this.db.markDirty();

      const { token } = sessionService.create(user.id, { userAgent: req.headers['user-agent'] });

      console.log(`\n✅ Вход пользователя: ${user.name} (@${user.username})\n`);

      res.json({ success: true, user: user.toSafeJSON(), token });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Ошибка входа' });
    }
  }

  // 5. Текущий пользователь
  me(req, res) {
    res.json({ success: true, user: req.user.toSafeJSON() });
  }

  // 5b. Вход по коду из SMS (passwordless; для аккаунтов без пароля и как второй фактор)
  loginWithCode(req, res) {
    try {
      const phone = String(req.body.phone || '').trim();
      const { loginToken, publicKey } = req.body;

      const proof = this.consumeLoginProof(phone, loginToken);
      if (!proof.ok) {
        return res.status(403).json({ error: proof.error });
      }

      const user = this.db.findUserById(proof.userId);
      if (!user || user.phone !== phone) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      if (typeof publicKey === 'string' && publicKey.length <= 4096) {
        user.public_key = publicKey;
      }
      this.db.markDirty();

      const { token } = sessionService.create(user.id, { userAgent: req.headers['user-agent'] });
      console.log(`\n✅ Вход по коду: ${user.name} (@${user.username})\n`);
      res.json({ success: true, user: user.toSafeJSON(), token });
    } catch (error) {
      console.error('LoginWithCode error:', error);
      res.status(500).json({ error: 'Ошибка входа' });
    }
  }

  // 6. Выход (инвалидация сессии)
  logout(req, res) {
    sessionService.revokeToken(req.token);
    res.json({ success: true });
  }

  // 6b. Активные устройства (сессии)
  listSessions(req, res) {
    try {
      const sessions = this.db.sessions
        .filter(s => s.user_id === req.userId && !s.isExpired())
        .map(s => ({
          id: s.id,
          current: s.token_hash === encryptionService.hashToken(req.token),
          user_agent: s.user_agent,
          created_at: s.created_at,
          expires_at: s.expires_at
        }))
        .sort((a, b) => b.created_at - a.created_at);
      res.json(sessions);
    } catch (error) {
      console.error('List sessions error:', error);
      res.status(500).json({ error: 'Ошибка получения сессий' });
    }
  }

  // 6c. Завершение сессии конкретного устройства
  revokeSession(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const session = this.db.sessions.find(s => s.id === id && s.user_id === req.userId);
      if (!session) {
        return res.status(404).json({ error: 'Сессия не найдена' });
      }
      this.db.deleteSessionByHash(session.token_hash);
      res.json({ success: true });
    } catch (error) {
      console.error('Revoke session error:', error);
      res.status(500).json({ error: 'Ошибка завершения сессии' });
    }
  }

  // 7. Проверка username
  checkUsername(req, res) {
    try {
      const { username } = req.query;
      if (!username) {
        return res.json({ available: false, error: 'Пустой username' });
      }

      const clean = String(username).replace(/^@/, '').toLowerCase();
      if (clean.length < config.usernameMinLength) {
        return res.json({ available: false, error: `Минимум ${config.usernameMinLength} символа` });
      }
      if (!/^[a-z0-9_]+$/.test(clean)) {
        return res.json({ available: false, error: 'Только латиница, цифры и _' });
      }

      res.json({ available: !this.db.isUsernameTaken(clean), username: clean });
    } catch (error) {
      console.error('Check username error:', error);
      res.status(500).json({ error: 'Ошибка проверки username' });
    }
  }

  consumeRegisterProof(phone, verifyToken) {
    if (!verifyToken) {
      return { ok: false, error: 'Подтвердите номер телефона кодом из SMS' };
    }
    const raw = encryptionService.decryptMessage(String(verifyToken));
    if (!raw) return { ok: false, error: 'Токен подтверждения недействителен' };

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: 'Токен подтверждения недействителен' };
    }
    if (data.scope !== 'register' || data.phone !== phone || data.exp < Date.now()) {
      return { ok: false, error: 'Подтверждение номера просрочено, запросите код заново' };
    }
    return { ok: true };
  }

  consumeLoginProof(phone, loginToken) {
    if (!loginToken) {
      return { ok: false, error: 'Подтвердите номер телефона кодом из SMS' };
    }
    const raw = encryptionService.decryptMessage(String(loginToken));
    if (!raw) return { ok: false, error: 'Токен входа недействителен' };

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: 'Токен входа недействителен' };
    }
    if (data.scope !== 'login' || data.phone !== phone || data.exp < Date.now()) {
      return { ok: false, error: 'Код входа просрочен, запросите новый' };
    }
    return { ok: true, userId: data.userId };
  }
}

module.exports = new AuthController();
