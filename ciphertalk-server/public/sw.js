/* CipherTalk service worker: network-first для оболочки, API не кешируем.
   Плюс фон: собственный WebSocket для уведомлений при закрытой вкладке. */
const CACHE = 'ciphertalk-v13';
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
let lastKnownToken = null; // последний валидный токен (переживает перезагрузку SW)
let notifMuted = false;    // страница явно сообщила, что уведомления выключены

// Как только какая-то вкладка выходит в фокус — закрываем наши уведомления:
// пользователь уже видит чат.
self.addEventListener('focus', () => {
  self.registration.getNotifications().then(list => {
    list.forEach(n => n.close());
  }).catch(() => {});
});

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
  // Сначала свежий токен от живых вкладок, иначе — последний известный
  const token = (await getTokenFromClients()) || lastKnownToken;
  if (!token) return; // выхода нет — попробуем позже, когда страница откроется
  lastKnownToken = token;
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
      lastKnownToken = null;
      return;
    }
    if (msg.type === 'pong' || msg.type === 'chats' || msg.type === 'folders') return;
    if (msg.type !== 'new_message' || !msg.message) return;

    // Пока хоть одна вкладка видима — уведомления показывает страница (без дублей).
    // Вкладка видимая, но НЕ в фокусе — страница тоже покажет (см. showNotification),
    // поэтому пропускаем только по-настоящему активные вкладки.
    const active = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (active.some(c => c.visibilityState === 'visible' && c.focused)) return;

    // Не показываем уведомления, если пользователь явно отключил их на странице
    if (notifMuted) return;

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
    } catch (e) {
      // Android требует предварительного разрешения — при отказе просим страницу
      // показать системный промпт и переслать нам результат через ct-bg-init
      getTokenFromClients().catch(() => null);
    }
  };

  ws.onclose = () => {
    if (bgWs === ws) bgWs = null;
    clearInterval(bgPingTimer);
    // Если вкладок приложения больше нет, переподключение из SW невозможно
    // (негде взять токен) — ждём ct-bg-init от страницы. Иначе реконнект.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length) bgScheduleReconnect(5000);
    });
  };

  ws.onerror = () => { /* onclose выполнит реконнект */ };
}

// Токен и пользователь лежат в localStorage страницы — читаем через postMessage
// (в самом SW доступа к localStorage нет).
async function getTokenFromClients() {
  // Ответственный за токен клиент должен быть «живой» вкладкой приложения:
  // hidden-вкладка Chrome может быть заморожена (frozen) и не ответить.
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const candidates = list.filter(c => c.visibilityState === 'visible')
    .concat(list.filter(c => c.visibilityState !== 'visible'));
  return new Promise(resolve => {
    if (!candidates.length) return resolve(null);
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', handler);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 3000);
    const handler = (e) => {
      if (e.data && e.data.type === 'ct-bg-creds-response') {
        finish(e.data.token || null);
        if (e.data.user) currentUser = e.data.user;
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    candidates.forEach(c => { try { c.postMessage({ type: 'ct-bg-creds-request' }); } catch (err) { /* ignore */ } });
  });
}

// Страница сообщает нам данные аккаунта (для фильтра собственных сообщений)
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'ct-bg-mute') {
    notifMuted = !!d.muted;
    return;
  }
  if (d.type === 'ct-bg-init') {
    currentUser = d.user ? { id: d.user.id } : null;
    if (typeof d.muted === 'boolean') notifMuted = d.muted;
    if (!d.token) { bgDisconnect(); lastKnownToken = null; return; }
    lastKnownToken = d.token;
    // Переподключаемся, если соединения нет или оно мёртвое.
    // ВАЖНО: живой OPEN/CLOSING-сокет не рвём — иначе при каждой перезагрузке
    // страницы новый сокет упирался бы в «уже авторизован» и фон замолкал.
    const alive = bgWs && bgWs.readyState !== WebSocket.CLOSED;
    if (!alive) {
      bgDisconnect();
      bgConnect();
    }
  }
  if (d.type === 'ct-bg-logout') {
    currentUser = null;
    lastKnownToken = null;
    bgDisconnect();
  }
});

// SW может быть выгружен браузером и перезапущен — восстанавливаемся из
// последнего известного токена, чтобы фон не молчал до следующего сообщения от страницы.
self.addEventListener('activate', () => {
  if (lastKnownToken && !bgWs) bgConnect().catch(() => {});
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
