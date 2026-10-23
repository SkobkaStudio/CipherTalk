const crypto = require('crypto');
const config = require('../config');

/**
 * ICE-серверы для WebRTC.
 *
 * STUN — по умолчанию публичные Google STUN (помогают определить внешний адрес).
 * TURN — опционально: нужен, если оба участника за symmetric NAT.
 *
 * Два режима TURN:
 * 1) TURN_SECRET (static-auth-secret, как у coturn) — сервер выдаёт
 *    одноразовые (time-limited) учётные данные по схеме REST API coturn:
 *    username = "<expiry>:<random>", credential = base64(HMAC-SHA1(secret, username)).
 *    Пароль TURN-сервера клиенту не передаётся.
 * 2) TURN_USERNAME + TURN_CREDENTIAL — статические учётные данные.
 */
class IceService {
  getStunServers() {
    const urls = config.ice.stunUrls.filter(Boolean);
    return urls.length ? [{ urls }] : [];
  }

  getTurnCredentials() {
    if (config.ice.turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + config.ice.turnTtlSeconds;
      const username = `${expiry}:${crypto.randomBytes(6).toString('hex')}`;
      const credential = crypto
        .createHmac('sha1', config.ice.turnSecret)
        .update(username)
        .digest('base64');
      return { username, credential, ephemeral: true };
    }
    if (config.ice.turnUsername && config.ice.turnCredential) {
      return {
        username: config.ice.turnUsername,
        credential: config.ice.turnCredential,
        ephemeral: false
      };
    }
    return null;
  }

  getIceServers() {
    const servers = this.getStunServers();
    const turnUrl = config.ice.turnUrl;

    if (turnUrl) {
      const creds = this.getTurnCredentials();
      if (creds) {
        servers.push({
          urls: turnUrl.split(',').map(u => u.trim()).filter(Boolean),
          username: creds.username,
          credential: creds.credential
        });
      } else {
        console.warn(
          '[ICE] TURN_URL задан, но нет TURN_SECRET или TURN_USERNAME/TURN_CREDENTIAL — TURN отключён'
        );
      }
    }

    return servers;
  }

  hasTurn() {
    return !!config.ice.turnUrl && !!this.getTurnCredentials();
  }
}

module.exports = new IceService();
