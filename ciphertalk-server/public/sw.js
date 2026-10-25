/* CipherTalk service worker: network-first для оболочки, API не кешируем.
   Плюс фон: собственный WebSocket для уведомлений при закрытой вкладке. */
const CACHE = 'ciphertalk-v12';
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
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
// приложения не активна (закрыта/усыплена), сообщения приходят сюда и показываются
// как системные уведомления прямо из ОС.

const BG_PING_MS = 30000;
let bgWs = null;
let bgReconnectTimer = null;
let bgPingTimer = null;
let currentUser = null; // {id} — приходит из страницы через ct-bg-init
let bgStaleToken = false; // сервер отклонил токен — ждём свежий от страницы

function hasVisibleAppClient() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(list => list.some(c => c.visibilityState === 'visible'));
}

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
  if (bgWs) return;
  const token = await getTokenFromClients();
  if (!token) return; // выхода нет — попробуем позже, когда страница откроется
  bgStaleToken = false;

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
    ws.send(JSON.stringify({ type: 'auth', token }));
    clearInterval(bgPingTimer);
    bgPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, BG_PING_MS);
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === 'auth_error') {
      // Токен недействителен — переподключение бессмысленно до нового входа
      bgDisconnect();
      bgStaleToken = true;
      return;
    }
    if (msg.type !== 'new_message' || !msg.message) return;

    // Пока хоть одна вкладка видима — уведомления показывает страница (без дублей)
    if (await hasVisibleAppClient()) return;

    // Поля приходят в camelCase (см. websocketService.js), поддержим оба варианта
    const m = msg.message;
    const senderId = Number(m.senderId ?? m.sender_id) || 0;
    const isOwn = currentUser && senderId && senderId === Number(currentUser.id);
    if (isOwn) return;

    const title = String(m.senderName || m.sender_name || 'CipherTalk');
    const chatId = Number(m.chatId ?? m.chat_id) || null;
    // Контент end-to-end шифрован — в фоне доступен только тип сообщения
    const typeLabels = {
      photo: '📷 Фото',
      video: '🎥 Видео',
      voice: '🎤 Голосовое сообщение',
      file: '📎 Файл',
      sticker: '💬 Стикер',
      call: '📞 Звонок'
    };
    const body = typeLabels[m.type] || 'Новое сообщение';

    try {
      await self.registration.showNotification(title, {
        body,
        icon: '/icons/icon.svg',
        badge: '/icons/icon.svg',
        tag: chatId ? `chat-${chatId}` : undefined,
        renotify: !!chatId,
        data: { chatId, url: '/' },
        vibrate: [80, 40, 80]
      });
    } catch (e) { /* ignore */ }
  };

  ws.onclose = () => {
    if (bgWs === ws) bgWs = null;
    clearInterval(bgPingTimer);
    bgScheduleReconnect(5000);
  };

  ws.onerror = () => { /* onclose выполнит реконнект */ };
}

// Токен и пользователь лежат в localStorage страницы — читаем через postMessage
// (в самом SW доступа к localStorage нет).
function getTokenFromClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    return new Promise(resolve => {
      if (!list.length) return resolve(null);
      const pending = list.length;
      let settled = false;
      let timer = setTimeout(() => { finish(null); }, 2000);
      const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const handler = (e) => {
        if (e.data && e.data.type === 'ct-bg-creds-response') {
          navigator.serviceWorker.removeEventListener('message', handler);
          finish(e.data.token || null);
        }
      };
      navigator.serviceWorker.addEventListener('message', handler);
      list.forEach(c => c.postMessage({ type: 'ct-bg-creds-request' }));
    });
  });
}

// Страница сообщает нам данные аккаунта (для фильтра собственных сообщений)
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'ct-bg-init') {
    currentUser = d.user ? { id: d.user.id } : null;
    // Если токен устарел или соединение живо — переподключаемся со свежим токеном
    const needReconnect = bgStaleToken || (bgWs && bgWs.readyState !== WebSocket.OPEN);
    if (d.token) {
      if (bgWs && !needReconnect) return; // уже подключены
      bgDisconnect();
      bgConnect();
    } else {
      bgDisconnect();
    }
  }
  if (d.type === 'ct-bg-logout') {
    currentUser = null;
    bgDisconnect();
  }
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
