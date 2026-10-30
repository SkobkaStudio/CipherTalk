// CipherTalk — клиент мессенджера: REST + WebSocket, без фреймворков.
// Авторизация v2: телефон -> (код из лога | пароль) -> профиль/username/пароль.
"use strict";

// ─── Глобальное состояние приложения ────────────────────────────────
const S = {
  token: null,         // JWT из localStorage
  user: null,          // {id, server_id, username, first_name, ...}
  currentChatId: null, // открытый сейчас чат (внутренний i64 id)
  ws: null,            // WebSocket-соединение
  wsClosed: true,      // флаг «закрыто намеренно» (при logout не переподключаемся)
  phone: null,         // нормализованный номер на шагах wizard
  code: null,          // подтверждённый код для finish_register
  chats: [],           // список чатов пользователя
};

const $ = (id) => document.getElementById(id);

// ─── Хранилище сессии ───────────────────────────────────────────────
function saveSession() {
  localStorage.setItem("ct_token", S.token || "");
  localStorage.setItem("ct_user", JSON.stringify(S.user || null));
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
    if (!u || !u.id) return false;
    S.token = token;
    S.user = u;
    return true;
  } catch {
    return false;
  }
}

// ─── Обёртка над fetch ──────────────────────────────────────────────
// Добавляет Bearer-токен, разбирает JSON-ошибки вида {error:"..."} и бросает Error.
// err.status — HTTP-код (нужен для разлогина при 401).
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (S.token) headers["Authorization"] = "Bearer " + S.token;
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    let msg = res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    try {
      const data = await res.json();
      if (data && data.error) err.message = data.error;
    } catch {}
    throw err;
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

// ─── Wizard авторизации: переключение шагов ─────────────────────────
const AUTH_STEPS = ["auth-step-phone", "auth-step-password", "auth-step-code", "auth-step-profile"];
function showStep(id) {
  for (const s of AUTH_STEPS) $(s).hidden = s !== id;
  $("auth-error").textContent = "";
}
function authError(msg) { $("auth-error").textContent = msg; }

// Нормализация номера как на сервере: цифры/+7, убираем пробелы, скобки, дефисы
function normalizePhone(raw) {
  let c = (raw || "").replace(/[ ()\-\u00A0]/g, "");
  if (c.startsWith("+")) return c;
  if (c.startsWith("8")) return "+7" + c.slice(1);
  return "+" + c;
}

// ─── Маски полей «только цифры» ─────────────────────────────────────
// В поле номера можно печатать только цифры — они сами превращаются
// в красивый формат "+7 (999) 123-45-67". Сырые цифры храним в dataset.digits,
// поэтому маска не мешает серверной нормализации (normalizePhone).

/// Красивый вывод до 11 цифр в российском формате.
function prettyPhone(d) {
  if (!d) return "";
  let out = "+" + d[0];                       // первая цифра (7 или 8)
  if (d.length > 1) out += " (" + d.slice(1, 4);
  if (d.length >= 4) out += ")";
  if (d.length > 4) out += " " + d.slice(4, 7);
  if (d.length > 7) out += "-" + d.slice(7, 9);
  if (d.length > 9) out += "-" + d.slice(9, 11);
  return out;
}

/// Перекрасить поле телефона из dataset.digits, сохранив позицию каретки
/// (пересчитываем индекс: сколько цифр было до курсора → где они в маске).
function rerenderPhone(el, keepCaretAfter) {
  const before = el.value;
  const digits = el.dataset.digits || "";
  el.value = prettyPhone(digits);
  if (keepCaretAfter) { el.setSelectionRange(el.value.length, el.value.length); return; }
  // Кол-во цифр слева от курсора в старом значении
  const pos = el.selectionStart ?? el.value.length;
  const leftDigits = before.slice(0, pos).replace(/\D/g, "").length;
  // Позиция в новом значении: после leftDigits-й цифры
  let seen = 0, caret = el.value.length;
  for (let i = 0; i < el.value.length; i++) {
    if (/\d/.test(el.value[i])) { seen++; if (seen === leftDigits) { caret = i + 1; break; } }
  }
  if (leftDigits === 0) caret = 0;
  el.setSelectionRange(caret, caret);
}

