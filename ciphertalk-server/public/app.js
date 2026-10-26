'use strict';

// ==================== КОНФИГ ====================
const SERVER_URL = '';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_VOICE_SECONDS = 300;
const MAX_VIDEO_SECONDS = 60;
const MEDIA_CACHE_LIMIT = 30;

let ws = null;
let wsReconnectTimer = null;
let currentUser = null;
let authToken = localStorage.getItem('ciphertalk_token') || '';
let chats = [];
let currentChatId = null;
let messages = {};          // chatId -> [normalized message]
const chatCacheTimers = {}; // chatId -> таймер дебаунса записи в IndexedDB
let chatsCacheTimer = null;
// E2EE-состояние живёт в обще модуле /e2ee.js, здесь только кэш
let onlineUsers = new Set();
let typingTimeout = null;
let usernameCheckTimeout = null;
let searchTimeout = null;
let lastTypingSent = 0;
let sessionExpiredHandled = false;
let typewriterTimers = new Set();
let renderChatListTimer = null;

// ==================== СИСТЕМНЫЕ УВЕДОМЛЕНИЯ ====================
// Правило одно и оно простое: уведомление показывает ТОТ, кто видит сообщение
// первым — страница (через регистрацию SW) или фоновый сокет внутри SW.
// Дедупликация: страница молчит, только когда её вкладка видимА И в фокусе;
// SW молчит по тем же правилам + не дублирует сообщения, которые страница
// уже показала (он знает о них через ct-notif-shown).
let notificationPermission = 'default';

function notifGranted() {
  return 'Notification' in window && Notification.permission === 'granted';
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  // Если разрешение уже «granted», НЕ зовём requestPermission() повторно —
  // в Firefox это может сбросить состояние и уведомления «включены, но не приходят».
  if (Notification.permission === 'granted') {
    notificationPermission = 'granted';
    syncSWBackground();
    return true;
  }
  if (Notification.permission === 'denied') {
    notificationPermission = 'denied';
    return false;
  }
  try {
    const perm = await Notification.requestPermission();
    notificationPermission = (perm === 'granted') ? 'granted' : (perm || 'default');
    syncSWBackground();
    return notificationPermission === 'granted';
  } catch (e) {
    console.warn('Notification.requestPermission failed:', e);
    return false;
  }
}

// Синхронизируем состояние разрешений с браузером (могли выдать/забрать
// в настройках сайта) — и немедленно доводим до сведения Service Worker'а.
if ('permissions' in navigator && 'Notification' in window) {
  try {
    navigator.permissions.query({ name: 'notifications' }).then(status => {
      const sync = () => {
        notificationPermission = status.state;
        syncSWBackground();
      };
      sync();
      status.onchange = sync;
    }).catch(() => {});
  } catch (e) { /* не поддерживается — не критично */ }
}

let swRegistration = null;

function hostnameIsLocal() {
  return ['localhost', '127.0.0.1', '::1'].includes(location.hostname) ||
    /^192\.168\./.test(location.hostname) || /^10\./.test(location.hostname);
}

// Актуальная регистрация SW. НЕ используем navigator.serviceWorker.ready —
// он никогда не резолвится, пока SW не станет контроллером страницы (первая
// сессия после регистрации), из-за чего уведомления «не приходили никогда».
// Кэшируем объект из register(); если страницы открыли без нас — ищем через
// getRegistration()/getRegistrations() ОДИН раз, без зависаний и гонок.
function getCachedSWRegistration() {
  if (swRegistration) return Promise.resolve(swRegistration);
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!(location.protocol === 'https:' || hostnameIsLocal())) return Promise.resolve(null);
  return (async () => {
    try {
      let reg = await navigator.serviceWorker.getRegistration();
      if (!reg && navigator.serviceWorker.getRegistrations) {
        const all = await navigator.serviceWorker.getRegistrations();
        reg = (all || [])[0] || null;
      }
      if (reg) swRegistration = reg;
      return reg;
    } catch (e) {
      return null;
    }
  })();
}

function showNotification(title, body, chatId) {
  // Вкладка открыта, видима и в фокусе — пользователь всё видит в интерфейсе,
  // системное уведомление не нужно. Во всех остальных случаях — показываем.
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  // Разрешения нет — показывать нечего (фон тоже получит отказ, см. sw.js).
  if (!notifGranted()) return;

  const options = {
    body,
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    tag: `chat-${chatId}`,
    renotify: true,
    data: { chatId },
    vibrate: [80, 40, 80]
  };

  getCachedSWRegistration().then(reg => {
    if (reg && reg.showNotification) {
      return reg.showNotification(title, options);
    }
    // Регистрация недоступна — last resort: прямой конструктор
    // (работает на Firefox/Safari, на Chromium без контроллера — нет).
    try { new Notification(title, options); } catch (e) { /* ignore */ }
    return undefined;
  }).then((ok) => {
    // ok === false значит «показ отклонён» (например, Android требует
    // канал уведомлений) — просим фон подхватить это сообщение.
    if (ok === false) swPostMessage({ type: 'ct-bg-init', token: authToken, user: currentUser ? { id: currentUser.id } : null, granted: true });
    else swPostMessage({ type: 'ct-notif-shown', chatId });
  }).catch(() => {});
}

// ==================== МОСТ СО SERVICE WORKER (фон) ====================
// SW держит собственный WebSocket и показывает уведомления, когда вкладка закрыта.
// Страница передаёт ему токен/пользователя и принимает команды от него.

// Отправляем сообщение Service Worker'у. ВАЖНО: postMessage идёт либо активному
// контроллеру, либо (если контроллера ещё нет — первая сессия после регистрации)
// ставится в очередь и уходит на controllerchange. Дополнительно дублируем в
// любую доступную регистрацию (reg.active/waiting), иначе ct-bg-init терялся,
// SW не знал токен и фоновые уведомления не работали никогда.
let swSendQueue = [];
function swPostMessage(data) {
  try {
    if (!('serviceWorker' in navigator)) return;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(data);
      return;
    }
    // Контроллера нет: пробуем достучаться до SW напрямую через регистрацию
    getCachedSWRegistration().then(reg => {
      const target = reg && (reg.active || reg.waiting);
      if (target) {
        try { target.postMessage(data); return; } catch (e) { /* ignore */ }
      }
      // Не вышло — копим до появления контроллера (dedupe по типу: важен последний)
      swSendQueue = swSendQueue.filter(m => m.type !== data.type);
      swSendQueue.push(data);
    });
  } catch (e) { /* ignore */ }
}

function flushSWQueue() {
  if (!navigator.serviceWorker.controller || !swSendQueue.length) return;
  const queue = swSendQueue;
  swSendQueue = [];
  for (const d of queue) {
    try { navigator.serviceWorker.controller.postMessage(d); } catch (e) { /* ignore */ }
  }
}

function syncSWBackground() {
  if (authToken && currentUser) {
    // granted берётся из реального состояния браузера — фон будет молчать,
    // пока разрешения нет (показывать всё равно нечего), и оживёт сразу,
    // как только пользователь выдаст разрешение (см. permissions.query выше).
    swPostMessage({
      type: 'ct-bg-init',
      token: authToken,
      user: { id: currentUser.id },
      granted: notifGranted()
    });
  } else {
    swPostMessage({ type: 'ct-bg-logout' });
  }
}

if ('serviceWorker' in navigator) {
  // Как только SW стал контроллером (первая активация или update) —
  // передаём ему учётные данные и сливаем очередь.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.__ctSwReady = true;
    flushSWQueue();
    syncSWBackground();
  });
  if (navigator.serviceWorker.controller) {
    window.__ctSwReady = true;
    flushSWQueue();
    syncSWBackground();
  }
  // Когда страница уходит в фон (свёрнута/потеряла фокус) — активируем фоновый
  // сокет SW заранее, чтобы ни одно сообщение не потерялось в момент перехода.
  const notifyVisibilityChange = () => {
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      swPostMessage({ type: 'ct-bg-pause' });
    } else {
      syncSWBackground();
    }
  };
  document.addEventListener('visibilitychange', notifyVisibilityChange);
  window.addEventListener('blur', notifyVisibilityChange);
  window.addEventListener('focus', notifyVisibilityChange);

  navigator.serviceWorker.addEventListener('message', (event) => {
    const d = event.data || {};
    if (d.type === 'ct-open-chat' && d.chatId) {
      // Дождаться загрузки чатов, затем открыть нужный
      let tries = 0;
      const timer = setInterval(() => {
        if (getChatById(Number(d.chatId))) {
          clearInterval(timer);
          openChat(Number(d.chatId));
        } else if (++tries > 20) {
          clearInterval(timer);
        }
      }, 300);
    }
  });
}

function renderChatListThrottled(filter = '') {
  if (renderChatListTimer) clearTimeout(renderChatListTimer);
  renderChatListTimer = setTimeout(() => {
    renderChatListTimer = null;
    renderChatList(filter);
  }, 60);
}

let regState = {
  phone: '', code: '', verifyToken: '', loginToken: '', firstName: '', lastName: '',
  username: '', password: '', action: null, existingName: ''
};

// ==================== ВНЕШНИЙ ВИД (темы/фон/стекло) ====================
const APPEARANCE_KEY = 'ciphertalk_appearance';

