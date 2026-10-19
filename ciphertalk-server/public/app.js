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
let cryptoKeys = {};        // chatId -> CryptoKey
let keyPairs = {};          // userId -> { publicKey, privateKey }
let onlineUsers = new Set();
let typingTimeout = null;
let usernameCheckTimeout = null;
let searchTimeout = null;
let lastTypingSent = 0;
let sessionExpiredHandled = false;
let typewriterTimers = new Set();

let regState = {
  phone: '', code: '', verifyToken: '', firstName: '', lastName: '',
  username: '', password: '', action: null, existingName: ''
};

// ==================== ВНЕШНИЙ ВИД (темы/фон/стекло) ====================
const APPEARANCE_KEY = 'ciphertalk_appearance';
const THEMES = [
  { id: 'dark', name: 'Тёмная', colors: ['#0e1621', '#2b5278', '#5eb5f7'] },
  { id: 'light', name: 'Светлая', colors: ['#ffffff', '#4a9de0', '#2b7fd4'] },
  { id: 'cyberpunk', name: 'Киберпанк', colors: ['#0d0221', '#ff2e97', '#00f5d4'] },
  { id: 'neon', name: 'Неон', colors: ['#05070d', '#00b4ff', '#39ff14'] }
];
const CHAT_BACKGROUNDS = [
  { id: 'default', name: 'По умолчанию' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'sunset', name: 'Закат' },
  { id: 'forest', name: 'Лес' },
  { id: 'grid', name: 'Сетка' }
];
let appearance = { theme: 'dark', chatBg: 'default', glass: false, snow: true };

function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    appearance = Object.assign(appearance, saved);
  } catch (e) { /* ignore */ }
  applyAppearance();
}

function saveAppearance() {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)); } catch (e) { /* ignore */ }
}

function applyAppearance() {
  const html = document.documentElement;
  html.setAttribute('data-theme', appearance.theme);
  html.setAttribute('data-glass', appearance.glass ? 'on' : 'off');
  document.querySelectorAll('.chat-area').forEach(el => {
    el.setAttribute('data-bg', appearance.chatBg);
  });
  if (snow) {
    if (appearance.snow) snow.resume();
    else { snow.pause(); if (snow.ctx) snow.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
  }
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
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">$1</a>');
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
    last_message_type: chat.last_message_type || null,
    last_message_time: chat.last_message_time || 0,
    last_sender_id: chat.last_sender_id || 0
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
    type: m.type || 'text',
    reply_to: m.reply_to ?? m.replyTo ?? null,
    edited: m.edited || 0,
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
function assertWebCrypto() {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('WebCrypto недоступен: откройте сайт по HTTPS или через localhost');
  }
}

async function generateKeyPair() {
  assertWebCrypto();
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );
  const publicKey = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return { publicKey, privateKey };
}

async function getOrCreateLocalKeyPair() {
  const saved = localStorage.getItem('ciphertalk_keys');
  if (saved) {
    try {
      const kp = JSON.parse(saved);
      if (kp && kp.publicKey && kp.privateKey) return kp;
    } catch (e) { /* ignore */ }
  }
  return generateKeyPair();
}

async function importPublicKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function importPrivateKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
}

async function deriveSharedKey(privateKeyJwk, publicKeyJwk) {
  const privateKey = await importPrivateKey(privateKeyJwk);
  const publicKey = await importPublicKey(publicKeyJwk);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey }, privateKey, 256
  );
  const keyMaterial = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: new TextEncoder().encode('CipherTalk') },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encryptMessage(text, aesKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(text)
  );
  return { content: arrayBufferToBase64(encrypted), iv: arrayBufferToBase64(iv) };
}

