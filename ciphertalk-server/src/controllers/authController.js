const { getDatabase } = require('../db/database');
const User = require('../models/User');
const VerificationCode = require('../models/VerificationCode');
const Chat = require('../models/Chat');
const smsService = require('../services/smsService');
const encryptionService = require('../services/encryptionService');
const sessionService = require('../services/sessionService');
const demoService = require('../services/demoService');
const config = require('../config');

const PHONE_RE = /^\+?[0-9]{5,20}$/;
const VERIFY_TOKEN_TTL_MS = 10 * 60 * 1000;

class AuthController {
  constructor() {
    this.db = getDatabase();
    // phone -> timestamp последней отправки (rate limit на отправку SMS)
    this.sendCooldowns = new Map();
  }

  // 1. Отправка кода
  async sendCode(req, res) {
    try {
      const phone = String(req.body.phone || '').trim();
      if (!PHONE_RE.test(phone)) {
        return res.status(400).json({ error: 'Введите корректный номер телефона' });
      }

      // Демо-режим: «чит-код». SMS не отправляем, код фиксированный,
      // и сразу пускаем в чат с тестовыми контактами.
      if (config.isDemoPhone(phone)) {
        return res.json({
          success: true,
          demo: true,
          code: config.demoCode,
          message: 'Демо-режим: вход без SMS',
          exists: true
        });
      }

      const lastSent = this.sendCooldowns.get(phone) || 0;
      const wait = config.sendCodeCooldownMs - (Date.now() - lastSent);
      if (wait > 0) {
        return res.status(429).json({
          error: `Повторная отправка через ${Math.ceil(wait / 1000)} сек.`
        });
      }
      // чистим устаревшие записи, чтобы Map не рос бесконечно
      const cutoff = Date.now() - config.sendCodeCooldownMs;
      for (const [p, ts] of this.sendCooldowns) {
        if (ts < cutoff) this.sendCooldowns.delete(p);
      }
      this.sendCooldowns.set(phone, Date.now());

      const code = String(Math.floor(1000 + Math.random() * 9000));
      const expiresAt = Date.now() + config.codeExpiryMinutes * 60 * 1000;

      this.db.deleteVerificationCode(phone);
      this.db.verificationCodes.push(new VerificationCode({
        phone,
        code: encryptionService.encryptMessage(code), // at-rest AES-256-GCM
        expires_at: expiresAt
      }));
      this.db.markDirty();

      await smsService.sendCode(phone, code);

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

      // Демо-режим: «чит-код» — сразу логиним с тестовыми контактами.
      if (config.isDemoPhone(phone)) {
        if (!encryptionService.safeCompare(code, config.demoCode)) {
          return res.status(400).json({ error: 'Неверный демо-код' });
        }
        const { user, token } = demoService.ensureDemoUser(phone);
        return res.json({
          success: true,
          action: 'demo',
          phone,
          name: user.name,
          user: user.toSafeJSON(),
          token
        });
      }

      const records = this.db.findVerificationCode(phone);
      if (!records.length) {
        return res.status(400).json({ error: 'Неверный или просроченный код' });
      }

      const record = records[records.length - 1];
      if (record.attempts >= config.codeMaxAttempts) {
        this.db.deleteVerificationCode(phone);
        return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код.' });
      }

      const storedCode = encryptionService.decryptMessage(record.code);
      if (!storedCode || !encryptionService.safeCompare(storedCode, code)) {
        record.attempts = (record.attempts || 0) + 1;
        this.db.markDirty();
        return res.status(400).json({ error: 'Неверный или просроченный код' });
      }

      this.db.deleteVerificationCode(phone);
      const existingUser = this.db.findUserByPhone(phone);

      if (existingUser) {
        return res.json({ success: true, action: 'login', phone, name: existingUser.name });
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
      const { firstName, lastName, username, password, publicKey, verifyToken } = req.body;
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

      const user = new User({
        id: this.db.nextId('users'),
        phone,
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

  // 6. Выход (инвалидация сессии)
  logout(req, res) {
    sessionService.revokeToken(req.token);
    res.json({ success: true });
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
}

module.exports = new AuthController();