// ==================== ШРИФТЫ И ТИПОГРАФИКА ====================
const FONT_FAMILIES = [
  { id: 'system',   label: 'settings.fontSystem',   stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { id: 'compact',  label: 'settings.fontCompact',  stack: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  { id: 'humanist', label: 'settings.fontHumanist', stack: "'Trebuchet MS', 'Segoe UI', Verdana, sans-serif" },
  { id: 'serif',    label: 'settings.fontSerif',    stack: "Georgia, 'Times New Roman', 'Noto Serif', serif" },
  { id: 'mono',     label: 'settings.fontMono',     stack: "'SFMono-Regular', 'JetBrains Mono', Consolas, 'Liberation Mono', monospace" },
  { id: 'rounded',  label: 'settings.fontRounded',  stack: "Nunito, Quicksand, 'Trebuchet MS', sans-serif" },
  { id: 'classic',  label: 'settings.fontClassic',  stack: "'PT Serif', 'Noto Serif', 'Times New Roman', serif" },
  { id: 'custom',   label: 'settings.fontCustom',   stack: '' }
];
const FONT_WEIGHTS = ['400', '500', '600', '700'];
const LINE_HEIGHT = { min: 1.2, max: 2, step: 0.05 };
const APPEARANCE_NUM_RANGES = {
  msgFontSize: [12, 24], blur: [0, 40], bgOpacity: [0, 100],
  saturate: [0, 300], glow: [0, 30], roundness: [0, 28], msgLineHeight: [1.2, 2]
};
const APPEARANCE_IDS = {
  theme: ['auto', 'dark', 'light', 'amoled', 'cyberpunk', 'neon', 'dracula', 'nord', 'mono', 'rose', 'ice', 'sunset', 'matrix'],
  chatBg: ['default', 'aurora', 'sunset', 'forest', 'grid', 'dots', 'waves', 'stars'],
  animLevel: ['off', 'normal', 'full'],
  fontFamily: FONT_FAMILIES.map(f => f.id),
  msgFontWeight: FONT_WEIGHTS,
  fontScope: ['app', 'messages']
};
const THEMES = [
  { id: 'auto', name: I18N.t('theme.auto'), colors: ['#ffffff', '#17212b', '#5eb5f7'] },
  { id: 'dark', name: I18N.t('theme.dark'), colors: ['#0e1621', '#2b5278', '#5eb5f7'] },
  { id: 'light', name: I18N.t('theme.light'), colors: ['#ffffff', '#4a9de0', '#2b7fd4'] },
  { id: 'amoled', name: 'AMOLED', colors: ['#000000', '#1a3a5c', '#ffffff'] },
  { id: 'cyberpunk', name: I18N.t('theme.cyberpunk'), colors: ['#0d0221', '#ff2e97', '#00f5d4'] },
  { id: 'neon', name: I18N.t('theme.neon'), colors: ['#05070d', '#00b4ff', '#39ff14'] },
  { id: 'dracula', name: 'Dracula', colors: ['#282a36', '#bd93f9', '#ff79c6'] },
  { id: 'nord', name: 'Nord', colors: ['#2e3440', '#88c0d0', '#a3be8c'] },
  { id: 'mono', name: I18N.t('theme.mono'), colors: ['#141414', '#4d4d4d', '#e6e6e6'] },
  { id: 'rose', name: I18N.t('theme.rose'), colors: ['#1a1016', '#ff6fae', '#ffd1e8'] },
  { id: 'ice', name: I18N.t('theme.ice'), colors: ['#0b1a24', '#5ec8f0', '#c9f4ff'] },
  { id: 'sunset', name: I18N.t('theme.sunset'), colors: ['#1a0f1e', '#ff7849', '#ffd166'] },
  { id: 'matrix', name: I18N.t('theme.matrix'), colors: ['#020a02', '#00ff41', '#0d2b0d'] }
];
const CHAT_BACKGROUNDS = [
  { id: 'default', name: I18N.t('bg.default') },
  { id: 'aurora', name: 'Aurora' },
  { id: 'sunset', name: I18N.t('bg.sunset') },
  { id: 'forest', name: I18N.t('bg.forest') },
  { id: 'grid', name: I18N.t('bg.grid') },
  { id: 'dots', name: I18N.t('bg.dots') },
  { id: 'waves', name: I18N.t('bg.waves') },
  { id: 'stars', name: I18N.t('bg.stars') }
];
const STYLE_PRESETS = [
  { id: 'classic', name: I18N.t('preset.classic'), patch: { theme: 'dark', glass: false, snow: true, blur: 14, bgOpacity: 55, saturate: 140, glow: 0, roundness: 12 } },
  { id: 'frost', name: 'Frost', patch: { theme: 'ice', glass: true, snow: true, blur: 22, bgOpacity: 45, saturate: 160, glow: 6, roundness: 18 } },
  { id: 'cyber', name: 'Cyber', patch: { theme: 'cyberpunk', glass: true, snow: false, blur: 12, bgOpacity: 60, saturate: 200, glow: 14, roundness: 6, customBg: '' } },
  { id: 'minimal', name: 'Minimal', patch: { theme: 'mono', glass: false, snow: false, blur: 8, bgOpacity: 70, saturate: 100, glow: 0, roundness: 8 } },
  { id: 'vapor', name: 'Vaporwave', patch: { theme: 'rose', glass: true, snow: false, blur: 18, bgOpacity: 50, saturate: 180, glow: 10, roundness: 20 } },
  { id: 'matrix', name: 'Matrix', patch: { theme: 'matrix', glass: true, snow: false, blur: 10, bgOpacity: 65, saturate: 120, glow: 16, roundness: 4 } }
];
function defaultAppearance() {
  return {
    theme: 'dark', chatBg: 'default', glass: true, snow: true, blur: 14,
    bgOpacity: 55, saturate: 140, glow: 0, roundness: 12,
    customBg: '', animLevel: 'normal', msgFontSize: 14, fontFamily: 'system',
    fontCustom: '', msgFontWeight: '400', msgLineHeight: 1.45, fontScope: 'app',
    tails: true, customCursor: true
  };
}
let appearance = defaultAppearance();
const BADGE_CHOICES = [
  { id: '', icon: '', label: 'settings.badgeNone' },
  { id: 'star', icon: 'star', label: 'settings.badgeStar' },
  { id: 'shield', icon: 'shield', label: 'settings.badgeShield' },
  { id: 'flame', icon: 'flame', label: 'settings.badgeFlame' },
  { id: 'zap', icon: 'zap', label: 'settings.badgeZap' },
  { id: 'heart', icon: 'heart', label: 'settings.badgeHeart' },
  { id: 'sparkle', icon: 'sparkle', label: 'settings.badgeSparkle' }
];
const BADGE_IDS = BADGE_CHOICES.map(b => b.id);
let privacy = { pinHash: '', hideOnline: false, ghost: false, screenshotGuard: false, badge: '' };
const PRIVACY_KEY = 'ciphertalk_privacy';
let appearanceTimerStarted = false;

// Шрифтовой стек из localStorage нельзя подставлять в CSS «как есть»:
// оставляем только безопасные символы (буквы, цифры, пробелы, кавычки, запятые).
function sanitizeFontStack(value) {
  return String(value == null ? '' : value)
    .replace(/[^a-zA-Z0-9\s'",.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Валидация настроек из localStorage: неизвестные ключи отбрасываем,
// числа ограничиваем диапазоном, строки — списком допустимых.
function sanitizeAppearance(saved) {
  const out = {};
  if (!saved || typeof saved !== 'object') return out;
  for (const key of Object.keys(APPEARANCE_NUM_RANGES)) {
    const v = Number(saved[key]);
    if (typeof saved[key] === 'number' && isFinite(v)) {
      const range = APPEARANCE_NUM_RANGES[key];
      out[key] = Math.min(range[1], Math.max(range[0], v));
    }
  }
  for (const key of Object.keys(APPEARANCE_IDS)) {
    if (typeof saved[key] === 'string' && APPEARANCE_IDS[key].includes(saved[key])) {
      out[key] = saved[key];
    }
  }
  for (const key of ['glass', 'snow', 'tails', 'customCursor']) {
    if (typeof saved[key] === 'boolean') out[key] = saved[key];
  }
  if (typeof saved.customBg === 'string' && saved.customBg.startsWith('data:image/')) {
    out.customBg = saved.customBg.slice(0, 4500000);
  }
  if (typeof saved.fontCustom === 'string') out.fontCustom = sanitizeFontStack(saved.fontCustom);
  return out;
}

function readStoredAppearance(key) {
  try { return sanitizeAppearance(JSON.parse(localStorage.getItem(key) || '{}')); }
  catch (e) { return {}; }
}

// Настройки внешнего вида и приватности привязаны к аккаунту:
// общие настройки устройства живут под APPEARANCE_KEY/PRIVACY_KEY,
// аккаунтные — под <key>_u<userId> (scopedStorageKey).
function appearanceStorageKey() { return scopedStorageKey(APPEARANCE_KEY); }
function privacyStorageKey() { return scopedStorageKey(PRIVACY_KEY); }

function loadAppearance() {
  appearance = Object.assign(defaultAppearance(), readStoredAppearance(APPEARANCE_KEY));

  const scopedKey = appearanceStorageKey();
  if (scopedKey !== APPEARANCE_KEY) {
    const scoped = readStoredAppearance(scopedKey);
    if (Object.keys(scoped).length) {
      appearance = Object.assign(appearance, scoped);
    } else {
      // Первый вход: переносим общие настройки устройства в аккаунт.
      try { localStorage.setItem(scopedKey, JSON.stringify(appearance)); } catch (e) { /* ignore */ }
    }
  }

  privacy = { pinHash: '', hideOnline: false, ghost: false, screenshotGuard: false, badge: '' };
  try {
    privacy = Object.assign(privacy, JSON.parse(localStorage.getItem(PRIVACY_KEY) || '{}'));
  } catch (e) { /* ignore */ }
  const pKey = privacyStorageKey();
  if (pKey !== PRIVACY_KEY) {
    let scopedPrivacy = {};
    try { scopedPrivacy = JSON.parse(localStorage.getItem(pKey) || '{}'); } catch (e) { /* ignore */ }
    if (!scopedPrivacy || typeof scopedPrivacy !== 'object' || !Object.keys(scopedPrivacy).length) {
      try { localStorage.setItem(pKey, JSON.stringify(privacy)); } catch (e) { /* ignore */ }
    } else {
      privacy = Object.assign(privacy, scopedPrivacy);
    }
  }

  applyAppearance();
  if (!appearanceTimerStarted) {
    appearanceTimerStarted = true;
    setInterval(() => {
      if (appearance.theme === 'auto') applyAppearance();
    }, 60000);
  }
}

// Перечитать настройки после входа/выхода (смена аккаунта)
function reloadAppearanceForUser() {
  loadAppearance();
}

function saveAppearance() {
  try { localStorage.setItem(appearanceStorageKey(), JSON.stringify(appearance)); } catch (e) { /* ignore */ }
}

function savePrivacy() {
  try { localStorage.setItem(privacyStorageKey(), JSON.stringify(privacy)); } catch (e) { /* ignore */ }
}

function resolveTheme() {
  if (appearance.theme !== 'auto') return appearance.theme;
  const hour = new Date().getHours();
  return hour >= 7 && hour < 19 ? 'light' : 'dark';
}

function applyAppearance() {
  const html = document.documentElement;
  const theme = resolveTheme();
  html.setAttribute('data-theme', theme);
  html.setAttribute('data-glass', appearance.glass ? 'on' : 'off');
  html.setAttribute('data-anim', appearance.animLevel || 'normal');
  html.setAttribute('data-tails', appearance.tails === false ? 'off' : 'on');
  const customCursor = appearance.customCursor !== false;
  if (window.Cursor && typeof window.Cursor.setEnabled === 'function') {
    window.Cursor.setEnabled(customCursor);
  } else {
    html.setAttribute('data-custom-cursor', customCursor ? 'on' : 'off');
  }
  const root = document.documentElement.style;
  root.setProperty('--glass-blur', (Number(appearance.blur) || 14) + 'px');
  root.setProperty('--glass-alpha', ((Number(appearance.bgOpacity) || 55) / 100).toFixed(2));
  root.setProperty('--glass-saturate', (Number(appearance.saturate) || 140) + '%');
  root.setProperty('--glow-strength', (Number(appearance.glow) || 0) + 'px');
  root.setProperty('--radius', (Number(appearance.roundness) || 0) + 'px');
  root.setProperty('--msg-font-size', (Number(appearance.msgFontSize) || 14) + 'px');
  // Шрифт приложения и шрифт сообщений могут различаться (область применения).
  const chosenStack = resolveFontStack();
  root.setProperty('--font-family', appearance.fontScope === 'messages' ? FONT_FAMILIES[0].stack : chosenStack);
  root.setProperty('--msg-font-family', chosenStack);
  root.setProperty('--msg-font-weight', appearance.msgFontWeight || '400');
  root.setProperty('--msg-line-height', String(Number(appearance.msgLineHeight) || 1.45));
  document.querySelectorAll('.chat-area').forEach(el => {
    el.setAttribute('data-bg', appearance.chatBg);
    if (appearance.customBg) {
      el.style.backgroundImage = `linear-gradient(rgba(0,0,0,${1 - (Number(appearance.bgOpacity) || 55) / 100}), rgba(0,0,0,${1 - (Number(appearance.bgOpacity) || 55) / 100})), url("${appearance.customBg}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } else {
      el.style.backgroundImage = '';
    }
  });
  if (snow) {
    const animOff = (appearance.animLevel || 'normal') === 'off';
    if (appearance.snow && !animOff) snow.resume();
    else { snow.pause(); if (snow.ctx) snow.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
  }
}

function setStylePreset(id) {
  const preset = STYLE_PRESETS.find(p => p.id === id);
  if (!preset) return;
  Object.assign(appearance, preset.patch);
  if (preset.patch.customBg === '') appearance.customBg = '';
  saveAppearance();
  applyAppearance();
  if (currentChatId) renderMessages(currentChatId);
  document.querySelectorAll('.preset-chip').forEach(el =>
    el.classList.toggle('active', el.dataset.preset === id));
  showToast(I18N.t('toast.styleApplied', { preset: preset.name }), 'success');
}

function setCustomBg(el) {
  const file = el && el.files && el.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { showToast(I18N.t('err.fileTooBig'), 'error'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    appearance.customBg = reader.result;
    appearance.chatBg = 'default';
    saveAppearance();
    applyAppearance();
    showToast(I18N.t('toast.customBg'), 'success');
  };
  reader.readAsDataURL(file);
}

function clearCustomBg() {
  appearance.customBg = '';
  saveAppearance();
  applyAppearance();
  showToast(I18N.t('toast.customBgRemoved'), 'success');
}

function setAnimLevel(level) {
  appearance.animLevel = level;
  saveAppearance();
  applyAppearance();
  document.querySelectorAll('.anim-chip').forEach(el =>
    el.classList.toggle('active', el.dataset.anim === level));
}

function setFloat(prop, value, labelId, suffix) {
  const bounds = { bgOpacity: [10, 95], saturate: [80, 240], glow: [0, 30], roundness: [0, 28] };
  const [min, max] = bounds[prop] || [0, 100];
  appearance[prop] = Math.max(min, Math.min(max, Number(value)));
  saveAppearance();
  applyAppearance();
  const label = document.getElementById(labelId);
  if (label) label.textContent = appearance[prop] + (suffix || '');
}

function setTheme(id) {
  appearance.theme = id;
  saveAppearance();
  // Плавный переход темы через View Transitions API (если поддерживается)
  if (typeof Motion !== 'undefined' && Motion.withTransition) {
    Motion.withTransition(function () { applyAppearance(); });
  } else {
    applyAppearance();
  }
  document.querySelectorAll('.theme-swatch').forEach(el =>
    el.classList.toggle('active', el.dataset.theme === id));
}

function setChatBg(id) {
  appearance.chatBg = id;
  saveAppearance();
  applyAppearance();
  document.querySelectorAll('.bg-swatch').forEach(el =>
    el.classList.toggle('active', el.dataset.bg === id));
}

function toggleGlass() {
  appearance.glass = !appearance.glass;
  saveAppearance();
  applyAppearance();
  const sw = document.getElementById('glass-switch');
  if (sw) sw.classList.toggle('on', appearance.glass);
}

// Кастомный курсор-стрелка (CSS-курсоры в cursor.css, включение — здесь)
function toggleCursor() {
  appearance.customCursor = appearance.customCursor === false;
  saveAppearance();
  applyAppearance();
  const sw = document.getElementById('cursor-switch');
  if (sw) sw.classList.toggle('on', appearance.customCursor !== false);
  showToast(
    I18N.t(appearance.customCursor !== false ? 'toast.cursorOn' : 'toast.cursorOff'),
    'success', 'palette'
  );
}

function toggleSnow() {
  appearance.snow = !appearance.snow;
  saveAppearance();
  applyAppearance();
  const sw = document.getElementById('snow-switch');
  if (sw) sw.classList.toggle('on', appearance.snow);
}

function setBlur(value) {
  appearance.blur = Math.max(4, Math.min(40, Number(value) || 14));
  saveAppearance();
  applyAppearance();
  const label = document.getElementById('blur-value');
  if (label) label.textContent = appearance.blur + 'px';
}

function resolveFontStack() {
  const fam = FONT_FAMILIES.find(f => f.id === appearance.fontFamily);
  if (!fam) return FONT_FAMILIES[0].stack;
  if (fam.id === 'custom') {
    const custom = sanitizeFontStack(appearance.fontCustom);
    return custom || FONT_FAMILIES[0].stack;
  }
  return fam.stack;
}

function updateFontPreview() {
  const el = document.getElementById('font-preview');
  if (!el) return;
  el.style.fontFamily = resolveFontStack();
  el.style.fontSize = (Number(appearance.msgFontSize) || 14) + 'px';
  el.style.fontWeight = appearance.msgFontWeight || '400';
  el.style.lineHeight = String(Number(appearance.msgLineHeight) || 1.45);
}

function setFontSize(value) {
  appearance.msgFontSize = Math.max(12, Math.min(24, Number(value) || 14));
  saveAppearance();
  applyAppearance();
  const label = document.getElementById('font-size-value');
  if (label) label.textContent = appearance.msgFontSize + 'px';
  updateFontPreview();
}

function setFontFamily(id) {
  if (!FONT_FAMILIES.some(f => f.id === id)) return;
  appearance.fontFamily = id;
  saveAppearance();
  applyAppearance();
  document.querySelectorAll('.font-chip').forEach(el =>
    el.classList.toggle('active', el.dataset.font === id));
  const row = document.getElementById('custom-font-row');
  if (row) row.style.display = id === 'custom' ? 'block' : 'none';
  updateFontPreview();
}

function setCustomFont(value) {
  appearance.fontCustom = sanitizeFontStack(value);
  saveAppearance();
  applyAppearance();
  updateFontPreview();
}

function setFontWeight(value) {
  const w = String(value);
  if (!FONT_WEIGHTS.includes(w)) return;
  appearance.msgFontWeight = w;
  saveAppearance();
  applyAppearance();
  document.querySelectorAll('.weight-chip').forEach(el =>
    el.classList.toggle('active', el.dataset.weight === w));
  updateFontPreview();
}

function setLineHeight(value) {
  const v = Number(value);
  if (!isFinite(v)) return;
  const step = LINE_HEIGHT.step;
  const clamped = Math.min(LINE_HEIGHT.max, Math.max(LINE_HEIGHT.min, v));
  appearance.msgLineHeight = Math.round(clamped / step) * step;
  appearance.msgLineHeight = Math.round(appearance.msgLineHeight * 100) / 100;
  saveAppearance();
  applyAppearance();
  const label = document.getElementById('line-height-value');
  if (label) label.textContent = appearance.msgLineHeight.toFixed(2);
  updateFontPreview();
}

function setFontScope(scope) {
  if (!['app', 'messages'].includes(scope)) return;
  appearance.fontScope = scope;
  saveAppearance();
  applyAppearance();
  document.querySelectorAll('.scope-chip').forEach(el =>
    el.classList.toggle('active', el.dataset.scope === scope));
  updateFontPreview();
}

function resetTypography() {
  const d = defaultAppearance();
  appearance.msgFontSize = d.msgFontSize;
  appearance.fontFamily = d.fontFamily;
  appearance.fontCustom = '';
  appearance.msgFontWeight = d.msgFontWeight;
  appearance.msgLineHeight = d.msgLineHeight;
  appearance.fontScope = d.fontScope;
  saveAppearance();
  applyAppearance();
  document.querySelectorAll('.font-chip').forEach(el =>
    el.classList.toggle('active', el.dataset.font === appearance.fontFamily));
  document.querySelectorAll('.weight-chip').forEach(el =>
    el.classList.toggle('active', el.dataset.weight === appearance.msgFontWeight));
  document.querySelectorAll('.scope-chip').forEach(el =>
    el.classList.toggle('active', el.dataset.scope === appearance.fontScope));
  const row = document.getElementById('custom-font-row');
  if (row) row.style.display = 'none';
  const input = document.getElementById('custom-font-input');
  if (input) input.value = '';
  const sizeLabel = document.getElementById('font-size-value');
  if (sizeLabel) sizeLabel.textContent = appearance.msgFontSize + 'px';
  const lhLabel = document.getElementById('line-height-value');
  if (lhLabel) lhLabel.textContent = appearance.msgLineHeight.toFixed(2);
  updateFontPreview();
  showToast(I18N.t('toast.typographyReset'), 'success');
}

function toggleTails() {
  appearance.tails = appearance.tails === false;
  saveAppearance();
  applyAppearance();
  const sw = document.getElementById('tails-switch');
  if (sw) sw.classList.toggle('on', appearance.tails !== false);
}

// ==================== PIN-КОД ====================
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function setPin() {
  const pin = (document.getElementById('settings-pin')?.value || '').trim();
  if (!/^\d{4,8}$/.test(pin)) {
    showToast(I18N.t('pin.format'), 'error');
    return;
  }
  privacy.pinHash = await sha256Hex(pin);
  savePrivacy();
  const input = document.getElementById('settings-pin');
  if (input) input.value = '';
  showToast(I18N.t('toast.pinSet'), 'success');
}

function removePin() {
  privacy.pinHash = '';
  savePrivacy();
  showToast(I18N.t('toast.pinRemoved'), 'success');
}

function showPinLock() {
  const el = document.getElementById('pin-lock-screen');
  if (!el) return;
  el.classList.add('show');
  const input = document.getElementById('pin-lock-input');
  const err = document.getElementById('pin-lock-error');
  if (err) err.textContent = '';
  if (input) { input.value = ''; input.focus(); }
}

function hidePinLock() {
  document.getElementById('pin-lock-screen')?.classList.remove('show');
}

async function unlockWithPin() {
  const input = document.getElementById('pin-lock-input');
  const err = document.getElementById('pin-lock-error');
  const pin = (input?.value || '').trim();
  if (!pin) { if (err) err.textContent = I18N.t('pin.enter'); return; }
  const hash = await sha256Hex(pin);
  if (hash === privacy.pinHash) {
    hidePinLock();
  } else {
    if (err) err.textContent = I18N.t('pin.wrong');
    if (input) input.value = '';
  }
}

function maybeLockApp() {
  if (privacy.pinHash && currentUser) showPinLock();
}

// ==================== E2EE: СБРОС И СТАТУС ====================
async function resetE2EE() {
  if (!confirm(I18N.t('confirm.resetKeys'))) return;
  try {
    identity = await E2EE.generateIdentity();
    writeIdentity(identityStorageKey(currentUser.id), identity);
    localStorage.setItem(IDENTITY_OWNER_KEY, String(currentUser.id));
    localStorage.removeItem(scopedStorageKey(SESSIONS_KEY));
    chatKeys = {};
    groupKeyBlobs = {};
    localStorage.removeItem(scopedStorageKey(GROUP_KEYS_KEY));
    clearPlaintextCache();
    await publishOwnPublicKey();
    // Владелец групп/каналов перевыпускает ключи: иначе старые группы
    // остались бы без ключа и перестали бы расшифровываться.
    for (const chat of chats.filter(c =>
      (c.type === 'group' || c.type === 'supergroup' || c.type === 'channel') &&
      c.owner_id === currentUser.id)) {
      try { await createAndPublishGroupKey(chat); } catch (e) { /* не критично */ }
    }
    showToast(I18N.t('toast.keysReset'), 'success');
    if (currentChatId) renderMessages(currentChatId);
  } catch (e) {
    showToast(I18N.t('err.resetKeys') + ' ' + e.message, 'error');
  }
}

function updateEncryptionBadge() {
  const badge = document.getElementById('enc-badge');
  if (!badge) return;
  const chat = getChatById(currentChatId);
  if (!chat) { badge.style.display = 'none'; return; }
  if (chat.type === 'private') {
    const other = chat.members?.find(m => m.id !== currentUser.id);
    const hasKey = other && other.public_key;
    badge.className = 'enc-badge' + (hasKey ? ' secured' : ' pending');
    badge.innerHTML = (hasKey ? Icons.svg('lock', { className: 'mq-icon--xs' }) : Icons.svg('clock', { className: 'mq-icon--xs' })) +
      `<span></span>`;
    badge.querySelector('span').textContent = hasKey ? 'E2EE' : I18N.t('chat.waitingKey');
  } else {
    badge.innerHTML = Icons.svg('shield-check', { className: 'mq-icon--xs' }) + `<span></span>`;
    badge.querySelector('span').textContent = I18N.t('chat.encGroup');
    badge.className = 'enc-badge secured';
  }
  badge.style.display = 'inline-flex';
}


// Медиа
const mediaCache = new Map(); // url -> objectUrl
const USER_STICKERS_KEY = 'ciphertalk_user_stickers';
// Пользовательские стикеры: { id, fileId, svg (dataURL-кэш для локальных),
// url (серверный путь /uploads/...), name, animated }
const userStickers = loadUserStickers();

function loadUserStickers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(USER_STICKERS_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((s) => s && s.id && (s.svg || s.url))
      : [];
  } catch (e) {
    return [];
  }
}

function saveUserStickers() {
  try {
    localStorage.setItem(USER_STICKERS_KEY, JSON.stringify(userStickers));
  } catch (e) { /* ignore */ }
}

// Подтягиваем серверные стикеры пользователя (E2EE: сам файл на сервере —
// шифротекст; здесь мы храним только URL и метаду).
async function fetchServerStickers() {
  if (!authToken) return;
  try {
    const res = await fetch(SERVER_URL + '/api/stickers', {
      headers: { Authorization: 'Bearer ' + authToken }
    });
    if (!res.ok) return;
    const data = await res.json();
    for (const s of (data.stickers || [])) {
      if (!userStickers.find((u) => u.id === s.id)) {
        userStickers.push({
          id: s.id,
          fileId: s.fileId,
          url: s.url,
          name: s.name,
          animated: !!s.animated,
          server: true
        });
      }
    }
    saveUserStickers();
  } catch (e) { /* сеть недоступна — работаем с локальным кэшем */ }
}
const activeMediaUrls = new Set(); // URL, которые сейчас используются для воспроизведения
let mediaRecorder = null;
let recordedChunks = [];
let recordingType = null;
let recordingInterval = null;
let recordingStartTime = 0;
let recordingStream = null;
let recordingMaxTimer = null;

// ==================== УТИЛИТЫ ====================
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function showToast(text, type = '', iconName = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  if (iconName) {
    toast.innerHTML = Icons.svg(iconName, { className: 'mq-icon--sm toast-icon' }) +
      `<span class="toast-text"></span>`;
    toast.querySelector('.toast-text').textContent = text;
  } else {
    toast.textContent = text;
  }
  container.appendChild(toast);
  setTimeout(() => {
    // Анимация выхода перед удалением
    toast.classList.add('closing');
    setTimeout(() => toast.remove(), 220);
  }, 3500);
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return I18N.t('date.yesterday');
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return I18N.t('date.today');
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return I18N.t('date.yesterday');
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatMessageTime(ts) {
  return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeen(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return I18N.t('time.justNow');
  if (diff < 3600000) return Math.floor(diff / 60000) + I18N.t('time.minAgo');
  if (diff < 86400000) return Math.floor(diff / 3600000) + I18N.t('time.hourAgo');
  return formatDate(ts);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return size + ' ' + I18N.t('size.b');
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' ' + I18N.t('size.kb');
  return (size / (1024 * 1024)).toFixed(1) + ' ' + I18N.t('size.mb');
}

function formatMessageText(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.*?)__/g, '<em>$1</em>');
  html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');
  html = html.replace(/`(.*?)`/g, '<code style="background:rgba(0,0,0,0.3);padding:2px 5px;border-radius:3px;font-family:monospace">$1</code>');
  html = html.replace(/(https?:\/\/[^\s<"'`]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">$1</a>');
  return html;
}

function typewriter(el, text) {
  const chars = Array.from(text);
  const caret = document.createElement('span');
  caret.className = 'typewriter-caret';
  el.textContent = '';
  el.appendChild(caret);

  if (chars.length > 220) {
    el.innerHTML = formatMessageText(text);
    return;
  }

  let i = 0;
  const tick = () => {
    if (i >= chars.length) {
      el.innerHTML = formatMessageText(text);
      return;
    }
    const step = chars.length > 120 ? 2 : 1;
    for (let k = 0; k < step && i < chars.length; k++) {
      caret.insertAdjacentText('beforebegin', chars[i]);
      i++;
    }
    const t = setTimeout(tick, 14);
    typewriterTimers.add(t);
  };
  const t0 = setTimeout(tick, 14);
  typewriterTimers.add(t0);
}

function normalizeUser(user) {
  if (!user) return user;
  return {
    ...user,
    name: user.name || user.firstName || user.first_name || '',
    firstName: user.firstName || user.first_name || '',
    lastName: user.lastName || user.last_name || ''
  };
}

// Участник чата внутри объекта чата: дополнительно нормализуем avatar,
// чтобы список чатов и шапка видели ссылку на картинку собеседника.
function normalizeUserMember(user) {
  const u = normalizeUser(user);
  if (u) u.avatar = normalizeAvatarValue(u.avatar);
  return u;
}

function normalizeChat(chat) {
  return {
    id: Number(chat.id),
    // Публичный id для ссылки в браузере (https://…/00000001, https://…/-00000000000001)
    public_id: String(chat.public_id || ''),
    type: chat.type || 'private',
    name: chat.name || '',
    // avatar может прийти строкой ('/uploads/..' или data-URL) или объектом —
    // нормализуем, иначе проверка «есть ли аватар» не срабатывала и рисовалась буква
    avatar: normalizeAvatarValue(chat.avatar),
    owner_id: chat.owner_id || null,
    role: chat.role || 'member',
    // other_user { id, avatar } приходит с сервера для приватных чатов —
    // без этого поля список чатов терял аватары собеседников (показывалась буква).
    other_user: chat.other_user
      ? { ...chat.other_user, avatar: normalizeAvatarValue(chat.other_user.avatar) }
      : null,
    members: Array.isArray(chat.members) ? chat.members.map(normalizeUserMember) : [],
    last_message: chat.last_message || '',
    last_message_iv: chat.last_message_iv || '',
    last_message_header: chat.last_message_header || '',
    last_message_type: chat.last_message_type || null,
    last_message_time: chat.last_message_time || 0,
    last_sender_id: chat.last_sender_id || 0,
    last_read_by: chat.last_read_by || {}
  };
}

// ==================== ПУБЛИЧНЫЕ ID / ССЫЛКИ В БРАУЗЕРЕ ====================
// Каждый чат имеет публичный id: пользователь — 8 знаков (00000001…99999999),
// группа/канал — отрицательный 14-значный (-00000000000001…).
// Открытый чат отображается в адресной строке как https://…/<публичный id>,
// «Избранное» = собственный id пользователя. Прямая загрузка такой ссылки
// открывает соответствующий чат.
let pendingUrlToken = null;

function chatTokenOf(chat) {
  if (!chat) return '';
  if (chat.public_id) return String(chat.public_id);
  // Личный чат без public_id (старый кэш) — id собеседника из members
  if (chat.type === 'private' && Array.isArray(chat.members)) {
    const other = chat.members.find(m => m && Number(m.id) !== Number(currentUser && currentUser.id));
    if (other && other.public_id) return String(other.public_id);
  }
  return '';
}

function syncUrlToChat(chat) {
  try {
    const token = chat ? chatTokenOf(chat) : '';
    const url = token ? '/' + encodeURIComponent(token) : '/';
    if (location.pathname !== url) history.pushState({ ctToken: token || null }, '', url);
  } catch (e) { /* не критично */ }
}

function readChatTokenFromUrl() {
  const m = decodeURIComponent(location.pathname || '').match(/^\/(-?\d{1,14})\/?$/);
  return m ? m[1] : null;
}

function openChatByToken(token) {
  token = String(token || '');
  if (!token) return;
  // Сначала пробуем найти чат с таким публичным id локально
  const local = chats.find(c => chatTokenOf(c) === token);
  if (local) {
    pendingUrlToken = null;
    openChat(local.id);
    return;
  }
  // Иначе просим сервер разобрать токен (ответ: 'public_resolved')
  pendingUrlToken = token;
  sendWs({ type: 'resolve_public_id', token });
}

window.addEventListener('popstate', () => {
  const t = readChatTokenFromUrl();
  if (!t) {
    if (currentChatId != null) closeChat();
    return;
  }
  if (t !== readCurrentUrlToken()) openChatByToken(t);
});

function readCurrentUrlToken() {
  const c = currentChatId != null ? getChatById(currentChatId) : null;
  return c ? chatTokenOf(c) : '';
}

// ==================== ВЛАДЕЛЕЦ ПРОЕКТА ====================
// Только серверный флаг is_owner. Телефон на клиенте не сравниваем:
// у чужих участников он замаскирован, а у обычных аккаунтов может
// случайно совпасть после нормализации.
function isOwnerUser(user) {
  if (!user) return false;
  return Number(user.is_owner) === 1 || user.is_owner === true;
}

// Бейдж в шапке — только для личного чата с владельцем.
// Названия групп/каналов и «Избранное» владельцем не являются.
function chatOwner(chat) {
  if (!chat || chat.type !== 'private' || !currentUser) return null;
  return (chat.members || []).find(m => m.id !== currentUser.id && isOwnerUser(m)) || null;
}

function ownerBadgeHtml() {
  const label = escapeHtml(I18N.t('owner.badge'));
  return '<span class="owner-badge" role="img" aria-label="' + label + '" data-tooltip="' + label + '">' +
    '<svg class="owner-badge__crown" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M3 8.2l4.4 3.2L12 4l4.6 7.4L21 8.2 19.4 19H4.6L3 8.2z"/>' +
    '<path d="M8 22h8"/></svg>' +
    '<svg class="owner-badge__check" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M5 12.5l4.2 4.2L19 7"/></svg></span>';
}

function appendOwnerBadge(parent, target) {
  if (!parent || !isOwnerUser(target)) return false;
  const slot = document.createElement('span');
  slot.className = 'owner-badge-slot';
  slot.innerHTML = ownerBadgeHtml();
  parent.appendChild(slot);
  return true;
}
function customBadgeHtml() {
  const badge = BADGE_CHOICES.find(b => b.id === privacy.badge);
  if (!badge || !badge.icon) return '';
  const label = escapeHtml(I18N.t(badge.label));
  return '<span class="user-badge" role="img" aria-label="' + label + '" data-tooltip="' + label + '">' +
    Icons.svg(badge.icon, { className: 'user-badge__icon' }) + '</span>';
}

let privacyGuardBound = false;

// Защита от скриншотов: blur при уходе из вкладки и на PrintScreen.
// Полностью ОС-скриншоты не блокирует, но скрывает содержимое в эти моменты.
function applyPrivacyFeatures() {
  const root = document.documentElement;
  root.classList.toggle('mq-screenshot-guard', !!privacy.screenshotGuard);
  if (!privacy.screenshotGuard) root.classList.remove('mq-privacy-blur');
  if (!privacyGuardBound && privacy.screenshotGuard) {
    privacyGuardBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!privacy.screenshotGuard) return;
      document.documentElement.classList.toggle('mq-privacy-blur', document.visibilityState !== 'visible');
    });
    document.addEventListener('keydown', (e) => {
      if (!privacy.screenshotGuard || e.key !== 'PrintScreen') return;
      const root = document.documentElement;
      root.classList.add('mq-privacy-blur');
      setTimeout(() => {
        if (document.visibilityState === 'visible') root.classList.remove('mq-privacy-blur');
      }, 1200);
    });
  }
}

function panicLock() {
  try {
    if (typeof clearPlaintextCache === 'function') clearPlaintextCache();
  } catch (e) { /* ignore */ }
  try { sessionStorage.clear(); } catch (e) { /* ignore */ }
  try {
    localStorage.removeItem('ciphertalk_token');
    localStorage.removeItem('ciphertalk_user');
  } catch (e) { /* ignore */ }
  clearSession(false);
  location.replace(location.pathname);
}

// ==================== АВТОУДАЛЕНИЕ СООБЩЕНИЙ ====================
const CHAT_TTL_KEY = 'ciphertalk_chat_ttl';
const TTL_CHOICES = [0, 60, 300, 3600, 86400];
const TTL_LABEL_KEYS = { 0: 'ttl.off', 60: 'ttl.1m', 300: 'ttl.5m', 3600: 'ttl.1h', 86400: 'ttl.1d' };

function readChatTtlMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_TTL_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function getChatTtl(chatId) {
  const value = Number(readChatTtlMap()[String(chatId)]);
  return TTL_CHOICES.includes(value) ? value : 0;
}

function ttlLabel(seconds) {
  return I18N.t(TTL_LABEL_KEYS[Number(seconds)] || 'ttl.off');
}

function setChatTtl(chatId, seconds) {
  const value = TTL_CHOICES.includes(Number(seconds)) ? Number(seconds) : 0;
  const map = readChatTtlMap();
  if (value) map[String(chatId)] = value;
  else delete map[String(chatId)];
  try { localStorage.setItem(CHAT_TTL_KEY, JSON.stringify(map)); } catch (e) {}
  updateChatHeader();
}

const expiryTimers = new Map();

function expiryKey(chatId, messageId) {
  return String(chatId) + ':' + String(messageId);
}

function scheduleMessageExpiry(chatId, message) {
  const expiresAt = Number(message && message.expires_at);
  if (!chatId || !expiresAt) return;
  const key = expiryKey(chatId, message.id);
  if (expiryTimers.has(key)) clearTimeout(expiryTimers.get(key));
  const delay = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    expiryTimers.delete(key);
    const list = messages[chatId];
    if (!list) return;
    const index = list.findIndex(m => m.id === message.id);
    if (index < 0) return;
    list.splice(index, 1);
    if (currentChatId === Number(chatId)) renderMessages(Number(chatId));
  }, Math.min(delay, 2147483647));
  expiryTimers.set(key, timer);
}

function cancelMessageExpiry(chatId, messageId) {
  const key = expiryKey(chatId, messageId);
  const timer = expiryTimers.get(key);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(key);
}

function normalizeMessage(m) {
  return {
    id: Number(m.id),
    chat_id: Number(m.chat_id ?? m.chatId),
    sender_id: Number(m.sender_id ?? m.senderId),
    sender_name: m.sender_name ?? m.senderName ?? '',
    sender_avatar: m.sender_avatar ?? '',
    encrypted_content: m.encrypted_content ?? m.content ?? '',
    iv: m.iv || '',
    header: m.header || m.last_message_header || '',
    type: m.type || 'text',
    reply_to: m.reply_to ?? m.replyTo ?? null,
    edited: m.edited || 0,
    deleted_for_all: m.deleted_for_all || m.deletedForAll || 0,
    forwarded_from: m.forwarded_from ?? m.forwardedFrom ?? null,
    reactions: m.reactions || {},
    pinned: m.pinned || 0,
    expires_at: Number(m.expires_at ?? m.expiresAt) || null,
    created_at: Number(m.created_at ?? m.createdAt ?? Date.now())
  };
}

function getChatById(chatId) {
  return chats.find(c => c.id === Number(chatId));
}

function getChatName(chat) {
  if (!chat) return I18N.t('chat.generic');
  if (chat.type === 'saved') return I18N.t('chat.saved');
  if (chat.type === 'group' || chat.type === 'supergroup') return chat.name || I18N.t('chat.group');
  if (chat.type === 'private') {
    const other = chat.members?.find(m => m.id !== currentUser?.id);
    return other?.name || other?.phone || I18N.t('chat.generic');
  }
  return chat.name || I18N.t('chat.generic');
}

function getChatAvatar(chat) {
  if (chat.type === 'saved') return '*';
  const name = getChatName(chat);
  return name[0]?.toUpperCase() || '?';
}

// Иконка аватара чата (для «Избранного» — звезда вместо буквы)
function getChatAvatarIcon(chat) {
  return chat && chat.type === 'saved' ? 'star' : null;
}

// Ссылки на загруженные файлы отдаются сервером как зашифрованный поток
// и требуют Authorization-заголовка, поэтому обычный <img src> их не грузит.
// Читаем их fetch'ем с токеном и подставляем blob-URL.
const avatarBlobCache = new Map(); // url -> Promise<blobUrl|''>
const avatarFailCache = new Map(); // url -> время ошибки (кратковременно, чтобы не долбить сервер)
const AVATAR_FAIL_TTL = 30000;

// Отдельный ретраимый fetch аватара: НЕ использует общий api(), который
// при 401 разлогинивает пользователя. Если токен ещё не готов или файл
// временно недоступен — возвращаем null (это «не ответ, а сбой») и
// вызывающий код повторит попытку позже; пустая строка '' — картинку
// точно нет смысла тянуть дальше.
async function fetchAvatarBlobUrl(url) {
  if (!authToken) return null; // подождём завершения логина
  const failAt = avatarFailCache.get(url);
  if (failAt && Date.now() - failAt < AVATAR_FAIL_TTL) return '';
  try {
    const res = await fetch(SERVER_URL + url, {
      method: 'GET',
      cache: 'default',
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    if (res.status === 401 || res.status === 403) { avatarFailCache.set(url, Date.now()); return null; }
    if (!res.ok) { avatarFailCache.set(url, Date.now()); return ''; }
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) { avatarFailCache.set(url, Date.now()); return ''; }
    // Сервер отдаёт файлы как application/octet-stream + nosniff, поэтому
    // MIME определяем по сигнатуре байтов (PNG/JPEG/GIF/WebP).
    const type = sniffImageMime(buf) || 'image/jpeg';
    return URL.createObjectURL(new Blob([buf], { type }));
  } catch (e) {
    return null; // сетевая ошибка — попробуем позже
  }
}

async function resolveAvatarSrc(rawUrl) {
  const url = normalizeAvatarValue(rawUrl);
  if (!url) return '';
  if (!url.startsWith('/uploads/')) return url; // data: и внешние http(s): грузятся напрямую
  if (avatarBlobCache.has(url)) return avatarBlobCache.get(url);
  const p = (async () => {
    const first = await fetchAvatarBlobUrl(url);
    if (first !== null) return first;
    // Временный сбой (нет токена / сеть / 401): повтор с backoff,
    // чтобы аватары появились сразу после инициализации.
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
      const again = await fetchAvatarBlobUrl(url);
      if (again !== null) return again;
    }
    return '';
  })().then(v => { if (v === '') avatarBlobCache.delete(url); return v; });
  avatarBlobCache.set(url, p);
  return p;
}

function sniffImageMime(buf) {
  const b = new Uint8Array(buf.slice ? buf.slice(0, 4) : buf);
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[3] === 0x46) return 'image/webp';
  return '';
}

// Единая точка чтения аватара чата. Порядок поиска: собственное поле чата
// (аватар группы/канала или заполненное сервером поле приватного чата),
// затем other_user / members[].avatar для приватных чатов. Раньше эти поля
// не читались, из-за чего всегда срабатывал fallback на первую букву.
function getChatAvatarUrl(chat) {
  if (!chat) return '';
  // saved («Избранное») — всегда иконка, картинки нет
  if (chat.type === 'saved') return '';
  const own = normalizeAvatarValue(chat.avatar);
  if (own) return own;
  if (chat.type === 'private' || chat.type === 'group' || chat.type === 'supergroup') {
    const me = Number(currentUser && currentUser.id);
    if (Array.isArray(chat.members)) {
      // Приватный чат: аватар собеседника. Группа: имя может быть не
      // заполнено — тогда показываем аватар одного из участников.
      const other = chat.type === 'private'
        ? chat.members.find(m => m && Number(m.id) !== me)
        : chat.members.find(m => m && normalizeAvatarValue(m.avatar));
      const memberAvatar = normalizeAvatarValue(other && other.avatar);
      if (memberAvatar) return memberAvatar;
    }
    const ou = normalizeAvatarValue(chat.other_user && chat.other_user.avatar);
    if (ou) return ou;
  }
  return '';
}

// Приводим любое «сырое» значение аватара к строке-ссылке: бэкенд отдаёт
// '/uploads/<файл>' или data-URL, но в отдельных местах (кэш IndexedDB,
// ответы сервера) поле могло приходить объектом { url/path/avatar }.
function normalizeAvatarValue(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v.url || v.path || v.avatar || '').trim();
  return '';
}

// Картинка аватара никогда не должна «расползаться» за круг контейнера
// (в т.ч. в панели информации о чате, где размер задаётся инлайн-стилем).
const AVATAR_IMG_STYLE = 'width:100%;height:100%;max-width:100%;max-height:100%;' +
  'border-radius:50%;object-fit:cover;display:block';

// Встроенные SVG-иконки могут быть больше контейнера — ограничиваем их.
const AVATAR_ICON_STYLE = 'max-width:60%;max-height:60%';

// Подставляем blob-URL для защищённых /uploads/-ссылок (нужен Authorization-
// заголовок, обычный <img src> такие ссылки не грузит). При неудаче —
// возвращаем исходный url, чтобы вызывающий код показал буквенную заглушку.
function attachResolvedAvatar(imgEl, url) {
  if (!imgEl || !url) return;
  if (!url.startsWith('/uploads/')) { imgEl.src = url; return; }
  resolveAvatarSrc(url).then((src) => {
    if (src && src !== '') imgEl.src = src;
    else if (typeof imgEl.remove === 'function') imgEl.remove();
  });
}

