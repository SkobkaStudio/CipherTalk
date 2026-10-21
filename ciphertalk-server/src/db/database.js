const fs = require('fs');
const config = require('../config');
const User = require('../models/User');

const DEFAULT_COUNTERS = {
  users: 0,
  chats: 0,
  messages: 0,
  files: 0,
  sessions: 0,
  folders: 0
};

class Database {
  constructor() {
    this.data = {
      users: [],
      verification_codes: [],
      chats: [],
      chat_members: [],
      messages: [],
      files: [],
      sessions: [],
      folders: [],
      // group_keys: { chat_id, version, wrapped: { user_id: { iv, ct } } }
      // Сервер хранит только «завёрнутые» ключи — сам ключ группы он не видит.
      group_keys: [],
      counters: { ...DEFAULT_COUNTERS }
    };
    this.saveInterval = null;
    this.saveTimeout = null;
    this.dirty = false;
  }

  load() {
    try {
      if (fs.existsSync(config.dbFile)) {
        const raw = fs.readFileSync(config.dbFile, 'utf8');
        if (raw.trim()) {
          this.data = JSON.parse(raw);
          this.migrate();
          console.log('✅ База данных загружена');
          return true;
        }
      }
      return false;
    } catch (e) {
      console.error('Ошибка загрузки БД:', e);
      return false;
    }
  }

  // Страховка от старых/неполных файлов БД
  migrate() {
    const collections = [
      'users', 'verification_codes', 'chats', 'chat_members',
      'messages', 'files', 'sessions', 'folders', 'group_keys'
    ];
    collections.forEach(name => {
      if (!Array.isArray(this.data[name])) this.data[name] = [];
    });
    if (!this.data.counters || typeof this.data.counters !== 'object') {
      this.data.counters = { ...DEFAULT_COUNTERS };
    }
    Object.keys(DEFAULT_COUNTERS).forEach(key => {
      if (typeof this.data.counters[key] !== 'number') this.data.counters[key] = 0;
    });
    // Счётчики не должны быть меньше уже существующих записей
    collections
      .filter(name => name !== 'verification_codes')
      .forEach(name => {
        const coll = this.data[name];
        const maxId = coll.reduce((max, item) => {
          const id = item && typeof item.id === 'number' ? item.id : 0;
          return id > max ? id : max;
        }, 0);
        if (maxId > this.data.counters[name]) this.data.counters[name] = maxId;
      });
    // Migrate messages to have new fields
    if (Array.isArray(this.data.messages)) {
      this.data.messages.forEach(m => {
        if (!m.deleted_by) m.deleted_by = [];
        if (m.deleted_for_all === undefined) m.deleted_for_all = 0;
        if (!m.reactions) m.reactions = {};
        if (m.pinned === undefined) m.pinned = 0;
        if (m.header === undefined) m.header = '';
        if (m.forwarded_from === undefined) m.forwarded_from = null;
      });
    }
    if (Array.isArray(this.data.group_keys)) {
      this.data.group_keys.forEach(g => {
        if (!g.wrapped || typeof g.wrapped !== 'object') g.wrapped = {};
        if (typeof g.version !== 'number') g.version = 1;
      });
    }
    if (Array.isArray(this.data.folders)) {
      this.data.folders.forEach(f => {
        if (!Array.isArray(f.chat_ids)) f.chat_ids = [];
        if (f.emoji === undefined) f.emoji = '📁';
        if (f.color === undefined) f.color = '';
      });
    }
    if (Array.isArray(this.data.users)) {
      this.data.users.forEach(u => {
        if (u.bio === undefined) u.bio = '';
        if (u.hide_online === undefined) u.hide_online = 0;
        // JSON.parse лишает записи методов класса User — восстанавливаем прототип,
        // иначе после рестарта ломаются verifyPassword()/toSafeJSON()/setPassword().
        if (Object.getPrototypeOf(u) !== User.prototype) {
          Object.setPrototypeOf(u, User.prototype);
        }
      });
    }
    if (Array.isArray(this.data.chat_members)) {
      this.data.chat_members.forEach(cm => {
        if (typeof cm.last_read_message_id !== 'number') cm.last_read_message_id = 0;
      });
    }
    if (Array.isArray(this.data.chats)) {
      this.data.chats.forEach(c => {
        if (c.description === undefined) c.description = '';
        if (c.is_pinned === undefined) c.is_pinned = false;
        if (c.is_channel === undefined) c.is_channel = c.type === 'channel';
      });
    }
  }

