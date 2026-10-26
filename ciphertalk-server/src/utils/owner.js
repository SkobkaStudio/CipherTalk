/**
 * Признак владельца / короны CipherTalk.
 *
 * Старый модуль с зашитым номером разработчика удалён. Теперь всё
 * настраивается ТОЛЬКО по номеру телефона в файле:
 *   src/config/crowns.json   { "+7XXXXXXXXXX": "gold" | "silver" | "bronze" }
 * и опционально OWNER_PHONE в .env (всегда gold).
 *
 * Логика живёт в ./crowns.js; здесь — совместимые реэкспорты, чтобы
 * существующие импорты (`require('../utils/owner')`) не ломались.
 */
const crowns = require('./crowns');

module.exports = {
  phoneDigits: crowns.phoneDigits,
  // Совместимость: раньше «владелец» = один номер из config.ownerPhone.
  isOwnerPhone: (phone) => crowns.getCrownLevelByPhone(phone) === 'gold',
  getCrownLevelByPhone: crowns.getCrownLevelByPhone,
  getCrownLevel: crowns.getCrownLevel,
  isCrowned: crowns.isCrowned,
  withCrown: crowns.withCrown,
  isOwnerUser: crowns.isOwnerUser,
};
