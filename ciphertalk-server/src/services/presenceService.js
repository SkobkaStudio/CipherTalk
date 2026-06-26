class PresenceService {
  constructor() {
    this.onlineUsers = new Map();
    this.userCallbacks = [];
  }

  setOnline(userId, ws) {
    this.onlineUsers.set(userId, {
      ws,
      lastSeen: Date.now()
    });
  }

  setOffline(userId) {
    this.onlineUsers.delete(userId);
  }

  isOnline(userId) {
    return this.onlineUsers.has(userId);
  }

  getOnlineUsers() {
    return Array.from(this.onlineUsers.keys());
  }

  getClient(userId) {
    return this.onlineUsers.get(userId)?.ws || null;
  }

  updateLastSeen(userId) {
    const user = this.onlineUsers.get(userId);
    if (user) {
      user.lastSeen = Date.now();
    }
  }

  // Broadcast to all online users
  broadcast(message, excludeUserId = null) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    for (const [userId, user] of this.onlineUsers) {
      if (userId !== excludeUserId && user.ws.readyState === 1) {
        try {
          user.ws.send(data);
        } catch (e) {
          console.error('Broadcast error:', e);
        }
      }
    }
  }

  // Send to specific user
  sendToUser(userId, message) {
    const client = this.getClient(userId);
    if (client && client.readyState === 1) {
      try {
        client.send(typeof message === 'string' ? message : JSON.stringify(message));
        return true;
      } catch (e) {
        console.error('Send error:', e);
        return false;
      }
    }
    return false;
  }

  // Send to chat members
  sendToChatMembers(chatId, members, message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    let sent = 0;
    for (const memberId of members) {
      if (this.sendToUser(memberId, data)) {
        sent++;
      }
    }
    return sent;
  }
}

module.exports = new PresenceService();