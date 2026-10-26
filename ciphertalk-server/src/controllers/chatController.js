const { getDatabase } = require('../db/database');
const Chat = require('../models/Chat');
const { maskPhone } = require('../utils/mask');
const { isOwnerPhone, creatorLevelFor } = require('../utils/owner');
const { getCreator } = require('../utils/creators');
const { isExpired } = require('../utils/messageExpiry');

class ChatController {
  constructor() {
    this.db = getDatabase();
  }

  // Получить список чатов пользователя (только свои)
  getUserChats(req, res) {
    try {
      const requestedId = parseInt(req.params.userId, 10);
      if (requestedId && requestedId !== req.userId) {
        return res.status(403).json({ error: 'Доступ только к своим чатам' });
      }

      const userChats = this.db.chatMembers
        .filter(cm => cm.user_id === req.userId && !cm.hidden)
        .map(cm => {
          const chat = this.db.findChatById(cm.chat_id);
          if (!chat) return null;
          return { ...this.getChatWithDetails(chat, req.userId), role: cm.role };
        })
        .filter(Boolean)
        .sort((a, b) => b.last_message_time - a.last_message_time);

      res.json(userChats);
    } catch (error) {
      console.error('Get user chats error:', error);
      res.status(500).json({ error: 'Ошибка получения чатов' });
    }
  }

  /**
   * Сообщения чата. Сервер отдаёт клиентский шифротекст как есть:
   * он не знает ключа и не может расшифровать ни одно сообщение.
   */
  getMessages(req, res) {
    try {
      const chatId = parseInt(req.params.chatId, 10);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

      if (!this.db.isChatMember(chatId, req.userId)) {
        return res.status(403).json({ error: 'Нет доступа к чату' });
      }

      const clearedAt = this.db.getChatClearedAt(chatId, req.userId);
      const messages = this.db.messages
        .filter(m => m.chat_id === chatId && !isExpired(m) && (!clearedAt || m.created_at > clearedAt))
        .slice(-limit)
        .map(m => this.serializeMessage(m));

      res.json(messages);
    } catch (error) {
      console.error('Get messages error:', error);
      res.status(500).json({ error: 'Ошибка получения сообщений' });
    }
  }

  // Единая сериализация сообщения для REST и WebSocket
  serializeMessage(m) {
    const sender = this.db.findUserById(m.sender_id);
    if (m.deleted_for_all) {
      return {
        id: m.id,
        chat_id: m.chat_id,
        sender_id: m.sender_id,
        sender_name: '',
        sender_avatar: '',
        encrypted_content: '',
        iv: '',
        header: '',
        type: 'text',
        reply_to: m.reply_to,
        forwarded_from: m.forwarded_from,
        edited: 0,
        deleted_for_all: 1,
        reactions: m.reactions || {},
        pinned: m.pinned || 0,
        created_at: m.created_at
      };
    }
    return {
      id: m.id,
      chat_id: m.chat_id,
      sender_id: m.sender_id,
      sender_name: sender?.name || '',
      sender_avatar: sender?.avatar || '',
      encrypted_content: m.encrypted_content,
      content: m.encrypted_content,
      ciphertext: m.encrypted_content,
      iv: m.iv,
      header: m.header || '',
      type: m.type,
      reply_to: m.reply_to,
      forwarded_from: m.forwarded_from,
      edited: m.edited,
      deleted_for_all: m.deleted_for_all || 0,
      reactions: m.reactions || {},
      pinned: m.pinned || 0,
      expires_at: m.expires_at || null,
      created_at: m.created_at
    };
  }

  // Закреплённые сообщения чата
  getPinnedMessages(req, res) {
    try {
      const chatId = parseInt(req.params.chatId, 10);
      if (!this.db.isChatMember(chatId, req.userId)) {
        return res.status(403).json({ error: 'Нет доступа к чату' });
      }
      const clearedAt = this.db.getChatClearedAt(chatId, req.userId);
      res.json(this.db.getPinnedMessages(chatId)
        .filter(m => !clearedAt || m.created_at > clearedAt)
        .map(m => this.serializeMessage(m)));
    } catch (error) {
      console.error('Get pinned messages error:', error);
      res.status(500).json({ error: 'Ошибка получения закреплённых сообщений' });
    }
  }

