'use strict';

/* ==========================================================================
   CipherTalk frontend — vanilla ES2022, no build step.
   ========================================================================== */

const $ = (id) => document.getElementById(id);

const state = {
  accessToken: null,
  tokenExpiresAt: 0,
  me: null,

  chats: [],
  chatsById: new Map(),
  activeChatId: null,
  activeChat: null,

  messages: new Map(),
  messageIndex: new Map(),
  hasMore: new Map(),

  ws: null,
  wsReady: false,
  wsRetry: 0,
  wsClosedByUs: false,
  subscribed: new Set(),

  refreshPromise: null,
  readTimer: null,
  lastTypingSent: 0,
  typingTimeout: null,
  replyTo: null,
  historyLoading: false,
  openSeq: 0,

  authMode: 'login',
  modalMode: 'dm',
  selectedMembers: new Map(),
  searchTimer: null,
  lastUserResults: [],

  chatFilter: '',

  notificationsEnabled: false,
  pushServerEnabled: false,
  pushPublicKey: null,
  pushSubscribed: false,
  pushEndpoint: null,
  upload: null,
  recording: null,
  profileAvatarBlob: null,
  call: null,
};

const AVATAR_COLORS = [
  '#2b5278',
  '#3d6b8f',
  '#4a6a86',
  '#5b4b85',
  '#84506f',
  '#2f7a6d',
  '#6b5b3e',
  '#4e6b3f',
];

const MAX_MESSAGE_LEN = 4096;

/* --------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function initials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorFor(seed) {
  const value = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatarFor(entity, size) {
  const name = entity?.display_name || entity?.title || entity?.username || '?';
  const node = el('div', size ? `avatar avatar-${size}` : 'avatar');
  node.textContent = initials(name);
  node.style.background = colorFor(entity?.id ?? name);
  node.title = name;
  if (entity?.avatar_url) {
    const img = el('img', 'avatar-img');
    img.src = entity.avatar_url;
    img.alt = '';
    img.loading = 'eager';
    img.decoding = 'async';
    img.fetchPriority = 'high';
    img.addEventListener('error', () => img.remove());
    node.append(img);
  }
  return node;
}

function plural(number, forms) {
  const n = Math.abs(number) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

const timeFmt = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});
const dayFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
});
const shortDayFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
});

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isSameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return timeFmt.format(date);
}

function formatChatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (isSameDay(date, now)) return timeFmt.format(date);
  if (isSameDay(date, new Date(now.getTime() - 86400000))) return 'Вчера';
  if (date.getFullYear() === now.getFullYear()) return shortDayFmt.format(date);
  return `${shortDayFmt.format(date)}.${String(date.getFullYear()).slice(-2)}`;
}

function formatDayLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (isSameDay(date, now)) return 'Сегодня';
  if (isSameDay(date, new Date(now.getTime() - 86400000))) return 'Вчера';
  const label = dayFmt.format(date);
  return date.getFullYear() === now.getFullYear()
    ? label
    : `${label} ${date.getFullYear()}`;
}

function formatLastSeen(iso) {
  if (!iso) return 'был(а) недавно';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'был(а) недавно';
  const diff = Date.now() - date.getTime();
  if (diff < 120000) return 'был(а) только что';
  if (diff < 3600000) {
    const minutes = Math.max(1, Math.floor(diff / 60000));
    return `был(а) ${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])} назад`;
  }
  const now = new Date();
  if (isSameDay(date, now)) return `был(а) сегодня в ${timeFmt.format(date)}`;
  if (isSameDay(date, new Date(now.getTime() - 86400000))) {
    return `был(а) вчера в ${timeFmt.format(date)}`;
  }
  return `был(а) ${shortDayFmt.format(date)}`;
}

function attachmentLabel(kind) {
  switch (kind) {
    case 'photo':
      return '📷 Фото';
    case 'video':
      return '🎬 Видео';
    case 'voice':
      return '🎤 Голосовое сообщение';
    case 'sticker':
      return '😀 Стикер';
    case 'file':
      return '📎 Файл';
    default:
      return '';
  }
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* --------------------------------------------------------------------------
   Session / API
   -------------------------------------------------------------------------- */
function applySession(payload) {
  state.accessToken = payload.access_token;
  state.tokenExpiresAt = Date.now() + Number(payload.expires_in || 900) * 1000;
  state.me = payload.user;
  try {
    localStorage.setItem('ct_has_session', '1');
  } catch {
    /* private mode */
  }
}

async function refreshAccessToken(force = false) {
  if (
    !force &&
    state.accessToken &&
    Date.now() < state.tokenExpiresAt - 30000
  ) {
    return;
  }
  if (state.refreshPromise) return state.refreshPromise;

  state.refreshPromise = (async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const error = new Error('session');
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    applySession(payload);
    return payload;
  })().finally(() => {
    state.refreshPromise = null;
  });

  return state.refreshPromise;
}

