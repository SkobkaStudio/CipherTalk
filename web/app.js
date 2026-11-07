'use strict';

/* ═══════════════════════════════════════════════════════════════
   CipherTalk — фронтенд без фреймворков.
   Всё состояние в одном объекте, DOM — через textContent (XSS-safe).
   ═══════════════════════════════════════════════════════════════ */

const STORAGE_TOKEN = 'ct_token';
const STORAGE_USER = 'ct_user';
const WS_RECONNECT_DELAY = 2000;
const MOBILE_BREAKPOINT = 720;

const state = {
  token: null,
  userId: null,
  username: null,
  currentChatId: null,
  ws: null,
  wsRetryTimer: null,
  manualClose: false,
  chats: [],
  messageIds: new Set(),
  openSeq: 0,
  lastDayKey: null,
  loadingMessages: false,
  pendingMessages: [],
  authMode: 'login',
  chatModalMode: 'create',
  toastTimer: null,
  sending: false,
};

const els = {};

document.addEventListener('DOMContentLoaded', init);

function init() {
  cacheElements();
  bindEvents();

  if (restoreSession()) {
    showApp();
  } else {
    showAuth();
  }
}

function cacheElements() {
  const ids = [
    'auth-screen', 'auth-form', 'auth-username', 'auth-password', 'auth-error',
    'auth-submit', 'app-screen', 'profile-btn', 'chat-search', 'new-chat-btn',
    'join-chat-btn', 'chats-list', 'conn-dot', 'conn-status', 'empty-new-chat',
    'chat-empty', 'chat-view', 'back-btn', 'chat-avatar', 'chat-title',
    'chat-meta', 'chat-id-badge', 'messages', 'messages-empty', 'message-form',
    'message-input', 'send-btn', 'profile-modal', 'profile-avatar',
    'profile-name', 'profile-id', 'profile-host', 'profile-conn', 'logout-btn',
    'chat-modal', 'chat-modal-title', 'chat-modal-subtitle', 'chat-tab-create',
    'chat-tab-join', 'chat-form', 'create-field', 'join-field', 'new-chat-name',
    'join-chat-id', 'chat-modal-error', 'chat-submit', 'toast',
  ];

  for (const id of ids) {
    const key = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    els[key] = document.getElementById(id);
  }
}

/* ─────────────────────────── Сессия ─────────────────────────── */

function restoreSession() {
  let token = null;
  let user = null;

  try {
    token = localStorage.getItem(STORAGE_TOKEN);
    const rawUser = localStorage.getItem(STORAGE_USER);
    if (rawUser) user = JSON.parse(rawUser);
  } catch (_) {
    token = null;
    user = null;
  }

  if (
    typeof token === 'string' && token &&
    user && Number.isInteger(Number(user.id)) && typeof user.username === 'string'
  ) {
    state.token = token;
    state.userId = Number(user.id);
    state.username = user.username;
    return true;
  }

  clearStoredSession();
  return false;
}

function persistSession() {
  try {
    localStorage.setItem(STORAGE_TOKEN, state.token);
    localStorage.setItem(
      STORAGE_USER,
      JSON.stringify({ id: state.userId, username: state.username })
    );
  } catch (_) {
    // Приватный режим/переполнение — просто работаем без сохранения.
  }
}

function clearStoredSession() {
  try {
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_USER);
  } catch (_) {
    // ignore
  }
}

/* ─────────────────────────── API ────────────────────────────── */

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (state.token) {
    headers.set('Authorization', 'Bearer ' + state.token);
  }

  let response;
  try {
    response = await fetch(path, { ...options, headers, cache: 'no-store' });
  } catch (_) {
    throw new Error('Нет соединения с сервером');
  }

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = raw;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && state.token) {
      logout();
      throw new Error('Сессия истекла — войдите снова');
    }
    const message =
      data && typeof data === 'object' && data.error
        ? data.error
        : (typeof data === 'string' && data ? data : `Ошибка ${response.status}`);
    throw new Error(message);
  }

  return data;
}

/* ─────────────────────────── Авторизация ────────────────────── */

