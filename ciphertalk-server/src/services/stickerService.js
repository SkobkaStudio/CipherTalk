/**
 * stickerService.js — серверная логика паков и стикеров (CipherTalk).
 *
 * Модель данных: sticker_packs (1) -> stickers (N), файлы на диске в
 * storage/stickers/<pack_id>/<sticker_id>.<ext>. Стикеры НЕ являются частью
 * E2EE-контента: это публичные метаданные + картинка, сервер раздаёт их
 * напрямую с проверкой доступа (см. serveStickerFile).
 *
 * Вся валидация загрузок сосредоточена здесь (DRY): маршруты только вызывают
 * методы сервиса и маппят ошибки в HTTP-коды.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const logger = require('../utils/logger');
const { probeImage } = require('../utils/imageHeaders');

// Лимиты ТЗ: 512 КБ, один файл, белый список MIME по содержимому (magic bytes).
const STICKER_MAX_SIZE = 512 * 1024;
const STICKER_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const PACK_NAME_MIN = 2;
const PACK_NAME_MAX = 50;
const EMOJI_TAGS_MAX = 200;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Ошибка сервиса с HTTP-статусом для роутера. */
class StickerError extends Error {
  /**
   * @param {number} status - код ответа (400/403/404/413/415/429/507)
   * @param {string} message - сообщение клиенту
   * @param {object} [headers] - дополнительные заголовки ответа (Retry-After)
   */
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers || null;
  }
}

/**
 * Multer-хранилище: буфер в памяти (стикеры <= 512 КБ), UUID генерирует
 * сервер, имя файла клиента не участвует ни в чём.
 */
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: STICKER_MAX_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    if (STICKER_ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new StickerError(415, 'Допустимы только PNG/JPEG/WebP/GIF'));
  }
});

function normalizePackName(raw) {
  const name = String(raw == null ? '' : raw).trim().slice(0, PACK_NAME_MAX);
  if (name.length < PACK_NAME_MIN) {
    throw new StickerError(400, `Название пака: ${PACK_NAME_MIN}-${PACK_NAME_MAX} символов`);
  }
  return name;
}

function normalizeEmojiTags(raw) {
  return String(raw == null ? '' : raw).trim().slice(0, EMOJI_TAGS_MAX);
}

/** Пакетный id из URL должен быть «безопасным» (защита от traversal). */
function assertSafeId(value, what) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new StickerError(400, `Некорректный ${what}`);
  }
  return value;
}

/**
 * Загрузка секрета подписанных URL: env STICKER_URL_SECRET, иначе файл
 * <dbFile>.sticker-secret с правами 0600 (по аналогии с jwt-secret),
 * иначе — одноразовый секрет на процесс с warning.
 * @returns {string} hex-секрет
 */
function loadUrlSecret() {
  if (config.stickerUrlSecret) return config.stickerUrlSecret;
  const secretFile = `${config.dbFile}.sticker-secret`;
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing) return existing;
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn({ err: e }, 'sticker-secret: не удалось прочитать файл секрета');
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  } catch (e) {
    logger.warn({ err: e }, 'sticker-secret: не удалось сохранить секрет на диск — подписи действуют только до рестарта');
  }
  return generated;
}

class StickerService {
  constructor(db) {
    this.db = db;
    /** Секрет HMAC для signed URL приватных стикеров (инициализируется один раз на модуль). */
    if (!StickerService._sharedUrlSecret) StickerService._sharedUrlSecret = loadUrlSecret();
    this.urlSecret = StickerService._sharedUrlSecret;
  }

  // ==================== ПАКИ ====================

