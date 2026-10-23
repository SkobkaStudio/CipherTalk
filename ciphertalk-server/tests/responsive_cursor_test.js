/**
 * Тесты адаптивных версий интерфейса и кастомного курсора.
 *
 * Проверяем:
 *  - кастомный курсор: создание элементов, реакция на движение/наведение,
 *    режим «текст», нажатие, отключение на тач-устройствах;
 *  - раскладку: три режима (ПК / планшет / телефон) в layout.css;
 *  - нижнюю навигацию телефона в разметке и её обработчик;
 *  - определение типа устройства на <html data-device>.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

// ==================== Мини-DOM ====================
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    _classes: new Set(),
    style: {
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
      getPropertyValue(k) { return this._props[k] || ''; },
      removeProperty(k) { delete this._props[k]; }
    },
    dataset: {},
    attrs: {},
    textContent: '',
    innerHTML: '',
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !el._classes.has(c) : !!force;
        if (on) el._classes.add(c); else el._classes.delete(c);
        return on;
      }
    },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener() {},
    closest() { return null; }
  };
  el._listeners = {};
  return el;
}

function createEnv({ pointer = 'fine', reduced = false } = {}) {
  const docEl = makeEl('html');
  const body = makeEl('body');
  const doc = {
    documentElement: docEl,
    body,
    createElement: (tag) => makeEl(tag),
    createTextNode: () => ({}),
    addEventListener(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => []
  };
  doc._listeners = {};

  const frames = [];
  const win = {
    document: doc,
    innerWidth: 1440,
    matchMedia: (q) => ({
      matches: q.includes('pointer: fine') ? pointer === 'fine'
        : q.includes('pointer: coarse') ? pointer === 'coarse'
        : q.includes('prefers-reduced-motion') ? reduced
        : false,
      addEventListener() {}, removeEventListener() {}
    }),
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelAnimationFrame: () => {},
    setTimeout: (fn, t) => { return setTimeout(fn, t); },
    clearTimeout,
    MutationObserver: function (cb) {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    addEventListener(type, fn) { (win._listeners[type] = win._listeners[type] || []).push(fn); },
    removeEventListener() {}
  };
  win._listeners = {};
  win.window = win; win.self = win; win.globalThis = win;

  const ctx = vm.createContext(win);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  const code = fs.readFileSync(path.join(ROOT, 'public/cursor.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'public/cursor.js' });

  return { ctx, doc, win, frames, docEl };
}

// ==================== Кастомный курсор ====================
const cursorCssText = fs.readFileSync(path.join(ROOT, 'public/cursor.css'), 'utf8');
const cursorJsText = fs.readFileSync(path.join(ROOT, 'public/cursor.js'), 'utf8');

check('курсор — SVG-стрелка через data:image/svg+xml', () => {
  assert.ok(cursorCssText.includes('cursor: url("data:image/svg+xml,'), 'нет SVG-курсора в CSS');
  assert.ok(!/cursor:\s*none/.test(cursorCssText), 'системный курсор скрывается');
  assert.ok(/\) 4 4, auto !important/.test(cursorCssText), 'нет hotspot или фолбэка стрелки');
});

check('все стили курсора — только при наличии мыши', () => {
  const start = cursorCssText.indexOf('@media (any-pointer: fine)');
  assert.ok(start >= 0, 'нет @media (any-pointer: fine)');
  const body = cursorCssText.slice(start, cursorCssText.indexOf('/* Страховка'));
  const outside = cursorCssText.replace(body, '');
  const decls = outside.match(/cursor:\s*[^;]+;/g) || [];
  decls.forEach((d) => assert.ok(/cursor:\s*auto/.test(d), 'курсор вне pointer:fine: ' + d));
});

check('цвет стрелки зависит от темы', () => {
  const dec = (theme) => {
    const m = cursorCssText.match(new RegExp('\\[data-theme="' + theme + '"\\][^{]*\\{[^}]*cursor: url\\("data:image/svg\\+xml,([^"]+)"'));
    assert.ok(m, 'нет курсора для темы ' + theme);
    return decodeURIComponent(m[1]);
  };
  const cyber = dec('cyberpunk');
  assert.ok(/#ff2e97/i.test(cyber), 'Киберпанк не розовый');
  assert.ok(/stroke="#ff2e97"/i.test(cyber), 'у Киберпанка нет свечения');
  const matrix = dec('matrix');
  assert.ok(/#00ff41/i.test(matrix), 'Матрица не зелёная');
  const amoled = dec('amoled');
  assert.ok(/#ffffff/i.test(amoled), 'AMOLED не белый');
});

check('у каждой темы свой набор курсоров', () => {
  const themes = ['dark', 'light', 'amoled', 'cyberpunk', 'neon', 'dracula', 'nord', 'mono', 'rose', 'ice', 'sunset', 'matrix'];
  themes.forEach((t) => {
    assert.ok(cursorCssText.includes('[data-theme="' + t + '"]'), 'нет курсора для темы ' + t);
  });
});

check('над кнопками — светящаяся рука, в полях — каретка', () => {
  assert.ok(/\) 11 2, pointer !important/.test(cursorCssText), 'нет «руки» для pointer-элементов');
  assert.ok(cursorCssText.includes('input[type="checkbox"]'), 'рука не покрывает чекбоксы');
  assert.ok(/cursor: text !important/.test(cursorCssText), 'в полях ввода не каретка');
});

check('переключатель: выключение возвращает системный курсор', () => {
  assert.ok(/html\[data-custom-cursor="on"\]/.test(cursorCssText), 'нет условия включения');
  const env = createEnv();
  env.ctx.Cursor.setEnabled(false);
  assert.strictEqual(env.docEl.getAttribute('data-custom-cursor'), 'off', 'курсор не выключился');
  env.ctx.Cursor.setEnabled(true);
  assert.strictEqual(env.docEl.getAttribute('data-custom-cursor'), 'on', 'курсор не включился');
});

check('на тач-устройствах курсор всегда системный', () => {
  const env = createEnv({ pointer: 'coarse' });
  env.ctx.Cursor.setEnabled(true);
  assert.strictEqual(env.docEl.getAttribute('data-custom-cursor'), 'off', 'курсор включён на тач-устройстве');
  assert.ok(!env.ctx.Cursor.isEnabled(), 'isEnabled вернул true на тач-устройстве');
});

check('cursor.js не создаёт DOM-элементов курсора', () => {
  assert.ok(!/createElement/.test(cursorJsText), 'лишние DOM-узлы');
  assert.ok(/setAttribute\('data-custom-cursor'/.test(cursorJsText), 'не управляет атрибутом');
});

check('настройка «Кастомный курсор» есть в Настройках', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  assert.ok(appSrc.includes('id="cursor-switch"'), 'нет тумблера');
  assert.ok(appSrc.includes('data-action="toggleCursor"'), 'нет обработчика тумблера');
  assert.ok(/function toggleCursor/.test(appSrc), 'нет toggleCursor');
  assert.ok(/customCursor: true/.test(appSrc), 'нет значения по умолчанию');
  assert.ok((i18n.match(/'settings\.customCursor'/g) || []).length >= 2, 'нет перевода названия');
  assert.ok((i18n.match(/'settings\.customCursorHint'/g) || []).length >= 2, 'нет перевода подсказки');
});

// ==================== Раскладка ====================
const layoutCss = fs.readFileSync(path.join(ROOT, 'public/layout.css'), 'utf8');
const cursorCss = fs.readFileSync(path.join(ROOT, 'public/cursor.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

check('есть три режима раскладки: ПК, планшет, телефон', () => {
  assert.ok(/@media \(min-width: 1025px\)/.test(layoutCss), 'нет режима ПК');
  assert.ok(/@media \(min-width: 641px\) and \(max-width: 1024px\)/.test(layoutCss), 'нет режима планшета');
  assert.ok(/@media \(max-width: 640px\)/.test(layoutCss), 'нет режима телефона');
});

check('телефон: нижняя навигация, безопасные зоны, шторки', () => {
  assert.ok(layoutCss.includes('.mobile-nav'), 'нет нижней навигации');
  assert.ok(layoutCss.includes('env(safe-area-inset-bottom)'), 'нет учёта безопасной зоны снизу');
  assert.ok(layoutCss.includes('env(safe-area-inset-top)'), 'нет учёта безопасной зоны сверху');
  assert.ok(layoutCss.includes('mqSheetUp'), 'нет анимации шторки');
});

check('планшет: две колонки, чат виден всегда', () => {
  const tablet = layoutCss.slice(layoutCss.indexOf('min-width: 641px'), layoutCss.indexOf('min-width: 1025px'));
  assert.ok(tablet.includes('.chat-area { display: flex !important;'), 'чат не всегда виден');
  assert.ok(tablet.includes('--mq-list-w'), 'нет ширины списка чатов');
});

check('ПК: три колонки и центрированная переписка', () => {
  const desktop = layoutCss.slice(layoutCss.indexOf('min-width: 1025px'));
  assert.ok(desktop.includes('.side-menu'), 'нет бокового меню');
  assert.ok(desktop.includes('--mq-content-max'), 'нет ограничения ширины переписки');
});

check('курсор вписан в дизайн: свечение и hotspot', () => {
  const first = (cursorCssText.match(/cursor: url\("data:image\/svg\+xml,([^"]+)"/) || [])[1];
  assert.ok(first, 'нет data-URI курсора');
  const svg = decodeURIComponent(first);
  assert.ok(/stroke-width="3\.6"/.test(svg), 'нет свечения вокруг стрелки');
  assert.ok(/#0b0f14/.test(svg), 'нет тёмной обводки для контраста');
  assert.ok(cursorCssText.includes(') 4 4, auto'), 'hotspot стрелки не задан');
  assert.ok(cursorCssText.includes(') 11 2, pointer'), 'hotspot руки не задан');
});

check('тач-устройства не теряют системный курсор', () => {
  const m = cursorCssText.split('@media not all and (any-pointer: fine)')[1];
  assert.ok(m, 'нет правила для тач-устройств');
  assert.ok(/cursor:\s*auto/.test(m), 'курсор не восстановлен');
});

check('разметка: подключены layout.css/cursor.css/cursor.js и нижняя навигация', () => {
  assert.ok(indexHtml.includes('href="/layout.css"'), 'не подключён layout.css');
  assert.ok(indexHtml.includes('href="/cursor.css"'), 'не подключён cursor.css');
  assert.ok(indexHtml.includes('src="/cursor.js"'), 'не подключён cursor.js');
  assert.ok(indexHtml.includes('id="mobile-nav"'), 'нет нижней навигации');
  assert.ok(indexHtml.includes('data-action="mobileChats"'), 'нет вкладки чатов');
});

check('клиент определяет тип устройства и ведёт нижнюю навигацию', () => {
  assert.ok(appJs.includes('function detectDevice()'), 'нет определения устройства');
  assert.ok(appJs.includes("data-device"), 'нет атрибута data-device');
  assert.ok(appJs.includes('function updateMobileNav()'), 'нет обновления навигации');
  assert.ok(appJs.includes('mobileChats:'), 'нет обработчика вкладки');
  assert.ok(appJs.includes('Cursor.init()'), 'курсор не инициализируется');
});

check('i18n: подписи нижней навигации на русском и английском', () => {
  const i18n = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  for (const key of ['nav.chats', 'nav.search', 'nav.group', 'nav.profile']) {
    const count = (i18n.match(new RegExp(`'${key}'`, 'g')) || []).length;
    assert.strictEqual(count, 2, `ключ ${key} встречается ${count} раз(а)`);
  }
});

check('service worker кеширует новые файлы', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.ok(sw.includes('/layout.css'), 'layout.css не в оболочке');
  assert.ok(sw.includes('/cursor.css'), 'cursor.css не в оболочке');
  assert.ok(sw.includes('/cursor.js'), 'cursor.js не в оболочке');
});

// ==================== итог ====================
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nАдаптивность и курсор: ${passed}/${results.length} проверок пройдено`);
if (failed) {
  console.error(`Провалено: ${failed}`);
  process.exit(1);
}
