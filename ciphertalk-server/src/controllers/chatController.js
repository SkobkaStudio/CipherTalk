const { getDatabase } = require('../db/database');
const encryptionService = require('../services/encryptionService');
const Chat = require('../models/Chat');

class ChatController {
  constructor() {
    this.db = getDatabase();
  }

  // Получить список чатов пользователя (только своих)
  getUserChats(req, res) {
    try {
      const requestedId = parseInt(req.params.userId, 10);
      if (requestedId && requestedId !== req.userId) {
        return res.status(403).json({ error: 'Доступ только к своим чатам' });
      }

      const userChats = this.db.chatMembers
        .filter(cm => cm.user_id === req.userId)
        .map(cm => {
          const chat = this.db.findChatById(cm.chat_id);
          if (!chat) return null;
          return { ...this.getChatWithDetails(chat), role: cm.role };
        })
        .filter(Boolean)
        .sort((a, b) => b.last_message_time - a.last_message_time);

      res.json(userChats);
    } catch (error) {
      console.error('Get user chats error:', error);
      res.status(500).json({ error: 'Ошибка получения чатов' });
    }
  }

  // Получить сообщения чата (только участник)
  getMessages(req, res) {
    try {
      const chatId = parseInt(req.params.chatId, 10);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

      if (!this.db.isChatMember(chatId, req.userId)) {
        return res.status(403).json({ error: 'Нет доступа к чату' });
      }

      const messages = this.db.messages
        .filter(m => m.chat_id === chatId)
        .slice(-limit)
        .map(m => {
          if (m.deleted_for_all) {
            return {
              id: m.id,
              chat_id: m.chat_id,
              sender_id: m.sender_id,
              sender_name: '',
              sender_avatar: '',
              encrypted_content: 'Сообщение удалено',
              iv: '',
              type: 'text',
              reply_to: m.reply_to,
              edited: 0,
              deleted_for_all: 1,
              created_at: m.created_at
            };
          }
          const sender = this.db.findUserById(m.sender_id);
          const content = encryptionService.decryptMessage(m.encrypted_content);
          return {
            id: m.id,
            chat_id: m.chat_id,
            sender_id: m.sender_id,
            sender_name: sender?.name || '',
            sender_avatar: sender?.avatar || '',
            encrypted_content: content === null ? '' : content,
            iv: m.iv,
            type: m.type,
            reply_to: m.reply_to,
            edited: m.edited,
            deleted_for_all: 0,
            created_at: m.created_at
          };
        });

      res.json(messages);
    } catch (error) {
      console.error('Get messages error:', error);
      res.status(500).json({ error: 'Ошибка получения сообщений' });
    }
  }

  // Создать группу
  createGroup(req, res) {
    try {
      const { name, avatar, members, groupType } = req.body;
      const userId = req.userId;

      const chatId = this.db.nextId('chats');
      const chat = new Chat({
        id: chatId,
        type: groupType === 'supergroup' ? 'supergroup' : 'group',
        name: String(name || 'Группа').slice(0, 100),
        avatar: typeof avatar === 'string' ? avatar.slice(0, 2 * 1024 * 1024) : '',
        owner_id: userId
      });
      this.db.chats.push(chat);
      this.db.chatMembers.push({
        chat_id: chatId,
        user_id: userId,
        role: 'owner',
        joined_at: Date.now()
      });

      if (Array.isArray(members)) {
        members
          .map(Number)
          .filter(uid => Number.isInteger(uid) && uid !== userId && this.db.findUserById(uid))
          .forEach(uid => {
            this.db.chatMembers.push({
              chat_id: chatId,
              user_id: uid,
              role: 'member',
              joined_at: Date.now()
            });
          });
      }
      this.db.markDirty();

      res.json(this.getChatWithDetails(chat));
    } catch (error) {
      console.error('Create group error:', error);
      res.status(500).json({ error: 'Ошибка создания группы' });
    }
  }

  // Добавить участника
  addMember(req, res) {
    try {
      const chatId = parseInt(req.body.chatId, 10);
      const userId = parseInt(req.body.userId, 10);

      if (!this.db.isChatMember(chatId, req.userId)) {
        return res.status(403).json({ error: 'Нет доступа к чату' });
      }
      if (!this.db.findUserById(userId)) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      if (!this.db.isChatMember(chatId, userId)) {
        this.db.chatMembers.push({
          chat_id: chatId,
          user_id: userId,
          role: 'member',
          joined_at: Date.now()
        });
        this.db.markDirty();
      }

      const chat = this.db.findChatById(chatId);
      res.json(chat ? this.getChatWithDetails(chat) : null);
    } catch (error) {
      console.error('Add member error:', error);
      res.status(500).json({ error: 'Ошибка добавления участника' });
    }
  }

  // Вспомогательные методы
  getChatMembersWithDetails(chatId) {
    return this.db.chatMembers
      .filter(m => m.chat_id === chatId)
      .map(m => {
        const u = this.db.findUserById(m.user_id);
        if (!u) return null;
        return {
          id: u.id,
          name: u.name,
          firstName: u.first_name,
          lastName: u.last_name,
          phone: u.phone,
          username: u.username,
          avatar: u.avatar,
          public_key: u.public_key,
          online: u.hide_online ? 0 : u.online,
          last_seen: u.last_seen,
          role: m.role
        };
      })
      .filter(Boolean);
  }

  getLastReadMap(chatId) {
    const out = {};
    this.db.chatMembers
      .filter(m => m.chat_id === chatId)
      .forEach(m => { out[m.user_id] = m.last_read_message_id || 0; });
    return out;
  }

  getChatWithDetails(chat) {
    const members = this.getChatMembersWithDetails(chat.id);
    const chatMessages = this.db.messages.filter(m => m.chat_id === chat.id);
    const lastMsg = chatMessages[chatMessages.length - 1];
    const lastContent = lastMsg ? encryptionService.decryptMessage(lastMsg.encrypted_content) : null;

    return {
      ...(chat.toJSON ? chat.toJSON() : chat),
      members,
      last_message: lastContent === null ? '' : lastContent,
      last_message_type: lastMsg?.type || null,
      last_message_time: lastMsg?.created_at || 0,
      last_sender_id: lastMsg?.sender_id || 0,
      last_read_by: this.getLastReadMap(chat.id)
    };
  }
}

module.exports = new ChatController();