async function decryptMessage(encryptedContent, ivBase64, aesKey) {
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToArrayBuffer(ivBase64)) },
      aesKey, base64ToArrayBuffer(encryptedContent)
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return '🔒 [Ошибка расшифровки]';
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getChatKey(chatId, chat) {
  if (cryptoKeys[chatId]) return cryptoKeys[chatId];
  if (!chat) return null;

  if (chat.type === 'private') {
    const other = chat.members?.find(m => m.id !== currentUser.id);
    const kp = keyPairs[currentUser.id];
    if (!other || !kp) return null;
    if (!other.public_key) {
      sendWs({ type: 'get_public_key', targetUserId: other.id });
      return null;
    }
    try {
      const key = await deriveSharedKey(kp.privateKey, JSON.parse(other.public_key));
      cryptoKeys[chatId] = key;
      return key;
    } catch (e) {
      return null;
    }
  }

  // Группа/Избранное: детерминированный ключ из id чата (ограничение описано в отчёте)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('CipherTalk-Group-' + chatId));
  const key = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  cryptoKeys[chatId] = key;
  return key;
}

// Бинарные вложения: [12 байт IV][AES-GCM ciphertext]
async function encryptBlob(buffer, aesKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, buffer);
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out.buffer;
}

async function decryptBlob(buffer, aesKey) {
  const all = new Uint8Array(buffer);
  if (all.byteLength <= 12) throw new Error('Повреждённый файл');
  const iv = all.slice(0, 12);
  const ciphertext = all.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
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
      // Демо-режим («чит-код»): вход без SMS — сразу подставляем код и входим.
      if (data.demo) {
        document.getElementById('code-input').value = data.code || '';
        regState.phone = phone;
        await step2Next();
        return;
      }
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
      // Демо-режим («чит-код»): сразу входим, без пароля.
      if (data.action === 'demo' && data.token) {
        const kp = await getOrCreateLocalKeyPair();
        // публикуем ключ демо-пользователя на сервере
        try {
          await api('/api/login', {
            method: 'POST',
            body: { phone: regState.phone, password: 'demo123', publicKey: JSON.stringify(kp.publicKey) },
            auth: false
          });
        } catch (e) { /* не критично */ }
        await enterApp(data, kp);
        showToast('Демо-режим: добро пожаловать! 🎄', 'success');
        return;
      }
      regState.action = data.action;
      regState.verifyToken = data.verifyToken || '';
      if (data.action === 'register') {
        goToStep(3);
      } else {
        regState.existingName = data.name;
        goToStep(3);
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

async function enterApp(data, kp) {
  currentUser = normalizeUser(data.user);
  if (data.token) {
    authToken = data.token;
    localStorage.setItem('ciphertalk_token', authToken);
  }
  keyPairs[currentUser.id] = kp;
  localStorage.setItem('ciphertalk_user', JSON.stringify(currentUser));
  localStorage.setItem('ciphertalk_keys', JSON.stringify(kp));

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  initApp();
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
  document.getElementById('menu-avatar').textContent =
    (currentUser.firstName || currentUser.name || 'U')[0].toUpperCase();
}

function connectWebSocket() {
  clearTimeout(wsReconnectTimer);
  if (!authToken || !currentUser) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    const kp = keyPairs[currentUser.id];
    if (kp) {
      ws.send(JSON.stringify({ type: 'set_public_key', publicKey: JSON.stringify(kp.publicKey) }));
    }
  };

  ws.onmessage = (event) => {
    try {
      handleWSMessage(JSON.parse(event.data));
    } catch (e) {
      console.error('WS message handling error:', e);
    }
  };

  ws.onclose = () => {
    ws = null;
    if (authToken && currentUser) {
      wsReconnectTimer = setTimeout(connectWebSocket, 3000);
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
      break;

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
        cryptoKeys[msg.chatId] = null;
        delete cryptoKeys[msg.chatId];
        if (currentChatId === msg.chatId) updateChatHeader();
      }
      break;
    }

    case 'messages': {
      const chatId = Number(msg.chatId);
      messages[chatId] = (msg.messages || []).map(normalizeMessage);
      if (currentChatId === chatId) renderMessages(chatId);
      break;
    }

    case 'new_message': {
      const message = normalizeMessage(msg.message);
      if (!messages[message.chat_id]) messages[message.chat_id] = [];
      if (!messages[message.chat_id].some(m => m.id === message.id)) {
        messages[message.chat_id].push(message);
      }
      if (currentChatId === message.chat_id) appendMessage(message);
      updateChatPreview(message.chat_id, message);
      break;
    }

    case 'message_edited': {
      const list = messages[Number(msg.chatId)];
      const m = list && list.find(x => x.id === Number(msg.messageId));
      if (m) {
        m.encrypted_content = msg.content;
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

    case 'typing':
      if (currentChatId === Number(msg.chatId) && msg.userId !== currentUser.id) {
        showTypingIndicator(msg.name);
      }
      break;

    case 'chat_updated': {
      const chat = getChatById(msg.chatId);
      if (chat) {
        chat.last_message = msg.lastMessage || '';
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

    case 'public_key':
      handlePublicKey(msg.userId, msg.publicKey);
      break;

    case 'error':
      showToast(msg.error || 'Ошибка сервера', 'error');
      break;
  }
}

function handlePublicKey(userId, publicKey) {
  let changed = false;
  chats.forEach(chat => {
    const member = chat.members?.find(m => m.id === userId);
    if (member && publicKey && member.public_key !== publicKey) {
      member.public_key = publicKey;
      delete cryptoKeys[chat.id];
      changed = true;
    }
  });
  if (changed && currentChatId) renderMessages(currentChatId);
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
  const filtered = chats.filter(c => !filter || getChatName(c).toLowerCase().includes(filter.toLowerCase()));

  container.innerHTML = filtered.map(chat => {
    const name = getChatName(chat);
    const avatar = getChatAvatar(chat);
    const isOnline = isChatOnline(chat);
    const time = chat.last_message_time ? formatTime(chat.last_message_time) : '';
    return `
      <div class="chat-item ${currentChatId === chat.id ? 'active' : ''}"
           onclick="openChat(${chat.id})" data-chat-id="${chat.id}">
        <div class="chat-avatar ${isOnline ? 'online' : ''}">${escapeHtml(avatar)}</div>
        <div class="chat-info">
          <div class="chat-top">
            <span class="chat-name">${escapeHtml(name)}</span>
            <span class="chat-time">${time}</span>
          </div>
          <div class="chat-bottom">
            <span class="chat-preview">${chatPreview(chat)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function chatPreview(chat) {
  if (!chat.last_message) return 'Нет сообщений';
  const labels = {
    voice: '🎤 Голосовое сообщение',
    video: '📹 Видеосообщение',
    image: '🖼 Изображение',
    file: '📎 Файл'
  };
  return labels[chat.last_message_type] || '🔒 Шифрованное сообщение';
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
}

// ==================== ОТРИСОВКА СООБЩЕНИЙ ====================
async function renderMessages(chatId) {
  const container = document.getElementById('messages-container');
  const chat = getChatById(chatId);
  if (!chat) return;

  const list = messages[chatId] || [];
  const key = await getChatKey(chatId, chat);

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
  const key = await getChatKey(currentChatId, chat);
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

  wrapper.appendChild(await buildMessageContent(msg, key, animate));

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
    ticks.textContent = '✓✓';
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

async function buildMessageContent(msg, key, animate = false) {
  if (msg.type === 'text' || !msg.type) {
    const div = document.createElement('div');
    div.className = 'message-text';
    const raw = msg.encrypted_content;
    if (!raw) return div;
    const text = key ? await decryptMessage(raw, msg.iv, key) : '🔒 [Нет ключа шифрования]';
    if (animate && text && !text.startsWith('🔒')) {
      typewriter(div, text);
    } else {
      div.innerHTML = formatMessageText(text);
    }
    return div;
  }

  let payload = null;
  if (key && msg.encrypted_content) {
    try {
      const decrypted = await decryptMessage(msg.encrypted_content, msg.iv, key);
      if (decrypted && !decrypted.startsWith('🔒')) payload = JSON.parse(decrypted);
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
  const key = await getChatKey(currentChatId, chat);
  if (!key) {
    showToast('Не удалось получить ключ шифрования. Попробуйте ещё раз.', 'error');
    return;
  }

  const { content, iv } = await encryptMessage(text, key);
  const sent = sendWs({ type: 'send_message', chatId: currentChatId, content, iv, msgType: 'text' });
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
  const key = await getChatKey(currentChatId, chat);
  if (!key) return showToast('Нет ключа шифрования', 'error');

  let currentText = '';
  try { currentText = await decryptMessage(msg.encrypted_content, msg.iv, key); } catch (e) { /* ignore */ }

  const newText = prompt('Редактировать сообщение:', currentText);
  if (newText === null || newText === currentText || !newText.trim()) return;

  const { content, iv } = await encryptMessage(newText.trim(), key);
  sendWs({ type: 'edit_message', chatId: currentChatId, messageId: msgId, content, iv });
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

  const { content, iv } = await encryptMessage(JSON.stringify(payload), key);
  const sent = sendWs({
    type: 'send_message',
    chatId,
    content,
    iv,
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
    <button class="modal-close" onclick="closeModal()">×</button>
    <h2>🔍 Найти пользователя</h2>
    <div class="input-group">
      <input type="text" id="user-search-input" placeholder="Имя, номер или @username" oninput="searchUsers(this.value)">
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
        <div class="search-result-item" onclick="startChat(${u.id})">
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
    <button class="modal-close" onclick="closeModal()">×</button>
    <h2>👥 Новая группа</h2>
    <div class="input-group">
      <label>Название группы</label>
      <input type="text" id="group-name-input" placeholder="Моя группа">
    </div>
    <button class="btn" onclick="createGroup()">Создать группу</button>
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

function openSavedMessages() {
  toggleMenu();
  const saved = chats.find(c => c.type === 'saved');
  if (saved) openChat(saved.id);
}

function showChatInfo() {
  const chat = getChatById(currentChatId);
  if (!chat) return;
  showModal(`
    <button class="modal-close" onclick="closeModal()">×</button>
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
    <button class="modal-close" onclick="closeModal()">×</button>
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
    <button class="theme-swatch ${appearance.theme === t.id ? 'active' : ''}" data-theme="${t.id}" onclick="setTheme('${t.id}')">
      <span class="dots">${t.colors.map(c => `<i style="background:${c}"></i>`).join('')}</span>
      ${escapeHtml(t.name)}
    </button>`).join('');

  const bgSwatches = CHAT_BACKGROUNDS.map(b => `
    <div class="bg-swatch ${appearance.chatBg === b.id ? 'active' : ''}" data-bg="${b.id}"
         data-preview="${b.id}" onclick="setChatBg('${b.id}')">
      <span>${escapeHtml(b.name)}</span>
    </div>`).join('');

  showModal(`
    <button class="modal-close" onclick="closeModal()">×</button>
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
    <button class="btn" onclick="saveSettings()">Сохранить</button>

    <div class="settings-section-title">Тема оформления</div>
    <div class="theme-grid">${themeSwatches}</div>

    <div class="settings-section-title">Фон чата</div>
    <div class="bg-grid">${bgSwatches}</div>

    <div class="settings-section-title">Эффекты</div>
    <div class="switch-row">
      <span>Прозрачные панели (glassmorphism)</span>
      <div class="switch ${appearance.glass ? 'on' : ''}" id="glass-switch" onclick="toggleGlass()"></div>
    </div>
    <div class="switch-row">
      <span>Снежинки на фоне</span>
      <div class="switch ${appearance.snow ? 'on' : ''}" id="snow-switch" onclick="toggleSnow()"></div>
    </div>
  `);
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

// ==================== СТАРТ ====================
window.addEventListener('load', async () => {
  loadAppearance();
  snow.init();
  const savedUser = localStorage.getItem('ciphertalk_user');
  const savedKeys = localStorage.getItem('ciphertalk_keys');

  if (authToken && savedUser && savedKeys) {
    try {
      const { ok, data } = await api('/api/me');
      if (ok && data.user) {
        currentUser = normalizeUser(data.user);
        keyPairs[currentUser.id] = JSON.parse(savedKeys);
        localStorage.setItem('ciphertalk_user', JSON.stringify(currentUser));
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        initApp();
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

window.addEventListener('beforeunload', () => {
  if (recordingStream) recordingStream.getTracks().forEach(track => track.stop());
});
