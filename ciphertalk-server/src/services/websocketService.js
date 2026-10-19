const WebSocket = require('ws');
const config = require('../config');
const presenceService = require('./presenceService');
const sessionService = require('./sessionService');
const encryptionService = require('./encryptionService');
const { getDatabase } = require('../db/database');
const Chat = require('../models/Chat');
const Message = require('../models/Message');

const MAX_SOCKETS_PER_USER = 20;
const ALLOWED_MESSAGE_TYPES = new Set(['text', 'file', 'image', 'voice', 'video']);

class WebSocketService {
  constructor(server) {
    this.wss = new WebSocket.Server({
      server,
      maxPayload: config.wsMaxPayload
    });
    this.db = getDatabase();
    this.heartbeatTimer = null;
    this.onlinePingTimer = null;
    this.setupHandlers();
  }

  setupHandlers() {
    this.wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      ws.userId = null;
      ws.remoteAddress = req?.socket?.remoteAddress || '';

      ws.on('pong', () => { ws.isAlive = true; });

      ws.on('message', (data) => {
        try {
          this.handleClientMessage(ws, data);
        } catch (e) {
          console.error('WS message error:', e);
          this.sendError(ws, 'internal_error', 'Ошибка обработки сообщения');
        }
      });

      ws.on('close', () => this.handleDisconnect(ws));

      // Без обработчика 'error' EventEmitter бросает исключение и роняет процесс
      ws.on('error', (err) => {
        console.error('WS socket error:', err.message);
        this.handleDisconnect(ws);
      });
    });

    this.wss.on('error', (err) => console.error('WS server error:', err.message));
  }

  handleClientMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return this.sendError(ws, 'bad_json', 'Некорректный JSON');
    }
    if (!msg || typeof msg.type !== 'string') {
      return this.sendError(ws, 'bad_request', 'Не указан type');
    }

    if (msg.type === 'auth') return this.handleAuth(ws, msg);
    if (msg.type === 'ping') return this.send(ws, { type: 'pong' });

    if (!ws.userId) {
      return this.sendError(ws, 'unauthorized', 'Сначала авторизуйтесь');
    }

    const handlers = {
      'get_public_key': () => this.handleGetPublicKey(ws, msg),
      'start_chat': () => this.handleStartChat(ws, msg),
      'create_group': () => this.handleCreateGroup(ws, msg),
      'send_message': () => this.handleSendMessage(ws, msg),
      'edit_message': () => this.handleEditMessage(ws, msg),
      'delete_message': () => this.handleDeleteMessage(ws, msg),
      'get_messages': () => this.handleGetMessages(ws, msg),
      'typing': () => this.handleTyping(ws, msg),
      'add_member': () => this.handleAddMember(ws, msg),
      'set_public_key': () => this.handleSetPublicKey(ws, msg)
    };

    const handler = handlers[msg.type];
    if (!handler) {
      return this.sendError(ws, 'unknown_type', `Неизвестный тип: ${msg.type}`);
    }
    handler();
  }

  // ==================== AUTH ====================

  handleAuth(ws, msg) {
    const auth = sessionService.verify(msg.token);
    if (!auth) {
      this.send(ws, { type: 'auth_error', error: 'Сессия недействительна' });
      return ws.close(4001, 'Unauthorized');
    }

    const sockets = presenceService.getSockets(auth.user.id);
    if (sockets.length >= MAX_SOCKETS_PER_USER) {
      this.sendError(ws, 'too_many_connections', 'Слишком много подключений');
      return ws.close(4008, 'Too many connections');
    }

    ws.userId = auth.user.id;
    presenceService.addSocket(auth.user.id, ws);

    const user = this.db.findUserById(auth.user.id);
    if (user) {
      user.online = 1;
      user.last_seen = Date.now();
      this.db.markDirty();
    }

    this.send(ws, { type: 'chats', chats: this.getUserChatsWithDetails(auth.user.id) });
    presenceService.broadcast(
      { type: 'user_online', userId: auth.user.id },
      auth.user.id
    );
  }

  // ==================== HANDLERS ====================

  handleGetPublicKey(ws, msg) {
    const user = this.db.findUserById(Number(msg.targetUserId));
    this.send(ws, {
      type: 'public_key',
      userId: Number(msg.targetUserId),
      publicKey: user?.public_key || ''
    });
  }

  handleStartChat(ws, msg) {
    const currentUserId = ws.userId;
    const targetUserId = Number(msg.targetUserId);

    if (!Number.isInteger(targetUserId)) {
      return this.sendError(ws, 'bad_request', 'Некорректный targetUserId');
    }
    if (targetUserId === currentUserId) {
      return this.sendError(ws, 'bad_request', 'Нельзя открыть чат с самим собой');
    }
    if (!this.db.findUserById(targetUserId)) {
      return this.sendError(ws, 'not_found', 'Пользователь не найден');
    }

    const myChats = this.db.chatMembers
      .filter(cm => cm.user_id === currentUserId)
      .map(cm => cm.chat_id);

    let chatId = null;
    for (const cid of myChats) {
      const chat = this.db.findChatById(cid);
      if (!chat || chat.type !== 'private') continue;
      if (this.db.isChatMember(cid, targetUserId)) {
        chatId = chat.id;
        break;
      }
    }

    let created = false;
    if (!chatId) {
      chatId = this.db.nextId('chats');
      const chat = new Chat({
        id: chatId,
        type: 'private',
        owner_id: null
      });
      this.db.chats.push(chat);
      const now = Date.now();
      this.db.chatMembers.push({ chat_id: chatId, user_id: currentUserId, role: 'member', joined_at: now });
      this.db.chatMembers.push({ chat_id: chatId, user_id: targetUserId, role: 'member', joined_at: now });
      this.db.markDirty();
      created = true;
    }

    const members = this.getChatMembersWithDetails(chatId);
    this.send(ws, { type: 'chat_created', chatId, members });

    if (created) {
      const chat = this.db.findChatById(chatId);
      const notification = {
        type: 'new_chat',
        chat: this.getChatWithDetails(chat, members)
      };
      // Уведомляем всех участников (у текущего уже открыт чат)
      members.forEach(m => {
        if (m.id !== currentUserId) presenceService.sendToUser(m.id, notification);
      });
    }
  }

  handleCreateGroup(ws, msg) {
    const currentUserId = ws.userId;
    const membersInput = Array.isArray(msg.members)
      ? msg.members.map(Number).filter(id => Number.isInteger(id) && this.db.findUserById(id))
      : [];

    const chatId = this.db.nextId('chats');
    const chat = new Chat({
      id: chatId,
      type: msg.groupType === 'supergroup' ? 'supergroup' : 'group',
      name: String(msg.name || 'Группа').slice(0, 100),
      avatar: typeof msg.avatar === 'string' ? msg.avatar.slice(0, 2 * 1024 * 1024) : '',
      owner_id: currentUserId
    });
    this.db.chats.push(chat);
    this.db.chatMembers.push({ chat_id: chatId, user_id: currentUserId, role: 'owner', joined_at: Date.now() });

    membersInput.forEach(uid => {
      this.db.chatMembers.push({ chat_id: chatId, user_id: uid, role: 'member', joined_at: Date.now() });
    });
    this.db.markDirty();

    const members = this.getChatMembersWithDetails(chatId);
    const notification = {
      type: 'new_chat',
      chat: this.getChatWithDetails(chat, members)
    };
    members.forEach(m => presenceService.sendToUser(m.id, notification));
  }

  handleSendMessage(ws, msg) {
    const currentUserId = ws.userId;
    const chatId = Number(msg.chatId);

    if (!this.db.isChatMember(chatId, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Вы не участник этого чата');
    }

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) {
      return this.sendError(ws, 'bad_request', 'Пустое сообщение');
    }
    if (content.length > config.maxMessageLength) {
      return this.sendError(ws, 'too_large', 'Слишком большое сообщение');
    }

    const type = ALLOWED_MESSAGE_TYPES.has(msg.msgType) ? msg.msgType : 'text';
    const now = Date.now();
    const message = new Message({
      id: this.db.nextId('messages'),
      chat_id: chatId,
      sender_id: currentUserId,
      encrypted_content: encryptionService.encryptMessage(content), // at-rest AES-256-GCM
      iv: typeof msg.iv === 'string' ? msg.iv.slice(0, 512) : '',
      type,
      reply_to: Number.isInteger(msg.replyTo) ? msg.replyTo : null,
      created_at: now
    });
    this.db.addMessage(message);

    const sender = this.db.findUserById(currentUserId);
    const members = this.getChatMemberIds(chatId);

    presenceService.sendToChatMembers(members, {
      type: 'new_message',
      message: {
        id: message.id,
        chatId: message.chat_id,
        senderId: message.sender_id,
        senderName: sender?.name || '',
        content,
        iv: message.iv,
        type: message.type,
        replyTo: message.reply_to,
        edited: 0,
        createdAt: message.created_at
      }
    });

    presenceService.sendToChatMembers(members, {
      type: 'chat_updated',
      chatId,
      lastMessage: content,
      lastMessageType: type,
      lastMessageTime: now,
      lastSenderId: currentUserId,
      senderName: sender?.name
    });
  }

  handleEditMessage(ws, msg) {
    const currentUserId = ws.userId;
    const messageId = Number(msg.messageId);
    const message = this.db.findMessageById(messageId);

    if (!message || message.sender_id !== currentUserId) {
      return this.sendError(ws, 'forbidden', 'Можно редактировать только свои сообщения');
    }
    if (message.type !== 'text') {
      return this.sendError(ws, 'forbidden', 'Медиа-сообщения нельзя редактировать');
    }
    if (!message.chat_id || !this.db.isChatMember(message.chat_id, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content || content.length > config.maxMessageLength) {
      return this.sendError(ws, 'bad_request', 'Некорректный текст');
    }

    message.encrypted_content = encryptionService.encryptMessage(content);
    message.edited = 1;
    this.db.markDirty();

    presenceService.sendToChatMembers(this.getChatMemberIds(message.chat_id), {
      type: 'message_edited',
      messageId,
      content,
      chatId: message.chat_id
    });
  }

  handleDeleteMessage(ws, msg) {
    const currentUserId = ws.userId;
    const messageId = Number(msg.messageId);
    const message = this.db.findMessageById(messageId);

    if (!message || message.sender_id !== currentUserId) {
      return this.sendError(ws, 'forbidden', 'Можно удалять только свои сообщения');
    }
    if (!message.chat_id || !this.db.isChatMember(message.chat_id, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }

    const chatId = message.chat_id;
    this.db.deleteMessage(messageId); // раньше присваивание геттеру молча не работало

    presenceService.sendToChatMembers(this.getChatMemberIds(chatId), {
      type: 'message_deleted',
      messageId,
      chatId
    });
  }

  handleGetMessages(ws, msg) {
    const chatId = Number(msg.chatId);
    if (!this.db.isChatMember(chatId, ws.userId)) {
      return this.sendError(ws, 'forbidden', 'Вы не участник этого чата');
    }

    const limit = Math.min(Math.max(parseInt(msg.limit, 10) || 50, 1), 200);
    const chatMessages = this.db.messages
      .filter(m => m.chat_id === chatId)
      .slice(-limit)
      .map(m => {
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
          created_at: m.created_at
        };
      });

    this.send(ws, { type: 'messages', chatId, messages: chatMessages });
  }

  handleTyping(ws, msg) {
    const chatId = Number(msg.chatId);
    if (!this.db.isChatMember(chatId, ws.userId)) return;

    const sender = this.db.findUserById(ws.userId);
    const payload = {
      type: 'typing',
      chatId,
      userId: ws.userId,
      name: sender?.name
    };

    this.getChatMemberIds(chatId).forEach(memberId => {
      if (memberId !== ws.userId) presenceService.sendToUser(memberId, payload);
    });
  }

  handleAddMember(ws, msg) {
    const chatId = Number(msg.chatId);
    const userId = Number(msg.userId);

    if (!this.db.isChatMember(chatId, ws.userId)) {
      return this.sendError(ws, 'forbidden', 'Вы не участник этого чата');
    }
    if (!this.db.findUserById(userId)) {
      return this.sendError(ws, 'not_found', 'Пользователь не найден');
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

    const members = this.getChatMembersWithDetails(chatId);
    presenceService.sendToChatMembers(members.map(m => m.id), {
      type: 'member_added',
      chatId,
      members
    });
  }

  handleSetPublicKey(ws, msg) {
    const user = this.db.findUserById(ws.userId);
    if (!user) return;
    if (typeof msg.publicKey !== 'string' || msg.publicKey.length > 4096) {
      return this.sendError(ws, 'bad_request', 'Некорректный publicKey');
    }
    user.public_key = msg.publicKey;
    this.db.markDirty();
  }

  // ==================== LIFECYCLE ====================

  handleDisconnect(ws) {
    const userId = ws.userId;
    if (userId === undefined || userId === null) return;

    const fullyOffline = presenceService.removeSocket(ws);
    ws.userId = null;
    if (!fullyOffline) return;

    const user = this.db.findUserById(userId);
    if (user) {
      user.online = 0;
      user.last_seen = Date.now();
      this.db.markDirty();
    }

    presenceService.broadcast({ type: 'user_offline', userId });
  }

  /**
   * Ping/pong: мёртвые (half-open) соединения закрываются, иначе они
   * копятся в памяти и presence врёт про онлайн.
   */
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (e) {
          ws.terminate();
        }
      }
    }, config.heartbeatInterval);
  }

  startOnlinePing() {
    if (this.onlinePingTimer) return;
    this.onlinePingTimer = setInterval(() => {
      const onlineIds = presenceService.getOnlineUsers();
      presenceService.broadcast({ type: 'online_users', users: onlineIds });
    }, config.onlinePingInterval);
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.onlinePingTimer) {
      clearInterval(this.onlinePingTimer);
      this.onlinePingTimer = null;
    }
  }

  // ==================== HELPERS ====================

  send(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    } catch (e) {
      console.error('WS send error:', e.message);
      return false;
    }
  }

  sendError(ws, code, message) {
    this.send(ws, { type: 'error', code, error: message });
  }

  getChatMemberIds(chatId) {
    return this.db.chatMembers
      .filter(m => m.chat_id === chatId)
      .map(m => m.user_id);
  }

  getChatWithDetails(chat, members) {
    const chatMessages = this.db.messages.filter(m => m.chat_id === chat.id);
    const lastMsg = chatMessages[chatMessages.length - 1];
    const lastContent = lastMsg ? encryptionService.decryptMessage(lastMsg.encrypted_content) : null;
    return {
      ...chat.toJSON ? chat.toJSON() : chat,
      members,
      last_message: lastContent === null ? '' : lastContent,
      last_message_type: lastMsg?.type || null,
      last_message_time: lastMsg?.created_at || 0,
      last_sender_id: lastMsg?.sender_id || 0
    };
  }

  getUserChatsWithDetails(userId) {
    return this.db.chatMembers
      .filter(cm => cm.user_id === userId)
      .map(cm => {
        const chat = this.db.findChatById(cm.chat_id);
        if (!chat) return null;
        const details = this.getChatWithDetails(chat, this.getChatMembersWithDetails(chat.id));
        return { ...details, role: cm.role };
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
}

module.exports = WebSocketService;
