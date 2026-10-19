const config = require('../config');
const { getDatabase } = require('../db/database');
const User = require('../models/User');
const Chat = require('../models/Chat');
const sessionService = require('./sessionService');

/**
 * Демо-режим («чит-код»): номер из config.demoPhone пропускает SMS и сразу
 * пускает в чат с тестовыми контактами (Алиса, Боб). Нужен только для показа;
 * в продакшене отключается переменной DEMO_MODE=0.
 */
class DemoService {
  /**
   * Гарантирует наличие демо-пользователя и тестовых контактов с чатами.
   * Возвращает демо-пользователя и свежий токен сессии.
   */
  ensureDemoUser(phone) {
    const db = getDatabase();
    const demoPhone = phone || config.demoPhone;

    let demo = db.findUserByPhone(demoPhone);
    if (!demo) {
      demo = new User({
        id: db.nextId('users'),
        phone: demoPhone,
        first_name: 'Демо',
        last_name: 'Пользователь',
        username: 'demo',
        public_key: ''
      });
      demo.setPassword('demo123');
      db.users.push(demo);
    }

    // Тестовые контакты
    const alice = this.ensureContact('alice', '+70000000001', 'Алиса', 'Иванова');
    const bob = this.ensureContact('bob', '+70000000002', 'Боб', 'Смит');

    // "Избранное" для демо-пользователя
    this.ensureSavedChat(demo.id);

    // Приватные чаты демо <-> Алиса/Боб
    this.ensurePrivateChat(demo.id, alice.id);
    this.ensurePrivateChat(demo.id, bob.id);

    db.markDirty();

    const { token } = sessionService.create(demo.id, { userAgent: 'demo-mode' });
    return { user: demo, token };
  }

  ensureContact(username, phone, firstName, lastName) {
    const db = getDatabase();
    let user = db.findUserByPhone(phone);
    if (!user) {
      user = new User({
        id: db.nextId('users'),
        phone,
        first_name: firstName,
        last_name: lastName,
        username,
        public_key: ''
      });
      user.setPassword('demo123');
      db.users.push(user);
    }
    this.ensureSavedChat(user.id);
    return user;
  }

  ensureSavedChat(userId) {
    const db = getDatabase();
    const saved = db.chats.find(c =>
      c.type === 'saved' && db.isChatMember(c.id, userId)
    );
    if (saved) return saved;

    const chatId = db.nextId('chats');
    db.chats.push(new Chat({
      id: chatId,
      type: 'saved',
      name: 'Избранное',
      owner_id: userId
    }));
    db.chatMembers.push({
      chat_id: chatId,
      user_id: userId,
      role: 'owner',
      joined_at: Date.now()
    });
    return db.findChatById(chatId);
  }

  ensurePrivateChat(userAId, userBId) {
    const db = getDatabase();
    const myChats = db.chatMembers
      .filter(cm => cm.user_id === userAId)
      .map(cm => cm.chat_id);

    for (const cid of myChats) {
      const chat = db.findChatById(cid);
      if (!chat || chat.type !== 'private') continue;
      if (db.isChatMember(cid, userBId)) return chat;
    }

    const chatId = db.nextId('chats');
    db.chats.push(new Chat({
      id: chatId,
      type: 'private',
      owner_id: null
    }));
    const now = Date.now();
    db.chatMembers.push({ chat_id: chatId, user_id: userAId, role: 'member', joined_at: now });
    db.chatMembers.push({ chat_id: chatId, user_id: userBId, role: 'member', joined_at: now });
    return db.findChatById(chatId);
  }
}

module.exports = new DemoService();