async function api(path, options = {}) {
  const {
    method = 'GET',
    body,
    auth = true,
    retry = true,
  } = options;

  const headers = { Accept: 'application/json' };
  if (auth && state.accessToken) {
    headers.Authorization = `Bearer ${state.accessToken}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Нет соединения с сервером');
  }

  if (response.status === 401 && auth && retry) {
    try {
      await refreshAccessToken(true);
    } catch {
      handleSessionExpired();
      throw new Error('Сессия истекла');
    }
    return api(path, { ...options, retry: false });
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload?.error?.message || `Ошибка запроса (${response.status})`;
    const error = new Error(message);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }

  return payload;
}

function handleSessionExpired() {
  if (!state.accessToken && !state.me) return;
  clearLocalSession();
  showAuth();
  setAuthError('Сессия истекла. Войдите снова.');
}

function clearLocalSession() {
  if (state.pushSubscribed || state.pushEndpoint) disablePush();
  cancelUpload();
  if (state.recording) stopRecording(false);
  closeCall(false);
  closeWs();
  state.pushSubscribed = false;
  state.pushEndpoint = null;
  $('notification-prompt').classList.add('hidden');
  try {
    localStorage.removeItem('ct_has_session');
  } catch {
    /* ignore */
  }
  state.accessToken = null;
  state.tokenExpiresAt = 0;
  state.me = null;
  state.chats = [];
  state.chatsById = new Map();
  state.activeChatId = null;
  state.activeChat = null;
  state.messages = new Map();
  state.messageIndex = new Map();
  state.hasMore = new Map();
  state.replyTo = null;
  state.wsRetry = 0;
  state.subscribed.clear();
  $('chat-list').replaceChildren();
  $('messages-inner').replaceChildren();
  $('conversation').classList.add('hidden');
  $('empty-state').classList.remove('hidden');
  document.body.classList.remove('chat-open');
  hideReply();
  hideTyping();
}

/* --------------------------------------------------------------------------
   Auth UI
   -------------------------------------------------------------------------- */
function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';
  $('auth-tabs').classList.toggle('register', isRegister);
  $('tab-login').classList.toggle('active', !isRegister);
  $('tab-register').classList.toggle('active', isRegister);
  $('tab-login').setAttribute('aria-selected', String(!isRegister));
  $('tab-register').setAttribute('aria-selected', String(isRegister));
  $('login-form').classList.toggle('hidden', isRegister);
  $('register-form').classList.toggle('hidden', !isRegister);
  setAuthError('');
  const target = isRegister ? $('register-username') : $('login-username');
  setTimeout(() => target?.focus(), 30);
}

function setAuthError(message) {
  const node = $('auth-error');
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}

function setBusy(button, busy, busyLabel) {
  button.disabled = busy;
  const label = button.querySelector('.btn-label');
  if (!label) return;
  if (!button.dataset.label) button.dataset.label = label.textContent;
  label.textContent = busy ? busyLabel : button.dataset.label;
}

async function submitLogin(event) {
  event.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  setAuthError('');
  if (!username || !password) {
    setAuthError('Введите username и пароль');
    return;
  }

  const button = $('login-submit');
  setBusy(button, true, 'Входим…');
  try {
    const payload = await api('/auth/login', {
      method: 'POST',
      auth: false,
      body: { username, password },
    });
    applySession(payload);
    $('login-password').value = '';
    await enterApp();
  } catch (error) {
    setAuthError(error.message);
  } finally {
    setBusy(button, false);
    updateSendState();
  }
}

async function submitRegister(event) {
  event.preventDefault();
  const username = $('register-username').value.trim().toLowerCase();
  const displayName = $('register-display-name').value.trim();
  const email = $('register-email').value.trim();
  const password = $('register-password').value;

  setAuthError('');
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    setAuthError('Username: 3–32 символа, только латиница, цифры и _');
    return;
  }
  if (!displayName || displayName.length > 64) {
    setAuthError('Укажите имя (до 64 символов)');
    return;
  }
  if (password.length < 8) {
    setAuthError('Пароль должен быть не короче 8 символов');
    return;
  }

  const button = $('register-submit');
  setBusy(button, true, 'Создаём…');
  try {
    const payload = await api('/auth/register', {
      method: 'POST',
      auth: false,
      body: {
        username,
        password,
        display_name: displayName,
        email: email || null,
      },
    });
    applySession(payload);
    $('register-password').value = '';
    await enterApp();
  } catch (error) {
    setAuthError(error.message);
  } finally {
    setBusy(button, false);
    updateSendState();
  }
}

async function logout() {
  const token = state.accessToken;
  await disablePush();
  closeWs();
  clearLocalSession();
  showAuth();
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
      });
    } catch {
      /* local logout is enough */
    }
  }
  toast('Вы вышли из аккаунта');
}

function showAuth() {
  $('app-screen').classList.add('hidden');
  $('auth-screen').classList.remove('hidden');
}

/* --------------------------------------------------------------------------
   Entering the app
   -------------------------------------------------------------------------- */
async function enterApp() {
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  renderProfile();
  await loadChats();
  connectWs();
  initPush();

  const requestedChat = Number(new URLSearchParams(location.search).get('chat'));
  if (Number.isFinite(requestedChat) && requestedChat > 0) {
    state.chatsById.has(requestedChat) && openChat(requestedChat);
  }
}

function renderProfile() {
  if (!state.me) return;
  $('profile-avatar').replaceChildren(avatarFor(state.me, 'sm'));
  $('profile-name').textContent = state.me.display_name || state.me.username;
  $('profile-username').textContent = `@${state.me.username}`;
}

function handleUserUpdated(user) {
  if (!user?.id) return;
  const isMe = user.id === state.me?.id;
  if (isMe) {
    state.me = { ...(state.me || {}), ...user };
    renderProfile();
    if (!$('profile-modal').classList.contains('hidden')) {
      $('profile-avatar-preview').replaceChildren(avatarFor(state.me, null));
    }
  }

  for (const chat of state.chats) {
    if (chat.peer?.id === user.id) {
      chat.peer = { ...chat.peer, ...user };
    }
  }
  if (state.activeChat?.peer?.id === user.id) {
    state.activeChat.peer = { ...state.activeChat.peer, ...user };
    renderChatHeader();
  }

  for (const [chatId, messages] of state.messages) {
    let changed = false;
    for (const message of messages) {
      if (message.sender?.id === user.id) {
        message.sender = { ...message.sender, ...user };
        changed = true;
      }
      if (message.reply_to?.sender_name === user.display_name) {
        message.reply_to.sender_name = user.display_name;
      }
    }
    if (changed && chatId === state.activeChatId) {
      renderMessages({ keepScroll: true });
    }
  }
  renderChatList();
}

/* --------------------------------------------------------------------------
   Chat list
   -------------------------------------------------------------------------- */
async function loadChats() {
  try {
    const data = await api('/chats?limit=100');
    state.chats = data?.items || [];
    state.chatsById = new Map(state.chats.map((chat) => [chat.id, chat]));

    if (state.activeChatId) {
      const summary = state.chatsById.get(state.activeChatId);
      if (summary) {
        state.activeChat = { ...(state.activeChat || {}), ...summary };
        renderChatHeader();
      } else {
        closeChat();
      }
    }

    renderChatList();
    updateUnreadTitle();
    if (state.wsReady) subscribeAllChats();
  } catch (error) {
    toast(error.message);
  }
}

function renderChatList() {
  const list = $('chat-list');
  list.replaceChildren();

  const filter = state.chatFilter.trim().toLowerCase();
  const chats = state.chats.filter((chat) => {
    if (!filter) return true;
    const title = chatTitle(chat).toLowerCase();
    const username = (chat.peer?.username || '').toLowerCase();
    return title.includes(filter) || username.includes(filter);
  });

  if (!chats.length) {
    const empty = el(
      'div',
      'chat-list-empty',
      filter
        ? 'Чаты не найдены'
        : 'Пока нет чатов. Нажмите «+», чтобы начать диалог.',
    );
    list.append(empty);
    return;
  }

  for (const chat of chats) {
    list.append(renderChatItem(chat));
  }
  updateUnreadTitle();
}

function chatTitle(chat) {
  return chat?.title || chat?.peer?.display_name || chat?.peer?.username || 'Чат';
}

function renderChatItem(chat) {
  const item = el('button', 'chat-item');
  item.type = 'button';
  if (chat.id === state.activeChatId) item.classList.add('active');

  item.append(avatarFor(
    {
      id: chat.kind === 'group' ? `group-${chat.id}` : chat.peer?.id || chat.id,
      display_name: chatTitle(chat),
      avatar_url: chat.kind === 'group' ? chat.avatar_url : chat.peer?.avatar_url,
    },
    null,
  ));

  const body = el('div', 'chat-body');
  const top = el('div', 'chat-row');
  top.append(el('div', 'chat-name', chatTitle(chat)));
  top.append(el('div', 'chat-time', formatChatTime(chat.last_message_at)));

  const previewRow = el('div', 'chat-preview-row');
  const preview = el('div', 'chat-preview');
  const last = chat.last_message;
  if (!last) {
    preview.textContent = 'Нет сообщений';
  } else if (last.is_deleted) {
    preview.textContent = 'Сообщение удалено';
  } else {
    if (chat.kind === 'group' && last.sender_name) {
      const sender = el(
        'span',
        'chat-sender',
        `${last.sender_name.split(' ')[0]}: `,
      );
      preview.append(sender);
    }
    const text = last.content ? last.content.replace(/\s+/g, ' ') : attachmentLabel(last.attachment_kind);
    preview.append(document.createTextNode(text));
  }
  previewRow.append(preview);

  if (chat.unread_count > 0) {
    previewRow.append(el('span', 'unread-badge', chat.unread_count > 99 ? '99+' : String(chat.unread_count)));
  }

  body.append(top, previewRow);
  item.append(body);
  item.addEventListener('click', () => openChat(chat.id));
  return item;
}

/* --------------------------------------------------------------------------
   Opening a chat
   -------------------------------------------------------------------------- */
async function openChat(chatId) {
  if (state.recording && state.activeChatId !== chatId) {
    stopRecording(false);
  }
  const isSame = state.activeChatId === chatId;
  document.body.classList.add('chat-open');

  if (isSame && state.activeChat) {
    $('message-input').focus();
    return;
  }

  state.activeChatId = chatId;
  state.replyTo = null;
  hideReply();
  hideTyping();
  clearTimeout(state.readTimer);

  const summary = state.chatsById.get(chatId);
  state.activeChat = summary ? { ...summary } : { id: chatId };
  state.activeChat.unread_count = 0;

  $('empty-state').classList.add('hidden');
  $('conversation').classList.remove('hidden');
  $('messages-inner').replaceChildren();
  renderChatHeader();
  renderChatList();
  updateSendState();
  subscribeChat(chatId);

  const seq = ++state.openSeq;
  try {
    const [details, page] = await Promise.all([
      api(`/chats/${chatId}`),
      api(`/chats/${chatId}/messages?limit=50`),
    ]);
    if (seq !== state.openSeq || state.activeChatId !== chatId) return;

    state.activeChat = { ...(summary || {}), ...details };
    state.messages.set(chatId, (page.items || []).map(normalizeMessage));
    rebuildMessageIndex(chatId);
    state.hasMore.set(chatId, Boolean(page.has_more));

    renderChatHeader();
    renderChatList();
    renderMessages({ toBottom: true });
    scheduleRead();
    $('message-input').focus();
  } catch (error) {
    if (seq !== state.openSeq) return;
    toast(error.message);
    closeChat();
  }
}

function closeChat() {
  state.openSeq += 1;
  state.activeChatId = null;
  state.activeChat = null;
  state.replyTo = null;
  clearTimeout(state.readTimer);
  hideTyping();
  hideReply();
  $('conversation').classList.add('hidden');
  $('empty-state').classList.remove('hidden');
  document.body.classList.remove('chat-open');
  if (state.recording) stopRecording(false);
  updateUnreadTitle();
  renderChatList();
  updateSendState();
}

function renderChatHeader() {
  const chat = state.activeChat;
  if (!chat) return;

  const title = chatTitle(chat);
  $('chat-title').textContent = title;
  updateUnreadTitle();

  $('chat-avatar').replaceChildren(avatarFor(
    {
      id: chat.kind === 'group' ? `group-${chat.id}` : chat.peer?.id || chat.id,
      display_name: title,
      avatar_url: chat.kind === 'group' ? chat.avatar_url : chat.peer?.avatar_url,
    },
    null,
  ));

  if (chat.kind === 'group') {
    const members = chat.members?.length ?? chat.member_count ?? 0;
    $('chat-subtitle').textContent = `${members} ${plural(members, ['участник', 'участника', 'участников'])}`;
    $('chat-subtitle').classList.remove('online');
    $('chat-meta').textContent = 'Группа';
  } else {
    $('chat-subtitle').textContent = formatLastSeen(chat.peer?.last_seen_at);
    $('chat-subtitle').classList.add('online');
    const actions = el('div', 'chat-actions');
    actions.append(
      callHeaderButton('audio', 'Аудиозвонок', () => startCall(false)),
      callHeaderButton('video', 'Видеозвонок', () => startCall(true)),
    );
    $('chat-meta').replaceChildren(actions);
  }
}

/* --------------------------------------------------------------------------
   Messages
   -------------------------------------------------------------------------- */
function normalizeMessage(message) {
  return {
    ...message,
    content: message?.content ?? '',
    is_deleted: Boolean(message?.is_deleted || message?.deleted_at),
  };
}

function rebuildMessageIndex(chatId) {
  const index = new Map();
  for (const message of state.messages.get(chatId) || []) {
    index.set(message.id, message);
  }
  state.messageIndex.set(chatId, index);
}

function compareMessages(a, b) {
  const aNumeric = typeof a.id === 'number';
  const bNumeric = typeof b.id === 'number';
  if (aNumeric && bNumeric) return a.id - b.id;
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

function addMessage(chatId, message, options = {}) {
  const normalized = normalizeMessage(message);
  let index = state.messageIndex.get(chatId);
  if (!index) {
    index = new Map();
    state.messageIndex.set(chatId, index);
  }
  const existing = index.get(normalized.id);
  if (existing) {
    Object.assign(existing, normalized);
    return existing;
  }

  let list = state.messages.get(chatId);
  if (!list) {
    list = [];
    state.messages.set(chatId, list);
  }
  list.push(normalized);
  list.sort(compareMessages);
  index.set(normalized.id, normalized);

  if (options.scroll !== false && state.activeChatId === chatId) {
    // caller decides about DOM updates
  }
  return normalized;
}

function removeMessage(chatId, messageId) {
  const list = state.messages.get(chatId);
  if (list) {
    const index = list.findIndex((message) => message.id === messageId);
    if (index >= 0) list.splice(index, 1);
  }
  state.messageIndex.get(chatId)?.delete(messageId);
}

function findMessage(chatId, messageId) {
  return state.messageIndex.get(chatId)?.get(messageId) || null;
}

function isNearBottom(container) {
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight < 120
  );
}

function scrollToBottom(smooth = false) {
  const container = $('messages');
  container.scrollTo({
    top: container.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  });
}

function renderMessages({ toBottom = false, keepScroll = false } = {}) {
  const chatId = state.activeChatId;
  if (!chatId) return;

  const container = $('messages');
  const previousHeight = container.scrollHeight;
  const previousTop = container.scrollTop;
  const wasNearBottom = isNearBottom(container);

  const list = state.messages.get(chatId) || [];
  const inner = $('messages-inner');
  inner.replaceChildren();

  if (!list.length) {
    inner.append(
      el('div', 'chat-empty', 'Сообщений пока нет. Напишите первым!'),
    );
  } else {
    let previousDay = null;
    const fragment = document.createDocumentFragment();
    for (const message of list) {
      const date = new Date(message.created_at);
      if (
        !previousDay ||
        !isSameDay(previousDay, date)
      ) {
        fragment.append(el('div', 'date-separator', formatDayLabel(message.created_at)));
        previousDay = date;
      }
      fragment.append(buildMessageNode(message));
    }
    inner.append(fragment);
  }

  if (toBottom || wasNearBottom) {
    scrollToBottom();
  } else if (keepScroll) {
    container.scrollTop = previousTop + (container.scrollHeight - previousHeight);
  }
}

function isReadByOthers(messageId) {
  const members = state.activeChat?.members || [];
  const others = members.filter((member) => member.user.id !== state.me?.id);
  if (!others.length) return false;
  return others.every(
    (member) => (member.last_read_message_id || 0) >= messageId,
  );
}

function canDeleteMessage(message) {
  if (message.sender?.id === state.me?.id) return true;
  return (
    state.activeChat?.kind === 'group' &&
    ['owner', 'admin'].includes(state.activeChat?.my_role)
  );
}

function callHeaderButton(kind, title, handler) {
  const button = el('button', 'icon-btn');
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML =
    kind === 'video'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z"/></svg>';
  button.addEventListener('click', handler);
  return button;
}

function buildMessageNode(message) {
  const own = message.sender?.id === state.me?.id;
  const row = el('div', `msg-row ${own ? 'own' : 'other'}`);
  row.dataset.id = String(message.id);

  const isSticker = message.attachment?.kind === 'sticker';
  const isPhotoOrVideo =
    message.attachment &&
    (message.attachment.kind === 'photo' || message.attachment.kind === 'video');
  const bubble = el(
    'div',
    isSticker ? 'bubble sticker-bubble' : isPhotoOrVideo ? 'bubble media-bubble' : 'bubble',
  );

  if (message.reply_to) {
    const reply = el('div', 'msg-reply');
    reply.append(
      el('span', 'msg-reply-name', message.reply_to.sender_name || 'Сообщение'),
    );
    const replyText = message.reply_to.is_deleted
      ? 'Сообщение удалено'
      : message.reply_to.content || 'Вложение';
    reply.append(el('span', 'msg-reply-text', replyText));
    bubble.append(reply);
  }

  if (!own && state.activeChat?.kind === 'group' && !message.is_deleted) {
    bubble.append(el('div', 'msg-sender', message.sender?.display_name || 'Удалённый пользователь'));
  }

  if (message.attachment && !message.is_deleted) {
    bubble.append(buildAttachmentNode(message.attachment));
  }

  if (message.is_deleted) {
    bubble.append(el('div', 'msg-text deleted', 'Сообщение удалено'));
  } else if (message.content) {
    bubble.append(
      el(
        'div',
        message.attachment ? 'msg-caption' : 'msg-text',
        message.content,
      ),
    );
  }

  const meta = el('div', 'msg-meta');
  meta.append(el('span', 'msg-time', formatTime(message.created_at)));
  if (message.edited_at && !message.is_deleted) {
    meta.append(el('span', 'msg-edited', 'изм.'));
  }
  if (own) {
    const status = el('span', 'msg-status');
    if (message._pending) {
      status.classList.add('pending');
      status.textContent = '…';
      status.title = 'Отправляется';
    } else if (message._failed) {
      status.classList.add('failed');
      status.textContent = '!';
      status.title = 'Не отправлено';
    } else {
      const read = isReadByOthers(message.id);
      status.textContent = read ? '✓✓' : '✓';
      status.classList.toggle('read', read);
      status.title = read ? 'Прочитано' : 'Отправлено';
    }
    meta.append(status);
  }
  bubble.append(meta);

  const actions = el('div', 'msg-actions');
  if (!message.is_deleted && !message._pending && !message._failed) {
    actions.append(actionButton('↩', 'Ответить', () => setReply(message)));
    if (own) {
      actions.append(actionButton('✎', 'Редактировать', () => startEdit(message, bubble)));
    }
    if (canDeleteMessage(message)) {
      actions.append(actionButton('🗑', 'Удалить', () => deleteMessage(message)));
    }
  }

  if (own) {
    row.append(actions, bubble);
  } else {
    row.append(bubble, actions);
  }

  return row;
}

function buildAttachmentNode(attachment) {
  switch (attachment.kind) {
    case 'photo': {
      const img = el('img', 'msg-photo');
      img.src = attachment.thumbnail_url || attachment.content_url;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = attachment.file_name || 'Фото';
      img.addEventListener('click', (event) => {
        event.stopPropagation();
        openImageViewer(attachment.content_url);
      });
      const wrap = el('div', 'msg-media');
      wrap.append(img);
      return wrap;
    }
    case 'video': {
      const video = el('video', 'msg-video');
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.src = attachment.content_url;
      if (attachment.thumbnail_url) video.poster = attachment.thumbnail_url;
      const wrap = el('div', 'msg-media');
      wrap.append(video);
      return wrap;
    }
    case 'voice':
      return buildVoiceNode(attachment);
    case 'sticker': {
      const img = el('img', 'msg-sticker');
      img.src = attachment.content_url;
      img.alt = 'Стикер';
      img.loading = 'lazy';
      img.addEventListener('click', (event) => {
        event.stopPropagation();
        openImageViewer(attachment.content_url);
      });
      return img;
    }
    case 'file':
    default: {
      const link = el('a', 'file-card');
      link.href = attachment.content_url;
      link.download = attachment.file_name;
      link.append(el('span', 'file-icon', '📄'));
      const meta = el('div', 'file-meta');
      meta.append(el('div', 'file-name', attachment.file_name));
      meta.append(el('div', 'file-size', formatBytes(attachment.size_bytes)));
      link.append(meta);
      link.addEventListener('click', (event) => event.stopPropagation());
      return link;
    }
  }
}

function buildVoiceNode(attachment) {
  const wrap = el('div', 'voice-message');
  const play = el('button', 'voice-play', '▶');
  play.type = 'button';
  play.setAttribute('aria-label', 'Воспроизвести голосовое');

  const main = el('div', 'voice-main');
  const wave = el('div', 'voice-wave');
  const bars = [];
  const count = 24;
  for (let i = 0; i < count; i += 1) {
    const bar = el('i');
    const height = 5 + ((Number(attachment.id) * 13 + i * 17) % 16);
    bar.style.height = `${height}px`;
    bars.push(bar);
    wave.append(bar);
  }
  const duration = el(
    'div',
    'voice-duration',
    formatDuration((attachment.duration_ms || 0) / 1000),
  );
  main.append(wave, duration);

  const audio = el('audio');
  audio.src = attachment.content_url;
  audio.preload = 'metadata';
  audio.hidden = true;

  audio.addEventListener('play', () => {
    document.querySelectorAll('audio[data-voice-playing]').forEach((other) => {
      if (other !== audio) other.pause();
    });
    audio.dataset.voicePlaying = '1';
    play.textContent = '❚❚';
  });
  audio.addEventListener('pause', () => {
    delete audio.dataset.voicePlaying;
    play.textContent = '▶';
  });
  audio.addEventListener('ended', () => {
    play.textContent = '▶';
    bars.forEach((bar) => bar.classList.remove('played'));
  });
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      duration.textContent = formatDuration(audio.duration);
    }
  });
  audio.addEventListener('timeupdate', () => {
    const total = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (attachment.duration_ms || 0) / 1000;
    const fraction = total > 0 ? Math.min(1, audio.currentTime / total) : 0;
    const played = Math.floor(fraction * count);
    bars.forEach((bar, index) => bar.classList.toggle('played', index < played));
  });

  play.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        toast('Не удалось воспроизвести аудио');
      }
    } else {
      audio.pause();
    }
  });
  wave.addEventListener('click', (event) => {
    event.stopPropagation();
    const rect = wave.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const total = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (attachment.duration_ms || 0) / 1000;
    if (total > 0) audio.currentTime = fraction * total;
  });

  wrap.append(play, main, audio);
  return wrap;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function openImageViewer(url) {
  const viewer = $('image-viewer');
  $('viewer-img').src = url;
  viewer.classList.remove('hidden');
}

function closeImageViewer() {
  $('image-viewer').classList.add('hidden');
  $('viewer-img').removeAttribute('src');
}

function actionButton(label, title, handler) {
  const button = el('button', 'msg-action', label);
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    handler();
  });
  return button;
}

/* --------------------------------------------------------------------------
   Reply / edit / delete
   -------------------------------------------------------------------------- */
function setReply(message) {
  state.replyTo = message;
  const banner = $('reply-banner');
  const text = $('reply-text');
  const name = message.sender?.display_name || 'Сообщение';
  const body = message.is_deleted
    ? 'Сообщение удалено'
    : message.content || attachmentLabel(message.attachment?.kind) || 'Вложение';
  text.textContent = `${name}: ${body}`;
  banner.classList.remove('hidden');
  $('message-input').focus();
}

function hideReply() {
  state.replyTo = null;
  $('reply-banner').classList.add('hidden');
  $('reply-text').textContent = '';
}

function startEdit(message, bubble) {
  const original = message.content;
  bubble.replaceChildren();

  const box = el('div', 'edit-box');
  const textarea = el('textarea', 'edit-textarea');
  textarea.value = original;
  textarea.maxLength = MAX_MESSAGE_LEN;

  const actions = el('div', 'edit-actions');
  const cancel = el('button', '', 'Отмена');
  cancel.type = 'button';
  const save = el('button', 'save', 'Сохранить');
  save.type = 'button';

  cancel.addEventListener('click', () => renderMessages({ keepScroll: true }));
  save.addEventListener('click', async () => {
    const content = textarea.value;
    if (!content.trim() && !message.attachment) {
      toast('Сообщение не может быть пустым');
      return;
    }
    save.disabled = true;
    try {
      const updated = await api(`/messages/${message.id}`, {
        method: 'PATCH',
        body: { content },
      });
      removeMessage(message.chat_id, message.id);
      addMessage(message.chat_id, updated);
      renderMessages({ keepScroll: true });
      updateChatPreviewFromMessage(message.chat_id, updated);
    } catch (error) {
      toast(error.message);
      save.disabled = false;
    }
  });

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save.click();
    } else if (event.key === 'Escape') {
      cancel.click();
    }
  });

  actions.append(cancel, save);
  box.append(textarea, actions);
  bubble.append(box);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function deleteMessage(message) {
  if (!window.confirm('Удалить сообщение?')) return;
  try {
    const updated = await api(`/messages/${message.id}`, { method: 'DELETE' });
    const local = findMessage(message.chat_id, message.id);
    if (local) Object.assign(local, normalizeMessage(updated));
    if (state.activeChatId === message.chat_id) {
      renderMessages({ keepScroll: true });
    }
    updateChatPreviewFromMessage(message.chat_id, normalizeMessage(updated));
  } catch (error) {
    toast(error.message);
  }
}

/* --------------------------------------------------------------------------
   Sending
   -------------------------------------------------------------------------- */
function updateSendState() {
  const input = $('message-input');
  if (!input) return;
  $('send-btn').disabled =
    !input.value.trim() || !state.activeChatId || state.historyLoading;
}

async function sendMessage(event) {
  event?.preventDefault();
  const input = $('message-input');
  if (!state.activeChatId) return;

  const raw = input.value;
  const content = raw.trim();
  if (!content) return;
  if ([...content].length > MAX_MESSAGE_LEN) {
    toast(`Сообщение не должно превышать ${MAX_MESSAGE_LEN} символов`);
    return;
  }

  const chatId = state.activeChatId;
  const reply = state.replyTo;
  const tempId = `tmp-${makeId()}`;
  const temp = {
    id: tempId,
    chat_id: chatId,
    sender: {
      id: state.me.id,
      username: state.me.username,
      display_name: state.me.display_name,
      avatar_url: state.me.avatar_url,
    },
    content,
    reply_to: reply
      ? {
          id: reply.id,
          sender_name: reply.sender?.display_name || null,
          content: reply.content,
          is_deleted: Boolean(reply.is_deleted),
        }
      : null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    is_deleted: false,
    _pending: true,
    _replyToId: reply?.id ?? null,
  };

  addMessage(chatId, temp);
  renderMessages({ toBottom: true });
  input.value = '';
  autoResizeInput();
  hideReply();
  updateSendState();
  input.focus();

  try {
    const saved = await api(`/chats/${chatId}/messages`, {
      method: 'POST',
      body: {
        content,
        reply_to_id: temp._replyToId,
      },
    });
    removeMessage(chatId, tempId);
    addMessage(chatId, saved);

    const localChat = state.chatsById.get(chatId);
    if (localChat) {
      localChat.last_read_message_id = Math.max(
        localChat.last_read_message_id || 0,
        saved.id,
      );
      localChat.unread_count = 0;
    }
    if (state.activeChatId === chatId) {
      state.activeChat.last_read_message_id = Math.max(
        state.activeChat.last_read_message_id || 0,
        saved.id,
      );
      const meMember = state.activeChat.members?.find(
        (member) => member.user.id === state.me.id,
      );
      if (meMember) {
        meMember.last_read_message_id = Math.max(
          meMember.last_read_message_id || 0,
          saved.id,
        );
      }
      renderMessages({ toBottom: true });
    }
    updateChatPreviewFromMessage(chatId, saved, { force: true });
  } catch (error) {
    removeMessage(chatId, tempId);
    if (state.activeChatId === chatId) renderMessages({ keepScroll: true });
    input.value = raw;
    autoResizeInput();
    updateSendState();
    toast(error.message);
  }
}

function updateChatPreviewFromMessage(chatId, message, { force = false } = {}) {
  const chat = state.chatsById.get(chatId);
  if (!chat) return;
  if (!force && chat.last_message && chat.last_message.id !== message.id) {
    return;
  }

  chat.last_message = {
    id: message.id,
    content: message.is_deleted ? '' : message.content,
    sender_name: message.sender?.display_name || null,
    attachment_kind: message.attachment?.kind || null,
    created_at: message.created_at,
    is_deleted: Boolean(message.is_deleted),
  };
  chat.last_message_at = message.created_at;
  if (message.sender?.id === state.me?.id) {
    chat.last_read_message_id = Math.max(
      chat.last_read_message_id || 0,
      typeof message.id === 'number' ? message.id : 0,
    );
  }
  state.chats = [chat, ...state.chats.filter((item) => item.id !== chatId)];
  renderChatList();
}

/* --------------------------------------------------------------------------
   Read receipts + typing
   -------------------------------------------------------------------------- */
function scheduleRead() {
  const chatId = state.activeChatId;
  if (!chatId) return;
  const list = state.messages.get(chatId) || [];
  const last = [...list]
    .reverse()
    .find((message) => typeof message.id === 'number');
  if (!last) return;

  const current = state.activeChat?.last_read_message_id || 0;
  if (current >= last.id) return;

  clearTimeout(state.readTimer);
  state.readTimer = setTimeout(() => markRead(last.id), 450);
}

async function markRead(messageId) {
  const chatId = state.activeChatId;
  if (!chatId) return;

  updateLocalRead(chatId, messageId);

  if (state.wsReady && sendWs({ type: 'read', chat_id: chatId, message_id: messageId })) {
    return;
  }

  try {
    await api(`/chats/${chatId}/read`, {
      method: 'POST',
      body: { message_id: messageId },
    });
  } catch {
    /* read receipts are best-effort */
  }
}

function updateLocalRead(chatId, messageId) {
  if (state.activeChatId === chatId && state.activeChat) {
    state.activeChat.last_read_message_id = Math.max(
      state.activeChat.last_read_message_id || 0,
      messageId,
    );
    const member = state.activeChat.members?.find(
      (item) => item.user.id === state.me?.id,
    );
    if (member) {
      member.last_read_message_id = Math.max(
        member.last_read_message_id || 0,
        messageId,
      );
    }
  }
  const chat = state.chatsById.get(chatId);
  if (chat) {
    chat.last_read_message_id = Math.max(
      chat.last_read_message_id || 0,
      messageId,
    );
    if (state.activeChatId === chatId) chat.unread_count = 0;
  }
  if (state.activeChatId === chatId) {
    renderMessages({ keepScroll: true });
    renderChatList();
  }
}

function sendTypingThrottled() {
  if (!state.activeChatId || !state.wsReady) return;
  const now = Date.now();
  if (now - state.lastTypingSent < 2800) return;
  state.lastTypingSent = now;
  sendWs({ type: 'typing', chat_id: state.activeChatId });
}

function showTyping(name) {
  const node = $('typing-indicator');
  node.replaceChildren();
  node.append(document.createTextNode(`${name} печатает`));
  const dots = el('span');
  dots.append(el('i'), el('i'), el('i'));
  node.append(dots);
  node.classList.remove('hidden');
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(hideTyping, 3500);
}

function hideTyping() {
  clearTimeout(state.typingTimeout);
  const node = $('typing-indicator');
  node.classList.add('hidden');
  node.replaceChildren();
}

/* --------------------------------------------------------------------------
   WebSocket
   -------------------------------------------------------------------------- */
function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws?token=${encodeURIComponent(state.accessToken)}`;
}

function connectWs() {
  if (!state.accessToken) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  state.wsClosedByUs = false;
  setConnection('connecting');

  const socket = new WebSocket(wsUrl());
  state.ws = socket;
  state.subscribed.clear();

  socket.addEventListener('open', () => {
    if (state.ws !== socket) return;
    state.wsReady = true;
    state.wsRetry = 0;
    setConnection('online');
    subscribeAllChats();
    catchUpActiveChat();
    loadChats();
  });

  socket.addEventListener('message', (event) => {
    if (state.ws !== socket) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleWsEvent(payload);
  });

  socket.addEventListener('close', () => {
    if (state.ws !== socket) return;
    state.ws = null;
    state.wsReady = false;
    state.subscribed.clear();
    if (state.call) closeCall(false);
    setConnection('offline');
    if (state.wsClosedByUs) return;

    const attempt = state.wsRetry++;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    setTimeout(async () => {
      if (state.wsClosedByUs || !state.accessToken) return;
      try {
        // A forced rotation also detects a session revoked in another tab.
        await refreshAccessToken(true);
      } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
          handleSessionExpired();
          return;
        }
        /* transient network error: retry with the current token */
      }
      connectWs();
    }, delay);
  });

  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}