const phoneInput = $("phone");
// Фильтруем ввод: оставляем только цифры, ведущий 8 меняем на 7 (как на сервере), макс 11
phoneInput.addEventListener("beforeinput", (e) => {
  if (e.data != null) {
    const only = e.data.replace(/\D/g, "");
    if (only !== e.data) e.preventDefault();          // буквы/символы не набираются
    if (only) {
      e.preventDefault();
      let digits = (phoneInput.dataset.digits || "") + only;
      if (digits[0] === "8") digits = "7" + digits.slice(1);
      phoneInput.dataset.digits = digits.slice(0, 11);
      rerenderPhone(phoneInput, true);
    }
  } else if (e.inputType === "deleteContentBackward" || e.inputType === "deleteContentForward") {
    e.preventDefault();
    const digits = (phoneInput.dataset.digits || "").slice(0, -1);
    phoneInput.dataset.digits = digits;
    rerenderPhone(phoneInput, true);
  } else if (e.inputType === "insertFromPaste") {
    e.preventDefault();
    const data = (e.dataTransfer || {}).getData
      ? (e.clipboardData || window.clipboardData).getData("text") : "";
    let digits = (data || "").replace(/\D/g, "").slice(0, 11);
    if (digits[0] === "8") digits = "7" + digits.slice(1);
    phoneInput.dataset.digits = digits;
    rerenderPhone(phoneInput, true);
  }
});
// Страховка на случай IME/автозаполнения: любая лишняя нецифра вычищается
phoneInput.addEventListener("input", () => {
  const cleaned = phoneInput.value.replace(/\D/g, "").slice(0, 11);
  if (cleaned !== (phoneInput.dataset.digits || "")) {
    phoneInput.dataset.digits = cleaned;
    phoneInput.value = prettyPhone(cleaned);
  }
});

// Поле кода: только цифры, максимум 6
$("code").addEventListener("input", (e) => {
  const v = e.target.value.replace(/\D/g, "").slice(0, 6);
  e.target.value = v;
});

// Шаг 1: номер телефона -> POST /api/auth/start
$("phone-next").addEventListener("click", async () => {
  authError("");
  const phone = normalizePhone($("phone").value.trim());
  if (phone.length < 9) { authError("Введите номер телефона полностью"); return; }
  try {
    const resp = await api("/api/auth/start", { method: "POST", body: JSON.stringify({ phone }) });
    S.phone = phone;
    if (resp.registered) {
      // Зарегистрированный номер — сразу экран пароля
      $("pwd-phone").textContent = phone;
      showStep("auth-step-password");
      $("password").focus();
    } else if (resp.needs_code) {
      // Новый номер — экран кода (код в логе сервера)
      $("code-phone").textContent = phone;
      showStep("auth-step-code");
      $("code").focus();
    }
  } catch (err) {
    authError(err.message);
  }
});
$("phone").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("phone-next").click(); }});

// Возврат к экрану номера
for (const [btn] of [["back-phone"], ["back-phone-2"]]) {
  $(btn).addEventListener("click", (e) => { e.preventDefault(); showStep("auth-step-phone"); });
}

// Экран пароля (зарегистрированный пользователь): POST /api/auth/login
$("password-next").addEventListener("click", async () => {
  authError("");
  const password = $("password").value;
  if (!password) { authError("Введите пароль"); return; }
  try {
    const resp = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: S.phone, password }),
    });
    onAuthOk(resp);
  } catch (err) {
    authError(err.message);
  }
});
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("password-next").click(); }});

// Шаг 2: ввод кода -> POST /api/auth/verify.
// Сервер при повторном /auth/start переиспользует неизрасходованный код,
// так что код из лога остаётся валидным все 5 минут TTL.
$("code-next").addEventListener("click", async () => {
  authError("");
  const code = $("code").value.trim();
  if (!/^\d{6}$/.test(code)) { authError("Код — 6 цифр"); return; }
  try {
    await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ phone: S.phone, code }) });
    S.code = code;
    showStep("auth-step-profile");
    $("first-name").focus();
  } catch (err) {
    if (err.message === "Неверный код" || err.message === "Сначала запросите код") {
      // Код мог истечь (TTL 5 мин) — перевыдаём новый и подсказываем пользователю
      try {
        await api("/api/auth/start", { method: "POST", body: JSON.stringify({ phone: S.phone }) });
        $("code").value = "";
        authError(err.message + ". Новый код отправлен (см. лог сервера).");
      } catch {
        authError(err.message);
      }
    } else {
      authError(err.message);
    }
  }
});
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("code-next").click(); }});

