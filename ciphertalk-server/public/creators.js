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
    phone: '+79609611353', // золотая корона
    name: 'Skobka',
    level: 'gold',
    role: 'Основатель · Lead Developer',
    description: 'Создал CipherTalk с нуля: архитектура сервера, сквозное шифрование E2EE, система публичных ID и ссылок чатов.'
  },
    {
    phone: '+79039952506', // золотая корона
    name: 'Максим',
    level: 'gold',
    role: 'Основатель · Lead Developer',
    description: 'Создал CipherTalk с нуля: архитектура сервера, сквозное шифрование E2EE, система публичных ID и ссылок чатов.'
  }//,
//  {
//    phone: '+79990000002', // серебряная корона
//    name: 'Cipher',
//    level: 'silver',
//    role: 'Backend Developer',
//    description: 'База данных SQLCipher, WebSocket-сервис, presence и автоудаление сообщений.'
//  },
//  {
//    phone: '+79990000003', // медная корона
//    name: 'Nova',
//    level: 'bronze',
//    role: 'UI/UX Designer',
//    description: 'Интерфейс мессенджера, тёмная тема, анимации и адаптивная вёрстка.'
//  }
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

  /** Корона для объекта-пользователя (member/user): берём его номер телефона. */
  function ofUser(user) {
    if (!user) return null;
    return get(user.phone);
  }

  return { list: window.CREATORS, get, levelOf, ofUser, byPhone: get };
})();
