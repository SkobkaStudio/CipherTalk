class VerificationCode {
  constructor(data) {
    this.phone = data.phone;
    // код хранится в БД в зашифрованном виде (AES-256-GCM)
    this.code = data.code;
    this.attempts = data.attempts || 0;
    this.expires_at = data.expires_at || Date.now() + 5 * 60 * 1000;
    this.created_at = data.created_at || Date.now();
  }

  toJSON() {
    return {
      phone: this.phone,
      code: this.code,
      attempts: this.attempts,
      expires_at: this.expires_at,
      created_at: this.created_at
    };
  }
}

module.exports = VerificationCode;
