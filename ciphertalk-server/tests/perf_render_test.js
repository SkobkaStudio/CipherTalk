/**
 * Тест производительности рендера и motion-системы.
 *
 * Проверяет:
 * - инкрементальность списка сообщений (DOM-узлы переиспользуются);
 * - точечное обновление изменённого сообщения (остальные узлы не трогаются);
 * - ограничение окна сообщений (MSG_WINDOW);
 * - инкрементальность списка чатов + перестановка узлов без пересборки;
 * - кэш превью (повторная расшифровка не выполняется);
 * - серверную пагинацию истории (beforeId / hasMore);
 * - motion-систему (ripple, stagger, prefers-reduced-motion).
 *
 * Запуск: node tests/perf_render_test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}

// ==================== Мини-DOM ====================
class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => x && this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  toggle(c, force) {
    if (force === undefined) { if (this.set.has(c)) this.set.delete(c); else this.set.add(c); }
    else if (force) this.set.add(c); else this.set.delete(c);
    return this.set.has(c);
  }
  contains(c) { return this.set.has(c); }
  toString() { return Array.from(this.set).join(' '); }
}

function parseSelector(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([.#]?[\w-]+|\[[^\]]+\])/g;
  let m;
  while ((m = re.exec(sel))) {
    const part = m[1];
    if (part.startsWith('#')) out.id = part.slice(1);
    else if (part.startsWith('.')) out.classes.push(part.slice(1));
    else if (part.startsWith('[')) {
      const inner = part.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq < 0) out.attrs.push([inner, null]);
      else out.attrs.push([inner.slice(0, eq).trim(), inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '')]);
    } else out.tag = part.toUpperCase();
  }
  return out;
}

function matches(el, sel) {
  const p = parseSelector(sel);
  if (p.tag && el.tagName !== p.tag) return false;
  if (p.id && el.getAttribute('id') !== p.id) return false;
  for (const c of p.classes) if (!el.classList.contains(c)) return false;
  for (const [attr, val] of p.attrs) {
    const actual = el.getAttribute(attr);
    if (val === null) { if (actual === null) return false; }
    else if (String(actual) !== val) return false;
  }
  return true;
}

function walk(node, fn) {
  for (const c of node.children) { fn(c); walk(c, fn); }
}

class FakeNode {
  constructor(tag = 'div', doc) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = doc || null;
    this.attributes = {};
    this.dataset = {};
    this._text = '';
    this._html = '';
    this.style = {
      _props: {},
      setProperty(k, v) { this._props[k] = String(v); },
      removeProperty(k) { delete this._props[k]; },
      getPropertyValue(k) { return this._props[k] === undefined ? '' : this._props[k]; }
    };
    this.classList = new FakeClassList(this);
    this.className = '';
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 600;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = v;
    if (v === '' || v === undefined || v === null) {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
    }
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get className() { return this.classList.toString(); }
  set className(v) {
    this.classList.set = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }
  appendChild(child) {
    // Фрагмент растворяется в родителе, как в настоящем DOM
    if (child.tagName === '#FRAGMENT') {
      const kids = child.children.slice();
      child.children = [];
      for (const k of kids) this.appendChild(k);
      return child;
    }
    if (child.parentNode) {
      const i = child.parentNode.children.indexOf(child);
      if (i >= 0) child.parentNode.children.splice(i, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(node) {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      this.parentNode.children[i] = node;
      node.parentNode = this.parentNode;
      this.parentNode = null;
    }
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k.startsWith('data-')) {
      this.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = String(v);
    }
  }
  getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; }
  hasAttribute(k) { return this.attributes[k] !== undefined; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 120, height: 40 }; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    walk(this, el => { if (matches(el, sel)) out.push(el); });
    return out;
  }
  addEventListener() {}
  removeEventListener() {}
  scrollIntoView() {}
  focus() {}
  click() {}
  closest() { return null; }
  getContext() {
    return {
      fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {},
      stroke() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {},
      fillText() {}, measureText() { return { width: 0 }; },
      createLinearGradient() { return { addColorStop() {} }; }, canvas: { width: 0, height: 0 }
    };
  }
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
}

function createBrowser(opts = {}) {
  const storage = new FakeStorage();
  const byId = new Map();
  const all = [];

  const document = {
    getElementById(id) {
      if (!byId.has(id)) {
        const el = new FakeNode('div', document);
        el.setAttribute('id', id);
        byId.set(id, el);
        all.push(el);
      }
      return byId.get(id);
    },
    createElement(tag) {
      const el = new FakeNode(tag, document);
      all.push(el);
      return el;
    },
    createDocumentFragment() {
      const el = new FakeNode('#fragment', document);
      all.push(el);
      return el;
    },
    createTextNode() { return {}; },
    querySelector(sel) {
      for (const el of all) if (matches(el, sel)) return el;
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      for (const el of all) if (matches(el, sel)) out.push(el);
      return out;
    },
    addEventListener() {},
    removeEventListener() {},
    body: null,
    documentElement: null,
    cookie: '',
    title: 'CipherTalk',
    readyState: 'complete'
  };
  document.body = new FakeNode('body', document);
  document.documentElement = new FakeNode('html', document);
  document.documentElement.style = {
    _props: {},
    setProperty(k, v) { this._props[k] = v; },
    removeProperty(k) { delete this._props[k]; },
    getPropertyValue(k) { return this._props[k] || ''; }
  };
  document.body.parentNode = document.documentElement;

  const window = {
    _listeners: {},
    I18N: { t: (k) => k, lang: 'ru', applyI18n() {}, setLang() {}, getLang: () => 'ru', set() {}, on() {} },
    localStorage: storage,
    document,
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', pathname: '/' },
    navigator: { userAgent: 'node-test', language: 'ru', mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) }, serviceWorker: { register: async () => ({}) }, onLine: true },
    addEventListener(type, fn) { (window._listeners[type] = window._listeners[type] || []).push(fn); },
    removeEventListener() {},
    matchMedia: (q) => ({
      matches: !!(opts.reduced && /reduce/.test(q)),
      addEventListener() {}, removeEventListener() {}
    }),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    requestIdleCallback: (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 8 }), 0),
    MutationObserver: undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    WebSocket: function () { this.close = () => {}; this.send = () => {}; },
    confirm: () => true, alert: () => {}, prompt: () => null,
    Notification: function () { return {}; },
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.dispatchEvent = (type, event) => {
    for (const h of window._listeners[type] || []) {
      try { const r = h(event || { type }); if (r && r.catch) r.catch(() => {}); } catch (e) { /* ignore */ }
    }
  };
  const ctx = vm.createContext(window);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  return { ctx, storage, document, window, byId, all };
}

