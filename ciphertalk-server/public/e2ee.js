/**
 * CipherTalk E2EE — общий модуль для браузера и Node.
 *
 * Примитивы: ECDH P-256 (Web Crypto) + AES-256-GCM + HMAC-SHA256/HKDF.
 *
 * Личные чаты:
 *   - статическая пара ECDH на пользователя, общий секрет ECDH -> HKDF -> корневой ключ;
 *   - из корневого ключа выводятся два независимых цепочечных ключа
 *     (в каждую сторону), поэтому ключ отправки и ключ приёма различаются;
 *   - каждое сообщение получает собственный ключ (HMAC по цепочке + HKDF со
 *     случайной солью) и уникальный 96-битный IV;
 *   - шаг цепочки даёт forward secrecy внутри сессии: из текущего ключа цепочки
 *     нельзя вывести предыдущие.
 *
 * Группы:
 *   - случайный 32-байтный ключ группы создаёт клиент;
 *   - для каждого участника ключ заворачивается (wrap) отдельным ECDH-ключом
 *     (KEK) и AES-256-GCM, сервер хранит только «завёрнутые» блобы.
 *
 * Сервер не знает ни одного открытого ключа и не может расшифровать данные.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CipherTalkE2EE = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SKIP = 1000;
  const MAX_SEND_KEYS = 300;
  const IV_BYTES = 12;
  const SALT_BYTES = 16;
  const KEY_BYTES = 32;

  function getCrypto() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    if (typeof require === 'function') {
      const nodeCrypto = require('crypto');
      if (nodeCrypto && nodeCrypto.webcrypto) return nodeCrypto.webcrypto;
    }
    throw new Error('WebCrypto API недоступен: нужен HTTPS/localhost или Node 18+');
  }

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function concatBytes(...parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  function randomBytes(length) {
    const out = new Uint8Array(length);
    getCrypto().getRandomValues(out);
    return out;
  }

  function bytesToText(bytes) {
    return textDecoder.decode(bytes);
  }

  function textToBytes(text) {
    return textEncoder.encode(String(text));
  }

  async function hmac(keyBytes, dataBytes) {
    const subtle = getCrypto().subtle;
    const key = await subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await subtle.sign('HMAC', key, dataBytes);
    return new Uint8Array(signature);
  }

  // HKDF (RFC 5869) на HMAC-SHA256 — реализован вручную, чтобы не зависеть
  // от поддержки HKDF в Web Crypto.
  async function hkdf(ikm, salt, info, length = KEY_BYTES) {
    const prk = await hmac(salt, ikm);
    const infoBytes = typeof info === 'string' ? textToBytes(info) : info;
    const blocks = [];
    let total = 0;
    let previous = new Uint8Array(0);
    for (let counter = 1; total < length; counter++) {
      const block = await hmac(prk, concatBytes(previous, infoBytes, new Uint8Array([counter])));
      blocks.push(block);
      total += block.length;
      previous = block;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const block of blocks) {
      out.set(block.subarray(0, Math.min(block.length, length - offset)), offset);
      offset += block.length;
      if (offset >= length) break;
    }
    return out;
  }

  async function sha256(dataBytes) {
    const digest = await getCrypto().subtle.digest('SHA-256', dataBytes);
    return new Uint8Array(digest);
  }

  const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };

  /**
   * Нормализует публичный ключ собеседника к base64(SPKI).
   * Поддерживает старый формат хранения (JWK-JSON), чтобы продолжали
   * работать аккаунты, зарегистрированные до перехода на текущую схему.
   */
  async function normalizePublicKey(key) {
    if (!key) return null;
    let raw = key;
    if (typeof raw !== 'string') {
      if (typeof raw === 'object' && raw.kty) raw = JSON.stringify(raw);
      else return null;
    }
    raw = String(raw).trim();
    if (!raw) return null;
    if (raw.charAt(0) !== '{') return raw;
    try {
      const jwk = JSON.parse(raw);
      if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
      const subtle = getCrypto().subtle;
      const pk = await subtle.importKey('jwk', jwk, ECDH_PARAMS, true, []);
      return bytesToB64(new Uint8Array(await subtle.exportKey('spki', pk)));
    } catch (e) {
      return null;
    }
  }

  async function generateIdentity() {
    const subtle = getCrypto().subtle;
    const pair = await subtle.generateKey(ECDH_PARAMS, true, ['deriveBits', 'deriveKey']);
    return {
      publicKey: bytesToB64(new Uint8Array(await subtle.exportKey('spki', pair.publicKey))),
      privateKey: bytesToB64(new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey)))
    };
  }

  async function importPublicKey(b64) {
    const subtle = getCrypto().subtle;
    return subtle.importKey('spki', b64ToBytes(b64), ECDH_PARAMS, true, []);
  }

  async function importPrivateKey(b64) {
    const subtle = getCrypto().subtle;
    return subtle.importKey('pkcs8', b64ToBytes(b64), ECDH_PARAMS, true, ['deriveBits', 'deriveKey']);
  }

  async function ecdhSharedSecret(privateKeyB64, peerPublicKeyB64) {
    const subtle = getCrypto().subtle;
    const priv = await importPrivateKey(privateKeyB64);
    const peer = await importPublicKey(peerPublicKeyB64);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256);
    return new Uint8Array(bits);
  }

  // Соль сессии зависит от обеих публичных ключей и не зависит от того,
  // кто инициировал чат.
  async function sessionSalt(publicKeyA, publicKeyB) {
    const [first, second] = publicKeyA < publicKeyB
      ? [publicKeyA, publicKeyB]
      : [publicKeyB, publicKeyA];
    return sha256(textToBytes(first + '|' + second));
  }

  async function importAesKey(keyBytes) {
    const subtle = getCrypto().subtle;
    return subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function encryptRaw(keyBytes, plaintextBytes, aadBytes) {
    const subtle = getCrypto().subtle;
    const key = await importAesKey(keyBytes);
    const iv = randomBytes(IV_BYTES);
    const params = { name: 'AES-GCM', iv, tagLength: 128 };
    if (aadBytes) params.additionalData = aadBytes;
    const ciphertext = await subtle.encrypt(params, key, plaintextBytes);
    return { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ciphertext)) };
  }

  async function decryptRaw(keyBytes, ivB64, dataB64, aadBytes) {
    const subtle = getCrypto().subtle;
    const key = await importAesKey(keyBytes);
    const params = { name: 'AES-GCM', iv: b64ToBytes(ivB64), tagLength: 128 };
    if (aadBytes) params.additionalData = aadBytes;
    const plaintext = await subtle.decrypt(params, key, b64ToBytes(dataB64));
    return new Uint8Array(plaintext);
  }

  // ==================== ЛИЧНЫЕ ЧАТЫ ====================

  /**
   * Создаёт сессию для личного чата.
   * Обе стороны получают одинаковые ключи независимо от того, кто начал диалог.
   */
  async function createDirectSession(identity, peerPublicKey) {
    if (!identity || !identity.privateKey || !peerPublicKey) {
      throw new Error('createDirectSession: нужен identity и публичный ключ собеседника');
    }
    const shared = await ecdhSharedSecret(identity.privateKey, peerPublicKey);
    const salt = await sessionSalt(identity.publicKey, peerPublicKey);
    const root = await hkdf(shared, salt, 'CT-v1|root', KEY_BYTES);
    const chainOne = await hkdf(root, salt, 'CT-v1|chain-1', KEY_BYTES);
    const chainTwo = await hkdf(root, salt, 'CT-v1|chain-2', KEY_BYTES);
    const fileKey = await hkdf(root, salt, 'CT-v1|file', KEY_BYTES);

    const iSendFirst = identity.publicKey < peerPublicKey;
    return {
      type: 'direct',
      v: 1,
      myPublicKey: identity.publicKey,
      peerPublicKey,
      fileKey: bytesToB64(fileKey),
      sendChain: bytesToB64(iSendFirst ? chainOne : chainTwo),
      recvChain: bytesToB64(iSendFirst ? chainTwo : chainOne),
      sendCount: 0,
      recvCount: 0,
      skipped: {}
    };
  }

  async function nextChainKey(chainKeyBytes) {
    return hmac(chainKeyBytes, textToBytes('CT-v1|next'));
  }

  async function messageKeyFromChain(chainKeyBytes) {
    return hmac(chainKeyBytes, textToBytes('CT-v1|mk'));
  }

  async function encryptDirect(session, plaintext, context) {
    if (!session || session.type !== 'direct') {
      throw new Error('encryptDirect: нет активной сессии');
    }
    const chainKey = b64ToBytes(session.sendChain);
    const rawKey = await messageKeyFromChain(chainKey);
    const nextChain = await nextChainKey(chainKey);

    const salt = randomBytes(SALT_BYTES);
    const messageKey = await hkdf(rawKey, salt, 'CT-v1|msg', KEY_BYTES);
    const header = JSON.stringify({
      v: 1,
      n: session.sendCount,
      ts: Date.now(),
      s: bytesToB64(salt)
    });
    const aad = textToBytes(`${context || ''}|${header}`);
    const encrypted = await encryptRaw(messageKey, textToBytes(plaintext), aad);

    if (!session.sendChainKeys) session.sendChainKeys = {};
    session.sendChainKeys[String(session.sendCount)] = bytesToB64(chainKey);
    const chainIndexes = Object.keys(session.sendChainKeys);
    if (chainIndexes.length > MAX_SEND_KEYS) {
      chainIndexes
        .map(Number)
        .sort((a, b) => a - b)
        .slice(0, chainIndexes.length - MAX_SEND_KEYS)
        .forEach(i => delete session.sendChainKeys[String(i)]);
    }

    session.sendChain = bytesToB64(nextChain);
    session.sendCount += 1;
    return { content: encrypted.data, iv: encrypted.iv, header };
  }

  async function decryptDirect(session, payload, context) {
    if (!session || session.type !== 'direct') {
      throw new Error('decryptDirect: нет активной сессии');
    }
    const header = typeof payload.header === 'string' ? payload.header : JSON.stringify(payload.header);
    const meta = JSON.parse(header);
    const index = Number(meta.n);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('decryptDirect: некорректный заголовок');
    }

    // Состояние обновляется только после успешной расшифровки: неудачная
    // попытка не должна сдвигать цепочку приёма.
    let rawKey;
    let nextRecvChain = session.recvChain;
    let nextRecvCount = session.recvCount;
    const nextSkipped = Object.assign({}, session.skipped);

    if (index === session.recvCount) {
      const chainKey = b64ToBytes(session.recvChain);
      rawKey = await messageKeyFromChain(chainKey);
      nextRecvChain = bytesToB64(await nextChainKey(chainKey));
      nextRecvCount = index + 1;
    } else if (index < session.recvCount) {
      const skipped = nextSkipped[String(index)];
      if (!skipped) throw new Error('decryptDirect: сообщение устарело или повторяется');
      rawKey = b64ToBytes(skipped.mk);
    } else {
      const gap = index - session.recvCount;
      if (gap > MAX_SKIP) throw new Error('decryptDirect: слишком большой пропуск сообщений');
      let chainKey = b64ToBytes(session.recvChain);
      for (let i = 0; i < gap; i++) {
        const skippedKey = await messageKeyFromChain(chainKey);
        nextSkipped[String(session.recvCount + i)] = { mk: bytesToB64(skippedKey) };
        chainKey = await nextChainKey(chainKey);
      }
      rawKey = await messageKeyFromChain(chainKey);
      nextRecvChain = bytesToB64(await nextChainKey(chainKey));
      nextRecvCount = index + 1;
    }

    const salt = b64ToBytes(meta.s || '');
    const messageKey = await hkdf(rawKey, salt, 'CT-v1|msg', KEY_BYTES);
    const aad = textToBytes(`${context || ''}|${header}`);
    const plaintext = await decryptRaw(messageKey, payload.iv, payload.content, aad);

    session.recvChain = nextRecvChain;
    session.recvCount = nextRecvCount;
    session.skipped = nextSkipped;
    return bytesToText(plaintext);
  }

  // Расшифровка собственного сообщения: ключ цепочки отправки по индексу.
  async function decryptDirectOwn(session, payload, context) {
    if (!session || session.type !== 'direct') {
      throw new Error('decryptDirectOwn: нет активной сессии');
    }
    const header = typeof payload.header === 'string' ? payload.header : JSON.stringify(payload.header);
    const meta = JSON.parse(header);
    const index = String(Number(meta.n));
    const stored = session.sendChainKeys && session.sendChainKeys[index];
    if (!stored) throw new Error('decryptDirectOwn: ключ отправки не найден');
    const rawKey = await messageKeyFromChain(b64ToBytes(stored));
    const salt = b64ToBytes(meta.s || '');
    const messageKey = await hkdf(rawKey, salt, 'CT-v1|msg', KEY_BYTES);
    const aad = textToBytes(`${context || ''}|${header}`);
    const plaintext = await decryptRaw(messageKey, payload.iv, payload.content, aad);
    return bytesToText(plaintext);
  }

  // ==================== ГРУППЫ ====================

  function createGroupKey() {
    return randomBytes(KEY_BYTES);
  }

  async function wrapGroupKey(groupKeyBytes, identity, memberPublicKey) {
    const shared = await ecdhSharedSecret(identity.privateKey, memberPublicKey);
    const salt = await sessionSalt(identity.publicKey, memberPublicKey);
    const kek = await hkdf(shared, salt, 'CT-v1|group-wrap', KEY_BYTES);
    const wrapped = await encryptRaw(kek, groupKeyBytes, null);
    return { iv: wrapped.iv, ct: wrapped.data };
  }

  async function unwrapGroupKey(wrapped, identity, wrapperPublicKey) {
    const shared = await ecdhSharedSecret(identity.privateKey, wrapperPublicKey);
    const salt = await sessionSalt(identity.publicKey, wrapperPublicKey);
    const kek = await hkdf(shared, salt, 'CT-v1|group-wrap', KEY_BYTES);
    return decryptRaw(kek, wrapped.iv, wrapped.ct, null);
  }

  async function encryptGroup(groupKeyBytes, plaintext, context, version) {
    const salt = randomBytes(SALT_BYTES);
    const messageKey = await hkdf(groupKeyBytes, salt, 'CT-v1|group-msg', KEY_BYTES);
    const header = JSON.stringify({
      v: 1,
      ts: Date.now(),
      s: bytesToB64(salt),
      g: version || 1
    });
    const aad = textToBytes(`${context || ''}|${header}`);
    const encrypted = await encryptRaw(messageKey, textToBytes(plaintext), aad);
    return { content: encrypted.data, iv: encrypted.iv, header };
  }

  async function decryptGroup(groupKeyBytes, payload, context) {
    const header = typeof payload.header === 'string' ? payload.header : JSON.stringify(payload.header);
    const meta = JSON.parse(header);
    const salt = b64ToBytes(meta.s || '');
    const messageKey = await hkdf(groupKeyBytes, salt, 'CT-v1|group-msg', KEY_BYTES);
    const aad = textToBytes(`${context || ''}|${header}`);
    const plaintext = await decryptRaw(messageKey, payload.iv, payload.content, aad);
    return bytesToText(plaintext);
  }

  // ==================== ФАЙЛЫ И МЕДИА ====================

  async function encryptFile(keyBytes, bytes) {
    const salt = randomBytes(SALT_BYTES);
    const fileKey = await hkdf(keyBytes, salt, 'CT-v1|file', KEY_BYTES);
    const encrypted = await encryptRaw(fileKey, bytes, null);
    return { iv: encrypted.iv, data: encrypted.data, salt: bytesToB64(salt) };
  }

  async function decryptFile(keyBytes, payload) {
    const salt = b64ToBytes(payload.salt || '');
    const fileKey = await hkdf(keyBytes, salt, 'CT-v1|file', KEY_BYTES);
    return decryptRaw(fileKey, payload.iv, payload.data, null);
  }

  function sessionFileKey(session) {
    if (!session || !session.fileKey) throw new Error('sessionFileKey: нет ключа файла');
    return b64ToBytes(session.fileKey);
  }

  // ==================== СЕРИАЛИЗАЦИЯ ====================

  function serializeSession(session) {
    return JSON.stringify({
      type: session.type,
      v: session.v,
      myPublicKey: session.myPublicKey,
      peerPublicKey: session.peerPublicKey,
      fileKey: session.fileKey,
      sendChain: session.sendChain,
      recvChain: session.recvChain,
      sendCount: session.sendCount,
      recvCount: session.recvCount,
      skipped: session.skipped || {},
      sendChainKeys: session.sendChainKeys || {}
    });
  }

  function deserializeSession(raw) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || data.type !== 'direct') return null;
    return {
      type: 'direct',
      v: data.v || 1,
      myPublicKey: data.myPublicKey || '',
      peerPublicKey: data.peerPublicKey || '',
      fileKey: data.fileKey || '',
      sendChain: data.sendChain,
      recvChain: data.recvChain,
      sendCount: data.sendCount || 0,
      recvCount: data.recvCount || 0,
      skipped: data.skipped || {},
      sendChainKeys: data.sendChainKeys || {}
    };
  }

  return {
    MAX_SKIP,
    MAX_SEND_KEYS,
    generateIdentity,
    normalizePublicKey,
    importPublicKey,
    importPrivateKey,
    ecdhSharedSecret,
    createDirectSession,
    encryptDirect,
    decryptDirect,
    decryptDirectOwn,
    createGroupKey,
    wrapGroupKey,
    unwrapGroupKey,
    encryptGroup,
    decryptGroup,
    encryptFile,
    decryptFile,
    sessionFileKey,
    serializeSession,
    deserializeSession,
    randomBytes,
    bytesToB64,
    b64ToBytes,
    textToBytes,
    bytesToText
  };
});