  /**
   * Атомарное сохранение: пишем во временный файл и переименовываем.
   * Обрыв на записи не может оставить битый JSON.
   */
  save() {
    try {
      const json = JSON.stringify(this.data, null, 2);
      const tmp = config.dbFile + '.tmp';
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, config.dbFile);
      this.dirty = false;
      return true;
    } catch (e) {
      console.error('Ошибка сохранения БД:', e);
      return false;
    }
  }

  /**
   * Помечаем данные изменёнными: сохраняемся почти сразу (debounce),
   * чтобы падение процесса не теряло сообщения.
   */
  markDirty() {
    this.dirty = true;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.save();
    }, config.saveDebounce);
  }

  startAutoSave() {
    if (this.saveInterval) clearInterval(this.saveInterval);
    this.saveInterval = setInterval(() => {
      if (this.dirty) this.save();
    }, config.saveInterval);
  }

  stopAutoSave() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
  }

  flush() {
    this.stopAutoSave();
    if (this.dirty) this.save();
  }

  // Геттеры для коллекций
  get users() { return this.data.users; }
  get verificationCodes() { return this.data.verification_codes; }
  get chats() { return this.data.chats; }
  get chatMembers() { return this.data.chat_members; }
  get messages() { return this.data.messages; }
  get files() { return this.data.files; }
  get sessions() { return this.data.sessions; }
  get folders() { return this.data.folders; }
  get groupKeys() { return this.data.group_keys; }
  get counters() { return this.data.counters; }

  // Методы для работы с пользователями
  findUserById(id) {
    return this.data.users.find(u => u.id === id);
  }

  findUserByPhone(phone) {
    return this.data.users.find(u => u.phone === phone);
  }

  isUsernameTaken(username, excludeUserId = null) {
    const clean = String(username).replace(/^@/, '').toLowerCase();
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

  isChatMember(chatId, userId) {
    return this.data.chat_members.some(m => m.chat_id === chatId && m.user_id === userId);
  }

  // Методы для работы с сообщениями
  findMessageById(id) {
    return this.data.messages.find(m => m.id === id);
  }

  addMessage(message) {
    this.data.messages.push(message);
    this.markDirty();
    return message;
  }

  deleteMessage(id) {
    const before = this.data.messages.length;
    this.data.messages = this.data.messages.filter(m => m.id !== id);
    const removed = this.data.messages.length !== before;
    if (removed) this.markDirty();
    return removed;
  }

  // ==================== Групповые ключи (E2EE) ====================
  // Сервер видит только «завёрнутые» (wrapped) ключи: для каждого участника
  // отдельный блоб, расшифровать который может только владелец приватного ключа.

  findGroupKey(chatId) {
    return this.data.group_keys.find(g => g.chat_id === chatId) || null;
  }

  saveGroupKey(chatId, version, wrapped, createdBy) {
    const existing = this.findGroupKey(chatId);
    if (existing) {
      existing.version = version;
      existing.wrapped = wrapped;
      existing.created_by = createdBy;
      existing.updated_at = Date.now();
      this.markDirty();
      return existing;
    }
    const record = {
      chat_id: chatId,
      version,
      wrapped,
      created_by: createdBy,
      updated_at: Date.now()
    };
    this.data.group_keys.push(record);
    this.markDirty();
    return record;
  }

  deleteGroupKey(chatId) {
    const before = this.data.group_keys.length;
    this.data.group_keys = this.data.group_keys.filter(g => g.chat_id !== chatId);
    const removed = this.data.group_keys.length !== before;
    if (removed) this.markDirty();
    return removed;
  }

  // ==================== Папки чатов ====================
  findFolderById(id) {
    return this.data.folders.find(f => f.id === id) || null;
  }

  getFolders(userId) {
    return this.data.folders.filter(f => f.user_id === userId);
  }

  createFolder(userId, name, emoji, color) {
    const folder = {
      id: this.nextId('folders'),
      user_id: userId,
      name: String(name || 'Папка').slice(0, 60),
      emoji: String(emoji || '📁').slice(0, 8),
      color: String(color || '').slice(0, 32),
      chat_ids: [],
      created_at: Date.now()
    };
    this.data.folders.push(folder);
    this.markDirty();
    return folder;
  }

  updateFolder(id, userId, patch = {}) {
    const folder = this.findFolderById(id);
    if (!folder || folder.user_id !== userId) return null;
    if (patch.name !== undefined) folder.name = String(patch.name).slice(0, 60);
    if (patch.emoji !== undefined) folder.emoji = String(patch.emoji).slice(0, 8);
    if (patch.color !== undefined) folder.color = String(patch.color).slice(0, 32);
    if (Array.isArray(patch.chat_ids)) {
      folder.chat_ids = patch.chat_ids.map(Number).filter(Number.isInteger);
    }
    this.markDirty();
    return folder;
  }

  deleteFolder(id, userId) {
    const folder = this.findFolderById(id);
    if (!folder || folder.user_id !== userId) return false;
    this.data.folders = this.data.folders.filter(f => f.id !== id);
    this.markDirty();
    return true;
  }

  // ==================== Закреплённые сообщения ====================
  setMessagePinned(messageId, pinned) {
    const message = this.findMessageById(messageId);
    if (!message) return null;
    message.pinned = pinned ? 1 : 0;
    this.markDirty();
    return message;
  }

  getPinnedMessages(chatId) {
    return this.data.messages.filter(m => m.chat_id === chatId && m.pinned);
  }

  // Методы для работы с кодами верификации
  findVerificationCode(phone) {
    const now = Date.now();
    return this.data.verification_codes.filter(
      c => c.phone === phone && c.expires_at > now
    );
  }

  deleteVerificationCode(phone) {
    const before = this.data.verification_codes.length;
    this.data.verification_codes = this.data.verification_codes.filter(
      c => c.phone !== phone
    );
    if (this.data.verification_codes.length !== before) this.markDirty();
  }

  // Сессии (ключ — хеш токена). Присваивание геттеру не работает,
  // поэтому удаление делаем здесь на this.data.
  deleteSessionByHash(hash) {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(s => s.token_hash !== hash);
    const removed = this.data.sessions.length !== before;
    if (removed) this.markDirty();
    return removed;
  }

  purgeExpiredSessions(now = Date.now()) {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(s => !s.isExpired(now));
    if (this.data.sessions.length !== before) this.markDirty();
  }

  // Генерация ID
  nextId(type) {
    this.data.counters[type] = (this.data.counters[type] || 0) + 1;
    this.markDirty();
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
