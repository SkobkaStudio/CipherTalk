const WebSocket = require('ws');
const presenceService = require('./presenceService');
const { getDatabase } = require('../db/database');

class WebSocketService {
  constructor(server) {
    this.wss = new WebSocket.Server({ server });
    this.db = getDatabase();
    this.setupHandlers();
  }

  setupHandlers() {
    this.wss.on('connection', (ws) => {
      let currentUserId = null;

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          this.handleMessage(ws, msg, currentUserId, (userId) => {
            currentUserId = userId;
          });
        } catch (e) {
          console.error('WS Error:', e);
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(currentUserId);
      });
    });
  }

  handleMessage(ws, msg, currentUserId, setUserId) {
    const handlers = {
      'auth': () => this.handleAuth(ws, msg, setUserId),
      'get_public_key': () => this.handleGetPublicKey(ws, msg),
      'start_chat': () => this.handleStartChat(ws, msg, currentUserId),
      'create_group': () => this.handleCreateGroup(ws, msg, currentUserId),
      'send_message': () => this.handleSendMessage(ws, msg, currentUserId),
      'edit_message': () => this.handleEditMessage(ws, msg, currentUserId),
      'delete_message': () => this.handleDeleteMessage(ws, msg, currentUserId),
      'get_messages': () => this.handleGetMessages(ws, msg),
      'typing': () => this.handleTyping(msg, currentUserId),
      'add_member': () => this.handleAddMember(ws, msg, currentUserId),
      'set_public_key': () => this.handleSetPublicKey(msg, currentUserId)
    };

    const handler = handlers[msg.type];
    if (handler) {
      handler();
    }
  }

  handleAuth(ws, msg, setUserId) {
    const userId = msg.userId;
    setUserId(userId);
    presenceService.setOnline(userId, ws);

    const user = this.db.findUserById(userId);
    if (user) {
      user.online = 1;
      user.last_seen = Date.now();
    }

    // Отправляем список чатов
    const userChats = this.getUserChatsWithDetails(userId);
    ws.send(JSON.stringify({ type: 'chats', chats: userChats }));
  }

  handleGetPublicKey(ws, msg) {
    const user = this.db.findUserById(msg.targetUserId);
    ws.send(JSON.stringify({
      type: 'public_key',
      userId: msg.targetUserId,
      publicKey: user?.public_key || ''
    }));
  }

  handleStartChat(ws, msg, currentUserId) {
    const myChats = this.db.chatMembers
      .filter(cm => cm.user_id === currentUserId)
      .map(cm => cm.chat_id);
    
    const targetChats = this.db.chatMembers
      .filter(cm => cm.user_id === msg.targetUserId)
      .map(cm => cm.chat_id);
    
    let chatId = null;
    for (const cid of myChats) {
      if (targetChats.includes(cid)) {
        const chat = this.db.findChatById(cid);
        if (chat && chat.type === 'private') {
          chatId = chat.id;
          break;
        }
      }
    }

    if (!chatId) {
      chatId = this.db.nextId('chats');
      const Chat = require('../models/Chat');
      const chat = new Chat({
        id: chatId,
        type: 'private',
        owner_id: null
      });
      this.db.chats.push(chat);
      this.db.chat_members.push({ chat_id: chatId, user_id: currentUserId, role: 'member', joined_at: Date.now() });
      this.db.chat_members.push({ chat_id: chatId, user_id: msg.targetUserId, role: 'member', joined_at: Date.now() });
    }

    const members = this.getChatMembersWithDetails(chatId);
    ws.send(JSON.stringify({ type: 'chat_created', chatId, members }));
  }

  handleCreateGroup(ws, msg, currentUserId) {
    const chatId = this.db.nextId('chats');
    const Chat = require('../models/Chat');
    const chat = new Chat({
      id: chatId,
      type: msg.groupType || 'group',
      name: msg.name || 'Группа',
      avatar: msg.avatar || '',
      owner_id: currentUserId
    });
    this.db.chats.push(chat);
    
    this.db.chat_members.push({ chat_id: chatId, user_id: currentUserId, role: 'owner', joined_at: Date.now() });
    
    if (msg.members && Array.isArray(msg.members)) {
      msg.members.forEach(uid => {
        this.db.chat_members.push({ chat_id: chatId, user_id: uid, role: 'member', joined_at: Date.now() });
      });
    }

    const members = this.getChatMembersWithDetails(chatId);
    const notification = JSON.stringify({
      type: 'new_chat',
      chat: { id: chatId, type: msg.groupType || 'group', name: msg.name, members }
    });

    members.forEach(m => {
      presenceService.sendToUser(m.id, notification);
    });
  }

  handleSendMessage(ws, msg, currentUserId) {
    const messageId = this.db.nextId('messages');
    const now = Date.now();
    
    const Message = require('../models/Message');
    const message = new Message({
      id: messageId,
      chat_id: msg.chatId,
      sender_id: currentUserId,
      encrypted_content: msg.content,
      iv: msg.iv || '',
      type: msg.msgType || 'text',
      reply_to: msg.replyTo || null,
      created_at: now
    });
    
    this.db.messages.push(message);

    const sender = this.db.findUserById(currentUserId);
    const payload = JSON.stringify({
      type: 'new_message',
      message: {
        id: message.id,
        chatId: message.chat_id,
        senderId: message.sender_id,
        content: message.encrypted_content,
        iv: message.iv,
        type: message.type,
        replyTo: message.reply_to,
        edited: 0,
        createdAt: message.created_at
      }
    });

    const members = this.db.chatMembers
      .filter(m => m.chat_id === msg.chatId)
      .map(m => m.user_id);

    members.forEach(memberId => {
      presenceService.sendToUser(memberId, payload);
    });

    // Обновление чата
    const updatePayload = JSON.stringify({
      type: 'chat_updated',
      chatId: msg.chatId,
      lastMessage: msg.content,
      lastMessageTime: now,
      lastSenderId: currentUserId,
      senderName: sender?.name
    });

    members.forEach(memberId => {
      presenceService.sendToUser(memberId, updatePayload);
    });
  }

  handleEditMessage(ws, msg, currentUserId) {
    const msgRec = this.db.messages.find(
      m => m.id === msg.messageId && m.sender_id === currentUserId
    );
    if (msgRec) {
      msgRec.encrypted_content = msg.content;
      msgRec.edited = 1;
    }
    
    const members = this.db.chatMembers
      .filter(m => m.chat_id === msg.chatId)
      .map(m => m.user_id);

    const payload = JSON.stringify({
      type: 'message_edited',
      messageId: msg.messageId,
      content: msg.content,
      chatId: msg.chatId
    });

    members.forEach(memberId => {
      presenceService.sendToUser(memberId, payload);
    });
  }

  handleDeleteMessage(ws, msg, currentUserId) {
    this.db.messages = this.db.messages.filter(
      m => !(m.id === msg.messageId && m.sender_id === currentUserId)
    );
    
    const members = this.db.chatMembers
      .filter(m => m.chat_id === msg.chatId)
      .map(m => m.user_id);

    const payload = JSON.stringify({
      type: 'message_deleted',
      messageId: msg.messageId,
      chatId: msg.chatId
    });

    members.forEach(memberId => {
      presenceService.sendToUser(memberId, payload);
    });
  }

  handleGetMessages(ws, msg) {
    const chatMessages = this.db.messages
      .filter(m => m.chat_id === msg.chatId)
      .slice(-50)
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

    ws.send(JSON.stringify({ type: 'messages', chatId: msg.chatId, messages: chatMessages }));
  }

  handleTyping(msg, currentUserId) {
    const members = this.db.chatMembers
      .filter(m => m.chat_id === msg.chatId)
      .map(m => m.user_id);
    
    const sender = this.db.findUserById(currentUserId);
    const payload = JSON.stringify({
      type: 'typing',
      chatId: msg.chatId,
      userId: currentUserId,
      name: sender?.name
    });

    members.forEach(memberId => {
      if (memberId !== currentUserId) {
        presenceService.sendToUser(memberId, payload);
      }
    });
  }

  handleAddMember(ws, msg, currentUserId) {
    const exists = this.db.chatMembers.find(
      m => m.chat_id === msg.chatId && m.user_id === msg.userId
    );
    if (!exists) {
      this.db.chatMembers.push({ 
        chat_id: msg.chatId, 
        user_id: msg.userId, 
        role: 'member', 
        joined_at: Date.now() 
      });
    }
    
    const members = this.getChatMembersWithDetails(msg.chatId);
    const payload = JSON.stringify({ type: 'member_added', chatId: msg.chatId, members });

    members.forEach(m => {
      presenceService.sendToUser(m.id, payload);
    });
  }

  handleSetPublicKey(msg, currentUserId) {
    const user = this.db.findUserById(currentUserId);
    if (user) user.public_key = msg.publicKey;
  }

  handleDisconnect(currentUserId) {
    if (currentUserId) {
      presenceService.setOffline(currentUserId);
      const user = this.db.findUserById(currentUserId);
      if (user) {
        user.online = 0;
        user.last_seen = Date.now();
      }
      
      const payload = JSON.stringify({ type: 'user_offline', userId: currentUserId });
      presenceService.broadcast(payload);
    }
  }

  getUserChatsWithDetails(userId) {
    return this.db.chatMembers
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
  }

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

  startOnlinePing() {
    setInterval(() => {
      const onlineIds = this.db.users
        .filter(u => u.online === 1)
        .map(u => u.id);
      
      const payload = JSON.stringify({ type: 'online_users', users: onlineIds });
      presenceService.broadcast(payload);
    }, config.onlinePingInterval);
  }
}

module.exports = WebSocketService;