// Аватар в разметке, генерируемой строкой (модалки, панель информации, поиск).
// Если аватарки нет — ДИНАМИЧЕСКАЯ первая буква имени конкретного чата.
// Контейнер (.chat-avatar/.fi-avatar/.member-avatar) красит синий круг сам,
// поэтому сюда возвращаем только содержимое.
function chatAvatarMarkup(chat) {
  const icon = getChatAvatarIcon(chat);
  if (icon) return `<span class="chat-avatar__icon" style="${AVATAR_ICON_STYLE}">${Icons.svg(icon, { className: 'mq-icon--lg' })}</span>`;
  const letter = escapeHtml(getChatAvatar(chat));
  const url = normalizeAvatarValue(getChatAvatarUrl(chat));
  if (!url) return `<span class="chat-avatar__letter">${letter}</span>`;
  const safe = escapeHtml(url).replace(/"/g, '&quot;');
  // alt = динамическая первая буква имени — заглушка, пока картинка грузится.
  // Защищённые /uploads/ ссылки сервер не отдаёт по прямому <img src>, поэтому
  // src оставляем пустым, кладём путь в data-avatar-path и подгружаем blob-URL
  // через hydrateAvatars()/hydrateAvatarImages() (fetch + Bearer-токен).
  if (url.startsWith('/uploads/')) {
    return `<span class="chat-avatar__wrap"><span class="chat-avatar__letter">${letter}</span><img class="chat-avatar__img" src="" data-avatar-path="${safe}" alt="${letter}" style="${AVATAR_IMG_STYLE}" loading="lazy"></span>`;
  }
  return `<span class="chat-avatar__wrap"><span class="chat-avatar__letter">${letter}</span><img class="chat-avatar__img" src="${safe}" alt="${letter}" style="${AVATAR_IMG_STYLE}" loading="lazy"></span>`;
}

// Аватар произвольного пользователя (результаты поиска, списки участников):
// <img>, если аватар есть в базе; иначе — ДИНАМИЧЕСКАЯ первая буква имени.
// Поддерживает и объект пользователя, и просто строку-имя (для совместимости
// со старыми вызовами).
function userAvatarMarkup(user) {
  if (typeof user === 'string') {
    return `<span class="chat-avatar__letter">${escapeHtml((user.trim()[0] || '?').toUpperCase())}</span>`;
  }
  const name = (user && (user.name || user.firstName || user.username)) || '';
  const letter = escapeHtml((name.trim()[0] || '?').toUpperCase());
  const url = normalizeAvatarValue(user && user.avatar);
  if (!url) return `<span class="chat-avatar__letter">${letter}</span>`;
  const safe = escapeHtml(url).replace(/"/g, '&quot;');
  // /uploads/ — защищённые ссылки: пустой src + data-avatar-path, картинку
  // догружает hydrateAvatars()/hydrateAvatarImages() через fetch с токеном.
  if (url.startsWith('/uploads/')) {
    return `<span class="chat-avatar__wrap"><span class="chat-avatar__letter">${letter}</span><img class="chat-avatar__img" src="" data-avatar-path="${safe}" alt="${letter}" style="${AVATAR_IMG_STYLE}" loading="lazy"></span>`;
  }
  return `<span class="chat-avatar__wrap"><span class="chat-avatar__letter">${letter}</span><img class="chat-avatar__img" src="${safe}" alt="${letter}" style="${AVATAR_IMG_STYLE}" loading="lazy"></span>`;
}

// Единая точка рендера строковой аватар-разметки в DOM-контейнер с
// гарантированной деградацией: если ссылка ведёт в защищённый /uploads/
// (нужен Authorization-заголовок, обычный <img src> её не грузит) —
// подтягиваем blob; при любой неудаче остаётся ДИНАМИЧЕСКАЯ первая буква
// имени (раньше битая <img> оставляла пустой синий круг).
function paintAvatar(el, markup) {
  if (!el) return;
  el.innerHTML = markup;
  const img = el.querySelector ? el.querySelector('img.chat-avatar__img') : null;
  if (!img) return;
  const letter = el.querySelector('.chat-avatar__letter');
  // hydrateAvatars(): подгружает blob и для data-avatar-path, и для прямых
  // /uploads/ ссылок в src (старый формат разметки).
  hydrateAvatars(el);
  // Если после гидратации src всё ещё пустой (защищённый путь), держим в
  // резерве буквенную деградацию: при неудаче — первая буква вместо круга.
  const path = normalizeAvatarValue(img.getAttribute('data-avatar-path')) || (img.getAttribute('src') || '');
  if (!path.startsWith('/uploads/')) return; // data:/внешние URL грузятся напрямую
  resolveAvatarSrc(path).then((resolved) => {
    if (!resolved) {
      // Картинку получить не удалось — показываем первую букву вместо круга
      if (el.isConnected) {
        img.style.display = 'none';
        if (letter) letter.style.display = 'flex';
      }
      return;
    }
    if (el.isConnected && img.isConnected) {
      img.src = resolved;
      img.style.display = 'block';
      if (letter) letter.style.display = 'none';
    }
  });
}

// Заменяет содержимое контейнера-аватара на буквенную заглушку или <img>.
// Используется после загрузки string-разметки (chatAvatarMarkup), чтобы
// дорисовать картинки из /uploads/, требующие Authorization-заголовка.
function hydrateAvatarImages(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('img.chat-avatar__img').forEach((img) => {
    // data-avatar-path — «сырая» ссылка из БД (/uploads/..), src при этом
    // пустой: сервер блокирует защищённые файлы для обычных <img>, поэтому
    // картинку подгружаем асинхронно fetch'ем с Bearer-токеном (см. ниже).
    const path = img.getAttribute('data-avatar-path') || '';
    if (path) { attachResolvedAvatar(img, path); return; }
    const src = img.getAttribute('src') || '';
    if (src.startsWith('/uploads/')) attachResolvedAvatar(img, src);
  });
}

// Гидратация аватаров после рендера списка чатов (.chat-list .mq-stagger)
// и шапки открытого чата (#chat-header-avatar): находит ВСЕ теги с
// data-avatar-path, делает fetch к бэкенду с заголовком
// `Authorization: Bearer ${authToken}` (см. resolveAvatarSrc/fetchAvatarBlobUrl),
// переводит ответ в Blob URL (URL.createObjectURL) и прописывает его в src.
// Если картинку получить не удалось — в контейнере остаётся динамическая
// первая буква названия чата (никаких пустых синих кругов).
function hydrateAvatars(root) {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  hydrateAvatarImages(scope);
  scope.querySelectorAll('img[data-avatar-path]').forEach((img) => {
    const path = normalizeAvatarValue(img.getAttribute('data-avatar-path'));
    if (!path) return;
    if (!img.classList.contains('chat-avatar__img')) {
      img.classList.add('chat-avatar__img');
      if (!img.style.cssText.includes('object-fit')) img.style.cssText = AVATAR_IMG_STYLE;
    }
    attachResolvedAvatar(img, path);
  });
}

// Инкрементальная перерисовка аватара: сравниваем «подпись» состояния
// (иконка/буква/URL картинки) и не трогаем DOM, если ничего не изменилось.
function avatarStateKey(el, chat) {
  const icon = getChatAvatarIcon(chat);
  const url = normalizeAvatarValue(getChatAvatarUrl(chat));
  return `${icon ? 'i:' + icon : ''}|l:${getChatAvatar(chat)}|u:${url}`;
}

// Содержимое круглого контейнера аватара чата: при наличии chat.avatar —
// <img data-avatar-path="..." src=""> (путь из БД; защищённые /uploads/
// сервер не отдаёт по прямому src, картинку подгружает hydrateAvatars()
// через fetch + Authorization: Bearer), иначе — динамическая первая буква
// названия чата/группы. Возвращает DOM-узлы (не HTML-строку).
function buildChatAvatarNodes(chat) {
  const frag = document.createDocumentFragment();
  if (!chat) return frag;
  const icon = getChatAvatarIcon(chat);
  if (icon) {
    const span = document.createElement('span');
    span.className = 'chat-avatar__icon';
    span.style.cssText = AVATAR_ICON_STYLE;
    span.innerHTML = Icons.svg(icon, { className: 'mq-icon--lg' });
    frag.appendChild(span);
    return frag;
  }
  // Динамическая первая буква названия чата/группы (никакого хардкода «U»):
  // она остаётся видимой, пока картинка грузится, и если аватара нет вовсе.
  const letter = getChatAvatar(chat);
  const url = normalizeAvatarValue(getChatAvatarUrl(chat));
  if (!url) {
    frag.textContent = letter;
    return frag;
  }
  // Буква всегда добавляется как текстовый фолбэк — видна сразу, остаётся если
  // картинка не загрузится.  imágenes накладываются поверх буквы.
  const letterWrap = document.createElement('span');
  letterWrap.className = 'chat-avatar__letter';
  letterWrap.textContent = letter;
  letterWrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:2;pointer-events:none;';
  frag.appendChild(letterWrap);

  const img = document.createElement('img');
  img.className = 'chat-avatar__img';
  img.alt = letter;
  img.style.cssText = AVATAR_IMG_STYLE + ';position:absolute;inset:0;z-index:1;';
  img.loading = 'lazy';
  img.onerror = () => {
    img.style.display = 'none';
    letterWrap.style.display = 'flex';
  };
  img.onload = () => {
    img.style.display = 'block';
    letterWrap.style.display = 'none';
  };
  if (url.startsWith('/uploads/')) {
    // Пустой src + data-avatar-path: blob-URL пропишет hydrateAvatars().
    img.setAttribute('src', '');
    img.setAttribute('data-avatar-path', url);
    img.style.display = 'none'; // скрыто пока не загрузится через fetch
    letterWrap.style.display = 'flex'; // буква видна пока картинки нет
    resolveAvatarSrc(url).then((src) => {
      if (!frag.isConnected) return;
      if (src && src !== '') {
        img.src = src;
        img.style.display = 'block';
        letterWrap.style.display = 'none';
      } else {
        img.style.display = 'none';
        letterWrap.style.display = 'flex';
      }
    });
  } else {
    img.src = url; // data:/внешние URL грузятся напрямую
    img.style.display = 'block';
    letterWrap.style.display = 'none';
  }
  frag.appendChild(img);
  return frag;
}

// Аватар пользователя в шапке бокового меню / панели профиля.
// Картинка из БД (<img>), иначе — ДИНАМИЧЕСКАЯ первая буква имени.
// Файлы из /uploads/ требуют Authorization-заголовок — дотягиваем их fetch'ем.
function setUserAvatar(el, user) {
  if (!el || !user) return;
  const name = String(user.name || user.firstName || user.username || '').trim();
  const letter = (name[0] || '?').toUpperCase();
  const url = normalizeAvatarValue(user.avatar);
  el.dataset.avatarKey = `l:${letter}|u:${url}`;
  // Сначала буква — она видима сразу и остаётся, если картинки нет/ошибка
  el.textContent = letter;
  if (!url) return;
  const apply = (src) => {
    if (!el.isConnected || el.dataset.avatarKey !== `l:${letter}|u:${url}`) return;
    if (!src) return;
    el.textContent = '';
    const img = document.createElement('img');
    img.className = 'chat-avatar__img';
    img.src = src;
    img.alt = letter;
    img.style.cssText = AVATAR_IMG_STYLE;
    el.appendChild(img);
  };
  if (url.startsWith('/uploads/')) resolveAvatarSrc(url).then(apply);
  else apply(url);
}

function setChatAvatar(el, chat) {
  if (!el || !chat) return;
  const key = avatarStateKey(el, chat);
  // Узел уже в актуальном состоянии: картинка (в т.ч. с data-avatar-path)
  // или иконка на месте — не трогаем DOM, чтобы не моргать при ререндере.
  if (el.dataset.avatarKey === key && el.querySelector('img.chat-avatar__img, .chat-avatar__icon')) return;
  el.dataset.avatarKey = key;

  // Единая логика для списка чатов (.chat-list .mq-stagger) и шапки
  // открытого чата (#chat-header-avatar): есть аватар — <img> с
  // data-avatar-path (blob подгрузит hydrateAvatars), нет — динамическая
  // первая буква названия чата/группы. Хардкода «U» и пустых кругов нет.
  el.textContent = '';
  el.appendChild(buildChatAvatarNodes(chat));

  // buildChatAvatarNodes уже сам вызывает resolveAvatarSrc и переключает display,
  // поэтому здесь второй вызов не нужен — он только ломает DOM (заменяет всё на букву).
  return el;
}

function isChatOnline(chat) {
  if (!chat || chat.type !== 'private') return false;
  const other = chat.members?.find(m => m.id !== currentUser?.id);
  return other ? onlineUsers.has(other.id) : false;
}

// ==================== HTTP ====================
async function api(path, options = {}) {
  const { method = 'GET', body, auth = true } = options;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && authToken) headers['Authorization'] = 'Bearer ' + authToken;

  const res = await fetch(SERVER_URL + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data: data || {} };
}

// ==================== КРИПТОГРАФИЯ ====================
// ==================== E2EE (общий модуль /e2ee.js) ====================
const E2EE = window.CipherTalkE2EE;

const IDENTITY_KEY = 'ciphertalk_identity';
const IDENTITY_OWNER_KEY = 'ciphertalk_identity_owner';
const SESSIONS_KEY = 'ciphertalk_sessions';
const GROUP_KEYS_KEY = 'ciphertalk_group_keys';

let identity = null;         // { publicKey, privateKey } в base64
let chatKeys = {};           // chatId -> { kind: 'direct'|'group', session?, groupKey? }
let groupKeyBlobs = {};      // chatId -> { version, wrapped, createdBy }

// Ключи, сессии и кэш расшифровок привязаны к аккаунту. Иначе на одном
// устройстве второй пользователь мог бы использовать чужой приватный ключ.
function identityStorageKey(userId) {
  return `${IDENTITY_KEY}_u${userId}`;
}

function scopedStorageKey(base) {
  return currentUser ? `${base}_u${currentUser.id}` : base;
}

function readIdentity(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    if (parsed && parsed.publicKey && parsed.privateKey) return parsed;
  } catch (e) { /* ignore */ }
  return null;
}

function writeIdentity(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function assertWebCrypto() {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error(I18N.t('err.webcrypto'));
  }
  if (!E2EE) throw new Error('Модуль шифрования /e2ee.js не загружен');
}

async function getOrCreateIdentity() {
  const saved = readIdentity(IDENTITY_KEY);
  if (saved) return saved;
  const created = await E2EE.generateIdentity();
  writeIdentity(IDENTITY_KEY, created);
  return created;
}

async function ensureLocalIdentity() {
  if (!identity) identity = await getOrCreateIdentity();
  return identity;
}

// При входе закрепляем личность за конкретным аккаунтом. Первый пользователь
// на устройстве может унаследовать уже созданную пару, остальные получают
// собственную — приватный ключ одного аккаунта не достаётся другому.
async function ensureIdentityForUser(userId) {
  const key = identityStorageKey(userId);
  let saved = readIdentity(key);

  if (!saved) {
    const legacy = readIdentity(IDENTITY_KEY);
    const owner = Number(localStorage.getItem(IDENTITY_OWNER_KEY) || 0);
    if (legacy && (!owner || owner === userId)) {
      saved = legacy;
      // Однократно переносим состояние старого формата в пространство аккаунта.
      for (const base of [SESSIONS_KEY, GROUP_KEYS_KEY, PLAINTEXT_CACHE_KEY]) {
        const oldValue = localStorage.getItem(base);
        const newKey = `${base}_u${userId}`;
        if (oldValue && !localStorage.getItem(newKey)) localStorage.setItem(newKey, oldValue);
      }
    } else {
      saved = await E2EE.generateIdentity();
    }
    writeIdentity(key, saved);
  }

  localStorage.setItem(IDENTITY_OWNER_KEY, String(userId));
  identity = saved;
  chatKeys = {};
  plaintextCache.clear();
  persistedPlaintext = null;
  // Групповые ключи тоже хранятся в пространстве аккаунта.
  groupKeyBlobs = loadGroupKeyBlobs();
  return identity;
}

// Локальная пара ключей E2EE для входа/регистрации (base64 SPKI/PKCS8).
// Ключ тот же, что публикуется собеседникам через publishOwnPublicKey().
async function getOrCreateLocalKeyPair() {
  return ensureLocalIdentity();
}

function loadSessionMap() {
  try {
    return JSON.parse(localStorage.getItem(scopedStorageKey(SESSIONS_KEY))) || {};
  } catch (e) {
    return {};
  }
}

function saveSession(chatId, session) {
  const all = loadSessionMap();
  all[chatId] = E2EE.serializeSession(session);
  localStorage.setItem(scopedStorageKey(SESSIONS_KEY), JSON.stringify(all));
}

function loadSession(chatId) {
  const all = loadSessionMap();
  return all[chatId] ? E2EE.deserializeSession(all[chatId]) : null;
}

function loadGroupKeyBlobs() {
  try {
    return JSON.parse(localStorage.getItem(scopedStorageKey(GROUP_KEYS_KEY))) || {};
  } catch (e) {
    return {};
  }
}

function saveGroupKeyBlobs() {
  localStorage.setItem(scopedStorageKey(GROUP_KEYS_KEY), JSON.stringify(groupKeyBlobs));
}

// Ожидание группового ключа от сервера
const pendingGroupKeys = new Map();

function requestGroupKey(chatId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingGroupKeys.delete(chatId);
      reject(new Error(I18N.t('err.groupKeyTimeout')));
    }, 6000);
    pendingGroupKeys.set(chatId, { resolve, reject, timer });
    sendWs({ type: 'get_group_key', chatId });
  });
}

function resolveGroupKey(chatId, payload) {
  const entry = pendingGroupKeys.get(chatId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingGroupKeys.delete(chatId);
  entry.resolve(payload);
}

// ==================== КЛЮЧИ ЧАТОВ ====================

async function getChatKey(chatId, chat) {
  if (chatKeys[chatId]) return chatKeys[chatId];
  if (!chat) throw new Error(I18N.t('err.chatNotFound'));
  const me = await ensureLocalIdentity();

  if (chat.type === 'private' || chat.type === 'saved') {
    let peerKey = null;
    if (chat.type === 'saved') {
      // «Избранное»: шифруем сами с собой (ECDH с собственным ключом)
      peerKey = me.publicKey;
    } else {
      const other = chat.members?.find(m => m.id !== currentUser.id) || chat.members?.[0];
      if (!other) throw new Error(I18N.t('err.noPeer'));
      peerKey = await E2EE.normalizePublicKey(other.public_key);
      if (!peerKey) {
        const fetched = await waitForPublicKey(other.id);
        peerKey = await E2EE.normalizePublicKey(fetched);
        other.public_key = peerKey;
      }
    }
    if (!peerKey) throw new Error(I18N.t('err.peerNoKey'));

    let session = loadSession(chatId);
    if (!session || session.peerPublicKey !== peerKey) {
      session = await E2EE.createDirectSession(me, peerKey);
      saveSession(chatId, session);
    }
    chatKeys[chatId] = { kind: 'direct', session };
    return chatKeys[chatId];
  }

  const groupKey = await ensureGroupKey(chat);
  chatKeys[chatId] = { kind: 'group', groupKey };
  return chatKeys[chatId];
}

async function ensureGroupKey(chat) {
  const chatId = chat.id;
  if (chatKeys[chatId] && chatKeys[chatId].kind === 'group') return chatKeys[chatId].groupKey;

  let state = groupKeyBlobs[chatId];
  if (!state || !state.mine) {
    state = await requestGroupKey(chatId);
  }
  if (!state || !state.mine) throw new Error(I18N.t('err.groupKeyMissing'));

  const me = await ensureLocalIdentity();
  const creatorId = Number(state.createdBy) || 0;
  if (creatorId === currentUser.id) return await unwrapOwn(state);
  let creator = chat.members?.find(m => m.id === creatorId);
  let creatorKey = await E2EE.normalizePublicKey(creator?.public_key);
  if (!creatorKey) {
    // Владелец ключа мог не быть в списке/не опубликовать ключ — запрашиваем его
    try {
      const fetchedOwner = await waitForPublicKey(creatorId, 6000);
      creatorKey = await E2EE.normalizePublicKey(fetchedOwner);
      if (creator) creator.public_key = creatorKey;
    } catch (e) { /* ignore */ }
  }
  if (!creatorKey) throw new Error(I18N.t('err.ownerKeyMissing'));

  const groupKey = await E2EE.unwrapGroupKey(state.mine, me, creatorKey);
  chatKeys[chatId] = { kind: 'group', groupKey };
  return groupKey;

  async function unwrapOwn(st) {
    const gk = await E2EE.unwrapGroupKey(st.mine, me, me.publicKey);
    chatKeys[chatId] = { kind: 'group', groupKey: gk };
    return gk;
  }
}

// Создаёт и публикует групповой ключ (вызывается создателем группы/канала)
async function publishGroupKey(chat, groupKeyBytes, version) {
  const me = await ensureLocalIdentity();
  const wrapped = {};
  for (const member of chat.members || []) {
    const mk = await E2EE.normalizePublicKey(member.public_key);
    if (!mk) continue;
    wrapped[member.id] = await E2EE.wrapGroupKey(groupKeyBytes, me, mk);
  }
  if (!wrapped[currentUser.id]) {
    wrapped[currentUser.id] = await E2EE.wrapGroupKey(groupKeyBytes, me, me.publicKey);
  }
  const ver = version || 1;
  groupKeyBlobs[chat.id] = {
    version: ver,
    wrapped,
    mine: wrapped[currentUser.id],
    createdBy: currentUser.id
  };
  saveGroupKeyBlobs();
  chatKeys[chat.id] = { kind: 'group', groupKey: groupKeyBytes };
  sendWs({ type: 'set_group_key', chatId: chat.id, version: ver, wrapped });
  return wrapped;
}

// Добавляет участника в группу: групповой ключ перезаворачивается заново
// для ВСЕХ участников (владельцем этой версии становится тот, кто перезавернул),
// иначе новый участник не смог бы расшифровать свой блоб.
async function shareGroupKeyWithMember(chat, member) {
  const me = await ensureLocalIdentity();
  const memberKey = await E2EE.normalizePublicKey(member.public_key);
  if (!memberKey) throw new Error(I18N.t('err.memberNoKey'));
  const groupKey = await ensureGroupKey(chat);
  const state = groupKeyBlobs[chat.id] || {};
  const wrapped = {};
  const members = (chat.members || []).filter(m => m.id !== member.id);
  for (const m of members) {
    const mk = await E2EE.normalizePublicKey(m.public_key);
    if (!mk) continue;
    wrapped[m.id] = await E2EE.wrapGroupKey(groupKey, me, mk);
  }
  wrapped[member.id] = await E2EE.wrapGroupKey(groupKey, me, memberKey);
  if (!wrapped[currentUser.id]) {
    wrapped[currentUser.id] = await E2EE.wrapGroupKey(groupKey, me, me.publicKey);
  }
  const version = (state.version || 1) + 1;
  groupKeyBlobs[chat.id] = {
    version,
    wrapped,
    mine: wrapped[currentUser.id],
    createdBy: currentUser.id
  };
  saveGroupKeyBlobs();
  sendWs({ type: 'set_group_key', chatId: chat.id, version, wrapped });
  return wrapped[member.id];
}

// Сохраняет полученный от сервера групповой ключ (только мой зашифрованный блоб)
function storeGroupKeyState(chatId, version, wrapped, createdBy) {
  const mine = wrapped && wrapped[currentUser.id];
  if (!mine) return null;
  groupKeyBlobs[chatId] = { version, wrapped, mine, createdBy };
  saveGroupKeyBlobs();
  delete chatKeys[chatId];
  return groupKeyBlobs[chatId];
}

// ==================== ШИФРОВАНИЕ СООБЩЕНИЙ ====================

async function encryptChatText(chatKey, text, chatId) {
  if (!chatKey) throw new Error(I18N.t('err.noChatKey'));
  if (chatKey.kind === 'group') {
    return E2EE.encryptGroup(chatKey.groupKey, text, String(chatId), 1);
  }
  const envelope = await E2EE.encryptDirect(chatKey.session, text, String(chatId));
  saveSession(chatId, chatKey.session);
  return envelope;
}

// Кэш расшифрованных сообщений.
//
// Один и тот же шифротекст запрашивается несколько раз: превью в списке чатов,
// тело сообщения в открытом чате, превью ответа. Рatchet (как и любой
// симметрический ratchet) не позволяет расшифровать одно сообщение дважды —
// без кэша вторая попытка падала бы с «сообщение устарело или повторяется».
//
// Кэш живёт в памяти и персистируется в localStorage (ограниченно): ratchet
// намеренно не хранит старые ключи цепочек, поэтому после перезагрузки страницы
// история иначе была бы нечитаемой. Ключ кэша — chatId + шифротекст.
const plaintextCache = new Map();      // cacheKey -> plaintext | Promise
const PLAINTEXT_CACHE_KEY = 'ciphertalk_plaintexts';
const PLAINTEXT_CACHE_LIMIT = 800;     // максимум записей
const PLAINTEXT_CACHE_MAX_CHARS = 20000; // не кэшируем «очень длинные» тексты
let persistedPlaintext = null;         // { cacheKey: plaintext }

function loadPersistedPlaintext() {
  if (persistedPlaintext) return persistedPlaintext;
  try {
    persistedPlaintext = JSON.parse(localStorage.getItem(scopedStorageKey(PLAINTEXT_CACHE_KEY))) || {};
  } catch (e) {
    persistedPlaintext = {};
  }
  return persistedPlaintext;
}

function plaintextCacheKey(chatId, content) {
  return String(chatId) + '|' + (content || '');
}

// Быстрый доступ к уже расшифрованному тексту (для записи в IndexedDB-кэш)
function getCachedPlaintext(chatId, content) {
  const ck = plaintextCacheKey(chatId, content);
  const mem = plaintextCache.get(ck);
  if (typeof mem === 'string') return mem;
  try {
    const p = loadPersistedPlaintext()[ck];
    return typeof p === 'string' ? p : '';
  } catch (e) { return ''; }
}

function persistPlaintext(chatId, content, text) {
  if (typeof text !== 'string' || text.length > PLAINTEXT_CACHE_MAX_CHARS) return;
  const store = loadPersistedPlaintext();
  store[plaintextCacheKey(chatId, content)] = text;
  const keys = Object.keys(store);
  if (keys.length > PLAINTEXT_CACHE_LIMIT) {
    // Вытесняем самые старые записи (порядок вставки в объекте сохраняется)
    for (const k of keys.slice(0, keys.length - PLAINTEXT_CACHE_LIMIT)) {
      delete store[k];
    }
  }
  try {
    localStorage.setItem(scopedStorageKey(PLAINTEXT_CACHE_KEY), JSON.stringify(store));
  } catch (e) { /* хранилище переполнено — пропускаем */ }
}

function clearPlaintextCache() {
  plaintextCache.clear();
  persistedPlaintext = {};
  try { localStorage.removeItem(scopedStorageKey(PLAINTEXT_CACHE_KEY)); } catch (e) { /* ignore */ }
}

// Кэш только что отправленных сообщений: подстраховка для расшифровки
// собственных сообщений (echo от сервера) без обращения к ratchet.
function rememberSent(chatId, content, text) {
  const ck = plaintextCacheKey(chatId, content);
  plaintextCache.set(ck, text);
  persistPlaintext(chatId, content, text);
}

async function decryptChatText(chatKey, message, chatId, isOwn = false) {
  if (!chatKey) throw new Error(I18N.t('err.noChatKey'));

  const raw = message.encrypted_content;
  const ck = plaintextCacheKey(chatId, raw);

  const cached = plaintextCache.get(ck);
  if (typeof cached === 'string') return cached;
  if (cached && typeof cached.then === 'function') return cached; // уже идёт расшифровка

  // Текст из IndexedDB-кэша чата (сообщения кэшируются уже расшифрованными)
  if (typeof message.plain === 'string' && message.plain) {
    plaintextCache.set(ck, message.plain);
    persistPlaintext(chatId, raw, message.plain);
    return message.plain;
  }

  const persisted = loadPersistedPlaintext()[ck];
  if (typeof persisted === 'string') {
    plaintextCache.set(ck, persisted);
    return persisted;
  }

  const task = (async () => {
    const payload = { content: raw, iv: message.iv, header: message.header || '' };
    if (chatKey.kind === 'group') {
      return E2EE.decryptGroup(chatKey.groupKey, payload, String(chatId));
    }
    if (isOwn) {
      try {
        const text = await E2EE.decryptDirectOwn(chatKey.session, payload, String(chatId));
        saveSession(chatId, chatKey.session);
        return text;
      } catch (e) {
        throw e;
      }
    }
    const text = await E2EE.decryptDirect(chatKey.session, payload, String(chatId));
    saveSession(chatId, chatKey.session);
    return text;
  })();

  plaintextCache.set(ck, task);
  try {
    const text = await task;
    plaintextCache.set(ck, text);
    persistPlaintext(chatId, raw, text);
    return text;
  } catch (e) {
    plaintextCache.delete(ck);
    throw e;
  }
}

// ==================== ФАЙЛЫ И МЕДИА ====================

function mediaKeyBytes(chatKey) {
  return chatKey.kind === 'group'
    ? chatKey.groupKey
    : E2EE.sessionFileKey(chatKey.session);
}

async function encryptBlob(buffer, chatKey) {
  const encrypted = await E2EE.encryptFile(mediaKeyBytes(chatKey), new Uint8Array(buffer));
  const salt = E2EE.b64ToBytes(encrypted.salt);
  const iv = E2EE.b64ToBytes(encrypted.iv);
  const data = E2EE.b64ToBytes(encrypted.data);
  const out = new Uint8Array(1 + salt.length + iv.length + data.length);
  out[0] = salt.length;
  out.set(salt, 1);
  out.set(iv, 1 + salt.length);
  out.set(data, 1 + salt.length + iv.length);
  return out.buffer;
}

async function decryptBlob(buffer, chatKey) {
  const all = new Uint8Array(buffer);
  if (all.byteLength < 14) throw new Error(I18N.t('err.corruptFile'));
  const saltLength = all[0];
  const salt = all.slice(1, 1 + saltLength);
  const iv = all.slice(1 + saltLength, 1 + saltLength + 12);
  const data = all.slice(1 + saltLength + 12);
  const plain = await E2EE.decryptFile(mediaKeyBytes(chatKey), {
    salt: E2EE.bytesToB64(salt),
    iv: E2EE.bytesToB64(iv),
    data: E2EE.bytesToB64(data)
  });
  return plain.buffer;
}

// ==================== ПУБЛИЧНЫЙ КЛЮЧ ====================

// Ожидание публичного ключа собеседника (если сервер ещё не прислал)
const pendingPublicKeys = new Map(); // userId -> [{ resolve, reject, timer }]

function waitForPublicKey(userId, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const list = pendingPublicKeys.get(userId) || [];
    const entry = { resolve, reject };
    entry.timer = setTimeout(() => {
      const arr = (pendingPublicKeys.get(userId) || []).filter(e => e !== entry);
      pendingPublicKeys.set(userId, arr);
      reject(new Error(I18N.t('err.peerNoKey')));
    }, timeoutMs);
    list.push(entry);
    pendingPublicKeys.set(userId, list);
    sendWs({ type: 'get_public_key', targetUserId: userId });
  });
}

