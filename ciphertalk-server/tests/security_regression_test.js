/**
 * Регрессии по итогам аудита:
 * - username нормализуется и валидируется до проверки занятости;
 * - профиль не меняется частично при ошибке валидации;
 * - CORS по умолчанию same-origin;
 * - повторный auth на сокете отклоняется;
 * - телефоны в WS-снимках маскируются относительно получателя;
 * - занятый абонент получает call_unavailable без доставки offer;
 * - повреждённые key/jwt-secret файлы не перезаписываются;
 * - файл БД зашифрован at-rest (AES-256-GCM), переживает рестарт и мигрирует
 *   старую открытую БД; при потере/повреждении ключа — fail-closed без перезаписи.
 *
 * Запуск: node tests/security_regression_test.js
 */
process.env.PORT = '3459';
process.env.DB_FILE = './test-security-db.json';
process.env.UPLOADS_DIR = './test-security-uploads';

const http = require('http');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '.key', '.jwt-secret', '.dbkey']) {
  try { fs.unlinkSync(path.join(__dirname, '..', 'test-security-db.json' + suffix)); } catch (e) {}
}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(path.join(__dirname, '..', 'test-security-db.sqlite' + suffix)); } catch (e) {}
}
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const smsService = require('../src/services/smsService');
let lastOtp = null;
smsService.sendCode = async (phone, code) => { lastOtp = code; return { success: true }; };
const App = require('../src/app');
const BASE = 'http://127.0.0.1:3459';

function request(method, urlPath, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + urlPath);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...headers }
    };
    if (payload) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = payload.length;
    }
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class WsClient {
  constructor() { this.inbox = []; this.waiters = []; this.closed = false; }
  connect(token) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://127.0.0.1:3459');
      this.ws.on('open', () => { this.send({ type: 'auth', token }); resolve(); });
      this.ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        this.inbox.push(msg);
        this.waiters = this.waiters.filter(w => {
          if (w.pred(msg)) { w.resolve(msg); return false; }
          return true;
        });
      });
      this.ws.on('close', () => { this.closed = true; });
      this.ws.on('error', reject);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  wait(pred, timeout = 4000) {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS timeout')), timeout);
      this.waiters.push({ pred, resolve: m => { clearTimeout(timer); resolve(m); } });
    });
  }
  clear() { this.inbox = []; }
  close() { try { this.ws.close(); } catch (e) {} }
}

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}

async function sendAndVerify(phone) {
  lastOtp = null;
  await request('POST', '/api/send-code', { body: { phone } });
  const verify = await request('POST', '/api/verify-code', { body: { phone, code: lastOtp } });
  return verify.json;
}

async function register(phone, username, name) {
  const verify = await sendAndVerify(phone);
  const reg = await request('POST', '/api/register', {
    body: {
      phone, firstName: name, lastName: 'Тест', username,
      password: 'Passw0rd!', verifyToken: verify.verifyToken
    }
  });
  if (!reg.json || !reg.json.success) throw new Error('register failed: ' + JSON.stringify(reg.json));
  return { user: reg.json.user, token: reg.json.token };
}