function closeWs() {
  state.wsClosedByUs = true;
  state.wsReady = false;
  state.subscribed.clear();
  if (state.ws) {
    try {
      state.ws.close(1000, 'logout');
    } catch {
      /* ignore */
    }
    state.ws = null;
  }
  setConnection('offline');
}

function setConnection(status) {
  const node = $('connection-status');
  node.classList.remove('online', 'offline', 'connecting');
  node.classList.add(status);
  node.title =
    status === 'online'
      ? 'Соединение установлено'
      : status === 'connecting'
        ? 'Подключение…'
        : 'Нет соединения';
}

function sendWs(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  try {
    state.ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function subscribeChat(chatId) {
  if (!state.wsReady || state.subscribed.has(chatId)) return;
  if (sendWs({ type: 'subscribe', chat_id: chatId })) {
    state.subscribed.add(chatId);
  }
}

function subscribeAllChats() {
  for (const chat of state.chats) subscribeChat(chat.id);
  if (state.activeChatId) subscribeChat(state.activeChatId);
}

function handleWsEvent(event) {
  switch (event.type) {
    case 'message.new':
      handleIncomingMessage(event.message);
      break;
    case 'message.edited':
      handleEditedMessage(event.message);
      break;
    case 'message.deleted':
      handleDeletedMessage(event.chat_id, event.message_id);
      break;
    case 'typing':
      if (
        event.chat_id === state.activeChatId &&
        event.user_id !== state.me?.id
      ) {
        showTyping(event.display_name || 'Кто-то');
      }
      break;
    case 'read.updated':
      handleReadUpdated(event);
      break;
    case 'chat.removed':
      removeChatLocally(event.chat_id);
      toast('Вы больше не участник этого чата');
      break;
    case 'user.updated':
      handleUserUpdated(event.user);
      break;
    case 'call.offer':
      handleCallOffer(event);
      break;
    case 'call.answer':
      handleCallAnswer(event);
      break;
    case 'call.ice':
      handleCallIce(event);
      break;
    case 'call.end':
      handleCallEnd(event);
      break;
    case 'error':
      if (event.code !== 'not_subscribed') {
        toast(event.message || 'Ошибка realtime');
      }
      break;
    default:
      break;
  }
}

function handleIncomingMessage(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return;
  const message = normalizeMessage(rawMessage);
  const chatId = message.chat_id;
  let chat = state.chatsById.get(chatId);

  if (!chat) {
    loadChats();
    return;
  }

  // The optimistic copy is superseded by the server echo.
  if (message.sender?.id === state.me?.id) {
    const list = state.messages.get(chatId) || [];
    const pending = list.find(
      (item) =>
        item._pending &&
        item.content === message.content &&
        item._replyToId === (message.reply_to?.id ?? null),
    );
    if (pending) removeMessage(chatId, pending.id);
  }

  const existed = Boolean(findMessage(chatId, message.id));
  addMessage(chatId, message);

  const isActive = state.activeChatId === chatId;
  const nearBottom = isActive ? isNearBottom($('messages')) : false;
  if (isActive) {
    renderMessages({ keepScroll: !nearBottom });
    if (message.sender?.id === state.me?.id) {
      scrollToBottom();
      updateLocalRead(chatId, message.id);
    } else if (nearBottom) {
      scrollToBottom();
    }
    hideTyping();
    if (document.visibilityState === 'visible' && nearBottom) scheduleRead();
  }

  if (!existed) {
    notifyMessage(message);
    updateChatPreviewFromMessage(chatId, message, { force: true });
    if (isActive) {
      if (nearBottom) {
        const current = state.chatsById.get(chatId);
        if (current) current.unread_count = 0;
      }
    } else if (message.sender?.id !== state.me?.id) {
      chat.unread_count = (chat.unread_count || 0) + 1;
      renderChatList();
    }
  }
}

function handleEditedMessage(rawMessage) {
  const message = normalizeMessage(rawMessage);
  const local = findMessage(message.chat_id, message.id);
  if (local) Object.assign(local, message);
  if (state.activeChatId === message.chat_id) {
    renderMessages({ keepScroll: true });
  }
  updateChatPreviewFromMessage(message.chat_id, message);
}

function handleDeletedMessage(chatId, messageId) {
  const local = findMessage(chatId, messageId);
  if (local) {
    local.is_deleted = true;
    local.content = '';
    local.deleted_at = new Date().toISOString();
  }
  if (state.activeChatId === chatId) {
    renderMessages({ keepScroll: true });
  }
  const chat = state.chatsById.get(chatId);
  if (chat?.last_message?.id === messageId) {
    chat.last_message = {
      ...chat.last_message,
      content: '',
      is_deleted: true,
    };
    renderChatList();
  }
}

function handleReadUpdated(event) {
  if (state.activeChatId === event.chat_id && state.activeChat) {
    const member = state.activeChat.members?.find(
      (item) => item.user.id === event.user_id,
    );
    if (member) {
      member.last_read_message_id = Math.max(
        member.last_read_message_id || 0,
        event.message_id,
      );
    }
    if (event.user_id === state.me?.id) {
      state.activeChat.last_read_message_id = Math.max(
        state.activeChat.last_read_message_id || 0,
        event.message_id,
      );
    }
    renderMessages({ keepScroll: true });
  }
}

function removeChatLocally(chatId) {
  const wasActive = state.activeChatId === chatId;
  state.chats = state.chats.filter((chat) => chat.id !== chatId);
  state.chatsById.delete(chatId);
  state.messages.delete(chatId);
  state.messageIndex.delete(chatId);
  state.hasMore.delete(chatId);
  state.subscribed.delete(chatId);
  if (wasActive) closeChat();
  renderChatList();
}

async function catchUpActiveChat() {
  const chatId = state.activeChatId;
  if (!chatId) return;
  const list = state.messages.get(chatId) || [];
  const last = [...list]
    .reverse()
    .find((message) => typeof message.id === 'number');

  try {
    if (!last) {
      const data = await api(`/chats/${chatId}/messages?limit=50`);
      if (state.activeChatId !== chatId) return;
      for (const item of data.items || []) addMessage(chatId, normalizeMessage(item));
      state.hasMore.set(chatId, Boolean(data.has_more));
      renderMessages({ toBottom: true });
      scheduleRead();
      return;
    }

    let after = last.id;
    for (let page = 0; page < 5; page += 1) {
      const data = await api(
        `/chats/${chatId}/messages?limit=100&after_id=${after}`,
      );
      if (state.activeChatId !== chatId) return;
      const items = (data.items || []).map(normalizeMessage);
      if (!items.length) break;
      for (const item of items) addMessage(chatId, item);
      after = items[items.length - 1].id;
      if (!data.has_more) break;
    }
    renderMessages({ toBottom: true });
    scheduleRead();
  } catch {
    /* will be recovered by the next reconnect or chat open */
  }
}

/* --------------------------------------------------------------------------
   History pagination
   -------------------------------------------------------------------------- */
async function loadOlderMessages() {
  const chatId = state.activeChatId;
  if (!chatId || state.historyLoading || !state.hasMore.get(chatId)) return;

  const list = state.messages.get(chatId) || [];
  const oldest = list.find((message) => typeof message.id === 'number');
  if (!oldest) return;

  state.historyLoading = true;
  $('history-loader').classList.remove('hidden');
  updateSendState();

  try {
    const data = await api(
      `/chats/${chatId}/messages?limit=50&before_id=${oldest.id}`,
    );
    if (state.activeChatId !== chatId) return;
    for (const item of data.items || []) addMessage(chatId, item);
    state.hasMore.set(chatId, Boolean(data.has_more));
    renderMessages({ keepScroll: true });
  } catch (error) {
    toast(error.message);
  } finally {
    state.historyLoading = false;
    $('history-loader').classList.add('hidden');
    updateSendState();
  }
}

/* --------------------------------------------------------------------------
   New chat modal
   -------------------------------------------------------------------------- */
function openNewChatModal() {
  $('new-chat-modal').classList.remove('hidden');
  $('user-search').value = '';
  $('group-title').value = '';
  state.selectedMembers.clear();
  setModalMode('dm');
  renderSelectedMembers();
  renderUserResults([]);
  setTimeout(() => $('user-search').focus(), 50);
}

function closeNewChatModal() {
  $('new-chat-modal').classList.add('hidden');
  clearTimeout(state.searchTimer);
}

function setModalMode(mode) {
  state.modalMode = mode;
  const isGroup = mode === 'group';
  $('modal-tab-dm').classList.toggle('active', !isGroup);
  $('modal-tab-group').classList.toggle('active', isGroup);
  $('group-fields').classList.toggle('hidden', !isGroup);
  $('group-actions').classList.toggle('hidden', !isGroup);
  renderUserResults(state.lastUserResults || []);
  updateCreateGroupState();
}

function renderSelectedMembers() {
  const container = $('selected-members');
  container.replaceChildren();
  for (const user of state.selectedMembers.values()) {
    const chip = el('div', 'selected-chip');
    chip.append(el('span', '', user.display_name));
    const remove = el('button', '', '✕');
    remove.type = 'button';
    remove.title = 'Убрать';
    remove.addEventListener('click', () => toggleMember(user));
    chip.append(remove);
    container.append(chip);
  }
  updateCreateGroupState();
}

function updateCreateGroupState() {
  const title = $('group-title').value.trim();
  $('create-group-btn').disabled = !title || state.selectedMembers.size === 0;
}

function toggleMember(user) {
  if (state.selectedMembers.has(user.id)) {
    state.selectedMembers.delete(user.id);
  } else {
    state.selectedMembers.set(user.id, user);
  }
  renderSelectedMembers();
  renderUserResults(state.lastUserResults || []);
}

function renderUserResults(users) {
  state.lastUserResults = users;
  const container = $('user-results');
  container.replaceChildren();

  if (!users.length) {
    const query = $('user-search').value.trim();
    container.append(
      el(
        'div',
        'user-results-empty',
        query.length >= 2
          ? 'Пользователи не найдены'
          : 'Введите минимум 2 символа username',
      ),
    );
    return;
  }

  for (const user of users) {
    const button = el('button', 'user-result');
    button.type = 'button';
    const selected = state.selectedMembers.has(user.id);
    if (selected) button.classList.add('selected');
    button.append(
      avatarFor(
        { id: user.id, display_name: user.display_name },
        'sm',
      ),
    );

    const info = el('div', 'user-result-info');
    info.append(el('div', 'user-result-name', user.display_name));
    info.append(el('div', 'user-result-username', `@${user.username}`));
    button.append(info);

    const action = el(
      'span',
      'user-result-action',
      state.modalMode === 'group' ? (selected ? '✓' : '+') : '→',
    );
    button.append(action);

    button.addEventListener('click', async () => {
      if (state.modalMode === 'group') {
        toggleMember(user);
      } else {
        await createPrivateChat(user.id);
      }
    });

    container.append(button);
  }
}

async function searchUsers(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    renderUserResults([]);
    return;
  }
  try {
    const users = await api(`/users/search?q=${encodeURIComponent(trimmed)}`);
    renderUserResults(users || []);
  } catch (error) {
    toast(error.message);
  }
}

async function createPrivateChat(userId) {
  try {
    const chat = await api('/chats/private', {
      method: 'POST',
      body: { user_id: userId },
    });
    closeNewChatModal();
    await loadChats();
    await openChat(chat.id);
  } catch (error) {
    toast(error.message);
  }
}

async function createGroupChat() {
  const title = $('group-title').value.trim();
  if (!title) {
    toast('Укажите название группы');
    return;
  }
  if (!state.selectedMembers.size) {
    toast('Добавьте хотя бы одного участника');
    return;
  }

  const button = $('create-group-btn');
  button.disabled = true;
  try {
    const chat = await api('/chats/group', {
      method: 'POST',
      body: {
        title,
        member_ids: [...state.selectedMembers.keys()],
      },
    });
    closeNewChatModal();
    await loadChats();
    await openChat(chat.id);
  } catch (error) {
    toast(error.message);
  } finally {
    updateCreateGroupState();
  }
}

/* --------------------------------------------------------------------------
   Inputs, toast, misc UI
   -------------------------------------------------------------------------- */
function autoResizeInput() {
  const input = $('message-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 4200);
}


/* --------------------------------------------------------------------------
   Media upload, avatars, notifications
   -------------------------------------------------------------------------- */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;

function guessMime(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4',
    webm: 'video/webm', mov: 'video/quicktime', ogg: 'audio/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  };
  return map[ext] || 'application/octet-stream';
}

function withMime(file, mime) {
  if (file.type === mime) return file;
  return new File([file], file.name, { type: mime });
}

function canvasBlob(canvas, type = 'image/jpeg', quality = 0.86) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob failed'))),
      type,
      quality,
    );
  });
}

