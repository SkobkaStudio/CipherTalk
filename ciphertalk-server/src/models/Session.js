const config = require('../config');

class Session {
  constructor(data) {
    this.id = data.id;
    this.user_id = data.user_id;
    this.token_hash = data.token_hash;
    this.created_at = data.created_at || Date.now();
    this.expires_at = data.expires_at || Date.now() + config.sessionTtlMs;
    this.user_agent = data.user_agent || '';
  }

  isExpired(now = Date.now()) {
    return now > this.expires_at;
  }

  toJSON() {
    return {
      id: this.id,
      user_id: this.user_id,
      token_hash: this.token_hash,
      created_at: this.created_at,
      expires_at: this.expires_at,
      user_agent: this.user_agent
    };
  }
}

module.exports = Session;
