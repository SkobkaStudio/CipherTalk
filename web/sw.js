/* CipherTalk service worker: background Web Push notifications. */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'CipherTalk', body: event.data ? event.data.text() : 'Новое сообщение' };
  }

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients) {
        try {
          client.postMessage({ type: 'push-received', payload: data });
        } catch {
          /* client may be closing */
        }
      }
      // The page already shows its own notification when it is visible.
      if (clients.some((client) => client.visibilityState === 'visible')) return;
      const title = data.title || 'CipherTalk';
      const options = {
        body: data.body || 'Новое сообщение',
        tag: data.tag || 'ciphertalk',
        renotify: true,
        data: {
          chat_id: data.chat_id || null,
          url: data.url || '/',
        },
      };
      if (data.icon) options.icon = data.icon;
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.url || '/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({
            type: 'open-chat',
            chatId: data.chat_id,
            url: targetUrl,
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients) {
        client.postMessage({ type: 'push-resubscribe' });
      }
    })(),
  );
});
