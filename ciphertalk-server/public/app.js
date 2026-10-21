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
// E2EE-состояние живёт в обще модуле /e2ee.js, здесь только кэш
let onlineUsers = new Set();
let typingTimeout = null;
let usernameCheckTimeout = null;
let searchTimeout = null;
let lastTypingSent = 0;
let sessionExpiredHandled = false;
let typewriterTimers = new Set();

let regState = {
  phone: '', code: '', verifyToken: '', loginToken: '', firstName: '', lastName: '',
  username: '', password: '', action: null, existingName: ''
};

// ==================== ВНЕШНИЙ ВИД (темы/фон/стекло) ====================
const APPEARANCE_KEY = 'ciphertalk_appearance';
const THEMES = [
  { id: 'dark', name: 'Тёмная', colors: ['#0e1621', '#2b5278', '#5eb5f7'] },
  { id: 'light', name: 'Светлая', colors: ['#ffffff', '#4a9de0', '#2b7fd4'] },
  { id: 'amoled', name: 'AMOLED', colors: ['#000000', '#1a3a5c', '#ffffff'] },
  { id: 'cyberpunk', name: 'Киберпанк', colors: ['#0d0221', '#ff2e97', '#00f5d4'] },
  { id: 'neon', name: 'Неон', colors: ['#05070d', '#00b4ff', '#39ff14'] },
  { id: 'dracula', name: 'Dracula', colors: ['#282a36', '#bd93f9', '#ff79c6'] },
  { id: 'nord', name: 'Nord', colors: ['#2e3440', '#88c0d0', '#a3be8c'] },
  { id: 'mono', name: 'Монохром', colors: ['#141414', '#4d4d4d', '#e6e6e6'] },
  { id: 'rose', name: 'Розовая', colors: ['#1a1016', '#ff6fae', '#ffd1e8'] },
  { id: 'ice', name: 'Ледяная', colors: ['#0b1a24', '#5ec8f0', '#c9f4ff'] },
  { id: 'sunset', name: 'Закат', colors: ['#1a0f1e', '#ff7849', '#ffd166'] },
  { id: 'matrix', name: 'Матрица', colors: ['#020a02', '#00ff41', '#0d2b0d'] }
];
const CHAT_BACKGROUNDS = [
  { id: 'default', name: 'По умолчанию' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'sunset', name: 'Закат' },
  { id: 'forest', name: 'Лес' },
  { id: 'grid', name: 'Сетка' },
  { id: 'dots', name: 'Точки' },
  { id: 'waves', name: 'Волны' },
  { id: 'stars', name: 'Звёзды' }
];
const STYLE_PRESETS = [
  { id: 'classic', name: 'Классика', patch: { theme: 'dark', glass: false, snow: true, blur: 14, bgOpacity: 55, saturate: 140, glow: 0, roundness: 12 } },
  { id: 'frost', name: 'Frost', patch: { theme: 'ice', glass: true, snow: true, blur: 22, bgOpacity: 45, saturate: 160, glow: 6, roundness: 18 } },
  { id: 'cyber', name: 'Cyber', patch: { theme: 'cyberpunk', glass: true, snow: false, blur: 12, bgOpacity: 60, saturate: 200, glow: 14, roundness: 6, customBg: '' } },
  { id: 'minimal', name: 'Minimal', patch: { theme: 'mono', glass: false, snow: false, blur: 8, bgOpacity: 70, saturate: 100, glow: 0, roundness: 8 } },
  { id: 'vapor', name: 'Vaporwave', patch: { theme: 'rose', glass: true, snow: false, blur: 18, bgOpacity: 50, saturate: 180, glow: 10, roundness: 20 } },
  { id: 'matrix', name: 'Matrix', patch: { theme: 'matrix', glass: true, snow: false, blur: 10, bgOpacity: 65, saturate: 120, glow: 16, roundness: 4 } }
];
let appearance = {
  theme: 'dark', chatBg: 'default', glass: false, snow: true, blur: 14,
  bgOpacity: 55, saturate: 140, glow: 0, roundness: 12,
  customBg: '', animLevel: 'normal'
};
let privacy = { pinHash: '', hideOnline: false };
const PRIVACY_KEY = 'ciphertalk_privacy';

function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    appearance = Object.assign(appearance, saved);
  } catch (e) { /* ignore */ }
  try {
    const saved = JSON.parse(localStorage.getItem(PRIVACY_KEY) || '{}');
    privacy = Object.assign(privacy, saved);
  } catch (e) { /* ignore */ }
  applyAppearance();
}

function saveAppearance() {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)); } catch (e) { /* ignore */ }
}

function savePrivacy() {
  try { localStorage.setItem(PRIVACY_KEY, JSON.stringify(privacy)); } catch (e) { /* ignore */ }
}

function applyAppearance() {
  const html = document.documentElement;
  html.setAttribute('data-theme', appearance.theme);
  html.setAttribute('data-glass', appearance.glass ? 'on' : 'off');
  html.setAttribute('data-anim', appearance.animLevel || 'normal');
  const root = document.documentElement.style;
  root.setProperty('--glass-blur', (Number(appearance.blur) || 14) + 'px');
  root.setProperty('--glass-alpha', ((Number(appearance.bgOpacity) || 55) / 100).toFixed(2));
  root.setProperty('--glass-saturate', (Number(appearance.saturate) || 140) + '%');
  root.setProperty('--glow-strength', (Number(appearance.glow) || 0) + 'px');
  root.setProperty('--radius', (Number(appearance.roundness) || 12) + 'px');
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
    if (appearance.snow) snow.resume();
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
  showToast(`Стиль «${preset.name}» применён ✨`, 'success');
}