// Шаг 4: @username с debounce 400мс -> GET /api/auth/check-username
let unameTimer = null;
let unameOk = false;
$("username").addEventListener("input", () => {
  clearTimeout(unameTimer);
  unameOk = false;
  updateFinishState();
  const u = $("username").value.trim().replace(/^@/, "");
  const st = $("username-status");
  if (!u) { st.textContent = ""; st.className = ""; return; }
  st.textContent = "проверяю…";
  st.className = "";
  unameTimer = setTimeout(async () => {
    try {
      const r = await api("/api/auth/check-username?username=" + encodeURIComponent(u));
      if ($("username").value.trim().replace(/^@/, "") !== u) return; // устаревший ответ
      unameOk = !!r.available;
      st.textContent = r.available ? "свободен" : (r.reason || "занят");
      st.className = r.available ? "ok" : "busy";
      updateFinishState();
    } catch (err) {
      st.textContent = err.message; st.className = "busy";
    }
  }, 400);
});

// Кнопка «Зарегистрироваться» активна, только когда username свободен
function updateFinishState() {
  $("profile-finish").disabled = !unameOk;
}

// Шаги 3–5: завершение регистрации -> POST /api/auth/finish
$("profile-finish").addEventListener("click", async () => {
  authError("");
  const first_name = $("first-name").value.trim();
  const lastRaw = $("last-name").value.trim();
  const username = $("username").value.trim().replace(/^@/, "");
  const password = $("new-password").value;
  const password_repeat = $("new-password-repeat").value;
  if (!first_name) { authError("Имя обязательно"); return; }
  if (password.length < 8) { authError("Пароль минимум 8 символов"); return; }
  if (password !== password_repeat) { authError("Пароли не совпадают"); return; }
  const body = { phone: S.phone, code: S.code, first_name, username, password, password_repeat };
  if (lastRaw) body.last_name = lastRaw; // пустую фамилию не передаём
  try {
    const resp = await api("/api/auth/finish", { method: "POST", body: JSON.stringify(body) });
    onAuthOk(resp);
  } catch (err) {
    authError(err.message);
  }
});

// Успешная авторизация: сохранить сессию и войти (учитывая pending-ссылку)
function onAuthOk(resp) {
  S.token = resp.token;
  S.user = resp.user;
  saveSession();
  enterApp();
  // Если пользователь пришёл по ссылке /00000001 или /-0000... — открыть её после входа
  if (window.__pendingRef) {
    const ref = window.__pendingRef;
    window.__pendingRef = null;
    setTimeout(() => handleServerRef(ref).catch((e) => toast(e.message)), 300);
  }
}

// ─── Вход в приложение ─────────────────────────────────────────────
async function enterApp() {
  $("auth-screen").hidden = true;
  $("app-screen").hidden = false;
  renderMeName();
  try {
    await loadChats();
  } catch (e) {
    if (e.status === 401) return logout();
    toast("Не удалось загрузить чаты: " + e.message);
  }
  connectWs();
  // Автоматически открываем saved-чат («Избранное»)
  const saved = S.chats.find((c) => c.kind === "saved");
  if (saved) openChat(saved.id);
}

function renderMeName() {
  if (!S.user) return;
  const name = S.user.first_name || S.user.username || S.user.server_id;
  $("me-name").textContent = S.user.username ? `${name} · @${S.user.username}` : name;
}

// ─── Чаты ───────────────────────────────────────────────────────────
async function loadChats() {
  S.chats = await api("/api/chats");
  renderChats();
}

// Подпись чата для списка и заголовка
function chatLabel(chat) {
  if (chat.kind === "saved") return "Избранное";
  if (chat.title) return chat.title;
  return `Чат #${chat.server_id}`;
}

function renderChats() {
  const list = $("chats-list");
  list.textContent = "";
  if (!S.chats.length) {
    const empty = document.createElement("div");
    empty.className = "chats-empty";
    empty.textContent = "Пока нет чатов — создайте группу";
    list.appendChild(empty);
  }
  for (const chat of S.chats) {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === S.currentChatId ? " active" : "");
    item.dataset.id = chat.id;
    const title = document.createElement("span");
    title.textContent = chatLabel(chat);
    const sid = document.createElement("small");
    sid.textContent = chat.server_id;
    item.appendChild(title);
    item.appendChild(sid);
    item.addEventListener("click", () => openChat(chat.id));
    list.appendChild(item);
  }
}

// Создание группы: POST /api/chats/group {kind:"group", title}
$("create-chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("new-chat-name").value.trim();
  if (!title) return;
  try {
    const chat = await api("/api/chats/group", {
      method: "POST",
      body: JSON.stringify({ kind: "group", title }),
    });
    $("new-chat-name").value = "";
    await loadChats();
    openChat(chat.id);
  } catch (err) {
    toast("Создание группы: " + err.message);
  }
});

