/**
 * Полный интеграционный тест CipherTalk:
 * Регистрация (реальный OTP) -> Поиск -> Личный чат -> E2EE ->
 * Сервер видит только шифротекст -> Группа/Канал/роли ->
 * Медиа-загрузка -> Read receipts -> Тайпинг.
 *
 * Запуск: node tests/full_integration_test.js
 */
process.env.PORT = '3457';
process.env.DB_FILE = './test-integration-db.json';
process.env.UPLOADS_DIR = './test-integration-uploads';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// Подчистка от прошлых прогонов ДО загрузки App (иначе SQLite уже открыта).
for (const f of ['test-integration-db.json', 'test-integration-db.json.key', 'test-integration-db.json.tmp', 'test-integration-db.json.dbkey', 'test-integration-db.sqlite', 'test-integration-db.sqlite-wal', 'test-integration-db.sqlite-shm']) {
  try { fs.unlinkSync(path.join(__dirname, '..', f)); } catch (e) {}
}

// Перехватываем OTP: подменяем sendCode, чтобы код попал в переменную
const smsService = require('../src/services/smsService');
const dbEncryptionService = require('../src/services/dbEncryptionService');
let lastOtp = null;
smsService.sendCode = async (phone, code) => { lastOtp = code; return { success: true }; };

const App = require('../src/app');

const BASE = 'http://127.0.0.1:3457';

function request(method, urlPath, { token, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + urlPath);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {}
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    let payload;
    if (raw) {
      payload = raw;
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = payload.length;
    }
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* binary */ }
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ==== E2EE как на клиенте: ECDH P-256 + HKDF-SHA256 + AES-256-GCM ====
function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeyJwk: publicKey.export({ format: 'jwk' }),
    privateKeyObj: privateKey
  };
}

function deriveSharedKey(privKeyObj, peerPublicJwk) {
  const peerPub = crypto.createPublicKey({ key: peerPublicJwk, format: 'jwk' });
  const secret = crypto.diffieHellman({ privateKey: privKeyObj, publicKey: peerPub });
  const hkdf = crypto.hkdfSync('sha256', secret, Buffer.alloc(16, 0), Buffer.from('CipherTalk'), 32);
  return Buffer.from(hkdf);
}

function encryptAes(keyBuf, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return {
    content: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function decryptAes(keyBuf, contentB64, ivB64, tagB64) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivB64, 'base64'));
  if (tagB64) decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  // В клиенте тег вшит в ciphertext GCM через WebCrypto; здесь tag отдельно.
  // Для совместимости с клиентским форматом тег передаётся отдельно только в тесте.
  return Buffer.concat([decipher.update(Buffer.from(contentB64, 'base64')), decipher.final()]).toString('utf8');
}

// Клиент WebCrypto кладёт tag в ciphertext автоматически. Симулируем это:
function encryptLikeClient(keyBuf, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([ct, tag]); // как WebCrypto: ct||tag
  return { content: combined.toString('base64'), iv: iv.toString('base64') };
}

function decryptLikeClient(keyBuf, contentB64, ivB64) {
  const all = Buffer.from(contentB64, 'base64');
  const ct = all.slice(0, all.length - 16);
  const tag = all.slice(all.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

class WsClient {
  constructor() { this.ws = null; this.inbox = []; this.waiters = []; }
  connect(token) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://127.0.0.1:3457');
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'auth', token }));
        resolve();
      });
      this.ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        this.inbox.push(msg);
        this.waiters = this.waiters.filter(w => {
          if (w.pred(msg)) { w.resolve(msg); return false; }
          return true;
        });
      });
      this.ws.on('error', reject);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  wait(pred, timeoutMs = 5000) {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS timeout waiting for message')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: m => { clearTimeout(timer); resolve(m); }
      });
    });
  }
  clear() { this.inbox = []; }
  close() { try { this.ws.close(); } catch (e) {} }
}

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.error('  ❌ FAIL: ' + name); }
}

async function registerUser(phone, username, firstName) {
  lastOtp = null;
  const send = await request('POST', '/api/send-code', { body: { phone } });
  assert(send.status === 200 && send.json.success, `OTP отправлен на ${phone}`);
  assert(lastOtp && lastOtp.length === 6, `[MANUAL OTP] 6-значный код получен: ${lastOtp}`);

  const verify = await request('POST', '/api/verify-code', { body: { phone, code: lastOtp } });
  assert(verify.status === 200 && verify.json.action === 'register', 'verify-code -> register');

  const kp = makeKeyPair();
  const reg = await request('POST', '/api/register', {
    body: {
      phone, firstName, lastName: 'Тест', username,
      password: 'secret123',
      publicKey: JSON.stringify(kp.publicKeyJwk),
      verifyToken: verify.json.verifyToken
    }
  });
  assert(reg.status === 200 && reg.json.success && reg.json.token, `Регистрация @${username} (${firstName})`);
  return { token: reg.json.token, user: reg.json.user, kp };
}