function showAuth() {
  els.appScreen.classList.add('hidden');
  els.authScreen.classList.remove('hidden');
  document.body.classList.remove('mobile-chat-open');
  document.title = 'CipherTalk — мессенджер';

  closeProfileModal();
  closeChatModal();
  setAuthMode('login');
  setAuthError('');
  els.authPassword.value = '';

  setTimeout(() => els.authUsername.focus(), 80);
}

function showApp() {
  state.manualClose = false;

  els.authScreen.classList.add('hidden');
  els.appScreen.classList.remove('hidden');
  document.body.classList.remove('mobile-chat-open');
  document.title = 'CipherTalk';

  renderProfile();
  setConnection('connecting', 'Подключение…');
  connectWs();

  loadChats().catch((error) => {
    if (state.token) toast(error.message);
  });
}

function setAuthMode(mode) {
  state.authMode = mode === 'register' ? 'register' : 'login';

  document.querySelectorAll('.auth-tab[data-mode]').forEach((tab) => {
    const active = tab.dataset.mode === state.authMode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  els.authSubmit.textContent = state.authMode === 'login' ? 'Войти' : 'Создать аккаунт';
  els.authPassword.autocomplete =
    state.authMode === 'login' ? 'current-password' : 'new-password';
  setAuthError('');
}

async function handleAuthSubmit(event) {
  event.preventDefault();

  const username = els.authUsername.value.trim();
  const password = els.authPassword.value;

  if (!username) {
    setAuthError('Введите имя пользователя');
    els.authUsername.focus();
    return;
  }
  if (!password) {
    setAuthError('Введите пароль');
    els.authPassword.focus();
    return;
  }
  if (state.authMode === 'register' && password.length < 6) {
    setAuthError('Пароль должен быть не короче 6 символов');
    els.authPassword.focus();
    return;
  }

  setAuthError('');
  els.authSubmit.disabled = true;
  const oldLabel = els.authSubmit.textContent;
  els.authSubmit.textContent = state.authMode === 'login' ? 'Вход…' : 'Создаём…';

  try {
    const data = await api(`/api/${state.authMode}`, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    if (!data || !data.token) {
      throw new Error('Сервер не вернул токен');
    }

    state.token = data.token;
    state.userId = Number(data.user_id);
    state.username = data.username || username;
    persistSession();

    els.authPassword.value = '';
    showApp();
  } catch (error) {
    setAuthError(error.message);
  } finally {
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = oldLabel;
  }
}

function logout() {
  state.manualClose = true;
  state.token = null;
  state.userId = null;
  state.username = null;
  state.currentChatId = null;
  state.chats = [];
  state.openSeq += 1;

  clearTimeout(state.wsRetryTimer);
  state.wsRetryTimer = null;

  if (state.ws) {
    const socket = state.ws;
    state.ws = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close(1000, 'logout');
    } catch (_) {
      // ignore
    }
  }

  clearMessages();
  els.chatView.classList.add('hidden');
  els.chatEmpty.classList.remove('hidden');
  els.chatTitle.textContent = 'Чат';
  els.chatMeta.textContent = '—';
  els.chatIdBadge.textContent = '#0';

  clearStoredSession();
  showAuth();
}

/* ─────────────────────────── Чаты ───────────────────────────── */

async function loadChats({ autoOpen = true } = {}) {
  const data = await api('/api/chats');
  const list = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.chats) ? data.chats : []);

  state.chats = list
    .map(normalizeChat)
    .filter((chat) => Number.isInteger(chat.id) && chat.id > 0);

  renderChats();

  const currentStillExists = state.chats.some(
    (chat) => Number(chat.id) === Number(state.currentChatId)
  );

  if (state.currentChatId && !currentStillExists) {
    closeChat();
  }

  if (
    autoOpen &&
    !state.currentChatId &&
    state.chats.length > 0 &&
    window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT + 1}px)`).matches
  ) {
    await openChat(state.chats[0].id);
  }
}

function normalizeChat(chat) {
  if (!chat || typeof chat !== 'object') return { id: NaN };
  return {
    id: Number(chat.id),
    name: typeof chat.name === 'string' && chat.name.trim() ? chat.name : 'Без названия',
    owner_id: Number(chat.owner_id) || 0,
    created_at: Number(chat.created_at) || 0,
    member_count: Number(chat.member_count) || 1,
  };
}

function renderChats() {
  if (!els.chatsList) return;

  const query = els.chatSearch.value.trim().toLowerCase();
  const chats = query
    ? state.chats.filter((chat) => chat.name.toLowerCase().includes(query))
    : state.chats;

  if (chats.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chats-empty';

    const icon = document.createElement('div');
    icon.className = 'chats-empty-icon';
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 ' +
      '8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 ' +
      '8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"></path>' +
      '</svg>';

    const title = document.createElement('strong');
    const hint = document.createElement('span');

    if (state.chats.length === 0) {
      title.textContent = 'Пока нет чатов';
      hint.textContent = 'Создайте первый чат или войдите по ID.';
    } else {
      title.textContent = 'Ничего не найдено';
      hint.textContent = 'Попробуйте другое название.';
    }

    empty.append(icon, title, hint);

    if (!query && state.chats.length === 0) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ghost';
      button.textContent = 'Создать чат';
      button.addEventListener('click', () => openChatModal('create'));
      empty.appendChild(button);
    }

    els.chatsList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const chat of chats) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-item';
    item.setAttribute('role', 'listitem');
    if (Number(chat.id) === Number(state.currentChatId)) {
      item.classList.add('active');
    }

    const avatar = document.createElement('div');
    avatar.className = 'avatar sm';
    avatar.setAttribute('aria-hidden', 'true');
    paintAvatar(avatar, chat.name, chat.id);

    const main = document.createElement('div');
    main.className = 'chat-item-main';

    const name = document.createElement('span');
    name.className = 'chat-item-name';
    name.textContent = chat.name;

    const sub = document.createElement('span');
    sub.className = 'chat-item-sub';
    sub.textContent = `${pluralMembers(chat.member_count)} · #${chat.id}`;

    main.append(name, sub);

    const side = document.createElement('span');
    side.className = 'chat-item-side';
    side.textContent = '#' + chat.id;

    item.append(avatar, main, side);
    item.addEventListener('click', () => openChat(chat.id));
    fragment.appendChild(item);
  }

  els.chatsList.replaceChildren(fragment);
}

