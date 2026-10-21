/**
 * Проверка локализации клиента:
 *  1) паритет ключей RU/EN,
 *  2) все ключи, используемые в index.html (data-i18n*) и JS (I18N.t), есть в словарях,
 *  3) одинаковые плейсхолдеры {var} в обеих локалях.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function loadI18N() {
  const code = fs.readFileSync(path.join(PUBLIC_DIR, 'i18n.js'), 'utf8');
  const store = {};
  const sandbox = {
    window: {},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] }
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.I18N;
}

function usedKeys() {
  const keys = new Set();
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title|-text)?="([^"]+)"/g)) {
    keys.add(m[1]);
  }
  for (const file of ['app.js', 'chat-features.js']) {
    const js = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    for (const m of js.matchAll(/I18N\.t\(\s*'([^']+)'/g)) keys.add(m[1]);
  }
  return keys;
}

function placeholders(str) {
  return (String(str).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort();
}

describe('i18n (RU/EN)', () => {
  let I18N;
  let dict;

  beforeAll(() => {
    I18N = loadI18N();
    dict = I18N.dict;
  });

  test('словари RU и EN существуют и не пусты', () => {
    expect(Object.keys(dict)).toEqual(expect.arrayContaining(['ru', 'en']));
    expect(Object.keys(dict.ru).length).toBeGreaterThan(100);
    expect(Object.keys(dict.en).length).toBeGreaterThan(100);
  });

  test('паритет ключей RU/EN', () => {
    const ru = Object.keys(dict.ru).sort();
    const en = Object.keys(dict.en).sort();
    const onlyRu = ru.filter(k => !(k in dict.en));
    const onlyEn = en.filter(k => !(k in dict.ru));
    expect(onlyRu).toEqual([]);
    expect(onlyEn).toEqual([]);
  });

  test('все используемые ключи есть в обеих локалях', () => {
    const keys = [...usedKeys()].filter(k => k !== 'lang.');
    const missingRu = keys.filter(k => dict.ru[k] === undefined);
    const missingEn = keys.filter(k => dict.en[k] === undefined);
    expect(missingRu).toEqual([]);
    expect(missingEn).toEqual([]);
  });

  test('одинаковые плейсхолдеры {var} в RU и EN', () => {
    const bad = [];
    for (const key of Object.keys(dict.ru)) {
      const a = placeholders(dict.ru[key]).join(',');
      const b = placeholders(dict.en[key]).join(',');
      if (a !== b) bad.push({ key, ru: a, en: b });
    }
    expect(bad).toEqual([]);
  });

  test('t() подставляет переменные', () => {
    I18N.setLang('ru');
    expect(I18N.t('reply.for', { name: 'Анна' })).toContain('Анна');
    I18N.setLang('en');
    expect(I18N.t('reply.for', { name: 'Anna' })).toContain('Anna');
    expect(I18N.getLang()).toBe('en');
    I18N.setLang('ru');
    expect(I18N.getLang()).toBe('ru');
  });

  test('t() возвращает ключ для отсутствующего перевода, а не undefined', () => {
    expect(I18N.t('definitely.missing.key')).toBe('definitely.missing.key');
  });

  test('известная локаль активна по умолчанию', () => {
    expect(['ru', 'en']).toContain(I18N.getLang());
  });
});
