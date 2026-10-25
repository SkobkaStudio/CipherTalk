'use strict';

/**
 * Клиентский список создателей (разработчиков) CipherTalk.
 * Синхронизирован с сервером: src/utils/creators.js
 *
 * Уровни корон: 'gold' | 'silver' | 'bronze'.
 * publicId — публичный 8-значный id (как в адресной строке /00000001).
 */
window.CREATORS = [
  {
    publicId: '00000001',
    name: 'Skobka',
    level: 'gold',
    role: 'Основатель · Lead Developer',
    description: 'Создал CipherTalk с нуля: архитектура сервера, сквозное шифрование E2EE, система публичных ID и ссылок чатов.'
  },
  {
    publicId: '35742553',
    name: 'Cipher',
    level: 'silver',
    role: 'Backend Developer',
    description: 'База данных SQLCipher, WebSocket-сервис, presence и автоудаление сообщений.'
  },
  {
    publicId: '00000002',
    name: 'Nova',
    level: 'bronze',
    role: 'UI/UX Designer',
    description: 'Интерфейс мессенджера, тёмная тема, анимации и адаптивная вёрстка.'
  }
];

window.Creators = (function () {
  const byToken = new Map();
  for (const c of window.CREATORS) {
    const key = String(c.publicId || '').replace(/^0+/, '') || String(c.publicId);
    byToken.set(key, c);
  }

  function get(publicId) {
    const raw = String(publicId == null ? '' : publicId).trim();
    if (!raw) return null;
    const key = raw.replace(/^0+/, '') || raw;
    return byToken.get(key) || null;
  }

  /** Уровень короны по public_id пользователя или токену из URL. */
  function levelOf(publicId) {
    const c = get(publicId);
    return c ? c.level : null;
  }

  /** Корона для объекта-пользователя (member/user): берём public_id. */
  function ofUser(user) {
    if (!user) return null;
    return get(user.public_id || user.publicId);
  }

  return { list: window.CREATORS, get, levelOf, ofUser };
})();
