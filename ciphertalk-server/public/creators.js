/* global window */
(function () {
  'use strict';

  /**
   * Клиентский список создателей (разработчиков) CipherTalk.
   * Синхронизирован с сервером: src/utils/creators.js
   *
   * Уровни корон: 'gold' | 'silver' | 'bronze'.
   * Идентификация — СТРОГО ПО НОМЕРУ ТЕЛЕФОНА разработчика, а не по id.
   *
   * ВАЖНО: файл подключается в index.html ДО app.js, но на случай
   * кривого кэша / старого service worker он не использует 'use strict'
   * на верхнем уровне и сам добавляет <script src="/creators.js"> в DOM,
   * если app.js загрузился раньше него.
   */

  // ---- Канонизация номера: только цифры, leading 8 -> 7 ----
  function digits(value) {
    var d = String(value == null ? '' : value).replace(/\D/g, '');
    return d.length === 11 && d[0] === '8' ? '7' + d.slice(1) : d;
  }

  // Список всегда пересобирается заново (в т.ч. при горячей перезагрузке файла).
  var LIST = [
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
    }
    // ,
    // { phone: '+79990000002', name: 'Cipher', level: 'silver', role: 'Backend Developer',
    //   description: 'База данных SQLCipher, WebSocket-сервис, presence и автоудаление сообщений.' },
    // { phone: '+79990000003', name: 'Nova', level: 'bronze', role: 'UI/UX Designer',
    //   description: 'Интерфейс мессенджера, тёмная тема, анимации и адаптивная вёрстка.' }
  ];

  var BY_PHONE = new Map();
  for (var i = 0; i < LIST.length; i++) {
    BY_PHONE.set(digits(LIST[i].phone), LIST[i]);
  }

  /** Карточка разработчика по номеру телефона (любой записи) или null. */
  function get(phone) {
    var key = digits(phone);
    if (!key) return null;
    return BY_PHONE.get(key) || null;
  }

  /** Уровень короны ('gold' | 'silver' | 'bronze') по номеру телефона или null. */
  function levelOf(phone) {
    var c = get(phone);
    return c ? c.level : null;
  }

  /**
   * Корона для объекта пользователя/участника.
   * Смотрим ВСЕ поля, где сервер мог передать номер (телефоны чужих
   * пользователей маскируются, поэтому проверяем и creator_phone,
   * и creator_level как резервный сигнал от сервера).
   */
  function ofUser(user) {
    if (!user) return null;
    var c = get(user.phone);
    if (c) return c;
    c = get(user.creator_phone);
    if (c) return c;
    // Резерв: сервер уже вычислил уровень по полному номеру до маскирования.
    var lvl = user.creator_level;
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

  window.CREATORS = LIST;
  window.Creators = {
    list: LIST,
    get: get,
    getByPhone: get,
    levelOf: levelOf,
    ofUser: ofUser,
    digits: digits
  };

  // ---- Самовосстановление: если app.js отработал раньше этого файла ----
  // (гараж из кэша service worker, другой порядок загрузки скриптов) —
  // сообщаем приложению, что список готов, и подстраховываемся тегом <script>.
  try {
    if (typeof window.__creatorsReady === 'function') {
      window.__creatorsReady();
    } else if (!document.querySelector('script[src="/creators.js"]')) {
      var s = document.createElement('script');
      s.src = '/creators.js';
      document.head.appendChild(s);
    }
  } catch (e) { /* noop */ }
})();
