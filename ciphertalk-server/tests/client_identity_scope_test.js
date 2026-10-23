/**
 * Тест клиентской привязки E2EE-идентичности к аккаунту.
 *
 * Проверяет логику public/app.js в Node-контексте (vm + заглушки браузера):
 * - приватный ключ привязан к аккаунту (второй аккаунт не наследует чужой);
 * - legacy-идентичность (без суффикса) наследует только первый аккаунт;
 * - сессии, групповые ключи и кэш расшифровок разделены по аккаунтам;
 * - смена аккаунта не оставляет чужие данные в localStorage.
 *
 * Запуск: node tests/client_identity_scope_test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const E2EE = require(path.join(ROOT, 'public/e2ee.js'));

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}

// ==================== Заглушки браузера ====================
class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
}

function fakeElement() {
  const el = {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [],
    innerHTML: '',
    textContent: '',
    value: '',
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    getAttribute() { return null; },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    click() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    getContext() {
      return {
        fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
        moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {},
        translate() {}, rotate() {}, scale() {}, setTransform() {},
        fillText() {}, measureText() { return { width: 0 }; },
        createLinearGradient() { return { addColorStop() {} }; },
        canvas: { width: 0, height: 0 }
      };
    },
    width: 0,
    height: 0,
    scrollIntoView() {}
  };
  return el;
}

function createBrowser() {
  const storage = new FakeStorage();
  const elements = new Map();

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement() { return fakeElement(); },
    createTextNode() { return {}; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    body: fakeElement(),
    documentElement: {
      ...fakeElement(),
      style: {
        _props: {},
        setProperty(k, v) { this._props[k] = v; },
        removeProperty(k) { delete this._props[k]; },
        getPropertyValue(k) { return this._props[k] || ''; }
      }
    },
    cookie: '',
    title: 'CipherTalk'
  };

  const window = {
    _listeners: {},
    CipherTalkE2EE: E2EE,
    I18N: {
      t: (k) => k,
      lang: 'ru',
      applyI18n() {},
      setLang() {},
      getLang() { return 'ru'; },
      set() {},
      on() {}
    },
    crypto: webcrypto,
    localStorage: storage,
    document,
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', pathname: '/' },
    navigator: {
      userAgent: 'node-test',
      language: 'ru',
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
      serviceWorker: { register: async () => ({}) },
      onLine: true
    },
    addEventListener(type, fn) {
      (window._listeners[type] = window._listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Notification: function () { return {}; },
    fetch: async (url, opts) => {
      window._fetchCalls.push(String(url));
      if (String(url).includes('/api/me')) {
        return {
          ok: true, status: 200,
          json: async () => ({ user: window._meUser || null })
        };
      }
      return { ok: false, status: 0, json: async () => ({}) };
    },
    WebSocket: function () { this.close = () => {}; this.send = () => {}; },
    confirm: () => true,
    alert: () => {},
    prompt: () => null
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;

  window._fetchCalls = [];
  window._meUser = null;
  window.dispatchEvent = (type, event) => {
    const handlers = window._listeners[type] || [];
    for (const h of handlers) {
      try {
        const r = h(event || { type });
        if (r && typeof r.catch === 'function') r.catch(e => {
          if (process.env.DEBUG_UI) console.error('[ui]', e && e.message);
        });
      } catch (e) { /* тест не должен падать из-за UI */ }
    }
  };
  const ctx = vm.createContext(window);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  return { ctx, storage, document, window };
}

// Загружаем клиентский скрипт в подготовленном контексте.
// seed вызывается до загрузки скрипта — чтобы localStorage уже был заполнен.
function loadApp(seed) {
  const env = createBrowser();
  if (typeof seed === 'function') seed(env.storage, env.window);
  const code = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  vm.runInContext(code, env.ctx, { filename: 'public/app.js' });
  return env;
}

