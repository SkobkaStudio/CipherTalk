const { getDatabase } = require('../db/database');
const User = require('../models/User');
const VerificationCode = require('../models/VerificationCode');
const Chat = require('../models/Chat');
const smsService = require('../services/smsService');
const encryptionService = require('../services/encryptionService');
const config = require('../config');

class AuthController {
  constructor() {
    this.db = getDatabase();
  }

  // 1. Отправка кода
  async sendCode(req, res) {
    try {
      const { phone } = req.body;
      if (!phone) {
        return res.status(400).json({ error: 'Введите номер телефона' });
      }

      const code = String(Math.floor(1000 + Math.random() * 9000));
      const expiresAt = Date.now() + config.codeExpiryMinutes * 60 * 1000;

      // Удаляем старые коды
      this.db.deleteVerificationCode(phone);
      
      // Сохраняем новый код
      const verificationCode = new VerificationCode({
        phone,
        code,
        expires_at: expiresAt
      });
      this.db.verificationCodes.push(verificationCode);

      // Отправляем SMS
      await smsService.sendCode(phone, code);

      const existingUser = this.db.findUserByPhone(phone);

      res.json({
        success: true,
        message: 'Код отправлен',
        exists: !!existingUser
      });
    } catch (error) {
      console.error('Send code error:', error);
      res.status(500).json({ error: 'Ошибка отправки кода' });
    }
  }

  // 2. Проверка кода
  verifyCode(req, res) {
    try {
      const { phone, code } = req.body;

      const record = this.db.findVerificationCode(phone, code);
      if (!record) {
        return res.status(400).json({ error: 'Неверный или просроченный код' });
      }

      this.db.deleteVerificationCode(phone);

      const existingUser = this.db.findUserByPhone(phone);

      if (existingUser) {
        res.json({
          success: true,
          action: 'login',
          phone,
          name: existingUser.name
        });
      } else {
        res.json({
          success: true,
          action: 'register',
          phone
        });
      }
    } catch (error) {
      console.error('Verify code error:', error);
      res.status(500).json({ error: 'Ошибка проверки кода' });
    }
  }

  // 3. Регистрация
  register(req, res) {
    try {
      const { phone, firstName, lastName, username, password, publicKey } = req.body;

      // Валидация
      if (!phone) {
        return res.status(400).json({ error: 'Нет номера телефона' });
      }
      if (!firstName || firstName.trim().length < 2) {
        return res.status(400).json({ error: 'Имя обязательно (минимум 2 символа)' });
      }
      if (!username || username.length < config.usernameMinLength) {
        return res.status(400).json({ error: `Username минимум ${config.usernameMinLength} символов` });
      }
      if (!password || password.length < config.passwordMinLength) {
        return res.status(400).json({ error: `Пароль минимум ${config.passwordMinLength} символов` });
      }

      // Проверка номера
      if (this.db.findUserByPhone(phone)) {
        return res.status(400).json({ error: 'Номер уже зарегистрирован' });
      }

      // Проверка username
      if (this.db.isUsernameTaken(username)) {
        return res.status(400).json({ error: 'Username уже занят' });
      }

      // Создаем пользователя
      const userId = this.db.nextId('users');
      const user = new User({
        id: userId,
        phone,
        first_name: firstName.trim(),
        last_name: lastName ? lastName.trim() : '',
        username: username.replace(/^@/, '').toLowerCase(),
        public_key: publicKey || ''
      });
      user.setPassword(password);

      this.db.users.push(user);

      // Создаем "Избранное"
      const savedChatId = this.db.nextId('chats');
      const savedChat = new Chat({
        id: savedChatId,
        type: 'saved',
        name: 'Избранное',
        owner_id: user.id
      });
      this.db.chats.push(savedChat);
      this.db.chatMembers.push({
        chat_id: savedChatId,
        user_id: user.id,
        role: 'owner',
        joined_at: Date.now()
      });

      console.log(`\n✅ Новый пользователь зарегистрирован:`);
      console.log(`👤 ${user.name} (@${user.username})`);
      console.log(`📱 ${user.phone}\n`);

      res.json({
        success: true,
        user: user.toSafeJSON()
      });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ error: 'Ошибка регистрации' });
    }
  }

  // 4. Вход
  login(req, res) {
    try {
      const { phone, password, publicKey } = req.body;

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

      if (publicKey) {
        user.public_key = publicKey;
      }

      console.log(`\n✅ Вход пользователя: ${user.name} (@${user.username})`);

      res.json({
        success: true,
        user: user.toSafeJSON()
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Ошибка входа' });
    }
  }

  // 5. Проверка username
  checkUsername(req, res) {
    try {
      const { username } = req.query;
      if (!username) {
        return res.json({ available: false, error: 'Пустой username' });
      }

      const clean = username.replace(/^@/, '').toLowerCase();
      
      if (clean.length < config.usernameMinLength) {
        return res.json({ 
          available: false, 
          error: `Минимум ${config.usernameMinLength} символа` 
        });
      }
      
      if (!/^[a-z0-9_]+$/.test(clean)) {
        return res.json({ 
          available: false, 
          error: 'Только латиница, цифры и _' 
        });
      }

      const taken = this.db.isUsernameTaken(clean);
      
      res.json({
        available: !taken,
        username: clean
      });
    } catch (error) {
      console.error('Check username error:', error);
      res.status(500).json({ error: 'Ошибка проверки username' });
    }
  }
}

module.exports = new AuthController();