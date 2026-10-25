/**
 * stickerRoutes.js — REST-маршруты паков и стикеров CipherTalk.
 *
 *   GET    /api/stickers/packs                 — публичные + свои (?mine=1, limit<=50, offset)
 *   POST   /api/stickers/packs                 — создать пак {name, is_public}
 *   GET    /api/stickers/packs/:id             — пак + стикеры (public OR author, иначе 404)
 *   PATCH  /api/stickers/packs/:id             — владелец: name/is_public/cover/order_index
 *   DELETE /api/stickers/packs/:id             — владелец: каскад строк + файлов с диска
 *   PUT    /api/stickers/packs/:id/stickers/reorder — порядок стикеров внутри пака
 *   POST   /api/stickers/packs/:id/stickers    — multipart {file, name?, emoji_tags?}, 10/мин
 *   PATCH  /api/stickers/:id                   — владелец: emoji_tags/order_index
 *   DELETE /api/stickers/:id                   — владелец: строка + файл
 *   GET    /api/stickers/favorites             — избранное пользователя
 *   POST   /api/stickers/favorites/:id         — добавить (INSERT OR IGNORE)
 *   DELETE /api/stickers/favorites/:id         — убрать
 *   GET    /api/stickers/recent                — последние 20 использованных
 *   DELETE /api/stickers/recent                — очистить недавние
 *   PUT    /api/stickers/packs/reorder         — порядок паков (order_index в БД)
 *
 * Права: чужой DELETE/PATCH -> 403; GET чужого приватного -> 404 (не подтверждать существование).
 */

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const logger = require('../utils/logger');
const { StickerService, StickerError, uploadMemory } = require('../services/stickerService');

// Отдельный лимит на загрузку стикеров: 10 запросов в минуту на пользователя.
function makeUploadLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `sticker-upload:${req.userId}`,
    handler: (req, res) => {
      res.set('Retry-After', '60');
      res.status(429).json({ error: 'Слишком много загрузок, попробуйте позже' });
    }
  });
}

/** Единый маппинг ошибок сервиса в HTTP-коды. */
function handleRouteError(res, e) {
  if (e instanceof StickerError) {
    if (e.headers) res.set(e.headers);
    return res.status(e.status).json({ error: e.message });
  }
  if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Стикер слишком большой (максимум 512 КБ)' });
  }
  console.error('[stickers] unexpected route error:', e.message);
  return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}

/**
 * Создаёт роутер стикеров.
 * @param {object} db - экземпляр Database (используется только для markDirty-семантики)
 * @returns {express.Router}
 */
