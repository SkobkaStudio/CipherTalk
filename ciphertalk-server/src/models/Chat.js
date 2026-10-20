class Chat {
  constructor(data) {
    this.id = data.id;
    this.type = data.type || 'private'; // 'private', 'group', 'supergroup', 'channel', 'saved'
    this.name = data.name || '';
    this.avatar = data.avatar || '';
    this.description = data.description || '';
    this.owner_id = data.owner_id || null;
    this.is_pinned = data.is_pinned || false;
    this.is_channel = data.is_channel || (this.type === 'channel') || false;
    this.created_at = data.created_at || Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      avatar: this.avatar,
      description: this.description,
      owner_id: this.owner_id,
      is_pinned: this.is_pinned,
      is_channel: this.is_channel,
      created_at: this.created_at
    };
  }
}

module.exports = Chat;