async function main() {
  console.log('\n— Привязка идентичности к аккаунту —');
  const env = loadApp();
  const { ctx, storage } = env;

  // Аккаунт 1 входит: появляется собственная пара ключей
  vm.runInContext('currentUser = { id: 1, username: "alice" };', ctx);
  const id1 = await vm.runInContext('ensureIdentityForUser(1)', ctx);
  check(!!id1 && !!id1.privateKey, 'для аккаунта 1 создана E2EE-идентичность');
  check(storage.getItem('ciphertalk_identity_u1') !== null, 'ключ сохранён в scope аккаунта 1');
  check(storage.getItem('ciphertalk_identity_owner') === '1', 'владелец идентичности записан');
  const key1 = storage.getItem('ciphertalk_identity_u1');

  // Аккаунт 2 входит: у него своя пара ключей
  vm.runInContext('currentUser = { id: 2, username: "bob" };', ctx);
  const id2 = await vm.runInContext('ensureIdentityForUser(2)', ctx);
  check(!!id2 && id2.privateKey !== id1.privateKey,
    'у второго аккаунта другой приватный ключ');
  check(storage.getItem('ciphertalk_identity_u2') !== null, 'ключ аккаунта 2 в отдельном scope');
  check(storage.getItem('ciphertalk_identity_u1') === key1, 'ключ аккаунта 1 не перезаписан');

  // Возврат к аккаунту 1: тот же ключ
  vm.runInContext('currentUser = { id: 1, username: "alice" };', ctx);
  const id1again = await vm.runInContext('ensureIdentityForUser(1)', ctx);
  check(id1again.privateKey === id1.privateKey, 'ключ аккаунта 1 восстанавливается при возврате');

  console.log('\n— Разделение сессий, групповых ключей и кэша —');
  vm.runInContext('currentUser = { id: 1 };', ctx);
  vm.runInContext(
    'localStorage.setItem("ciphertalk_sessions_u1", JSON.stringify({ 5: { a: 1 } }));' +
    'localStorage.setItem("ciphertalk_plaintexts_u1", JSON.stringify({ 5: ["текст"] }));' +
    'localStorage.setItem("ciphertalk_group_keys_u1", JSON.stringify({ 7: { version: 1 } }));',
    ctx
  );
  vm.runInContext('currentUser = { id: 2 };', ctx);
  const sessions2 = vm.runInContext('loadSessionMap()', ctx);
  const groups2 = vm.runInContext('loadGroupKeyBlobs()', ctx);
  check(Object.keys(sessions2).length === 0, 'сессии аккаунта 1 не видны аккаунту 2');
  check(Object.keys(groups2).length === 0, 'групповые ключи аккаунта 1 не видны аккаунту 2');

  vm.runInContext('currentUser = { id: 1 };', ctx);
  const sessions1 = vm.runInContext('loadSessionMap()', ctx);
  check(Object.keys(sessions1).length === 1, 'аккаунт 1 видит свои сессии');

  console.log('\n— Наследование legacy-идентичности —');
  const env2 = loadApp();
  const { ctx: ctx2, storage: storage2 } = env2;
  storage2.setItem('ciphertalk_identity', JSON.stringify({ publicKey: 'PUB-legacy', privateKey: 'PRIV-legacy' }));
  vm.runInContext('currentUser = { id: 7 };', ctx2);
  const adopted = await vm.runInContext('ensureIdentityForUser(7)', ctx2);
  check(adopted.privateKey === 'PRIV-legacy', 'первый аккаунт наследует legacy-ключ');
  check(storage2.getItem('ciphertalk_identity_u7') !== null, 'legacy-ключ перенесён в scope аккаунта');

  // Второй аккаунт legacy-ключ не наследует
  const env3 = loadApp();
  const { ctx: ctx3, storage: storage3 } = env3;
  storage3.setItem('ciphertalk_identity', JSON.stringify({ publicKey: 'PUB-legacy', privateKey: 'PRIV-legacy' }));
  storage3.setItem('ciphertalk_identity_owner', '7');
  vm.runInContext('currentUser = { id: 8 };', ctx3);
  const notAdopted = await vm.runInContext('ensureIdentityForUser(8)', ctx3);
  check(notAdopted.privateKey !== 'PRIV-legacy', 'чужой legacy-ключ не наследуется другим аккаунтом');

  console.log('\n— Сброс сессии —');
  vm.runInContext('currentUser = { id: 1 };', ctx);
  await vm.runInContext('clearSession()', ctx);
  check(storage.getItem('ciphertalk_token') === null, 'токен удалён');
  check(storage.getItem('ciphertalk_plaintexts_u1') === null, 'кэш расшифровок аккаунта удалён');
  // Ключи намеренно сохраняются: иначе история перестанет расшифровываться.
  check(storage.getItem('ciphertalk_identity_u1') !== null, 'ключ аккаунта сохранён для расшифровки истории');

  console.log('\n— Перезагрузка страницы: личность привязана к аккаунту —');
  const env4 = loadApp((storage, win) => {
    // Ключ другого аккаунта лежит рядом — перезагрузка не должна его взять
    storage.setItem('ciphertalk_identity_u42', JSON.stringify({ publicKey: 'PUB42', privateKey: 'PRIV42' }));
    storage.setItem('ciphertalk_token', 'token-42');
    storage.setItem('ciphertalk_user', JSON.stringify({ id: 42, username: 'carol' }));
    win._meUser = { id: 42, username: 'carol', name: 'Carol' };
  });
  const { ctx: ctx4, storage: storage4, window: win4 } = env4;
  win4.dispatchEvent('load');
  await new Promise(r => setTimeout(r, 300));
  check(win4._fetchCalls.some(u => u.includes('/api/me')), 'при перезагрузке проверяется сессия через /api/me');
  check(storage4.getItem('ciphertalk_identity_u42') !== null &&
    storage4.getItem('ciphertalk_identity_u42').includes('PRIV42'),
    'использован ключ своего аккаунта (u42), а не чужой scope');
  check(storage4.getItem('ciphertalk_identity_owner') === '42', 'владелец идентичности обновлён');

  console.log('\n— Внешний вид и типографика привязаны к аккаунту —');
  const env5 = loadApp();
  const { ctx: ctx5, storage: storage5 } = env5;
  vm.runInContext('currentUser = { id: 1 };', ctx5);
  vm.runInContext('loadAppearance()', ctx5);
  vm.runInContext('setFontFamily("serif")', ctx5);
  vm.runInContext('setFontSize(18)', ctx5);
  vm.runInContext('setFontWeight("600")', ctx5);
  vm.runInContext('setLineHeight(1.6)', ctx5);
  vm.runInContext('setFontScope("messages")', ctx5);

  check(storage5.getItem('ciphertalk_appearance_u1') !== null,
    'настройки внешнего вида сохраняются в scope аккаунта');
  const savedA = JSON.parse(storage5.getItem('ciphertalk_appearance_u1') || '{}');
  check(savedA.fontFamily === 'serif' && savedA.msgFontSize === 18 &&
    savedA.msgFontWeight === '600' && savedA.msgLineHeight === 1.6 &&
    savedA.fontScope === 'messages',
    'сохранены шрифт, размер, начертание, интерлиньяж и область применения');

  const props5 = env5.document.documentElement.style._props;
  check(typeof props5['--msg-font-family'] === 'string' && props5['--msg-font-family'].length > 0,
    'CSS-переменная шрифта сообщений выставлена');
  check(props5['--msg-font-weight'] === '600', 'CSS-переменная начертания выставлена');
  check(props5['--msg-line-height'] === '1.6', 'CSS-переменная интерлиньяжа выставлена');
  check(String(props5['--font-family']).includes('-apple-system'),
    'в режиме «только сообщения» интерфейс остаётся на системном шрифте');

  // Второй аккаунт не наследует настройки первого
  vm.runInContext('currentUser = { id: 2 };', ctx5);
  vm.runInContext('loadAppearance()', ctx5);
  check(vm.runInContext('appearance.fontFamily', ctx5) !== 'serif',
    'настройки аккаунта 1 не применяются к аккаунту 2');
  check(storage5.getItem('ciphertalk_appearance_u1') !== null &&
    JSON.parse(storage5.getItem('ciphertalk_appearance_u1')).fontFamily === 'serif',
    'настройки аккаунта 1 не перезаписаны настройками аккаунта 2');

  console.log('\n— Настройки переживают перезагрузку страницы —');
  const env9 = loadApp((storage) => {
    storage.setItem('ciphertalk_appearance_u1', storage5.getItem('ciphertalk_appearance_u1'));
  });
  const { ctx: ctx9 } = env9;
  vm.runInContext('currentUser = { id: 1 };', ctx9);
  vm.runInContext('loadAppearance()', ctx9);
  check(vm.runInContext('appearance.fontFamily', ctx9) === 'serif', 'шрифт восстановлен после перезагрузки');
  check(vm.runInContext('appearance.msgFontSize', ctx9) === 18, 'размер шрифта восстановлен');
  check(vm.runInContext('appearance.msgLineHeight', ctx9) === 1.6, 'интерлиньяж восстановлен');
  check(vm.runInContext('appearance.fontScope', ctx9) === 'messages', 'область применения восстановлена');

  console.log('\n— Сброс типографики —');
  vm.runInContext('currentUser = { id: 1 };', ctx5);
  vm.runInContext('loadAppearance()', ctx5);
  vm.runInContext('resetTypography()', ctx5);
  check(vm.runInContext('appearance.fontFamily', ctx5) === 'system', 'шрифт сброшен на системный');
  check(vm.runInContext('appearance.msgFontSize', ctx5) === 14, 'размер шрифта сброшен');
  check(vm.runInContext('appearance.msgLineHeight', ctx5) === 1.45, 'интерлиньяж сброшен');
  check(vm.runInContext('appearance.fontScope', ctx5) === 'app', 'область применения сброшена');

  console.log('\n— Пользовательский шрифт очищается от опасных символов —');
  const dirty = vm.runInContext(
    'sanitizeFontStack("Georgia; } body { display:none !important; color:red")', ctx5);
  check(!/[{};:()<>]/.test(dirty), 'из пользовательского шрифта убраны спецсимволы');
  check(vm.runInContext('sanitizeFontStack("")', ctx5) === '', 'пустой шрифт остаётся пустым');
  const customStack = vm.runInContext(
    '(function(){ appearance.fontFamily = "custom"; appearance.fontCustom = "Arial; } body{background:red}"; return resolveFontStack(); })()',
    ctx5);
  check(!/[{};]/.test(customStack), 'пользовательский стек не содержит управляющих символов');
  check(/Arial/.test(customStack), 'пользовательский стек сохраняет имя шрифта');

  console.log('\n— Перенос общих настроек в первый аккаунт —');
  const env6 = loadApp((storage) => {
    storage.setItem('ciphertalk_appearance', JSON.stringify({ fontFamily: 'mono', msgFontSize: 20 }));
  });
  const { ctx: ctx6, storage: storage6 } = env6;
  vm.runInContext('currentUser = { id: 3 };', ctx6);
  vm.runInContext('loadAppearance()', ctx6);
  check(vm.runInContext('appearance.fontFamily', ctx6) === 'mono',
    'общие настройки устройства переносятся в первый аккаунт');
  check(storage6.getItem('ciphertalk_appearance_u3') !== null,
    'перенесённые настройки сохранены в scope аккаунта');

  console.log('\n— Битые настройки в localStorage не ломают интерфейс —');
  const env7 = loadApp((storage) => {
    storage.setItem('ciphertalk_appearance_u9', JSON.stringify({
      fontFamily: '<script>', msgFontSize: 999, theme: 'нет-такой-темы',
      glass: 'yes', msgLineHeight: 'много', unknownKey: 1
    }));
  });
  const { ctx: ctx7 } = env7;
  vm.runInContext('currentUser = { id: 9 };', ctx7);
  vm.runInContext('loadAppearance()', ctx7);
  check(vm.runInContext('appearance.fontFamily', ctx7) === 'system', 'неизвестный шрифт отброшен');
  check(vm.runInContext('appearance.msgFontSize', ctx7) === 24, 'размер шрифта ограничен диапазоном');
  check(vm.runInContext('appearance.theme', ctx7) === 'dark', 'неизвестная тема отброшена');
  check(vm.runInContext('appearance.glass', ctx7) === true, 'некорректный boolean отброшен');
  check(vm.runInContext('appearance.msgLineHeight', ctx7) === 1.45, 'некорректный интерлиньяж отброшен');
  check(vm.runInContext('appearance.unknownKey === undefined', ctx7) === true,
    'неизвестные ключи не попадают в настройки');

  console.log('\n— Настройки: разметка типографики —');
  const env8 = loadApp();
  const { ctx: ctx8 } = env8;
  vm.runInContext('currentUser = { id: 1 };', ctx8);
  vm.runInContext('loadAppearance()', ctx8);
  vm.runInContext('openSettings()', ctx8);
  const html8 = vm.runInContext('document.getElementById("modal-content").innerHTML', ctx8) || '';
  check((html8.match(/data-action="setFontFamily"/g) || []).length === 8, 'доступны 8 вариантов шрифта');
  check(html8.includes('data-action="setCustomFont"'), 'есть поле своего шрифта');
  check(html8.includes('data-action="setFontWeight"'), 'есть выбор начертания');
  check(html8.includes('data-action="setLineHeight"'), 'есть настройка интерлиньяжа');
  check(html8.includes('data-action="setFontScope"'), 'есть выбор области применения');
  check(html8.includes('id="font-preview"'), 'есть предпросмотр шрифта');
  check(html8.includes('data-action="resetTypography"'), 'есть сброс типографики');

  console.log(`\n=== ИТОГО: passed=${passed}, failed=${failed} ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