function loadApp(opts = {}) {
  const env = createBrowser(opts);
  const code = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  vm.runInContext(code, env.ctx, { filename: 'public/app.js' });
  return env;
}

// ==================== Тесты ====================
async function main() {
  console.log('\n— Инкрементальный рендер сообщений —');
  const env = loadApp();
  const { ctx, document } = env;

  // Заглушки: сборка сообщения не требует криптографии
  vm.runInContext(`
    window.__built = 0;
    window.__decrypts = 0;
    buildMessageElement = async function (msg, chat, key, animate) {
      window.__built++;
      const el = document.createElement('div');
      el.className = 'message';
      el.setAttribute('data-msg-id', String(msg.id));
      el.dataset.msgId = String(msg.id);
      return el;
    };
    getChatKey = async function () { return { kind: 'test' }; };
    decryptChatText = async function () { window.__decrypts++; return 'текст'; };
  `, ctx);

  const chatId = 42;
  vm.runInContext(`
    currentUser = { id: 1, username: 'alice' };
    chats = [{ id: ${chatId}, type: 'private', members: [{ id: 1 }, { id: 2 }], last_read_by: {} }];
    messages[${chatId}] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1, chat_id: ${chatId}, sender_id: 2, encrypted_content: 'c' + i, iv: 'iv' + i,
      header: 'h', type: 'text', created_at: Date.now() - (30 - i) * 60000
    }));
    currentChatId = ${chatId};
  `, ctx);

  const container = document.getElementById('messages-container');
  const msgNodes = (el) => el.children.filter(n => n.classList.contains('message'));
  await vm.runInContext('renderMessages(' + chatId + ')', ctx);

  const firstNodes = msgNodes(container);
  const builtFirst = await vm.runInContext('window.__built', ctx);
  check(firstNodes.length === 30, 'отрисованы все сообщения окна');
  check(builtFirst === 30, 'каждое сообщение собрано один раз');

  // Повторный рендер без изменений — узлы должны остаться теми же
  await vm.runInContext('renderMessages(' + chatId + ')', ctx);
  const secondNodes = msgNodes(container);
  check(secondNodes.length === 30, 'количество узлов не изменилось при повторном рендере');
  check(firstNodes.every((n, i) => n === secondNodes[i]), 'DOM-узлы переиспользованы, а не пересозданы');
  const builtSecond = await vm.runInContext('window.__built', ctx);
  check(builtSecond === 30, 'повторный рендер не пересобирает сообщения');

  // Изменили одно сообщение — пересобраться должно только оно
  vm.runInContext(`messages[${chatId}][5].encrypted_content = 'changed';`, ctx);
  await vm.runInContext('renderMessages(' + chatId + ')', ctx);
  const thirdNodes = msgNodes(container);
  const rebuilt = await vm.runInContext('window.__built', ctx);
  check(rebuilt === 31, 'изменённое сообщение пересобрано ровно один раз');
  check(thirdNodes[0] === firstNodes[0] && thirdNodes[1] === firstNodes[1],
    'остальные узлы остались нетронутыми');
  check(thirdNodes[5] !== firstNodes[5], 'узел изменённого сообщения заменён');

  console.log('\n— Окно сообщений ограничено —');
  vm.runInContext(`
    messages[${chatId}] = Array.from({ length: 400 }, (_, i) => ({
      id: i + 1, chat_id: ${chatId}, sender_id: 2, encrypted_content: 'x' + i, iv: 'i' + i,
      header: 'h', type: 'text', created_at: Date.now() - (400 - i) * 60000
    }));
  `, ctx);
  await vm.runInContext('renderMessages(' + chatId + ')', ctx);
  const windowNodes = msgNodes(container);
  check(windowNodes.length === 150, 'в DOM держится не более 150 сообщений');
  check(windowNodes[0].getAttribute('data-msg-id') === '251', 'в окне оставлены последние сообщения');

  console.log('\n— Инкрементальный список чатов —');
  const env2 = loadApp();
  const { ctx: ctx2, document: doc2 } = env2;
  vm.runInContext(`
    currentUser = { id: 1, username: 'alice' };
    chats = [
      { id: 10, type: 'private', members: [{ id: 1 }, { id: 2 }], last_message: 'AAA', last_message_iv: 'iv1', last_message_header: 'h1', last_message_type: 'text' },
      { id: 11, type: 'private', members: [{ id: 1 }, { id: 3 }], last_message: 'BBB', last_message_iv: 'iv2', last_message_header: 'h2', last_message_type: 'text' }
    ];
    window.__htmlSets = 0;
    window.__decryptCalls = 0;
    getChatKey = async function () { return { kind: 'test' }; };
    decryptChatText = async function () { window.__decryptCalls++; return 'превью'; };
  `, ctx2);

  const listEl = doc2.getElementById('chat-list');
  // Считаем пересборки innerHTML
  const desc = Object.getOwnPropertyDescriptor(FakeNode.prototype, 'innerHTML');
  let htmlSets = 0;
  Object.defineProperty(listEl, 'innerHTML', {
    get() { return desc.get.call(this); },
    set(v) { if (v !== '') htmlSets++; desc.set.call(this, v); }
  });

  vm.runInContext('renderChatList()', ctx2);
  const chatNodes = listEl.children.slice();
  check(chatNodes.length === 2, 'список чатов отрисован');
  const htmlSetsAfterFirst = htmlSets;

  vm.runInContext('renderChatList()', ctx2);
  check(htmlSets === htmlSetsAfterFirst, 'повторный рендер списка не пересобирает HTML');
  check(listEl.children[0] === chatNodes[0] && listEl.children[1] === chatNodes[1],
    'узлы списка чатов переиспользованы');

  // Перестановка чатов (новое сообщение поднимает чат вверх)
  vm.runInContext('chats = [chats[1], chats[0]];', ctx2);
  vm.runInContext('renderChatList()', ctx2);
  check(htmlSets === htmlSetsAfterFirst, 'перестановка чатов не пересобирает HTML заново');
  check(listEl.children[0] === chatNodes[1] && listEl.children[1] === chatNodes[0],
    'готовые узлы переставлены на новые позиции');

  console.log('\n— Кэш превью —');
  await new Promise(r => setTimeout(r, 60));
  const decryptsAfterFirst = await vm.runInContext('window.__decryptCalls', ctx2);
  vm.runInContext('renderChatList()', ctx2);
  await new Promise(r => setTimeout(r, 60));
  const decryptsAfterSecond = await vm.runInContext('window.__decryptCalls', ctx2);
  check(decryptsAfterFirst === 2, 'превью расшифрованы по одному разу на чат');
  check(decryptsAfterSecond === decryptsAfterFirst, 'повторный рендер не расшифровывает превью заново');

  console.log('\n— Серверная пагинация истории —');
  const WebSocketService = require(path.join(ROOT, 'src/services/websocketService.js'));
  const sent = [];
  const fakeDb = {
    messages: Array.from({ length: 120 }, (_, i) => ({
      id: i + 1, chat_id: 5, sender_id: 2, encrypted_content: 'c' + i, iv: 'iv', header: 'h',
      type: 'text', created_at: new Date().toISOString(), deleted_for_all: 0
    })),
    isChatMember: () => true,
    getChatClearedAt: () => 0,
    findUserById: () => ({ id: 2, username: 'bob' })
  };
  const svc = Object.create(WebSocketService.prototype);
  svc.db = fakeDb;
  svc.send = (ws, payload) => { sent.push(payload); return true; };
  const wsStub = { readyState: 1, userId: 2 };

  svc.handleGetMessages(wsStub, { chatId: 5, limit: 50 });
  const page1 = sent.pop();
  check(page1.messages.length === 50, 'первая страница — 50 сообщений');
  check(page1.hasMore === true, 'сервер сообщает, что есть более старые сообщения');
  check(page1.beforeId === 71, 'beforeId указывает на первое сообщение страницы');
  check(page1.older === false, 'первая страница не помечена как «старые»');

  svc.handleGetMessages(wsStub, { chatId: 5, limit: 50, beforeId: page1.beforeId });
  const page2 = sent.pop();
  check(page2.messages.length === 50, 'вторая страница — 50 сообщений');
  check(page2.older === true, 'страница помечена как «старые сообщения»');
  check(page2.messages[0].id === 21, 'вторая страница содержит сообщения до beforeId');
  check(page2.hasMore === true, 'история не закончилась');

  svc.handleGetMessages(wsStub, { chatId: 5, limit: 200, beforeId: 21 });
  const page3 = sent.pop();
  check(page3.messages.length === 20, 'последняя страница содержит остаток истории');
  check(page3.hasMore === false, 'история полностью загружена');

  console.log('\n— Motion-система —');
  const env3 = createBrowser();
  const motionCode = fs.readFileSync(path.join(ROOT, 'public/motion.js'), 'utf8');
  vm.runInContext(motionCode, env3.ctx, { filename: 'public/motion.js' });
  check(typeof env3.window.Motion === 'object', 'движок Motion загрузился');
  check(env3.window.Motion.enabled === true, 'анимации включены по умолчанию');
  env3.window.Motion.init();
  check(env3.window.Motion.level === 'normal', 'уровень анимаций читается из data-anim');

  // Ripple
  const btn = env3.document.createElement('button');
  env3.document.documentElement.appendChild(btn);
  env3.window.Motion.ripple(btn, { clientX: 10, clientY: 10 });
  check(btn.children.length === 1 && btn.children[0].classList.contains('mq-ripple'),
    'ripple создаёт анимационный элемент');

  // Stagger
  const list = env3.document.createElement('div');
  for (let i = 0; i < 5; i++) list.appendChild(env3.document.createElement('div'));
  env3.window.Motion.stagger(list);
  check(list.children[3].style.getPropertyValue('--mq-i') === '3', 'stagger проставляет задержку индекса');
  check(list.classList.contains('mq-stagger'), 'stagger вешает класс на контейнер');

  // prefers-reduced-motion
  const env4 = createBrowser({ reduced: true });
  vm.runInContext(motionCode, env4.ctx, { filename: 'public/motion.js' });
  check(env4.window.Motion.reduced === true, 'учитывается prefers-reduced-motion');
  check(env4.window.Motion.enabled === false, 'при reduced-motion анимации отключаются');

  // Уровень off
  const env5 = createBrowser();
  vm.runInContext(motionCode, env5.ctx, { filename: 'public/motion.js' });
  env5.document.documentElement.setAttribute('data-anim', 'off');
  env5.window.Motion.syncLevel();
  check(env5.window.Motion.enabled === false, 'уровень anim=off отключает анимации');

  console.log(`\n=== ИТОГО: passed=${passed}, failed=${failed} ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