function resolvePublicKeyWait(userId, publicKey) {
  const list = pendingPublicKeys.get(userId) || [];
  list.forEach(e => { clearTimeout(e.timer); e.resolve(publicKey); });
  pendingPublicKeys.delete(userId);
}

// Публикует свой публичный ключ на сервер (чтобы собеседники могли шифровать)
async function publishOwnPublicKey() {
  const me = await ensureLocalIdentity();
  if (!me) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_public_key', publicKey: me.publicKey }));
  }
  try {
    await api('/api/update-profile', { method: 'POST', body: { publicKey: me.publicKey } });
  } catch (e) { /* WS-путь достаточен */ }
}

// ==================== ЛОГИН / РЕГИСТРАЦИЯ ====================
function goToStep(step) {
  document.querySelectorAll('.login-step').forEach(el => { el.style.display = 'none'; });
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.classList.remove('active', 'done');
    if (i + 1 < step) dot.classList.add('done');
    if (i + 1 === step) dot.classList.add('active');
  });

  if (step === 1) {
    document.getElementById('step-1').style.display = 'block';
    document.getElementById('phone-input').focus();
  } else if (step === 2) {
    document.getElementById('step-2').style.display = 'block';
    document.getElementById('step-2-desc').textContent = I18N.t('auth.codeSentTo', { phone: regState.phone });
    document.getElementById('code-input').focus();
  } else if (step === 3) {
    if (regState.action === 'register') {
      document.getElementById('step-3-register').style.display = 'block';
      document.getElementById('firstname-input').focus();
    } else {
      document.getElementById('step-3-login').style.display = 'block';
      document.getElementById('welcome-name').textContent = regState.existingName || '';
      document.getElementById('password-input').focus();
    }
  } else if (step === 4) {
    document.getElementById('step-4').style.display = 'block';
    document.getElementById('username-input').focus();
  } else if (step === 5) {
    document.getElementById('step-5').style.display = 'block';
    document.getElementById('new-password-input').focus();
  }
}

async function step1Next() {
  const phone = document.getElementById('phone-input').value.trim();
  if (!phone || phone.length < 5) {
    showToast(I18N.t('err.phoneRequired'), 'error');
    return;
  }

  const btn = document.getElementById('send-code-btn');
  btn.disabled = true;
  btn.textContent = I18N.t('auth.sending');
  try {
    const { ok, data } = await api('/api/send-code', { method: 'POST', body: { phone }, auth: false });
    if (ok && data.success) {
      regState.phone = phone;
      goToStep(2);
      showToast(I18N.t('auth.codeSent'), 'success');
    } else {
      showToast(data.error || I18N.t('err.sendCode'), 'error');
    }
  } catch (e) {
    showToast(I18N.t('err.connection'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = I18N.t('auth.next');
  }
}

async function step2Next() {
  const code = document.getElementById('code-input').value.trim();
  if (!code || code.length < 4) {
    showToast(I18N.t('err.codeRequired'), 'error');
    return;
  }

  try {
    const { ok, data } = await api('/api/verify-code', {
      method: 'POST', body: { phone: regState.phone, code }, auth: false
    });
    if (ok && data.success) {
      regState.action = data.action;
      regState.verifyToken = data.verifyToken || '';
      regState.loginToken = data.loginToken || '';
      if (data.action === 'register') {
        goToStep(3);
      } else {
        regState.existingName = data.name;
        if (data.loginToken) {
          // Вход по коду из SMS (passwordless) — пароль не требуется
          await loginWithToken();
        } else {
          goToStep(3);
        }
      }
    } else {
      showToast(data.error || I18N.t('err.codeInvalid'), 'error');
    }
  } catch (e) {
    showToast(I18N.t('err.generic') + ' ' + e.message, 'error');
  }
}

function step3RegNext() {
  const firstName = document.getElementById('firstname-input').value.trim();
  const lastName = document.getElementById('lastname-input').value.trim();
  if (!firstName || firstName.length < 2) {
    showToast(I18N.t('err.nameRequired'), 'error');
    return;
  }
  regState.firstName = firstName;
  regState.lastName = lastName;
  goToStep(4);
}

async function step3LoginNext() {
  const password = document.getElementById('password-input').value;
  if (!password) {
    showToast(I18N.t('err.passwordRequired'), 'error');
    return;
  }

  try {
    const kp = await getOrCreateLocalKeyPair();
    const { ok, data } = await api('/api/login', {
      method: 'POST',
      body: { phone: regState.phone, password, publicKey: kp.publicKey },
      auth: false
    });

    if (ok && data.success) {
      await enterApp(data, kp);
      showToast(I18N.t('auth.welcome', { name: currentUser.name }), 'success', 'shield-check');
    } else {
      showToast(data.error || I18N.t('err.login'), 'error');
    }
  } catch (e) {
    showToast(I18N.t('err.generic') + ' ' + e.message, 'error');
  }
}

async function loginWithToken() {
  try {
    const kp = await getOrCreateLocalKeyPair();
    const { ok, data } = await api('/api/login-code', {
      method: 'POST',
      body: { phone: regState.phone, loginToken: regState.loginToken, publicKey: kp.publicKey },
      auth: false
    });

    if (ok && data.success) {
      await enterApp(data, kp);
      showToast(I18N.t('auth.welcome', { name: currentUser.name }), 'success', 'shield-check');
    } else {
      showToast(data.error || I18N.t('err.login'), 'error');
      if (data && /просроч|недействительн/i.test(data.error || '')) goToStep(1);
    }
  } catch (e) {
    showToast(I18N.t('err.generic') + ' ' + e.message, 'error');
  }
}

async function checkUsername() {
  const input = document.getElementById('username-input');
  const hint = document.getElementById('username-hint');
  const btn = document.getElementById('username-next-btn');
  let value = input.value.replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  input.value = value;

  clearTimeout(usernameCheckTimeout);

  if (value.length < 3) {
    hint.textContent = I18N.t('err.usernameMin');
    hint.className = 'input-hint info';
    input.classList.remove('success', 'error');
    btn.disabled = true;
    return;
  }

  hint.textContent = I18N.t('auth.checking');
  hint.className = 'input-hint info';
  input.classList.remove('success', 'error');
  btn.disabled = true;

  usernameCheckTimeout = setTimeout(async () => {
    try {
      const { data } = await api(`/api/check-username?username=${encodeURIComponent(value)}`, { auth: false });
      if (data.available) {
        hint.innerHTML = `${I18N.t('auth.usernameFree')}<span class="username-preview">@${escapeHtml(value)}</span>`;
        hint.className = 'input-hint success';
        input.classList.add('success');
        input.classList.remove('error');
        btn.disabled = false;
        regState.username = value;
      } else {
        hint.textContent = data.error || I18N.t('err.usernameTaken');
        hint.className = 'input-hint error';
        input.classList.add('error');
        input.classList.remove('success');
        btn.disabled = true;
      }
    } catch (e) {
      hint.textContent = I18N.t('err.check');
      hint.className = 'input-hint error';
    }
  }, 400);
}

function step4Next() {
  if (!regState.username) return;
  goToStep(5);
}

function checkPasswordStrength() {
  const pwd = document.getElementById('new-password-input').value;
  const confirm = document.getElementById('confirm-password-input').value;
  regState.password = (pwd.length >= 6 && pwd === confirm) ? pwd : '';
}

async function step5Next() {
  const pwd = document.getElementById('new-password-input').value;
  const confirm = document.getElementById('confirm-password-input').value;

  if (pwd.length < 6) {
    showToast(I18N.t('err.passwordMin'), 'error');
    return;
  }
  if (pwd !== confirm) {
    showToast(I18N.t('err.passwordMismatch'), 'error');
    return;
  }
  if (!regState.verifyToken) {
    showToast(I18N.t('err.confirmPhoneAgain'), 'error');
    goToStep(1);
    return;
  }

  try {
    const kp = await getOrCreateLocalKeyPair();
    const { ok, data } = await api('/api/register', {
      method: 'POST',
      body: {
        phone: regState.phone,
        firstName: regState.firstName,
        lastName: regState.lastName,
        username: regState.username,
        password: pwd,
        publicKey: kp.publicKey,
        verifyToken: regState.verifyToken
      },
      auth: false
    });

    if (ok && data.success) {
      await enterApp(data, kp);
      showToast(I18N.t('auth.registered', { name: currentUser.name }), 'success');
    } else {
      showToast(data.error || I18N.t('err.register'), 'error');
    }
  } catch (e) {
    showToast(I18N.t('err.generic') + ' ' + e.message, 'error');
  }
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = Icons.svg('eye-off', { className: 'mq-icon--sm' });
    btn.setAttribute('aria-label', I18N.t('auth.hidePassword') || 'Hide password');
  } else {
    input.type = 'password';
    btn.innerHTML = Icons.svg('eye', { className: 'mq-icon--sm' });
    btn.setAttribute('aria-label', I18N.t('auth.showPassword') || 'Show password');
  }
}

async function enterApp(data) {
  currentUser = normalizeUser(data.user);
  await ensureIdentityForUser(currentUser.id);
  // Настройки внешнего вида и приватности привязаны к аккаунту
  reloadAppearanceForUser();
  if (data.token) {
    authToken = data.token;
    localStorage.setItem('ciphertalk_token', authToken);
  }
  localStorage.setItem('ciphertalk_user', JSON.stringify(currentUser));
  if (currentUser.hide_online) privacy.hideOnline = true;
  savePrivacy();

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  initApp();
  requestNotificationPermission().then(syncSWBackground);
  // Публикуем актуальный публичный ключ (перекрывает старый, если сменилось устройство)
  publishOwnPublicKey().catch(() => {});
  maybeLockApp();
}

// ==================== ПРИЛОЖЕНИЕ ====================

/**
 * Определяет тип устройства и записывает его в <html data-device>:
 *   phone   — телефон (одна колонка, нижняя навигация)
 *   tablet  — планшет (две колонки)
 *   desktop — ПК (три колонки)
 * Также помечает тип указателя: fine (мышь) или coarse (палец).
 */
function detectDevice() {
  const w = window.innerWidth;
  const coarse = typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  let device = 'desktop';
  if (w <= 640) device = 'phone';
  else if (w <= 1024) device = 'tablet';

  const html = document.documentElement;
  html.setAttribute('data-device', device);
  html.setAttribute('data-pointer', coarse ? 'coarse' : 'fine');
  return device;
}

/** Следит за сменой размера окна — версия переключается на лету. */
function watchDevice() {
  detectDevice();
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(detectDevice, 120);
  });
}

/** Нижняя навигация телефона: активная вкладка. */
function updateMobileNav() {
  const nav = document.getElementById('mobile-nav');
  if (!nav) return;
  const chatOpen = document.getElementById('app-container').classList.contains('chat-open');
  const chatsTab = nav.querySelector('[data-action="mobileChats"]');
  if (chatsTab) chatsTab.classList.toggle('active', !chatOpen);
}

function initApp() {
  updateMenuProfile();
  setupMessagesScroll();
  hydrateFromCache(); // мгновенный список чатов из IndexedDB (до ответа сервера)
  connectWebSocket();
  refreshPublicAccess();
  updateMobileNav();
}

// Оффлайн-первая загрузка: показываем кэшированный список чатов сразу,
// не дожидаясь WebSocket/сервера. Актуальные данные придут следом и заменят его.
async function hydrateFromCache() {
  if (chats.length || !currentUser) return;
  const rec = await idbGet('chats', 'list');
  if (!rec || !Array.isArray(rec.list) || rec.list.length === 0) return;
  if (chats.length) return; // сервер успел ответить раньше
  chats = rec.list.map(normalizeChat).filter(c => {
    // «Избранное» и личные чаты валидируем по участникам
    if (!c.id) return false;
    if (c.type === 'saved') return true;
    return Array.isArray(c.members) && c.members.some(m => Number(m.id) === Number(currentUser.id));
  });
  rebuildOnlineSet();
  renderChatList();
}

// ==================== ПРОКРУТКА СПИСКА СООБЩЕНИЙ ====================
let scrollRafPending = 0;

function setupMessagesScroll() {
  const container = getMessagesContainer();
  if (!container || container.dataset.mqScroll === '1') return;
  container.dataset.mqScroll = '1';
  container.addEventListener('scroll', function () {
    if (scrollRafPending) return;
    const run = () => { scrollRafPending = 0; onMessagesScroll(); };
    if (typeof requestAnimationFrame === 'function') scrollRafPending = requestAnimationFrame(run);
    else scrollRafPending = setTimeout(run, 60);
  }, { passive: true });
}

function onMessagesScroll() {
  const container = getMessagesContainer();
  if (!container) return;
  // Подгружаем историю, когда пользователь доскроллил вверх
  if (container.scrollTop <= 60) loadOlderMessages();
  if (isScrolledToBottom(container, 160)) hideScrollFab();
  else showScrollFab();
}

let fabBadgeCount = 0;

function showScrollFab() {
  const fab = document.getElementById('scroll-down-fab');
  if (fab) fab.classList.add('visible');
}

// Счётчик непрочитанных сообщений на кнопке «вниз»
function bumpScrollFabBadge() {
  fabBadgeCount++;
  const badge = document.getElementById('scroll-fab-badge');
  if (badge) {
    badge.textContent = fabBadgeCount > 99 ? '99+' : String(fabBadgeCount);
    badge.style.display = '';
  }
  const fab = document.getElementById('scroll-down-fab');
  if (fab) fab.classList.add('pulse');
}

function hideScrollFab() {
  const fab = document.getElementById('scroll-down-fab');
  if (fab) fab.classList.remove('visible', 'pulse');
  fabBadgeCount = 0;
  const badge = document.getElementById('scroll-fab-badge');
  if (badge) {
    badge.style.display = 'none';
    badge.textContent = '0';
  }
}

function scrollToBottom() {
  scrollMessagesToBottom(getMessagesContainer(), true);
}

function updateMenuProfile() {
  const menuName = document.getElementById('menu-name');
  menuName.innerHTML = escapeHtml(currentUser.name || I18N.t('chat.user')) +
    customBadgeHtml() + (isOwnerUser(currentUser) ? ownerBadgeHtml() : '');
  document.getElementById('menu-username').textContent = '@' + (currentUser.username || 'username');
  document.getElementById('menu-phone').textContent = currentUser.phone || '';
  const avatarEl = document.getElementById('menu-avatar');
  if (avatarEl) {
    // Аватар пользователя: картинка из БД, иначе — динамическая первая буква
    // имени (хардкод «U» из index.html убран; setUserAvatar всегда перерисовывает
    // элемент целиком, поэтому старый контент не остаётся на экране).
    setUserAvatar(avatarEl, currentUser);
  }
}

// Обновление профиля в интерфейсе
function updateUserUI() {
  updateMenuProfile();
}

function connectWebSocket() {
  clearTimeout(wsReconnectTimer);
  if (!authToken || !currentUser) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    wsReconnectAttempts = 0; // соединение живое — сбрасываем backoff
    ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    publishOwnPublicKey().catch(() => {});
    // Фоновый сокет SW нужен ТОЛЬКО когда страница не может показывать сама:
    // вкладка свёрнута/закрыта или фокус у другого окна. Если страница
    // сейчас видима и в фокусе — просим фон отключиться (меньше дублей,
    // меньше нагрузки на сервер). Иначе — пусть висит и страхует.
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      swPostMessage({ type: 'ct-bg-pause' });
    } else {
      syncSWBackground();
    }
  };

  ws.onmessage = (event) => {
    try {
      handleWSMessage(JSON.parse(event.data));
    } catch (e) {
      console.error('WS message handling error:', e);
    }
  };

  ws.onclose = (e) => {
    ws = null;
    if (authToken && currentUser) {
      // Быстрый реконнект, затем плавное увеличение (до 15с): раньше при
      // недоступном сервере страница переподключалась каждые 1.5с вечно —
      // это и «съедало» батарею/сеть, и мешало фону получить свой сокет.
      wsReconnectAttempts++;
      const delay = Math.min(1500 * wsReconnectAttempts, 15000);
      wsReconnectTimer = setTimeout(connectWebSocket, delay);
    }
  };

  ws.onerror = () => { /* onclose выполнит реконнект */ };
}
let wsReconnectAttempts = 0;

function sendWs(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast(I18N.t('err.noConnection'), 'error');
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}

async function handleWSMessage(msg) {
  switch (msg.type) {
    case 'auth_error':
      handleSessionExpired();
      break;

    case 'chats': {
      const prevIds = new Set(chats.map(c => Number(c.id)));
      chats = (msg.chats || []).map(normalizeChat);
      rebuildOnlineSet();
      renderChatList();
      if (currentChatId && !getChatById(currentChatId)) closeChat();
      // Первичная загрузка по ссылке /<публичный id>: открываем чат из URL
      if (!pendingUrlToken) {
        const t0 = readChatTokenFromUrl();
        if (t0) openChatByToken(t0);
      }
      // Удалили чат на другом устройстве — вычищаем его из локального кэша
      for (const id of Object.keys(messages)) {
        if (!prevIds.has(Number(id))) continue;
        if (!getChatById(Number(id))) {
          delete messages[id];
          idbDelete('messages', Number(id));
        }
      }
      scheduleChatsCache();
      break;
    }

    case 'chat_deleted':
      {
        const chatId = Number(msg.chatId);
        chats = (chats || []).filter(c => Number(c.id) !== chatId);
        if (messages && messages[chatId]) delete messages[chatId];
        idbDelete('messages', chatId);
        scheduleChatsCache();
        if (currentChatId === chatId) closeChat();
        try { localStorage.removeItem('ciphertalk_draft_' + chatId); } catch (e) {}
        delete chatKeys[chatId];
        // Очищаем все таймеры истечения для этого чата
        for (const k of Array.from(expiryTimers.keys())) {
          if (String(k).startsWith(String(chatId) + ':')) {
            const t = expiryTimers.get(k);
            if (t) clearTimeout(t);
            expiryTimers.delete(k);
          }
        }
        delete expiryTimers[chatId];
        pendingGroupKeys.delete(chatId);
        renderChatList();
      }
      break;

    case 'new_chat':
      upsertChat(msg.chat);
      renderChatList();
      if (msg.chat && msg.chat.type !== 'private' && msg.chat.type !== 'saved') {
        const chat = getChatById(msg.chat.id);
        if (chat && chat.owner_id === currentUser.id) {
          createAndPublishGroupKey(chat).catch(() => {});
        }
      }
      break;

    case 'group_created':
    case 'channel_created': {
      upsertChat(msg.chat);
      renderChatList();
      const chat = getChatById(msg.chat?.id);
      if (chat) {
        createAndPublishGroupKey(chat).catch(() => {});
        openChat(chat.id);
      }
      break;
    }

    case 'group_key': {
      const chatId = Number(msg.chatId);
      const state = storeGroupKeyState(chatId, msg.version, msg.wrapped || {}, msg.createdBy);
      resolveGroupKey(chatId, state);
      if (currentChatId === chatId) renderMessages(chatId);
      break;
    }

    case 'chat_created': {
      if (!getChatById(msg.chatId)) {
        chats.unshift(normalizeChat({ id: msg.chatId, type: 'private', members: msg.members, public_id: msg.public_id || '' }));
        renderChatList();
      }
      openChat(msg.chatId);
      break;
    }

    case 'public_resolved': {
      // Сервер разобрал токен из URL в chatId — открываем чат
      const cid = Number(msg.chatId);
      pendingUrlToken = null;
      if (cid === -1) {
        closeChat();
        syncUrlToChat(null);
      } else if (getChatById(cid)) {
        openChat(cid);
      } else {
        let tries = 0;
        const timer = setInterval(() => {
          if (getChatById(cid)) { clearInterval(timer); openChat(cid); }
          else if (++tries > 20) {
            clearInterval(timer);
            showToast('Чат не найден: /' + msg.token, 'error');
          }
        }, 300);
      }
      break;
    }

    case 'member_added': {
      const chat = getChatById(msg.chatId);
      if (chat) {
        chat.members = (msg.members || []).map(normalizeUser);
        delete chatKeys[msg.chatId];
        if (currentChatId === msg.chatId) updateChatHeader();
      }
      break;
    }

    case 'messages': {
      const chatId = Number(msg.chatId);
      const incoming = (msg.messages || []).map(normalizeMessage);
      chatPager.set(chatId, { hasMore: !!msg.hasMore, beforeId: msg.beforeId || null });
      loadingOlder.delete(chatId);
      if (msg.older) {
        // Подгрузка старых сообщений: дополняем историю без дублей
        const list = messages[chatId] || (messages[chatId] = []);
        const known = new Set(list.map(m => m.id));
        const fresh = incoming.filter(m => !known.has(m.id));
        if (fresh.length) {
          list.unshift(...fresh);
          fresh.forEach(m => scheduleMessageExpiry(chatId, m));
          if (currentChatId === chatId) await refreshWindowPreservingScroll(chatId);
          scheduleChatCache(chatId);
        }
      } else {
        const existing = messages[chatId] || [];
        if (existing.length > 0) {
          // Локальный кэш уже отрисован — объединяем с ответом сервера без дублей,
          // чтобы не «мигать» пустотой и не терять только что пришедшие сообщения.
          const byId = new Map(existing.map(m => [m.id, m]));
          for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m);
          const merged = Array.from(byId.values())
            .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
          messages[chatId] = merged;
          if (currentChatId === chatId) {
            await renderMessages(chatId);
            markChatRead(chatId);
            requestMissingGap(chatId);
          }
          scheduleChatCache(chatId);
        } else {
          messages[chatId] = incoming;
          incoming.forEach(m => scheduleMessageExpiry(chatId, m));
          if (currentChatId === chatId) {
            await renderMessages(chatId);
            markChatRead(chatId);
          }
          scheduleChatCache(chatId);
        }
      }
      break;
    }

    case 'new_message': {
      const message = normalizeMessage(msg.message);
      if (!messages[message.chat_id]) messages[message.chat_id] = [];
      const isNew = !messages[message.chat_id].some(m => m.id === message.id);
      if (isNew) {
        messages[message.chat_id].push(message);
        scheduleMessageExpiry(message.chat_id, message);
        scheduleChatCache(message.chat_id);
        if (currentChatId === message.chat_id) appendMessage(message);
      }
      updateChatPreview(message.chat_id, message);
      if (isNew && currentChatId === message.chat_id) markChatRead(message.chat_id);
      // Системное уведомление о новом сообщении вне текущего чата
      if (isNew && currentChatId !== message.chat_id) {
        const chat = getChatById(message.chat_id);
        const senderName = message.sender_name || (chat ? getChatName(chat) : I18N.t('chat.user'));
        // Заголовок: в группах — «отправитель: название чата», в личке — имя собеседника
        const notifTitle = (chat && (chat.type === 'group' || chat.type === 'supergroup'))
          ? `${senderName}: ${getChatName(chat)}`
          : senderName;
        // Уведомление показываем ТОЛЬКО с текстом самого сообщения: сначала
        // расшифровываем (обычно это доли секунды — ключи и текст уже в памяти),
        // и лишь потом показываем. Никаких заглушек «Новое сообщение» /
        // «Зашифрованное сообщение» пользователь не увидит.
        buildNotificationBody(message, chat).then(bodyText => {
          if (!bodyText) return; // расшифровка не удалась — молчим, а не глушим
          // Сообщаем фону превью ДО показа: если фоновый сокет получит это
          // сообщение первым, он подставит наш текст вместо своей метки.
          swPostMessage({ type: 'ct-notif-body', chatId: message.chat_id, body: bodyText });
          showNotification(notifTitle, bodyText, message.chat_id);
        });
      }
      break;
    }

    case 'message_edited': {
      const list = messages[Number(msg.chatId)];
      const m = list && list.find(x => x.id === Number(msg.messageId));
      if (m) {
        m.encrypted_content = msg.content;
        m.iv = msg.iv || m.iv;
        m.header = msg.header || m.header;
        m.edited = 1;
        delete m.plain; // новый шифротекст — старый кэшированный текст невалиден
        scheduleChatCache(Number(msg.chatId));
        if (currentChatId === Number(msg.chatId)) renderMessages(Number(msg.chatId));
      }
      break;
    }

    case 'message_deleted': {
      const chatId = Number(msg.chatId);
      cancelMessageExpiry(chatId, Number(msg.messageId));
      if (messages[chatId]) {
        messages[chatId] = messages[chatId].filter(m => m.id !== Number(msg.messageId));
        scheduleChatCache(chatId);
        if (currentChatId === chatId) renderMessages(chatId);
      }
      break;
    }

    case 'messages_read': {
      const chatId = Number(msg.chatId);
      const chat = getChatById(chatId);
      if (chat) {
        if (!chat.last_read_by) chat.last_read_by = {};
        chat.last_read_by[msg.userId] = Number(msg.lastReadId) || 0;
        if (currentChatId === chatId) updateTicksForChat(chatId);
      }
      break;
    }

    case 'typing':
      if (currentChatId === Number(msg.chatId) && msg.userId !== currentUser.id) {
        showTypingIndicator(msg.name);
      }
      break;

    case 'chat_updated': {
      const chat = getChatById(msg.chatId);
      if (chat) {
        chat.last_message = msg.lastMessage || '';
        chat.last_message_iv = msg.lastMessageIv || '';
        chat.last_message_header = msg.lastMessageHeader || '';
        chat.last_message_type = msg.lastMessageType || null;
        chat.last_message_time = msg.lastMessageTime || Date.now();
        chat.last_sender_id = msg.lastSenderId || 0;
        // Сервер присылает avatar только при реальной смене аватара; пустая
        // строка означает явную очистку картинки (тогда остаётся буква имени).
        if ('avatar' in msg && typeof msg.avatar === 'string') {
          applyChatAvatarUpdate(chat, msg.avatar);
        }
        reorderChat(chat);
      }
      renderChatListThrottled();
      break;
    }

    case 'online_users':
      onlineUsers = new Set(msg.users || []);
      updateOnlineStatuses();
      break;

    case 'user_online':
      onlineUsers.add(msg.userId);
      updateOnlineStatuses();
      break;

    case 'user_offline':
      onlineUsers.delete(msg.userId);
      updateOnlineStatuses();
      break;

    case 'folders':
      setFolders(msg.folders || []);
      renderChatList();
      break;

    case 'folder_created':
    case 'folder_updated': {
      const list = folders.filter(f => f.id !== Number(msg.folder?.id));
      list.push(msg.folder);
      setFolders(list);
      break;
    }

    case 'folder_deleted':
      setFolders(folders.filter(f => f.id !== Number(msg.id)));
      break;

    case 'chat_folder_changed': {
      const chat = getChatById(Number(msg.chatId));
      if (chat) {
        chat.folder_id = msg.folderId ?? null;
        setFolders(folders.map(f => {
          const ids = (f.chat_ids || []).filter(id => id !== chat.id);
          if (Number(msg.folderId) === Number(f.id)) ids.push(chat.id);
          return { ...f, chat_ids: ids };
        }));
        renderChatList();
      }
      break;
    }

    case 'message_pinned': {
      const chatId = Number(msg.chatId);
      const list = messages[chatId] || [];
      const m = list.find(x => x.id === Number(msg.messageId));
      if (m) {
        m.pinned = msg.pinned ? 1 : 0;
        if (currentChatId === chatId) renderMessages(chatId);
      }
      break;
    }

    case 'message_reaction': {
      const chatId = Number(msg.chatId);
      const list = messages[chatId] || [];
      const m = list.find(x => x.id === Number(msg.messageId));
      if (m) {
        m.reactions = msg.reactions || {};
        if (currentChatId === chatId) renderMessages(chatId);
      }
      break;
    }

    case 'public_key':
      handlePublicKey(msg.userId, msg.publicKey);
      break;

    case 'call_offer':
      if (typeof handleCallOffer === 'function') handleCallOffer(msg);
      break;
    case 'call_answer':
      if (typeof handleCallAnswer === 'function') handleCallAnswer(msg);
      break;
    case 'call_ice':
      if (typeof handleCallIce === 'function') handleCallIce(msg);
      break;
    case 'call_reject':
      if (typeof handleCallReject === 'function') handleCallReject(msg);
      break;
    case 'call_end':
      if (typeof handleCallEnd === 'function') handleCallEnd(msg);
      break;
    case 'call_ringing':
      if (typeof handleCallRinging === 'function') handleCallRinging(msg);
      break;
    case 'call_unavailable':
      if (typeof handleCallUnavailable === 'function') handleCallUnavailable(msg);
      break;

    case 'error':
      showToast(msg.error || I18N.t('err.server'), 'error');
      break;
  }
}