  // Создать группу
  createGroup(req, res) {
    try {
      const { name, avatar, members, groupType, description } = req.body;
      const userId = req.userId;

      const chatId = this.db.nextId('chats');
      const chat = new Chat({
        id: chatId,
        type: groupType === 'supergroup' ? 'supergroup' : 'group',
        name: String(name || 'Группа').slice(0, 100),
        avatar: typeof avatar === 'string' ? avatar.slice(0, 2 * 1024 * 1024) : '',
        description: typeof description === 'string' ? description.slice(0, 500) : '',
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

      res.json(this.getChatWithDetails(chat, req.userId));
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
      const chat = this.db.findChatById(chatId);
      if (!chat) return res.status(404).json({ error: 'Чат не найден' });
      if (chat.type === 'private' || chat.type === 'saved') {
        return res.status(403).json({ error: 'В приватный чат нельзя добавлять участников' });
      }
      const myRole = this.db.chatMembers.find(m => m.chat_id === chatId && m.user_id === req.userId)?.role;
      if (chat.type === 'channel' && myRole !== 'owner' && myRole !== 'admin') {
        return res.status(403).json({ error: 'Только админы могут добавлять подписчиков' });
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

      res.json(this.getChatWithDetails(chat, req.userId));
    } catch (error) {
      console.error('Add member error:', error);
      res.status(500).json({ error: 'Ошибка добавления участника' });
    }
  }

  // ==================== ПАПКИ ====================
  getFolders(req, res) {
    try {
      res.json(this.db.getFolders(req.userId));
    } catch (error) {
      console.error('Get folders error:', error);
      res.status(500).json({ error: 'Ошибка получения папок' });
    }
  }

  createFolder(req, res) {
    try {
      const { name, emoji, color } = req.body;
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Введите название папки' });
      }
      const folder = this.db.createFolder(req.userId, name, emoji, color);
      res.json(folder);
    } catch (error) {
      console.error('Create folder error:', error);
      res.status(500).json({ error: 'Ошибка создания папки' });
    }
  }

  updateFolder(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const folder = this.db.updateFolder(id, req.userId, req.body || {});
      if (!folder) return res.status(404).json({ error: 'Папка не найдена' });
      res.json(folder);
    } catch (error) {
      console.error('Update folder error:', error);
      res.status(500).json({ error: 'Ошибка обновления папки' });
    }
  }

  deleteFolder(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!this.db.deleteFolder(id, req.userId)) {
        return res.status(404).json({ error: 'Папка не найдена' });
      }
      // Чаты остаются, но теряют привязку к папке
      this.db.chats.forEach(c => { if (c.folder_id === id) c.folder_id = null; });
      this.db.markDirty();
      res.json({ success: true });
    } catch (error) {
      console.error('Delete folder error:', error);
      res.status(500).json({ error: 'Ошибка удаления папки' });
    }
  }

  // ==================== Вспомогательные методы ====================
  getChatMembersWithDetails(chatId, requesterId = null) {
    return this.db.chatMembers
      .filter(m => m.chat_id === chatId)
      .map(m => {
        const u = this.db.findUserById(m.user_id);
        if (!u) return null;
        const isSelf = requesterId === null || u.id === requesterId;
        return {
          id: u.id,
          public_id: this.db.getPublicUserId ? this.db.getPublicUserId(u.id) : (u.public_id || ''),
          name: u.name,
          firstName: u.first_name,
          lastName: u.last_name,
          phone: isSelf ? u.phone : maskPhone(u.phone),
          username: u.username,
          avatar: u.avatar,
          bio: u.bio || '',
          public_key: u.public_key,
          online: u.hide_online ? 0 : u.online,
          last_seen: u.last_seen,
          is_owner: isOwnerPhone(u.phone) ? 1 : 0,
          // Корона разработчика — СТРОГО по полному номеру телефона (не по id).
          // Считаем до маскирования номера, чтобы клиент тоже мог сверить номер.
          creator_level: creatorLevelFor({ phone: u.phone }),
          creator_phone: String(u.phone || '').replace(/\D/g, ''),
          creator_name: (getCreator(u.phone) || {}).name || null,
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

  getChatWithDetails(chat, requesterId = null) {
    const members = this.getChatMembersWithDetails(chat.id, requesterId);
    const clearedAt = requesterId ? this.db.getChatClearedAt(chat.id, requesterId) : 0;
    const chatMessages = this.db.messages.filter(m =>
      m.chat_id === chat.id && !isExpired(m) && (!clearedAt || m.created_at > clearedAt)
    );
    const lastMsg = chatMessages[chatMessages.length - 1];
    // Никакой расшифровки на сервере: отдаём шифротекст + iv + header,
    // расшифрует клиент, у которого есть ключ.
    const lastContent = lastMsg && !lastMsg.deleted_for_all ? lastMsg.encrypted_content : '';
    let other_user = null;
    if (chat && chat.type === 'private' && Array.isArray(members) && requesterId) {
      const other = members.find(m => m && m.id !== requesterId) || members[0];
      if (other) {
        const u = this.db.findUserById(other.id);
        other_user = { id: other.id, avatar: u ? u.avatar : (other.avatar || '') };
      }
    }

    return {
      ...(chat.toJSON ? chat.toJSON() : chat),
      members,
      other_user,
      last_message: lastContent || '',
      last_message_iv: lastMsg && !lastMsg.deleted_for_all ? lastMsg.iv : '',
      last_message_header: lastMsg && !lastMsg.deleted_for_all ? (lastMsg.header || '') : '',
      last_message_type: lastMsg?.type || null,
      last_message_time: lastMsg?.created_at || 0,
      last_sender_id: lastMsg?.sender_id || 0,
      last_read_by: this.getLastReadMap(chat.id)
    };
  }
}

module.exports = new ChatController();