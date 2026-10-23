class Message {
  constructor(data) {
    this.id = data.id;
    this.chat_id = data.chat_id;
    this.sender_id = data.sender_id;
    // Клиентский шифротекст. Сервер НЕ расшифровывает и не перешифровывает:
    // хранит ровно то, что прислал браузер (ciphertext + iv + header).
    this.encrypted_content = data.encrypted_content || '';
    this.iv = data.iv || '';
    // Заголовок Double Ratchet (JSON): { dh, n, ts } — нужен получателю.
    this.header = data.header || '';
    this.type = data.type || 'text';
    this.reply_to = data.reply_to || null;
    this.forwarded_from = data.forwarded_from || null;
    this.edited = data.edited || 0;
    this.deleted_for_all = data.deleted_for_all || 0;
    this.deleted_by = Array.isArray(data.deleted_by) ? data.deleted_by : [];
    this.reactions = data.reactions && typeof data.reactions === 'object' ? data.reactions : {};
    this.pinned = data.pinned || 0;
    // Абсолютное время автоудаления (UTC ms) или null, если TTL не задан.
    this.expires_at = Number(data.expires_at) || null;
    this.created_at = data.created_at || Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      chat_id: this.chat_id,
      sender_id: this.sender_id,
      encrypted_content: this.encrypted_content,
      iv: this.iv,
      header: this.header,
      type: this.type,
      reply_to: this.reply_to,
      forwarded_from: this.forwarded_from,
      edited: this.edited,
      deleted_for_all: this.deleted_for_all,
      deleted_by: this.deleted_by || [],
      reactions: this.reactions || {},
      pinned: this.pinned || 0,
      expires_at: this.expires_at || null,
      created_at: this.created_at
    };
  }
}

module.exports = Message;