function handlePublicKey(userId, publicKey) {
  resolvePublicKeyWait(Number(userId), publicKey);
  let changed = false;
  const touchedGroups = [];
  chats.forEach(chat => {
    const member = chat.members?.find(m => m.id === Number(userId));
    if (member && publicKey && member.public_key !== publicKey) {
      member.public_key = publicKey;
      delete chatKeys[chat.id];
      changed = true;
      if (chat.type !== 'private' && chat.type !== 'saved' && chat.owner_id === currentUser.id) {
        touchedGroups.push(chat);
      }
    }
  });
  if (changed && currentChatId) renderMessages(currentChatId);
  // Владелец группы доливает ключ участнику, чей публичный ключ появился позже
  touchedGroups.forEach(chat => {
    shareGroupKeyWithMember(chat, chat.members.find(m => m.id === Number(userId)))
      .catch(() => {});
  });
}

// Создаёт и публикует групповой ключ для новой группы/канала
async function createAndPublishGroupKey(chat) {
  const groupKey = E2EE.createGroupKey();
  await publishGroupKey(chat, groupKey, 1);
  return groupKey;
}

function upsertChat(rawChat) {
  if (!rawChat) return;
  const chat = normalizeChat(rawChat);
  const idx = chats.findIndex(c => c.id === chat.id);
  if (idx === -1) chats.unshift(chat);
  else chats[idx] = { ...chats[idx], ...chat };
  rebuildOnlineSet();
}

function rebuildOnlineSet() {
  const set = new Set();
  chats.forEach(chat => {
    (chat.members || []).forEach(m => {
      if (m.online === 1 || m.online === true) set.add(m.id);
    });
  });
  if (onlineUsers.size) {
    onlineUsers.forEach(id => set.add(id));
  }
  onlineUsers = set;
}

// Список чатов тоже пересобирается инкрементально: раньше каждое новое сообщение
// перерисовывало весь список (innerHTML) и запускало расшифровку превью у всех чатов.
const chatListNodes = new Map(); // chatId -> HTMLElement
const previewCache = new Map();  // chatId -> { sig, text }

function previewSig(chat) {
  return `${chat.last_message || ''}|${chat.last_message_iv || ''}|${chat.last_message_header || ''}|${chat.last_message_type || ''}`;
}

// Элемент чата строится через DOM API: это быстрее разбора HTML-строки
// и не требует экранирования (текст попадает через textContent).
function buildChatItem(chat) {
  const el = document.createElement('div');
  el.className = 'chat-item' + (currentChatId === chat.id ? ' active' : '');
  el.setAttribute('data-action', 'openChat');
  el.setAttribute('data-id', String(chat.id));
  el.setAttribute('data-chat-id', String(chat.id));

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar' + (isChatOnline(chat) ? ' online' : '');
  setChatAvatar(avatar, chat);

  const info = document.createElement('div');
  info.className = 'chat-info';

  const top = document.createElement('div');
  top.className = 'chat-top';
  const nameWrap = document.createElement('span');
  nameWrap.className = 'chat-name-wrap';
  const name = document.createElement('span');
  name.className = 'chat-name';
  name.textContent = getChatName(chat);
  nameWrap.appendChild(name);
  appendOwnerBadge(nameWrap, chatOwner(chat));
  const time = document.createElement('span');
  time.className = 'chat-time';
  time.textContent = chat.last_message_time ? formatTime(chat.last_message_time) : '';
  top.appendChild(nameWrap);
  top.appendChild(time);

  const bottom = document.createElement('div');
  bottom.className = 'chat-bottom';
  const preview = document.createElement('span');
  preview.className = 'chat-preview';
  preview.setAttribute('data-preview-chat', String(chat.id));
  preview.textContent = chatPreview(chat);
  bottom.appendChild(preview);

  info.appendChild(top);
  info.appendChild(bottom);
  el.appendChild(avatar);
  el.appendChild(info);
  return el;
}

function getFilteredChats(filter) {
  const folderId = typeof activeFolderId !== 'undefined' ? activeFolderId : null;
  return chats.filter(c => {
    if (folderId !== null) {
      const folder = (folders || []).find(f => Number(f.id) === Number(folderId));
      if (!folder || !(folder.chat_ids || []).includes(c.id)) return false;
    }
    return !filter || getChatName(c).toLowerCase().includes(filter.toLowerCase());
  });
}

function updateChatItem(el, chat) {
  if (!el) return;
  const timeEl = el.querySelector ? el.querySelector('.chat-time') : null;
  if (timeEl) {
    const time = chat.last_message_time ? formatTime(chat.last_message_time) : '';
    if (timeEl.textContent !== time) timeEl.textContent = time;
  }
  const avatarEl = el.querySelector ? el.querySelector('.chat-avatar') : null;
  if (avatarEl) {
    avatarEl.classList.toggle('online', isChatOnline(chat));
    // Обязательно перечитываем содержимое аватара: без этого смена картинки
    // (или подгрузка other_user из обновлённого списка чатов) не попадали
    // в уже отрисованный элемент — на экране оставалась старая буква.
    setChatAvatar(avatarEl, chat);
  }
  const previewEl = el.querySelector ? el.querySelector('.chat-preview') : null;
  if (previewEl) {
    const cached = previewCache.get(chat.id);
    if (cached && cached.sig === previewSig(chat)) {
      if (previewEl.textContent !== cached.text) previewEl.textContent = cached.text;
    } else {
      const placeholder = chatPreview(chat);
      if (previewEl.textContent !== placeholder) previewEl.textContent = placeholder;
    }
  }
  el.classList.toggle('active', currentChatId === chat.id);
}

function renderChatList(filter = '') {
  const container = document.getElementById('chat-list');
  if (!container) return;
  const filtered = getFilteredChats(filter);
  const ids = filtered.map(c => c.id);
  const prevIds = Array.from(chatListNodes.keys());
  const sameOrder = prevIds.length === ids.length && prevIds.every((id, i) => id === ids[i]);
  const sameSet = prevIds.length === ids.length && ids.every(id => chatListNodes.has(id));

  if (!sameOrder && sameSet) {
    // Порядок изменился (чат всплыл вверх) — переставляем готовые узлы
    for (const id of ids) {
      const el = chatListNodes.get(id);
      if (el) container.appendChild(el);
    }
    for (const chat of filtered) updateChatItem(chatListNodes.get(chat.id), chat);
  } else if (!sameOrder) {
    const wasEmpty = !container.children || container.children.length === 0;
    container.innerHTML = '';
    chatListNodes.clear();
    for (const chat of filtered) {
      const el = buildChatItem(chat);
      container.appendChild(el);
      chatListNodes.set(chat.id, el);
    }
    // Каскадное появление — только при первой отрисовке списка
    if (wasEmpty && typeof Motion !== 'undefined' && Motion.stagger) {
      Motion.stagger(container, { max: 18 });
    }
  } else {
    for (const chat of filtered) updateChatItem(chatListNodes.get(chat.id), chat);
  }

  // Сразу после рендера списка чатов (.chat-list, контейнер каскада —
  // .mq-stagger) догружаем все <img data-avatar-path>: fetch с
  // Authorization: Bearer -> Blob URL -> src. Пустых синих кругов не
  // остаётся: при неудаче в контейнере видна динамическая первая буква.
  hydrateAvatars(container);

  // Расшифровываем превью последнего сообщения (сервер хранит только шифротекст)
  schedulePreviewRefresh(filtered);
}

// Превью расшифровываются в свободное время и только для видимых чатов.
// Запускаются параллельно, чтобы не ждать каждую ECDH-операцию по очереди.
function schedulePreviewRefresh(filtered) {
  const run = async () => {
    await Promise.allSettled(filtered.slice(0, 24).map(chat => refreshChatPreview(chat)));
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 900 });
  else setTimeout(run, 80);
}

function chatPreview(chat) {
  if (!chat.last_message) return I18N.t('chat.noMessages');
  const labels = {
    voice: { icon: 'mic', text: I18N.t('chat.voiceMsg') },
    video: { icon: 'video', text: I18N.t('chat.videoMsg') },
    image: { icon: 'image', text: I18N.t('chat.imageMsg') },
    file: { icon: 'paperclip', text: I18N.t('chat.fileMsg') }
  };
  const hit = labels[chat.last_message_type];
  return hit ? hit.text : I18N.t('chat.loading');
}

async function refreshChatPreview(chat) {
  const el = document.querySelector(`.chat-preview[data-preview-chat="${chat.id}"]`);
  if (!el || !chat.last_message) return;
  const sig = previewSig(chat);
  const hit = previewCache.get(chat.id);
  if (hit && hit.sig === sig) {
    if (el.textContent !== hit.text) el.textContent = hit.text;
    return;
  }
  const labels = {
    voice: { icon: 'mic', text: I18N.t('chat.voiceMsg') },
    video: { icon: 'video', text: I18N.t('chat.videoMsg') },
    image: { icon: 'image', text: I18N.t('chat.imageMsg') },
    file: { icon: 'paperclip', text: I18N.t('chat.fileMsg') }
  };
  if (labels[chat.last_message_type]) {
    const label = labels[chat.last_message_type];
    previewCache.set(chat.id, { sig, text: label.text });
    el.innerHTML = Icons.svg(label.icon, { className: 'mq-icon--xs mq-inline-icon' }) +
      '<span class="cp-text"></span>';
    const span = el.querySelector('.cp-text');
    if (span) span.textContent = label.text;
    return;
  }
  try {
    const key = await getChatKey(chat.id, chat);
    const text = await decryptChatText(key, {
      encrypted_content: chat.last_message,
      iv: chat.last_message_iv,
      header: chat.last_message_header
    }, chat.id, chat.last_sender_id === currentUser.id);
    const preview = String(text).slice(0, 80);
    previewCache.set(chat.id, { sig, text: preview });
    el.textContent = preview;
  } catch (e) {
    const fallback = I18N.t('chat.encryptedMessage');
    previewCache.set(chat.id, { sig, text: fallback });
    el.innerHTML = Icons.svg('lock', { className: 'mq-icon--xs mq-inline-icon' }) +
      '<span class="cp-text"></span>';
    const span = el.querySelector('.cp-text');
    if (span) span.textContent = fallback;
  }
}
function searchChats(query) {
  renderChatList(query);
}

function reorderChat(chat) {
  const idx = chats.indexOf(chat);
  if (idx > 0) {
    chats.splice(idx, 1);
    chats.unshift(chat);
  }
}

// Метки типов для уведомлений (синхронная часть — без криптографии).
function notifTypeLabel(type) {
  const typeLabels = {
    image: '📷 ' + I18N.t('notif.photo'),
    photo: '📷 ' + I18N.t('notif.photo'),
    video: '🎥 ' + I18N.t('notif.video'),
    round: '🎥 ' + I18N.t('notif.video'),
    voice: '🎤 ' + I18N.t('notif.voice'),
    file: '📄 ' + I18N.t('notif.file'),
    sticker: '🎨 ' + I18N.t('notif.sticker'),
    custom_sticker: '🎨 ' + I18N.t('notif.sticker'),
    call: '📞 ' + I18N.t('notif.call')
  };
  return typeLabels[type] || null;
}

// Превью для системного уведомления: ВСЕГДА показываем расшифрованный текст
// сообщения (или понятную метку типа для медиа: 📷 фото, 🎥 видео, 🎤 голосовое,
// 📄 файл, 🎨 стикер). Заглушек вроде «Новое сообщение» / «Зашифрованное
// сообщение» нет: если расшифровать не удалось — возвращаем null и
// уведомление просто не показывается, а не показывается с служебным текстом.
async function buildNotificationBody(message, chat) {
  const t = message.type || 'text';
  // Медиа: не пытаемся расшифровывать JSON-полезную нагрузку — сразу метка типа
  const mediaLabel = notifTypeLabel(t);
  if (mediaLabel) return mediaLabel;
  try {
    let key = chatKeys[message.chat_id] || null;
    if (!key) {
      // Ключа в памяти нет (чат ещё не открывали) — получаем его асинхронно.
      // Для групп это может запросить ключ у участников через WS, поэтому
      // ставим лимит 15 секунд: за это время ключ почти всегда приходит.
      key = await Promise.race([
        getChatKeySafe(message.chat_id, chat),
        new Promise(res => setTimeout(() => res(null), 15000))
      ]);
    }
    if (!key) throw new Error('no key');
    const text = await decryptChatText(key, message, message.chat_id,
      currentUser && message.sender_id === currentUser.id);
    // На всякий случай: если тип не пометился как медиа, но внутри JSON с url —
    // это файл/фото и т.п., показываем метку типа из payload
    if (text && text.startsWith('{')) {
      try {
        const p = JSON.parse(text);
        if (p && p.url) {
          const name = String(p.name || '').trim();
          return name ? '📎 ' + name : '📎 ' + I18N.t('notif.file');
        }
      } catch (e) { /* обычный текст */ }
    }
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (clean) return clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
  } catch (e) { /* не удалось — вернём null, без служебных заглушек */ }
  return null;
}

function updateChatPreview(chatId, msg) {
  const chat = getChatById(chatId);
  if (!chat) return;
  chat.last_message = msg.encrypted_content ?? msg.content ?? '';
  chat.last_message_type = msg.type || null;
  chat.last_message_time = msg.created_at ?? msg.createdAt ?? Date.now();
  chat.last_sender_id = msg.sender_id ?? msg.senderId ?? 0;
  reorderChat(chat);
  scheduleChatsCache();
  renderChatListThrottled();
}

// ==================== ОТМЕТКА ПРОЧТЕНИЯ ====================
function markChatRead(chatId) {
  const chat = getChatById(chatId);
  const list = messages[chatId] || [];
  if (!chat || !list.length || !currentUser) return;
  const lastId = list[list.length - 1].id;
  if (!chat.last_read_by) chat.last_read_by = {};
  if ((chat.last_read_by[currentUser.id] || 0) >= lastId) return;
  chat.last_read_by[currentUser.id] = lastId;
  if (!privacy.ghost) sendWs({ type: 'read_messages', chatId, lastReadId: lastId });
  updateTicksForChat(chatId);
}

function isMessageReadByOthers(msg, chat) {
  if (!chat || !currentUser) return false;
  const others = (chat.members || []).filter(m => m.id !== currentUser.id);
  if (!others.length) return false;
  const reads = chat.last_read_by || {};
  return others.every(m => (reads[m.id] || 0) >= msg.id);
}

function updateTicksForChat(chatId) {
  const chat = getChatById(chatId);
  const list = messages[chatId] || [];
  list.forEach(msg => {
    if (msg.sender_id !== currentUser?.id) return;
    // Берём узел из кэша рендера: querySelector на каждое сообщение — лишний обход DOM
    const node = msgRender.nodes.get(msg.id) ||
      document.querySelector(`.message[data-msg-id="${msg.id}"]`);
    if (!node) return;
    const el = node.querySelector ? node.querySelector('.tick-marks') : null;
    if (!el) return;
    const read = isMessageReadByOthers(msg, chat);
    el.innerHTML = read
      ? Icons.svg('check-check', { className: 'mq-icon--xs mq-icon--inherit' })
      : Icons.svg('check', { className: 'mq-icon--xs mq-icon--inherit' });
    el.classList.toggle('read', read);
  });
}

async function backToChats() {
  currentChatId = null;
  const area = document.getElementById('active-chat');
  if (area) area.style.display = 'none';
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = 'flex';
  const app = document.getElementById('app-container');
  if (app) app.classList.remove('chat-open');
  syncUrlToChat(null);
  renderChatList();
}

function openChat(chatId) {
  // Очищаем анимации печати от предыдущего чата
  for (const t of typewriterTimers) clearTimeout(t);
  typewriterTimers.clear();

  chatId = Number(chatId);
  const chat = getChatById(chatId);
  if (!chat) return;

  currentChatId = chatId;
  // Публичный id в адресной строке: https://…/00000001 или https://…/-00000000000001
  syncUrlToChat(chat);
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('active-chat').style.display = 'flex';
  document.getElementById('app-container').classList.add('chat-open');
  updateMobileNav();

  for (const [id, el] of chatListNodes) {
    el.classList.toggle('active', Number(id) === chatId);
  }

  updateChatHeader();
  // Мгновенно показываем локальный кэш (если есть), параллельно запрашиваем сервер.
  const hadCache = (messages[chatId] || []).length > 0;
  if (!hadCache) {
    renderCachedHistory(chatId);
    messages[chatId] = messages[chatId] || [];
  }
  sendWs({ type: 'get_messages', chatId, limit: 50 });
}

function updateChatHeader() {
  const chat = getChatById(currentChatId);
  if (!chat) return;

  document.getElementById('chat-header-name').textContent = getChatName(chat);
  const ownerSlot = document.getElementById('chat-header-owner');
  if (ownerSlot) ownerSlot.innerHTML = chatOwner(chat) ? ownerBadgeHtml() : '';
  const ttlEl = document.getElementById('chat-header-ttl');
  const ttl = getChatTtl(chat.id);
  if (ttlEl) {
    ttlEl.innerHTML = ttl
      ? Icons.svg('clock', { className: 'mq-icon--xs mq-icon--inherit' }) +
        '<span>' + escapeHtml(ttlLabel(ttl)) + '</span>'
      : '';
    ttlEl.hidden = !ttl;
    ttlEl.title = ttl ? I18N.t('ttl.header', { label: ttlLabel(ttl) }) : '';
  }
  // Шапка открытого чата: та же логика, что и в списке чатов — <img> с
  // data-avatar-path при наличии ava, динамическая буква иначе; затем
  // hydrateAvatars() подгружает blob через fetch + Bearer-токен.
  const headerAvatarEl = document.getElementById('chat-header-avatar');
  setChatAvatar(headerAvatarEl, chat);
  if (headerAvatarEl) hydrateAvatars(headerAvatarEl);

  const statusEl = document.getElementById('chat-header-status');
  if (chat.type === 'private') {
    const other = chat.members?.find(m => m.id !== currentUser.id);
    if (isChatOnline(chat)) {
      statusEl.textContent = I18N.t('chat.online');
      statusEl.className = 'chat-header-status online';
    } else if (other?.last_seen) {
      statusEl.textContent = I18N.t('chat.lastSeen', { time: formatLastSeen(other.last_seen) });
      statusEl.className = 'chat-header-status';
    } else {
      statusEl.textContent = I18N.t('chat.offline');
      statusEl.className = 'chat-header-status';
    }
  } else if (chat.type === 'group' || chat.type === 'supergroup') {
    statusEl.textContent = I18N.t('chat.membersCount', { count: chat.members?.length || 0 });
  } else {
    statusEl.textContent = I18N.t('chat.notes');
  }
  updateEncryptionBadge();

  const isPrivate = chat.type === 'private';
  const audioBtn = document.getElementById('call-audio-btn');
  const videoBtn = document.getElementById('call-video-btn');
  if (audioBtn) audioBtn.style.display = isPrivate ? '' : 'none';
  if (videoBtn) videoBtn.style.display = isPrivate ? '' : 'none';
}

// ==================== ОТРИСОВКА СООБЩЕНИЙ (ОПТИМИЗИРОВАННАЯ) ====================
// Раньше любое событие (новое сообщение, реакция, правка, чтение) пересобирало
// весь список сообщений заново — это главный источник лагов в длинных чатах.
// Теперь DOM-узлы переиспользуются: пересобирается только то, что изменилось.
const MSG_WINDOW = 150;      // максимум сообщений, удерживаемых в DOM
const MSG_WINDOW_DROP = 40;  // сколько узлов выбрасываем, когда окно переполнено
const RENDER_CHUNK = 12;     // размер порции при параллельной сборке узлов

const msgRender = {
  chatId: null,
  order: [],       // id сообщений в порядке DOM
  nodes: new Map() // id -> HTMLElement
};

// Пагинация истории: hasMore/beforeId на чат + защита от повторных запросов
const chatPager = new Map();
const loadingOlder = new Set();

function msgSig(msg) {
  return `${msg.encrypted_content || ''}|${msg.iv || ''}|${msg.header || ''}|${msg.type || 'text'}`;
}

function reactionsSig(msg) {
  const r = msg.reactions;
  if (!r) return '';
  return Object.keys(r).sort().map(k => `${k}:${(r[k] || []).length}`).join(',');
}

function getMessagesContainer() {
  return document.getElementById('messages-container');
}

async function getChatKeySafe(chatId, chat) {
  try { return await getChatKey(chatId, chat); } catch (e) { return null; }
}

// ==================== ЛОКАЛЬНЫЙ КЭШ ЧАТОВ (IndexedDB) ====================
// Сообщения хранятся шифротекстом + уже расшифрованный текст (он и так
// персистируется в plaintext-кэше). При открытии чата сначала мгновенно
// рисуем кэш, затем «догоняем» недостающие сообщения с сервера одной
// страницей — без бесконечных последовательных выгрузок истории.
const CT_CACHE_DB = 'ciphertalk-cache';
const CT_CACHE_VERSION = 1;
const MSG_CACHE_LIMIT = 500;      // сообщений на чат в кэше
const CHAT_CACHE_LIMIT = 60;      // чатов в кэше
let ctCacheDbPromise = null;

function openCacheDb() {
  if (!ctCacheDbPromise) {
    ctCacheDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('indexedDB unavailable'));
      const req = indexedDB.open(CT_CACHE_DB, CT_CACHE_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('messages')) {
          const st = db.createObjectStore('messages', { keyPath: 'chatId' });
          st.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    }).catch((e) => { ctCacheDbPromise = null; throw e; });
  }
  return ctCacheDbPromise;
}

function idbPut(storeName, value, key) {
  return openCacheDb().then((db) => new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      if (key !== undefined) tx.objectStore(storeName).put(value, key);
      else tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    } catch (e) { reject(e); }
  })).catch(() => {});
}

function idbGet(storeName, key) {
  return openCacheDb().then((db) => new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  })).catch(() => null);
}

function idbDelete(storeName, key) {
  return openCacheDb().then((db) => new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch (e) { resolve(); }
  })).catch(() => {});
}

function cacheMsgRow(m) {
  return {
    id: m.id,
    chat_id: m.chat_id,
    sender_id: m.sender_id,
    sender_name: m.sender_name || '',
    sender_avatar: m.sender_avatar || '',
    encrypted_content: m.encrypted_content || '',
    iv: m.iv || '',
    header: m.header || '',
    type: m.type || 'text',
    reply_to: m.reply_to ?? null,
    edited: m.edited || 0,
    deleted_for_all: m.deleted_for_all || 0,
    forwarded_from: m.forwarded_from ?? null,
    reactions: m.reactions || {},
    pinned: m.pinned || 0,
    expires_at: m.expires_at ?? null,
    created_at: m.created_at,
    plain: getCachedPlaintext(m.chat_id, m.encrypted_content)
  };
}

function cacheMessagesNow(chatId) {
  chatId = Number(chatId);
  const list = messages[chatId];
  if (!Array.isArray(list)) return;
  const now = Date.now();
  const rows = [];
  for (const m of list) {
    if (!m || !m.id) continue;
    if (m.expires_at && Number(m.expires_at) <= now) continue;
    rows.push(cacheMsgRow(m));
  }
  while (rows.length > MSG_CACHE_LIMIT) rows.shift();
  idbPut('messages', { chatId, updatedAt: now, msgs: rows });
}

function scheduleChatCache(chatId) {
  clearTimeout(chatCacheTimers[chatId]);
  chatCacheTimers[chatId] = setTimeout(() => {
    delete chatCacheTimers[chatId];
    cacheMessagesNow(chatId);
  }, 700);
}

function scheduleChatsCache() {
  clearTimeout(chatsCacheTimer);
  chatsCacheTimer = setTimeout(() => {
    let list = Array.isArray(chats) ? chats.slice() : [];
    list.sort((a, b) => (Number(b.last_message_time) || 0) - (Number(a.last_message_time) || 0));
    list = list.slice(0, CHAT_CACHE_LIMIT);
    idbPut('chats', { updatedAt: Date.now(), list });
  }, 800);
}

// Мгновенная отрисовка кэшированной истории до ответа сервера
async function renderCachedHistory(chatId) {
  chatId = Number(chatId);
  const rec = await idbGet('messages', chatId);
  // Пока ждали кэш: пользователь успел закрыть/переключить чат или данные уже пришли
  if (currentChatId !== chatId) return;
  if (!rec || !Array.isArray(rec.msgs) || rec.msgs.length === 0) return;
  if ((messages[chatId] || []).length > 0) return;
  const now = Date.now();
  const list = rec.msgs
    .filter(m => m && m.id && !(m.expires_at && Number(m.expires_at) <= now))
    .map(normalizeMessage);
  if (!list.length) return;
  messages[chatId] = list;
  for (const m of list) scheduleMessageExpiry(chatId, m);
  await renderMessages(chatId, { scroll: true });
}

// Догонка пропусков: если в кэше есть «дырка» между первым сообщением кэша
// и самой старой известной строкой — тянем одну страницу истории с сервера.
function requestMissingGap(chatId) {
  chatId = Number(chatId);
  const list = messages[chatId] || [];
  if (list.length < 2) return;
  const first = list[0];
  const prev = list[1];
  if (Number(prev.id) + 1 === Number(first.id)) return; // дырки нет
  sendWs({ type: 'get_messages', chatId, limit: Math.min(MSG_CACHE_LIMIT, 200), beforeId: first.id });
}

