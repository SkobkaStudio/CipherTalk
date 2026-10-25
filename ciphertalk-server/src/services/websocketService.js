const WebSocket = require('ws');
const config = require('../config');
const presenceService = require('./presenceService');
const { maskPhone } = require('../utils/mask');
const { isOwnerPhone } = require('../utils/owner');
const { normalizeTtlSeconds, expiresAtFor, isExpired } = require('../utils/messageExpiry');
const sessionService = require('./sessionService');
const { getDatabase } = require('../db/database');
const Chat = require('../models/Chat');
const Message = require('../models/Message');

const MAX_SOCKETS_PER_USER = 20;
const ALLOWED_MESSAGE_TYPES = new Set(['text', 'file', 'image', 'voice', 'video', 'sticker']);
const MAX_CIPHERTEXT_CHARS = 400 * 1024;

class WebSocketService {
  constructor(server) {
    this.wss = new WebSocket.Server({
      server,
      maxPayload: config.wsMaxPayload
    });
    this.db = getDatabase();
    this.heartbeatTimer = null;
    this.onlinePingTimer = null;
    this.expiryTimer = null;
    // Активные WebRTC-звонки: callId -> { caller, callee, type }
    this.activeCalls = new Map();
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
      'create_channel': () => this.handleCreateChannel(ws, msg),
      'send_message': () => this.handleSendMessage(ws, msg),
      'edit_message': () => this.handleEditMessage(ws, msg),
      'delete_message': () => this.handleDeleteMessage(ws, msg),
      'get_messages': () => this.handleGetMessages(ws, msg),
      'typing': () => this.handleTyping(ws, msg),
      'add_member': () => this.handleAddMember(ws, msg),
      'remove_member': () => this.handleRemoveMember(ws, msg),
      'set_role': () => this.handleSetRole(ws, msg),
      'set_public_key': () => this.handleSetPublicKey(ws, msg),
      'forward_message': () => this.handleForwardMessage(ws, msg),
      'pin_message': () => this.handlePinMessage(ws, msg),
      'unpin_message': () => this.handlePinMessage(ws, msg, true),
      'react_message': () => this.handleReactMessage(ws, msg),
      'read_messages': () => this.handleReadMessages(ws, msg),
      'set_privacy': () => this.handleSetPrivacy(ws, msg),
      'set_group_key': () => this.handleSetGroupKey(ws, msg),
      'get_group_key': () => this.handleGetGroupKey(ws, msg),
      'call_offer': () => this.handleCallSignal(ws, msg, 'call_offer'),
      'call_answer': () => this.handleCallSignal(ws, msg, 'call_answer'),
      'call_ice': () => this.handleCallSignal(ws, msg, 'call_ice'),
      'call_reject': () => this.handleCallSignal(ws, msg, 'call_reject'),
      'call_end': () => this.handleCallSignal(ws, msg, 'call_end'),
      'create_folder': () => this.handleCreateFolder(ws, msg),
      'update_folder': () => this.handleUpdateFolder(ws, msg),
      'delete_folder': () => this.handleDeleteFolder(ws, msg),
      'set_chat_folder': () => this.handleSetChatFolder(ws, msg),
      'delete_chat': () => this.handleDeleteChat(ws, msg)
    };

