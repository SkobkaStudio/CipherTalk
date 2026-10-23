/**
 * Проверка серверного WebRTC-сигналинга: offer/ringing/answer/ice/end,
 * запрет звонков вне личного чата и call_unavailable для офлайна.
 * Запуск: node tests/call_signal_test.js
 */
process.env.PORT = '3458';
process.env.DB_FILE = './test-call-db.json';
process.env.UPLOADS_DIR = './test-call-uploads';

const http = require('http');
const WebSocket = require('ws');
const smsService = require('../src/services/smsService');
let lastOtp = null;
smsService.sendCode = async (phone, code) => { lastOtp = code; return { success: true }; };
const App = require('../src/app');
const BASE = 'http://127.0.0.1:3458';

function request(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + urlPath);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class WsClient {
  constructor() { this.inbox = []; this.waiters = []; }
  connect(token) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://127.0.0.1:3458');
      this.ws.on('open', () => { this.send({ type: 'auth', token }); resolve(); });
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

async function register(phone, username, name) {
  lastOtp = null;
  await request('POST', '/api/send-code', { body: { phone } });
  const verify = await request('POST', '/api/verify-code', { body: { phone, code: lastOtp } });
  const reg = await request('POST', '/api/register', {
    body: {
      phone, firstName: name, lastName: 'Тест', username,
      password: 'Passw0rd!', verifyToken: verify.json.verifyToken
    }
  });
  if (!reg.json || !reg.json.success) {
    throw new Error('register failed: ' + JSON.stringify(reg.json));
  }
  return { user: reg.json.user, token: reg.json.token };
}

async function main() {
  const app = new App();
  const server = app.start();
  wait: {
    await new Promise(r => setTimeout(r, 300));
  }
  const stamp = String(Date.now()).slice(-6);
  const A = await register(`+7911${stamp}01`, `calla${stamp}`, 'Алиса');
  const B = await register(`+7911${stamp}02`, `callb${stamp}`, 'Боб');
  const C = await register(`+7911${stamp}03`, `callc${stamp}`, 'Кэрол');
  check(!!A.token && !!B.token, 'регистрация и JWT-сессии');

  const wsA = new WsClient(); const wsB = new WsClient(); const wsC = new WsClient();
  await Promise.all([wsA.connect(A.token), wsB.connect(B.token), wsC.connect(C.token)]);
  await wsA.wait(m => m.type === 'chats');
  await wsB.wait(m => m.type === 'chats');

  wsA.send({ type: 'start_chat', targetUserId: B.user.id });
  const created = await wsA.wait(m => m.type === 'chat_created' && m.members && m.members.length === 2);
  await wsB.wait(m => m.type === 'new_chat');
  check(!!created.chatId, 'личный чат создан');

  console.log('\n— Offer / ringing / answer / ICE / end —');
  wsA.clear(); wsB.clear();
  wsA.send({ type: 'call_offer', targetUserId: B.user.id, callId: 'call-1', callType: 'video', sdp: 'v=0 offer' });
  const ringing = await wsA.wait(m => m.type === 'call_ringing' && m.callId === 'call-1');
  const offer = await wsB.wait(m => m.type === 'call_offer' && m.callId === 'call-1');
  check(ringing && offer, 'offer доставлен, звонящий получил ringing');
  check(offer.fromUserId === A.user.id && String(offer.fromName).includes('Алиса') && offer.callType === 'video',
    'offer содержит отправителя, имя и тип video');

  wsB.send({ type: 'call_answer', targetUserId: A.user.id, callId: 'call-1', sdp: 'v=0 answer' });
  const answer = await wsA.wait(m => m.type === 'call_answer' && m.callId === 'call-1');
  check(!!answer && answer.sdp === 'v=0 answer', 'answer доставлен звонящему');

  wsA.send({ type: 'call_ice', targetUserId: B.user.id, callId: 'call-1', candidate: { candidate: 'candidate:1', sdpMid: '0' } });
  const ice = await wsB.wait(m => m.type === 'call_ice' && m.callId === 'call-1');
  check(!!ice && ice.candidate && ice.candidate.candidate === 'candidate:1', 'ICE-кандидат доставлен');

  wsB.send({ type: 'call_end', targetUserId: A.user.id, callId: 'call-1', reason: 'ended' });
  const end = await wsA.wait(m => m.type === 'call_end' && m.callId === 'call-1');
  check(!!end && end.reason === 'ended', 'call_end доставлен');

  console.log('\n— Ограничения доступа —');
  wsA.clear();
  wsA.send({ type: 'call_offer', targetUserId: C.user.id, callId: 'call-spam', callType: 'audio', sdp: 'v=0 spam' });
  const forbidden = await wsA.wait(m => m.type === 'error' || m.error);
  check(!!forbidden, 'звонок пользователю без личного чата отклонён');
  const spam = wsC.inbox.find(m => m.type === 'call_offer');
  check(!spam, 'посторонний не получил offer');

  wsA.send({ type: 'call_ice', targetUserId: B.user.id, callId: 'call-1', candidate: { candidate: 'late' } });
  const late = await wsA.wait(m => m.type === 'error' || m.error);
  check(!!late, 'сигналинг по завершённому callId отклонён');

  wsB.close();
  await new Promise(r => setTimeout(r, 200));
  wsA.clear();
  wsA.send({ type: 'call_offer', targetUserId: B.user.id, callId: 'call-offline', callType: 'audio', sdp: 'v=0 offline' });
  const unavailable = await wsA.wait(m => m.type === 'call_unavailable' && m.callId === 'call-offline');
  check(!!unavailable, 'офлайн-абонент: call_unavailable');

  console.log('\n— ICE-серверы (STUN/TURN) —');
  const iceRes = await request('GET', '/api/ice-servers', { token: A.token });
  const iceList = iceRes.json && iceRes.json.iceServers;
  check(iceRes.status === 200 && Array.isArray(iceList) && iceList.length > 0,
    '/api/ice-servers отдаёт список ICE-серверов');
  check(iceList && iceList.some(s => String(s.urls).includes('stun:')),
    'в списке есть STUN по умолчанию');
  check(iceRes.json && iceRes.json.turnAvailable === false,
    'без настройки TURN помечен как недоступный');
  const iceAnon = await request('GET', '/api/ice-servers');
  check(iceAnon.status === 401, 'без авторизации ICE-серверы не отдаются');

  // С TURN-сервером клиент получает одноразовые учётные данные (coturn REST API)
  const { execFileSync } = require('child_process');
  const path = require('path');
  const crypto = require('crypto');
  const root = path.resolve(__dirname, '..');
  const turnOut = execFileSync(process.execPath, ['-e', `
    process.env.TURN_URL = 'turn:turn.example.com:3478?transport=udp';
    process.env.TURN_SECRET = 'top-secret-turn';
    console.log(JSON.stringify(require(${JSON.stringify(path.join(root, 'src/services/iceService.js'))}).getIceServers()));
  `], { cwd: root, stdio: 'pipe' }).toString().trim().split('\n').pop();
  const turnServers = JSON.parse(turnOut);
  const turn = turnServers.find(s => String(s.urls).includes('turn:'));
  check(!!turn, 'TURN-сервер добавлен при TURN_URL + TURN_SECRET');
  check(!!turn && /^[0-9]+:[0-9a-f]{12}$/.test(turn.username),
    'username одноразовый: <expiry>:<random>');
  const expected = turn
    ? crypto.createHmac('sha1', 'top-secret-turn').update(turn.username).digest('base64')
    : '';
  check(!!turn && turn.credential === expected, 'credential = base64(HMAC-SHA1(secret, username))');
  check(!turnOut.includes('top-secret-turn'), 'секрет TURN не уходит клиенту');

  // Без секрета и без статических учётных данных TURN отключается
  const noCredOut = execFileSync(process.execPath, ['-e', `
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    delete process.env.TURN_SECRET;
    console.log(JSON.stringify(require(${JSON.stringify(path.join(root, 'src/services/iceService.js'))}).getIceServers()));
  `], { cwd: root, stdio: 'pipe' }).toString().trim().split('\n').pop();
  check(!noCredOut.includes('turn:'), 'без учётных данных TURN не добавляется');

  wsA.close(); wsC.close();
  server.close();
  app.wsService && app.wsService.stop();
  try { require('../src/db/database').getDatabase().flush(); } catch (e) {}
  setTimeout(() => {
    console.log(`\n=== ИТОГО: passed=${passed}, failed=${failed} ===`);
    process.exit(failed ? 1 : 0);
  }, 300);
}

main().catch(e => { console.error(e); process.exit(1); });