function createStickerRouter(db) {
  const router = express.Router();
  const stickers = new StickerService(db);
  const uploadLimiter = makeUploadLimiter();

  /**
   * GET /packs — список доступных паков с пагинацией.
   * Query: mine=1, limit<=50, offset>=0.
   */
  router.get('/packs', authMiddleware.authenticate, (req, res) => {
    try {
      const { packs, total } = stickers.listPacks(req.userId, {
        mine: req.query.mine === '1',
        limit: req.query.limit,
        offset: req.query.offset
      });
      res.json({ packs, total });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * PUT /packs/reorder — новый порядок паков владельца (массив id в body.order).
   */
  router.put('/packs/reorder', authMiddleware.authenticate, (req, res) => {
    try {
      const packs = stickers.reorderPacks(req.userId, (req.body && req.body.order) || []);
      res.json({ packs });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * POST /packs — создать пак {name (2-50), is_public}.
   */
  router.post('/packs', authMiddleware.authenticate, (req, res) => {
    try {
      const pack = stickers.createPack(req.userId, req.body || {});
      res.status(201).json({ pack });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * GET /packs/:id — пак + стикеры. Чужой приватный -> 404.
   */
  router.get('/packs/:id', authMiddleware.authenticate, (req, res) => {
    try {
      res.json(stickers.getPackWithStickers(req.params.id, req.userId));
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * PATCH /packs/:id — владелец меняет name/is_public/cover_sticker_id/order_index.
   */
  router.patch('/packs/:id', authMiddleware.authenticate, (req, res) => {
    try {
      const pack = stickers.updatePack(req.params.id, req.userId, req.body || {});
      res.json({ pack });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * DELETE /packs/:id — владелец удаляет пак, строки и файлы на диске.
   */
  router.delete('/packs/:id', authMiddleware.authenticate, (req, res) => {
    try {
      stickers.deletePack(req.params.id, req.userId);
      res.json({ ok: true });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * PUT /packs/:id/stickers/reorder — порядок стикеров внутри пака (body.order).
   */
  router.put('/packs/:id/stickers/reorder', authMiddleware.authenticate, (req, res) => {
    try {
      const list = stickers.reorderStickers(req.params.id, req.userId, (req.body && req.body.order) || []);
      res.json({ stickers: list });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * POST /packs/:id/stickers — загрузка стикера (multipart file + name?/emoji_tags?).
   * Лимиты: 512 КБ, 10/мин, magic-bytes sniff в сервисе.
   */
  router.post('/packs/:id/stickers',
    authMiddleware.authenticate,
    uploadLimiter,
    (req, res, next) => uploadMemory.single('file')(req, res, (err) => {
      if (err) return handleRouteError(res, err);
      next();
    }),
    (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
        const dto = stickers.saveSticker(req.params.id, req.userId, req.file, req.body || {});
        res.status(201).json({ sticker: dto });
      } catch (e) {
        handleRouteError(res, e);
      }
    }
  );

  /**
   * GET /favorites — избранные стикеры пользователя.
   */
  router.get('/favorites', authMiddleware.authenticate, (req, res) => {
    try {
      res.json({ stickers: stickers.listFavorites(req.userId) });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * POST /favorites/:id — добавить в избранное (идемпотентно).
   */
  router.post('/favorites/:id', authMiddleware.authenticate, (req, res) => {
    try {
      stickers.addFavorite(req.userId, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * DELETE /favorites/:id — убрать из избранного.
   */
  router.delete('/favorites/:id', authMiddleware.authenticate, (req, res) => {
    try {
      stickers.removeFavorite(req.userId, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * GET /recent — последние 20 использованных стикеров.
   */
  router.get('/recent', authMiddleware.authenticate, (req, res) => {
    try {
      res.json({ stickers: stickers.listRecent(req.userId) });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * DELETE /recent — очистить список недавних.
   */
  router.delete('/recent', authMiddleware.authenticate, (req, res) => {
    try {
      stickers.clearRecent(req.userId);
      res.json({ ok: true });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * PATCH /:id — владелец пака меняет emoji_tags/order_index стикера.
   */
  router.patch('/:id', authMiddleware.authenticate, (req, res) => {
    try {
      const dto = stickers.updateSticker(req.params.id, req.userId, req.body || {});
      res.json({ sticker: dto });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /**
   * DELETE /:id — владелец удаляет стикер (сначала БД, затем файл; ошибка файла — warning).
   */
  router.delete('/:id', authMiddleware.authenticate, (req, res) => {
    try {
      stickers.deleteSticker(req.params.id, req.userId);
      res.json({ ok: true });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  // Раздача файлов: app.js монтирует GET /static/stickers/:packId/:filename
  // на stickers.serveStickerFile через createStickerFileHandler.
  return router;
}

/**
 * Возвращает middleware раздачи /static/stickers/* с проверкой доступа
 * и path-traversal guard (любой '..' -> 400). Использовать вместо express.static.
 * @param {object} db
 * @returns {Function} express handler (params: packId, filename)
 */
function createStickerFileHandler(db) {
  const stickers = new StickerService(db);
  return (req, res) => stickers.serveStickerFile(req, res);
}

module.exports = { createStickerRouter, createStickerFileHandler };
// END src/routes/stickerRoutes.js
