/* CipherTalk service worker: network-first для оболочки, API не кешируем.
   Плюс фон: собственный WebSocket для уведомлений при закрытой вкладке.

   Как это работает (простая схема без гонок):
   1. Страница при логине шлёт ct-bg-init { token, user, granted }.
   2. SW хранит эти данные в Cache Storage ('ct-bg-creds') — они переживают
      выгрузку и перезапуск SW (в отличие от переменных).
   3. SW держит свой WebSocket. new_message приходит одновременно странице
      и фону; уведомление показывает ТОТ, кто первый: страница, если её
      вкладка видима и в фокусе, иначе фон. Фон узнаёт о показе страницы
      через ct-notif-shown и не дублирует. */
// Версия кэша поднята (v19): старый Service Worker отдавал index.html с
// хардкодом «U» и старый app.js — из-за этого аватары «не чинились».
const CACHE = 'ciphertalk-v19';
const CREDS_CACHE = 'ct-bg-creds';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/calls.js',
  '/chat-features.js',
  '/e2ee.js',
  '/i18n.js',
  '/icons.js',
  '/features.css',
  '/icons.css',
  '/motion.css',
  '/motion.js',
  '/layout.css',
  '/cursor.css',
  '/cursor.js',
  '/owner.css',
  '/manifest.json',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== CREDS_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => {
    if (hit) return hit;
    const accept = req.headers.get('accept') || '';
    if (accept.includes('text/html')) return caches.match('/index.html');
    return new Response('', { status: 404, statusText: 'Not Found' });
  }))
  );
});

// ==================== ФОНОВЫЕ УВЕДОМЛЕНИЯ (закрытая вкладка) ====================
// Service worker держит собственный WebSocket к серверу. Если ни одна вкладка
// приложения не активна (закрыта/свёрнута), сообщения приходят сюда и
// показываются как системные уведомления прямо из ОС.

const BG_PING_MS = 25000;
let bgWs = null;
let bgReconnectTimer = null;
let bgPingTimer = null;
let bgCreds = null;          // { token, user: {id}, granted } — синхронизируется с Cache Storage
let recentShown = new Map();  // chatId -> timestamp: уведомления, показанные страницей (дедуп)
const pendingNotifBody = new Map(); // chatId -> { body, at }: превью пришло раньше нашего уведомления
const bodyWaiters = new Map();      // chatId -> [{resolve, timer}]: ждём расшифрованное превью от страницы
let credsLoaded = false;      // попытка восстановить креды из хранилища уже была

// Ждём расшифрованный текст сообщения от страницы (ct-notif-body).
// Страница расшифровывает почти мгновенно, если вкладка открыта; timeout
// защищает от зависания, когда вкладки нет.
function waitForNotifBody(chatId, timeoutMs) {
  return new Promise(resolve => {
    const p = pendingNotifBody.get(chatId);
    if (p && p.body && Date.now() - p.at < 15000) {
      pendingNotifBody.delete(chatId);
      resolve(p.body);
      return;
    }
    let list = bodyWaiters.get(chatId);
    if (!list) { list = []; bodyWaiters.set(chatId, list); }
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        const l = bodyWaiters.get(chatId) || [];
        const i = l.indexOf(waiter);
        if (i >= 0) l.splice(i, 1);
        resolve(null);
      }, timeoutMs)
    };
    list.push(waiter);
  });
}

function deliverToWaiters(chatId, body) {
  const list = bodyWaiters.get(chatId);
  if (!list || !list.length) return false;
  while (list.length) {
    const w = list.pop();
    clearTimeout(w.timer);
    w.resolve(body);
  }
  return true;
}

// ----------Постоянное хранилище кредов (переживает выгрузку SW) ----------
// Cache Storage хранит пары request->response; ключом делаем фиксированный URL.
async function persistCreds(creds) {
  bgCreds = creds;
  try {
    const cache = await caches.open(CREDS_CACHE);
    const key = new Request('https://ciphertalk.internal/bg-creds');
    await cache.put(key, new Response(JSON.stringify(creds || null)));
  } catch (e) { /* ignore */ }
}

async function loadCreds() {
  if (credsLoaded) return bgCreds;
  credsLoaded = true;
  try {
    const cache = await caches.open(CREDS_CACHE);
    const hit = await cache.match('https://ciphertalk.internal/bg-creds');
    if (hit) {
      const data = await hit.json();
      if (data && data.token) bgCreds = data;
    }
  } catch (e) { /* ignore */ }
  return bgCreds;
}

async function clearCreds() {
  bgCreds = null;
  try {
    const cache = await caches.open(CREDS_CACHE);
    await cache.delete(new Request('https://ciphertalk.internal/bg-creds'));
  } catch (e) { /* ignore */ }
}

