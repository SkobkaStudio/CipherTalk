class UserSticker {
  constructor(data) {
    this.id = data.id;
    this.user_id = data.user_id;
    this.file_id = data.file_id;
    this.name = data.name || '';
    this.animated = !!data.animated;
    this.created_at = data.created_at || Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      user_id: this.user_id,
      file_id: this.file_id,
      name: this.name,
      animated: this.animated,
      created_at: this.created_at
    };
  }
}

module.exports = UserSticker;