function baseName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .slice(0, 60);
  return cleaned || fallback;
}

async function preparePhoto(file) {
  const mime = guessMime(file);
  if (mime === 'image/gif') {
    let width = null;
    let height = null;
    try {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close?.();
    } catch {
      /* dimensions are optional */
    }
    return { file: withMime(file, mime), thumbnail: null, width, height };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / bitmap.width, MAX_IMAGE_DIMENSION / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvasBlob(canvas);

  const thumbScale = Math.min(1, 640 / bitmap.width, 640 / bitmap.height);
  const thumbWidth = Math.max(1, Math.round(bitmap.width * thumbScale));
  const thumbHeight = Math.max(1, Math.round(bitmap.height * thumbScale));
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbWidth;
  thumbCanvas.height = thumbHeight;
  const thumbCtx = thumbCanvas.getContext('2d');
  thumbCtx.fillStyle = '#ffffff';
  thumbCtx.fillRect(0, 0, thumbWidth, thumbHeight);
  thumbCtx.drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
  bitmap.close?.();
  const thumbBlob = await canvasBlob(thumbCanvas, 'image/jpeg', 0.75);

  return {
    file: new File([blob], `${baseName(file.name, 'photo')}.jpg`, { type: 'image/jpeg' }),
    thumbnail: new File([thumbBlob], 'thumb.jpg', { type: 'image/jpeg' }),
    width,
    height,
  };
}

async function prepareVideo(file) {
  const mime = guessMime(file);
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('metadata timeout')), 4000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('video metadata error'));
      };
    });

    const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null;
    const width = video.videoWidth || null;
    const height = video.videoHeight || null;

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 800);
      video.onseeked = () => {
        clearTimeout(timer);
        resolve();
      };
      const target = Number.isFinite(video.duration)
        ? Math.min(0.12, Math.max(0.01, video.duration / 3))
        : 0.05;
      try {
        video.currentTime = target;
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });

    let thumbnail = null;
    try {
      const scale = Math.min(1, 640 / (width || 640), 640 / (height || 640));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((width || 640) * scale));
      canvas.height = Math.max(1, Math.round((height || 360) * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, 'image/jpeg', 0.76);
      thumbnail = new File([blob], 'thumb.jpg', { type: 'image/jpeg' });
    } catch {
      thumbnail = null;
    }

    return {
      file: withMime(file, mime),
      thumbnail,
      width,
      height,
      duration_ms: durationMs,
    };
  } finally {
    video.removeAttribute('src');
    video.load?.();
    URL.revokeObjectURL(objectUrl);
  }
}

function audioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 3000);
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    };
    audio.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    audio.src = url;
  });
}

function videoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 4000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    video.src = url;
  });
}

async function prepareAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = Math.round((bitmap.width - side) / 2);
  const sy = Math.round((bitmap.height - side) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 512);
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, 512, 512);
  bitmap.close?.();
  const blob = await canvasBlob(canvas, 'image/jpeg', 0.9);
  return new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
}

function showUploadPanel(kind, name, previewUrl) {
  const preview = $('upload-preview');
  preview.replaceChildren();
  if (kind === 'photo' && previewUrl) {
    const img = el('img');
    img.src = previewUrl;
    preview.append(img);
  } else if (kind === 'video') {
    preview.append(el('span', '', '🎬'));
  } else if (kind === 'voice') {
    preview.append(el('span', '', '🎤'));
  } else if (kind === 'sticker') {
    preview.append(el('span', '', '😀'));
  } else {
    preview.append(el('span', '', '📎'));
  }
  $('upload-name').textContent = name;
  $('upload-bar-fill').style.width = '0%';
  $('upload-panel').classList.remove('hidden');
}

function setUploadProgress(percent) {
  $('upload-bar-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function hideUploadPanel() {
  const upload = state.upload;
  if (upload?.previewUrl) URL.revokeObjectURL(upload.previewUrl);
  state.upload = null;
  $('upload-panel').classList.add('hidden');
  $('upload-preview').replaceChildren();
  $('upload-name').textContent = '';
  $('upload-bar-fill').style.width = '0%';
}

function uploadAttachmentXhr(chatId, formData, onProgress, retried = false) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (state.upload) state.upload.xhr = xhr;
    xhr.open('POST', `/api/chats/${chatId}/attachments`);
    xhr.setRequestHeader('Authorization', `Bearer ${state.accessToken}`);
    xhr.timeout = 120000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress((event.loaded / event.total) * 100);
      }
    };
    xhr.onload = async () => {
      if (xhr.status === 401 && !retried) {
        try {
          await refreshAccessToken(true);
          resolve(await uploadAttachmentXhr(chatId, formData, onProgress, true));
        } catch (error) {
          reject(error);
        }
        return;
      }
      let payload = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
      } else {
        reject(new Error(payload?.error?.message || `Ошибка загрузки (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Нет соединения при загрузке файла'));
    xhr.ontimeout = () => reject(new Error('Истекло время загрузки файла'));
    xhr.onabort = () => reject(new Error('Загрузка отменена'));
    xhr.send(formData);
  });
}

async function handlePickedFile(file, mode = 'media', forcedDurationMs = null) {
  if (!state.activeChatId) {
    toast('Сначала откройте чат');
    return;
  }
  if (state.upload) {
    toast('Дождитесь завершения текущей загрузки');
    return;
  }
  if (!file || file.size <= 0) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    toast(`Файл больше ${MAX_UPLOAD_BYTES / (1024 * 1024)} МБ`);
    return;
  }

  const chatId = state.activeChatId;
  const mime = guessMime(file);
  let kind = 'file';
  let uploadFile = withMime(file, mime);
  let thumbnail = null;
  let width = null;
  let height = null;
  let durationMs = forcedDurationMs;

  try {
    if (mode === 'media') {
      if (mime.startsWith('image/')) {
        kind = 'photo';
        const prepared = await preparePhoto(file);
        uploadFile = prepared.file;
        thumbnail = prepared.thumbnail;
        width = prepared.width;
        height = prepared.height;
      } else if (mime.startsWith('video/')) {
        kind = 'video';
        const prepared = await prepareVideo(file);
        uploadFile = prepared.file;
        thumbnail = prepared.thumbnail;
        width = prepared.width;
        height = prepared.height;
        durationMs = prepared.duration_ms;
      } else {
        toast('Выберите фото или видео');
        return;
      }
    } else if (mode === 'audio' || mode === 'voice') {
      if (!mime.startsWith('audio/')) {
        toast('Выберите аудиофайл');
        return;
      }
      kind = 'voice';
      if (durationMs == null) durationMs = await audioDuration(file);
    } else if (mode === 'sticker') {
      if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
        toast('Для стикера выберите фото или видео');
        return;
      }
      kind = 'sticker';
      if (mime.startsWith('video/')) {
        const seconds = await videoDuration(file);
        if (seconds == null) {
          toast('Не удалось прочитать длительность видео');
          return;
        }
        if (seconds > 5.1) {
          toast('Видео для стикера должно быть не длиннее 5 секунд');
          return;
        }
        durationMs = Math.round(seconds * 1000);
      }
    } else {
      kind = 'file';
    }
  } catch (error) {
    toast(error.message || 'Не удалось обработать файл');
    return;
  }

  const uploadState = {
    chatId,
    xhr: null,
    previewUrl: URL.createObjectURL(file),
    cancelled: false,
  };
  state.upload = uploadState;
  showUploadPanel(kind, uploadFile.name || file.name, uploadState.previewUrl);
  setUploadProgress(1);

  const form = new FormData();
  form.append('kind', kind);
  form.append('file', uploadFile, uploadFile.name || file.name);
  if (thumbnail) form.append('thumbnail', thumbnail, thumbnail.name);
  if (width) form.append('width', String(width));
  if (height) form.append('height', String(height));
  if (durationMs != null) form.append('duration_ms', String(Math.round(durationMs)));

  try {
    const attachment = await uploadAttachmentXhr(chatId, form, setUploadProgress);
    const stillActive = state.activeChatId === chatId;
    const replyId = stillActive ? state.replyTo?.id ?? null : null;
    const caption = stillActive && kind !== 'sticker' ? $('message-input').value.trim() : '';
    if (stillActive && kind !== 'sticker') {
      $('message-input').value = '';
      autoResizeInput();
      updateSendState();
    }
    if (stillActive) hideReply();
    await sendAttachmentMessage(chatId, attachment, caption, replyId);
  } catch (error) {
    if (!uploadState.cancelled) toast(error.message || 'Ошибка загрузки');
  } finally {
    if (state.upload === uploadState) hideUploadPanel();
  }
}

async function sendAttachmentMessage(chatId, attachment, caption, replyToId = null) {
  const message = await api(`/chats/${chatId}/messages`, {
    method: 'POST',
    body: {
      content: caption || '',
      attachment_id: attachment.id,
      reply_to_id: replyToId,
    },
  });
  addMessage(chatId, message);
  if (state.activeChatId === chatId) {
    renderMessages({ toBottom: true });
    updateLocalRead(chatId, message.id);
    scheduleRead();
    scrollToBottom();
  }
  updateChatPreviewFromMessage(chatId, message, { force: true });
  if (state.activeChatId !== chatId) toast('Вложение отправлено в другой чат');
}

function cancelUpload() {
  if (!state.upload) return;
  state.upload.cancelled = true;
  try {
    state.upload.xhr?.abort();
  } catch {
    /* ignore */
  }
  hideUploadPanel();
}

function secureMediaAvailable() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

async function startRecording() {
  if (!secureMediaAvailable()) {
    toast('Запись голоса работает только по HTTPS. Откройте защищённую версию или отправьте аудиофайл.');
    return;
  }
  if (state.recording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    if (!preferred) {
      stream.getTracks().forEach((track) => track.stop());
      toast('Браузер не поддерживает запись аудио');
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: preferred });
    const recording = {
      stream,
      recorder,
      chunks: [],
      mimeType: preferred,
      startedAt: Date.now(),
      timer: null,
      uploadOnStop: true,
    };
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recording.chunks.push(event.data);
    };
    recorder.onstop = async () => {
      clearInterval(recording.timer);
      recording.stream.getTracks().forEach((track) => track.stop());
      $('recording-bar').classList.add('hidden');
      $('voice-btn').classList.remove('recording');
      state.recording = null;
      if (!recording.uploadOnStop || !recording.chunks.length) return;
      const type = recording.mimeType.split(';')[0];
      const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const blob = new Blob(recording.chunks, { type });
      const file = new File([blob], `voice-${Date.now()}.${extension}`, { type });
      await handlePickedFile(file, 'voice', Date.now() - recording.startedAt);
    };
    state.recording = recording;
    recorder.start(250);
    $('recording-bar').classList.remove('hidden');
    $('voice-btn').classList.add('recording');
    $('recording-time').textContent = '0:00';
    recording.timer = setInterval(() => {
      const elapsed = (Date.now() - recording.startedAt) / 1000;
      $('recording-time').textContent = formatDuration(elapsed);
      if (elapsed >= 300) {
        toast('Максимальная длина голосового — 5 минут');
        stopRecording(true);
      }
    }, 250);
  } catch (error) {
    toast(
      error?.name === 'NotAllowedError'
        ? 'Разрешение на микрофон не выдано'
        : 'Не удалось начать запись',
    );
  }
}

function stopRecording(upload) {
  const recording = state.recording;
  if (!recording) return;
  recording.uploadOnStop = upload;
  try {
    recording.recorder.stop();
  } catch {
    recording.stream.getTracks().forEach((track) => track.stop());
    state.recording = null;
    $('recording-bar').classList.add('hidden');
    $('voice-btn').classList.remove('recording');
  }
}

function openProfileModal() {
  if (!state.me) return;
  $('profile-avatar-preview').replaceChildren(avatarFor(state.me, null));
  $('profile-name-input').value = state.me.display_name || '';
  $('profile-bio-input').value = state.me.bio || '';
  $('profile-username').textContent = `@${state.me.username}`;
  $('profile-error').classList.add('hidden');
  updateNotificationUi();
  $('profile-modal').classList.remove('hidden');
}

function closeProfileModal() {
  $('profile-modal').classList.add('hidden');
}

function showProfileError(message) {
  const node = $('profile-error');
  node.textContent = message;
  node.classList.toggle('hidden', !message);
}

async function saveProfile() {
  const display_name = $('profile-name-input').value.trim();
  const bio = $('profile-bio-input').value.trim();
  if (!display_name) {
    showProfileError('Имя не может быть пустым');
    return;
  }
  const button = $('profile-save');
  button.disabled = true;
  try {
    state.me = await api('/users/me', { method: 'PATCH', body: { display_name, bio } });
    renderProfile();
    renderChatList();
    renderChatHeader();
    closeProfileModal();
    toast('Профиль сохранён');
  } catch (error) {
    showProfileError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function uploadAvatarFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    showProfileError('Аватар больше 8 МБ');
    return;
  }
  try {
    const prepared = await prepareAvatar(file);
    const form = new FormData();
    form.append('avatar', prepared, 'avatar.jpg');
    state.me = await formRequest('/users/me/avatar', form);
    $('profile-avatar-preview').replaceChildren(avatarFor(state.me, null));
    renderProfile();
    renderChatList();
    renderChatHeader();
    toast('Аватар обновлён');
  } catch (error) {
    showProfileError(error.message || 'Не удалось загрузить аватар');
  }
}

async function removeAvatar() {
  try {
    state.me = await api('/users/me/avatar', { method: 'DELETE' });
    $('profile-avatar-preview').replaceChildren(avatarFor(state.me, null));
    renderProfile();
    renderChatList();
    renderChatHeader();
    toast('Аватар удалён');
  } catch (error) {
    showProfileError(error.message);
  }
}

async function formRequest(path, formData, method = 'POST') {
  const headers = {};
  if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;
  let response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: formData,
  });
  if (response.status === 401) {
    await refreshAccessToken(true);
    headers.Authorization = `Bearer ${state.accessToken}`;
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: formData,
    });
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Ошибка запроса (${response.status})`);
  }
  return payload;
}