function setCustomBg(el) {
  const file = el && el.files && el.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { showToast('Файл больше 3 МБ', 'error'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    appearance.customBg = reader.result;
    appearance.chatBg = 'default';
    saveAppearance();
    applyAppearance();
    showToast('Свой фон установлен 🖼️', 'success');
  };
  reader.readAsDataURL(file);
}

function clearCustomBg() {
  appearance.customBg = '';
  saveAppearance();
  applyAppearance();
  showToast('Свой фон убран', 'success');
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
  applyAppearance();
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

// ==================== PIN-КОД ====================
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function setPin() {
  const pin = (document.getElementById('settings-pin')?.value || '').trim();
  if (!/^\d{4,8}$/.test(pin)) {
    showToast('PIN: 4-8 цифр', 'error');
    return;
  }
  privacy.pinHash = await sha256Hex(pin);
  savePrivacy();
  const input = document.getElementById('settings-pin');
  if (input) input.value = '';
  showToast('PIN-код установлен 🔒', 'success');
}

function removePin() {
  privacy.pinHash = '';
  savePrivacy();
  showToast('PIN-код снят', 'success');
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
  if (!pin) { if (err) err.textContent = 'Введите PIN'; return; }
  const hash = await sha256Hex(pin);
  if (hash === privacy.pinHash) {
    hidePinLock();
  } else {
    if (err) err.textContent = 'Неверный PIN-код';
    if (input) input.value = '';
  }
}

function maybeLockApp() {
  if (privacy.pinHash && currentUser) showPinLock();
}

// ==================== E2EE: СБРОС И СТАТУС ====================
async function resetE2EE() {
  if (!confirm('Сбросить ключи шифрования? Старые сообщения станут нечитаемыми на этом устройстве.')) return;
  try {
    identity = await E2EE.generateIdentity();
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    localStorage.removeItem(SESSIONS_KEY);
    chatKeys = {};
    groupKeyBlobs = {};
    localStorage.removeItem(GROUP_KEYS_KEY);
    await publishOwnPublicKey();
    showToast('🔑 Ключи шифрования пересозданы', 'success');
    if (currentChatId) renderMessages(currentChatId);
  } catch (e) {
    showToast('Не удалось сбросить ключи: ' + e.message, 'error');
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
    badge.textContent = hasKey ? '🔒 E2EE' : '⏳ Ожидание ключа';
    badge.className = 'enc-badge' + (hasKey ? ' secured' : ' pending');
  } else {
    badge.textContent = '🔒 E2EE (группа)';
    badge.className = 'enc-badge secured';
  }
  badge.style.display = 'inline-flex';
}


// Медиа
const mediaCache = new Map(); // url -> objectUrl
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

function showToast(text, type = '') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = text;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatMessageTime(ts) {
  return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeen(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'только что';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' мин. назад';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч. назад';
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
  if (size < 1024) return size + ' Б';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' КБ';
  return (size / (1024 * 1024)).toFixed(1) + ' МБ';
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
    firstName: user.firstName || user.first_name || '',
    lastName: user.lastName || user.last_name || ''
  };
}

function normalizeChat(chat) {
  return {
    id: Number(chat.id),
    type: chat.type || 'private',
    name: chat.name || '',
    avatar: chat.avatar || '',
    owner_id: chat.owner_id || null,
    role: chat.role || 'member',
    members: Array.isArray(chat.members) ? chat.members.map(normalizeUser) : [],
    last_message: chat.last_message || '',
    last_message_iv: chat.last_message_iv || '',
    last_message_header: chat.last_message_header || '',
    last_message_type: chat.last_message_type || null,
    last_message_time: chat.last_message_time || 0,
    last_sender_id: chat.last_sender_id || 0,
    last_read_by: chat.last_read_by || {}
  };
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
    created_at: Number(m.created_at ?? m.createdAt ?? Date.now())
  };
}

function getChatById(chatId) {
  return chats.find(c => c.id === Number(chatId));
}

function getChatName(chat) {
  if (!chat) return 'Чат';
  if (chat.type === 'saved') return 'Избранное';
  if (chat.type === 'group' || chat.type === 'supergroup') return chat.name || 'Группа';
  if (chat.type === 'private') {
    const other = chat.members?.find(m => m.id !== currentUser?.id);
    return other?.name || other?.phone || 'Чат';
  }
  return chat.name || 'Чат';
}

function getChatAvatar(chat) {
  if (chat.type === 'saved') return '⭐';
  const name = getChatName(chat);
  return name[0]?.toUpperCase() || '?';
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
const SESSIONS_KEY = 'ciphertalk_sessions';
const GROUP_KEYS_KEY = 'ciphertalk_group_keys';

let identity = null;         // { publicKey, privateKey } в base64
let chatKeys = {};           // chatId -> { kind: 'direct'|'group', session?, groupKey? }
let groupKeyBlobs = {};      // chatId -> { version, wrapped, createdBy }

function assertWebCrypto() {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('WebCrypto недоступен: откройте сайт по HTTPS или через localhost');
  }
  if (!E2EE) throw new Error('Модуль шифрования /e2ee.js не загружен');
}

async function getOrCreateIdentity() {
  const saved = localStorage.getItem(IDENTITY_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.publicKey && parsed.privateKey) return parsed;
    } catch (e) { /* пересоздадим */ }
  }
  const created = await E2EE.generateIdentity();
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(created));
  return created;
}

async function ensureLocalIdentity() {
  if (!identity) identity = await getOrCreateIdentity();
  return identity;
}

function loadSessionMap() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSession(chatId, session) {
  const all = loadSessionMap();
  all[chatId] = E2EE.serializeSession(session);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
}

function loadSession(chatId) {
  const all = loadSessionMap();
  return all[chatId] ? E2EE.deserializeSession(all[chatId]) : null;
}

