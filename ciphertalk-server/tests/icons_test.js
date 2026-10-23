/**
 * Тесты SVG-иконок и стикеров.
 *
 * Проверяем:
 *  - в интерфейсе не осталось системных эмодзи (index.html и клиентские скрипты);
 *  - все ссылки #mq-i-* в разметке и скриптах есть в спрайте символов;
 *  - для каждой темы заданы --mq-icon / --mq-icon-glow (Киберпанк — розовый,
 *    Матрица — зелёный), иконки наследуют currentColor;
 *  - hover-пульс и отключение анимаций при data-anim="off";
 *  - стикеры: набор SVG, отправка как сообщение типа sticker, приём и рендер
 *    картинкой, сервер разрешает тип sticker.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

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

// Диапазоны эмодзи: смайлы, символы, стрелки, буллеты, часы, значки
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B50}-\u{2B55}\u{2139}]/u;

// Эмодзи, которые остаются как данные (значение реакции), а не как элемент интерфейса
const ALLOWED_EMOJI_DATA = new Set(['👍', '❤️', '😂', '🔥', '🎉', '😢', '🙏', '👀', '❤', '📁']);

const indexHtml = read('index.html');
const appJs = read('app.js');
const chatFeatures = read('chat-features.js');
const callsJs = read('calls.js');
const iconsJs = read('icons.js');
const iconsCss = read('icons.css');

console.log('\n— Иконки: эмодзи вычищены из интерфейса —');

check('в index.html нет системных эмодзи', () => {
  const found = indexHtml.match(EMOJI_RE);
  assert.ok(!found, 'найдены эмодзи: ' + (found || []).join(' '));
});

check('в клиентских скриптах нет системных эмодзи (кроме данных реакций)', () => {
  ['app.js', 'chat-features.js', 'calls.js'].forEach((f) => {
    const src = read(f);
    const found = src.match(EMOJI_RE);
    if (!found) return;
    const unexpected = found.filter((e) => !ALLOWED_EMOJI_DATA.has(e));
    assert.ok(!unexpected.length, `${f}: ${unexpected.join(' ')}`);
  });
});

check('в разметке есть инлайн-спрайт символов', () => {
  assert.ok(indexHtml.includes('id="mq-icon-sprite"'), 'нет спрайта');
  assert.ok(/<symbol id="mq-i-search"/.test(indexHtml), 'нет символа поиска');
});

check('icons.js подключён до app.js', () => {
  const iconsAt = indexHtml.indexOf('src="/icons.js"');
  const appAt = indexHtml.indexOf('src="/app.js"');
  assert.ok(iconsAt > -1, 'icons.js не подключён');
  assert.ok(iconsAt < appAt, 'icons.js должен идти раньше app.js');
});

check('icons.css подключён и есть в service worker', () => {
  assert.ok(indexHtml.includes('/icons.css'), 'icons.css не подключён');
  const sw = read('sw.js');
  assert.ok(sw.includes("'/icons.css'"), 'icons.css нет в кеше SW');
  assert.ok(sw.includes("'/icons.js'"), 'icons.js нет в кеше SW');
  assert.ok(/ciphertalk-v\d+/.test(sw), 'нет версии кеша');
});

console.log('\n— Иконки: целостность спрайте —');

check('все #mq-i-* ссылки из разметки есть в спрайте', () => {
  const ids = new Set([...indexHtml.matchAll(/id="mq-i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  const refs = new Set([...indexHtml.matchAll(/#mq-i-([a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...refs].filter((r) => !ids.has(r));
  assert.ok(!missing.length, 'нет символов: ' + missing.join(', '));
});

check('все #mq-i-* ссылки из скриптов есть в спрайте', () => {
  const ids = new Set([...indexHtml.matchAll(/id="mq-i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  ['app.js', 'chat-features.js', 'calls.js'].forEach((f) => {
    const refs = new Set([...read(f).matchAll(/#mq-i-([a-z0-9-]+)/g)].map((m) => m[1]));
    const missing = [...refs].filter((r) => !ids.has(r));
    assert.ok(!missing.length, `${f}: нет символов ${missing.join(', ')}`);
  });
});

check('спрайт и PATHS в icons.js совпадают', () => {
  const ids = [...indexHtml.matchAll(/id="mq-i-([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
  const paths = [...iconsJs.matchAll(/^\s{4}'?([a-z0-9-]+)'?:\s*'/gm)].map((m) => m[1]).sort();
  const missing = ids.filter((i) => !paths.includes(i));
  assert.ok(!missing.length, 'в icons.js нет путей для: ' + missing.join(', '));
});

console.log('\n— Иконки: темы, свечение, анимации —');

check('для каждой темы задан цвет иконки и свечение', () => {
  const themes = ['dark', 'light', 'amoled', 'cyberpunk', 'neon', 'matrix', 'dracula',
    'nord', 'mono', 'rose', 'ice', 'sunset'];
  themes.forEach((t) => {
    const block = iconsCss.match(new RegExp(`html\\[data-theme="${t}"\\]\\s*\\{([^}]*)\\}`));
    assert.ok(block, `нет блока темы ${t}`);
    assert.ok(/--mq-icon:\s*#/.test(block[1]), `нет --mq-icon в ${t}`);
    assert.ok(/--mq-icon-glow:\s*rgba/.test(block[1]), `нет --mq-icon-glow в ${t}`);
  });
});

check('Киберпанк — неоново-розовая иконка, Матрица — зелёная', () => {
  const cyber = iconsCss.match(/html\[data-theme="cyberpunk"\]\s*\{([^}]*)\}/)[1];
  assert.ok(/--mq-icon:\s*#ff2e97/i.test(cyber), 'в киберпанке не розовый цвет');
  const matrix = iconsCss.match(/html\[data-theme="matrix"\]\s*\{([^}]*)\}/)[1];
  assert.ok(/--mq-icon:\s*#00ff41/i.test(matrix), 'в матрице не зелёный цвет');
});

check('иконки наследуют currentColor (перекраска под тему)', () => {
  assert.ok(/stroke="currentColor"/.test(indexHtml), 'символы без currentColor');
  assert.ok(/\.mq-icon\s*\{[^}]*color:\s*var\(--mq-icon\)/.test(iconsCss), 'нет color: var(--mq-icon)');
});

check('есть hover-пульс и отключение анимаций', () => {
  assert.ok(/@keyframes mqIconPulse/.test(iconsCss), 'нет анимации пульса');
  assert.ok(/data-anim="off"[\s\S]{0,120}animation:\s*none/.test(iconsCss), 'нет отключения при anim=off');
  assert.ok(/prefers-reduced-motion/.test(iconsCss), 'нет учёта prefers-reduced-motion');
});

check('иконки не перехватывают клики', () => {
  assert.ok(/\.mq-icon\s*\{[^}]*pointer-events:\s*none/.test(iconsCss), 'pointer-events не отключён');
});

console.log('\n— Стикеры —');

check('набор стикеров состоит из SVG-картинок', () => {
  const { STICKERS } = require(path.join(PUBLIC, 'icons.js'));
  assert.ok(Array.isArray(STICKERS) && STICKERS.length >= 8, 'стикеров мало');
  STICKERS.forEach((s) => {
    assert.ok(s.id && s.svg, 'стикер без id/svg');
    assert.ok(s.svg.startsWith('<svg') && s.svg.includes('</svg>'), 'стикер не SVG: ' + s.id);
    assert.ok(!/<script/i.test(s.svg), 'в стикере есть скрипт');
  });
});

check('стикер info добавлен в набор', () => {
  const { STICKERS } = require(path.join(PUBLIC, 'icons.js'));
  const info = STICKERS.find((s) => s.id === 'info');
  assert.ok(info, 'нет стикера info');
  assert.ok(info.svg.includes('s-info-g'), 'стикер info без градиента');
  assert.ok(STICKERS.length === 11, 'ожидается 11 стикеров, найдено ' + STICKERS.length);
});

check('SVG стикеров корректны (без дублей атрибутов)', () => {
  const { STICKERS } = require(path.join(PUBLIC, 'icons.js'));
  STICKERS.forEach((s) => {
    const tags = s.svg.match(/<[a-zA-Z][^>]*>/g) || [];
    tags.forEach((tag) => {
      const name = (tag.match(/^<([a-zA-Z:]+)/) || [])[1];
      if (name === 'svg' && tag.endsWith('/>')) return;
      const attrs = [...tag.matchAll(/([a-zA-Z:-]+)\s*=/g)].map((m) => m[1]);
      const dup = attrs.find((a, i) => attrs.indexOf(a) !== i);
      assert.ok(!dup, `стикер ${s.id}: дубль атрибута "${dup}" в <${name}>`);
    });
  });
});

check('стикеры отправляются отдельным типом сообщения', () => {
  assert.ok(/sendMediaBlob\(blob, 'sticker'/.test(appJs), 'стикер отправляется не как sticker');
  assert.ok(/msg\.type === 'sticker'/.test(appJs), 'нет приёма типа sticker');
  assert.ok(/function buildSticker/.test(appJs), 'нет рендера стикера');
});

check('стикер рендерится картинкой, а не текстом', () => {
  const block = appJs.match(/function buildSticker[\s\S]*?\n}/);
  assert.ok(block, 'нет buildSticker');
  assert.ok(/createElement\('img'\)/.test(block[0]), 'стикер рисуется не через <img>');
  assert.ok(!/textContent\s*=\s*sticker/.test(block[0]), 'стикер выводится текстом');
});

check('сервер разрешает тип сообщения sticker', () => {
  const ws = fs.readFileSync(path.join(ROOT, 'src/services/websocketService.js'), 'utf8');
  const set = ws.match(/ALLOWED_MESSAGE_TYPES = new Set\(\[([^\]]*)\]/);
  assert.ok(set, 'нет набора типов');
  assert.ok(/'sticker'/.test(set[1]), 'тип sticker не разрешён');
});

check('кнопка стикеров есть в интерфейсе и i18n', () => {
  assert.ok(/id="sticker-btn"/.test(indexHtml), 'нет кнопки стикеров');
  assert.ok(/data-action="openStickerPicker"/.test(indexHtml), 'нет обработчика');
  assert.ok(/openStickerPicker:/.test(appJs), 'нет действия openStickerPicker');
  const i18n = read('i18n.js');
  assert.ok((i18n.match(/'chat.stickers'/g) || []).length >= 2, 'нет перевода chat.stickers');
});

console.log('\n— Иконки: остальные элементы интерфейса —');

check('реакции отображаются иконками, а не эмодзи', () => {
  assert.ok(/Icons\.reactionMarkup\(emoji/.test(chatFeatures), 'панель реакций без иконок');
  assert.ok(/Icons\.REACTION_ICONS\[emoji\]/.test(appJs), 'чипы реакций без иконок');
  const emojiList = (chatFeatures.match(/const REACTION_EMOJI = \[([^\]]*)\]/) || [])[1] || '';
  const list = emojiList.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.ok(list.length, 'не найден список реакций');
  const { REACTION_ICONS } = require(path.join(PUBLIC, 'icons.js'));
  list.forEach((e) => {
    assert.ok(REACTION_ICONS[e], 'нет иконки для реакции ' + e);
  });
});

check('файлы, галочки, кнопки и меню используют SVG', () => {
  assert.ok(/Icons\.svg\('image'/.test(appJs), 'иконка файла не SVG');
  assert.ok(/Icons\.svg\('check-check'/.test(appJs), 'галочки не SVG');
  assert.ok(/Icons\.svg\('edit'/.test(appJs), 'кнопка правки не SVG');
  assert.ok(/Icons\.svg\('trash'/.test(appJs), 'кнопка удаления не SVG');
  assert.ok(/Icons\.svg\('phone'/.test(callsJs), 'иконки звонка не SVG');
});

console.log('\n— Иконки: эмодзи в строках переводов —');

check('для каждого эмодзи в переводах есть иконка', () => {
  const i18n = read('i18n.js');
  const { EMOJI_ICONS } = require(path.join(PUBLIC, 'icons.js'));
  const found = new Set();
  const re = /'[^']*'\s*:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(i18n)) !== null) {
    const value = m[1];
    for (const ch of value) {
      if (EMOJI_RE.test(ch)) found.add(ch);
    }
  }
  assert.ok(found.size, 'в переводах не найдено эмодзи (проверьте актуальность теста)');
  found.forEach((ch) => {
    assert.ok(EMOJI_ICONS[ch], 'нет иконки для эмодзи ' + ch);
  });
});

check('автозамена эмодзи ограничена служебными областями', () => {
  const { EMOJI_ICONS } = require(path.join(PUBLIC, 'icons.js'));
  const iconsJs = read('icons.js');
  assert.ok(/ICONIFY_SCOPE/.test(iconsJs), 'нет области автозамены');
  assert.ok(/startIconify/.test(iconsJs), 'нет автозамены эмодзи в текстах');
  const scope = (iconsJs.match(/const ICONIFY_SCOPE = \[([\s\S]*?)\]\.join/) || [])[1] || '';
  assert.ok(!/chat-area|chat-list|chat-preview|message/.test(scope), 'область автозамены затрагивает сообщения');
  assert.ok(Object.keys(EMOJI_ICONS).length >= 30, 'мало эмодзи в карте иконок');
});

check('служебные подписи в чате используют иконки', () => {
  assert.ok(/icon: 'mic'/.test(appJs), 'нет иконки микрофона в превью');
  assert.ok(/icon: 'paperclip'/.test(appJs), 'нет иконки скрепки в превью');
  assert.ok(/Icons\.svg\('lock'/.test(appJs), 'нет иконки замка в превью');
  assert.ok(/Icons\.svg\('trash'/.test(appJs), 'нет иконки корзины для удалённого сообщения');
  const i18n = read('i18n.js');
  assert.ok(!/'chat\.voiceMsg':\s*'[^']*[\u{1F300}-\u{1FAFF}]/u.test(i18n), 'в превью остался эмодзи');
});

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n=== ИТОГО: passed=${passed}, failed=${failed} ===`);
if (failed) {
  results.filter((r) => !r.ok).forEach((r) => console.error(`  ✗ ${r.name}: ${r.error}`));
  process.exit(1);
}