function base64UrlToUint8Array(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registerPush() {
  if (!state.pushServerEnabled || !state.pushPublicKey) return false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(state.pushPublicKey),
      });
    }
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      throw new Error('Браузер не вернул ключи push-подписки');
    }
    await api('/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
    });
    state.pushSubscribed = true;
    state.pushEndpoint = json.endpoint;
    updateNotificationUi();
    return true;
  } catch (error) {
    console.warn('push registration failed', error);
    state.pushSubscribed = false;
    updateNotificationUi();
    return false;
  }
}

async function disablePush() {
  const endpoint = state.pushEndpoint;
  if (endpoint && state.accessToken) {
    try {
      await api('/push/unsubscribe', {
        method: 'POST',
        body: { endpoint },
      });
    } catch {
      /* best effort */
    }
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    /* ignore */
  }
  state.pushSubscribed = false;
  state.pushEndpoint = null;
}

function showNotificationPromptIfNeeded() {
  if (!state.me) return;
  const prompt = $('notification-prompt');
  const text = $('notification-prompt-text');
  const button = $('notification-enable');
  const supported = 'Notification' in window && window.isSecureContext;
  if (!supported) {
    prompt.classList.add('hidden');
    return;
  }
  if (state.notificationsEnabled && Notification.permission === 'granted') {
    prompt.classList.add('hidden');
    return;
  }

  prompt.classList.remove('hidden');
  if (Notification.permission === 'denied') {
    text.textContent = 'Уведомления заблокированы в настройках сайта. Разрешите их в настройках браузера.';
    button.textContent = 'Как включить';
  } else if (state.pushServerEnabled) {
    text.textContent = 'Новые сообщения будут приходить даже при закрытой вкладке.';
    button.textContent = 'Включить';
  } else {
    text.textContent = 'Показывать уведомления о новых сообщениях, пока вкладка открыта.';
    button.textContent = 'Включить';
  }
}