function clearAllChatCache() {
  for (const k in chatCacheTimers) { clearTimeout(chatCacheTimers[k]); delete chatCacheTimers[k]; }
  clearTimeout(chatsCacheTimer);
  openCacheDb().then((db) => new Promise((resolve) => {
    try {
      const tx = db.transaction(['messages', 'chats'], 'readwrite');
      tx.objectStore('messages').clear();
      tx.objectStore('chats').clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch (e) { resolve(); }
  })).catch(() => {});
}

function isScrolledToBottom(container, threshold = 140) {
  if (!container) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

function scrollMessagesToBottom(container, smooth = false) {
  if (!container) return;
  if (smooth && typeof container.scrollTo === 'function') {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  } else {
    container.scrollTop = container.scrollHeight;
  }
  if (typeof hideScrollFab === 'function') hideScrollFab();
}

// Планировщик: несколько событий в одном кадре => один рендер
const renderTasks = new Set();
let renderScheduled = false;
function scheduleRender(fn) {
  renderTasks.add(fn);
  if (renderScheduled) return;
  renderScheduled = true;
  const run = () => {
    renderScheduled = false;
    const tasks = Array.from(renderTasks);
    renderTasks.clear();
    for (const t of tasks) {
      try { t(); } catch (e) { /* рендер не должен ломать UI */ }
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

async function buildMessageNodes(list, chat, key) {
  const out = [];
  for (let i = 0; i < list.length; i += RENDER_CHUNK) {
    const chunk = list.slice(i, i + RENDER_CHUNK);
    const built = await Promise.all(chunk.map(async (msg) => {
      const sig = msgSig(msg);
      const rsig = reactionsSig(msg);
      const old = msgRender.nodes.get(msg.id);
      // Узел актуален — переиспользуем (ни расшифровки, ни пересоздания DOM)
      if (old && old.dataset && old.dataset.sig === sig && old.dataset.rsig === rsig) {
        return { msg, el: old };
      }
      const el = await buildMessageElement(msg, chat, key, false);
      if (el && el.dataset) {
        el.dataset.sig = sig;
        el.dataset.rsig = rsig;
      }
      return { msg, el };
    }));
    out.push(...built);
  }
  return out;
}

function applyMessageNodes(container, built) {
  const nodes = [];
  const map = new Map();
  let lastDate = '';
  for (const item of built) {
    if (!item || !item.msg) continue;
    const date = formatDate(item.msg.created_at);
    if (date !== lastDate) {
      nodes.push(buildDateSeparator(date));
      lastDate = date;
    }
    if (item.el) {
      nodes.push(item.el);
      map.set(item.msg.id, item.el);
    }
  }
  container.innerHTML = '';
  if (typeof document.createDocumentFragment === 'function') {
    const frag = document.createDocumentFragment();
    for (const n of nodes) frag.appendChild(n);
    container.appendChild(frag);
  } else {
    for (const n of nodes) container.appendChild(n);
  }
  msgRender.nodes = map;
  msgRender.order = built.filter(b => b && b.el).map(b => b.msg.id);
}

async function renderMessages(chatId, opts = {}) {
  const container = getMessagesContainer();
  const chat = getChatById(chatId);
  if (!chat || !container) return;

  const list = messages[chatId] || [];
  const key = await getChatKeySafe(chatId, chat);
  const start = Math.max(0, list.length - MSG_WINDOW);
  const view = list.slice(start);
  const ids = view.map(m => m.id);

  const sameOrder = msgRender.chatId === chatId &&
    msgRender.order.length === ids.length &&
    msgRender.order.every((id, i) => id === ids[i]);

  if (sameOrder) {
    // Окно не изменилось — обновляем только изменённые сообщения
    const dirty = view.filter((m) => {
      const el = msgRender.nodes.get(m.id);
      if (!el || !el.dataset) return true;
      return el.dataset.sig !== msgSig(m) || el.dataset.rsig !== reactionsSig(m);
    });
    // Точечно правим только если все узлы на месте — иначе нужна пересборка
    const patchable = dirty.every((m) => {
      const el = msgRender.nodes.get(m.id);
      return !!(el && el.parentNode);
    });
    if (dirty.length && patchable) {
      const built = await buildMessageNodes(dirty, chat, key);
      for (const item of built) {
        const old = msgRender.nodes.get(item.msg.id);
        if (!item.el || !old) continue;
        if (typeof old.replaceWith === 'function') old.replaceWith(item.el);
        else if (old.parentNode) old.parentNode.replaceChild(item.el, old);
        msgRender.nodes.set(item.msg.id, item.el);
      }
      updateTicksForChat(chatId);
      if (opts.scroll !== false) scrollMessagesToBottom(container, opts.smooth);
      return;
    }
    if (!dirty.length) {
      updateTicksForChat(chatId);
      if (opts.scroll !== false) scrollMessagesToBottom(container, opts.smooth);
      return;
    }
    // узлы потеряны (чат переключили) — падаем в полную пересборку ниже
  }

  // Окно изменилось: пересобираем, но переиспользуем готовые узлы
  const prevTop = container.scrollTop;
  const prevHeight = container.scrollHeight;
  const keepPosition = prevTop <= 8; // пользователь наверху — подгрузились старые

  const built = await buildMessageNodes(view, chat, key);
  applyMessageNodes(container, built);
  msgRender.chatId = chatId;

  if (keepPosition) {
    const delta = container.scrollHeight - prevHeight;
    if (delta > 0) container.scrollTop = container.scrollTop + delta;
  } else if (opts.scroll !== false) {
    scrollMessagesToBottom(container, opts.smooth);
  }
}

// Пересобирает окно сообщений, сохраняя позицию скролла (подгрузка старых)
async function refreshWindowPreservingScroll(chatId) {
  const container = getMessagesContainer();
  const chat = getChatById(chatId);
  if (!container || !chat) return;
  const prevHeight = container.scrollHeight;
  const prevTop = container.scrollTop;
  const list = messages[chatId] || [];
  const start = Math.max(0, list.length - MSG_WINDOW);
  const view = list.slice(start);
  const key = await getChatKeySafe(chatId, chat);
  const built = await buildMessageNodes(view, chat, key);
  applyMessageNodes(container, built);
  msgRender.chatId = chatId;
  const delta = container.scrollHeight - prevHeight;
  if (delta > 0) container.scrollTop = prevTop + delta;
}

// Догрузка старых сообщений при прокрутке вверх
function loadOlderMessages() {
  const chatId = currentChatId;
  if (!chatId || loadingOlder.has(chatId)) return;
  const pager = chatPager.get(chatId);
  if (!pager || !pager.hasMore || !pager.beforeId) return;
  loadingOlder.add(chatId);
  sendWs({ type: 'get_messages', chatId, limit: 50, beforeId: pager.beforeId });
}

async function appendMessage(msg) {
  const container = getMessagesContainer();
  const chat = getChatById(currentChatId);
  if (!chat || !container) return;

  const list = messages[currentChatId] || [];
  const prev = list[list.length - 2];
  if (!prev || formatDate(prev.created_at) !== formatDate(msg.created_at)) {
    container.appendChild(buildDateSeparator(formatDate(msg.created_at)));
  }

  const shouldScroll = isScrolledToBottom(container, 180);
  const key = await getChatKeySafe(currentChatId, chat);
  // «Печатная машинка» только для свежих входящих текстовых сообщений.
  const animate = msg.sender_id !== currentUser.id && (msg.type === 'text' || !msg.type);
  const el = await buildMessageElement(msg, chat, key, animate);
  if (el) {
    if (el.dataset) {
      el.dataset.sig = msgSig(msg);
      el.dataset.rsig = reactionsSig(msg);
    }
    container.appendChild(el);
    msgRender.chatId = currentChatId;
    msgRender.order.push(msg.id);
    msgRender.nodes.set(msg.id, el);
    // Окно переполнено — выбрасываем самые старые узлы
    while (msgRender.order.length > MSG_WINDOW) {
      const oldId = msgRender.order.shift();
      const oldEl = msgRender.nodes.get(oldId);
      if (oldEl && oldEl.remove) oldEl.remove();
      msgRender.nodes.delete(oldId);
    }
    if (msg.sender_id === currentUser.id) {
      el.classList.add('sent-pop');
      setTimeout(() => el.classList.remove('sent-pop'), 360);
    }
  }
  if (shouldScroll) scrollMessagesToBottom(container);
  else { showScrollFab(); bumpScrollFabBadge(); }
}

function buildDateSeparator(date) {
  const div = document.createElement('div');
  div.className = 'date-separator';
  const span = document.createElement('span');
  span.textContent = date;
  div.appendChild(span);
  return div;
}

// Плейсхолдеры, которые показываются вместо текста сообщения.
// Раньше это были эмодзи в тексте — теперь у них отдельная SVG-иконка.
function placeholderIcon(text) {
  if (!text) return null;
  if (text === I18N.t('chat.noKey')) return 'lock';
  if (text === I18N.t('chat.decryptFailed')) return 'alert-circle';
  if (text === I18N.t('chat.waitingKey')) return 'clock';
  return null;
}

async function buildMessageElement(msg, chat, key, animate = false) {
  const isOut = msg.sender_id === currentUser.id;
  const wrapper = document.createElement('div');
  wrapper.className = `message ${isOut ? 'out' : 'in'}`;
  wrapper.dataset.msgId = String(msg.id);

  if (!isOut && chat.type !== 'private' && chat.type !== 'saved') {
    const senderMember = chat.members?.find(m => m.id === msg.sender_id);
    const senderEl = document.createElement('div');
    senderEl.className = 'message-sender';
    senderEl.textContent = msg.sender_name || senderMember?.name || '';
    appendOwnerBadge(senderEl, senderMember);
    wrapper.appendChild(senderEl);
  }

  // Превью ответа на сообщение
  if (msg.reply_to) {
    const original = (messages[chat?.id] || []).find(m => m.id === Number(msg.reply_to));
    if (original) {
      const preview = document.createElement('div');
      preview.className = 'reply-preview';
      let author = original.sender_name || I18N.t('chat.peer');
      let text = '';
      let icon = 'lock';
      try {
        if (key) {
          text = await decryptChatText(key, original, chat.id, original.sender_id === currentUser.id);
          icon = placeholderIcon(text) || null;
          if (!icon) text = String(text);
        }
      } catch (e) { text = ''; icon = 'lock'; }
      preview.innerHTML = `<span class="rp-name">${escapeHtml(author)}</span>` +
        (icon ? Icons.svg(icon, { className: 'mq-icon--xs mq-icon--inherit' }) : '') +
        `<span class="rp-text">${escapeHtml(String(text).slice(0, 80))}</span>`;
      preview.addEventListener('click', () => {
        const el = document.querySelector(`.message[data-msg-id="${original.id}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      wrapper.appendChild(preview);
    }
  }

  wrapper.appendChild(await buildMessageContent(msg, chat, key, animate));

  // Реакции
  if (msg.reactions && Object.keys(msg.reactions).length) {
    const row = document.createElement('div');
    row.className = 'message-reactions';
    Object.entries(msg.reactions).forEach(([emoji, users]) => {
      const chip = document.createElement('button');
      chip.className = 'reaction-chip' + ((users || []).includes(currentUser.id) ? ' mine' : '');
      const iconName = Icons.REACTION_ICONS[emoji];
      if (iconName) {
        chip.innerHTML = Icons.svg(iconName, { className: 'mq-icon--xs reaction-icon' }) +
          `<span class="rc-count">${(users || []).length}</span>`;
      } else {
        chip.textContent = `${emoji} ${(users || []).length}`;
      }
      chip.title = `${emoji} ${(users || []).length}`;
      chip.addEventListener('click', () => sendReaction(msg.id, emoji));
      row.appendChild(chip);
    });
    wrapper.appendChild(row);
  }

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  if (msg.edited) {
    const edited = document.createElement('span');
    edited.className = 'message-edited';
    edited.textContent = I18N.t('chat.edited');
    meta.appendChild(edited);
  }
  if (msg.expires_at) {
    const ttl = document.createElement('span');
    ttl.className = 'message-ttl';
    ttl.title = I18N.t('ttl.messageHint');
    ttl.innerHTML = Icons.svg('clock', { className: 'mq-icon--xs mq-icon--inherit' });
    meta.appendChild(ttl);
  }
  const time = document.createElement('span');
  time.textContent = formatMessageTime(msg.created_at);
  meta.appendChild(time);
  if (isOut) {
    const ticks = document.createElement('span');
    const read = isMessageReadByOthers(msg, chat);
    ticks.className = 'tick-marks' + (read ? ' read' : '');
    ticks.innerHTML = read
      ? Icons.svg('check-check', { className: 'mq-icon--xs mq-icon--inherit' })
      : Icons.svg('check', { className: 'mq-icon--xs mq-icon--inherit' });
    meta.appendChild(ticks);
  }
  wrapper.appendChild(meta);

  if (isOut) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (msg.type === 'text') {
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.innerHTML = Icons.svg('edit', { className: 'mq-icon--sm' });
      editBtn.title = I18N.t('msg.edit');
      editBtn.onclick = () => editMessage(msg.id);
      actions.appendChild(editBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-action-btn';
    delBtn.innerHTML = Icons.svg('trash', { className: 'mq-icon--sm' });
    delBtn.title = I18N.t('msg.delete');
    delBtn.onclick = () => deleteMessage(msg.id);
    actions.appendChild(delBtn);
    wrapper.appendChild(actions);
  }

  return wrapper;
}

async function buildMessageContent(msg, chat, key, animate = false) {
  const chatId = chat?.id ?? msg.chat_id;

  if (msg.deleted_for_all) {
    const div = document.createElement('div');
    div.className = 'message-text message-deleted';
    div.innerHTML = Icons.svg('trash', { className: 'mq-icon--xs mq-inline-icon' }) +
      '<span class="cp-text"></span>';
    div.querySelector('.cp-text').textContent = I18N.t('chat.deleted');
    return div;
  }

  const isOwn = msg.sender_id === currentUser.id;

  if (msg.type === 'text' || !msg.type) {
    const div = document.createElement('div');
    div.className = 'message-text';
    const raw = msg.encrypted_content;
    if (!raw) return div;
    let text = I18N.t('chat.noKey');
    if (key) {
      try {
        text = await decryptChatText(key, msg, chatId, isOwn);
      } catch (e) {
        text = I18N.t('chat.decryptFailed');
      }
    }
    const phIcon = placeholderIcon(text);
    if (animate && text && !phIcon) {
      typewriter(div, text);
    } else {
      div.innerHTML = (phIcon ? Icons.svg(phIcon, { className: 'mq-icon--xs mq-icon--inherit' }) : '') +
        formatMessageText(text);
    }
    return div;
  }

  let payload = null;
  if (key && msg.encrypted_content) {
    try {
      const decrypted = await decryptChatText(key, msg, chatId, isOwn);
      if (decrypted && !placeholderIcon(decrypted)) payload = JSON.parse(decrypted);
    } catch (e) { payload = null; }
  }

  if (!payload || !payload.url) {
    const div = document.createElement('div');
    div.className = 'message-media-unavailable';
    div.innerHTML = Icons.svg('image', { className: 'mq-icon--sm mq-inline-icon' }) +
      '<span class="cp-text">' + escapeHtml(I18N.t('chat.mediaUnavailable')) + '</span>';
    return div;
  }

  if (msg.type === 'sticker' || msg.type === 'custom_sticker') return buildSticker(payload, key);
  if (msg.type === 'image') return buildImage(payload, key);
  if (msg.type === 'voice') return buildVoice(payload, key);
  if (msg.type === 'video') return buildVideo(payload, key);
  return buildFile(payload, key);
}

async function getMediaObjectUrl(payload, key) {
  if (mediaCache.has(payload.url)) return mediaCache.get(payload.url);

  const res = await fetch(SERVER_URL + payload.url, {
    headers: authToken ? { Authorization: 'Bearer ' + authToken } : {}
  });
  if (!res.ok) throw new Error(I18N.t('err.downloadStatus', { status: res.status }));

  const encrypted = await res.arrayBuffer();
  const plain = await decryptBlob(encrypted, key);
  const objectUrl = URL.createObjectURL(
    new Blob([plain], { type: payload.mime || 'application/octet-stream' })
  );

  if (mediaCache.size >= MEDIA_CACHE_LIMIT) {
    let evicted = false;
    for (const [url, objUrl] of mediaCache) {
      if (activeMediaUrls.has(url)) continue;
      URL.revokeObjectURL(objUrl);
      mediaCache.delete(url);
      evicted = true;
      break;
    }
    if (!evicted) {
      // Все кэшированные URL активны — отдаём новый без кэширования
      return objectUrl;
    }
  }
  mediaCache.set(payload.url, objectUrl);
  return objectUrl;
}

function buildImage(payload, key) {
  const wrap = document.createElement('div');
  wrap.className = 'image-message';
  const placeholder = document.createElement('div');
  placeholder.className = 'media-loading';
  placeholder.textContent = I18N.t('chat.loadingImage');
  wrap.appendChild(placeholder);

  const load = async () => {
    try {
      const src = await getMediaObjectUrl(payload, key);
      const img = document.createElement('img');
      img.src = src;
      img.alt = payload.name || I18N.t('chat.image');
      img.onclick = () => window.open(src, '_blank', 'noopener');
      placeholder.replaceWith(img);
    } catch (e) {
      placeholder.innerHTML = Icons.svg('image', { className: 'mq-icon--sm mq-inline-icon' }) +
        '<span class="cp-text">' + escapeHtml(I18N.t('chat.imageUnavailable')) + '</span>';
      placeholder.classList.add('media-error');
    }
  };
  lazyLoad(wrap, load);
  return wrap;
}

function buildVoice(payload, key) {
  const wrap = document.createElement('div');
  wrap.className = 'voice-message';

  const btn = document.createElement('button');
  btn.className = 'voice-play-btn';
  btn.innerHTML = Icons.svg('play', { className: 'mq-icon--sm' });

  const wave = document.createElement('div');
  wave.className = 'voice-waveform';
  for (let i = 0; i < 18; i++) {
    const bar = document.createElement('div');
    bar.className = 'voice-bar';
    bar.style.height = (5 + Math.random() * 16).toFixed(1) + 'px';
    wave.appendChild(bar);
  }

  const duration = document.createElement('span');
  duration.className = 'voice-duration';
  duration.textContent = formatDuration(payload.duration);

  let audio = null;
  let audioSrc = null;
  btn.onclick = async () => {
    try {
      if (!audio) {
        btn.disabled = true;
        audioSrc = await getMediaObjectUrl(payload, key);
        activeMediaUrls.add(audioSrc);
        audio = new Audio(audioSrc);
        btn._audio = audio; // храним ссылку на элементе, чтобы не verlorсь при GC
        audio.onplay = () => { btn.innerHTML = Icons.svg('pause', { className: 'mq-icon--sm' }); };
        audio.onpause = () => { btn.innerHTML = Icons.svg('play', { className: 'mq-icon--sm' }); };
        audio.onended = () => {
          btn.innerHTML = Icons.svg('play', { className: 'mq-icon--sm' });
          if (audioSrc) { activeMediaUrls.delete(audioSrc); }
        };
        audio.onerror = () => {
          btn.innerHTML = Icons.svg('play', { className: 'mq-icon--sm' });
          if (audioSrc) { activeMediaUrls.delete(audioSrc); }
        };
        btn.disabled = false;
      }
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch (e) {
      btn.disabled = false;
      if (e.message && (e.message.includes('interrupted') || e.name === 'NotAllowedError')) {
        audio = null;
        audioSrc = null;
        btn._audio = null;
        btn.innerHTML = Icons.svg('play', { className: 'mq-icon--sm' });
        return;
      }
      showToast(I18N.t('err.play', { error: e.message }), 'error');
    }
  };

  wrap.append(btn, wave, duration);
  return wrap;
}

function buildVideo(payload, key) {
  const wrap = document.createElement('div');
  wrap.className = 'video-circle';

  const placeholder = document.createElement('div');
  placeholder.className = 'media-loading';
  placeholder.textContent = I18N.t('chat.tapToLoadVideo');

  const play = document.createElement('div');
  play.className = 'video-play';
  play.innerHTML = Icons.svg('play', { className: 'mq-icon--lg' });

  const duration = document.createElement('div');
  duration.className = 'video-duration';
  duration.textContent = formatDuration(payload.duration);

  wrap.append(placeholder, play, duration);

  let video = null;
  wrap.onclick = async () => {
    try {
      if (!video) {
        placeholder.textContent = I18N.t('chat.loadingVideo');
        const src = await getMediaObjectUrl(payload, key);
        video = document.createElement('video');
        video.src = src;
        video.playsInline = true;
        video.preload = 'auto';
        video.onplay = () => wrap.classList.add('playing');
        video.onpause = () => wrap.classList.remove('playing');
        video.onended = () => wrap.classList.remove('playing');
        placeholder.remove();
        wrap.insertBefore(video, wrap.firstChild);
      }
      if (video.paused) await video.play();
      else video.pause();
    } catch (e) {
      placeholder.innerHTML = Icons.svg('video', { className: 'mq-icon--sm mq-inline-icon' }) +
        '<span class="cp-text">' + escapeHtml(I18N.t('chat.videoUnavailable')) + '</span>';
      placeholder.classList.add('media-error');
      showToast(I18N.t('err.playVideo', { error: e.message }), 'error');
    }
  };

  return wrap;
}

function buildFile(payload, key) {
  const wrap = document.createElement('div');
  wrap.className = 'file-message';

  const icon = document.createElement('div');
  icon.className = 'file-icon';
  icon.innerHTML = fileIcon(payload.mime);

  const info = document.createElement('div');
  info.className = 'file-info';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = payload.name || I18N.t('chat.file');
  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = formatBytes(payload.size) + I18N.t('chat.clickToDownload');
  info.append(name, size);

  wrap.append(icon, info);
  wrap.onclick = async () => {
    try {
      const src = await getMediaObjectUrl(payload, key);
      const a = document.createElement('a');
      a.href = src;
      a.download = payload.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      showToast(I18N.t('err.downloadFile', { error: e.message }), 'error');
    }
  };
  return wrap;
}

function fileIcon(mime) {
  if (!mime) return Icons.svg('paperclip', { className: 'mq-icon--lg' });
  if (mime.startsWith('image/')) return Icons.svg('image', { className: 'mq-icon--lg' });
  if (mime.startsWith('audio/')) return Icons.svg('music', { className: 'mq-icon--lg' });
  if (mime.startsWith('video/')) return Icons.svg('film', { className: 'mq-icon--lg' });
  if (mime.includes('pdf')) return Icons.svg('file-text', { className: 'mq-icon--lg' });
  if (mime.includes('zip') || mime.includes('compressed')) return Icons.svg('file-archive', { className: 'mq-icon--lg' });
  return Icons.svg('paperclip', { className: 'mq-icon--lg' });
}

function lazyLoad(el, fn) {
  if (!('IntersectionObserver' in window)) {
    fn();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) {
      observer.disconnect();
      fn();
    }
  }, { rootMargin: '200px' });
  observer.observe(el);
}

// ==================== ОТПРАВКА ====================
async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !currentChatId) return;

  const chat = getChatById(currentChatId);
  let key;
  try {
    key = await getChatKey(currentChatId, chat);
  } catch (err) {
    showToast(err.message, 'error', 'lock');
    return;
  }

  let envelope;
  try {
    envelope = await encryptChatText(key, text, currentChatId);
  } catch (err) {
    showToast(err.message, 'error', 'lock');
    return;
  }
  rememberSent(currentChatId, envelope.content, text);
  const replyTo = (typeof replyContext !== 'undefined' && replyContext) ? replyContext.messageId : null;
  const sent = sendWs({
    type: 'send_message',
    chatId: currentChatId,
    content: envelope.content,
    iv: envelope.iv,
    header: envelope.header,
    msgType: 'text',
    replyTo: replyTo || null,
    ttlSeconds: getChatTtl(currentChatId)
  });
  if (!sent) return;

  // Анимация «отправки»
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    sendBtn.classList.add('sending-pop');
    setTimeout(() => sendBtn.classList.remove('sending-pop'), 280);
  }

  input.value = '';
  input.style.height = 'auto';

  // Контекст ответа сбрасывается после успешной отправки
  if (replyTo && typeof cancelReply === 'function') cancelReply();
}

function handleKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleTyping() {
  if (!currentChatId || privacy.ghost) return;
  const now = Date.now();
  if (now - lastTypingSent < 2000) return;
  lastTypingSent = now;
  sendWs({ type: 'typing', chatId: currentChatId });
}

async function editMessage(msgId) {
  const list = messages[currentChatId] || [];
  const msg = list.find(m => m.id === Number(msgId));
  if (!msg) return;

  const chat = getChatById(currentChatId);
  let key;
  try { key = await getChatKey(currentChatId, chat); }
  catch (err) { return showToast(err.message, 'error', 'lock'); }

  let currentText = '';
  try { currentText = await decryptChatText(key, msg, currentChatId); } catch (e) { /* ignore */ }

  const newText = prompt(I18N.t('msg.editPrompt'), currentText);
  if (newText === null || newText === currentText || !newText.trim()) return;

  const envelope = await encryptChatText(key, newText.trim(), currentChatId);
  sendWs({
    type: 'edit_message',
    chatId: currentChatId,
    messageId: msgId,
    content: envelope.content,
    iv: envelope.iv,
    header: envelope.header
  });
}

function deleteMessage(msgId) {
  if (!confirm(I18N.t('msg.deleteConfirm'))) return;
  sendWs({ type: 'delete_message', chatId: currentChatId, messageId: msgId });
}

// ==================== МЕДИА ====================
function pickMimeType(kind) {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = kind === 'video'
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find(type => {
    try { return MediaRecorder.isTypeSupported(type); } catch (e) { return false; }
  }) || '';
}

async function toggleVoiceRecording() {
  if (mediaRecorder && recordingType === 'voice') stopRecording();
  else await startRecording('voice');
}

async function toggleVideoRecording() {
  if (mediaRecorder && recordingType === 'video') stopRecording();
  else await startRecording('video');
}

async function startRecording(type) {
  if (!currentChatId) {
    showToast(I18N.t('err.pickChat'), 'error');
    return;
  }
  if (mediaRecorder) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast(I18N.t('err.noMediaSupport'), 'error');
    return;
  }

  try {
    const constraints = type === 'video'
      ? { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } }
      : { audio: true };

    recordingStream = await navigator.mediaDevices.getUserMedia(constraints);
    recordedChunks = [];
    recordingType = type;
    recordingStartTime = Date.now();

    const mimeType = pickMimeType(type);
    mediaRecorder = mimeType
      ? new MediaRecorder(recordingStream, { mimeType })
      : new MediaRecorder(recordingStream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const durationSec = Math.round((Date.now() - recordingStartTime) / 1000);
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || (type === 'video' ? 'video/webm' : 'audio/webm') });
      const chatIdAtStart = currentChatId;
      resetRecordingUI();

      if (durationSec < 1 || blob.size === 0) {
        showToast(I18N.t('err.tooShort'), 'error');
        return;
      }

      try {
        await sendMediaBlob(blob, type, {
          chatId: chatIdAtStart,
          duration: durationSec,
          name: type === 'video' ? I18N.t('chat.videoMsg') : I18N.t('chat.voiceMsg'),
          mime: blob.type
        });
      } catch (e) {
        showToast(I18N.t('err.sendFailed') + ' ' + e.message, 'error');
      }
    };

    mediaRecorder.start(250);
    updateRecordingUI(true);

    const maxSeconds = type === 'video' ? MAX_VIDEO_SECONDS : MAX_VOICE_SECONDS;
    recordingMaxTimer = setTimeout(() => {
      showToast(I18N.t('err.recLimit', { seconds: maxSeconds }), 'error');
      stopRecording();
    }, maxSeconds * 1000);

    recordingInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      updateRecordingTime(elapsed);
    }, 500);
  } catch (e) {
    showToast(I18N.t('err.noMediaAccess') + ' ' + e.message, 'error');
  }
}

function stopRecording() {
  if (recordingMaxTimer) {
    clearTimeout(recordingMaxTimer);
    recordingMaxTimer = null;
  }
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    resetRecordingUI();
  }
}

function updateRecordingUI(isRecording) {
  const inputArea = document.getElementById('input-area');
  const messageInput = document.getElementById('message-input');
  const voiceBtn = document.getElementById('voice-btn');
  const videoBtn = document.getElementById('video-btn');
  const sendBtn = document.getElementById('send-btn');

  if (isRecording) {
    messageInput.style.display = 'none';
    sendBtn.style.display = 'none';
    if (recordingType === 'voice') voiceBtn.classList.add('recording');
    else videoBtn.classList.add('recording');

    const indicator = document.createElement('div');
    indicator.id = 'recording-indicator';
    indicator.className = 'recording-indicator';
    indicator.innerHTML = `
      <div class="recording-dot"></div>
      <span class="recording-time" id="recording-time">0:00</span>
      <span class="recording-text">${recordingType === 'video' ? I18N.t('rec.video') : I18N.t('rec.audio')}</span>
    `;
    inputArea.insertBefore(indicator, messageInput);
  } else {
    messageInput.style.display = '';
    sendBtn.style.display = '';
    voiceBtn.classList.remove('recording');
    videoBtn.classList.remove('recording');
    const indicator = document.getElementById('recording-indicator');
    if (indicator) indicator.remove();
  }
}

function updateRecordingTime(seconds) {
  const timeEl = document.getElementById('recording-time');
  if (timeEl) timeEl.textContent = formatDuration(seconds);
}

function resetRecordingUI() {
  if (recordingStream) {
    recordingStream.getTracks().forEach(track => track.stop());
    recordingStream = null;
  }
  if (recordingMaxTimer) {
    clearTimeout(recordingMaxTimer);
    recordingMaxTimer = null;
  }
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  updateRecordingUI(false);
  mediaRecorder = null;
  recordedChunks = [];
  recordingType = null;
}

// ==================== СТИКЕРЫ ====================
function stickerSrc(s) {
  // Для серверных стикеров картинка зашифрована (application/octet-stream),
  // поэтому <img src> по URL не сработает — используем локальный dataURL-кэш.
  return s.svg || s.url || '';
}

function openStickerPicker() {
  if (!currentChatId) {
    showToast(I18N.t('err.pickChat'), 'error');
    return;
  }
  const systemItems = Icons.STICKERS.map((s) => `
    <button class="sticker-item" data-action="sendSticker" data-id="${s.id}" title="${escapeHtml(s.id)}">
      <img src="data:image/svg+xml;utf8,${encodeURIComponent(s.svg)}" alt="${escapeHtml(s.id)}" loading="lazy">
    </button>`).join('');
  const userItems = userStickers.map((s) => `
    <button class="sticker-item" data-action="sendUserSticker" data-id="${s.id}" title="${escapeHtml(s.name || s.id)}">
      <img src="${escapeHtml(stickerSrc(s))}" alt="${escapeHtml(s.name || s.id)}" loading="lazy">
      ${s.animated ? '<span class="sticker-animated-badge">GIF</span>' : ''}
    </button>`).join('');
  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${I18N.t('chat.stickers')}</h2>
    <div class="sticker-picker">${systemItems}${userItems}</div>
    <div style="margin-top:12px;padding:8px;border-top:1px solid var(--border);display:flex;gap:8px;">
      <button class="btn btn-secondary" data-action="openStickerCreator" style="flex:1;padding:8px;">
        ${Icons.svg('plus', { className: 'mq-icon--sm' })} ${I18N.t('sticker.create')}
      </button>
      <button class="btn btn-secondary" data-action="openMyStickers" style="flex:1;padding:8px;">
        ${Icons.svg('settings', { className: 'mq-icon--sm' })} ${I18N.t('sticker.myStickers')}
      </button>
    </div>
  `);
}

async function openStickerCreator() {
  closeModal();
  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${I18N.t('sticker.createTitle')}</h2>
    <div class="input-group">
      <label>${I18N.t('sticker.name')}</label>
      <input type="text" id="sticker-name-input" placeholder="${I18N.t('sticker.namePlaceholder')}">
    </div>
    <div class="input-group">
      <label>${I18N.t('sticker.file')}</label>
      <input type="file" id="sticker-file-input" accept="image/png,image/jpeg,image/webp,image/gif">
      <small style="opacity:.7">${I18N.t('sticker.hint')}</small>
    </div>
    <button class="btn" data-action="createSticker">${I18N.t('sticker.upload')}</button>
  `);
}

// Проверка анимации на клиенте по «сырым» байтам (Canvas для GIF/WebP не
// используется, чтобы не убить анимацию при перерисовке).
async function isAnimatedFile(file) {
  if (file.type === 'image/gif') {
    const buf = new Uint8Array(await file.arrayBuffer());
    let frames = 0;
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === 0x21 && buf[i + 1] === 0xF9) frames++;
      if (frames >= 2) return true;
    }
    return false;
  }
  if (file.type === 'image/webp') {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer());
    const asChars = String.fromCharCode.apply(null, head);
    return asChars.includes('ANIM') || asChars.includes('ANMF');
  }
  return false;
}

// Центрированная обрезка до квадрата 512x512 + сжатие в WebP (только статика)
async function cropToSticker(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(I18N.t('sticker.errDecode')));
      img.src = url;
    });
    const SIZE = 512;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = Math.round((img.naturalWidth - side) / 2);
    const sy = Math.round((img.naturalHeight - side) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    return blob || file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function createSticker() {
  const nameInput = document.getElementById('sticker-name-input');
  const fileInput = document.getElementById('sticker-file-input');
  const name = nameInput.value.trim();
  if (!name) {
    showToast(I18N.t('sticker.errName'), 'error');
    return;
  }
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    showToast(I18N.t('sticker.errFile'), 'error');
    return;
  }
  const file = fileInput.files[0];
  if (file.size > 1024 * 1024) {
    showToast(I18N.t('sticker.errTooBig'), 'error');
    return;
  }

  const animated = await isAnimatedFile(file);
  // Статичные PNG/JPEG (и неанимированные WebP) режем через Canvas;
  // анимированные GIF/WebP отправляем как есть.
  const outBlob = animated ? file : await cropToSticker(file);
  const outName = animated ? (file.name || 'sticker') : ('sticker-' + Date.now() + '.webp');

  // Загружаем на сервер: POST /api/stickers (проверит размер и тип ещё раз)
  const form = new FormData();
  form.append('name', name);
  form.append('file', outBlob, outName);
  let serverData;
  try {
    const res = await fetch(SERVER_URL + '/api/stickers', {
      method: 'POST',
      headers: authToken ? { Authorization: 'Bearer ' + authToken } : {},
      body: form
    });
    serverData = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(serverData.error || I18N.t('sticker.errUpload'), 'error');
      return;
    }
  } catch (e) {
    showToast(I18N.t('sticker.errUpload') + ' ' + e.message, 'error');
    return;
  }

  // dataURL-копию храним локально: серверный файл — шифротекст, обычный
  // <img src="/uploads/..."> его не отобразит без дешифровки на клиенте.
  const previewUrl = await fileToDataURL(outBlob);
  userStickers.unshift({
    id: serverData.id,
    fileId: serverData.fileId,
    svg: previewUrl,
    url: serverData.url,
    name,
    animated: !!serverData.animated,
    server: true
  });
  saveUserStickers();
  closeModal();
  showToast(I18N.t('sticker.created'), 'success');
  openStickerPicker();
}

// Вкладка «Мои стикеры»: список с кнопками «Удалить» и «Загрузить стикер»
async function openMyStickers() {
  closeModal();
  await fetchServerStickers();
  renderMyStickers();
}

function renderMyStickers() {
  const items = userStickers.map((s) => `
    <div class="my-sticker-item">
      <img src="${escapeHtml(stickerSrc(s))}" alt="${escapeHtml(s.name || '')}" loading="lazy">
      <div class="my-sticker-meta">
        <span class="my-sticker-name">${escapeHtml(s.name || s.id)}</span>
        ${s.animated ? '<span class="sticker-animated-badge">GIF</span>' : ''}
      </div>
      <button class="btn btn-danger btn-sm" data-action="deleteUserSticker" data-id="${s.id}">
        ${Icons.svg('trash', { className: 'mq-icon--sm' })} ${I18N.t('sticker.delete')}
      </button>
    </div>`).join('');
  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${I18N.t('sticker.myStickers')}</h2>
    <div class="my-stickers-list">${items || `<p style="opacity:.7">${I18N.t('sticker.empty')}</p>`}</div>
    <div style="margin-top:12px;display:flex;gap:8px;">
      <button class="btn" data-action="openStickerCreator" style="flex:1;">
        ${Icons.svg('upload', { className: 'mq-icon--sm' })} ${I18N.t('sticker.upload')}
      </button>
    </div>
  `);
}

async function deleteUserSticker(stickerId) {
  const idx = userStickers.findIndex((s) => String(s.id) === String(stickerId));
  if (idx === -1) return;
  const sticker = userStickers[idx];
  try {
    const res = await fetch(SERVER_URL + '/api/stickers/' + encodeURIComponent(stickerId), {
      method: 'DELETE',
      headers: authToken ? { Authorization: 'Bearer ' + authToken } : {}
    });
    if (!res.ok && res.status !== 404) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || I18N.t('sticker.errDelete'), 'error');
      return;
    }
  } catch (e) {
    showToast(I18N.t('sticker.errDelete') + ' ' + e.message, 'error');
    return;
  }
  userStickers.splice(idx, 1);
  saveUserStickers();
  renderMyStickers();
  showToast(I18N.t('sticker.deleted'), 'success');
}

async function sendSticker(stickerId) {
  const sticker = Icons.STICKERS.find((s) => s.id === stickerId);
  if (!sticker) return;
  if (!currentChatId) {
    showToast(I18N.t('err.pickChat'), 'error');
    return;
  }
  const chatIdAtStart = currentChatId;
  closeModal();
  try {
    const blob = new Blob([sticker.svg], { type: 'image/svg+xml' });
    await sendMediaBlob(blob, 'sticker', {
      chatId: chatIdAtStart,
      duration: 0,
      name: `sticker-${sticker.id}.svg`,
      mime: 'image/svg+xml'
    });
  } catch (err) {
    showToast(I18N.t('err.sendFailed') + ' ' + err.message, 'error');
  }
}

async function sendUserSticker(stickerId) {
  const sticker = userStickers.find(s => String(s.id) === String(stickerId));
  if (!sticker) return;
  if (!currentChatId) {
    showToast(I18N.t('err.pickChat'), 'error');
    return;
  }
  const chatIdAtStart = currentChatId;
  closeModal();
  try {
    // Берём локальную dataURL-копию (или серверный URL, если он доступен как
    // картинка напрямую). Браузер сам проиграет анимацию GIF/WebP в <img>.
    const response = await fetch(stickerSrc(sticker));
    const blob = await response.blob();
    await sendMediaBlob(blob, 'custom_sticker', {
      chatId: chatIdAtStart,
      duration: 0,
      name: `sticker-${sticker.name || sticker.id}.${fileInputMime(blob)}`,
      mime: blob.type || 'image/webp'
    });
  } catch (err) {
    showToast(I18N.t('err.upload') + ' ' + err.message, 'error', 'alert-circle');
  }
}

function fileInputMime(blob) {
  const type = blob.type || 'image/png';
  return type.split('/').pop() || 'png';
}

// Стикер в сообщении — это картинка (SVG/Lottie), а не текстовый смайлик
function buildSticker(payload, key) {
  const wrap = document.createElement('div');
  wrap.className = 'sticker-message';
  const placeholder = document.createElement('div');
  placeholder.className = 'media-loading';
  placeholder.textContent = I18N.t('chat.loadingImage');
  wrap.appendChild(placeholder);

  const load = async () => {
    try {
      const src = await getMediaObjectUrl(payload, key);
      const img = document.createElement('img');
      img.src = src;
      img.alt = payload.name || 'sticker';
      img.onclick = () => window.open(src, '_blank', 'noopener');
      placeholder.replaceWith(img);
    } catch (e) {
      placeholder.textContent = I18N.t('chat.imageUnavailable');
    }
  };
  lazyLoad(wrap, load);
  return wrap;
}

function attachFile() {
  if (!currentChatId) {
    showToast(I18N.t('err.pickChat'), 'error');
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      showToast(I18N.t('err.fileTooLarge'), 'error');
      return;
    }

    const chatIdAtStart = currentChatId;
    const kind = (file.type || '').startsWith('image/') ? 'image' : 'file';
    showToast(I18N.t('chat.uploadingFile'));
    try {
      await sendMediaBlob(file, kind, {
        chatId: chatIdAtStart,
        duration: 0,
        name: file.name,
        mime: file.type || 'application/octet-stream'
      });
      showToast(I18N.t('toast.fileSent'), 'success');
    } catch (err) {
      showToast(I18N.t('err.upload') + ' ' + err.message, 'error');
    }
  };
  input.click();
}

async function sendMediaBlob(blob, kind, opts) {
  const chatId = Number(opts.chatId);
  const chat = getChatById(chatId);
  if (!chat) throw new Error(I18N.t('err.chatNotFound'));

  const key = await getChatKey(chatId, chat);
  if (!key) throw new Error(I18N.t('err.noKey'));

  const buffer = await blob.arrayBuffer();
  const encrypted = await encryptBlob(buffer, key);

  const form = new FormData();
  form.append('file', new Blob([encrypted], { type: 'application/octet-stream' }), 'encrypted.bin');

  const res = await fetch(SERVER_URL + '/api/upload', {
    method: 'POST',
    headers: authToken ? { Authorization: 'Bearer ' + authToken } : {},
    body: form
  });
  const uploaded = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(uploaded.error || I18N.t('err.fileRejected'));
  }

  const payload = {
    url: uploaded.url,
    fileId: uploaded.fileId,
    name: opts.name || I18N.t('chat.file'),
    size: buffer.byteLength,
    mime: opts.mime || blob.type || 'application/octet-stream',
    duration: opts.duration || 0
  };

  const envelope = await encryptChatText(key, JSON.stringify(payload), chatId);
  rememberSent(chatId, envelope.content, JSON.stringify(payload));
  const sent = sendWs({
    type: 'send_message',
    chatId,
    content: envelope.content,
    iv: envelope.iv,
    header: envelope.header,
    msgType: kind,
    ttlSeconds: getChatTtl(chatId)
  });
  if (!sent) throw new Error(I18N.t('err.noConnection'));
}

// ==================== UI ====================
function showModal(html) {
  const content = document.getElementById('modal-content');
  content.innerHTML = html;
  document.getElementById('modal-overlay').classList.add('show');
  // Аватары из /uploads/ требуют Authorization-заголовок — догружаем их
  // blob-URL'ами после вставки строковой разметки (модалки, инфо о чате).
  hydrateAvatarImages(content);
}

// Рендер «отложенных» аватаров: контейнеры с data-avatar-markup (строковая
// разметка chatAvatarMarkup/userAvatarMarkup, сохранённая через
// encodeURIComponent) заполняются через paintAvatar — с подгрузкой blob для
// /uploads/ и гарантированной первой буквой имени при любой неудаче.
function renderDeferredAvatars(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('[data-avatar-markup]').forEach((el) => {
    let markup = '';
    try { markup = decodeURIComponent(el.getAttribute('data-avatar-markup') || ''); } catch (e) { /* ignore */ }
    el.removeAttribute('data-avatar-markup');
    paintAvatar(el, markup);
  });
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  // Анимация выхода: сначала fade-out, потом скрытие
  overlay.classList.add('closing');
  const hide = () => {
    overlay.classList.remove('show', 'closing');
    const content = document.getElementById('modal-content');
    if (content) content.innerHTML = '';
  };
  setTimeout(hide, 170);
}

function toggleMenu() {
  document.getElementById('side-menu').classList.toggle('open');
  document.getElementById('menu-backdrop').classList.toggle('show');
}

function closeChat() {
  for (const t of typewriterTimers) clearTimeout(t);
  typewriterTimers.clear();
  currentChatId = null;
  syncUrlToChat(null);
  document.getElementById('app-container').classList.remove('chat-open');
  updateMobileNav();
  document.getElementById('active-chat').style.display = 'none';
  document.getElementById('empty-state').style.display = 'flex';
  for (const el of chatListNodes.values()) el.classList.remove('active');
  hideScrollFab();
  // Кэш рендера больше невалиден для открытого чата
  msgRender.chatId = null;
  msgRender.order = [];
  msgRender.nodes.clear();
  // Сброс контекста ответа и состояния долгого нажатия — иначе ответ уйдёт в другой чат
  if (typeof window._ctResetReply === 'function') window._ctResetReply();
  if (typeof window._ctResetTouch === 'function') window._ctResetTouch();
}

function openSearch() {
  toggleMenu();
  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${I18N.t('search.title')}</h2>
    <div class="input-group">
      <input type="text" id="user-search-input" placeholder="${I18N.t('search.placeholder2')}" data-action="searchUsers">
    </div>
    <div class="search-results" id="search-results"></div>
  `);
  document.getElementById('user-search-input').focus();
}

async function searchUsers(query) {
  clearTimeout(searchTimeout);
  const container = document.getElementById('search-results');
  if (!query || query.length < 2) {
    container.innerHTML = `<p style="color:var(--text-secondary);padding:14px;text-align:center">${I18N.t('search.min2')}</p>`;
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const { ok, status, data } = await api(`/api/search-users?query=${encodeURIComponent(query)}`);
      if (status === 401) return handleSessionExpired();
      if (!ok || !Array.isArray(data)) throw new Error('search failed');

      if (data.length === 0) {
        container.innerHTML = `<p style="color:var(--text-secondary);padding:14px;text-align:center">${I18N.t('search.none')}</p>`;
        return;
      }
      container.innerHTML = data.map(u => `
        <div class="search-result-item" data-action="startChat" data-id="${u.id}">
          <div class="chat-avatar" data-avatar-markup="${encodeURIComponent(userAvatarMarkup(u))}"></div>
          <div>
            <div class="search-result-name">${escapeHtml(u.name || I18N.t('chat.user'))}${isOwnerUser(u) ? ownerBadgeHtml() : ''}</div>
            <div style="font-size:12px;color:var(--text-secondary)">@${escapeHtml(u.username || '')} • ${escapeHtml(u.phone || '')}</div>
          </div>
        </div>
      `).join('');
      // Аватары из /uploads/ грузятся только с Authorization-заголовком —
      // рендерим их через paintAvatar (blob + деградация на первую букву).
      renderDeferredAvatars(container);
    } catch (e) {
      container.innerHTML = `<p style="color:var(--danger);padding:14px;text-align:center">${I18N.t('search.error')}</p>`;
    }
  }, 300);
}

function startChat(userId) {
  closeModal();
  sendWs({ type: 'start_chat', targetUserId: userId });
}

function openNewGroup() {
  toggleMenu();
  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${I18N.t('group.title')}</h2>
    <div class="input-group">
      <label>${I18N.t('group.name')}</label>
      <input type="text" id="group-name-input" placeholder="${I18N.t('group.namePlaceholder')}">
    </div>
    <div class="input-group">
      <label>${I18N.t('group.avatar')}</label>
      <input type="file" id="group-avatar-input" accept="image/*">
    </div>
    <button class="btn" data-action="createGroup">${I18N.t('group.create')}</button>
  `);
}

async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) {
    showToast(I18N.t('err.nameRequired2'), 'error');
    return;
  }
  let avatar = '';
  const fileInput = document.getElementById('group-avatar-input');
  if (fileInput && fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    if (file.size > 2 * 1024 * 1024) {
      showToast(I18N.t('profile.tooBig'), 'error');
      return;
    }
    avatar = await fileToDataURL(file);
  }
  sendWs({ type: 'create_group', name, members: [], avatar });
  closeModal();
}

function openNewChannel() {
  toggleMenu();
  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${I18N.t('channel.title')}</h2>
    <div class="input-group">
      <label>${I18N.t('channel.name')}</label>
      <input type="text" id="channel-name-input" placeholder="${I18N.t('channel.namePlaceholder')}">
    </div>
    <div class="input-group">
      <label>${I18N.t('channel.desc')}</label>
      <input type="text" id="channel-desc-input" placeholder="${I18N.t('channel.descPlaceholder')}">
    </div>
    <div class="input-group">
      <label>${I18N.t('channel.avatar')}</label>
      <input type="file" id="channel-avatar-input" accept="image/*">
    </div>
    <button class="btn" data-action="createChannel">${I18N.t('channel.create')}</button>
  `);
}

async function createChannel() {
  const name = document.getElementById('channel-name-input').value.trim();
  const description = document.getElementById('channel-desc-input').value.trim();
  if (!name) {
    showToast(I18N.t('err.nameRequired2'), 'error');
    return;
  }
  let avatar = '';
  const fileInput = document.getElementById('channel-avatar-input');
  if (fileInput && fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    if (file.size > 2 * 1024 * 1024) {
      showToast(I18N.t('profile.tooBig'), 'error');
      return;
    }
    avatar = await fileToDataURL(file);
  }
  const sent = sendWs({ type: 'create_channel', name, description, avatar });
  if (sent) {
    closeModal();
    showToast(I18N.t('toast.channelCreated'), 'success');
  }
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function openSavedMessages() {
  toggleMenu();
  const saved = chats.find(c => c.type === 'saved');
  if (saved) openChat(saved.id);
}

function showChatInfo() {
  const chat = getChatById(currentChatId);
  if (!chat) return;
  const isGroup = chat.type !== 'private' && chat.type !== 'saved';
  const ownerOrAdmin = isGroup && (chat.owner_id === currentUser.id || chat.role === 'owner' || chat.role === 'admin');
  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${escapeHtml(getChatName(chat))}</h2>
    <div style="text-align:center;margin-bottom:18px;">
      <div class="chat-avatar" style="width:70px;height:70px;font-size:28px;margin:0 auto 10px;">${chatAvatarMarkup(chat)}</div>
      <div class="encryption-badge"><svg class="mq-icon mq-icon--xs" aria-hidden="true" focusable="false"><use href="#mq-i-lock"></use></svg><span>E2EE AES-256-GCM</span></div>
    </div>
    <div style="font-size:13px;color:var(--text-secondary)">
      ${I18N.t('chatinfo.membersShort', { count: chat.members?.length || 0 })}
    </div>
    ${isGroup && ownerOrAdmin ? `
    <div style="margin-top:16px;">
      <div class="input-group">
        <label class="btn btn-secondary" style="cursor:pointer;display:inline-block;text-align:center">
          ${I18N.t('chat.avatarChange')}
          <input type="file" id="chat-avatar-input" accept="image/*" style="display:none" data-action="setChatAvatarFile">
        </label>
      </div>
    </div>
    <div style="margin-top:10px;">
      <div class="input-group">
        <label>${I18N.t('chat.inviteLink')}</label>
        <div style="display:flex;gap:6px;">
          <input type="text" id="chat-invite-link" readonly style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;">
          <button class="btn btn-secondary" data-action="copyInviteLink" style="padding:8px 12px;font-size:12px">${I18N.t('chat.copyInvite')}</button>
        </div>
      </div>
    </div>
    ` : ''}
  `);
  if (isGroup && ownerOrAdmin) {
    const linkEl = document.getElementById('chat-invite-link');
    if (linkEl) {
      linkEl.value = `${location.origin}/invite/${chat.id}`;
    }
  }
}