function loadGroupKeyBlobs() {
  try {
    return JSON.parse(localStorage.getItem(GROUP_KEYS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveGroupKeyBlobs() {
  localStorage.setItem(GROUP_KEYS_KEY, JSON.stringify(groupKeyBlobs));
}

// Ожидание группового ключа от сервера
const pendingGroupKeys = new Map();

function requestGroupKey(chatId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingGroupKeys.delete(chatId);
      reject(new Error('Сервер не прислал ключ группы'));
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
  if (!chat) throw new Error('Чат не найден');
  const me = await ensureLocalIdentity();

  if (chat.type === 'private' || chat.type === 'saved') {
    let peerKey = null;
    if (chat.type === 'saved') {
      // «Избранное»: шифруем сами с собой (ECDH с собственным ключом)
      peerKey = me.publicKey;
    } else {
      const other = chat.members?.find(m => m.id !== currentUser.id) || chat.members?.[0];
      if (!other) throw new Error('Не найден собеседник');
      peerKey = other.public_key;
      if (!peerKey) {
        const fetched = await waitForPublicKey(other.id);
        peerKey = fetched;
        other.public_key = fetched;
      }
    }
    if (!peerKey) throw new Error('У собеседника ещё нет ключа шифрования');

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
  if (!state || !state.mine) throw new Error('Ключ группы ещё не создан');

  const me = await ensureLocalIdentity();
  const creatorId = Number(state.createdBy) || 0;
  const creator = chat.members?.find(m => m.id === creatorId);
  const creatorKey = creator?.public_key || (creatorId === currentUser.id ? me.publicKey : null);
  if (!creatorKey) throw new Error('Нет публичного ключа создателя группы');

  const groupKey = await E2EE.unwrapGroupKey(state.mine, me, creatorKey);
  chatKeys[chatId] = { kind: 'group', groupKey };
  return groupKey;
}

// Создаёт и публикует групповой ключ (вызывается создателем группы/канала)
async function publishGroupKey(chat, groupKeyBytes, version) {
  const me = await ensureLocalIdentity();
  const wrapped = {};
  for (const member of chat.members || []) {
    if (!member.public_key) continue;
    wrapped[member.id] = await E2EE.wrapGroupKey(groupKeyBytes, me, member.public_key);
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

// Добавляет участника в группу: ключ группы заворачивается лично для него
async function shareGroupKeyWithMember(chat, member) {
  const me = await ensureLocalIdentity();
  if (!member.public_key) throw new Error('У участника нет публичного ключа');
  const groupKey = await ensureGroupKey(chat);
  const state = groupKeyBlobs[chat.id] || {};
  const blob = await E2EE.wrapGroupKey(groupKey, me, member.public_key);
  const wrapped = { ...(state.wrapped || {}), [member.id]: blob };
  const version = (state.version || 1) + 1;
  groupKeyBlobs[chat.id] = {
    version,
    wrapped,
    mine: state.mine || blob,
    createdBy: state.createdBy || currentUser.id
  };
  saveGroupKeyBlobs();
  sendWs({ type: 'set_group_key', chatId: chat.id, version, wrapped });
  return blob;
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
  if (!chatKey) throw new Error('Нет ключа чата');
  if (chatKey.kind === 'group') {
    return E2EE.encryptGroup(chatKey.groupKey, text, String(chatId), 1);
  }
  const envelope = await E2EE.encryptDirect(chatKey.session, text, String(chatId));
  saveSession(chatId, chatKey.session);
  return envelope;
}

// Кэш только что отправленных сообщений: подстраховка для расшифровки
// собственных сообщений (echo от сервера) без обращения к ratchet.
const sentPlaintext = new Map();

function rememberSent(content, text) {
  sentPlaintext.set(content, text);
  if (sentPlaintext.size > 200) {
    const oldest = sentPlaintext.keys().next().value;
    sentPlaintext.delete(oldest);
  }
}

async function decryptChatText(chatKey, message, chatId, isOwn = false) {
  if (!chatKey) throw new Error('Нет ключа чата');
  const payload = {
    content: message.encrypted_content,
    iv: message.iv,
    header: message.header || ''
  };
  if (chatKey.kind === 'group') {
    return E2EE.decryptGroup(chatKey.groupKey, payload, String(chatId));
  }
  if (isOwn) {
    try {
      const text = await E2EE.decryptDirectOwn(chatKey.session, payload, String(chatId));
      saveSession(chatId, chatKey.session);
      return text;
    } catch (e) {
      const cached = sentPlaintext.get(message.encrypted_content);
      if (cached !== undefined) return cached;
      throw e;
    }
  }
  const text = await E2EE.decryptDirect(chatKey.session, payload, String(chatId));
  saveSession(chatId, chatKey.session);
  return text;
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
  if (all.byteLength < 14) throw new Error('Повреждённый файл');
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
      reject(new Error('Нет ключа шифрования у собеседника'));
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
    document.getElementById('step-2-desc').textContent = `Код отправлен на ${regState.phone}`;
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
    showToast('Введите номер телефона', 'error');
    return;
  }

  const btn = document.getElementById('send-code-btn');
  btn.disabled = true;
  btn.textContent = 'Отправка...';
  try {
    const { ok, data } = await api('/api/send-code', { method: 'POST', body: { phone }, auth: false });
    if (ok && data.success) {
      regState.phone = phone;
      goToStep(2);
      showToast('Код отправлен! Он выведен в консоль сервера', 'success');
    } else {
      showToast(data.error || 'Не удалось отправить код', 'error');
    }
  } catch (e) {
    showToast('Ошибка соединения с сервером', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Далее';
  }
}

async function step2Next() {
  const code = document.getElementById('code-input').value.trim();
  if (!code || code.length < 4) {
    showToast('Введите код', 'error');
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
      showToast(data.error || 'Неверный код', 'error');
    }
  } catch (e) {
    showToast('Ошибка: ' + e.message, 'error');
  }
}

function step3RegNext() {
  const firstName = document.getElementById('firstname-input').value.trim();
  const lastName = document.getElementById('lastname-input').value.trim();
  if (!firstName || firstName.length < 2) {
    showToast('Введите имя (минимум 2 символа)', 'error');
    return;
  }
  regState.firstName = firstName;
  regState.lastName = lastName;
  goToStep(4);
}

async function step3LoginNext() {
  const password = document.getElementById('password-input').value;
  if (!password) {
    showToast('Введите пароль', 'error');
    return;
  }

  try {
    const kp = await getOrCreateLocalKeyPair();
    const { ok, data } = await api('/api/login', {
      method: 'POST',
      body: { phone: regState.phone, password, publicKey: JSON.stringify(kp.publicKey) },
      auth: false
    });

    if (ok && data.success) {
      await enterApp(data, kp);
      showToast(`С возвращением, ${currentUser.name}! 🔐`, 'success');
    } else {
      showToast(data.error || 'Ошибка входа', 'error');
    }
  } catch (e) {
    showToast('Ошибка: ' + e.message, 'error');
  }
}

async function loginWithToken() {
  try {
    const kp = await getOrCreateLocalKeyPair();
    const { ok, data } = await api('/api/login-code', {
      method: 'POST',
      body: { phone: regState.phone, loginToken: regState.loginToken, publicKey: JSON.stringify(kp.publicKey) },
      auth: false
    });

    if (ok && data.success) {
      await enterApp(data, kp);
      showToast(`С возвращением, ${currentUser.name}! 🔐`, 'success');
    } else {
      showToast(data.error || 'Ошибка входа', 'error');
      if (data && /просроч|недействительн/i.test(data.error || '')) goToStep(1);
    }
  } catch (e) {
    showToast('Ошибка: ' + e.message, 'error');
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
    hint.textContent = 'Минимум 3 символа';
    hint.className = 'input-hint info';
    input.classList.remove('success', 'error');
    btn.disabled = true;
    return;
  }

  hint.textContent = 'Проверка...';
  hint.className = 'input-hint info';
  input.classList.remove('success', 'error');
  btn.disabled = true;

  usernameCheckTimeout = setTimeout(async () => {
    try {
      const { data } = await api(`/api/check-username?username=${encodeURIComponent(value)}`, { auth: false });
      if (data.available) {
        hint.innerHTML = `✅ Свободен! Вы будете: <span class="username-preview">@${escapeHtml(value)}</span>`;
        hint.className = 'input-hint success';
        input.classList.add('success');
        input.classList.remove('error');
        btn.disabled = false;
        regState.username = value;
      } else {
        hint.textContent = '❌ ' + (data.error || 'Username уже занят');
        hint.className = 'input-hint error';
        input.classList.add('error');
        input.classList.remove('success');
        btn.disabled = true;
      }
    } catch (e) {
      hint.textContent = 'Ошибка проверки';
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
    showToast('Пароль минимум 6 символов', 'error');
    return;
  }
  if (pwd !== confirm) {
    showToast('Пароли не совпадают', 'error');
    return;
  }
  if (!regState.verifyToken) {
    showToast('Подтвердите номер телефона заново', 'error');
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
        publicKey: JSON.stringify(kp.publicKey),
        verifyToken: regState.verifyToken
      },
      auth: false
    });

    if (ok && data.success) {
      await enterApp(data, kp);
      showToast(`Добро пожаловать, ${currentUser.name}! 🔐`, 'success');
    } else {
      showToast(data.error || 'Ошибка регистрации', 'error');
    }
  } catch (e) {
    showToast('Ошибка: ' + e.message, 'error');
  }
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👁️';
  }
}

async function enterApp(data) {
  currentUser = normalizeUser(data.user);
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
  // Публикуем актуальный публичный ключ (перекрывает старый, если сменилось устройство)
  publishOwnPublicKey().catch(() => {});
  maybeLockApp();
}

// ==================== ПРИЛОЖЕНИЕ ====================
function initApp() {
  updateMenuProfile();
  connectWebSocket();
}

function updateMenuProfile() {
  document.getElementById('menu-name').textContent = currentUser.name || 'Пользователь';
  document.getElementById('menu-username').textContent = '@' + (currentUser.username || 'username');
  document.getElementById('menu-phone').textContent = currentUser.phone || '';
  const avatarEl = document.getElementById('menu-avatar');
  if (currentUser.avatar) {
    avatarEl.innerHTML = `<img src="${escapeHtml(currentUser.avatar)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
  } else {
    avatarEl.textContent = (currentUser.firstName || currentUser.name || 'U')[0].toUpperCase();
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
    ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    publishOwnPublicKey().catch(() => {});
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
      wsReconnectTimer = setTimeout(connectWebSocket, 1500);
    }
  };

  ws.onerror = () => { /* onclose выполнит реконнект */ };
}

function sendWs(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Нет соединения с сервером', 'error');
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

    case 'chats':
      chats = (msg.chats || []).map(normalizeChat);
      rebuildOnlineSet();
      renderChatList();
      if (currentChatId && !getChatById(currentChatId)) closeChat();
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
        chats.unshift(normalizeChat({ id: msg.chatId, type: 'private', members: msg.members }));
        renderChatList();
      }
      openChat(msg.chatId);
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
      messages[chatId] = (msg.messages || []).map(normalizeMessage);
      if (currentChatId === chatId) {
        renderMessages(chatId);
        markChatRead(chatId);
      }
      break;
    }

    case 'new_message': {
      const message = normalizeMessage(msg.message);
      if (!messages[message.chat_id]) messages[message.chat_id] = [];
      const isNew = !messages[message.chat_id].some(m => m.id === message.id);
      if (isNew) {
        messages[message.chat_id].push(message);
        if (currentChatId === message.chat_id) appendMessage(message);
      }
      updateChatPreview(message.chat_id, message);
      if (isNew && currentChatId === message.chat_id) markChatRead(message.chat_id);
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
        if (currentChatId === Number(msg.chatId)) renderMessages(Number(msg.chatId));
      }
      break;
    }

    case 'message_deleted': {
      const chatId = Number(msg.chatId);
      if (messages[chatId]) {
        messages[chatId] = messages[chatId].filter(m => m.id !== Number(msg.messageId));
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
        reorderChat(chat);
      }
      renderChatList();
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

    case 'error':
      showToast(msg.error || 'Ошибка сервера', 'error');
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

function renderChatList(filter = '') {
  const container = document.getElementById('chat-list');
  const folderId = typeof activeFolderId !== 'undefined' ? activeFolderId : null;
  const filtered = chats.filter(c => {
    if (folderId !== null) {
      const folder = (folders || []).find(f => Number(f.id) === Number(folderId));
      if (!folder || !(folder.chat_ids || []).includes(c.id)) return false;
    }
    return !filter || getChatName(c).toLowerCase().includes(filter.toLowerCase());
  });

  container.innerHTML = filtered.map(chat => {
    const name = getChatName(chat);
    const avatar = getChatAvatar(chat);
    const isOnline = isChatOnline(chat);
    const time = chat.last_message_time ? formatTime(chat.last_message_time) : '';
    return `
      <div class="chat-item ${currentChatId === chat.id ? 'active' : ''}"
           data-action="openChat" data-id="${chat.id}" data-chat-id="${chat.id}">
        <div class="chat-avatar ${isOnline ? 'online' : ''}">${escapeHtml(avatar)}</div>
        <div class="chat-info">
          <div class="chat-top">
            <span class="chat-name">${escapeHtml(name)}</span>
            <span class="chat-time">${time}</span>
          </div>
          <div class="chat-bottom">
            <span class="chat-preview" data-preview-chat="${chat.id}">${chatPreview(chat)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Расшифровываем превью последнего сообщения (сервер хранит только шифротекст)
  filtered.forEach(chat => refreshChatPreview(chat));
}

function chatPreview(chat) {
  if (!chat.last_message) return 'Нет сообщений';
  const labels = {
    voice: '🎤 Голосовое сообщение',
    video: '📹 Видеосообщение',
    image: '🖼 Изображение',
    file: '📎 Файл'
  };
  return labels[chat.last_message_type] || '🔒 Загрузка…';
}

async function refreshChatPreview(chat) {
  const el = document.querySelector(`.chat-preview[data-preview-chat="${chat.id}"]`);
  if (!el || !chat.last_message) return;
  const labels = {
    voice: '🎤 Голосовое сообщение',
    video: '📹 Видеосообщение',
    image: '🖼 Изображение',
    file: '📎 Файл'
  };
  if (labels[chat.last_message_type]) {
    el.textContent = labels[chat.last_message_type];
    return;
  }
  try {
    const key = await getChatKey(chat.id, chat);
    const text = await decryptChatText(key, {
      encrypted_content: chat.last_message,
      iv: chat.last_message_iv,
      header: chat.last_message_header
    }, chat.id, chat.last_sender_id === currentUser.id);
    el.textContent = String(text).slice(0, 80);
  } catch (e) {
    el.textContent = '🔒 Зашифрованное сообщение';
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

function updateChatPreview(chatId, msg) {
  const chat = getChatById(chatId);
  if (!chat) return;
  chat.last_message = msg.encrypted_content ?? msg.content ?? '';
  chat.last_message_type = msg.type || null;
  chat.last_message_time = msg.created_at ?? msg.createdAt ?? Date.now();
  chat.last_sender_id = msg.sender_id ?? msg.senderId ?? 0;
  reorderChat(chat);
  renderChatList();
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
  sendWs({ type: 'read_messages', chatId, lastReadId: lastId });
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
    const el = document.querySelector(`.message[data-msg-id="${msg.id}"] .tick-marks`);
    if (!el) return;
    const read = isMessageReadByOthers(msg, chat);
    el.textContent = read ? '✓✓' : '✓';
    el.classList.toggle('read', read);
  });
}

async function openChat(chatId) {
  // Очищаем анимации печати от предыдущего чата
  for (const t of typewriterTimers) clearTimeout(t);
  typewriterTimers.clear();

  chatId = Number(chatId);
  const chat = getChatById(chatId);
  if (!chat) return;

  currentChatId = chatId;
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('active-chat').style.display = 'flex';
  document.getElementById('app-container').classList.add('chat-open');

  document.querySelectorAll('.chat-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.chatId, 10) === chatId);
  });

  updateChatHeader();
  sendWs({ type: 'get_messages', chatId, limit: 50 });
}

function updateChatHeader() {
  const chat = getChatById(currentChatId);
  if (!chat) return;

  document.getElementById('chat-header-name').textContent = getChatName(chat);
  document.getElementById('chat-header-avatar').textContent = getChatAvatar(chat);

  const statusEl = document.getElementById('chat-header-status');
  if (chat.type === 'private') {
    const other = chat.members?.find(m => m.id !== currentUser.id);
    if (isChatOnline(chat)) {
      statusEl.textContent = 'в сети';
      statusEl.className = 'chat-header-status online';
    } else if (other?.last_seen) {
      statusEl.textContent = 'был(а) ' + formatLastSeen(other.last_seen);
      statusEl.className = 'chat-header-status';
    } else {
      statusEl.textContent = 'не в сети';
      statusEl.className = 'chat-header-status';
    }
  } else if (chat.type === 'group' || chat.type === 'supergroup') {
    statusEl.textContent = `${chat.members?.length || 0} участников`;
  } else {
    statusEl.textContent = 'заметки';
  }
  updateEncryptionBadge();
}

// ==================== ОТРИСОВКА СООБЩЕНИЙ ====================
async function renderMessages(chatId) {
  const container = document.getElementById('messages-container');
  const chat = getChatById(chatId);
  if (!chat) return;

  const list = messages[chatId] || [];
  let key = null;
  try { key = await getChatKey(chatId, chat); } catch (e) { key = null; }

  container.innerHTML = '';
  let lastDate = '';
  for (const msg of list) {
    const date = formatDate(msg.created_at);
    if (date !== lastDate) {
      container.appendChild(buildDateSeparator(date));
      lastDate = date;
    }
    const el = await buildMessageElement(msg, chat, key);
    if (el) container.appendChild(el);
  }
  container.scrollTop = container.scrollHeight;
}

async function appendMessage(msg) {
  const container = document.getElementById('messages-container');
  const chat = getChatById(currentChatId);
  if (!chat) return;

  const list = messages[currentChatId] || [];
  const prev = list[list.length - 2];
  if (!prev || formatDate(prev.created_at) !== formatDate(msg.created_at)) {
    container.appendChild(buildDateSeparator(formatDate(msg.created_at)));
  }

  const shouldScroll = container.scrollHeight - container.scrollTop - container.clientHeight < 180;
  let key = null;
  try { key = await getChatKey(currentChatId, chat); } catch (e) { key = null; }
  // «Печатная машинка» только для свежих входящих текстовых сообщений.
  const animate = msg.sender_id !== currentUser.id && (msg.type === 'text' || !msg.type);
  const el = await buildMessageElement(msg, chat, key, animate);
  if (el) {
    container.appendChild(el);
    if (msg.sender_id === currentUser.id) {
      el.classList.add('sent-pop');
      setTimeout(() => el.classList.remove('sent-pop'), 360);
    }
  }
  if (shouldScroll) container.scrollTop = container.scrollHeight;
}

function buildDateSeparator(date) {
  const div = document.createElement('div');
  div.className = 'date-separator';
  const span = document.createElement('span');
  span.textContent = date;
  div.appendChild(span);
  return div;
}

async function buildMessageElement(msg, chat, key, animate = false) {
  const isOut = msg.sender_id === currentUser.id;
  const wrapper = document.createElement('div');
  wrapper.className = `message ${isOut ? 'out' : 'in'}`;
  wrapper.dataset.msgId = String(msg.id);

  if (!isOut && chat.type !== 'private' && chat.type !== 'saved') {
    const senderEl = document.createElement('div');
    senderEl.className = 'message-sender';
    senderEl.textContent = msg.sender_name || chat.members?.find(m => m.id === msg.sender_id)?.name || '';
    wrapper.appendChild(senderEl);
  }

  // Превью ответа на сообщение
  if (msg.reply_to) {
    const original = (messages[chat?.id] || []).find(m => m.id === Number(msg.reply_to));
    if (original) {
      const preview = document.createElement('div');
      preview.className = 'reply-preview';
      let author = original.sender_name || 'Собеседник';
      let text = '🔒';
      try {
        if (key) text = await decryptChatText(key, original, chat.id, original.sender_id === currentUser.id);
      } catch (e) { text = '🔒'; }
      preview.innerHTML = `<span class="rp-name">${escapeHtml(author)}</span><span class="rp-text">${escapeHtml(String(text).slice(0, 80))}</span>`;
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
      chip.textContent = `${emoji} ${(users || []).length}`;
      chip.title = `${(users || []).length}`;
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
    edited.textContent = 'ред.';
    meta.appendChild(edited);
  }
  const time = document.createElement('span');
  time.textContent = formatMessageTime(msg.created_at);
  meta.appendChild(time);
  if (isOut) {
    const ticks = document.createElement('span');
    const read = isMessageReadByOthers(msg, chat);
    ticks.className = 'tick-marks' + (read ? ' read' : '');
    ticks.textContent = read ? '✓✓' : '✓';
    meta.appendChild(ticks);
  }
  wrapper.appendChild(meta);

  if (isOut) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (msg.type === 'text') {
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.textContent = '✏️';
      editBtn.title = 'Редактировать';
      editBtn.onclick = () => editMessage(msg.id);
      actions.appendChild(editBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-action-btn';
    delBtn.textContent = '🗑️';
    delBtn.title = 'Удалить';
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
    div.textContent = '🗑️ Сообщение удалено';
    return div;
  }

  const isOwn = msg.sender_id === currentUser.id;

  if (msg.type === 'text' || !msg.type) {
    const div = document.createElement('div');
    div.className = 'message-text';
    const raw = msg.encrypted_content;
    if (!raw) return div;
    let text = '🔒 [Нет ключа шифрования]';
    if (key) {
      try {
        text = await decryptChatText(key, msg, chatId, isOwn);
      } catch (e) {
        text = '⚠️ Не удалось расшифровать сообщение';
      }
    }
    if (animate && text && !text.startsWith('🔒') && !text.startsWith('⚠️')) {
      typewriter(div, text);
    } else {
      div.innerHTML = formatMessageText(text);
    }
    return div;
  }

  let payload = null;
  if (key && msg.encrypted_content) {
    try {
      const decrypted = await decryptChatText(key, msg, chatId, isOwn);
      if (decrypted && !decrypted.startsWith('🔒') && !decrypted.startsWith('⚠️')) payload = JSON.parse(decrypted);
    } catch (e) { payload = null; }
  }

  if (!payload || !payload.url) {
    const div = document.createElement('div');
    div.className = 'message-text';
    div.textContent = '🔒 [Медиа недоступно]';
    return div;
  }

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
  if (!res.ok) throw new Error('Не удалось скачать файл (' + res.status + ')');

  const encrypted = await res.arrayBuffer();
  const plain = await decryptBlob(encrypted, key);
  const objectUrl = URL.createObjectURL(
    new Blob([plain], { type: payload.mime || 'application/octet-stream' })
  );

  if (mediaCache.size >= MEDIA_CACHE_LIMIT) {
    const oldest = mediaCache.keys().next().value;
    URL.revokeObjectURL(mediaCache.get(oldest));
    mediaCache.delete(oldest);
  }
  mediaCache.set(payload.url, objectUrl);
  return objectUrl;
}

function buildImage(payload, key) {
  const wrap = document.createElement('div');
  wrap.className = 'image-message';
  const placeholder = document.createElement('div');
  placeholder.className = 'media-loading';
  placeholder.textContent = 'Загрузка изображения…';
  wrap.appendChild(placeholder);

  const load = async () => {
    try {
      const src = await getMediaObjectUrl(payload, key);
      const img = document.createElement('img');
      img.src = src;
      img.alt = payload.name || 'Изображение';
      img.onclick = () => window.open(src, '_blank', 'noopener');
      placeholder.replaceWith(img);
    } catch (e) {
      placeholder.textContent = '🔒 Изображение недоступно';
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
  btn.textContent = '▶';

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
  btn.onclick = async () => {
    try {
      if (!audio) {
        btn.disabled = true;
        const src = await getMediaObjectUrl(payload, key);
        audio = new Audio(src);
        audio.onplay = () => { btn.textContent = '⏸'; };
        audio.onpause = () => { btn.textContent = '▶'; };
        audio.onended = () => { btn.textContent = '▶'; };
        btn.disabled = false;
      }
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch (e) {
      btn.disabled = false;
      showToast('Не удалось воспроизвести: ' + e.message, 'error');
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
  placeholder.textContent = 'Нажмите, чтобы загрузить видео';

  const play = document.createElement('div');
  play.className = 'video-play';
  play.textContent = '▶';

  const duration = document.createElement('div');
  duration.className = 'video-duration';
  duration.textContent = formatDuration(payload.duration);

  wrap.append(placeholder, play, duration);

  let video = null;
  wrap.onclick = async () => {
    try {
      if (!video) {
        placeholder.textContent = 'Загрузка видео…';
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
      placeholder.textContent = '🔒 Видео недоступно';
      showToast('Не удалось воспроизвести видео: ' + e.message, 'error');
    }
  };

  return wrap;
}

function buildFile(payload, key) {
  const wrap = document.createElement('div');
  wrap.className = 'file-message';

  const icon = document.createElement('div');
  icon.className = 'file-icon';
  icon.textContent = fileIcon(payload.mime);

  const info = document.createElement('div');
  info.className = 'file-info';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = payload.name || 'Файл';
  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = formatBytes(payload.size) + ' • нажмите, чтобы скачать';
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
      showToast('Не удалось скачать файл: ' + e.message, 'error');
    }
  };
  return wrap;
}

function fileIcon(mime) {
  if (!mime) return '📎';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('zip') || mime.includes('compressed')) return '🗜️';
  return '📎';
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
    showToast('🔒 ' + err.message, 'error');
    return;
  }

  let envelope;
  try {
    envelope = await encryptChatText(key, text, currentChatId);
  } catch (err) {
    showToast('🔒 ' + err.message, 'error');
    return;
  }
  rememberSent(envelope.content, text);
  const sent = sendWs({
    type: 'send_message',
    chatId: currentChatId,
    content: envelope.content,
    iv: envelope.iv,
    header: envelope.header,
    msgType: 'text',
    replyTo: replyContext?.messageId || null
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
  if (!currentChatId) return;
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
  catch (err) { return showToast('🔒 ' + err.message, 'error'); }

  let currentText = '';
  try { currentText = await decryptChatText(key, msg, currentChatId); } catch (e) { /* ignore */ }

  const newText = prompt('Редактировать сообщение:', currentText);
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
  if (!confirm('Удалить сообщение?')) return;
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
    showToast('Сначала выберите чат', 'error');
    return;
  }
  if (mediaRecorder) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('Браузер не поддерживает запись медиа', 'error');
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
        showToast('Слишком короткая запись', 'error');
        return;
      }

      try {
        await sendMediaBlob(blob, type, {
          chatId: chatIdAtStart,
          duration: durationSec,
          name: type === 'video' ? 'Видеосообщение' : 'Голосовое сообщение',
          mime: blob.type
        });
      } catch (e) {
        showToast('Ошибка отправки: ' + e.message, 'error');
      }
    };

    mediaRecorder.start(250);
    updateRecordingUI(true);

    const maxSeconds = type === 'video' ? MAX_VIDEO_SECONDS : MAX_VOICE_SECONDS;
    recordingMaxTimer = setTimeout(() => {
      showToast(`Достигнут лимит ${maxSeconds} сек.`, 'error');
      stopRecording();
    }, maxSeconds * 1000);

    recordingInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      updateRecordingTime(elapsed);
    }, 500);
  } catch (e) {
    showToast('Нет доступа к медиа: ' + e.message, 'error');
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
      <span class="recording-text">${recordingType === 'video' ? 'Запись видео…' : 'Запись аудио…'}</span>
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

function attachFile() {
  if (!currentChatId) {
    showToast('Сначала выберите чат', 'error');
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      showToast('Файл слишком большой (максимум 20 МБ)', 'error');
      return;
    }

    const chatIdAtStart = currentChatId;
    const kind = (file.type || '').startsWith('image/') ? 'image' : 'file';
    showToast('Загрузка файла…');
    try {
      await sendMediaBlob(file, kind, {
        chatId: chatIdAtStart,
        duration: 0,
        name: file.name,
        mime: file.type || 'application/octet-stream'
      });
      showToast('Файл отправлен', 'success');
    } catch (err) {
      showToast('Ошибка загрузки: ' + err.message, 'error');
    }
  };
  input.click();
}

async function sendMediaBlob(blob, kind, opts) {
  const chatId = Number(opts.chatId);
  const chat = getChatById(chatId);
  if (!chat) throw new Error('Чат не найден');

  const key = await getChatKey(chatId, chat);
  if (!key) throw new Error('Нет ключа шифрования');

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
    throw new Error(uploaded.error || 'Сервер отклонил файл');
  }

  const payload = {
    url: uploaded.url,
    fileId: uploaded.fileId,
    name: opts.name || 'Файл',
    size: buffer.byteLength,
    mime: opts.mime || blob.type || 'application/octet-stream',
    duration: opts.duration || 0
  };

  const envelope = await encryptChatText(key, JSON.stringify(payload), chatId);
  rememberSent(envelope.content, JSON.stringify(payload));
  const sent = sendWs({
    type: 'send_message',
    chatId,
    content: envelope.content,
    iv: envelope.iv,
    header: envelope.header,
    msgType: kind
  });
  if (!sent) throw new Error('Нет соединения с сервером');
}

// ==================== UI ====================
function showModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('show');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
}

function toggleMenu() {
  document.getElementById('side-menu').classList.toggle('open');
  document.getElementById('menu-backdrop').classList.toggle('show');
}

function closeChat() {
  for (const t of typewriterTimers) clearTimeout(t);
  typewriterTimers.clear();
  currentChatId = null;
  document.getElementById('app-container').classList.remove('chat-open');
  document.getElementById('active-chat').style.display = 'none';
  document.getElementById('empty-state').style.display = 'flex';
  document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
}

function openSearch() {
  toggleMenu();
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>🔍 Найти пользователя</h2>
    <div class="input-group">
      <input type="text" id="user-search-input" placeholder="Имя, номер или @username" data-action="searchUsers">
    </div>
    <div class="search-results" id="search-results"></div>
  `);
  document.getElementById('user-search-input').focus();
}

async function searchUsers(query) {
  clearTimeout(searchTimeout);
  const container = document.getElementById('search-results');
  if (!query || query.length < 2) {
    container.innerHTML = '<p style="color:var(--text-secondary);padding:14px;text-align:center">Введите минимум 2 символа</p>';
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const { ok, status, data } = await api(`/api/search-users?query=${encodeURIComponent(query)}`);
      if (status === 401) return handleSessionExpired();
      if (!ok || !Array.isArray(data)) throw new Error('search failed');

      if (data.length === 0) {
        container.innerHTML = '<p style="color:var(--text-secondary);padding:14px;text-align:center">Никого не найдено</p>';
        return;
      }
      container.innerHTML = data.map(u => `
        <div class="search-result-item" data-action="startChat" data-id="${u.id}">
          <div class="chat-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</div>
          <div>
            <div style="font-weight:600">${escapeHtml(u.name || 'Пользователь')}</div>
            <div style="font-size:12px;color:var(--text-secondary)">@${escapeHtml(u.username || '')} • ${escapeHtml(u.phone || '')}</div>
          </div>
        </div>
      `).join('');
    } catch (e) {
      container.innerHTML = '<p style="color:var(--danger);padding:14px;text-align:center">Ошибка поиска</p>';
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
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>👥 Новая группа</h2>
    <div class="input-group">
      <label>Название группы</label>
      <input type="text" id="group-name-input" placeholder="Моя группа">
    </div>
    <button class="btn" data-action="createGroup">Создать группу</button>
  `);
}

function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) {
    showToast('Введите название', 'error');
    return;
  }
  sendWs({ type: 'create_group', name, members: [] });
  closeModal();
}

function openNewChannel() {
  toggleMenu();
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>📢 Новый канал</h2>
    <div class="input-group">
      <label>Название канала</label>
      <input type="text" id="channel-name-input" placeholder="Мой канал">
    </div>
    <div class="input-group">
      <label>Описание</label>
      <input type="text" id="channel-desc-input" placeholder="О канала (необязательно)">
    </div>
    <button class="btn" data-action="createChannel">Создать канал</button>
  `);
}

function createChannel() {
  const name = document.getElementById('channel-name-input').value.trim();
  const description = document.getElementById('channel-desc-input').value.trim();
  if (!name) {
    showToast('Введите название', 'error');
    return;
  }
  const sent = sendWs({ type: 'create_channel', name, description });
  if (sent) {
    closeModal();
    showToast('Канал создан', 'success');
  }
}

function openSavedMessages() {
  toggleMenu();
  const saved = chats.find(c => c.type === 'saved');
  if (saved) openChat(saved.id);
}

function showChatInfo() {
  const chat = getChatById(currentChatId);
  if (!chat) return;
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>${escapeHtml(getChatName(chat))}</h2>
    <div style="text-align:center;margin-bottom:18px;">
      <div class="chat-avatar" style="width:70px;height:70px;font-size:28px;margin:0 auto 10px;">${escapeHtml(getChatAvatar(chat))}</div>
      <div class="encryption-badge">🔒 E2EE AES-256-GCM</div>
    </div>
    <div style="font-size:13px;color:var(--text-secondary)">
      Участников: ${chat.members?.length || 0}
    </div>
  `);
}