async function openChat(chatId) {
  const chat = state.chats.find((item) => Number(item.id) === Number(chatId));
  if (!chat) {
    toast('Чат не найден в списке');
    return;
  }

  const sequence = ++state.openSeq;
  state.currentChatId = Number(chat.id);

  clearMessages();
  els.messagesEmpty.classList.add('hidden');
  els.messages.classList.add('is-loading');
  els.chatEmpty.classList.add('hidden');
  els.chatView.classList.remove('hidden');
  document.body.classList.add('mobile-chat-open');

  els.chatTitle.textContent = chat.name;
  els.chatMeta.textContent = pluralMembers(chat.member_count);
  els.chatIdBadge.textContent = '#' + chat.id;
  paintAvatar(els.chatAvatar, chat.name, chat.id);
  document.title = `${chat.name} — CipherTalk`;

  renderChats();
  subscribe(chat.id);

  if (window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT + 1}px)`).matches) {
    setTimeout(() => els.messageInput.focus(), 60);
  }

  state.pendingMessages = [];
  state.loadingMessages = true;

  try {
    const data = await api(`/api/chats/${chat.id}/messages?limit=50`);
    if (sequence !== state.openSeq) return;

    const list = Array.isArray(data)
      ? data
      : (data && Array.isArray(data.messages) ? data.messages : []);

    for (const message of list) {
      appendMessage(message, false);
    }

    // Сообщения, пришедшие по WS во время загрузки истории, добавляем после неё.
    state.loadingMessages = false;
    const pending = state.pendingMessages.splice(0);
    for (const message of pending) {
      appendMessage(message, true);
    }

    if (state.messageIds.size === 0) {
      els.messagesEmpty.classList.remove('hidden');
    }
    scrollToBottom(false);
  } catch (error) {
    if (sequence === state.openSeq) toast(error.message);
  } finally {
    if (sequence === state.openSeq) {
      state.loadingMessages = false;
      const pending = state.pendingMessages.splice(0);
      for (const message of pending) {
        appendMessage(message, true);
      }
      if (state.messageIds.size === 0) {
        els.messagesEmpty.classList.remove('hidden');
      }
      els.messages.classList.remove('is-loading');
    }
  }
}

function closeChat() {
  state.openSeq += 1;
  state.currentChatId = null;

  clearMessages();
  els.chatView.classList.add('hidden');
  els.chatEmpty.classList.remove('hidden');
  document.body.classList.remove('mobile-chat-open');
  document.title = 'CipherTalk';
  renderChats();
}

function clearMessages() {
  els.messages.querySelectorAll('.msg, .day-sep').forEach((node) => node.remove());
  state.messageIds.clear();
  state.lastDayKey = null;
  state.loadingMessages = false;
  state.pendingMessages = [];
  els.messages.classList.remove('is-loading');
  els.messagesEmpty.classList.add('hidden');
}

/* ─────────────────────────── Сообщения ──────────────────────── */

async function sendMessage() {
  if (state.sending || !state.currentChatId) return;

  const body = els.messageInput.value.trim();
  if (!body) return;

  const chatId = state.currentChatId;
  const savedText = els.messageInput.value;

  els.messageInput.value = '';
  autoResizeInput();
  state.sending = true;
  els.sendBtn.disabled = true;

  try {
    const message = await api(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });

    if (Number(state.currentChatId) === Number(chatId)) {
      appendMessage(message, true);
    }
  } catch (error) {
    toast(error.message);
    if (!els.messageInput.value) {
      els.messageInput.value = savedText;
      autoResizeInput();
    }
  } finally {
    state.sending = false;
    els.sendBtn.disabled = false;
    if (window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT + 1}px)`).matches) {
      els.messageInput.focus();
    }
  }
}

