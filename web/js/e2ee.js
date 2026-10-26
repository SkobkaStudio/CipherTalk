// =============================================================================
//  e2ee.js — сквозное шифрование (E2EE) на WebCrypto
// =============================================================================
//  СХЕМА (гибридное шифрование, как в Signal/Telegram MTProto-секретах):
//
//    1. При регистрации браузер генерирует пару RSA-2048 (OAEP-SHA256).
//       ПУБЛИЧНЫЙ ключ уходит на сервер (поле users.e2ee_pub),
//       ПРИВАТНЫЙ сохраняется в localStorage и НИКОГДА не покидает устройство.
//
//    2. Чтобы отправить сообщение, отправитель:
//       - генерирует случайный AES-256-GCM ключ (session key);
//       - шифрует им текст: {iv, ct} = AES-GCM(plaintext);
//       - шифрует session key публичным ключом получателя: RSA-OAEP;
//       - на сервер уходит контейнер {ek:[...], iv, ct}.
//
//    3. В ГРУППАХ каждый участник должен расшифровать session key, поэтому
//       session key шифруется отдельно публичным ключом КАЖДОГО участника.
//       Приватный ключ собеседника есть только у него — сервер не может
//       прочитать ничего, даже имея полный дамп БД.
//
//  Формат контейнера (то, что лежит в messages.content на сервере):
//     { "v":1, "ek":["b64...","b64..."], "iv":"b64", "ct":"b64" }
//  где ek — зашифрованные session keys по порядку id участников.
// =============================================================================

const E2EE = (() => {
  const LS_PRIV = 'e2ee_priv';        // ключ localStorage с приватным ключом (jwk)

  // ---------- низкоуровневые помощники base64 <-> ArrayBuffer ----------
  const b64enc = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64dec = s   => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;

  // Генерация собственной пары ключей (вызывается один раз при регистрации)
  async function generateIdentity() {
    const pair = await crypto.subtle.generateKey(
      { name:'RSA-OAEP', modulusLength:2048,
        publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' },
      true, ['encrypt','decrypt']);
    // jwk — JSON-представление ключа; его можно положить в localStorage/БД
    const pubJwk  = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    localStorage.setItem(LS_PRIV, JSON.stringify(privJwk));
    return JSON.stringify(pubJwk);            // строка для поля e2ee_pub
  }

  // Импорт чужого публичного ключа из строки jwk (с кэшированием)
  const pubCache = new Map();
  async function importPub(jwkStr) {
    if (pubCache.has(jwkStr)) return pubCache.get(jwkStr);
    const k = await crypto.subtle.importKey('jwk', JSON.parse(jwkStr),
                                            { name:'RSA-OAEP', hash:'SHA-256' },
                                            true, ['encrypt']);
    pubCache.set(jwkStr, k);
    return k;
  }
  // Импорт своего приватного ключа из localStorage
  async function importPriv() {
    const s = localStorage.getItem(LS_PRIV);
    if (!s) throw new Error('Приватный ключ потерян (очистили localStorage?)');
    return crypto.subtle.importKey('jwk', JSON.parse(s),
                                   { name:'RSA-OAEP', hash:'SHA-256' },
                                   true, ['decrypt']);
  }

  // Генерация случайного симметричного ключа AES-256-GCM
  async function genAesKey() {
    return crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true,
                                      ['encrypt','decrypt']);
  }

  // --------------------------- ШИФРОВАНИЕ ------------------------------------
  // plainText — строка; peerPubs — массив строк jwk (все получатели, включая себя)
  async function encrypt(plainText, pubsList) {
    const aesKey = await genAesKey();
    const raw    = await crypto.subtle.exportKey('raw', aesKey);  // 32 байта
    const iv     = crypto.getRandomValues(new Uint8Array(12));    // nonce GCM
    const ct     = await crypto.subtle.encrypt(
        { name:'AES-GCM', iv }, aesKey, new TextEncoder().encode(plainText));

    // Session key шифруется под каждого получателя по отдельности
    const ek = [];
    for (const p of pubsList) {
      const pk = await importPub(p);
      const encKey = await crypto.subtle.encrypt({ name:'RSA-OAEP' }, pk, raw);
      ek.push(b64enc(encKey));
    }
    return JSON.stringify({ v:1, ek, iv:b64enc(iv.buffer), ct:b64enc(ct) });
  }

  // --------------------------- РАСШИФРОВКА -----------------------------------
  // containerJson — строка из messages.content; myIndex — позиция моего ключа
  // в списке ek (сервер присылает ordered ids участников, фронт считает индекс).
  async function decrypt(containerJson, myIndex) {
    let c; try { c = JSON.parse(containerJson); } catch(e){ return null; }
    if (!c || !c.ek || c.ek.length === 0) return null;
    const idx = (typeof myIndex === 'number') ? myIndex : 0;
    if (idx >= c.ek.length) return null;                 // меня тут нет — не наше
    try {
      const priv = await importPriv();
      const raw  = await crypto.subtle.decrypt({ name:'RSA-OAEP' }, priv, b64dec(c.ek[idx]));
      const aesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      const pt = await crypto.subtle.decrypt(
          { name:'AES-GCM', iv: b64dec(c.iv) }, aesKey, b64dec(c.ct));
      return new TextDecoder().decode(pt);
    } catch (e) {
      // Ключ не подходит к этому сообщению — вернём null, UI покажет 🔒
      return null;
    }
  }

  // Проверка: есть ли у нас вообще ключи (для экрана входа)
  const hasIdentity = () => !!localStorage.getItem(LS_PRIV);

  return { generateIdentity, encrypt, decrypt, hasIdentity };
})();