function showEncryptionInfo() {
  toggleMenu();
  showModal(`
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>🔐 О шифровании</h2>
    <div style="line-height:1.7;font-size:13px;">
      <p><strong>CipherTalk</strong> использует сквозное шифрование:</p><br>
      <p>🔑 <strong>ECDH</strong> (P-256) — обмен ключами</p>
      <p>🔒 <strong>AES-256-GCM</strong> — сообщения, файлы, голос и видео</p>
      <p>🛡️ <strong>HKDF</strong> — вывод ключей</p>
      <p>💾 <strong>AES-256-GCM</strong> — данные на диске сервера</p><br>
      <p>Сервер <strong>не имеет доступа</strong> к содержимому переписки и вложений.</p>
    </div>
  `);
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
  statusEl.innerHTML = `<span class="typing-indicator"><span></span><span></span><span></span></span> ${escapeHtml(name || '')} печатает…`;
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
    <button class="modal-close" data-action="closeModal">×</button>
    <h2>⚙️ Настройки</h2>

    <div class="settings-section-title">Профиль</div>
    <div class="row">
      <div class="input-group">
        <label>Имя</label>
        <input type="text" id="settings-firstname" value="${escapeHtml(currentUser.firstName || '')}">
      </div>
      <div class="input-group">
        <label>Фамилия</label>
        <input type="text" id="settings-lastname" value="${escapeHtml(currentUser.lastName || '')}">
      </div>
    </div>
    <div class="input-group">
      <label>Username</label>
      <input type="text" id="settings-username" value="${escapeHtml(currentUser.username || '')}">
    </div>
    <button class="btn" data-action="saveSettings">Сохранить</button>

    <div class="settings-section-title">Тема оформления</div>
    <div class="theme-grid">${themeSwatches}</div>

    <div class="settings-section-title">Фон чата</div>
    <div class="bg-grid">${bgSwatches}</div>
    <div class="row" style="margin-top:10px">
      <label class="btn btn-secondary" style="cursor:pointer;text-align:center">
        🖼️ Свой фон
        <input type="file" accept="image/*,image/gif" style="display:none" data-action="setCustomBg">
      </label>
      <button class="btn btn-secondary" data-action="clearCustomBg" ${appearance.customBg ? '' : 'disabled'}>Убрать свой фон</button>
    </div>

    <div class="settings-section-title">Стиль одним кликом</div>
    <div class="preset-row">
      ${STYLE_PRESETS.map(p => `<button class="preset-chip ${appearance.theme === p.patch.theme && appearance.glass === p.patch.glass ? 'active' : ''}" data-preset="${p.id}" data-action="setStylePreset" data-id="${p.id}">${escapeHtml(p.name)}</button>`).join('')}
    </div>

    <div class="settings-section-title">Эффекты стекла</div>
    <div class="switch-row">
      <span>Прозрачные панели (glassmorphism)</span>
      <div class="switch ${appearance.glass ? 'on' : ''}" id="glass-switch" data-action="toggleGlass"></div>
    </div>
    <div class="slider-row">
      <span>Сила размытия</span>
      <input type="range" min="4" max="40" step="1" value="${appearance.blur}" data-action="setBlur">
      <span class="slider-value" id="blur-value">${appearance.blur}px</span>
    </div>
    <div class="slider-row">
      <span>Прозрачность панелей</span>
      <input type="range" min="10" max="95" step="1" value="${appearance.bgOpacity}" data-action="setFloat" data-key="bgOpacity" data-target="opacity-value" data-unit="opacity-value">
      <span class="slider-value" id="opacity-value">${appearance.bgOpacity}%</span>
    </div>
    <div class="slider-row">
      <span>Насыщенность</span>
      <input type="range" min="80" max="240" step="5" value="${appearance.saturate}" data-action="setFloat" data-key="saturate" data-target="saturate-value" data-unit="saturate-value">
      <span class="slider-value" id="saturate-value">${appearance.saturate}%</span>
    </div>
    <div class="slider-row">
      <span>Свечение (glow)</span>
      <input type="range" min="0" max="30" step="1" value="${appearance.glow}" data-action="setFloat" data-key="glow" data-target="glow-value" data-unit="px">
      <span class="slider-value" id="glow-value">${appearance.glow}px</span>
    </div>
    <div class="slider-row">
      <span>Округление углов</span>
      <input type="range" min="0" max="28" step="1" value="${appearance.roundness}" data-action="setFloat" data-key="roundness" data-target="round-value" data-unit="px">
      <span class="slider-value" id="round-value">${appearance.roundness}px</span>
    </div>
    <div class="switch-row">
      <span>Снежинки на фоне</span>
      <div class="switch ${appearance.snow ? 'on' : ''}" id="snow-switch" data-action="toggleSnow"></div>
    </div>
    <div class="slider-row" style="align-items:center">
      <span>Анимации</span>
      <div class="anim-row">
        <button class="anim-chip ${appearance.animLevel === 'off' ? 'active' : ''}" data-anim="off" data-action="setAnimLevel" data-id="off">Выкл</button>
        <button class="anim-chip ${appearance.animLevel === 'normal' ? 'active' : ''}" data-anim="normal" data-action="setAnimLevel" data-id="normal">Обычные</button>
        <button class="anim-chip ${appearance.animLevel === 'full' ? 'active' : ''}" data-anim="full" data-action="setAnimLevel" data-id="full">Максимум</button>
      </div>
    </div>

    <div class="settings-section-title">Приватность</div>
    <div class="switch-row">
      <span>Скрыть статус «в сети»</span>
      <div class="switch ${privacy.hideOnline ? 'on' : ''}" id="hide-online-switch" data-action="toggleHideOnline"></div>
    </div>
    <div class="input-group">
      <label>PIN-код приложения (4-8 цифр)</label>
      <input type="password" id="settings-pin" placeholder="${privacy.pinHash ? 'PIN установлен — введите новый' : 'Не задан'}" inputmode="numeric" maxlength="8">
    </div>
    <div class="row">
      <button class="btn" data-action="setPin">Установить PIN</button>
      <button class="btn btn-secondary" data-action="removePin" ${privacy.pinHash ? '' : 'disabled'}>Снять PIN</button>
    </div>

    <div class="settings-section-title">Шифрование</div>
    <div class="settings-hint">Ключи E2EE хранятся только на этом устройстве. Сброс сделает старые сообщения нечитаемыми здесь.</div>
    <button class="btn btn-secondary" data-action="resetE2EE">🔑 Сбросить ключи шифрования</button>
  `);
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
  showToast(privacy.hideOnline ? 'Статус онлайна скрыт' : 'Статус онлайна виден', 'success');
}

async function saveSettings() {
  const firstName = document.getElementById('settings-firstname').value.trim();
  const lastName = document.getElementById('settings-lastname').value.trim();
  const username = document.getElementById('settings-username').value.trim();

  if (!firstName || firstName.length < 2) {
    showToast('Имя обязательно', 'error');
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
      showToast('Сохранено!', 'success');
    } else {
      showToast(data.error || 'Ошибка', 'error');
    }
  } catch (e) {
    showToast('Ошибка сохранения', 'error');
  }
}

function handleSessionExpired() {
  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  showToast('Сессия истекла, войдите снова', 'error');
  clearSession(false);
  setTimeout(() => location.reload(), 700);
}

function clearSession(reload) {
  authToken = '';
  currentUser = null;
  localStorage.removeItem('ciphertalk_token');
  localStorage.removeItem('ciphertalk_user');
  // ключи E2EE не удаляем: иначе история перестанет расшифровываться
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch (e) { /* ignore */ }
    ws = null;
  }
  mediaCache.forEach(objectUrl => URL.revokeObjectURL(objectUrl));
  mediaCache.clear();
  if (reload) location.reload();
}

async function logout() {
  if (!confirm('Выйти из аккаунта?')) return;
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
  logout: () => logout(),
  toggleMenu: () => toggleMenu(),
  closeChat: () => closeChat(),
  showChatInfo: () => showChatInfo(),
  attachFile: () => attachFile(),
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
  setBlur: (el) => setBlur(el.value),
  setFloat: (el) => setFloat(el.dataset.key, el.value, el.dataset.target, el.dataset.unit),
  toggleSnow: () => toggleSnow(),
  setAnimLevel: (el) => setAnimLevel(el.dataset.id),
  toggleHideOnline: () => toggleHideOnline(),
  setPin: () => setPin(),
  removePin: () => removePin(),
  resetE2EE: () => resetE2EE()
};

const CHANGE_ACTIONS = {
  setCustomBg: (el) => setCustomBg(el)
};

const INPUT_ACTIONS = {
  checkUsername: () => checkUsername(),
  checkPasswordStrength: () => checkPasswordStrength(),
  searchChats: (el) => searchChats(el.value),
  searchUsers: (el) => searchUsers(el.value),
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
  loadAppearance();
  snow.init();
  const savedUser = localStorage.getItem('ciphertalk_user');
  groupKeyBlobs = loadGroupKeyBlobs();

  if (authToken && savedUser) {
    try {
      const { ok, data } = await api('/api/me');
      if (ok && data.user) {
        currentUser = normalizeUser(data.user);
        identity = await ensureLocalIdentity();
        localStorage.setItem('ciphertalk_user', JSON.stringify(currentUser));
        if (currentUser.hide_online) {
          privacy.hideOnline = true;
          savePrivacy();
        }
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        initApp();
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