    const handler = handlers[msg.type];
    if (!handler) {
      return this.sendError(ws, 'unknown_type', `Неизвестный тип: ${msg.type}`);
    }
    handler();
  }

  // ==================== AUTH ====================

  handleAuth(ws, msg) {
    if (ws.userId) {
      this.send(ws, { type: 'auth_error', error: 'Соединение уже авторизовано' });
      return ws.close(4002, 'Already authenticated');
    }

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
      // «Скрытый онлайн»: остальным пользователям не рассылаем событие
      if (!user.hide_online) {
        presenceService.broadcast(
          { type: 'user_online', userId: auth.user.id },
          auth.user.id
        );
      }
    }

    this.send(ws, { type: 'chats', chats: this.getUserChatsWithDetails(auth.user.id) });
    this.send(ws, { type: 'folders', folders: this.db.getFolders(auth.user.id) });
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

  // ==================== WEBRTC-СИГНАЛИНГ ====================
  // Сервер только пересылает SDP/ICE между участниками. Медиа идёт
  // напрямую P2P и шифруется DTLS-SRTP, сервер его не видит.

  handleCallSignal(ws, msg, signalType) {
    const targetUserId = Number(msg.targetUserId);
    const callId = String(msg.callId || '').slice(0, 96);
    if (!Number.isInteger(targetUserId) || targetUserId === ws.userId) {
      return this.sendError(ws, 'bad_request', 'Некорректный собеседник');
    }
    if (!callId) {
      return this.sendError(ws, 'bad_request', 'Не указан callId');
    }
    if (!this.db.findUserById(targetUserId)) {
      return this.sendError(ws, 'not_found', 'Пользователь не найден');
    }
    if (typeof msg.sdp === 'string' && msg.sdp.length > 200 * 1024) {
      return this.sendError(ws, 'bad_request', 'Слишком большой SDP');
    }

    if (signalType === 'call_offer') {
      const sharesPrivateChat = this.db.chatMembers
        .filter(cm => cm.user_id === ws.userId)
        .map(cm => cm.chat_id)
        .some(cid => {
          const chat = this.db.findChatById(cid);
          return chat && chat.type === 'private' && this.db.isChatMember(cid, targetUserId);
        });
      if (!sharesPrivateChat) {
        return this.sendError(ws, 'forbidden', 'Звонки доступны только в личных чатах');
      }
    } else {
      const call = this.activeCalls.get(callId);
      const validPair = call && (
        (call.caller === ws.userId && call.callee === targetUserId) ||
        (call.callee === ws.userId && call.caller === targetUserId)
      );
      if (!validPair) {
        return this.sendError(ws, 'bad_request', 'Неизвестный звонок');
      }
    }

    const me = this.db.findUserById(ws.userId);
    const payload = {
      type: signalType,
      callId,
      fromUserId: ws.userId,
      fromName: me ? (me.name || me.username || '') : '',
      fromAvatar: me ? (me.avatar || '') : '',
      callType: msg.callType === 'video' ? 'video' : 'audio'
    };
    if (typeof msg.sdp === 'string') payload.sdp = msg.sdp;
    if (msg.candidate && typeof msg.candidate === 'object') payload.candidate = msg.candidate;
    if (typeof msg.reason === 'string') payload.reason = msg.reason.slice(0, 80);

    if (signalType === 'call_offer') {
      // Один активный звонок на пользователя. Тот же участник может
      // перезвонить повторно (старый callId просто заменяется).
      for (const [id, call] of this.activeCalls) {
        const samePair = id !== callId && (
          (call.caller === ws.userId && call.callee === targetUserId) ||
          (call.callee === ws.userId && call.caller === targetUserId)
        );
        const busy = id !== callId && (
          call.caller === targetUserId || call.callee === targetUserId ||
          call.caller === ws.userId || call.callee === ws.userId
        );
        if (samePair) {
          this.activeCalls.delete(id);
        } else if (busy) {
          return this.send(ws, { type: 'call_unavailable', callId, reason: 'busy' });
        }
      }
      this.activeCalls.set(callId, { caller: ws.userId, callee: targetUserId, type: payload.callType });
    }

    const delivered = presenceService.sendToUser(targetUserId, payload);
    if (!delivered && signalType === 'call_offer') {
      this.activeCalls.delete(callId);
      return this.send(ws, { type: 'call_unavailable', callId, reason: 'offline' });
    }

    if (signalType === 'call_offer') {
      this.send(ws, { type: 'call_ringing', callId, targetUserId });
    }
    if (signalType === 'call_end' || signalType === 'call_reject') {
      this.activeCalls.delete(callId);
    }
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

    // Если чат был удалён у кого-то из собеседников — возвращаем его в список.
    this.db.restoreChatForUser(chatId, currentUserId);
    this.db.restoreChatForUser(chatId, targetUserId);

    const members = this.getChatMembersWithDetails(chatId, currentUserId);
    this.send(ws, { type: 'chat_created', chatId, members });

    if (created) {
      const chat = this.db.findChatById(chatId);
      const notification = {
        type: 'new_chat',
        chat: this.getChatWithDetails(chat, this.getChatMembersWithDetails(chatId, targetUserId), targetUserId)
      };
      // Уведомляем собеседника; телефон каждого маскируется относительно него.
      presenceService.sendToUser(targetUserId, notification);
    }
  }

  handleCreateGroup(ws, msg) {
    const currentUserId = ws.userId;
    const membersInput = Array.isArray(msg.members)
      ? msg.members.map(Number).filter(id => Number.isInteger(id) && this.db.findUserById(id) && id !== currentUserId)
      : [];

    const chatId = this.db.nextId('chats');
    const chat = new Chat({
      id: chatId,
      type: msg.groupType === 'supergroup' ? 'supergroup' : 'group',
      name: String(msg.name || 'Группа').slice(0, 100),
      avatar: typeof msg.avatar === 'string' ? msg.avatar.slice(0, 2 * 1024 * 1024) : '',
      description: typeof msg.description === 'string' ? msg.description.slice(0, 500) : '',
      owner_id: currentUserId
    });
    this.db.chats.push(chat);
    this.db.chatMembers.push({ chat_id: chatId, user_id: currentUserId, role: 'owner', joined_at: Date.now() });

    membersInput.forEach(uid => {
      if (!this.db.isChatMember(chatId, uid)) {
        this.db.chatMembers.push({ chat_id: chatId, user_id: uid, role: 'member', joined_at: Date.now() });
      }
    });
    this.db.markDirty();

    const memberIds = this.getChatMemberIds(chatId);
    memberIds.forEach(uid => {
      if (uid === currentUserId) return;
      presenceService.sendToUser(uid, {
        type: 'new_chat',
        chat: this.getChatWithDetails(chat, this.getChatMembersWithDetails(chatId, uid), uid)
      });
    });
    this.send(ws, {
      type: 'group_created',
      chat: this.getChatWithDetails(chat, this.getChatMembersWithDetails(chatId, currentUserId), currentUserId)
    });
  }

  handleCreateChannel(ws, msg) {
    const currentUserId = ws.userId;
    const chatId = this.db.nextId('chats');
    const chat = new Chat({
      id: chatId,
      type: 'channel',
      name: String(msg.name || 'Канал').slice(0, 100),
      avatar: typeof msg.avatar === 'string' ? msg.avatar.slice(0, 2 * 1024 * 1024) : '',
      description: typeof msg.description === 'string' ? msg.description.slice(0, 1000) : '',
      owner_id: currentUserId,
      is_channel: true
    });
    this.db.chats.push(chat);
    this.db.chatMembers.push({ chat_id: chatId, user_id: currentUserId, role: 'owner', joined_at: Date.now() });
    this.db.markDirty();

    this.getChatMemberIds(chatId).forEach(uid => {
      presenceService.sendToUser(uid, {
        type: 'new_chat',
        chat: this.getChatWithDetails(chat, this.getChatMembersWithDetails(chatId, uid), uid)
      });
    });
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
    if (content.length > MAX_CIPHERTEXT_CHARS) {
      return this.sendError(ws, 'too_large', 'Слишком большое сообщение');
    }

    const type = ALLOWED_MESSAGE_TYPES.has(msg.msgType) ? msg.msgType : 'text';
    const now = Date.now();
    const iv = typeof msg.iv === 'string' ? msg.iv.slice(0, 256) : '';
    const header = typeof msg.header === 'string' ? msg.header.slice(0, 4096) : '';
    const replyTo = Number.isInteger(Number(msg.replyTo)) && Number(msg.replyTo) > 0
      ? Number(msg.replyTo)
      : null;
    const ttlSeconds = normalizeTtlSeconds(msg.ttlSeconds);
    const expiresAt = expiresAtFor(ttlSeconds, now);

    const message = new Message({
      id: this.db.nextId('messages'),
      chat_id: chatId,
      sender_id: currentUserId,
      encrypted_content: content,
      iv: iv,
      header: header,
      type,
      reply_to: replyTo,
      forwarded_from: Number.isInteger(Number(msg.forwardedFrom)) && Number(msg.forwardedFrom) > 0
        ? Number(msg.forwardedFrom)
        : null,
      expires_at: expiresAt || null,
      created_at: now
    });
    this.db.addMessage(message);

    const sender = this.db.findUserById(currentUserId);
    const members = this.getChatMemberIds(chatId);
    const restored = this.db.restoreHiddenChatMembers(chatId);
    const chatForRestored = restored.length ? this.db.findChatById(chatId) : null;
    restored.forEach(uid => {
      if (!chatForRestored) return;
      presenceService.sendToUser(uid, {
        type: 'new_chat',
        chat: this.getChatWithDetails(chatForRestored, this.getChatMembersWithDetails(chatId, uid), uid)
      });
    });

    presenceService.sendToChatMembers(members, {
      type: 'new_message',
      message: {
        id: message.id,
        chatId: message.chat_id,
        senderId: message.sender_id,
        senderName: sender?.name || '',
        senderAvatar: sender?.avatar || '',
        content,
        ciphertext: content,
        iv: message.iv,
        header: message.header,
        type: message.type,
        replyTo: message.reply_to,
        forwardedFrom: message.forwarded_from,
        edited: message.edited,
        deletedForAll: message.deleted_for_all,
        reactions: message.reactions,
        pinned: message.pinned,
        expiresAt: message.expires_at,
        createdAt: message.created_at
      }
    });

    presenceService.sendToChatMembers(members, {
      type: 'chat_updated',
      chatId,
      lastMessage: content,
      lastMessageIv: message.iv,
      lastMessageHeader: message.header,
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
    if (message.deleted_for_all) {
      return this.sendError(ws, 'forbidden', 'Удалённое сообщение нельзя редактировать');
    }
    if (!message.chat_id || !this.db.isChatMember(message.chat_id, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content || content.length > MAX_CIPHERTEXT_CHARS) {
      return this.sendError(ws, 'bad_request', 'Некорректный текст');
    }

    message.encrypted_content = content;
    if (typeof msg.iv === 'string') message.iv = msg.iv.slice(0, 256);
    if (typeof msg.header === 'string') message.header = msg.header.slice(0, 4096);
    message.edited = 1;
    this.db.markDirty();

    presenceService.sendToChatMembers(this.getChatMemberIds(message.chat_id), {
      type: 'message_edited',
      messageId,
      content,
      ciphertext: content,
      iv: message.iv,
      header: message.header,
      chatId: message.chat_id
    });
  }

  handleDeleteMessage(ws, msg) {
    const currentUserId = ws.userId;
    const messageId = Number(msg.messageId);
    const message = this.db.findMessageById(messageId);
    const forAll = msg.forAll !== false;

    if (!message || !message.chat_id || !this.db.isChatMember(message.chat_id, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }

    const chatId = message.chat_id;
    const isOwn = message.sender_id === currentUserId;

    if (forAll && !isOwn) {
      const cm = this.db.chatMembers.find(m => m.chat_id === chatId && m.user_id === currentUserId);
      if (!cm || (cm.role !== 'owner' && cm.role !== 'admin')) {
        return this.sendError(ws, 'forbidden', 'Удалять у всех могут только автор или администратор');
      }
    }

    if (forAll) {
      // Помечаем удалённым для всех: сам шифротекст стираем с диска.
      message.deleted_for_all = 1;
      message.encrypted_content = '';
      message.iv = '';
      message.header = '';
      message.pinned = 0;
      this.db.markDirty();
      presenceService.sendToChatMembers(this.getChatMemberIds(chatId), {
        type: 'message_deleted',
        messageId,
        chatId,
        forAll: true
      });
    } else {
      if (!isOwn) {
        return this.sendError(ws, 'forbidden', 'Можно удалять только свои сообщения');
      }
      this.db.deleteMessage(messageId);
      presenceService.sendToChatMembers(this.getChatMemberIds(chatId), {
        type: 'message_deleted',
        messageId,
        chatId,
        forAll: false
      });
    }
  }

  handleGetMessages(ws, msg) {
    const chatId = Number(msg.chatId);
    if (!this.db.isChatMember(chatId, ws.userId)) {
      return this.sendError(ws, 'forbidden', 'Вы не участник этого чата');
    }

    const limit = Math.min(Math.max(parseInt(msg.limit, 10) || 50, 1), 500);
    const beforeId = parseInt(msg.beforeId, 10) || null;
    const clearedAt = this.db.getChatClearedAt(chatId, ws.userId);
    const pageRaw = this.db.getChatMessages(chatId, limit + 1, beforeId);
    const page = pageRaw
      .filter(m => !isExpired(m) && (!clearedAt || m.created_at > clearedAt))
      .slice(0, limit);
    const hasMore = pageRaw.length > limit;

    this.send(ws, {
      type: 'messages',
      chatId,
      messages: page.map(m => this.serializeMessage(m)),
      hasMore,
      beforeId: page.length ? page[0].id : null,
      older: !!beforeId
    });
  }

  /**
   * Сериализация сообщения для WebSocket. Сервер отдаёт шифротекст как есть.
   */
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
        pinned: 0,
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

  /**
   * Удаление чата:
   *  - forAll=true — только владелец группы/канала удаляет чат для всех;
   *  - forAll=false — чат скрывается у текущего пользователя вместе с историей.
   */
  handleDeleteChat(ws, msg) {
    const chatId = Number(msg.chatId);
    const chat = this.db.findChatById(chatId);
    if (!chat) return this.sendError(ws, 'not_found', 'Чат не найден');
    if (!this.db.isChatMember(chatId, ws.userId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }

    const forAll = msg.forAll === true || msg.forAll === 1;
    if (!forAll) {
      this.db.hideChatForUser(chatId, ws.userId);
      this.send(ws, { type: 'chat_deleted', chatId, forAll: false });
      return;
    }

    const isGroup = chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel';
    if (!isGroup) {
      return this.sendError(ws, 'forbidden', 'В личном чате можно удалить только у себя');
    }
    if (this.checkRole(chatId, ws.userId) !== 'owner') {
      return this.sendError(ws, 'forbidden', 'Удалить чат для всех может только владелец');
    }

    const members = this.getChatMemberIds(chatId);
    this.db.deleteChat(chatId);
    members.forEach(uid => {
      presenceService.sendToUser(uid, { type: 'chat_deleted', chatId, forAll: true });
    });
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

  checkRole(chatId, userId) {
    const cm = this.db.chatMembers.find(m => m.chat_id === chatId && m.user_id === userId);
    return cm?.role || 'member';
  }

  handleAddMember(ws, msg) {
    const chatId = Number(msg.chatId);
    const userId = Number(msg.userId);
    const currentUserId = ws.userId;

    if (!this.db.isChatMember(chatId, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Вы не участник этого чата');
    }
    const myRole = this.checkRole(chatId, currentUserId);
    const chat = this.db.findChatById(chatId);
    if (!chat) return this.sendError(ws, 'not_found', 'Чат не найден');
    if (chat.type === 'private' || chat.type === 'saved') {
      return this.sendError(ws, 'forbidden', 'В приватный чат нельзя добавлять участников');
    }
    if (chat.type === 'channel' && myRole !== 'owner' && myRole !== 'admin') {
      return this.sendError(ws, 'forbidden', 'Только админы могут добавлять подписчиков');
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

    this.getChatMemberIds(chatId).forEach(uid => {
      presenceService.sendToUser(uid, {
        type: 'member_added',
        chatId,
        members: this.getChatMembersWithDetails(chatId, uid)
      });
    });

    // Новому участнику отправляем текущий групповой ключ (он завёрнут лично для него).
    const gk = this.db.findGroupKey(chatId);
    if (gk && gk.wrapped[userId]) {
      presenceService.sendToUser(userId, {
        type: 'group_key',
        chatId,
        version: gk.version,
        wrapped: { [userId]: gk.wrapped[userId] },
        createdBy: gk.created_by
      });
    }
  }

  handleRemoveMember(ws, msg) {
    const chatId = Number(msg.chatId);
    const userId = Number(msg.userId);
    const currentUserId = ws.userId;
    if (!this.db.isChatMember(chatId, currentUserId)) return this.sendError(ws, 'forbidden', 'Нет доступа');
    const myRole = this.checkRole(chatId, currentUserId);
    const targetRole = this.checkRole(chatId, userId);
    if (myRole !== 'owner' && myRole !== 'admin') return this.sendError(ws, 'forbidden', 'Недостаточно прав');
    if (targetRole === 'owner') return this.sendError(ws, 'forbidden', 'Нельзя удалить владельца');
    this.db.chatMembers = this.db.chatMembers.filter(m => !(m.chat_id === chatId && m.user_id === userId));
    this.db.markDirty();
    this.getChatMemberIds(chatId).forEach(uid => {
      presenceService.sendToUser(uid, {
        type: 'member_removed',
        chatId,
        userId,
        members: this.getChatMembersWithDetails(chatId, uid)
      });
    });
  }

  handleSetPublicKey(ws, msg) {
    const user = this.db.findUserById(ws.userId);
    if (!user) return;
    if (typeof msg.publicKey !== 'string' || msg.publicKey.length > 4096) {
      return this.sendError(ws, 'bad_request', 'Некорректный publicKey');
    }
    const changed = user.public_key !== msg.publicKey;
    user.public_key = msg.publicKey;
    this.db.markDirty();

    // Сообщаем собеседникам: у пользователя новый публичный ключ.
    // Клиент сбросит кэш ключа и пересогласует общий секрет.
    if (changed) {
      const chatIds = this.db.chatMembers
        .filter(cm => cm.user_id === user.id)
        .map(cm => cm.chat_id);
      const recipients = new Set();
      chatIds.forEach(chatId => {
        this.getChatMemberIds(chatId).forEach(uid => {
          if (uid !== user.id) recipients.add(uid);
        });
      });
      recipients.forEach(uid => {
        presenceService.sendToUser(uid, {
          type: 'public_key',
          userId: user.id,
          publicKey: msg.publicKey
        });
      });
    }
  }

  /**
   * Пересылка сообщения.
   * Сервер НЕ расшифровывает оригинал: клиент сам шифрует текст
   * ключом целевого чата и присылает готовый шифротекст.
   */
  handleForwardMessage(ws, msg) {
    const currentUserId = ws.userId;
    const fromChatId = Number(msg.fromChatId);
    const toChatId = Number(msg.toChatId);
    const messageId = Number(msg.messageId);

    if (!this.db.isChatMember(fromChatId, currentUserId) || !this.db.isChatMember(toChatId, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }
    const orig = this.db.findMessageById(messageId);
    if (!orig || orig.chat_id !== fromChatId) {
      return this.sendError(ws, 'not_found', 'Сообщение не найдено');
    }

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content || content.length > MAX_CIPHERTEXT_CHARS) {
      return this.sendError(ws, 'bad_request', 'Некорректное содержимое для пересылки');
    }

    const now = Date.now();
    const message = new Message({
      id: this.db.nextId('messages'),
      chat_id: toChatId,
      sender_id: currentUserId,
      encrypted_content: content,
      iv: typeof msg.iv === 'string' ? msg.iv.slice(0, 256) : '',
      header: typeof msg.header === 'string' ? msg.header.slice(0, 4096) : '',
      type: orig.type,
      forwarded_from: orig.id,
      reply_to: null,
      created_at: now
    });
    this.db.addMessage(message);

    const sender = this.db.findUserById(currentUserId);
    const members = this.getChatMemberIds(toChatId);
    const restored = this.db.restoreHiddenChatMembers(toChatId);
    const chatForRestored = restored.length ? this.db.findChatById(toChatId) : null;
    restored.forEach(uid => {
      if (!chatForRestored) return;
      presenceService.sendToUser(uid, {
        type: 'new_chat',
        chat: this.getChatWithDetails(chatForRestored, this.getChatMembersWithDetails(toChatId, uid), uid)
      });
    });
    presenceService.sendToChatMembers(members, {
      type: 'new_message',
      message: {
        id: message.id,
        chatId: message.chat_id,
        senderId: message.sender_id,
        senderName: sender?.name || '',
        senderAvatar: sender?.avatar || '',
        content,
        ciphertext: content,
        iv: message.iv,
        header: message.header,
        type: message.type,
        replyTo: null,
        forwardedFrom: orig.id,
        edited: 0,
        deletedForAll: 0,
        reactions: {},
        pinned: 0,
        createdAt: message.created_at
      }
    });
    presenceService.sendToChatMembers(members, {
      type: 'chat_updated',
      chatId: toChatId,
      lastMessage: content,
      lastMessageIv: message.iv,
      lastMessageHeader: message.header,
      lastMessageType: message.type,
      lastMessageTime: now,
      lastSenderId: currentUserId,
      senderName: sender?.name
    });
  }

  /**
   * Закрепление сообщения (только админ/владелец).
   */
  handlePinMessage(ws, msg, unpin = false) {
    const chatId = Number(msg.chatId);
    const currentUserId = ws.userId;
    const messageId = Number(msg.messageId);

    if (!this.db.isChatMember(chatId, currentUserId)) return this.sendError(ws, 'forbidden', 'Нет доступа');

    const message = this.db.findMessageById(messageId);
    if (!message || message.chat_id !== chatId) {
      return this.sendError(ws, 'not_found', 'Сообщение не найдено');
    }
    if (message.deleted_for_all) {
      return this.sendError(ws, 'bad_request', 'Сообщение удалено');
    }

    const myRole = this.checkRole(chatId, currentUserId);
    const chat = this.db.findChatById(chatId);
    const isPrivate = chat && chat.type === 'private';
    if (!isPrivate && myRole !== 'owner' && myRole !== 'admin') {
      return this.sendError(ws, 'forbidden', 'Закреплять сообщения могут только администраторы');
    }

    message.pinned = unpin ? 0 : 1;
    this.db.markDirty();

    presenceService.sendToChatMembers(this.getChatMemberIds(chatId), {
      type: 'message_pinned',
      messageId,
      chatId,
      pinned: !!message.pinned
    });
  }

  /**
   * Роли участников: owner / admin / member.
   */
  handleSetRole(ws, msg) {
    const chatId = Number(msg.chatId);
    const userId = Number(msg.userId);
    const role = ['owner', 'admin', 'member'].includes(msg.role) ? msg.role : 'member';
    const currentUserId = ws.userId;

    if (!this.db.isChatMember(chatId, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }
    const chat = this.db.findChatById(chatId);
    if (!chat) return this.sendError(ws, 'not_found', 'Чат не найден');
    const myRole = this.checkRole(chatId, currentUserId);
    if (myRole !== 'owner' && myRole !== 'admin') {
      return this.sendError(ws, 'forbidden', 'Недостаточно прав');
    }
    const target = this.db.chatMembers.find(m => m.chat_id === chatId && m.user_id === userId);
    if (!target) return this.sendError(ws, 'not_found', 'Участник не найден');
    if (target.role === 'owner' && role !== 'owner') {
      return this.sendError(ws, 'forbidden', 'Нельзя забрать права владельца');
    }
    if (role === 'owner' && myRole !== 'owner') {
      return this.sendError(ws, 'forbidden', 'Передавать владение может только владелец');
    }

    target.role = role;
    if (role === 'owner') {
      const previousOwner = this.db.chatMembers.find(m => m.chat_id === chatId && m.user_id !== userId && m.role === 'owner');
      if (previousOwner) previousOwner.role = 'admin';
      chat.owner_id = userId;
    }
    this.db.markDirty();

    this.getChatMemberIds(chatId).forEach(uid => {
      presenceService.sendToUser(uid, {
        type: 'member_role_changed',
        chatId,
        userId,
        role,
        members: this.getChatMembersWithDetails(chatId, uid)
      });
    });
  }

  /**
   * Публикация группового ключа.
   * Клиент присылает только «завёрнутые» копии ключа (по одной на участника),
   * сервер их пересылает и НИКОГДА не видит сам ключ группы.
   */
  handleSetGroupKey(ws, msg) {
    const chatId = Number(msg.chatId);
    const currentUserId = ws.userId;

    if (!this.db.isChatMember(chatId, currentUserId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }
    const chat = this.db.findChatById(chatId);
    if (!chat || chat.type === 'private' || chat.type === 'saved') {
      return this.sendError(ws, 'bad_request', 'Групповой ключ применим только к группам и каналам');
    }

    const wrapped = msg.wrapped;
    if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
      return this.sendError(ws, 'bad_request', 'Некорректные wrapped-ключи');
    }

    const clean = {};
    const members = new Set(this.getChatMemberIds(chatId));
    for (const [userId, blob] of Object.entries(wrapped)) {
      const uid = Number(userId);
      if (!Number.isInteger(uid) || !members.has(uid)) continue;
      if (!blob || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') continue;
      clean[uid] = { iv: blob.iv.slice(0, 256), ct: blob.ct.slice(0, 4096) };
    }
    if (!Object.keys(clean).length) {
      return this.sendError(ws, 'bad_request', 'Пустой набор ключей');
    }

    const version = Number.isInteger(Number(msg.version)) ? Number(msg.version) : 1;
    this.db.saveGroupKey(chatId, version, clean, currentUserId);

    presenceService.sendToChatMembers(this.getChatMemberIds(chatId), {
      type: 'group_key',
      chatId,
      version,
      wrapped: clean,
      createdBy: currentUserId
    });
  }

  handleGetGroupKey(ws, msg) {
    const chatId = Number(msg.chatId);
    if (!this.db.isChatMember(chatId, ws.userId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }
    const record = this.db.findGroupKey(chatId);
    this.send(ws, {
      type: 'group_key',
      chatId,
      version: record?.version || 0,
      wrapped: record?.wrapped || {},
      createdBy: record?.created_by || 0
    });
  }

  // ==================== ПАПКИ ====================
  handleCreateFolder(ws, msg) {
    const name = String(msg.name || '').trim();
    if (!name) return this.sendError(ws, 'bad_request', 'Введите название папки');
    const folder = this.db.createFolder(ws.userId, name, msg.emoji, msg.color);
    this.send(ws, { type: 'folder_created', folder });
  }

  handleUpdateFolder(ws, msg) {
    const id = Number(msg.id);
    const patch = {};
    if (msg.name !== undefined) patch.name = msg.name;
    if (msg.emoji !== undefined) patch.emoji = msg.emoji;
    if (msg.color !== undefined) patch.color = msg.color;
    if (Array.isArray(msg.chat_ids)) patch.chat_ids = msg.chat_ids;
    const folder = this.db.updateFolder(id, ws.userId, patch);
    if (!folder) return this.sendError(ws, 'not_found', 'Папка не найдена');
    this.send(ws, { type: 'folder_updated', folder });
  }

  handleDeleteFolder(ws, msg) {
    const id = Number(msg.id);
    if (!this.db.deleteFolder(id, ws.userId)) {
      return this.sendError(ws, 'not_found', 'Папка не найдена');
    }
    this.db.chats.forEach(c => { if (c.folder_id === id) c.folder_id = null; });
    this.db.markDirty();
    this.send(ws, { type: 'folder_deleted', id });
  }

  handleSetChatFolder(ws, msg) {
    const chatId = Number(msg.chatId);
    const folderId = msg.folderId === null || msg.folderId === undefined ? null : Number(msg.folderId);
    if (!this.db.isChatMember(chatId, ws.userId)) {
      return this.sendError(ws, 'forbidden', 'Нет доступа к чату');
    }
    const chat = this.db.findChatById(chatId);
    if (!chat) return this.sendError(ws, 'not_found', 'Чат не найден');

    if (folderId !== null) {
      const folder = this.db.findFolderById(folderId);
      if (!folder || folder.user_id !== ws.userId) {
        return this.sendError(ws, 'not_found', 'Папка не найдена');
      }
      if (!folder.chat_ids.includes(chatId)) folder.chat_ids.push(chatId);
    } else {
      this.db.folders.forEach(f => {
        f.chat_ids = f.chat_ids.filter(id => id !== chatId);
      });
    }
    chat.folder_id = folderId;
    this.db.markDirty();

    this.send(ws, { type: 'chat_folder_changed', chatId, folderId });
  }

  handleReactMessage(ws, msg) {
    const messageId = Number(msg.messageId);
    const reaction = String(msg.reaction || '👍').slice(0, 8);
    const message = this.db.findMessageById(messageId);
    if (!message || !message.chat_id) return this.sendError(ws, 'not_found', 'Сообщение не найдено');
    if (!this.db.isChatMember(message.chat_id, ws.userId)) return this.sendError(ws, 'forbidden', 'Нет доступа');
    if (!message.reactions) message.reactions = {};
    if (!message.reactions[reaction]) message.reactions[reaction] = [];
    const idx = message.reactions[reaction].indexOf(ws.userId);
    if (idx >= 0) {
      message.reactions[reaction].splice(idx, 1);
      if (message.reactions[reaction].length === 0) delete message.reactions[reaction];
    } else {
      message.reactions[reaction].push(ws.userId);
    }
    this.db.markDirty();
    presenceService.sendToChatMembers(this.getChatMemberIds(message.chat_id), {
      type: 'message_reaction',
      messageId,
      chatId: message.chat_id,
      reactions: message.reactions,
      userId: ws.userId,
      reaction
    });
  }

  handleReadMessages(ws, msg) {
    const chatId = Number(msg.chatId);
    const lastReadId = Number(msg.lastReadId) || 0;
    if (!this.db.isChatMember(chatId, ws.userId)) return;

    const cm = this.db.chatMembers.find(m => m.chat_id === chatId && m.user_id === ws.userId);
    if (!cm) return;
    if ((cm.last_read_message_id || 0) >= lastReadId) return;
    cm.last_read_message_id = lastReadId;
    this.db.markDirty();

    presenceService.sendToChatMembers(this.getChatMemberIds(chatId), {
      type: 'messages_read',
      chatId,
      userId: ws.userId,
      lastReadId
    });
  }

  handleSetPrivacy(ws, msg) {
    const user = this.db.findUserById(ws.userId);
    if (!user) return;
    if (typeof msg.hideOnline === 'boolean') {
      user.hide_online = msg.hideOnline ? 1 : 0;
      if (user.hide_online) {
        presenceService.broadcast({ type: 'user_offline', userId: ws.userId }, ws.userId);
      } else {
        presenceService.broadcast({ type: 'user_online', userId: ws.userId }, ws.userId);
      }
    }
    this.db.markDirty();
    this.send(ws, { type: 'privacy_updated', hideOnline: !!user.hide_online });
  }

  // ==================== LIFECYCLE ====================

  handleDisconnect(ws) {
    const userId = ws.userId;
    if (userId === undefined || userId === null) return;

    // Завершаем звонки, в которых участвовал отключившийся пользователь.
    for (const [callId, call] of this.activeCalls) {
      if (call.caller === userId || call.callee === userId) {
        const peer = call.caller === userId ? call.callee : call.caller;
        presenceService.sendToUser(peer, {
          type: 'call_end',
          callId,
          reason: 'disconnected',
          fromUserId: userId
        });
        this.activeCalls.delete(callId);
      }
    }

    const fullyOffline = presenceService.removeSocket(ws);
    ws.userId = null;
    if (ws.pingTimer) {
      clearInterval(ws.pingTimer);
      ws.pingTimer = null;
    }
    ws.removeAllListeners && ws.removeAllListeners();
    if (!fullyOffline) return;

    const user = this.db.findUserById(userId);
    if (user) {
      user.online = 0;
      user.last_seen = Date.now();
      this.db.markDirty();
      if (!user.hide_online) {
        presenceService.broadcast({ type: 'user_offline', userId });
      }
      return;
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
      const onlineIds = presenceService.getOnlineUsers().filter(id => {
        const u = this.db.findUserById(id);
        return u && !u.hide_online;
      });
      presenceService.broadcast({ type: 'online_users', users: onlineIds });
    }, config.onlinePingInterval);
  }

  /**
   * Периодически удаляет сообщения с истёкшим TTL и уведомляет участников,
   * чтобы исчезновение было одинаковым на всех устройствах.
   */
  startExpirySweep() {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => this.purgeExpiredMessages(), 15000);
    if (this.expiryTimer.unref) this.expiryTimer.unref();
  }

  purgeExpiredMessages(now = Date.now()) {
    const expired = this.db.messages.filter(m => isExpired(m, now));
    if (!expired.length) return 0;

    const byChat = new Map();
    expired.forEach(m => {
      if (!byChat.has(m.chat_id)) byChat.set(m.chat_id, []);
      byChat.get(m.chat_id).push(m.id);
    });
    const expiredIds = new Set(expired.map(m => m.id));
    this.db.messages = this.db.messages.filter(m => !expiredIds.has(m.id));
    this.db.markDirty();

    byChat.forEach((messageIds, chatId) => {
      const members = this.getChatMemberIds(chatId);
      messageIds.forEach(messageId => {
        presenceService.sendToChatMembers(members, {
          type: 'message_deleted',
          chatId,
          messageId,
          forAll: false,
          expired: true
        });
      });
      const chat = this.db.findChatById(chatId);
      if (!chat) return;
      members.forEach(uid => {
        const details = this.getChatWithDetails(chat, this.getChatMembersWithDetails(chatId, uid), uid);
        presenceService.sendToUser(uid, {
          type: 'chat_updated',
          chatId,
          lastMessage: details.last_message,
          lastMessageIv: details.last_message_iv,
          lastMessageHeader: details.last_message_header,
          lastMessageType: details.last_message_type,
          lastMessageTime: details.last_message_time,
          lastSenderId: details.last_sender_id
        });
      });
    });
    return expired.length;
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
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
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

  getChatWithDetails(chat, members, requesterId = null) {
    const clearedAt = requesterId ? this.db.getChatClearedAt(chat.id, requesterId) : 0;
    const chatMessages = this.db.messages.filter(m =>
      m.chat_id === chat.id && !isExpired(m) && (!clearedAt || m.created_at > clearedAt)
    );
    const lastMsg = chatMessages[chatMessages.length - 1];
    // Никакой расшифровки на сервере — только шифротекст.
    const lastContent = lastMsg && !lastMsg.deleted_for_all ? lastMsg.encrypted_content : '';
    const lastReadBy = {};
    this.db.chatMembers
      .filter(m => m.chat_id === chat.id)
      .forEach(m => { lastReadBy[m.user_id] = m.last_read_message_id || 0; });
    let other_user = null;
    if (chat && chat.type === 'private' && Array.isArray(members)) {
      const other = members.find(m => m && requesterId && m.id !== requesterId) || members[0];
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
      last_read_by: lastReadBy
    };
  }

  getUserChatsWithDetails(userId) {
    return this.db.chatMembers
      .filter(cm => cm.user_id === userId && !cm.hidden)
      .map(cm => {
        const chat = this.db.findChatById(cm.chat_id);
        if (!chat) return null;
        const details = this.getChatWithDetails(chat, this.getChatMembersWithDetails(chat.id, userId), userId);
        return { ...details, role: cm.role };
      })
      .filter(Boolean)
      .sort((a, b) => b.last_message_time - a.last_message_time);
  }

  getChatMembersWithDetails(chatId, requesterId = null) {
    return this.db.chatMembers
      .filter(m => m.chat_id === chatId)
      .map(m => {
        const u = this.db.findUserById(m.user_id);
        if (!u) return null;
        const isSelf = requesterId === null || u.id === requesterId;
        return {
          id: u.id,
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
          role: m.role
        };
      })
      .filter(Boolean);
  }
}

module.exports = WebSocketService;
