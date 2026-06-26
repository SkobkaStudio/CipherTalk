class Chat {
  constructor(data) {
    this.id = data.id;
    this.type = data.type || 'private'; // 'private', 'group', 'saved'
    this.name = data.name || '';
    this.avatar = data.avatar || '';
    this.owner_id = data.owner_id || null;
    this.created_at = data.created_at || Date.now();
  }

  isPrivate() { return this.type === 'private'; }
  isGroup() { return this.type === 'group'; }
  isSaved() { return this.type === 'saved'; }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      avatar: this.avatar,
      owner_id: this.owner_id,
      created_at: this.created_at
    };
  }
}

module.exports = Chat;