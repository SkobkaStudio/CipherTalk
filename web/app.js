// ============================================================
// CipherTalk — логика фронтенда (чистый JS, без фреймворков).
// - Авторизация: регистрация/логин, хранение JWT в localStorage
// - REST API: чаты, сообщения, пользователи
// - WebSocket: real-time доставка новых сообщений
// ============================================================
"use strict";

// ---------- Состояние приложения ----------
const state = {
    token: localStorage.getItem("ct_token") || "",
    user: JSON.parse(localStorage.getItem("ct_user") || "null"), // {userId, username, displayName}
    chats: [],            // список чатов с сервера
    activeChatId: null,   // открытый сейчас чат
    messages: [],         // сообщения открытого чата
    ws: null,             // WebSocket-соединение
    wsRetry: 0,           // счётчик переподключений
};

// ---------- Короткие помощники ----------
const $ = (id) => document.getElementById(id);

// Запрос к REST API с Bearer-токеном
async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    const resp = await fetch(path, { ...options, headers });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || ("HTTP " + resp.status));
    return data;
}

// Экранирование HTML для безопасной вставки текста сообщений
function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Инициалы для аватара из имени
function initials(name) {
    return (name || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
}

// Формат времени метки сообщения (HH:MM)
function fmtTime(tsSec) {
    const d = new Date(Number(tsSec) * 1000);
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// ---------- Экран авторизации ----------
let authMode = "login"; // активная вкладка: login | register

$("tabLogin").addEventListener("click", () => setAuthMode("login"));
$("tabRegister").addEventListener("click", () => setAuthMode("register"));

function setAuthMode(mode) {
    authMode = mode;
    $("tabLogin").classList.toggle("active", mode === "login");
    $("tabRegister").classList.toggle("active", mode === "register");
    $("displayNameField").style.display = mode === "register" ? "block" : "none";
    $("authSubmit").textContent = mode === "register" ? "Создать аккаунт" : "Войти";
    $("authError").textContent = "";
}

$("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("authError").textContent = "";
    const username = $("username").value.trim();
    const password = $("password").value;
    try {
        // Один и тот же обработчик для регистрации и входа
        const path = authMode === "register" ? "/api/register" : "/api/login";
        const body = { username, password };
        if (authMode === "register") body.displayName = $("displayName").value.trim();
        const data = await api(path, { method: "POST", body: JSON.stringify(body) });
        // Сохраняем токен и профиль
        state.token = data.token;
        state.user = { userId: data.userId, username: data.username, displayName: data.displayName };
        localStorage.setItem("ct_token", state.token);
        localStorage.setItem("ct_user", JSON.stringify(state.user));
        enterApp();
    } catch (err) {
        $("authError").textContent = err.message;
    }
});

// Выход из аккаунта
$("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem("ct_token");
    localStorage.removeItem("ct_user");
    if (state.ws) { state.ws.close(); state.ws = null; }
    state.token = ""; state.user = null;
    location.reload();
});

// ---------- Вход в основной интерфейс ----------
async function enterApp() {
    $("authScreen").classList.add("hidden");
    $("mainScreen").classList.remove("hidden");
    $("myName").textContent = state.user.displayName;
    $("myAvatar").textContent = initials(state.user.displayName);
    await loadChats();
    connectWebSocket();
}

// ---------- Список чатов ----------
async function loadChats() {
    try {
        const data = await api("/api/chats");
        state.chats = data.chats || [];
        renderChatList();
    } catch (err) {
        console.error("не удалось загрузить чаты:", err);
    }
}

function chatDisplayName(chat) {
    if (chat.type === "group") return chat.name || "Группа";
    // Для личного чата показываем имя собеседника (не моё)
    const other = (chat.names || []).find(n => n !== state.user.displayName) ||
                  (chat.names || [])[0] || "Чат";
    return other;
}

function renderChatList() {
    const list = $("chatList");
    if (!state.chats.length) {
        list.innerHTML = '<div class="chat-list-empty">Чатов пока нет.<br>Найдите пользователя через поиск выше.</div>';
        return;
    }
    list.innerHTML = state.chats.map(c => `
        <div class="chat-item ${c.id == state.activeChatId ? "active" : ""}" data-id="${c.id}">
            <div class="avatar">${esc(initials(chatDisplayName(c)))}</div>
            <div class="chat-item-body">
                <div class="chat-item-title">${esc(chatDisplayName(c))}</div>
                <div class="chat-item-preview">${esc(c.preview || "нет сообщений")}</div>
            </div>
        </div>`).join("");
    // Клик по чату — открыть переписку
    list.querySelectorAll(".chat-item").forEach(el =>
        el.addEventListener("click", () => openChat(el.dataset.id)));
}

// ---------- Поиск пользователей ----------
let searchTimer = null;
$("userSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doUserSearch, 250); // debounce от лишних запросов
});

async function doUserSearch() {
    const q = $("userSearch").value.trim().toLowerCase();
    const box = $("userResults");
    if (!q) { box.classList.add("hidden"); return; }
    try {
        const data = await api("/api/users");
        const users = (data.users || [])
            .filter(u => u.id != state.user.userId &&
                (u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)))
            .slice(0, 8);
        box.innerHTML = users.length ? users.map(u => `
            <div class="user-item" data-id="${u.id}">
                <div class="avatar">${esc(initials(u.displayName))}</div>
                <div>
                    <div class="user-item-name">${esc(u.displayName)}</div>
                    <div class="user-item-login">@${esc(u.username)}</div>
                </div>
            </div>`).join("")
            : '<div class="chat-list-empty">Никого не найдено</div>';
        box.classList.remove("hidden");
        // Клик по пользователю — создать/открыть личный чат
        box.querySelectorAll(".user-item").forEach(el =>
            el.addEventListener("click", async () => {
                box.classList.add("hidden");
                $("userSearch").value = "";
                const created = await api("/api/chats", {
                    method: "POST",
                    body: JSON.stringify({ withUserId: Number(el.dataset.id) })
                });
                await loadChats();
                openChat(created.chatId);
            }));
    } catch (err) {
        console.error(err);
    }
}