async function setChatAvatar(el) {
  const chat = getChatById(currentChatId);
  if (!chat) return;
  // Файл берём из скрытого input, который передал событие change.
  // Если файл не выбран (например, диалог закрыт без выбора) — молча выходим,
  // без ошибки «Выберите файл».
  const fileInput = el && el.files ? el : document.getElementById('chat-avatar-input');
  if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
  const file = fileInput.files[0];
  if (file.size > 2 * 1024 * 1024) {
    showToast(I18N.t('profile.tooBig'), 'error');
    return;
  }
  // Сначала пробуем загрузить файл на сервер через REST (multipart/form-data,
  // multer сохраняет его в uploads/ и пишет путь в chats.avatar).
  try {
    const updated = await uploadChatAvatar(chat.id, file);
    if (updated) {
      applyChatAvatarUpdate(chat, updated);
      refreshChatInfoModal(chat);
      closeModal();
      showToast(I18N.t('toast.saved'), 'success');
      return;
    }
  } catch (e) {
    console.warn('uploadChatAvatar failed, falling back to WS:', e);
  }
  // Fallback: data-URL через WebSocket (работает на старых серверах).
  const avatar = await fileToDataURL(file);
  sendWs({ type: 'set_chat_avatar', chatId: chat.id, avatar });
  applyChatAvatarUpdate(chat, avatar);
  closeModal();
  showToast(I18N.t('toast.saved'), 'success');
}

// Отправка файла аватара группы/канала на бэкенд: FormData с полем 'avatar'
// на POST /api/chats/:chatId/avatar (на сервере к нему подключён
// multer upload.single('avatar')). Возвращает обновлённый объект чата или null.
async function uploadChatAvatar(chatId, file) {
  const fd = new FormData();
  fd.append('avatar', file, file.name || 'avatar.jpg');
  const res = await fetch(SERVER_URL + `/api/chats/${encodeURIComponent(chatId)}/avatar`, {
    method: 'POST',
    headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {},
    body: fd
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    if (res.status === 401) handleSessionExpired();
    return null;
  }
  return data || {};
}

// Применяем новый аватар локально: список чатов, шапка открытого чата, кэш.
// avatar может прийти как строкой (data:/URL), так и в составе объекта
// обновлённого чата с сервера ({ avatar: '/uploads/...' }).
function applyChatAvatarUpdate(chat, payload) {
  if (!chat) return;
  const newAvatar = normalizeAvatarValue(typeof payload === 'string' ? payload : (payload && payload.avatar));
  // Старый файл больше не актуален — убираем его blob-кэш, иначе на экране
  // останется предыдущая картинка.
  const oldUrl = getChatAvatarUrl(chat);
  if (oldUrl && oldUrl.startsWith('/uploads/') && oldUrl !== newAvatar) {
    avatarBlobCache.delete(oldUrl);
  }
  chat.avatar = newAvatar;
  // для приватных чатов источник аватара — other_user/members: синхронизируем
  if (chat.type === 'private') {
    if (newAvatar && chat.other_user) chat.other_user.avatar = newAvatar;
    if (newAvatar && Array.isArray(chat.members)) {
      const other = chat.members.find(m => m && Number(m.id) !== Number(currentUser && currentUser.id));
      if (other) other.avatar = newAvatar;
    }
  }
  // Сервер мог прислать обновлённый объект чата целиком — подтягиваем members
  // (источник аватаров для приватных чатов и групп без своей картинки).
  if (payload && typeof payload === 'object' && Array.isArray(payload.members) && Array.isArray(chat.members)) {
    payload.members.forEach((pm) => {
      const local = chat.members.find((m) => m && Number(m.id) === Number(pm && pm.id));
      if (local && pm && normalizeAvatarValue(pm.avatar)) local.avatar = pm.avatar;
    });
  }
  renderChatListThrottled();
  if (currentChatId === chat.id) {
    const headerAvatarEl = document.getElementById('chat-header-avatar');
    // Новый /uploads/ путь — это другой файл: убираем возможные кэш-записи,
    // чтобы hydrateAvatars() гарантированно сделал свежий fetch с токеном.
    if (newAvatar && newAvatar.startsWith('/uploads/')) {
      avatarBlobCache.delete(newAvatar);
      avatarFailCache.delete(newAvatar);
    }
    setChatAvatar(headerAvatarEl, chat);
    if (headerAvatarEl) hydrateAvatars(headerAvatarEl);
  }
  scheduleChatsCache();
}

// После смены аватара перечитываем панель информации о чате, если она
// открыта — иначе там остаётся старая картинка до повторного открытия.
function refreshChatInfoModal(chat) {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay || !overlay.classList.contains('show')) return;
  const content = document.getElementById('modal-content');
  if (!content || !content.querySelector('#chat-avatar-input')) return;
  try { showChatInfo(); } catch (e) { /* не критично */ }
}

function copyInviteLink() {
  const el = document.getElementById('chat-invite-link');
  if (!el || !el.value) return;
  copyToClipboard(el.value);
  showToast(I18N.t('chat.inviteCopied'), 'success');
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  } catch (e) {
    return false;
  }
}

async function computeSafetyNumber() {
  if (!identity || !currentChatId) return null;
  const chat = getChatById(currentChatId);
  if (!chat) return null;
  let keys = [];
  if (chat.type === 'private') {
    const other = (chat.members || []).find(m => m.id !== currentUser.id);
    if (!other || !other.public_key) return null;
    keys = [await E2EE.normalizePublicKey(other.public_key)];
  } else {
    keys = (chat.members || [])
      .filter(m => m.id !== currentUser.id && m.public_key)
      .map(m => m.public_key)
      .sort();
    if (!keys.length) return null;
  }
  try {
    const data = new TextEncoder().encode([identity.publicKey, ...keys].join('|'));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    let num = 0n;
    for (const b of digest) num = (num << 8n) + BigInt(b);
    const digits = num.toString().padStart(60, '0').slice(-60);
    return digits.match(/.{5}/g).join(' ');
  } catch (e) {
    return null;
  }
}

async function fillSafetyNumber() {
  const el = document.getElementById('safety-number');
  if (!el) return;
  const sn = await computeSafetyNumber();
  if (!el.isConnected) return;
  el.textContent = sn || I18N.t('enc.safetyUnavailable');
  el.dataset.safety = sn || '';
}

function copySafetyNumber() {
  const el = document.getElementById('safety-number');
  const sn = el && el.dataset.safety;
  if (!sn) return;
  copyToClipboard(sn.replace(/\s/g, ''));
  showToast(I18N.t('enc.safetyCopied'), 'success');
}