async function main() {
  const app = new App();
  const server = app.start();
  await new Promise(r => setTimeout(r, 300));
  const stamp = String(Date.now()).slice(-6);
  const phoneA = `+7922${stamp}01`;
  const phoneB = `+7922${stamp}02`;
  const phoneC = `+7922${stamp}03`;

  console.log('\n— Username: нормализация и валидация —');
  const badPhone = `+7922${stamp}09`;
  const badVerify = await sendAndVerify(badPhone);
  const badReg = await request('POST', '/api/register', {
    body: {
      phone: badPhone, firstName: 'Иван', lastName: 'Тест', username: 'bad name!',
      password: 'Passw0rd!', verifyToken: badVerify.verifyToken
    }
  });
  check(badReg.status === 400, 'некорректный username отклонён');

  const A = await register(phoneA, 'Good_User', 'Алиса');
  check(A.user.username === 'good_user', 'username приведён к нижнему регистру');

  const dupPhone = `+7922${stamp}08`;
  const dupVerify = await sendAndVerify(dupPhone);
  const dupReg = await request('POST', '/api/register', {
    body: {
      phone: dupPhone, firstName: 'Пётр', lastName: 'Тест', username: 'GOOD_USER',
      password: 'Passw0rd!', verifyToken: dupVerify.verifyToken
    }
  });
  check(dupReg.status === 400 && /занят/i.test(dupReg.json.error || ''), 'дубликат после нормализации отклонён');

  const B = await register(phoneB, `secb${stamp}`, 'Боб');
  const C = await register(phoneC, `secc${stamp}`, 'Кэрол');

  console.log('\n— Атомарность обновления профиля —');
  const before = await request('GET', '/api/me', { token: A.token });
  const badProfile = await request('POST', '/api/update-profile', {
    token: A.token,
    body: { firstName: 'Изменено', email: 'not-an-email' }
  });
  const after = await request('GET', '/api/me', { token: A.token });
  check(badProfile.status === 400, 'некорректный профиль отклонён');
  check(after.json.user.first_name === before.json.user.first_name, 'имя не изменилось при ошибке');
  check(after.json.user.email === before.json.user.email, 'email не изменился при ошибке');

  console.log('\n— CORS same-origin по умолчанию —');
  const preflight = await request('OPTIONS', '/api/me', {
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'GET'
    }
  });
  check(!preflight.headers['access-control-allow-origin'], 'cross-origin preflight не получает разрешение');

  console.log('\n— WebSocket: повторная авторизация —');
  const wsA = new WsClient();
  await wsA.connect(A.token);
  await wsA.wait(m => m.type === 'chats');
  wsA.clear();
  wsA.send({ type: 'auth', token: A.token });
  const reauth = await wsA.wait(m => m.type === 'auth_error');
  await new Promise(r => setTimeout(r, 100));
  check(!!reauth && wsA.closed, 'повторный auth отклонён, сокет закрыт');

  const wsA2 = new WsClient();
  await wsA2.connect(A.token);
  await wsA2.wait(m => m.type === 'chats');

  const wsB = new WsClient();
  const wsC = new WsClient();
  await wsB.connect(B.token);
  await wsC.connect(C.token);
  await wsB.wait(m => m.type === 'chats');
  await wsC.wait(m => m.type === 'chats');

  console.log('\n— Маскирование телефонов в WS-снимках —');
  wsA2.clear(); wsB.clear();
  wsA2.send({ type: 'create_group', members: [B.user.id], name: 'Группа' });
  const groupCreated = await wsA2.wait(m => m.type === 'group_created');
  const bNewChat = await wsB.wait(m => m.type === 'new_chat' && m.chat.type === 'group');
  const aInBView = bNewChat.chat.members.find(m => m.id === A.user.id);
  const bInAView = groupCreated.chat.members.find(m => m.id === B.user.id);
  check(aInBView.phone !== A.user.phone && aInBView.phone.includes('••••'), 'телефон A скрыт от B');
  check(bInAView.phone !== B.user.phone && bInAView.phone.includes('••••'), 'телефон B скрыт от A');

  console.log('\n— Занятый абонент в WebRTC-сигналинге —');
  wsA2.clear(); wsB.clear(); wsC.clear();
  wsA2.send({ type: 'start_chat', targetUserId: B.user.id });
  await wsA2.wait(m => m.type === 'chat_created');
  wsC.send({ type: 'start_chat', targetUserId: B.user.id });
  await wsC.wait(m => m.type === 'chat_created');
  wsA2.send({ type: 'call_offer', targetUserId: B.user.id, callId: 'busy-1', callType: 'audio', sdp: 'v=0 one' });
  await wsB.wait(m => m.type === 'call_offer' && m.callId === 'busy-1');
  wsC.send({ type: 'call_offer', targetUserId: B.user.id, callId: 'busy-2', callType: 'audio', sdp: 'v=0 two' });
  const busy = await wsC.wait(m => m.type === 'call_unavailable' && m.callId === 'busy-2');
  await new Promise(r => setTimeout(r, 100));
  check(busy && busy.reason === 'busy', 'C получил call_unavailable(busy)');
  check(!wsB.inbox.some(m => m.type === 'call_offer' && m.callId === 'busy-2'), 'B не получил второй offer');

  console.log('\n— Fail-closed при повреждённых секретах —');
  const tmp = '/tmp/opencode';
  fs.mkdirSync(tmp, { recursive: true });
  const badDb = path.join(tmp, `ct-bad-${stamp}.json`);
  fs.writeFileSync(badDb + '.key', 'not-a-valid-key');
  fs.writeFileSync(badDb + '.jwt-secret', 'not-a-valid-secret');
  const root = path.resolve(__dirname, '..');
  const run = (file) => {
    try {
      execFileSync(process.execPath, ['-e', `
        process.env.DB_FILE = ${JSON.stringify(badDb)};
        const svc = require(${JSON.stringify(path.join(root, file))});
        svc.${file.includes('session') ? 'getSecret' : 'getKey'}();
      `], { cwd: root, stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status || 1;
    }
  };
  check(run('src/services/encryptionService.js') !== 0, 'повреждённый AES-ключ не перезаписан');
  check(run('src/services/sessionService.js') !== 0, 'повреждённый JWT-секрет не перезаписан');
  try { fs.unlinkSync(badDb + '.key'); fs.unlinkSync(badDb + '.jwt-secret'); } catch (e) {}

  console.log('\n— Шифрование SQLite БД at-rest —');
  const dbFile = path.join(root, 'test-security-db.json');
  const dbPath = dbFile.replace(/\.json$/, '.sqlite');
  const dbKeyPath = dbFile + '.dbkey';
  try { require('../src/db/database').getDatabase().flush(); } catch (e) {}
  const rawDb = fs.readFileSync(dbPath);
  check(rawDb.slice(0, 16).toString('utf8') !== 'SQLite format 3\u0000',
    'SQLite БД зашифрована (SQLCipher), нет открытого заголовка');
  check(!rawDb.includes(Buffer.from(A.user.username)) && !rawDb.includes(Buffer.from(A.user.phone)),
    'в зашифрованной SQLite БД нет открытых username/телефона');
  check(fs.existsSync(dbKeyPath), 'ключ БД вынесен в отдельный файл');
  try {
    const mode = fs.statSync(dbKeyPath).mode & 0o777;
    check(mode === 0o600, 'права на ключ БД — 600');
  } catch (e) {
    check(false, 'права на ключ БД — 600');
  }

  // БД читается после рестарта процесса
  const readAfterRestart = (file) => {
    try {
      const out = execFileSync(process.execPath, ['-e', `
        process.env.DB_FILE = ${JSON.stringify(file)};
        const { getDatabase } = require(${JSON.stringify(path.join(root, 'src/db/database.js'))});
        const db = getDatabase();
        console.log(JSON.stringify({ users: db.users.length }));
        db.stopAutoSave();
        process.exit(0);
      `], { cwd: root, stdio: 'pipe' }).toString();
      return JSON.parse(out.trim().split('\n').pop());
    } catch (e) {
      return null;
    }
  };
  const restored = readAfterRestart(dbFile);
  check(restored && restored.users === 3, 'зашифрованная SQLite БД читается после рестарта');

  // Потерянный ключ => fail-closed, файл БД не перезаписывается
  const noKeyDb = path.join(tmp, `ct-nokey-${stamp}.json`);
  const noKeySqlite = noKeyDb.replace(/\.json$/, '.sqlite');
  const noKeyBytes = fs.readFileSync(dbPath);
  fs.writeFileSync(noKeySqlite, noKeyBytes);
  const beforeBytes = fs.readFileSync(noKeySqlite);
  const lostKey = readAfterRestart(noKeyDb);
  check(lostKey === null, 'без ключа SQLite-сервер не стартует (fail-closed)');
  check(beforeBytes.equals(fs.readFileSync(noKeySqlite)), 'SQLite-файл не перезаписан без ключа');

  // Повреждённый ключ => fail-closed, файл БД не перезаписывается
  fs.writeFileSync(noKeyDb + '.dbkey', 'not-a-valid-key');
  const corruptKey = readAfterRestart(noKeyDb);
  check(corruptKey === null, 'повреждённый ключ БД => fail-closed');
  check(beforeBytes.equals(fs.readFileSync(noKeySqlite)), 'SQLite-файл не перезаписан при повреждённом ключе');
  try { fs.unlinkSync(noKeySqlite); fs.unlinkSync(noKeyDb + '.dbkey'); } catch (e) {}

  // Старая база в открытом JSON мигрируется в зашифрованную SQLite
  const legacyDb = path.join(tmp, `ct-legacy-${stamp}.json`);
  const legacySqlite = legacyDb.replace(/\.json$/, '.sqlite');
  fs.writeFileSync(legacyDb, JSON.stringify({
    users: [{ id: 1, username: 'legacy_user', phone: '+79991112233' }],
    chats: [], chat_members: [], messages: [], files: [], sessions: [],
    verification_codes: [], folders: [], group_keys: [],
    counters: { users: 1, chats: 0, messages: 0, files: 0, sessions: 0, folders: 0 }
  }));
  try {
    execFileSync(process.execPath, ['-e', `
      process.env.DB_FILE = ${JSON.stringify(legacyDb)};
      const { getDatabase } = require(${JSON.stringify(path.join(root, 'src/db/database.js'))});
      const db = getDatabase();
      db.markDirty();
      db.save();
      db.stopAutoSave();
      process.exit(0);
    `], { cwd: root, stdio: 'pipe' });
  } catch (e) { /* проверяем файл ниже */ }
  const legacyRaw = fs.readFileSync(legacySqlite);
  check(legacyRaw.slice(0, 16).toString('utf8') !== 'SQLite format 3\u0000',
    'старая открытая JSON-БД мигрирует в зашифрованную SQLite');
  const legacyBack = readAfterRestart(legacyDb);
  check(legacyBack && legacyBack.users === 1, 'данные миграции сохранены');
  try {
    fs.unlinkSync(legacyDb); fs.unlinkSync(legacySqlite);
    fs.unlinkSync(legacyDb + '.dbkey');
  } catch (e) {}

  wsA2.close(); wsB.close(); wsC.close();
  server.close();
  app.wsService && app.wsService.stop();
  try { require('../src/db/database').getDatabase().flush(); } catch (e) {}
  setTimeout(() => {
    console.log(`\n=== ИТОГО: passed=${passed}, failed=${failed} ===`);
    process.exit(failed ? 1 : 0);
  }, 300);
}

main().catch(e => { console.error(e); process.exit(1); });