async function main() {
  console.log('=== CipherTalk Full Integration Test ===\n');

  const app = new App();
  const server = app.start();
  await new Promise(r => setTimeout(r, 800));

  try {
    // 0. Health
    console.log('\n— Health —');
    const health = await request('GET', '/api/health');
    assert(health.status === 200 && health.json.status === 'ok', 'GET /api/health');

    // 1. Регистрация двух пользователей через реальный OTP
    console.log('\n— Регистрация (реальный OTP) —');
    const stamp = Date.now() % 1000000;
    const A = await registerUser(`+7900${stamp}01`, `usera${stamp}`, 'Алиса');
    const B = await registerUser(`+7900${stamp}02`, `userb${stamp}`, 'Боб');

    // 2. Поиск
    console.log('\n— Поиск пользователей —');
    const search = await request('GET', `/api/search-users?query=userb${stamp}`, { token: A.token });
    assert(search.status === 200 && Array.isArray(search.json) && search.json.length === 1, 'Поиск по username находит B');
    assert(search.json[0].id === B.user.id, 'Найден именно B');
    const searchPhone = await request('GET', `/api/search-users?query=${B.user.phone}`, { token: A.token });
    assert(searchPhone.json.length === 1, 'Поиск по телефону находит B');

    // 3. WebSocket: личный чат
    console.log('\n— WebSocket: авторизация и личный чат —');
    const wsA = new WsClient();
    const wsB = new WsClient();
    await wsA.connect(A.token);
    await wsB.connect(B.token);
    await wsA.wait(m => m.type === 'chats');
    await wsB.wait(m => m.type === 'chats');
    assert(true, 'WS auth: оба получили список чатов');

    wsA.clear(); wsB.clear();
    wsA.send({ type: 'start_chat', targetUserId: B.user.id });
    const created = await wsA.wait(m => m.type === 'chat_created');
    assert(created.chatId > 0 && created.members.length === 2, 'start_chat создал личный чат (2 участника)');
    const chatId = created.chatId;

    const newChatB = await wsB.wait(m => m.type === 'new_chat' && m.chat && m.chat.id === chatId);
    assert(!!newChatB, 'B получил new_chat уведомление');

    // 4. E2EE: A шифрует, B расшифровывает, сервер видит только шифротекст
    console.log('\n— E2EE: ECDH P-256 + HKDF + AES-256-GCM —');
    const sharedA = deriveSharedKey(A.kp.privateKeyObj, B.kp.publicKeyJwk);
    const sharedB = deriveSharedKey(B.kp.privateKeyObj, A.kp.publicKeyJwk);
    assert(sharedA.equals(sharedB), 'ECDH: общий ключ совпал у A и B');

    const secretText = `Секретное сообщение 🔐 ${Date.now()}`;
    const enc = encryptLikeClient(sharedA, secretText);
    assert(decryptLikeClient(sharedB, enc.content, enc.iv) === secretText, 'B расшифровал сообщение A');

    // A -> server -> B
    wsA.clear(); wsB.clear();
    wsA.send({ type: 'send_message', chatId, content: enc.content, iv: enc.iv, msgType: 'text' });
    const delivered = await wsB.wait(m => m.type === 'new_message' && m.message && m.message.chatId === chatId);
    assert(delivered.message.content === enc.content, 'B получил шифротекст по WS');
    assert(decryptLikeClient(sharedB, delivered.message.content, delivered.message.iv) === secretText, 'B расшифровал доставленное сообщение');

    const selfA = await wsA.wait(m => m.type === 'new_message' && m.message && m.message.content === enc.content);
    assert(!!selfA, 'A тоже получил эхо своего сообщения');

    // Сервер хранит только шифротекст
    await new Promise(r => setTimeout(r, 800));
    const dbFile = path.join(__dirname, '..', 'test-integration-db.sqlite');
    const dbRaw = fs.readFileSync(dbFile);
    assert(!dbRaw.includes(Buffer.from(secretText)), 'На диске SQLite БД нет открытого текста');

    // REST history: должен отдать шифротекст (E2EE), не plaintext
    const hist = await request('GET', `/api/messages/${chatId}`, { token: B.token });
    const lastMsg = hist.json[hist.json.length - 1];
    assert(lastMsg.encrypted_content === enc.content, 'REST /api/messages отдаёт шифротекст (сервер не знает ключ');

    // Обратный путь: B -> A
    const replyText = 'Ответ Боба: всё работает!';
    const encReply = encryptLikeClient(sharedB, replyText);
    wsB.send({ type: 'send_message', chatId, content: encReply.content, iv: encReply.iv, msgType: 'text' });
    const gotReply = await wsA.wait(m => m.type === 'new_message' && m.message && m.message.content === encReply.content);
    assert(decryptLikeClient(sharedA, gotReply.message.content, gotReply.message.iv) === replyText, 'A расшифровал ответ B');

    // 5. Дубликаты: повторная доставка не дублируется на клиенте (проверка сервера: id уникален)
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const e = encryptLikeClient(sharedA, 'spam' + i);
      wsA.send({ type: 'send_message', chatId, content: e.content, iv: e.iv, msgType: 'text' });
    }
    await new Promise(r => setTimeout(r, 400));
    const hist2 = await request('GET', `/api/messages/${chatId}`, { token: A.token });
    const idSet = new Set(hist2.json.map(m => m.id));
    assert(idSet.size === hist2.json.length, 'ID сообщений уникальны (нет дублей на сервере)');

    // 6. Read receipts
    console.log('\n— Read receipts —');
    wsA.clear(); wsB.clear();
    const lastId = hist2.json[hist2.json.length - 1].id;
    wsB.send({ type: 'read_messages', chatId, lastReadId: lastId });
    const readEvt = await wsA.wait(m => m.type === 'messages_read' && m.chatId === chatId);
    assert(readEvt.userId === B.user.id && readEvt.lastReadId === lastId, 'A получил messages_read от B');

    // 7. Тайпинг
    console.log('\n— Тайпинг —');
    wsB.clear();
    wsB.send({ type: 'typing', chatId });
    const typing = await wsA.wait(m => m.type === 'typing' && m.chatId === chatId);
    assert(typing.userId === B.user.id, 'A получил typing-событие');

    // 8. Группа: роли owner/member
    console.log('\n— Группа и роли —');
    wsA.clear();
    wsA.send({ type: 'create_group', name: 'Тестовая группа', members: [B.user.id] });
    const group = await wsA.wait(m => m.type === 'group_created' && m.chat && m.chat.type === 'group');
    const ownerRole = group.chat.members.find(m => m.id === A.user.id)?.role;
    const memberRole = group.chat.members.find(m => m.id === B.user.id)?.role;
    assert(ownerRole === 'owner', 'A — owner группы');
    assert(memberRole === 'member', 'B — member группы');

    // B не owner: попытка удалить owner должна быть запрещена
    wsB.clear();
    wsB.send({ type: 'remove_member', chatId: group.chat.id, userId: A.user.id });
    const deny = await wsB.wait(m => m.type === 'error' && m.code === 'forbidden');
    assert(!!deny, 'B (member) не может удалить owner');

    // E2EE в группе: детерминированный ключ
    const groupKeyA = crypto.createHash('sha256').update('CipherTalk-Group-' + group.chat.id).digest();
    const gEnc = encryptLikeClient(groupKeyA, 'Группное секретное сообщение');
    wsA.send({ type: 'send_message', chatId: group.chat.id, content: gEnc.content, iv: gEnc.iv, msgType: 'text' });
    const gGot = await wsB.wait(m => m.type === 'new_message' && m.message && m.message.chatId === group.chat.id);
    const groupKeyB = crypto.createHash('sha256').update('CipherTalk-Group-' + group.chat.id).digest();
    assert(decryptLikeClient(groupKeyB, gGot.message.content, gGot.message.iv) === 'Группное секретное сообщение', 'Группное E2EE: B расшифровал');

    // 9. Канал: только owner/admin добавляет
    console.log('\n— Канал и роли —');
    wsA.clear();
    wsA.send({ type: 'create_channel', name: 'Тестовый канал', description: 'опыт' });
    const chan = await wsA.wait(m => m.type === 'new_chat' && m.chat && m.chat.type === 'channel');
    assert(chan.chat.id > 0, 'Канал создан');
    wsB.clear();
    wsB.send({ type: 'add_member', chatId: chan.chat.id, userId: A.user.id });
    // B вообще не участник канала -> forbidden
    const chanDeny = await wsB.wait(m => m.type === 'error');
    assert(chanDeny.code === 'forbidden', 'Не участник канала не может добавлять');

    // 10. Медиа: E2EE-файл (сервер видит только шифротекст)
    console.log('\n— Медиа: E2EE-загрузка файла —');
    const filePlain = Buffer.from('конфиденциальные данные файла — pdf bytes');
    const ivM = crypto.randomBytes(12);
    const cipherM = crypto.createCipheriv('aes-256-gcm', sharedA, ivM);
    const ctM = Buffer.concat([cipherM.update(filePlain), cipherM.final()]);
    const encFile = Buffer.concat([ivM, ctM, cipherM.getAuthTag()]); // формат клиента: iv||ct||tag

    const boundary = '----ct' + Date.now();
    const fileBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="encrypted.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      encFile,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const uploadResult = await new Promise((resolve, reject) => {
      const req2 = http.request({
        hostname: '127.0.0.1', port: 3457, path: '/api/upload', method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + A.token,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        }
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req2.on('error', reject);
      req2.write(fileBody);
      req2.end();
    });
    assert(uploadResult.status === 200 && uploadResult.json.url, 'Файл загружен, получен URL');

    // Скачивание с токеном
    const dl = await request('GET', uploadResult.json.url, { token: A.token });
    assert(dl.status === 200 && dl.body.equals(encFile), 'Скачанный файл побайтно равен шифротексту (не plaintext)');
    assert(!dl.body.includes('конфиденциальные'), 'На сервере нет plaintext файла');

    // Расшифровка скачанного файла ключом B
    const dlIv = dl.body.slice(0, 12);
    const dlTag = dl.body.slice(dl.body.length - 16);
    const dlCt = dl.body.slice(12, dl.body.length - 16);
    const decFile = crypto.createDecipheriv('aes-256-gcm', sharedB, dlIv);
    decFile.setAuthTag(dlTag);
    const fileBack = Buffer.concat([decFile.update(dlCt), decFile.final()]);
    assert(fileBack.equals(filePlain), 'B расшифровал файл побайтно');

    // 11. Приватность: hide_online
    console.log('\n— Приватность: скрытие онлайна —');
    wsA.clear();
    wsA.send({ type: 'set_privacy', hideOnline: true });
    const priv = await wsA.wait(m => m.type === 'privacy_updated');
    assert(priv.hideOnline === true, 'set_privacy: hide_online=true принят');
    wsB.clear();
    // A переподключается, чтобы offline/online событие прошло заново
    wsA.close();
    await new Promise(r => setTimeout(r, 300));
    const wsA2 = new WsClient();
    await wsA2.connect(A.token);
    await wsA2.wait(m => m.type === 'chats');
    await new Promise(r => setTimeout(r, 200));
    const onlineLeak = wsB.inbox.some(m => m.type === 'user_online' && m.userId === A.user.id);
    assert(!onlineLeak, 'Скрытый онлайн: B не получил user_online от A');
    const prof = await request('GET', '/api/profile/' + A.user.id, { token: B.token });
    assert(prof.json.hide_online === 1 || prof.json.hide_online === true, 'hide_online виден в БД/профиле');

    // 12. Удалённое сообщение не утекает через REST
    console.log('\n— Удаление сообщений —');
    wsA2.clear();
    wsA2.send({ type: 'delete_message', chatId, messageId: lastId, forAll: true });
    await new Promise(r => setTimeout(r, 300));
    const hist3 = await request('GET', `/api/messages/${chatId}`, { token: A.token });
    const deleted = hist3.json.find(m => m.id === lastId);
    // Сервер не знает содержимого и не подставляет текст — только флаг удаления.
    // Плашку "Сообщение удалено" рисует клиент.
    assert(deleted && deleted.deleted_for_all === 1, 'Удалённое сообщение помечено deleted_for_all');
    assert(deleted.encrypted_content === '' && deleted.iv === '',
      'Удалённое сообщение: сервер не отдаёт ни шифротекст, ни IV');

    // 13. Сессии: logout инвалидирует токен
    console.log('\n— Сессии / logout —');
    const lo = await request('POST', '/api/logout', { token: B.token });
    assert(lo.status === 200 && lo.json.success, 'logout OK');
    const meAfter = await request('GET', '/api/me', { token: B.token });
    assert(meAfter.status === 401, 'После logout токен недействителен (401)');

    // 14. Passwordless-вход по коду из SMS (для аккаунтов без пароля)
    console.log('\n— Вход по коду (passwordless) —');
    // Снимаем cooldown повторной отправки, чтобы протестировать полный путь
    require('../src/controllers/authController').sendCooldowns.clear();
    lastOtp = null;
    await request('POST', '/api/send-code', { body: { phone: B.user.phone } });
    assert(lastOtp && lastOtp.length === 6, 'OTP повторно отправлен');
    const vc = await request('POST', '/api/verify-code', { body: { phone: B.user.phone, code: lastOtp } });
    assert(vc.json.action === 'login' && !!vc.json.loginToken, 'verify-code вернул loginToken для входа');
    const kpB2 = makeKeyPair();
    const otpLogin = await request('POST', '/api/login-code', {
      body: { phone: B.user.phone, loginToken: vc.json.loginToken, publicKey: JSON.stringify(kpB2.publicKeyJwk) }
    });
    assert(otpLogin.status === 200 && otpLogin.json.token, 'login-code: получен токен сессии без пароля');
    const meOtp = await request('GET', '/api/me', { token: otpLogin.json.token });
    assert(meOtp.status === 200 && meOtp.json.user.id === B.user.id, 'Токен OTP-входа валиден');
    const badProof = await request('POST', '/api/login-code', {
      body: { phone: B.user.phone, loginToken: 'garbage' }
    });
    assert(badProof.status === 403, 'Невалидный loginToken отклонён (403)');

    // 15. Ротация ключа: смена публичного ключа рассылается собеседникам
    console.log('\n— Ротация E2EE-ключа —');
    const kpA2 = makeKeyPair();
    wsB.clear();
    wsA2.send({ type: 'set_public_key', publicKey: JSON.stringify(kpA2.publicKeyJwk) });
    const keyEvt = await wsB.wait(m => m.type === 'public_key' && m.userId === A.user.id);
    assert(!!keyEvt && keyEvt.publicKey.includes(kpA2.publicKeyJwk.x),
      'B получил обновлённый public_key от A');
    // После ротации A шифрует новым ключом, B расшифровывает через новый общий секрет
    const sharedA2 = deriveSharedKey(kpA2.privateKeyObj, B.kp.publicKeyJwk);
    const secret2 = 'Сообщение после ротации ключа';
    const enc2 = encryptLikeClient(sharedA2, secret2);
    wsB.clear();
    wsA2.send({ type: 'send_message', chatId, content: enc2.content, iv: enc2.iv, msgType: 'text' });
    const got2 = await wsB.wait(m => m.type === 'new_message' && m.message && m.message.content === enc2.content);
    const sharedB2 = deriveSharedKey(B.kp.privateKeyObj, kpA2.publicKeyJwk);
    assert(decryptLikeClient(sharedB2, got2.message.content, got2.message.iv) === secret2,
      'B расшифровал сообщение после ротации ключа A');

    // 16. Персистентность пароля: password_hash выживает в БД и не утекает в API
    console.log('\n— Персистентность пароля —');
    const dbMod = require('../src/db/database'); const dbInst = dbMod.getDatabase(); const dbObj = { users: dbInst.users.map(u=>u.toJSON?u.toJSON():u) };
    const userA = dbObj.users.find(u => u.id === A.user.id);
    assert(userA && typeof userA.password_hash === 'string' && userA.password_hash.length > 0,
      'password_hash сохраняется в БД (не стирается toJSON)');
    const meA = await request('GET', '/api/me', { token: A.token });
    assert(meA.json.user && meA.json.user.password_hash === undefined,
      'API /api/me не отдаёт password_hash');
    const searchNoLeak = await request('GET', `/api/search-users?query=username`, { token: A.token });
    assert(Array.isArray(searchNoLeak.json) && searchNoLeak.json.every(u => u.password_hash === undefined),
      'Поиск пользователей не утекает password_hash');

    wsA.close(); wsA2.close(); wsB.close();
  } catch (e) {
    failed++;
    console.error('\n❌ Тест упал с исключением:', e.message);
    console.error(e.stack);
  } finally {
    server.close();
    app.wsService && app.wsService.stop();
    try { require('../src/db/database').getDatabase().flush(); } catch (e) {}
    setTimeout(() => {
      console.log(`\n=== ИТОГО: passed=${passed}, failed=${failed} ===`);
      process.exit(failed ? 1 : 0);
    }, 500);
  }
}

main();
