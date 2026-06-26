class VerificationCode {
  constructor(data) {
    this.phone = data.phone;
    this.code = data.code || this.generateCode();
    this.expires_at = data.expires_at || Date.now() + 5 * 60 * 1000;
  }

  generateCode() {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  isValid() {
    return Date.now() < this.expires_at;
  }

  isExpired() {
    return !this.isValid();
  }

  toJSON() {
    return {
      phone: this.phone,
      code: this.code,
      expires_at: this.expires_at
    };
  }
}

module.exports = VerificationCode;