function appendMessage(message, animate = true) {
  if (!message || message.id === undefined || message.id === null) return;
  if (!state.currentChatId) return;
  if (Number(message.chat_id) !== Number(state.currentChatId)) return;

  const id = Number(message.id);
  if (state.messageIds.has(id)) return;
  state.messageIds.add(id);

  els.messagesEmpty.classList.add('hidden');

  const createdAt = Number(message.created_at) || Math.floor(Date.now() / 1000);
  const day = dayKey(createdAt);
  if (state.lastDayKey !== day) {
    state.lastDayKey = day;
    els.messages.appendChild(createDaySeparator(createdAt));
  }

  const mine = Number(message.user_id) === Number(state.userId);

  const row = document.createElement('div');
  row.className = 'msg ' + (mine ? 'me' : 'other');
  if (!animate) row.classList.add('instant');
  row.dataset.messageId = String(id);

  if (!mine) {
    const avatar = document.createElement('div');
    avatar.className = 'avatar sm';
    avatar.setAttribute('aria-hidden', 'true');
    paintAvatar(avatar, message.username || '?', message.user_id);
    row.appendChild(avatar);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  if (!mine) {
    const author = document.createElement('div');
    author.className = 'msg-author';
    author.textContent = message.username || 'Аноним';
    body.appendChild(author);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = typeof message.body === 'string' ? message.body : '';

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(createdAt);

  body.append(bubble, time);
  row.appendChild(body);
  els.messages.appendChild(row);

  scrollToBottom(animate);
}

function createDaySeparator(timestamp) {
  const separator = document.createElement('div');
  separator.className = 'day-sep';
  const label = document.createElement('span');
  label.textContent = formatDay(timestamp);
  separator.appendChild(label);
  return separator;
}

function scrollToBottom(animate) {
  requestAnimationFrame(() => {
    if (animate) {
      els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: 'smooth' });
    } else {
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  });
}

function autoResizeInput() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = Math.min(els.messageInput.scrollHeight, 150) + 'px';
}

/* ─────────────────────────── WebSocket ──────────────────────── */

