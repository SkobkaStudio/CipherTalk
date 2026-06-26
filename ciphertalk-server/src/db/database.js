const fs = require('fs');
const config = require('../config');

class Database {
  constructor() {
    this.data = {
      users: [],
      verification_codes: [],
      chats: [],
      chat_members: [],
      messages: [],
      files: [],
      counters: { users: 0, chats: 0, messages: 0, files: 0 }
    };
    this.saveInterval = null;
  }

  load() {
    try {
      if (fs.existsSync(config.dbFile)) {
        this.data = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
        console.log('✅ База данных загружена');
        return true;
      }
      return false;
    } catch (e) {
      console.error('Ошибка загрузки БД:', e);
      return false;
    }
  }

  save() {
    try {
      fs.writeFileSync(config.dbFile, JSON.stringify(this.data, null, 2));
      return true;
    } catch (e) {
      console.error('Ошибка сохранения БД:', e);
      return false;
    }
  }

  startAutoSave() {
    if (this.saveInterval) clearInterval(this.saveInterval);
    this.saveInterval = setInterval(() => this.save(), config.saveInterval);
  }

  stopAutoSave() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  // Геттеры для коллекций
  get users() { return this.data.users; }
  get verificationCodes() { return this.data.verification_codes; }
  get chats() { return this.data.chats; }
  get chatMembers() { return this.data.chat_members; }
  get messages() { return this.data.messages; }
  get files() { return this.data.files; }
  get counters() { return this.data.counters; }

  // Методы для работы с пользователями
  findUserById(id) {
    return this.data.users.find(u => u.id === id);
  }

  findUserByPhone(phone) {
    return this.data.users.find(u => u.phone === phone);
  }

  findUserByUsername(username) {
    const clean = username.replace(/^@/, '').toLowerCase();
    return this.data.users.find(u => (u.username || '').toLowerCase() === clean);
  }

  isUsernameTaken(username, excludeUserId = null) {
    const clean = username.replace(/^@/, '').toLowerCase();
    return this.data.users.some(u => 
      u.id !== excludeUserId && (u.username || '').toLowerCase() === clean
    );
  }

  // Методы для работы с чатами
  findChatById(id) {
    return this.data.chats.find(c => c.id === id);
  }

  getChatMembers(chatId) {
    return this.data.chat_members.filter(m => m.chat_id === chatId);
  }

  getChatMessages(chatId, limit = 50) {
    return this.data.messages
      .filter(m => m.chat_id === chatId)
      .slice(-limit);
  }

  getUserChats(userId) {
    return this.data.chat_members
      .filter(cm => cm.user_id === userId)
      .map(cm => this.findChatById(cm.chat_id))
      .filter(Boolean);
  }

  // Методы для работы с сообщениями
  findMessageById(id) {
    return this.data.messages.find(m => m.id === id);
  }

  // Методы для работы с кодами верификации
  findVerificationCode(phone, code) {
    const now = Date.now();
    return this.data.verification_codes.find(
      c => c.phone === phone && c.code === code && c.expires_at > now
    );
  }

  deleteVerificationCode(phone) {
    this.data.verification_codes = this.data.verification_codes.filter(
      c => c.phone !== phone
    );
  }

  // Генерация ID
  nextId(type) {
    this.data.counters[type] = (this.data.counters[type] || 0) + 1;
    return this.data.counters[type];
  }
}

// Singleton
let instance = null;
module.exports = {
  getDatabase: () => {
    if (!instance) {
      instance = new Database();
      instance.load();
      instance.startAutoSave();
    }
    return instance;
  }
};