async function enableNotifications() {
  if (!('Notification' in window) || !window.isSecureContext) {
    toast('Уведомления доступны только по HTTPS');
    return false;
  }
  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    state.notificationsEnabled = false;
    persistNotificationPreference(false);
    updateNotificationUi();
    showNotificationPromptIfNeeded();
    toast(
      permission === 'denied'
        ? 'Разрешите уведомления в настройках браузера'
        : 'Разрешение на уведомления не выдано',
    );
    return false;
  }
  state.notificationsEnabled = true;
  persistNotificationPreference(true);
  $('notification-prompt').classList.add('hidden');
  updateNotificationUi();
  await registerPush();
  toast('Уведомления включены');
  return true;
}

async function initPush() {
  try {
    const info = await api('/push/public-key');
    state.pushServerEnabled = Boolean(info?.enabled);
    state.pushPublicKey = info?.public_key || null;
  } catch {
    state.pushServerEnabled = false;
    state.pushPublicKey = null;
  }
  showNotificationPromptIfNeeded();
  if (
    'Notification' in window &&
    state.notificationsEnabled &&
    Notification.permission === 'granted' &&
    state.pushServerEnabled
  ) {
    await registerPush();
  }
  updateNotificationUi();
}

function updateNotificationUi() {
  const toggle = $('notifications-toggle');
  const hint = $('notifications-hint');
  const supported = 'Notification' in window && window.isSecureContext;
  toggle.checked = supported && state.notificationsEnabled;
  toggle.disabled = !supported;
  if (!supported) {
    hint.textContent = window.isSecureContext
      ? 'Браузер не поддерживает уведомления.'
      : 'Нужен HTTPS: на HTTP браузер блокирует уведомления.';
    return;
  }
  if (Notification.permission === 'denied') {
    hint.textContent = 'Уведомления запрещены в настройках сайта.';
  } else if (state.notificationsEnabled && state.pushSubscribed) {
    hint.textContent = 'Включены, фоновые уведомления работают.';
  } else if (state.notificationsEnabled && state.pushServerEnabled) {
    hint.textContent = 'Включены в браузере; фоновые уведомления подключаются.';
  } else if (state.notificationsEnabled) {
    hint.textContent = 'Включены, пока вкладка открыта.';
  } else {
    hint.textContent = 'Показывать уведомления о новых сообщениях.';
  }
}

function persistNotificationPreference(enabled) {
  try {
    localStorage.setItem('ct_notifications', enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

async function toggleNotifications(enabled) {
  if (enabled) {
    const ok = await enableNotifications();
    if (!ok) $('notifications-toggle').checked = false;
  } else {
    state.notificationsEnabled = false;
    persistNotificationPreference(false);
    await disablePush();
    updateNotificationUi();
    $('notification-prompt').classList.add('hidden');
  }
}

function loadNotificationPreference() {
  try {
    state.notificationsEnabled = localStorage.getItem('ct_notifications') === '1';
  } catch {
    state.notificationsEnabled = false;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    state.notificationsEnabled = false;
  }
}

function notifyMessage(message) {
  if (message.sender?.id === state.me?.id) return;
  if (!state.notificationsEnabled || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (state.pushSubscribed && document.visibilityState !== 'visible') return;
  if (document.visibilityState === 'visible' && state.activeChatId === message.chat_id) return;
  const chat = state.chatsById.get(message.chat_id);
  if (!chat) return;
  const senderName = message.sender?.display_name || 'CipherTalk';
  const title = chat.kind === 'group' ? `${senderName} — ${chatTitle(chat)}` : senderName;
  const body = message.content || attachmentLabel(message.attachment?.kind) || 'Новое сообщение';
  const icon = chat.kind === 'private'
    ? chat.peer?.avatar_url || message.sender?.avatar_url
    : chat.avatar_url;
  try {
    const notification = new Notification(title, {
      body: body.slice(0, 180),
      icon: icon ? new URL(icon, location.origin).href : undefined,
      tag: `chat-${message.chat_id}`,
      silent: false,
    });
    notification.onclick = () => {
      window.focus();
      openChat(message.chat_id);
      notification.close();
    };
  } catch {
    /* platform may block */
  }
}

function handleServiceWorkerMessage(event) {
  const data = event.data || {};
  if (data.type === 'open-chat' && data.chatId) {
    openChat(Number(data.chatId));
  } else if (data.type === 'push-resubscribe' && state.notificationsEnabled) {
    registerPush();
  }
}

function updateUnreadTitle() {
  const unread = state.chats.reduce(
    (total, chat) => total + (Number(chat.unread_count) || 0),
    0,
  );
  const activeTitle = state.activeChat ? chatTitle(state.activeChat) : '';
  document.title = `${unread > 0 ? `(${unread}) ` : ''}${activeTitle ? `${activeTitle} — ` : ''}CipherTalk`;
}


/* --------------------------------------------------------------------------
   1:1 WebRTC calls
   -------------------------------------------------------------------------- */
function secureCallAvailable() {
  return Boolean(
    window.isSecureContext &&
      navigator.mediaDevices?.getUserMedia &&
      window.RTCPeerConnection,
  );
}

function callTimerText(call) {
  if (!call.active || !call.startedAt) return call.direction === 'incoming'
    ? `Входящий ${call.video ? 'видеозвонок' : 'аудиозвонок'}`
    : 'Звоним…';
  return `Соединено · ${formatDuration((Date.now() - call.startedAt) / 1000)}`;
}

function showCallOverlay(call) {
  const chat = state.chatsById.get(call.chatId);
  const avatarEntity = {
    id: call.peerId,
    display_name: call.peerName || 'Собеседник',
    avatar_url: call.peerAvatar || chat?.peer?.avatar_url,
  };
  $('call-avatar').replaceChildren(avatarFor(avatarEntity, null));
  $('call-name').textContent = call.peerName || 'Собеседник';
  $('call-status').textContent = callTimerText(call);
  $('call-overlay').classList.remove('hidden');
  updateCallUi(call);
}

function updateCallUi(call) {
  if (!state.call || state.call !== call) return;
  $('call-status').textContent = callTimerText(call);
  const incomingWaiting = call.direction === 'incoming' && !call.active;
  $('call-accept').classList.toggle('hidden', !incomingWaiting);
  $('call-decline').classList.toggle('hidden', !incomingWaiting);
  $('call-end').classList.toggle('hidden', incomingWaiting);
  $('call-mute').classList.toggle('hidden', incomingWaiting);
  $('call-camera').classList.toggle('hidden', incomingWaiting || !call.video);
  $('call-videos').classList.toggle(
    'hidden',
    !call.video || (!call.localStream && !call.remoteStream),
  );
  if (call.localStream && call.video) {
    const local = $('call-local');
    if (local.srcObject !== call.localStream) local.srcObject = call.localStream;
  }
}

function createCallPeer(call) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });
  call.pc = pc;

  call.localStream.getTracks().forEach((track) => {
    pc.addTrack(track, call.localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWs({
        type: 'call.ice',
        call_id: call.id,
        chat_id: call.chatId,
        candidate: event.candidate.toJSON(),
      });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    call.remoteStream = stream;
    $('call-remote').srcObject = stream;
    updateCallUi(call);
  };

  pc.onconnectionstatechange = () => {
    if (state.call !== call) return;
    if (pc.connectionState === 'connected') {
      markCallActive(call);
    } else if (pc.connectionState === 'failed') {
      toast('Соединение потеряно');
      closeCall(true, 'connection_lost');
    } else {
      updateCallUi(call);
    }
  };
}

function markCallActive(call) {
  if (call.active) return;
  call.active = true;
  call.startedAt = Date.now();
  clearTimeout(call.timeout);
  $('call-accept').classList.add('hidden');
  $('call-decline').classList.add('hidden');
  $('call-end').classList.remove('hidden');
  $('call-mute').classList.remove('hidden');
  $('call-camera').classList.toggle('hidden', !call.video);
  if (call.video) $('call-videos').classList.remove('hidden');
  clearInterval(call.timer);
  call.timer = setInterval(() => {
    if (state.call === call) {
      $('call-status').textContent = callTimerText(call);
    }
  }, 1000);
  updateCallUi(call);
}

async function startCall(video) {
  const chat = state.activeChat;
  if (!chat || chat.kind !== 'private' || !chat.peer) return;
  if (!secureCallAvailable()) {
    toast('Звонки работают только по HTTPS. Откройте https://192.168.1.34:8443');
    return;
  }
  if (state.call) {
    toast('Уже идёт звонок');
    return;
  }
  if (state.recording) stopRecording(false);

  const call = {
    id: makeId(),
    chatId: chat.id,
    peerId: chat.peer.id,
    peerName: chatTitle(chat),
    peerAvatar: chat.peer.avatar_url,
    video: Boolean(video),
    direction: 'outgoing',
    active: false,
    pendingOffer: null,
    pendingCandidates: [],
    pc: null,
    localStream: null,
    remoteStream: null,
    timer: null,
    timeout: null,
    startedAt: 0,
  };
  state.call = call;
  showCallOverlay(call);
  call.timeout = setTimeout(() => {
    if (state.call === call && !call.active) {
      toast('Абонент не ответил');
      closeCall(true, 'timeout');
    }
  }, 45000);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: Boolean(video),
    });
    if (state.call !== call) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    call.localStream = stream;
    createCallPeer(call);
    updateCallUi(call);

    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    if (
      !sendWs({
        type: 'call.offer',
        call_id: call.id,
        chat_id: call.chatId,
        sdp: offer.sdp,
        video: Boolean(video),
      })
    ) {
      throw new Error('Нет соединения');
    }
  } catch (error) {
    if (state.call === call) {
      toast(
        error?.name === 'NotAllowedError'
          ? 'Нет доступа к микрофону или камере'
          : error.message || 'Не удалось начать звонок',
      );
      closeCall(true, 'media_error');
    }
  }
}