document.addEventListener("click", (e) => {
    // Скрываем результаты поиска при клике вне блока
    if (!e.target.closest(".search-box")) $("userResults").classList.add("hidden");
});

// ---------- Окно чата и сообщения ----------
async function openChat(chatId) {
    state.activeChatId = chatId;
    renderChatList();
    const chat = state.chats.find(c => c.id == chatId);
    $("emptyState").classList.add("hidden");
    $("chatView").classList.remove("hidden");
    if (chat) {
        $("chatTitle").textContent = chatDisplayName(chat);
        $("chatAvatar").textContent = initials(chatDisplayName(chat));
        $("chatSub").textContent = chat.type === "group"
            ? `группа · ${(chat.names || []).length} участников`
            : "личный чат";
    }
    // Загружаем историю сообщений
    try {
        const data = await api(`/api/messages?chatId=${chatId}&limit=200`);
        state.messages = data.messages || [];
        renderMessages();
    } catch (err) {
        console.error(err);
    }
    $("messageInput").focus();
}

function renderMessages() {
    const box = $("messages");
    box.innerHTML = state.messages.map(m => messageHtml(m)).join("");
    box.scrollTop = box.scrollHeight; // прокрутка к последним сообщениям
}

// HTML одного сообщения-пузыря
function messageHtml(m) {
    const mine = m.senderId == state.user.userId;
    const cls = mine ? "out" : "in";
    const sender = (!mine && state.chats.find(c => c.id == m.chatId)?.type === "group")
        ? `<div class="sender">${esc(m.senderName)}</div>` : "";
    return `<div class="msg ${cls}">${sender}<div>${esc(m.text)}</div>
            <div class="meta">${fmtTime(m.createdAt)}</div></div>`;
}

// Отправка нового сообщения
$("messageForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("messageInput").value.trim();
    if (!text || !state.activeChatId) return;
    $("messageInput").value = "";
    try {
        await api("/api/messages", {
            method: "POST",
            body: JSON.stringify({ chatId: Number(state.activeChatId), text })
        });
        // Сообщение придёт обратно по WebSocket (эхо) — дубликат отсекается по id
    } catch (err) {
        alert("Не удалось отправить: " + err.message);
    }
});

// ---------- WebSocket real-time ----------
function connectWebSocket() {
    if (!state.token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`;
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => {
        state.wsRetry = 0;
        setWsStatus("online", "в сети");
    };

    ws.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        handleWsEvent(data);
    };

    ws.onclose = () => {
        setWsStatus("offline", "нет соединения — переподключение…");
        // Автопереподключение с экспоненциальной задержкой (до 15 секунд)
        const delay = Math.min(15000, 500 * Math.pow(2, state.wsRetry++));
        setTimeout(() => { if (state.token) connectWebSocket(); }, delay);
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
}

function setWsStatus(cls, text) {
    const el = $("wsStatus");
    el.className = "ws-status " + cls;
    el.textContent = text;
}

// Обработка событий, прилетевших по WebSocket
function handleWsEvent(data) {
    if (data.type !== "message") return;
    const isMineEcho = data.senderId == state.user.userId &&
                       state.messages.some(m => m.id == data.id);
    if (isMineEcho) return; // эхо собственного сообщения уже учтено

    if (data.chatId == state.activeChatId) {
        // Открыт этот чат — дописываем пузырёк сразу
        state.messages.push(data);
        $("messages").insertAdjacentHTML("beforeend", messageHtml(data));
        $("messages").scrollTop = $("messages").scrollHeight;
    } else {
        // Другой чат — подсвечиваем в списке, обновляем превью
        const chat = state.chats.find(c => c.id == data.chatId);
        if (chat) { chat.preview = data.text; renderChatList(); }
        else loadChats();
    }
    // Обновляем превью и порядок чатов на боковой панели
    const idx = state.chats.findIndex(c => c.id == data.chatId);
    if (idx > 0) {
        const [c] = state.chats.splice(idx, 1);
        c.preview = data.text;
        state.chats.unshift(c);
        renderChatList();
    }
}

// ---------- Старт приложения ----------
(async function boot() {
    // Если токен сохранён — проверяем его и сразу заходим
    if (state.token && state.user) {
        try {
            await api("/api/me"); // валидация JWT на сервере
            enterApp();
            return;
        } catch {
            // Токен недействителен — очищаем и показываем форму входа
            localStorage.removeItem("ct_token");
            localStorage.removeItem("ct_user");
            state.token = ""; state.user = null;
        }
    }
    $("authScreen").classList.remove("hidden");
})();

// ---------- Keepalive: периодический пинг, чтобы соединение не закрывалось ----------
setInterval(() => {
    // Раз в 25 секунд шлём прикладной ping (сервер отвечает {"type":"pong"})
    if (state.ws && state.ws.readyState === WebSocket.OPEN)
        state.ws.send(JSON.stringify({ type: "ping" }));
}, 25000);