  /**
   * Список паков: публичные + собственные пользователя, с количеством стикеров.
   * @param {number} userId
   * @param {{mine?: boolean, limit?: number, offset?: number}} opts
   * @returns {{packs: Array<object>, total: number}}
   */
  listPacks(userId, { mine = false, limit = 20, offset = 0 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const off = Math.max(Number(offset) || 0, 0);
    const where = mine
      ? 'author_id = ?'
      : '(is_public = 1 OR author_id = ?)';
    const rows = this.db.listStickerPacks(where, Number(userId), lim, off);
    const total = this.db.countStickerPacks(where, Number(userId));
    return { packs: rows.map((p) => this.packDto(p)), total };
  }

  /**
   * Пак вместе со списком стикеров. Права: public OR author; чужой приватный — 404.
   * @param {string} packId
   * @param {number} userId
   */
  getPackWithStickers(packId, userId) {
    assertSafeId(packId, 'идентификатор пака');
    const pack = this.db.findStickerPackById(packId);
    if (!pack) throw new StickerError(404, 'Пак не найден');
    const isAuthor = Number(pack.author_id) === Number(userId);
    if (!pack.is_public && !isAuthor) throw new StickerError(404, 'Пак не найден');
    const stickers = this.db.listStickersByPack(packId);
    return { pack: this.packDto(pack, stickers.length), stickers: stickers.map((s) => this.stickerDto(s, userId)) };
  }

  /**
   * Создаёт пак; при конфликте гонки возвращает существующий (идемпотентно).
   * @param {number} userId
   * @param {{name: string, is_public?: boolean, id?: string}} data
   */
  createPack(userId, data) {
    const name = normalizePackName(data.name);
    const isPublic = data.is_public === undefined ? true : !!data.is_public;
    const id = data.id || crypto.randomUUID();
    if (data.id) assertSafeId(id, 'идентификатор пака');
    const now = Date.now();
    const created = this.db.createStickerPack({
      id, name, author_id: Number(userId), cover_sticker_id: null,
      is_public: isPublic ? 1 : 0, order_index: this.db.nextPackOrderIndex(userId),
      created_at: now, updated_at: now
    });
    if (!created) return this.packDto(this.db.findStickerPackById(id)); // INSERT OR IGNORE: уже есть
    return this.packDto(created);
  }

  /** Гарантированно существующий личный пак пользователя (для legacy-миграции). */
  ensureLegacyPack(userId) {
    const id = 'legacy-' + crypto.createHash('sha1').update(String(userId)).digest('hex').slice(0, 24);
    const existing = this.db.findStickerPackById(id);
    if (existing) return existing;
    const now = Date.now();
    this.db.createStickerPack({
      id, name: 'Legacy', author_id: Number(userId), cover_sticker_id: null,
      is_public: 0, order_index: this.db.nextPackOrderIndex(userId), created_at: now, updated_at: now
    });
    return this.db.findStickerPackById(id);
  }

  /**
   * PATCH пака (только владелец). Разрешены name, is_public, cover_sticker_id, order_index.
   * @param {string} packId
   * @param {number} userId
   * @param {object} patch
   */
  updatePack(packId, userId, patch) {
    assertSafeId(packId, 'идентификатор пака');
    const pack = this.db.findStickerPackById(packId);
    if (!pack) throw new StickerError(404, 'Пак не найден');
    if (Number(pack.author_id) !== Number(userId)) throw new StickerError(403, 'Нет прав на этот пак');
    const clean = {};
    if (patch.name !== undefined) clean.name = normalizePackName(patch.name);
    if (patch.is_public !== undefined) clean.is_public = patch.is_public ? 1 : 0;
    if (patch.order_index !== undefined) clean.order_index = Math.max(0, Number(patch.order_index) || 0);
    if (patch.cover_sticker_id !== undefined) {
      const coverId = patch.cover_sticker_id ? String(patch.cover_sticker_id) : null;
      if (coverId) {
        const st = this.db.findStickerById(coverId);
        if (!st || st.pack_id !== packId) throw new StickerError(400, 'Обложка должна быть стикером этого пака');
      }
      clean.cover_sticker_id = coverId;
    }
    if (!Object.keys(clean).length) throw new StickerError(400, 'Нет изменений');
    this.db.updateStickerPack(packId, clean);
    return this.packDto(this.db.findStickerPackById(packId));
  }

  /**
   * Удаляет пак: строки БД (каскад по stickers/favorites/recent) в транзакции,
   * затем файлы на диске. Ошибки удаления файлов — warning, не откат.
   * @param {string} packId
   * @param {number} userId
   */
  deletePack(packId, userId) {
    assertSafeId(packId, 'идентификатор пака');
    const pack = this.db.findStickerPackById(packId);
    if (!pack) throw new StickerError(404, 'Пак не найден');
    if (Number(pack.author_id) !== Number(userId)) throw new StickerError(403, 'Нет прав на этот пак');
    const files = this.db.listStickersByPack(packId).map((s) => this.stickerFilePath(s));
    this.db.deleteStickerPack(packId);
    for (const fp of files) this.removeFileQuiet(fp, packId);
    try { fs.rmSync(path.join(config.stickersPath, packId), { recursive: true, force: true }); } catch (e) {
      logger.error({ err: e, packId }, '[stickers] не удалось удалить каталог пака');
    }
    return true;
  }

  // ==================== СТИКЕРЫ ====================

  /**
   * Сохраняет загруженный файл (req.file от multer memoryStorage) как стикер пака.
   * Транзакция: сначала запись в БД; ошибка диска — откат БД и удаление частичного
   * файла; ENOSPC -> 507.
   * @param {string} packId
   * @param {number} userId
   * @param {{buffer: Buffer, mimetype: string, size: number}} uploaded
   * @param {{name?: string, emoji_tags?: string}} meta
   */
  saveSticker(packId, userId, uploaded, meta = {}) {
    assertSafeId(packId, 'идентификатор пака');
    const pack = this.db.findStickerPackById(packId);
    if (!pack) throw new StickerError(404, 'Пак не найден');
    if (Number(pack.author_id) !== Number(userId)) throw new StickerError(403, 'Нет прав на этот пак');
    if (!uploaded || !uploaded.buffer || !uploaded.buffer.length) throw new StickerError(400, 'Файл не получен');
    if (uploaded.size > STICKER_MAX_SIZE) throw new StickerError(413, 'Стикер слишком большой (максимум 512 КБ)');

    const info = probeImage(uploaded.buffer);
    if (!info) throw new StickerError(415, 'Файл не является поддерживаемым изображением');
    if (!STICKER_ALLOWED_MIME.includes(info.mime)) throw new StickerError(415, 'Файл не является поддерживаемым изображением');

    const id = crypto.randomUUID();
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[info.mime];
    const filePath = path.join(config.stickersPath, packId, id + '.' + ext);
    const relPath = path.posix.join('stickers', packId, id + '.' + ext);
    const row = {
      id,
      pack_id: packId,
      file_path: relPath,
      mime_type: info.mime,
      width: info.width,
      height: info.height,
      emoji_tags: normalizeEmojiTags(meta.emoji_tags || meta.name || ''),
      order_index: this.db.nextStickerOrderIndex(packId),
      created_at: Date.now()
    };

    let fileWritten = false;
    try {
      const tx = this.db.db.transaction(() => {
        this.db.createSticker(row);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, uploaded.buffer);
        fileWritten = true;
      });
      tx();
    } catch (e) {
      if (fileWritten) {
        try { fs.unlinkSync(filePath); } catch (unlinkErr) {
          logger.error({ err: unlinkErr, stickerId: id }, '[stickers] не удалось убрать частичный файл стикера');
        }
      }
      if (e && e.code === 'ENOSPC') throw new StickerError(507, 'Хранилище переполнено');
      if (e instanceof StickerError) throw e;
      throw e;
    }
    return this.stickerDto(row, userId);
  }

