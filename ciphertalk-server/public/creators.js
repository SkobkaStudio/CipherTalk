'use strict';

/**
 * Клиентский список создателей (разработчиков) CipherTalk.
 * Синхронизирован с сервером: src/utils/creators.js
 *
 * Уровни корон: 'gold' | 'silver' | 'bronze'.
 * Идентификация — ПО НОМЕРУ ТЕЛЕФОНА разработчика (phone), а не по id.
 */

window.CREATORS = [
  {
    phone: '+79609611353',
    name: 'Skobka',
    level: 'gold',
    role: 'Основатель · Lead Developer',
    description: 'Создал CipherTalk с нуля: архитектура сервера, сквозное шифрование E2EE, система публичных ID и ссылок чатов.'
  },
  {
    phone: '+79039952506',
    name: 'Максим',
    level: 'gold',
    role: 'Основатель · Lead Developer',
    description: 'Создал CipherTalk с нуля: архитектура сервера, сквозное шифрование E2EE, система публичных ID и ссылок чатов.'
  }
  // Закомментированные примеры для будущего расширения:
  // { phone: '+79990000002', name: 'Cipher', level: 'silver', role: 'Backend Developer', description: '...' },
  // { phone: '+79990000003', name: 'Nova', level: 'bronze', role: 'UI/UX Designer', description: '...' }
];

window.Creators = (function () {
  // Канонический вид номера: только цифры, 8... -> 7...
  function digits(value) {
    const d = String(value == null ? '' : value).replace(/\D/g, '');
    return d.length === 11 && d[0] === '8' ? '7' + d.slice(1) : d;
  }

  const byPhone = new Map();
  for (const c of window.CREATORS) {
    byPhone.set(digits(c.phone), c);
  }

  /** Карточка разработчика по номеру телефона (любой записи) или null. */
  function get(phone) {
    const key = digits(phone);
    if (!key) return null;
    return byPhone.get(key) || null;
  }

  /** Уровень короны ('gold' | 'silver' | 'bronze') по номеру телефона или null. */
  function levelOf(phone) {
    const c = get(phone);
    return c ? c.level : null;
  }

  /**
   * Корона для объекта пользователя/участника.
   * ВАЖНО: телефоны чужих пользователей маскируются сервером.
   * Поэтому мы проверяем не только user.phone, но и специальные
   * поля creator_phone / creator_level, которые сервер передаёт
   * для разработчиков даже при маскировке.
   */
  function ofUser(user) {
    if (!user) return null;

    // 1. Прямое совпадение по номеру
    let c = get(user.phone);
    if (c) return c;

    // 2. Совпадение по специальному полю телефона разработчика
    c = get(user.creator_phone);
    if (c) return c;

    // 3. Резерв: сервер уже вычислил уровень по полному номеру до маскирования
    const lvl = user.creator_level;
    if (lvl === 'gold' || lvl === 'silver' || lvl === 'bronze') {
      return {
        phone: String(user.creator_phone || user.phone || ''),
        name: user.creator_name || user.name || 'Разработчик',
        level: lvl,
        role: user.creator_role || '',
        description: user.creator_description || ''
      };
    }

    return null;
  }

  return {
    list: window.CREATORS,
    get,
    getByPhone: get,
    levelOf,
    ofUser,
    digits
  };
})();

// ---- Самовосстановление: если app.js отработал раньше этого файла ----
// (гараж из кэша service worker, другой порядок загрузки скриптов)
try {
  if (typeof window.__creatorsReady === 'function') {
    window.__creatorsReady();
  } else if (!document.querySelector('script[src="/creators.js"]')) {
    const s = document.createElement('script');
    s.src = '/creators.js';
    document.head.appendChild(s);
  }
} catch (e) { /* noop */ }