function connectWs() {
  if (!state.token || state.manualClose) return;
  if (
    state.ws &&
    (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearTimeout(state.wsRetryTimer);
  state.wsRetryTimer = null;

  setConnection('connecting', 'Подключение…');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(state.token)}`;

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (_) {
    scheduleReconnect();
    return;
  }

  state.ws = socket;

  socket.addEventListener('open', () => {
    if (state.ws !== socket) return;
    setConnection('online', 'Онлайн');
    if (state.currentChatId) {
      subscribe(state.currentChatId);
    }
  });

  socket.addEventListener('message', (event) => {
    if (state.ws !== socket) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    handleWsEvent(payload);
  });

  socket.addEventListener('close', () => {
    if (state.ws === socket) state.ws = null;
    setConnection('offline', 'Не в сети');
    if (!state.manualClose && state.token) scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch (_) {
      // ignore
    }
  });
}

function scheduleReconnect() {
  clearTimeout(state.wsRetryTimer);
  state.wsRetryTimer = setTimeout(() => {
    state.wsRetryTimer = null;
    if (state.token && !state.manualClose) connectWs();
  }, WS_RECONNECT_DELAY);
}

function subscribe(chatId) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: 'subscribe', chat_id: Number(chatId) }));
}

function handleWsEvent(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.type === 'message') {
    if (Number(payload.chat_id) === Number(state.currentChatId)) {
      if (state.loadingMessages) {
        state.pendingMessages.push(payload);
      } else {
        appendMessage(payload, true);
      }
    }
    return;
  }

  if (payload.type === 'error' && payload.error) {
    toast(payload.error);
  }
}

function setConnection(status, text) {
  if (els.connDot) els.connDot.className = 'dot ' + status;
  if (els.connStatus) els.connStatus.textContent = text;
  if (els.profileConn) els.profileConn.textContent = text;
}

/* ─────────────────────────── Профиль ────────────────────────── */

function renderProfile() {
  paintAvatar(els.profileAvatar, state.username || '?', state.userId);
  paintAvatar(els.profileBtn, state.username || '?', state.userId);
  els.profileBtn.setAttribute('aria-label', 'Профиль: ' + (state.username || 'пользователь'));
  els.profileName.textContent = state.username || 'Пользователь';
  els.profileId.textContent = state.userId === null ? '—' : String(state.userId);
  els.profileHost.textContent = window.location.host;
}

function openProfileModal() {
  renderProfile();
  els.profileModal.classList.remove('hidden');
}

function closeProfileModal() {
  els.profileModal.classList.add('hidden');
}

/* ──────────────── Создание чата / вход по ID ───────────────── */

function openChatModal(mode) {
  state.chatModalMode = mode === 'join' ? 'join' : 'create';
  setChatModalError('');

  els.newChatName.value = '';
  els.joinChatId.value = '';
  updateChatModal();

  els.chatModal.classList.remove('hidden');
  setTimeout(() => {
    if (state.chatModalMode === 'create') {
      els.newChatName.focus();
    } else {
      els.joinChatId.focus();
    }
  }, 60);
}

function closeChatModal() {
  els.chatModal.classList.add('hidden');
  setChatModalError('');
}

function updateChatModal() {
  const create = state.chatModalMode === 'create';

  els.chatTabCreate.classList.toggle('active', create);
  els.chatTabJoin.classList.toggle('active', !create);
  els.chatTabCreate.setAttribute('aria-selected', String(create));
  els.chatTabJoin.setAttribute('aria-selected', String(!create));

  els.createField.classList.toggle('hidden', !create);
  els.joinField.classList.toggle('hidden', create);

  els.chatModalTitle.textContent = create ? 'Новый чат' : 'Войти по ID';
  els.chatModalSubtitle.textContent = create
    ? 'Придумайте название — участники смогут войти по ID.'
    : 'Введите ID существующего чата, чтобы присоединиться.';
  els.chatSubmit.textContent = create ? 'Создать чат' : 'Войти в чат';
}

async function handleChatModalSubmit(event) {
  event.preventDefault();
  setChatModalError('');

  const create = state.chatModalMode === 'create';
  let name = '';
  let chatId = 0;

  if (create) {
    name = els.newChatName.value.trim();
    if (!name) {
      setChatModalError('Введите название чата');
      els.newChatName.focus();
      return;
    }
  } else {
    const raw = els.joinChatId.value.trim();
    chatId = Number(raw);
    if (!raw || !Number.isSafeInteger(chatId) || chatId <= 0) {
      setChatModalError('Введите корректный числовой ID чата');
      els.joinChatId.focus();
      return;
    }
  }

  els.chatSubmit.disabled = true;
  const oldLabel = els.chatSubmit.textContent;
  els.chatSubmit.textContent = create ? 'Создаём…' : 'Входим…';

  try {
    if (create) {
      const data = await api('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      closeChatModal();
      await loadChats({ autoOpen: false });
      await openChat(data.chat_id);
    } else {
      await api(`/api/chats/${chatId}/join`, { method: 'POST' });
      closeChatModal();
      await loadChats({ autoOpen: false });
      await openChat(chatId);
    }
  } catch (error) {
    if (els.chatModal.classList.contains('hidden')) {
      toast(error.message);
    } else {
      setChatModalError(error.message);
    }
  } finally {
    els.chatSubmit.disabled = false;
    els.chatSubmit.textContent = oldLabel;
  }
}

/* ─────────────────────────── Ошибки/toast ───────────────────── */

function setAuthError(message) {
  els.authError.textContent = message || '';
  els.authError.classList.toggle('visible', Boolean(message));
}

function setChatModalError(message) {
  els.chatModalError.textContent = message || '';
  els.chatModalError.classList.toggle('visible', Boolean(message));
}

function toast(message) {
  if (!message) return;
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, 3200);
}

/* ─────────────────────────── Утилиты ────────────────────────── */

function paintAvatar(element, name, id) {
  if (!element) return;
  const source = String(name || '').trim();
  const characters = Array.from(source);
  element.textContent = characters.length ? characters[0].toUpperCase() : '#';

  const numericId = Math.abs(Number(id) || 0);
  const hue = (numericId * 47 + 205) % 360;
  element.style.background =
    `linear-gradient(135deg, hsl(${hue} 74% 72%), hsl(${(hue + 42) % 360} 70% 58%))`;
  element.style.color = '#11111b';
}

function pluralMembers(count) {
  const number = Math.max(0, Number(count) || 0);
  const mod10 = number % 10;
  const mod100 = number % 100;

  let word = 'участников';
  if (mod10 === 1 && mod100 !== 11) {
    word = 'участник';
  } else if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) {
    word = 'участника';
  }
  return `${number} ${word}`;
}

function dayKey(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) {
    const today = new Date();
    return `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  }
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return (
    String(date.getHours()).padStart(2, '0') +
    ':' +
    String(date.getMinutes()).padStart(2, '0')
  );
}

