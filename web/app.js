// CipherTalk — клиент мессенджера: REST + WebSocket, без фреймворков.
"use strict";

// ─── Глобальное состояние приложения ────────────────────────────────
const S = {
  token: null,        // JWT из localStorage
  userId: null,       // id текущего пользователя
  username: "",       // имя текущего пользователя
  currentChatId: null,// открытый сейчас чат
  ws: null,           // WebSocket-соединение
  wsClosed: true,     // флаг «закрыто намеренно» (при logout не переподключаемся)
  mode: "login",      // "login" | "register" — режим формы авторизации
  chats: [],          // список чатов пользователя
};

// Короткие ссылки на DOM-элементы
const $ = (id) => document.getElementById(id);

// ─── Хранилище токена ───────────────────────────────────────────────
function saveSession() {
  localStorage.setItem("ct_token", S.token || "");
  localStorage.setItem("ct_user", JSON.stringify({ id: S.userId, username: S.username }));
}
function clearSession() {
  localStorage.removeItem("ct_token");
  localStorage.removeItem("ct_user");
}
function restoreSession() {
  const token = localStorage.getItem("ct_token");
  const raw = localStorage.getItem("ct_user");
  if (!token || !raw) return false;
  try {
    const u = JSON.parse(raw);
    S.token = token;
    S.userId = u.id;
    S.username = u.username;
    return true;
  } catch {
    return false;
  }
}

// ─── Обёртка над fetch ──────────────────────────────────────────────
// Добавляет Bearer-токен, разбирает JSON-ошибки вида {error:"..."} и бросает Error.
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (S.token) headers["Authorization"] = "Bearer " + S.token;
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch {}
    throw new Error(msg || "Ошибка сервера");
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── Toast-уведомления ──────────────────────────────────────────────
let toastTimer = null;
function toast(text, ok = false) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.toggle("ok", ok);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ─── Авторизация ────────────────────────────────────────────────────
$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("auth-error");
  errEl.textContent = "";
  const username = $("username").value.trim();
  const password = $("password").value;
  if (!username || !password) {
    errEl.textContent = "Заполните имя пользователя и пароль";
    return;
  }
  const path = S.mode === "login" ? "/api/login" : "/api/register";
  try {
    const resp = await api(path, { method: "POST", body: JSON.stringify({ username, password }) });
    S.token = resp.token;
    S.userId = resp.user_id;
    S.username = username;
    saveSession();
    enterApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// Переключение login <-> register по ссылке
$("auth-toggle").addEventListener("click", (e) => {
  e.preventDefault();
  S.mode = S.mode === "login" ? "register" : "login";
  $("auth-submit").textContent = S.mode === "login" ? "Войти" : "Зарегистрироваться";
  $("auth-toggle").textContent =
    S.mode === "login" ? "Нет аккаунта? Зарегистрироваться" : "Уже есть аккаунт? Войти";
  $("auth-error").textContent = "";
});

// ─── Вход в приложение ─────────────────────────────────────────────
async function enterApp() {
  $("auth-screen").hidden = true;
  $("app-screen").hidden = false;
  $("me-name").textContent = S.username;
  await loadChats().catch((e) => toast("Не удалось загрузить чаты: " + e.message));
  connectWs();
}

// ─── Чаты ───────────────────────────────────────────────────────────
async function loadChats() {
  S.chats = await api("/api/chats");
  renderChats();
}

function renderChats() {
  const list = $("chats-list");
  list.textContent = "";
  if (!S.chats.length) {
    const empty = document.createElement("div");
    empty.className = "chats-empty";
    empty.textContent = "Пока нет чатов — создайте новый";
    list.appendChild(empty);
  }
  for (const chat of S.chats) {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === S.currentChatId ? " active" : "");
    item.dataset.id = chat.id;
    item.textContent = `${chat.name} · #${chat.id}`;
    item.addEventListener("click", () => openChat(chat.id));
    list.appendChild(item);
  }
}

// Создание чата: POST /api/chats {name} -> {chat_id}
$("create-chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("new-chat-name").value.trim();
  if (!name) return;
  try {
    const resp = await api("/api/chats", { method: "POST", body: JSON.stringify({ name }) });
    $("new-chat-name").value = "";
    await loadChats();
    openChat(resp.chat_id);
  } catch (err) {
    toast("Создание чата: " + err.message);
  }
});