  /**
   * Удаляет стикер: сначала строка (транзакция каскада favorites/recent),
   * затем файл; ошибка файла — warning, не откат.
   * @param {string} stickerId
   * @param {number} userId
   */
  deleteSticker(stickerId, userId) {
    const sticker = this.db.findStickerById(stickerId);
    if (!sticker) throw new StickerError(404, 'Стикер не найден');
    const pack = this.db.findStickerPackById(sticker.pack_id);
    if (!pack || Number(pack.author_id) !== Number(userId)) throw new StickerError(403, 'Нет прав на этот стикер');
    this.db.deleteSticker(stickerId);
    this.removeFileQuiet(this.stickerFilePath(sticker), pack.id);
    return true;
  }

  /** PATCH стикера: emoji_tags / order_index, только владелец пака. */
  updateSticker(stickerId, userId, patch) {
    const sticker = this.db.findStickerById(stickerId);
    if (!sticker) throw new StickerError(404, 'Стикер не найден');
    const pack = this.db.findStickerPackById(sticker.pack_id);
    if (!pack || Number(pack.author_id) !== Number(userId)) throw new StickerError(403, 'Нет прав на этот стикер');
    const clean = {};
    if (patch.emoji_tags !== undefined) clean.emoji_tags = normalizeEmojiTags(patch.emoji_tags);
    if (patch.order_index !== undefined) clean.order_index = Math.max(0, Number(patch.order_index) || 0);
    if (!Object.keys(clean).length) throw new StickerError(400, 'Нет изменений');
    this.db.updateSticker(stickerId, clean);
    return this.stickerDto(this.db.findStickerById(stickerId), userId);
  }

  /** Пересортировка стикеров внутри пака (массив id, только владелец). */
  reorderStickers(packId, userId, ids) {
    assertSafeId(packId, 'идентификатор пака');
    const pack = this.db.findStickerPackById(packId);
    if (!pack) throw new StickerError(404, 'Пак не найден');
    if (Number(pack.author_id) !== Number(userId)) throw new StickerError(403, 'Нет прав на этот пак');
    if (!Array.isArray(ids) || !ids.length) throw new StickerError(400, 'Ожидается непустой массив id');
    const clean = ids.map((x) => String(x).slice(0, 64));
    this.db.reorderStickers(packId, clean);
    return this.db.listStickersByPack(packId).map((s) => this.stickerDto(s, userId));
  }