function formatDay(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const difference = Math.round((today - target) / 86400000);

  if (difference === 0) return 'Сегодня';
  if (difference === 1) return 'Вчера';

  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/* ─────────────────────────── События ────────────────────────── */

function bindEvents() {
  document.querySelectorAll('.auth-tab[data-mode]').forEach((tab) => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
  });

  els.authForm.addEventListener('submit', handleAuthSubmit);

  els.profileBtn.addEventListener('click', openProfileModal);
  els.logoutBtn.addEventListener('click', () => {
    logout();
    toast('Вы вышли из аккаунта');
  });

  els.newChatBtn.addEventListener('click', () => openChatModal('create'));
  els.joinChatBtn.addEventListener('click', () => openChatModal('join'));
  els.emptyNewChat.addEventListener('click', () => openChatModal('create'));

  els.chatTabCreate.addEventListener('click', () => {
    state.chatModalMode = 'create';
    updateChatModal();
    els.newChatName.focus();
  });
  els.chatTabJoin.addEventListener('click', () => {
    state.chatModalMode = 'join';
    updateChatModal();
    els.joinChatId.focus();
  });
  els.chatForm.addEventListener('submit', handleChatModalSubmit);

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.close === 'profile') {
        closeProfileModal();
      } else {
        closeChatModal();
      }
    });
  });

  [els.profileModal, els.chatModal].forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        if (modal === els.profileModal) {
          closeProfileModal();
        } else {
          closeChatModal();
        }
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeProfileModal();
      closeChatModal();
    }
  });

  els.messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage();
  });

  els.messageInput.addEventListener('input', autoResizeInput);
  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      els.messageForm.requestSubmit();
    }
  });

  els.backBtn.addEventListener('click', closeChat);
  els.chatSearch.addEventListener('input', renderChats);
  els.connStatus.addEventListener('click', () => {
    if (!state.manualClose && state.token) connectWs();
  });

  window.addEventListener('online', () => {
    if (state.token) connectWs();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token) {
      connectWs();
    }
  });
}
