const { getDatabase } = require('../db/database');

class ChatController {
  constructor() {
    this.db = getDatabase();
  }

  // Получить список чатов пользователя
  getUserChats(req, res) {
    try {
      const userId = parseInt(req.params.userId) || parseInt(req.query.userId);
      
      const userChats = this.db.chatMembers
        .filter(cm => cm.user_id === userId)
        .map(cm => {
          const chat = this.db.findChatById(cm.chat_id);
          if (!chat) return null;
          
          const members = this.getChatMembersWithDetails(chat.id);
          const chatMessages = this.db.messages.filter(m => m.chat_id === chat.id);
          const lastMsg = chatMessages[chatMessages.length - 1];
          
          return {
            ...chat,
            role: cm.role,
            members,
            last_message: lastMsg?.encrypted_content || '',
            last_message_time: lastMsg?.created_at || 0,
            last_sender_id: lastMsg?.sender_id || 0
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.last_message_time - a.last_message_time);

      res.json(userChats);
    } catch (error) {
      console.error('Get user chats error:', error);
      res.status(500).json({ error: 'Ошибка получения чатов' });
    }
  }

  // Получить сообщения чата
  getMessages(req, res) {
    try {
      const chatId = parseInt(req.params.chatId);
      const limit = parseInt(req.query.limit) || 50;
      
      const messages = this.db.messages
        .filter(m => m.chat_id === chatId)
        .slice(-limit)
        .map(m => {
          const sender = this.db.findUserById(m.sender_id);
          return {
            id: m.id,
            chat_id: m.chat_id,
            sender_id: m.sender_id,
            sender_name: sender?.name || '',
            sender_avatar: sender?.avatar || '',
            encrypted_content: m.encrypted_content,
            iv: m.iv,
            type: m.type,
            reply_to: m.reply_to,
            edited: m.edited,
            created_at: m.created_at
          };
        });

      res.json(messages);
    } catch (error) {
      console.error('Get messages error:', error);
      res.status(500).json({ error: 'Ошибка получения сообщений' });
    }
  }

  // Создать группу (REST версия)
  createGroup(req, res) {
    try {
      const { name, avatar, members, groupType, userId } = req.body;
      
      const chatId = this.db.nextId('chats');
      const Chat = require('../models/Chat');
      const chat = new Chat({
        id: chatId,
        type: groupType || 'group',
        name: name || 'Группа',
        avatar: avatar || '',
        owner_id: userId
      });
      this.db.chats.push(chat);
      
      this.db.chatMembers.push({ 
        chat_id: chatId, 
        user_id: userId, 
        role: 'owner', 
        joined_at: Date.now() 
      });
      
      if (members && Array.isArray(members)) {
        members.forEach(uid => {
          this.db.chatMembers.push({ 
            chat_id: chatId, 
            user_id: uid, 
            role: 'member', 
            joined_at: Date.now() 
          });
        });
      }

      const chatWithMembers = this.getChatWithMembers(chatId);
      res.json(chatWithMembers);
    } catch (error) {
      console.error('Create group error:', error);
      res.status(500).json({ error: 'Ошибка создания группы' });
    }
  }

  // Добавить участника
  addMember(req, res) {
    try {
      const { chatId, userId } = req.body;
      
      const exists = this.db.chatMembers.find(
        m => m.chat_id === chatId && m.user_id === userId
      );
      
      if (!exists) {
        this.db.chatMembers.push({ 
          chat_id: chatId, 
          user_id: userId, 
          role: 'member', 
          joined_at: Date.now() 
        });
      }

      const chatWithMembers = this.getChatWithMembers(chatId);
      res.json(chatWithMembers);
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
          online: u.online,
          last_seen: u.last_seen,
          role: m.role
        };
      })
      .filter(Boolean);
  }

  getChatWithMembers(chatId) {
    const chat = this.db.findChatById(chatId);
    if (!chat) return null;
    
    const members = this.getChatMembersWithDetails(chatId);
    const chatMessages = this.db.messages.filter(m => m.chat_id === chatId);
    const lastMsg = chatMessages[chatMessages.length - 1];
    
    return {
      ...chat,
      members,
      last_message: lastMsg?.encrypted_content || '',
      last_message_time: lastMsg?.created_at || 0,
      last_sender_id: lastMsg?.sender_id || 0
    };
  }
}

module.exports = new ChatController();