// Вступление/открытие по ID: внутреннему, server_id пользователя или группы
$("join-chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("join-chat-id").value.trim().replace(/^\//, "");
  if (!raw) return;
  $("join-chat-id").value = "";
  try {
    await handleServerRef(raw);
  } catch (err) {
    toast(err.message);
  }
});

// Разбор ссылки: 8 цифр -> пользователь (dm/saved), -14 цифр -> чат (join)
async function handleServerRef(ref) {
  if (/^\d{8}$/.test(ref)) {
    const user = await api(`/api/users/${ref}`);
    const chat = await api("/api/chats/dm", { method: "POST", body: JSON.stringify({ user_id: user.id }) });
    if (!S.chats.some((c) => c.id === chat.id)) await loadChats();
    openChat(chat.id);
  } else if (/^-\d{14}$/.test(ref)) {
    const chat = await api(`/api/chats/by-id/${ref}`);
    await api(`/api/chats/${chat.id}/join`, { method: "POST" }); // идемпотентно
    if (!S.chats.some((c) => c.id === chat.id)) await loadChats();
    openChat(chat.id);
  } else {
    // Возможно, старый внутренний числовой id
    const id = parseInt(ref, 10);
    if (!Number.isFinite(id)) throw new Error("Неверный формат ID");
    await api(`/api/chats/${id}/join`, { method: "POST" });
    await loadChats();
    openChat(id);
  }
}

// Открытие чата: загрузка истории + подписка по WS
async function openChat(id) {
  S.currentChatId = id;
  const chat = S.chats.find((c) => c.id === id);
  $("chat-title").textContent = chat ? chatLabel(chat) : "Чат";
  $("send-form").hidden = false;
  $("messages").textContent = "";
  renderChats(); // подсветить активный элемент
  try {
    const msgs = await api(`/api/chats/${id}/messages?limit=50`);
    msgs.forEach(appendMessage);
    scrollToBottom();
  } catch (err) {
    if (err.status === 401) return logout();
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
  div.className = "msg " + (m.user_id === (S.user && S.user.id) ? "me" : "other");
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
  if (!S.token) return;
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

// ─── Профиль (модалка) ──────────────────────────────────────────────
$("profile-btn").addEventListener("click", () => {
  if (!S.user) return;
  $("profile-server-id").textContent = S.user.server_id;
  $("profile-username").textContent = S.user.username || "";
  const link = `${location.origin}/${S.user.server_id}`;
  const a = $("profile-link");
  a.href = link;
  a.textContent = link;
  $("profile-modal").hidden = false;
});
$("profile-close").addEventListener("click", () => ($("profile-modal").hidden = true));

// ─── Logout ─────────────────────────────────────────────────────────
function logout() {
  S.wsClosed = true;
  if (S.ws) S.ws.close();
  clearSession();
  S.token = null;
  S.user = null;
  S.currentChatId = null;
  S.chats = [];
  $("app-screen").hidden = true;
  $("app-screen").classList.remove("mobile-chat-open");
  $("profile-modal").hidden = true;
  $("auth-screen").hidden = false;
  $("messages").textContent = "";
  $("send-form").hidden = true;
  $("chat-title").textContent = "Выбери чат";
  showStep("auth-step-phone");
}
$("logout").addEventListener("click", logout);

// Кнопка «назад» в мобильной раскладке
$("back-btn").addEventListener("click", () => {
  $("app-screen").classList.remove("mobile-chat-open");
});

// ─── Старт: восстановление сессии + обработка deep-ссылок ───────────
// /00000001 — пользователь, /-00000000000001 — группа/канал.
// Ссылку запоминаем всегда; применям после входа (или сразу, если сессия есть).
(function captureDeepLink() {
  const m = location.pathname.match(/^\/(\d{8})$/);
  const g = location.pathname.match(/^\/(-\d{14})$/);
  if (m || g) {
    window.__pendingRef = (m || g)[1];
    history.replaceState(null, "", "/"); // URL чистый, ссылка будет обработана
  }
})();

(async function boot() {
  if (restoreSession()) {
    await enterApp();
    if (window.__pendingRef) {
      const ref = window.__pendingRef;
      window.__pendingRef = null;
      try {
        await handleServerRef(ref);
      } catch (err) {
        if (err.status === 401) logout();
        else toast(err.status === 404 ? (/^\d{8}$/.test(ref) ? "Пользователь не найден" : "Чат не найден") : err.message);
      }
    }
  } else {
    showStep("auth-step-phone");
    $("phone").focus();
  }
})();
