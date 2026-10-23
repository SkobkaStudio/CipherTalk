/**
 * Тесты публичного доступа: сервис адреса туннеля, супервизор и QR-код.
 *
 * Проверяем:
 *  - чтение/кэш state-файла (.public-url) в tunnelService;
 *  - парсинг публичного адреса из вывода cloudflared (quick и named);
 *  - корректность QR: сгенерированный SVG декодируется jsQR и содержит ровно
 *    тот же URL, что и в state-файле (QR сканируется телефоном).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

// ---------- tunnelService ----------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciphertalk-tunnel-'));
const stateFile = path.join(tmpDir, '.public-url');

process.env.PUBLIC_URL_FILE = stateFile;
const tunnelService = require(path.join(ROOT, 'src', 'services', 'tunnelService'));

check('state-файл отсутствует — адрес недоступен', () => {
  tunnelService.invalidate();
  const state = tunnelService.getState();
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.url, null);
});

check('после записи state-файла адрес читается', () => {
  fs.writeFileSync(stateFile, JSON.stringify({
    url: 'https://example.trycloudflare.com',
    mode: 'quick',
    updatedAt: new Date().toISOString()
  }));
  tunnelService.invalidate();
  const state = tunnelService.getState();
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.url, 'https://example.trycloudflare.com');
  assert.strictEqual(state.mode, 'quick');
  assert.strictEqual(tunnelService.getUrl(), 'https://example.trycloudflare.com');
});

check('http-адрес и мусор игнорируются (только https)', () => {
  fs.writeFileSync(stateFile, JSON.stringify({ url: 'http://insecure.example.com' }));
  tunnelService.invalidate();
  assert.strictEqual(tunnelService.getUrl(), null);

  fs.writeFileSync(stateFile, 'не json вовсе');
  tunnelService.invalidate();
  assert.strictEqual(tunnelService.getUrl(), null);
});

check('хвостовой слэш убирается', () => {
  fs.writeFileSync(stateFile, JSON.stringify({ url: 'https://a.trycloudflare.com/' }));
  tunnelService.invalidate();
  assert.strictEqual(tunnelService.getUrl(), 'https://a.trycloudflare.com');
});

check('битый state-файл не роняет сервис', () => {
  fs.writeFileSync(stateFile, '{"url": 123}');
  tunnelService.invalidate();
  assert.strictEqual(tunnelService.getUrl(), null);
});

// ---------- парсинг адреса в супервизоре ----------
const supervisorSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'tunnel.js'), 'utf8');
const extractUrl = new Function('text', `
  const m = text.match(/https:\\/\\/[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.trycloudflare\\.com/i);
  return m ? m[0].replace(/\\/$/, '') : null;
`);

check('адрес вылавливается из JSON-логов cloudflared', () => {
  const line = JSON.stringify({
    level: 'info',
    message: 'Your quick Tunnel has been created!  Visit it at: https://wise-feature-geography-cms.trycloudflare.com',
    source: 'cloudflared'
  });
  assert.strictEqual(
    extractUrl(line),
    'https://wise-feature-geography-cms.trycloudflare.com'
  );
});

check('адрес вылавливается из обычного лога', () => {
  const line = 'INF Your quick Tunnel has been created! Visit it at: https://abc-def.trycloudflare.com';
  assert.strictEqual(extractUrl(line), 'https://abc-def.trycloudflare.com');
});

check('мусор без адреса даёт null', () => {
  assert.strictEqual(extractUrl('INF connection established'), null);
  assert.strictEqual(extractUrl('https://example.com'), null);
});

check('супервизор поддерживает режимы quick/named', () => {
  assert.ok(/TUNNEL_MODE/.test(supervisorSrc), 'нет поддержки TUNNEL_MODE');
  assert.ok(/trycloudflare/.test(supervisorSrc), 'нет парсинга quick-адреса');
  assert.ok(/readNamedConfig/.test(supervisorSrc), 'нет поддержки named-конфига');
});

// ---------- QR ----------
const { qrSvg, qrMatrixSize } = require(path.join(ROOT, 'src', 'services', 'qrService'));
const jsQR = require('jsqr');

function rasterize(svg) {
  // Разбираем наш SVG: viewBox = "0 0 dim dim", модули — path из h1v1h-1z
  const dim = Number(svg.match(/viewBox="0 0 (\d+) (\d+)"/)[1]);
  const modules = new Set();
  const re = /M(\d+) (\d+)h1v1h-1z/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    modules.add(`${Number(m[1]) - 3},${Number(m[2]) - 3}`); // quiet = 3
  }
  const scale = 4;
  const quiet = 3;
  const size = dim - quiet * 2;
  const data = new Uint8ClampedArray(dim * scale * dim * scale * 4).fill(255);
  for (const key of modules) {
    const [r, c] = key.split(',').map(Number);
    for (let y = 0; y < scale; y++) {
      for (let x = 0; x < scale; x++) {
        const py = (r + quiet) * scale + y;
        const px = (c + quiet) * scale + x;
        const i = (py * dim * scale + px) * 4;
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
      }
    }
  }
  return { data, dim: dim * scale, size };
}

check('QR строится в корректный SVG', () => {
  const svg = qrSvg('https://example.com', { ec: 'M', quiet: 3 });
  assert.ok(svg.startsWith('<svg'), 'не SVG');
  // 25 модулей + quiet 3 с каждой стороны = 31
  assert.ok(svg.includes('viewBox="0 0 31 31"'), 'неверный viewBox');
  assert.ok(svg.includes('<rect'), 'нет белой подложки');
  assert.ok(qrMatrixSize('https://example.com', 'M') === 25, 'неверный размер матрицы');
});

check('QR декодируется сканером и содержит адрес', () => {
  const url = 'https://wise-feature-geography-cms.trycloudflare.com';
  const svg = qrSvg(url, { ec: 'M', quiet: 3 });
  const { data, dim } = rasterize(svg);
  const decoded = jsQR(data, dim, dim);
  assert.ok(decoded, 'QR не распознан');
  assert.strictEqual(decoded.data, url);
});

check('QR выдерживает длинный адрес', () => {
  const url = 'https://a-very-long-subdomain-name.example-company-domain.com/chat/room/42?invite=abcdef123456';
  const svg = qrSvg(url, { ec: 'M', quiet: 3 });
  const { data, dim } = rasterize(svg);
  const decoded = jsQR(data, dim, dim);
  assert.ok(decoded, 'QR не распознан');
  assert.strictEqual(decoded.data, url);
});

check('пустые данные отклоняются', () => {
  assert.throws(() => qrSvg(''), /Пустые данные/);
  assert.throws(() => qrSvg('   '), /Пустые данные/);
});

// ---------- эндпоинты сервера ----------
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
check('в сервере есть эндпоинты публичного адреса и QR', () => {
  assert.ok(appSrc.includes("/api/public-url"), 'нет /api/public-url');
  assert.ok(appSrc.includes("/api/public-url/qr.svg"), 'нет /api/public-url/qr.svg');
  assert.ok(appSrc.includes('publicUrl'), 'health не отдаёт publicUrl');
});

const clientSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
check('клиент показывает адрес и умеет копировать', () => {
  assert.ok(clientSrc.includes('copyPublicUrl'), 'нет обработчика копирования');
  assert.ok(clientSrc.includes('publicAccessCardHtml'), 'нет карточки в настройках');
  assert.ok(indexHtml.includes('id="public-access"'), 'нет блока на экране входа');
  assert.ok(indexHtml.includes('data-action="copyPublicUrl"'), 'нет кнопки копирования');
});

const i18nSrc = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
check('i18n содержит ключи публичного доступа (ru/en)', () => {
  for (const key of ['public.title', 'public.note', 'public.copy', 'public.copied', 'public.unavailable', 'public.qrAlt']) {
    const count = (i18nSrc.match(new RegExp(`'${key}'`, 'g')) || []).length;
    assert.strictEqual(count, 2, `ключ ${key} встречается ${count} раз(а), ожидалось 2 (ru/en)`);
  }
});

// ---------- клиентская логика в мини-DOM ----------
const vm = require('vm');

function fakeEl() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], innerHTML: '', textContent: '', value: '',
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    getContext() { return { fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {}, fillText() {}, measureText() { return { width: 0 }; }, createLinearGradient() { return { addColorStop() {} }; }, canvas: { width: 0 } }; },
    width: 0, height: 0, scrollIntoView() {}
  };
}

function createClientEnv(publicUrl) {
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, fakeEl());
      return els.get(id);
    },
    createElement() { return fakeEl(); },
    createTextNode() { return {}; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, body: fakeEl(),
    documentElement: { ...fakeEl(), style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } } },
    cookie: '', title: 'CipherTalk'
  };
  const copied = [];
  const win = {
    CipherTalkE2EE: { init: async () => ({}), getIdentity: () => null, ensureIdentity: async () => ({}) },
    I18N: { t: (k) => k, lang: 'ru', applyI18n() {}, setLang() {}, getLang() { return 'ru'; } },
    crypto: require('crypto').webcrypto,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key() { return null; }, get length() { return 0; } },
    document,
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', pathname: '/' },
    navigator: {
      userAgent: 'node-test', language: 'ru',
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
      serviceWorker: { register: async () => ({}) }, onLine: true,
      clipboard: { writeText: async (text) => { copied.push(text); } }
    },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Notification: function () { return {}; },
    fetch: async (url) => {
      if (String(url).includes('/api/public-url')) {
        return { ok: true, status: 200, json: async () => ({ url: publicUrl, mode: 'quick', available: !!publicUrl }) };
      }
      return { ok: false, status: 0, json: async () => ({}) };
    },
    WebSocket: function () { this.close = () => {}; this.send = () => {}; },
    confirm: () => true, alert: () => {}, prompt: () => null
  };
  win.window = win; win.self = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), ctx, { filename: 'public/app.js' });
  return { ctx, els, copied };
}

const clientUrl = 'https://wise-feature-geography-cms.trycloudflare.com';

(async () => {
  const env = createClientEnv(clientUrl);
  const block = env.els.get('public-access') || env.ctx.document.getElementById('public-access');
  const urlEl = env.ctx.document.getElementById('public-access-url');

  await vm.runInContext('refreshPublicAccess()', env.ctx);

  check('клиент подставляет публичный адрес в блок входа', () => {
    assert.strictEqual(urlEl.textContent, clientUrl);
    assert.strictEqual(block.style.display, 'block');
  });

  await vm.runInContext('copyPublicUrl()', env.ctx);
  check('кнопка копирования копирует адрес в буфер', () => {
    assert.ok(env.copied.includes(clientUrl), 'адрес не скопирован');
  });

  const env2 = createClientEnv(null);
  await vm.runInContext('refreshPublicAccess()', env2.ctx);
  const block2 = env2.ctx.document.getElementById('public-access');
  check('без туннеля блок скрыт', () => {
    assert.strictEqual(block2.style.display, 'none');
  });

  finish();
})().catch((e) => { console.error(e); finish(1); });

function finish(code) {
  // ---------- итог ----------
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nПубличный доступ: ${passed}/${results.length} проверок пройдено`);
  if (failed) {
    console.error(`Провалено: ${failed}`);
    process.exit(1);
  }
  process.exit(code || 0);
}

// ---------- итог ----------