// Вступление в чат по ID: POST /api/chats/:id/join
$("join-chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = parseInt($("join-chat-id").value, 10);
  if (!Number.isFinite(id)) return;
  try {
    await api(`/api/chats/${id}/join`, { method: "POST" });
    $("join-chat-id").value = "";
    toast("Вы вступили в чат #" + id, true);
    await loadChats();
    openChat(id);
  } catch (err) {
    toast("Вступление в чат: " + err.message);
  }
});

// Открытие чата: загрузка истории + подписка по WS
async function openChat(id) {
  S.currentChatId = id;
  const chat = S.chats.find((c) => c.id === id);
  $("chat-title").textContent = chat ? `${chat.name} · #${chat.id}` : `Чат #${id}`;
  $("send-form").hidden = false;
  $("messages").textContent = "";
  renderChats(); // подсветить активный элемент
  try {
    const msgs = await api(`/api/chats/${id}/messages?limit=50`);
    msgs.forEach(appendMessage);
    scrollToBottom();
  } catch (err) {
    toast("История сообщений: " + err.message);
  }
  // Подписываемся на события чата по WebSocket
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: "subscribe", chat_id: id }));
  }
  // Мобильная раскладка: показываем окно чата
  $("app-screen").classList.add("mobile-chat-open");
}

// ─── Сообщения ──────────────────────────────────────────────────────
$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message-input");
  const body = input.value.trim();
  if (!body || !S.currentChatId) return;
  input.value = "";
  try {
    const saved = await api(`/api/chats/${S.currentChatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    // Обычно сообщение придёт через WS; если соединения нет — добавляем из ответа
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) appendMessage(saved);
  } catch (err) {
    input.value = body; // вернуть текст, чтобы не потерять
    toast("Отправка: " + err.message);
  }
});

// Добавление одного сообщения в ленту (textContent — защита от XSS)
function appendMessage(m) {
  const div = document.createElement("div");
  div.className = "msg " + (m.user_id === S.userId ? "me" : "other");
  const author = document.createElement("div");
  author.className = "msg-author";
  author.textContent = `${m.username} · ${formatTime(m.created_at)}`;
  const bodyEl = document.createElement("div");
  bodyEl.className = "msg-body";
  bodyEl.textContent = m.body;
  div.appendChild(author);
  div.appendChild(bodyEl);
  $("messages").appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  const el = $("messages");
  el.scrollTop = el.scrollHeight;
}

// HH:MM из unix-seconds
function formatTime(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── WebSocket ──────────────────────────────────────────────────────
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(S.token)}`);
  S.ws = ws;
  S.wsClosed = false;

  ws.onopen = () => {
    // При переподключении заново подписываемся на текущий чат
    if (S.currentChatId) {
      ws.send(JSON.stringify({ type: "subscribe", chat_id: S.currentChatId }));
    }
  };

  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "message" && ev.chat_id === S.currentChatId) {
      appendMessage(ev);
    }
  };

  ws.onerror = () => { /* переподключение произойдёт в onclose */ };

  ws.onclose = () => {
    // Намеренный logout — не переподключаемся; иначе retry через 2 секунды
    if (S.wsClosed || !S.token) return;
    setTimeout(connectWs, 2000);
  };
}

// ─── Logout ─────────────────────────────────────────────────────────
$("logout").addEventListener("click", () => {
  S.wsClosed = true;
  if (S.ws) S.ws.close();
  clearSession();
  S.token = null;
  S.userId = null;
  S.username = "";
  S.currentChatId = null;
  S.chats = [];
  $("app-screen").hidden = true;
  $("app-screen").classList.remove("mobile-chat-open");
  $("auth-screen").hidden = false;
  $("messages").textContent = "";
  $("send-form").hidden = true;
  $("chat-title").textContent = "Выбери чат";
});

// Кнопка «назад» в мобильной раскладке
$("back-btn").addEventListener("click", () => {
  $("app-screen").classList.remove("mobile-chat-open");
});

// ─── Старт: если токен сохранён — сразу в приложение ───────────────
if (restoreSession()) {
  enterApp();
} else {
  $("auth-screen").hidden = false;
}
