'use strict';

/**
 * Список создателей (разработчиков) CipherTalk.
 *
 * Каждый разработчик получает корону одного из трёх уровней:
 *   gold    — золотая корона
 *   silver  — серебряная корона
 *   bronze  — медная корона
 *
 * Идентификация — по публичному 8-значному id пользователя (public_id),
 * который виден в адресной строке: https://ciphertalk.cloudpub.ru/00000001
 * Дублирует список на клиенте: /creators.js (window.CREATORS).
 *
 * Чтобы добавить разработчика — допишите объект в массив CREATORS ниже.
 */

const CREATORS = [
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

// Быстрый поиск по нормализованному токену ('1' === '00000001')
const BY_TOKEN = new Map();
for (const c of CREATORS) {
  const key = String(c.publicId || '').replace(/^0+/, '') || String(c.publicId);
  BY_TOKEN.set(key, c);
}

/** Уровень короны разработчика по его публичному id. */
function getCreatorLevel(publicId) {
  const c = getCreator(publicId);
  return c ? c.level : null;
}

/** Полная карточка разработчика или null. */
function getCreator(publicId) {
  const raw = String(publicId == null ? '' : publicId).trim();
  if (!raw) return null;
  const key = raw.replace(/^0+/, '') || raw;
  return BY_TOKEN.get(key) || null;
}

/**
 * Добавить уровень короны пользователю (объекту member/user) по его public_id.
 * Мутирует и возвращает тот же объект.
 */
function withCrown(user) {
  if (!user || typeof user !== 'object') return user;
  const creator = getCreator(user.public_id || user.publicId);
  if (creator) {
    user.creator_level = creator.level;
    user.creator_name = creator.name;
    user.creator_role = creator.role;
    user.creator_description = creator.description;
  }
  return user;
}

module.exports = { CREATORS, getCreator, getCreatorLevel, withCrown };