// Как только какая-то вкладка выходит в фокус — закрываем наши уведомления:
// пользователь уже видит чат.
self.addEventListener('focus', () => {
  self.registration.getNotifications().then(list => {
    list.forEach(n => n.close());
  }).catch(() => {});
});

function bgDisconnect() {
  clearTimeout(bgReconnectTimer);
  clearInterval(bgPingTimer);
  bgReconnectTimer = null;
  bgPingTimer = null;
  if (bgWs) {
    const s = bgWs;
    bgWs = null;
    s.onclose = null;
    try { s.close(); } catch (e) { /* ignore */ }
  }
}

function bgScheduleReconnect(delay = 3000) {
  if (bgReconnectTimer) return;
  bgReconnectTimer = setTimeout(() => {
    bgReconnectTimer = null;
    bgConnect();
  }, delay);
}

async function bgConnect() {
  if (bgWs && bgWs.readyState !== WebSocket.CLOSED) return;
  const creds = bgCreds || await loadCreds();
  if (!creds || !creds.token) return; // кредов нет — дождёмся ct-bg-init от страницы
  if (creds.granted === false) return; // разрешения нет — показывать нечего

  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    bgScheduleReconnect(10000);
    return;
  }
  bgWs = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token: creds.token }));
    clearInterval(bgPingTimer);
    bgPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, BG_PING_MS);
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === 'auth_error') {
      // Токен недействителен — переподключение бессмысленно до нового входа.
      bgDisconnect();
      clearCreds();
      return;
    }
    if (msg.type === 'pong' || msg.type === 'chats' || msg.type === 'folders') return;
    if (msg.type !== 'new_message' || !msg.message) return;

    const m = msg.message;
    const senderId = Number(m.senderId ?? m.sender_id) || 0;
    const isOwn = bgCreds && bgCreds.user && senderId && senderId === Number(bgCreds.user.id);
    if (isOwn) return;

    const chatId = Number(m.chatId ?? m.chat_id) || null;

    // Дедупликация: страница показывает сама, когда её вкладка видима И в
    // фокусе, и сообщает о показе через ct-notif-shown. Проверяем оба условия.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.some(c => c.visibilityState === 'visible' && c.focused)) return;
    const shownAt = recentShown.get(chatId);
    if (shownAt && Date.now() - shownAt < 5000) return; // страница уже показала

    // Разрешение могло появиться позже — фон живёт по последнему сообщению страницы
    if (bgCreds && bgCreds.granted === false) return;

    // Контент end-to-end шифрован — в фоне доступен только тип сообщения,
    // поэтому для медиа показываем метку (📷/🎥/🎤/…). Для ТЕКСТОВЫХ сообщений
    // заглушек не показываем: страница при открытой вкладке почти сразу шлёт
    // расшифрованный текст (ct-notif-body) — ждём его короткое время и
    // показываем уведомление с настоящим текстом. Если за это время превью
    // не пришло (вкладка закрыта и расшифровать некому) — молчим: служебные
    // «Сообщение» / «Зашифрованное сообщение» хуже, чем одно пропущенное
    // уведомление (непрочитанный счётчик в списке чатов всё равно виден).
    const typeLabels = {
      image: '📷 Фото',
      photo: '📷 Фото',
      video: '🎥 Видео',
      round: '🎥 Видеосообщение',
      voice: '🎤 Голосовое сообщение',
      file: '📄 Файл',
      sticker: '🎨 Стикер',
      custom_sticker: '🎨 Стикер',
      call: '📞 Звонок'
    };
    const title = String(m.senderName || m.sender_name || 'CipherTalk');
    let body = typeLabels[m.type] || null;

    try {
      // Превью могло прийти раньше этого сообщения (сокет страницы быстрее
      // фонового) — берём его сразу.
      if (chatId != null && pendingNotifBody.has(chatId)) {
        const p = pendingNotifBody.get(chatId);
        pendingNotifBody.delete(chatId);
        if (p && p.body && Date.now() - p.at < 15000) body = p.body;
      }
      // Текстовое сообщение без готового превью: подождём до 2 секунд —
      // открытая страница расшифровывает текст практически мгновенно.
      if (!body && chatId != null) {
        body = await waitForNotifBody(chatId, 2000);
      }
      if (!body) return; // текста нет и показать нечего — не плодим заглушки
      await self.registration.showNotification(title, {
        body,
        icon: '/icons/icon.svg',
        badge: '/icons/icon.svg',
        tag: chatId != null ? `chat-${chatId}` : undefined,
        renotify: chatId != null,
        data: { chatId, url: '/', body },
        vibrate: [80, 40, 80]
      });
      // Ждём немного расшифрованное превью от страницы: если она открыта
      // (но не в фокусе / видима) — она сама перезаменит уведомление через
      // ct-notif-body. Здесь лишь подстраховка, ничего лишнего не делаем.
    } catch (e) {
      console.warn('[CT-SW] showNotification failed:', e && e.message);
    }
  };

  ws.onclose = () => {
    if (bgWs === ws) bgWs = null;
    clearInterval(bgPingTimer);
    // Реконнект только если ещё есть креды (страница залогинена)
    if (bgCreds && bgCreds.token) bgScheduleReconnect(5000);
  };

  ws.onerror = () => { /* onclose выполнит реконнект */ };
}