function handleCallOffer(event) {
  if (event.from_user_id === state.me?.id) return;
  if (state.call) {
    sendWs({
      type: 'call.end',
      call_id: event.call_id,
      chat_id: event.chat_id,
      reason: 'busy',
    });
    return;
  }
  const chat = state.chatsById.get(event.chat_id);
  if (!chat || chat.kind !== 'private') return;
  if (!secureCallAvailable()) {
    sendWs({
      type: 'call.end',
      call_id: event.call_id,
      chat_id: event.chat_id,
      reason: 'secure_context_required',
    });
    return;
  }

  const call = {
    id: event.call_id,
    chatId: event.chat_id,
    peerId: event.from_user_id,
    peerName: event.display_name || chatTitle(chat),
    peerAvatar: chat.peer?.avatar_url,
    video: Boolean(event.video),
    direction: 'incoming',
    active: false,
    pendingOffer: event.sdp,
    pendingCandidates: [],
    pc: null,
    localStream: null,
    remoteStream: null,
    timer: null,
    timeout: null,
    startedAt: 0,
  };
  state.call = call;
  showCallOverlay(call);
}

async function acceptCall() {
  const call = state.call;
  if (!call || call.direction !== 'incoming' || !call.pendingOffer) return;
  if (!secureCallAvailable()) {
    toast('Для звонка нужен HTTPS');
    return;
  }
  $('call-accept').disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: call.video,
    });
    if (state.call !== call) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    call.localStream = stream;
    createCallPeer(call);
    await call.pc.setRemoteDescription({
      type: 'offer',
      sdp: call.pendingOffer,
    });
    await flushCallCandidates(call);
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    sendWs({
      type: 'call.answer',
      call_id: call.id,
      chat_id: call.chatId,
      sdp: answer.sdp,
    });
    call.pendingOffer = null;
    updateCallUi(call);
  } catch (error) {
    toast(
      error?.name === 'NotAllowedError'
        ? 'Нет доступа к микрофону или камере'
        : 'Не удалось принять звонок',
    );
    closeCall(true, 'media_error');
  } finally {
    $('call-accept').disabled = false;
  }
}

async function handleCallAnswer(event) {
  if (event.from_user_id === state.me?.id) return;
  const call = state.call;
  if (
    !call ||
    call.id !== event.call_id ||
    call.direction !== 'outgoing' ||
    !call.pc
  ) {
    return;
  }
  try {
    await call.pc.setRemoteDescription({ type: 'answer', sdp: event.sdp });
    await flushCallCandidates(call);
    updateCallUi(call);
  } catch {
    toast('Не удалось установить соединение');
    closeCall(true, 'connection_failed');
  }
}

async function flushCallCandidates(call) {
  if (!call.pc) return;
  const candidates = call.pendingCandidates.splice(0);
  for (const candidate of candidates) {
    try {
      await call.pc.addIceCandidate(candidate);
    } catch {
      /* stale candidate */
    }
  }
}

async function handleCallIce(event) {
  if (event.from_user_id === state.me?.id) return;
  const call = state.call;
  if (!call || call.id !== event.call_id) return;
  if (!call.pc || !call.pc.remoteDescription) {
    call.pendingCandidates.push(event.candidate);
    return;
  }
  try {
    await call.pc.addIceCandidate(event.candidate);
  } catch {
    /* ignore */
  }
}

function handleCallEnd(event) {
  if (event.from_user_id === state.me?.id) return;
  const call = state.call;
  if (!call || call.id !== event.call_id) return;
  const wasInactiveIncoming = call.direction === 'incoming' && !call.active;
  closeCall(false);
  if (event.reason === 'busy') {
    toast('Абонент занят');
  } else if (event.reason === 'declined') {
    toast('Звонок отклонён');
  } else if (event.reason === 'timeout') {
    toast('Абонент не ответил');
  } else if (event.reason === 'secure_context_required') {
    toast('У собеседника нет HTTPS — звонок недоступен');
  } else if (wasInactiveIncoming) {
    toast('Звонок отменён');
  } else {
    toast('Звонок завершён');
  }
}

function closeCall(sendEnd = true, reason = null) {
  const call = state.call;
  if (!call) return;
  state.call = null;
  clearTimeout(call.timeout);
  clearInterval(call.timer);
  if (sendEnd) {
    sendWs({
      type: 'call.end',
      call_id: call.id,
      chat_id: call.chatId,
      reason,
    });
  }
  try {
    call.localStream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* ignore */
  }
  try {
    call.pc?.close();
  } catch {
    /* ignore */
  }
  $('call-remote').srcObject = null;
  $('call-local').srcObject = null;
  $('call-local').style.opacity = '1';
  $('call-overlay').classList.add('hidden');
  $('call-videos').classList.add('hidden');
  $('call-mute').classList.remove('muted');
  $('call-camera').classList.remove('muted');
}

function toggleCallMute() {
  const call = state.call;
  if (!call?.localStream) return;
  const audioTracks = call.localStream.getAudioTracks();
  if (!audioTracks.length) return;
  const enabled = !audioTracks.every((track) => track.enabled);
  audioTracks.forEach((track) => {
    track.enabled = enabled;
  });
  $('call-mute').classList.toggle('muted', !enabled);
}

function toggleCallCamera() {
  const call = state.call;
  if (!call?.localStream || !call.video) return;
  const videoTracks = call.localStream.getVideoTracks();
  if (!videoTracks.length) return;
  const enabled = !videoTracks.every((track) => track.enabled);
  videoTracks.forEach((track) => {
    track.enabled = enabled;
  });
  $('call-camera').classList.toggle('muted', !enabled);
  const local = $('call-local');
  if (local) local.style.opacity = enabled ? '1' : '0.35';
}

/* --------------------------------------------------------------------------
   Event wiring
   -------------------------------------------------------------------------- */
function bindEvents() {
  $('tab-login').addEventListener('click', () => setAuthMode('login'));
  $('tab-register').addEventListener('click', () => setAuthMode('register'));
  $('login-form').addEventListener('submit', submitLogin);
  $('register-form').addEventListener('submit', submitRegister);

  $('logout-btn').addEventListener('click', logout);
  $('settings-btn').addEventListener('click', openProfileModal);
  $('profile-avatar').addEventListener('click', openProfileModal);
  $('new-chat-btn').addEventListener('click', openNewChatModal);
  $('empty-new-chat').addEventListener('click', openNewChatModal);

  $('profile-close').addEventListener('click', closeProfileModal);
  $('profile-modal').addEventListener('click', (event) => {
    if (event.target === $('profile-modal')) closeProfileModal();
  });
  $('profile-save').addEventListener('click', saveProfile);
  $('avatar-choose').addEventListener('click', () => $('avatar-input').click());
  $('avatar-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await uploadAvatarFile(file);
  });
  $('avatar-remove').addEventListener('click', removeAvatar);
  $('notifications-toggle').addEventListener('change', (event) => {
    toggleNotifications(event.target.checked);
  });
  $('notification-enable').addEventListener('click', async () => {
    if (Notification.permission === 'denied') {
      toast('Разрешите уведомления в настройках сайта (иконка замка в адресной строке)');
      return;
    }
    await enableNotifications();
  });
  $('notification-later').addEventListener('click', () => {
    $('notification-prompt').classList.add('hidden');
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
  }

  $('attach-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    $('attach-menu').classList.toggle('hidden');
  });
  $('attach-menu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-attach]')?.dataset.attach;
    if (!action) return;
    $('attach-menu').classList.add('hidden');
    if (action === 'media') $('media-input').click();
    else if (action === 'sticker') $('sticker-input').click();
    else if (action === 'file') $('file-input').click();
    else if (action === 'audio') $('audio-input').click();
  });
  $('media-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await handlePickedFile(file, 'media');
  });
  $('sticker-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await handlePickedFile(file, 'sticker');
  });
  $('file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await handlePickedFile(file, 'file');
  });
  $('audio-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await handlePickedFile(file, 'audio');
  });
  $('voice-btn').addEventListener('click', () => {
    if (state.recording) stopRecording(true);
    else startRecording();
  });
  $('recording-stop').addEventListener('click', () => stopRecording(true));
  $('recording-cancel').addEventListener('click', () => stopRecording(false));
  $('upload-cancel').addEventListener('click', cancelUpload);
  $('call-accept').addEventListener('click', acceptCall);
  $('call-decline').addEventListener('click', () => closeCall(true, 'declined'));
  $('call-end').addEventListener('click', () => closeCall(true, 'ended'));
  $('call-mute').addEventListener('click', toggleCallMute);
  $('call-camera').addEventListener('click', toggleCallCamera);
  $('viewer-close').addEventListener('click', closeImageViewer);
  $('image-viewer').addEventListener('click', (event) => {
    if (event.target === $('image-viewer')) closeImageViewer();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#attach-menu') && !event.target.closest('#attach-btn')) {
      $('attach-menu').classList.add('hidden');
    }
  });

  $('modal-close').addEventListener('click', closeNewChatModal);
  $('new-chat-modal').addEventListener('click', (event) => {
    if (event.target === $('new-chat-modal')) closeNewChatModal();
  });
  $('modal-tab-dm').addEventListener('click', () => setModalMode('dm'));
  $('modal-tab-group').addEventListener('click', () => setModalMode('group'));
  $('create-group-btn').addEventListener('click', createGroupChat);
  $('group-title').addEventListener('input', updateCreateGroupState);

  $('user-search').addEventListener('input', (event) => {
    const query = event.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => searchUsers(query), 260);
  });

  $('chat-filter').addEventListener('input', (event) => {
    state.chatFilter = event.target.value;
    renderChatList();
  });

  $('back-btn').addEventListener('click', () => {
    document.body.classList.remove('chat-open');
  });

  $('composer').addEventListener('submit', sendMessage);
  $('message-input').addEventListener('input', () => {
    autoResizeInput();
    updateSendState();
    sendTypingThrottled();
  });
  $('message-input').addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      sendMessage();
    }
  });
  $('reply-cancel').addEventListener('click', hideReply);

  $('messages').addEventListener('scroll', () => {
    const container = $('messages');
    if (container.scrollTop < 70) {
      loadOlderMessages();
    } else if (isNearBottom(container)) {
      scheduleRead();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.call) closeCall(true, 'ended');
  });
  window.addEventListener('focus', () => {
    if (isNearBottom($('messages'))) scheduleRead();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isNearBottom($('messages'))) {
      scheduleRead();
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('image-viewer').classList.contains('hidden')) {
        closeImageViewer();
      } else if (!$('profile-modal').classList.contains('hidden')) {
        closeProfileModal();
      } else if (!$('new-chat-modal').classList.contains('hidden')) {
        closeNewChatModal();
      } else if (!$('attach-menu').classList.contains('hidden')) {
        $('attach-menu').classList.add('hidden');
      } else if (state.replyTo) {
        hideReply();
      }
    }
  });
}

/* --------------------------------------------------------------------------
   Bootstrap
   -------------------------------------------------------------------------- */
async function init() {
  bindEvents();
  loadNotificationPreference();
  updateSendState();
  autoResizeInput();

  let hasSession = false;
  try {
    hasSession = localStorage.getItem('ct_has_session') === '1';
  } catch {
    hasSession = false;
  }

  if (!hasSession) {
    showAuth();
    return;
  }

  try {
    await refreshAccessToken(true);
    await enterApp();
  } catch {
    try {
      localStorage.removeItem('ct_has_session');
    } catch {
      /* ignore */
    }
    showAuth();
  }
}

document.addEventListener('DOMContentLoaded', init);