function showEncryptionInfo() {
  toggleMenu();
  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${I18N.t('enc.title')}</h2>
    <div style="line-height:1.7;font-size:13px;">
      <p><strong>CipherTalk</strong> ${I18N.t('enc.subtitle')}</p><br>
      <p><svg class="mq-icon mq-icon--xs" aria-hidden="true" focusable="false"><use href="#mq-i-key"></use></svg><strong>ECDH</strong> (P-256) — ${I18N.t('enc.ecdh')}</p>
      <p><svg class="mq-icon mq-icon--xs" aria-hidden="true" focusable="false"><use href="#mq-i-lock"></use></svg><strong>AES-256-GCM</strong> — ${I18N.t('enc.aes')}</p>
      <p><svg class="mq-icon mq-icon--xs" aria-hidden="true" focusable="false"><use href="#mq-i-shield"></use></svg><strong>HKDF</strong> — ${I18N.t('enc.hkdf')}</p>
      <p><svg class="mq-icon mq-icon--xs" aria-hidden="true" focusable="false"><use href="#mq-i-database"></use></svg><strong>AES-256-GCM</strong> — ${I18N.t('enc.atRest')}</p>
      <p><svg class="mq-icon mq-icon--xs" aria-hidden="true" focusable="false"><use href="#mq-i-phone"></use></svg><strong>DTLS-SRTP</strong> — ${I18N.t('enc.calls')}</p><br>
      <p>${I18N.t('enc.serverBlind')}</p>
      <div class="safety-block">
        <div class="safety-title"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-shield-check"></use></svg><span>${I18N.t('enc.safety')}</span></div>
        <div class="safety-number" id="safety-number">…</div>
        <div class="safety-hint">${I18N.t('enc.safetyHint')}</div>
        <button class="btn btn-secondary" data-action="copySafetyNumber">${I18N.t('enc.safetyCopy')}</button>
      </div>
    </div>
  `);
  fillSafetyNumber();
}

function updateOnlineStatuses() {
  if (currentChatId) updateChatHeader();
  document.querySelectorAll('.chat-item').forEach(el => {
    const chat = getChatById(parseInt(el.dataset.chatId, 10));
    if (!chat) return;
    const avatar = el.querySelector('.chat-avatar');
    if (avatar) avatar.classList.toggle('online', isChatOnline(chat));
  });
}

function showTypingIndicator(name) {
  const statusEl = document.getElementById('chat-header-status');
  statusEl.innerHTML = `<span class="typing-indicator"><span class="mq-typing-dot"></span><span class="mq-typing-dot"></span><span class="mq-typing-dot"></span></span> ${escapeHtml(name || '')} ${I18N.t('chat.typing')}`;
  statusEl.className = 'chat-header-status online';
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => updateChatHeader(), 3000);
}

function openSettings() {
  toggleMenu();
  const themeSwatches = THEMES.map(t => `
    <button class="theme-swatch ${appearance.theme === t.id ? 'active' : ''}" data-theme="${t.id}" data-action="setTheme" data-id="${t.id}">
      <span class="dots">${t.colors.map(c => `<i style="background:${c}"></i>`).join('')}</span>
      ${escapeHtml(t.name)}
    </button>`).join('');

  const bgSwatches = CHAT_BACKGROUNDS.map(b => `
    <div class="bg-swatch ${appearance.chatBg === b.id ? 'active' : ''}" data-bg="${b.id}"
         data-preview="${b.id}" data-action="setChatBg" data-id="${b.id}">
      <span>${escapeHtml(b.name)}</span>
    </div>`).join('');

  showModal(`
    <button class="modal-close" data-action="closeModal"><svg class="mq-icon mq-icon--sm" aria-hidden="true" focusable="false"><use href="#mq-i-x"></use></svg></button>
    <h2>${I18N.t('settings.title')}</h2>

    <div class="settings-section-title">${I18N.t('settings.profile')}</div>
    <div class="row">
      <div class="input-group">
        <label>${I18N.t('profile.firstname')}</label>
        <input type="text" id="settings-firstname" value="${escapeHtml(currentUser.firstName || '')}">
      </div>
      <div class="input-group">
        <label>${I18N.t('profile.lastname')}</label>
        <input type="text" id="settings-lastname" value="${escapeHtml(currentUser.lastName || '')}">
      </div>
    </div>
    <div class="input-group">
      <label>${I18N.t('profile.username')}</label>
      <input type="text" id="settings-username" value="${escapeHtml(currentUser.username || '')}">
    </div>
    <button class="btn" data-action="saveSettings">${I18N.t('profile.save')}</button>

    <div class="settings-section-title">${I18N.t('settings.theme')}</div>
    <div class="theme-grid">${themeSwatches}</div>

    <div class="settings-section-title">${I18N.t('settings.bg')}</div>
    <div class="bg-grid">${bgSwatches}</div>
    <div class="row" style="margin-top:10px">
      <label class="btn btn-secondary" style="cursor:pointer;text-align:center">
        ${I18N.t('settings.customBg')}
        <input type="file" accept="image/*,image/gif" style="display:none" data-action="setCustomBg">
      </label>
      <button class="btn btn-secondary" data-action="clearCustomBg" ${appearance.customBg ? '' : 'disabled'}>${I18N.t('settings.removeBg')}</button>
    </div>

    <div class="settings-section-title">${I18N.t('settings.preset')}</div>
    <div class="preset-row">
      ${STYLE_PRESETS.map(p => `<button class="preset-chip ${appearance.theme === p.patch.theme && appearance.glass === p.patch.glass ? 'active' : ''}" data-preset="${p.id}" data-action="setStylePreset" data-id="${p.id}">${escapeHtml(p.name)}</button>`).join('')}
    </div>

    <div class="settings-section-title">${I18N.t('settings.glass')}</div>
    <div class="switch-row">
      <span>${I18N.t('settings.glassSwitch')}</span>
      <div class="switch ${appearance.glass ? 'on' : ''}" id="glass-switch" data-action="toggleGlass"></div>
    </div>
    <div class="slider-row">
      <span>${I18N.t('settings.blur')}</span>
      <input type="range" min="4" max="40" step="1" value="${appearance.blur}" data-action="setBlur">
      <span class="slider-value" id="blur-value">${appearance.blur}px</span>
    </div>
    <div class="slider-row">
      <span>${I18N.t('settings.opacity')}</span>
      <input type="range" min="10" max="95" step="1" value="${appearance.bgOpacity}" data-action="setFloat" data-key="bgOpacity" data-target="opacity-value" data-unit="opacity-value">
      <span class="slider-value" id="opacity-value">${appearance.bgOpacity}%</span>
    </div>
    <div class="slider-row">
      <span>${I18N.t('settings.saturate')}</span>
      <input type="range" min="80" max="240" step="5" value="${appearance.saturate}" data-action="setFloat" data-key="saturate" data-target="saturate-value" data-unit="saturate-value">
      <span class="slider-value" id="saturate-value">${appearance.saturate}%</span>
    </div>
    <div class="slider-row">
      <span>${I18N.t('settings.glow')}</span>
      <input type="range" min="0" max="30" step="1" value="${appearance.glow}" data-action="setFloat" data-key="glow" data-target="glow-value" data-unit="px">
      <span class="slider-value" id="glow-value">${appearance.glow}px</span>
    </div>
    <div class="slider-row">
      <span>${I18N.t('settings.roundness')}</span>
      <input type="range" min="0" max="28" step="1" value="${appearance.roundness}" data-action="setFloat" data-key="roundness" data-target="round-value" data-unit="px">
      <span class="slider-value" id="round-value">${appearance.roundness}px</span>
    </div>
    <div class="switch-row">
      <span>${I18N.t('settings.tails')}</span>
      <div class="switch ${appearance.tails !== false ? 'on' : ''}" id="tails-switch" data-action="toggleTails"></div>
    </div>

    <div class="settings-section-title">${I18N.t('settings.typography')}</div>
    <div class="anim-row font-row">
      ${FONT_FAMILIES.map(f => `<button class="anim-chip font-chip ${(appearance.fontFamily || 'system') === f.id ? 'active' : ''}" data-font="${f.id}" data-action="setFontFamily" data-id="${f.id}">${I18N.t(f.label)}</button>`).join('')}
    </div>
    <div id="custom-font-row" style="display:${appearance.fontFamily === 'custom' ? 'block' : 'none'};margin-top:8px">
      <input type="text" id="custom-font-input" class="custom-font-input" maxlength="200"
             placeholder="${I18N.t('settings.customFontPlaceholder')}"
             value="${escapeHtml(appearance.fontCustom || '')}" data-action="setCustomFont">
      <div class="input-hint">${I18N.t('settings.customFontHint')}</div>
    </div>
    <div class="slider-row">
      <span>${I18N.t('settings.fontSize')}</span>
      <input type="range" min="12" max="24" step="1" value="${appearance.msgFontSize || 14}" data-action="setFontSize">
      <span class="slider-value" id="font-size-value">${appearance.msgFontSize || 14}px</span>
    </div>
    <div class="anim-row" style="margin-top:10px">
      <span class="row-label">${I18N.t('settings.fontWeight')}</span>
      ${FONT_WEIGHTS.map(w => `<button class="anim-chip weight-chip ${appearance.msgFontWeight === w ? 'active' : ''}" data-weight="${w}" data-action="setFontWeight" data-id="${w}">${w}</button>`).join('')}
    </div>
    <div class="slider-row">
      <span>${I18N.t('settings.lineHeight')}</span>
      <input type="range" min="1.2" max="2" step="0.05" value="${appearance.msgLineHeight || 1.45}" data-action="setLineHeight">
      <span class="slider-value" id="line-height-value">${(Number(appearance.msgLineHeight) || 1.45).toFixed(2)}</span>
    </div>
    <div class="anim-row" style="margin-top:10px">
      <span class="row-label">${I18N.t('settings.fontScope')}</span>
      <button class="anim-chip scope-chip ${appearance.fontScope !== 'messages' ? 'active' : ''}" data-scope="app" data-action="setFontScope" data-id="app">${I18N.t('settings.scopeApp')}</button>
      <button class="anim-chip scope-chip ${appearance.fontScope === 'messages' ? 'active' : ''}" data-scope="messages" data-action="setFontScope" data-id="messages">${I18N.t('settings.scopeMessages')}</button>
    </div>
    <div id="font-preview" class="font-preview" style="font-family:${escapeHtml(resolveFontStack())};font-size:${appearance.msgFontSize || 14}px;font-weight:${appearance.msgFontWeight || '400'};line-height:${Number(appearance.msgLineHeight) || 1.45}">${I18N.t('settings.fontPreview')}</div>
    <button class="btn btn-secondary" data-action="resetTypography" style="margin-top:10px;width:100%">${I18N.t('settings.resetTypography')}</button>

    <div class="switch-row">
      <span>${I18N.t('settings.snow')}</span>
      <div class="switch ${appearance.snow ? 'on' : ''}" id="snow-switch" data-action="toggleSnow"></div>
    </div>
    <div class="slider-row" style="align-items:center">
      <span>${I18N.t('settings.animations')}</span>
      <div class="anim-row">
        <button class="anim-chip ${appearance.animLevel === 'off' ? 'active' : ''}" data-anim="off" data-action="setAnimLevel" data-id="off">${I18N.t('settings.animOff')}</button>
        <button class="anim-chip ${appearance.animLevel === 'normal' ? 'active' : ''}" data-anim="normal" data-action="setAnimLevel" data-id="normal">${I18N.t('settings.animNormal')}</button>
        <button class="anim-chip ${appearance.animLevel === 'full' ? 'active' : ''}" data-anim="full" data-action="setAnimLevel" data-id="full">${I18N.t('settings.animFull')}</button>
      </div>
    </div>

    <div class="switch-row">
      <span>${I18N.t('settings.customCursor')}</span>
      <div class="switch ${appearance.customCursor !== false ? 'on' : ''}" id="cursor-switch" data-action="toggleCursor"></div>
    </div>
    <div class="settings-hint">${I18N.t('settings.customCursorHint')}</div>

    <div class="settings-section-title">${I18N.t('settings.privacy')}</div>
    <div class="switch-row">
      <span>${I18N.t('settings.hideOnline')}</span>
      <div class="switch ${privacy.hideOnline ? 'on' : ''}" id="hide-online-switch" data-action="toggleHideOnline"></div>
    </div>
    <div class="switch-row">
      <span>${I18N.t('settings.ghost')}</span>
      <div class="switch ${privacy.ghost ? 'on' : ''}" id="ghost-switch" data-action="toggleGhost"></div>
    </div>
    <div class="settings-hint">${I18N.t('settings.ghostHint')}</div>
    <div class="switch-row">
      <span>${I18N.t('settings.screenshot')}</span>
      <div class="switch ${privacy.screenshotGuard ? 'on' : ''}" id="screenshot-switch" data-action="toggleScreenshotGuard"></div>
    </div>
    <div class="settings-hint">${I18N.t('settings.screenshotHint')}</div>
    <div class="settings-section-title" style="font-size:13px">${I18N.t('settings.badge')}</div>
    <div class="anim-row badge-row">
      ${BADGE_CHOICES.map(b => `<button class="anim-chip badge-chip ${privacy.badge === b.id ? 'active' : ''}" data-badge="${b.id}" data-action="setBadge" data-id="${b.id}">${b.icon ? `<svg class="mq-icon mq-icon--xs" aria-hidden="true" focusable="false"><use href="#mq-i-${b.icon}"></use></svg>` : ''}${escapeHtml(I18N.t(b.label))}</button>`).join('')}
    </div>
    <div class="input-group">
      <label>${I18N.t('settings.pin')}</label>
      <input type="password" id="settings-pin" placeholder="${privacy.pinHash ? I18N.t('toast.pinSetNew') : I18N.t('settings.notSet')}" inputmode="numeric" maxlength="8">
    </div>
    <div class="row">
      <button class="btn" data-action="setPin">${I18N.t('settings.setPin')}</button>
      <button class="btn btn-secondary" data-action="removePin" ${privacy.pinHash ? '' : 'disabled'}>${I18N.t('settings.removePin')}</button>
    </div>

    <div class="settings-section-title">${I18N.t('settings.panic')}</div>
    <div class="settings-hint">${I18N.t('settings.panicHint')}</div>
    <button class="btn btn-secondary panic-btn" data-action="panicLock">${I18N.t('settings.panicBtn')}</button>

    <div class="settings-section-title">${I18N.t('settings.encryption')}</div>
    <div class="settings-hint">${I18N.t('settings.encryptionHint')}</div>
    <button class="btn btn-secondary" data-action="resetE2EE">${I18N.t('settings.resetKeys')}</button>

    <div class="settings-section-title">${I18N.t('public.title')}</div>
    <div id="public-access-card">${publicAccessCardHtml()}</div>

    <div class="settings-section-title">${I18N.t('lang.name')}</div>
    <div class="anim-row">
      <button class="anim-chip ${I18N.getLang() === 'ru' ? 'active' : ''}" data-action="setLang" data-id="ru">${I18N.t('lang.ru')}</button>
      <button class="anim-chip ${I18N.getLang() === 'en' ? 'active' : ''}" data-action="setLang" data-id="en">${I18N.t('lang.en')}</button>
    </div>
  `);

  // Адрес мог обновиться после прошлого открытия — обновляем карточку,
  // не блокируя показ модалки.
  loadPublicUrl().then(() => {
    const card = document.getElementById('public-access-card');
    if (card) card.innerHTML = publicAccessCardHtml();
  });
}

// ==================== ПУБЛИЧНЫЙ ДОСТУП ====================
// Адрес, по которому мессенджер доступен с любого устройства и любой сети.
let publicUrlCache = null;

async function loadPublicUrl() {
  try {
    const res = await fetch('/api/public-url', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    publicUrlCache = (data && data.url) ? data.url : null;
    return publicUrlCache;
  } catch (e) {
    publicUrlCache = null;
    return null;
  }
}

function publicAccessCardHtml() {
  const url = publicUrlCache;
  if (!url) {
    return `<div class="settings-hint">${I18N.t('public.unavailable')}</div>`;
  }
  return `
    <div class="public-card">
      <img class="public-card-qr" src="/api/public-url/qr.svg" alt="QR" data-i18n-alt="public.qrAlt">
      <div class="public-card-body">
        <div class="public-card-title">${I18N.t('public.title')}</div>
        <div class="public-card-url">${escapeHtml(url)}</div>
        <div class="public-card-hint">${I18N.t('public.note')}</div>
        <button class="btn btn-secondary" data-action="copyPublicUrl">${I18N.t('public.copy')}</button>
      </div>
    </div>
  `;
}

async function copyPublicUrl() {
  const url = publicUrlCache || await loadPublicUrl();
  if (!url) {
    showToast(I18N.t('public.unavailable'), 'error');
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast(I18N.t('public.copied'), 'success');
  } catch (e) {
    showToast(url, 'info');
  }
}

// Показываем адрес на экране входа и в настройках
async function refreshPublicAccess() {
  const url = await loadPublicUrl();
  const block = document.getElementById('public-access');
  const urlEl = document.getElementById('public-access-url');
  if (block && urlEl) {
    if (url) {
      urlEl.textContent = url;
      block.style.display = 'block';
    } else {
      block.style.display = 'none';
    }
  }
  return url;
}

function updateLangChips() {
  const cur = I18N.getLang();
  const ru = document.getElementById('lang-ru');
  const en = document.getElementById('lang-en');
  if (ru) ru.classList.toggle('active', cur === 'ru');
  if (en) en.classList.toggle('active', cur === 'en');
}

function setLanguage(lang) {
  if (!lang || lang === I18N.getLang()) return;
  I18N.setLang(lang);
  I18N.applyI18n();
  updateLangChips();
  try { renderChatList(); } catch (e) { /* ignore */ }
  try { if (typeof renderFolderBar === 'function') renderFolderBar(); } catch (e) { /* ignore */ }
  try { if (currentChatId) { updateChatHeader(); renderMessages(currentChatId); } } catch (e) { /* ignore */ }
  try { if (document.getElementById('modal-overlay').classList.contains('show')) openSettings(); } catch (e) { /* ignore */ }
  showToast(I18N.t('lang.changed', { lang: I18N.t('lang.' + lang) }), 'success');
}

async function toggleGhost() {
  privacy.ghost = !privacy.ghost;
  if (privacy.ghost) privacy.hideOnline = true;
  savePrivacy();
  applyPrivacyFeatures();
  const ghost = document.getElementById('ghost-switch');
  if (ghost) ghost.classList.toggle('on', privacy.ghost);
  const online = document.getElementById('hide-online-switch');
  if (online) online.classList.toggle('on', privacy.hideOnline);
  sendWs({ type: 'set_privacy', hideOnline: privacy.hideOnline });
  try {
    await api('/api/update-profile', { method: 'POST', body: { hideOnline: privacy.hideOnline } });
  } catch (e) { /* WS уже применил */ }
  showToast(privacy.ghost ? I18N.t('toast.ghostOn') : I18N.t('toast.ghostOff'), 'success');
}

function toggleScreenshotGuard() {
  privacy.screenshotGuard = !privacy.screenshotGuard;
  savePrivacy();
  applyPrivacyFeatures();
  document.getElementById('screenshot-switch')?.classList.toggle('on', privacy.screenshotGuard);
}

function setBadge(id) {
  privacy.badge = BADGE_IDS.includes(id) ? id : '';
  savePrivacy();
  document.querySelectorAll('[data-badge]').forEach(el => {
    el.classList.toggle('active', el.dataset.badge === privacy.badge);
  });
  updateMenuProfile();
  showToast(I18N.t('settings.saved'), 'success');
}

async function toggleHideOnline() {
  privacy.hideOnline = !privacy.hideOnline;
  savePrivacy();
  const sw = document.getElementById('hide-online-switch');
  if (sw) sw.classList.toggle('on', privacy.hideOnline);
  sendWs({ type: 'set_privacy', hideOnline: privacy.hideOnline });
  try {
    await api('/api/update-profile', { method: 'POST', body: { hideOnline: privacy.hideOnline } });
  } catch (e) { /* WS уже применил */ }
  showToast(privacy.hideOnline ? I18N.t('toast.onlineHidden') : I18N.t('toast.onlineShown'), 'success');
}

async function saveSettings() {
  const firstName = document.getElementById('settings-firstname').value.trim();
  const lastName = document.getElementById('settings-lastname').value.trim();
  const username = document.getElementById('settings-username').value.trim();

  if (!firstName || firstName.length < 2) {
    showToast(I18N.t('err.nameRequired'), 'error');
    return;
  }

  try {
    const { ok, status, data } = await api('/api/update-profile', {
      method: 'POST',
      body: { firstName, lastName, username }
    });
    if (status === 401) return handleSessionExpired();
    if (ok && data.success) {
      currentUser = normalizeUser(data.user);
      localStorage.setItem('ciphertalk_user', JSON.stringify(currentUser));
      updateMenuProfile();
      renderChatList();
      closeModal();
      showToast(I18N.t('toast.saved'), 'success');
    } else {
      showToast(data.error || I18N.t('err.genericShort'), 'error');
    }
  } catch (e) {
    showToast(I18N.t('err.save'), 'error');
  }
}

function handleSessionExpired() {
  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  showToast(I18N.t('err.sessionExpired'), 'error');
  clearSession(false);
  setTimeout(() => location.reload(), 700);
}

function clearSession(reload) {
  authToken = '';
  sessionExpiredHandled = false;
  appearanceTimerStarted = false;
  // Чистим кэш текущего аккаунта до сброса currentUser (ключ зависит от него).
  clearPlaintextCache();
  currentUser = null;
  // Возвращаемся к общим настройкам устройства (без аккаунта)
  reloadAppearanceForUser();
  identity = null;
  chatKeys = {};
  groupKeyBlobs = {};
  persistedPlaintext = null;
  localStorage.removeItem('ciphertalk_token');
  localStorage.removeItem('ciphertalk_user');
  swPostMessage({ type: 'ct-bg-logout' });
  // Сами E2EE-ключи не удаляем: иначе история перестанет расшифровываться
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch (e) { /* ignore */ }
    ws = null;
  }
  try {
    mediaCache.forEach(objectUrl => { try { URL.revokeObjectURL(objectUrl); } catch(e){} });
    mediaCache.clear();
  } catch(e){}
  // очистка всех таймеров истечения
  try {
    for (const t of expiryTimers.values()) { try { clearTimeout(t); } catch(e){} }
    expiryTimers.clear();
  } catch(e){}
  if (reload) location.reload();
}

async function logout() {
  if (!confirm(I18N.t('confirm.logout'))) return;
  try {
    if (authToken) {
      await fetch(SERVER_URL + '/api/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + authToken }
      });
    }
  } catch (e) { /* ignore */ }
  clearSession(true);
}

// ==================== ФОН: СНЕЖИНКИ ====================
// Лёгкий canvas-снегопад. Рисуем только через трансформации кадра,
// при неактивной вкладке анимация ставится на паузу (экономим CPU).
const snow = {
  canvas: null,
  ctx: null,
  flakes: [],
  raf: null,
  running: false,
  dpr: 1,

  init() {
    this.canvas = document.getElementById('snow-canvas');
    if (!this.canvas) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    this.spawn();
    window.addEventListener('resize', () => this.resize(), { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause(); else this.resume();
    });
    this.resume();
  },

  resize() {
    if (!this.canvas) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * this.dpr);
    this.canvas.height = Math.floor(window.innerHeight * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.spawn();
  },

  spawn() {
    const area = window.innerWidth * window.innerHeight;
    const count = Math.min(140, Math.max(50, Math.round(area / 16000)));
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.flakes = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 1 + Math.random() * 2.6,
      speed: 0.35 + Math.random() * 1.1,
      drift: (Math.random() - 0.5) * 0.6,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.25 + Math.random() * 0.5
    }));
  },

  resume() {
    if (this.running || !this.ctx) return;
    this.running = true;
    let last = 0;
    const step = (ts) => {
      if (!this.running) return;
      // ~60fps, но не чаще: пропускаем лишние кадры
      if (ts - last > 24) {
        this.draw();
        last = ts;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  },

  pause() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  },

  draw() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.ctx.clearRect(0, 0, width, height);
    for (const f of this.flakes) {
      f.phase += 0.01;
      f.y += f.speed;
      f.x += f.drift + Math.sin(f.phase) * 0.4;
      if (f.y > height + 6) { f.y = -6; f.x = Math.random() * width; }
      if (f.x > width + 6) f.x = -6;
      else if (f.x < -6) f.x = width + 6;

      this.ctx.beginPath();
      this.ctx.fillStyle = `rgba(210,232,255,${f.alpha})`;
      this.ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }
};

// ==================== ДЕЛЕГИРОВАНИЕ СОБЫТИЙ (CSP-safe, без inline-обработчиков) ====================
const CLICK_ACTIONS = {
  step1Next: () => step1Next(),
  step2Next: () => step2Next(),
  step3RegNext: () => step3RegNext(),
  step3LoginNext: () => step3LoginNext(),
  step4Next: () => step4Next(),
  step5Next: () => step5Next(),
  goToStep: (el) => goToStep(parseInt(el.dataset.step, 10) || 1),
  togglePassword: (el) => togglePassword(el.dataset.target, el),
  openNewGroup: () => openNewGroup(),
  openNewChannel: () => openNewChannel(),
  openSearch: () => openSearch(),
  openSavedMessages: () => openSavedMessages(),
  openSettings: () => openSettings(),
  showEncryptionInfo: () => showEncryptionInfo(),
  copySafetyNumber: () => copySafetyNumber(),
  copyPublicUrl: () => copyPublicUrl(),
  mobileChats: () => { closeChat(); updateMobileNav(); },
  logout: () => logout(),
  toggleMenu: () => toggleMenu(),
  closeChat: () => closeChat(),
  showChatInfo: () => showChatInfo(),
  attachFile: () => attachFile(),
  openStickerPicker: () => openStickerPicker(),
  sendSticker: (el) => sendSticker(el.dataset.id),
  sendUserSticker: (el) => sendUserSticker(el.dataset.id),
  openStickerCreator: () => openStickerCreator(),
  toggleVoiceRecording: () => toggleVoiceRecording(),
  toggleVideoRecording: () => toggleVideoRecording(),
  sendMessage: () => sendMessage(),
  unlockWithPin: () => unlockWithPin(),
  openChat: (el) => openChat(parseInt(el.dataset.id, 10)),
  closeModal: () => closeModal(),
  searchUsers: (el) => searchUsers(el.value),
  startChat: (el) => startChat(parseInt(el.dataset.id, 10)),
  createGroup: () => createGroup(),
  createChannel: () => createChannel(),
  setTheme: (el) => setTheme(el.dataset.id),
  setChatBg: (el) => setChatBg(el.dataset.id),
  saveSettings: () => saveSettings(),
  clearCustomBg: () => clearCustomBg(),
  setStylePreset: (el) => setStylePreset(el.dataset.id),
  toggleGlass: () => toggleGlass(),
  toggleCursor: () => toggleCursor(),
  setBlur: (el) => setBlur(el.value),
  setFloat: (el) => setFloat(el.dataset.key, el.value, el.dataset.target, el.dataset.unit),
  toggleSnow: () => toggleSnow(),
  toggleTails: () => toggleTails(),
  setFontFamily: (el) => setFontFamily(el.dataset.id),
  setFontWeight: (el) => setFontWeight(el.dataset.id),
  setFontScope: (el) => setFontScope(el.dataset.id),
  resetTypography: () => resetTypography(),
  setAnimLevel: (el) => setAnimLevel(el.dataset.id),
  scrollToBottom: () => scrollToBottom(),
  toggleHideOnline: () => toggleHideOnline(),
  toggleGhost: () => toggleGhost(),
  toggleScreenshotGuard: () => toggleScreenshotGuard(),
  setBadge: (el) => setBadge(el.dataset.id),
  panicLock: () => panicLock(),
  setPin: () => setPin(),
  removePin: () => removePin(),
  resetE2EE: () => resetE2EE(),
  setLang: (el) => setLanguage(el.dataset.id),
  copyInviteLink: () => copyInviteLink()
};

const CHANGE_ACTIONS = {
  setCustomBg: (el) => setCustomBg(el),
  setChatAvatarFile: (el) => setChatAvatar(el)
};

const INPUT_ACTIONS = {
  checkUsername: () => checkUsername(),
  checkPasswordStrength: () => checkPasswordStrength(),
  searchChats: (el) => searchChats(el.value),
  searchUsers: (el) => searchUsers(el.value),
  setFontSize: (el) => setFontSize(el.value),
  setCustomFont: (el) => setCustomFont(el.value),
  setLineHeight: (el) => setLineHeight(el.value),
  messageInput: (el) => { autoResize(el); handleTyping(); }
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = CLICK_ACTIONS[el.dataset.action];
  if (!handler) return;
  e.preventDefault();
  handler(el);
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = INPUT_ACTIONS[el.dataset.action];
  if (handler) handler(el);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = CHANGE_ACTIONS[el.dataset.action];
  if (handler) handler(el);
});

document.addEventListener('keydown', (e) => {
  const el = e.target.closest('[data-action="messageInput"]');
  if (el) handleKeyDown(e);
});

// ==================== СТАРТ ====================
window.addEventListener('load', async () => {
  I18N.applyI18n();
  updateLangChips();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || hostnameIsLocal())) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        // Кэшируем регистрацию сразу: ready() не резолвится, пока SW не станет
        // контроллером страницы, а showNotification доступен на регистрации
        // уже сейчас — иначе уведомления не работали до первой перезагрузки.
        swRegistration = reg;
        return reg.update();
      })
      .catch(() => {});
  }
  loadAppearance();
  snow.init();
  watchDevice();
  // Кастомный курсор — только для устройств с мышью
  if (typeof Cursor !== 'undefined' && Cursor.init) Cursor.init();
  // Публичный адрес виден ещё до входа — по нему можно открыть мессенджер
  // с телефона или другого устройства.
  refreshPublicAccess();
  const savedUser = localStorage.getItem('ciphertalk_user');

  if (authToken && savedUser) {
    try {
      const { ok, data } = await api('/api/me');
      if (ok && data.user) {
        currentUser = normalizeUser(data.user);
        // Личность привязана к аккаунту: при входе подключаем нужный ключ.
        await ensureIdentityForUser(currentUser.id);
        // Настройки внешнего вида и приватности тоже принадлежат аккаунту.
        reloadAppearanceForUser();
        localStorage.setItem('ciphertalk_user', JSON.stringify(currentUser));
        if (currentUser.hide_online) {
          privacy.hideOnline = true;
          savePrivacy();
        }
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        initApp();
        requestNotificationPermission().then(syncSWBackground);
        publishOwnPublicKey().catch(() => {});
        maybeLockApp();
        return;
      }
    } catch (e) { /* fallthrough */ }
    clearSession(false);
  }

  goToStep(1);
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

document.getElementById('code-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') step2Next();
});

document.getElementById('phone-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') step1Next();
});

document.getElementById('firstname-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') step3RegNext();
});

document.getElementById('password-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') step3LoginNext();
});

document.getElementById('confirm-password-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') step5Next();
});

document.getElementById('pin-lock-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlockWithPin();
});

window.addEventListener('beforeunload', () => {
  if (recordingStream) recordingStream.getTracks().forEach(track => track.stop());
});
