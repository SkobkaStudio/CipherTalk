/**
 * Presence: у одного пользователя может быть много сокетов
 * (несколько вкладок / устройств). Сообщение уходит во ВСЕ его сокеты,
 * пользователь считается offline только когда закрыт последний сокет.
 */
class PresenceService {
  constructor() {
    /** @type {Map<number, Set<import('ws').WebSocket>>} */
    this.onlineUsers = new Map();
  }

  addSocket(userId, ws) {
    if (!this.onlineUsers.has(userId)) {
      this.onlineUsers.set(userId, new Set());
    }
    this.onlineUsers.get(userId).add(ws);
    ws.userId = userId;
    ws.lastSeen = Date.now();
  }

  removeSocket(ws) {
    const userId = ws.userId;
    if (userId === undefined || userId === null) return false;

    const sockets = this.onlineUsers.get(userId);
    if (!sockets) return false;

    sockets.delete(ws);
    if (sockets.size === 0) {
      this.onlineUsers.delete(userId);
      return true; // пользователь полностью ушёл
    }
    return false;
  }

  isOnline(userId) {
    const sockets = this.onlineUsers.get(userId);
    return !!sockets && sockets.size > 0;
  }

  getOnlineUsers() {
    return Array.from(this.onlineUsers.keys());
  }

  getSockets(userId) {
    return Array.from(this.onlineUsers.get(userId) || []);
  }

  broadcast(message, excludeUserId = null) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    for (const [userId, sockets] of this.onlineUsers) {
      if (userId === excludeUserId) continue;
      this.sendRaw(sockets, data);
    }
  }

  sendToUser(userId, message) {
    const sockets = this.onlineUsers.get(userId);
    if (!sockets || sockets.size === 0) return false;
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.sendRaw(sockets, data);
    return true;
  }

  sendToChatMembers(members, message) {
    let sent = 0;
    for (const memberId of members) {
      if (this.sendToUser(memberId, message)) sent++;
    }
    return sent;
  }

  sendRaw(sockets, data) {
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        try {
          ws.send(data);
        } catch (e) {
          console.error('WS send error:', e.message);
        }
      }
    }
  }
}

module.exports = new PresenceService();
