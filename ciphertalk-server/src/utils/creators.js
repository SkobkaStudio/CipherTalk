'use strict';

/**
 * Список создателей (разработчиков) CipherTalk.
 *
 * Каждый разработчик получает корону одного из трёх уровней:
 *   gold    — золотая корона
 *   silver  — серебряная корона
 *   bronze  — медная корона
 *
 * Идентификация — ПО НОМЕРУ ТЕЛЕФОНА разработчика (phone), а не по id.
 * Дублирует список на клиенте: /creators.js (window.CREATORS).
 *
 * Чтобы добавить разработчика — допишите объект в массив CREATORS ниже.
 */

const { normalizePhone } = require('./phone');

// Канонический вид номера для сравнения: '+79990000001' -> '79990000001'
function phoneDigits(value) {
  const p = normalizePhone(value);
  return p ? p.replace(/\D/g, '') : '';
}

const CREATORS = [
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
];

// Быстрый поиск по нормализованным цифрам телефона ('79990000001')
const BY_PHONE = new Map();
for (const c of CREATORS) {
  BY_PHONE.set(phoneDigits(c.phone), c);
}

/** Уровень короны разработчика по его номеру телефона. */
function getCreatorLevel(phone) {
  const c = getCreator(phone);
  return c ? c.level : null;
}

/** Полная карточка разработчика по номеру телефона или null. */
function getCreator(phone) {
  const key = phoneDigits(phone);
  if (!key) return null;
  return BY_PHONE.get(key) || null;
}

/**
 * Добавить уровень короны пользователю (объекту member/user) по его номеру.
 * Мутирует и возвращает тот же объект.
 */
function withCrown(user) {
  if (!user || typeof user !== 'object') return user;
  const creator = getCreator(user.phone);
  if (creator) {
    user.creator_level = creator.level;
    user.creator_name = creator.name;
    user.creator_role = creator.role;
    user.creator_description = creator.description;
  }
  return user;
}

module.exports = { CREATORS, getCreator, getCreatorLevel, withCrown };