// Страница сообщает нам данные аккаунта; SW может быть выгружен в любой
// момент — поэтому всё дублируем в Cache Storage и восстанавливаем на activate.
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'ct-bg-init') {
    const creds = {
      token: d.token || null,
      user: d.user ? { id: d.user.id } : null,
      granted: d.granted !== false
    };
    if (!creds.token) {
      bgDisconnect();
      clearCreds();
      return;
    }
    const tokenChanged = !bgCreds || bgCreds.token !== creds.token;
    const grantChanged = bgCreds && bgCreds.granted === false && creds.granted === true;
    persistCreds(creds);
    // Переподключаемся, если соединения нет, оно мёртвое, токен сменился или
    // разрешение только что выдали. Живой OPEN-сокет не рвём.
    const alive = bgWs && bgWs.readyState !== WebSocket.CLOSED;
    if (!alive || tokenChanged || grantChanged) {
      bgDisconnect();
      bgConnect();
    }
    return;
  }
  if (d.type === 'ct-bg-logout') {
    bgDisconnect();
    clearCreds();
    return;
  }
  if (d.type === 'ct-bg-pause') {
    // Страница видима и в фокусе — она сама показывает уведомления.
    // закрываем фоновый сокет, чтобы не плодить соединения и дубли.
    bgDisconnect();
    return;
  }
  if (d.type === 'ct-notif-shown') {
    recentShown.set(d.chatId, Date.now());
    if (recentShown.size > 50) {
      const cutoff = Date.now() - 10000;
      for (const [k, t] of recentShown) if (t < cutoff) recentShown.delete(k);
    }
    return;
  }
  // Страница прислала расшифрованный текст сообщения. Если фон уже показал
  // уведомление — тихо заменяем его текст (тот же tag, silent). Если ждём
  // превью (waitForNotifBody) — отдаём ожидающему. Иначе сохраняем на случай,
  // что фоновое сообщение дойдёт чуть позже.
  if (d.type === 'ct-notif-body') {
    const chatId = Number(d.chatId) || null;
    const body = String(d.body || '');
    if (chatId == null || !body) return;
    const hadWaiter = deliverToWaiters(chatId, body);
    self.registration.getNotifications().then(list => {
      let found = false;
      for (const n of list) {
        const data = n.data || {};
        if (Number(data.chatId) !== chatId) continue;
        found = true;
        if (data.body === body) return; // уже актуально
        try {
          n.close();
          self.registration.showNotification(n.title, {
            body,
            icon: '/icons/icon.svg',
            badge: '/icons/icon.svg',
            tag: `chat-${chatId}`,
            renotify: true,
            silent: true,
            data: { chatId, url: '/', body }
          });
        } catch (e) { /* ignore */ }
        return;
      }
      // Уведомления ещё нет — сохраняем превью, чтобы фон подставил его
      // сразу при показе (или отдал ожидающему waitForNotifBody).
      if (!found && !hadWaiter) {
        pendingNotifBody.set(chatId, { body, at: Date.now() });
        if (pendingNotifBody.size > 30) {
          const cutoff = Date.now() - 20000;
          for (const [k, v] of pendingNotifBody) if (v.at < cutoff) pendingNotifBody.delete(k);
        }
      }
    }).catch(() => {});
    return;
  }
});

// SW перезапущен после выгрузки — восстанавливаем фон из хранилища.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const creds = await loadCreds();
    if (creds && creds.token && creds.granted !== false && !bgWs) {
      bgConnect().catch(() => {});
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const url = '/';
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        if (data.chatId) client.postMessage({ type: 'ct-open-chat', chatId: data.chatId });
        return client.focus();
      }
    }
    if (self.clients.openWindow) {
      const c = await self.clients.openWindow(url);
      if (c && data.chatId) setTimeout(() => c.postMessage({ type: 'ct-open-chat', chatId: data.chatId }), 2000);
      return c;
    }
  })());
});