  /** Пересортировка паков пользователя (массив id, авторство проверяется на каждом). */
  reorderPacks(userId, ids) {
    if (!Array.isArray(ids) || !ids.length) throw new StickerError(400, 'Ожидается непустой массив id');
    for (const id of ids) {
      const pack = this.db.findStickerPackById(String(id));
      if (!pack) throw new StickerError(404, 'Пак не найден');
      if (Number(pack.author_id) !== Number(userId)) throw new StickerError(403, 'Нет прав на этот пак');
    }
    this.db.reorderStickerPacks(ids.map(String));
    return this.listPacks(userId, { mine: true, limit: 50 }).packs;
  }

  // ==================== ДОСТУП И РАЗДАЧА ====================

  /**
   * Есть ли у пользователя доступ к файлу стикера (публичный пак — всем).
   * @param {string} stickerId
   * @param {number} userId
   * @returns {boolean}
   */
  checkAccess(stickerId, userId) {
    const sticker = this.db.findStickerById(stickerId);
    if (!sticker) return false;
    const pack = this.db.findStickerPackById(sticker.pack_id);
    if (!pack) return false;
    return !!pack.is_public || Number(pack.author_id) === Number(userId);
  }

  /**
   * HMAC-подпись URL приватного стикера. Публичные паки подписи НЕ требуют —
   * для них используется прямой путь без query (см. stickerDto).
   * @param {string} stickerId - UUID стикера
   * @param {number} userId - владелец (кто запрашивает)
   * @param {number} [ttlMs=3600000] - TTL ссылки, по умолчанию 1 час
   * @returns {{url: string, expiresAt: number}} относительный URL с ?exp=&uid=&sig=
   */
  signStickerUrl(stickerId, userId, ttlMs = 3600000) {
    const sticker = this.db.findStickerById(stickerId);
    if (!sticker) throw new StickerError(404, 'Стикер не найден');
    const exp = Date.now() + ttlMs;
    const payload = `${exp}:${stickerId}:${userId}`;
    const sig = crypto.createHmac('sha256', this.urlSecret).update(payload).digest('hex');
    const filename = path.basename(sticker.file_path);
    const url = `/static/stickers/${sticker.pack_id}/${filename}?exp=${exp}&uid=${Number(userId)}&sig=${sig}`;
    return { url, expiresAt: exp };
  }

