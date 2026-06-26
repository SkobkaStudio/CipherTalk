class Message {
  constructor(data) {
    this.id = data.id;
    this.chat_id = data.chat_id;
    this.sender_id = data.sender_id;
    this.encrypted_content = data.encrypted_content || '';
    this.iv = data.iv || '';
    this.type = data.type || 'text';
    this.reply_to = data.reply_to || null;
    this.edited = data.edited || 0;
    this.created_at = data.created_at || Date.now();
  }

  isText() { return this.type === 'text'; }
  isFile() { return this.type === 'file'; }
  isVoice() { return this.type === 'voice'; }

  toJSON() {
    return {
      id: this.id,
      chat_id: this.chat_id,
      sender_id: this.sender_id,
      encrypted_content: this.encrypted_content,
      iv: this.iv,
      type: this.type,
      reply_to: this.reply_to,
      edited: this.edited,
      created_at: this.created_at
    };
  }
}

module.exports = Message;