  /**
   * Проверка подписи signed URL приватного стикера.
   * @param {string} stickerId
   * @param {number|string} userId - uid из query
   * @param {number|string} exp - unix-ms истечения из query
   * @param {string} sig - hex-HMAC из query
   * @returns {{ok: boolean, reason?: string}}
   */
  verifyStickerSig(stickerId, userId, exp, sig) {
    if (!exp || !sig) return { ok: false, reason: 'missing_sig' };
    if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return { ok: false, reason: 'expired' };
    const expected = crypto.createHmac('sha256', this.urlSecret)
      .update(`${exp}:${stickerId}:${Number(userId)}`).digest('hex');
    const a = Buffer.from(String(sig), 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_sig' };
    // Подпись подтверждает, что URL когда-то выдал именно uid; дополнительно
    // требуем, чтобы пак принадлежал этому пользователю (или был публичным —
    // но туда мы не заходим, публичные идут без sig).
    const sticker = this.db.findStickerById(stickerId);
    if (!sticker) return { ok: false, reason: 'not_found' };
    const pack = this.db.findStickerPackById(sticker.pack_id);
    if (!pack) return { ok: false, reason: 'not_found' };
    if (Number(pack.author_id) !== Number(userId)) return { ok: false, reason: 'wrong_owner' };
    return { ok: true };
  }

  /**
   * Раздача файлов GET /static/stickers/:packId/:filename БЕЗ JWT:
   * <img src> не умеет передавать Authorization. Публичный пак — открытый
   * ассет; приватный — только по signed URL (?exp=&uid=&sig=, см. signStickerUrl).
   * Guard от path traversal: любой '..' -> 400; packId — по regex; filename — basename.
   * @param {{params: object, query: object, url: string}} req
   * @param {{set: Function, status: Function, type: Function, sendFile: Function}} res
   */
  serveStickerFile(req, res) {
    const { packId, filename } = req.params;
    const rawUrl = `${packId}/${filename}`;
    if (rawUrl.includes('..') || String(req.url || '').includes('..')) {
      return res.status(400).json({ error: 'Некорректный путь' });
    }
    try {
      assertSafeId(packId, 'идентификатор пака');
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const base = path.basename(String(filename || ''));
    if (!base || base !== filename || !SAFE_ID_RE.test(base.replace(/\.[a-z0-9]+$/i, ''))) {
      return res.status(400).json({ error: 'Некорректное имя файла' });
    }
    const pack = this.db.findStickerPackById(packId);
    if (!pack) return res.status(404).json({ error: 'Стикер не найден' });
    const sticker = this.db.findStickerByFile(`${packId}/${base}`);
    if (!sticker) return res.status(404).json({ error: 'Стикер не найден' });
    if (!pack.is_public) {
      // Приватный пак: доступ только по валидной подписи (без Authorization).
      const { exp, sig, uid } = req.query || {};
      const check = this.verifyStickerSig(sticker.id, uid, exp, sig);
      if (!check.ok) return res.status(403).json({ error: 'Доступ запрещён', reason: check.reason });
    }
    const abs = this.stickerFilePath(sticker);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Файл отсутствует' });
    res.set('Cache-Control', 'private, max-age=3600, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.type(sticker.mime_type).sendFile(abs);
  }

  /** Абсолютный путь файла стикера на диске (от корня сервера, не от cwd). */
  stickerFilePath(sticker) {
    const rel = String(sticker.file_path); // 'stickers/<pack>/<id>.<ext>'
    const parts = rel.split('/');
    return path.join(config.serverRoot, ...parts.slice(1)); // <root>/storage/stickers/...
  }

  removeFileQuiet(absPath, packId) {
    try { fs.unlinkSync(absPath); } catch (e) {
      if (e.code !== 'ENOENT') {
        logger.warn({ err: e, packId }, '[stickers] не удалось удалить файл стикера');
      }
    }
  }

  // ==================== ИЗБРАННОЕ / НЕДАВНИЕ ====================

  /** Добавить избранное (идемпотентно). Требует доступа к стикеру. */
  addFavorite(userId, stickerId) {
    if (!this.checkAccess(stickerId, userId)) throw new StickerError(404, 'Стикер не найден');
    this.db.addFavoriteSticker(userId, stickerId);
    return { ok: true };
  }

  removeFavorite(userId, stickerId) {
    this.db.removeFavoriteSticker(userId, stickerId);
    return { ok: true };
  }

  listFavorites(userId) {
    return this.db.listFavoriteStickers(userId).map((s) => this.stickerDto(s, userId));
  }

  listRecent(userId) {
    return this.db.listRecentStickers(userId, 20).map((s) => this.stickerDto(s, userId));
  }

  clearRecent(userId) {
    this.db.clearRecentStickers(userId);
    return { ok: true };
  }

  /** Отметить использование (вызывается WS-обработчиком sticker_send). */
  markUsed(userId, stickerId) {
    this.db.touchRecentSticker(userId, stickerId);
  }

  /** DTO для REST/WS: публичная карта стикера. */
  stickerDto(s, userId = null) {
    if (!s) return null;
    const filename = path.basename(s.file_path);
    let url = `/static/stickers/${s.pack_id}/${filename}`;
    // Приватный пак: <img src> не умеет Authorization — отдаём signed URL.
    if (userId != null) {
      const pack = this.db.findStickerPackById(s.pack_id);
      if (pack && !pack.is_public) {
        url = this.signStickerUrl(s.id, userId).url;
      }
    }
    return {
      id: s.id,
      pack_id: s.pack_id,
      url,
      mime_type: s.mime_type,
      width: s.width,
      height: s.height,
      emoji_tags: s.emoji_tags || '',
      order_index: s.order_index,
      created_at: s.created_at
    };
  }

  packDto(p, countOverride) {
    return {
      id: p.id,
      name: p.name,
      author_id: p.author_id,
      cover_sticker_id: p.cover_sticker_id || null,
      is_public: !!p.is_public,
      order_index: p.order_index,
      sticker_count: countOverride !== undefined ? countOverride : this.db.countStickersInPack(p.id),
      created_at: p.created_at,
      updated_at: p.updated_at
    };
  }
}

module.exports = {
  StickerService,
  StickerError,
  uploadMemory,
  STICKER_MAX_SIZE,
  STICKER_ALLOWED_MIME,
  normalizePackName,
  assertSafeId
};
// END src/services/stickerService.js
