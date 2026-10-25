const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BetterSqlite3 = require('better-sqlite3-multiple-ciphers');
const config = require('../config');
const logger = require('../utils/logger');
const dbEncryptionService = require('../services/dbEncryptionService');
const { probeImage } = require('../utils/imageHeaders');
// User импортируется один раз в начале файла: так require не вызывается
// из _mapUser при каждой загрузке строки (это ломало цикл инициализации
// модулей и приводило к "TypeError: User is not a constructor").
const User = require('../models/User');

const DEFAULT_COUNTERS = {
  users: 0,
  chats: 0,
  messages: 0,
  files: 0,
  sessions: 0,
  folders: 0,
  user_stickers: 0
};

function safeJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

class Database {
  constructor() {
    this.jsonPath = config.dbFile || './ciphertalk-db.json';
    this.sqlitePath = this.jsonPath.replace(/\.json$/, '.sqlite') || './ciphertalk-db.sqlite';
    this.db = null;
    this.saveInterval = null;
    this.saveTimeout = null;
    this.dirty = false;
    this._tracked = new Map();
  }

  _isPlainSqlite() {
    try {
      const fd = fs.openSync(this.sqlitePath, 'r');
      try {
        const buf = Buffer.alloc(16);
        const read = fs.readSync(fd, buf, 0, 16, 0);
        return buf.slice(0, read).toString('utf8') === 'SQLite format 3\u0000';
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      return false;
    }
  }

  _applyKey(db) {
    if (!config.dbEncryption) return;
    const key = dbEncryptionService.getKey().toString('hex');
    db.pragma("cipher='sqlcipher'");
    db.pragma(`key="x'${key}'"`);
  }

  load() {
    const hadSqlite = fs.existsSync(this.sqlitePath);

    if (hadSqlite && config.dbEncryption && !fs.existsSync(config.dbKeyFile)) {
      throw new Error(`Файл ключа БД не найден (${config.dbKeyFile}), а SQLite-база зашифрована — восстановите ключ`);
    }

    if (hadSqlite && config.dbEncryption && this._isPlainSqlite()) {
      if (!fs.existsSync(this.jsonPath)) {
        throw new Error('Найдена незашифрованная SQLite-БД без исходного JSON — откажитесь от DB_ENCRYPTION=false или восстановите JSON');
      }
      const legacy = this.sqlitePath + '.plaintext.' + Date.now();
      fs.renameSync(this.sqlitePath, legacy);
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(this.sqlitePath + suffix); } catch (e) {}
      }
      console.log('[DB] Unencrypted SQLite moved to', path.basename(legacy));
    }

    const jsonExisted = fs.existsSync(this.jsonPath);
    if (!fs.existsSync(this.sqlitePath)) {
      const migrate = path.join(__dirname, '../../scripts/migrate_to_sqlite.js');
      if (fs.existsSync(migrate) && jsonExisted) {
        try {
          require(migrate);
          console.log('[DB] Auto-migrated JSON -> SQLite');
        } catch (e) {
          console.error('[DB] Migration failed:', e.message);
        }
      }
    }

    if (!fs.existsSync(this.sqlitePath) && jsonExisted) {
      throw new Error(`Не удалось перенести JSON в SQLite: ${this.sqlitePath}`);
    }

    this.db = new BetterSqlite3(this.sqlitePath);
    this._applyKey(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.ensureSchema();
    this.migrateSchema();
    this.migrateLegacyStickers();
    console.log('✅ База данных SQLite загружена (WAL)');
    return true;
  }

  ensureSchema() {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  phone TEXT,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  name TEXT,
  username TEXT,
  password_hash TEXT,
  avatar TEXT,
  bio TEXT,
  public_key TEXT,
  online INTEGER DEFAULT 0,
  last_seen INTEGER DEFAULT 0,
  hide_online INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY,
  type TEXT,
  name TEXT,
  avatar TEXT,
  description TEXT,
  owner_id INTEGER,
  is_pinned INTEGER DEFAULT 0,
  is_channel INTEGER DEFAULT 0,
  folder_id INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER,
  user_id INTEGER,
  role TEXT,
  joined_at INTEGER,
  last_read_message_id INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  cleared_at INTEGER DEFAULT 0,
  PRIMARY KEY(chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER,
  sender_id INTEGER,
  encrypted_content TEXT,
  iv TEXT,
  header TEXT,
  type TEXT,
  reply_to INTEGER,
  forwarded_from INTEGER,
  edited INTEGER DEFAULT 0,
  deleted_for_all INTEGER DEFAULT 0,
  deleted_by TEXT,
  reactions TEXT,
  pinned INTEGER DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  token TEXT,
  token_hash TEXT,
  expires_at INTEGER,
  created_at INTEGER,
  last_used INTEGER,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  original_name TEXT,
  size INTEGER,
  mimetype TEXT,
  uploader_id INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY,
  phone TEXT,
  code TEXT,
  attempts INTEGER DEFAULT 0,
  expires_at INTEGER,
  used INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vcodes_phone ON verification_codes(phone);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  name TEXT,
  emoji TEXT,
  color TEXT,
  chat_ids TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS group_keys (
  chat_id INTEGER PRIMARY KEY,
  version INTEGER,
  wrapped TEXT,
  created_by INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_vcodes_expires ON verification_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS message_edits (
  id INTEGER PRIMARY KEY,
  message_id INTEGER,
  old_content TEXT,
  new_content TEXT,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_message_edits_mid ON message_edits(message_id);

CREATE TABLE IF NOT EXISTS sticker_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cover_sticker_id TEXT,
  is_public INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  emoji_tags TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_favorite_stickers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sticker_id TEXT NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, sticker_id)
);
CREATE TABLE IF NOT EXISTS user_recent_stickers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sticker_id TEXT NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  used_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, sticker_id)
);
CREATE INDEX IF NOT EXISTS idx_stickers_pack ON stickers(pack_id, order_index);
CREATE INDEX IF NOT EXISTS idx_packs_author ON sticker_packs(author_id);
CREATE INDEX IF NOT EXISTS idx_recent_user ON user_recent_stickers(user_id, used_at DESC);
    `);
  }

  // ==================== БЕЗОПАСНАЯ МИГРАЦИЯ СХЕМЫ ====================
  // Вместо сложного массива миграций, который вызывал ошибки, 
  // мы просто пытаемся добавить всё необходимое. SQLite игнорирует 
  // попытки создать уже существующие таблицы/индексы, а ошибки 
  // "duplicate column" мы перехватываем. Это 100% надёжный метод.
  migrateSchema() {
    // Проверяем реальную схему таблицы через PRAGMA table_info,
    // чтобы не пытаться добавить уже существующую колонку и не спамить
    // в консоль ошибкой "duplicate column name".
    const existingColumns = (table) => new Set(
      this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    );

    const columnsToAdd = [
      ['users', 'email', 'email TEXT'],
      ['users', 'bio', 'bio TEXT'],
      ['users', 'hide_online', 'hide_online INTEGER DEFAULT 0'],
      ['chats', 'is_channel', 'is_channel INTEGER DEFAULT 0'],
      ['chats', 'folder_id', 'folder_id INTEGER'],
      ['chats', 'avatar', 'avatar TEXT'],
      ['sessions', 'token_hash', 'token_hash TEXT'],
      ['verification_codes', 'attempts', 'attempts INTEGER DEFAULT 0'],
      ['messages', 'expires_at', 'expires_at INTEGER'],
      // Ровно одна колонка для инварианта E2EE: type='sticker' -> sticker_id != NULL,
      // encrypted_content/iv/header = NULL; для остальных типов sticker_id = NULL.
      ['messages', 'sticker_id', 'sticker_id TEXT']
    ];

    for (const [table, colName, columnDef] of columnsToAdd) {
      if (existingColumns(table).has(colName)) continue; // дубликат — пропускаем молча
      try {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`).run();
      } catch (e) {
        // Ошибки дубликата колонки не выводим в консоль;
        // любые прочие — тоже глушим, они не критичны для работы.
        if (!/duplicate column name/i.test(e.message)) {
          console.error('[DB] migrateSchema column error:', e.message);
        }
      }
    }

    const schemasToAdd = [
      'CREATE TABLE IF NOT EXISTS message_edits (id INTEGER PRIMARY KEY, message_id INTEGER, old_content TEXT, new_content TEXT, edited_at INTEGER)',
      'CREATE INDEX IF NOT EXISTS idx_message_edits_mid ON message_edits(message_id)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)',
      'CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_vcodes_expires ON verification_codes(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)',
      'CREATE TABLE IF NOT EXISTS group_keys (chat_id INTEGER PRIMARY KEY, version INTEGER, wrapped TEXT, created_by INTEGER, created_at INTEGER, updated_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, emoji TEXT, color TEXT, chat_ids TEXT, created_at INTEGER, updated_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, filename TEXT, original_name TEXT, size INTEGER, mimetype TEXT, uploader_id INTEGER, created_at INTEGER)',
      // Схемы паков/стикеров — в ensureSchema; здесь только идемпотентные индексы.
      'CREATE INDEX IF NOT EXISTS idx_stickers_pack ON stickers(pack_id, order_index)',
      'CREATE INDEX IF NOT EXISTS idx_packs_author ON sticker_packs(author_id)',
      'CREATE INDEX IF NOT EXISTS idx_recent_user ON user_recent_stickers(user_id, used_at DESC)'
    ];

    for (const sql of schemasToAdd) {
      try {
        this.db.prepare(sql).run();
      } catch (e) {
        // Единственный допустимый «шум» — already exists; прочее пишем в лог.
        if (!/already exists/i.test(e.message)) {
          logger.error({ err: e.message }, '[DB] migrateSchema error');
        }
      }
    }
  }

  // ==================== ЛЕГАСИ-МИГРАЦИЯ user_stickers -> packs/stickers ====================
  /**
   * Однократная миграция легаси-таблицы user_stickers в sticker_packs/stickers.
   * Идемпотентна: повторный запуск — no-op (таблица отсутствует). Файлы из
   * uploads/ НЕ являются шифротекстом (старый клиент заливал raw blob через
   * multer), поэтому переносим их как есть: sniff MIME -> размеры -> uuid ->
   * fs.rename в storage/stickers/<pack_id>/<uuid>.<ext>.
   * Битые/отсутствующие файлы пропускаются с warning; DROP выполняется только
   * если все строки обработаны (перенесены или осознанно пропущены), иначе —
   * исключение и откат транзакции.
   */
  migrateLegacyStickers() {
    const hasTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_stickers'")
      .get();
    if (!hasTable) return; // уже смигрировано (или чистая установка по новой схеме)

    const legacyRows = this.db.prepare('SELECT * FROM user_stickers').all();
    const extByMime = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

    const run = this.db.transaction(() => {
      for (const row of legacyRows) {
        const uid = Number(row.user_id);
        if (!Number.isInteger(uid)) {
          throw new Error(`[DB] legacy sticker ${row.id}: некорректный user_id`);
        }
        // Детерминированный pack_id: один Legacy-пак на пользователя.
        const packId = 'legacy-' + crypto.createHash('sha1').update(String(uid)).digest('hex').slice(0, 24);
        const now = Date.now();
        this.db.prepare(`INSERT OR IGNORE INTO sticker_packs
          (id, name, author_id, cover_sticker_id, is_public, order_index, created_at, updated_at)
          VALUES (?, 'Legacy', ?, NULL, 0, 0, ?, ?)`).run(packId, uid, now, now);

        const fileRow = row.file_id == null ? null
          : this.db.prepare('SELECT filename FROM files WHERE id = ?').get(Number(row.file_id));
        if (!fileRow || !fileRow.filename) {
          logger.warn({ sticker: row.id, user: uid }, '[DB] legacy sticker без записи files — пропущен');
          continue;
        }
        const base = path.basename(String(fileRow.filename));
        if (!base || base.includes('..')) {
          logger.warn({ sticker: row.id, user: uid }, '[DB] legacy sticker: некорректное имя файла — пропущен');
          continue;
        }
        const srcPath = path.join(config.uploadsPath, base);
        if (!fs.existsSync(srcPath)) {
          logger.warn({ sticker: row.id, user: uid }, '[DB] legacy sticker: файл отсутствует в uploads — пропущен');
          continue;
        }
        let buf;
        try {
          buf = fs.readFileSync(srcPath);
        } catch (e) {
          logger.warn({ sticker: row.id, err: e.code || e.message }, '[DB] legacy sticker: чтение файла не удалось — пропущен');
          continue;
        }
        const info = probeImage(buf);
        if (!info || !extByMime[info.mime]) {
          logger.warn({ sticker: row.id }, '[DB] legacy sticker: sniff MIME не распознан — пропущен');
          continue;
        }
        const stickerId = crypto.randomUUID();
        const destDir = path.join(config.stickersPath, packId);
        const destPath = path.join(destDir, stickerId + '.' + extByMime[info.mime]);
        // Уже перенесён (идемпотентность при частичном сбое прошлого запуска)?
        if (fs.existsSync(destPath)) {
          logger.warn({ pack: packId, sticker: stickerId }, '[DB] legacy sticker: файл уже в storage — пропущен');
          continue;
        }
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(srcPath, destPath);
        this.db.prepare(`INSERT INTO stickers
          (id, pack_id, file_path, mime_type, width, height, emoji_tags, order_index, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
            stickerId, packId, `stickers/${packId}/${stickerId}.${extByMime[info.mime]}`,
            info.mime, info.width, info.height, String(row.name || '').slice(0, 200),
            Number(row.id) || 0, row.created_at || now
          );
      }

      // Все строки разобраны — удаляем легаси-инфраструктуру.
      this.db.prepare('DROP INDEX IF EXISTS idx_user_stickers_user').run();
      this.db.prepare('DROP TABLE IF EXISTS user_stickers').run();
      this.db.prepare('DELETE FROM counters WHERE name = ?').run('user_stickers');
    });

    run();
    logger.info({ count: legacyRows.length }, '[DB] Миграция user_stickers -> sticker_packs/stickers выполнена');
  }

  nextId(name) {
    const row = this.db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
    const val = row && typeof row.value === 'number' ? row.value + 1 : 1;
    this.db.prepare('INSERT OR REPLACE INTO counters(name,value) VALUES(?,?)').run(name, val);
    return val;
  }

  _track(obj, table) {
    if (obj && typeof obj === 'object') this._tracked.set(obj, table);
    return obj;
  }

  _wrap(name, rows) {
    for (const row of rows) this._track(row, name);
    const self = this;
    return new Proxy(rows, {
      get(target, prop, receiver) {
        if (prop === 'push') {
          return (...items) => {
            for (const item of items) {
              self._insertRow(name, item);
              target.push(item);
            }
            return target.length;
          };
        }
        if (prop === 'unshift') {
          return (...items) => {
            for (const item of items) self._insertRow(name, item);
            for (let i = items.length - 1; i >= 0; i--) target.unshift(items[i]);
            return target.length;
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  }

  _insertRow(table, item) {
    if (!item || typeof item !== 'object') return item;
    if (table === 'users') {
      const saved = this.addUser(item);
      if (saved && !item.id) item.id = saved.id;
    } else if (table === 'chats') {
      const saved = this.addChat(item);
      if (saved && !item.id) item.id = saved.id;
    } else if (table === 'messages') {
      const saved = this.addMessage(item);
      if (saved && !item.id) item.id = saved.id;
    } else if (table === 'chat_members') {
      this.addChatMember(item);
    } else if (table === 'sessions') {
      const saved = this.addSession(item);
      if (saved && !item.id) item.id = saved.id;
    } else if (table === 'files') {
      const saved = this.addFile(item);
      if (saved && !item.id) item.id = saved.id;
    } else if (table === 'verification_codes') {
      const saved = this.addVerificationCode(item);
      if (saved && !item.id) item.id = saved.id;
    } else if (table === 'folders') {
      const saved = this.addFolder(item);
      if (saved && !item.id) item.id = saved.id;
    }
    return item;
  }

  _updateRow(table, item) {
    if (!item || typeof item !== 'object') return;
    if (table === 'users') {
      if (item.id === undefined || item.id === null) return;
      this.db.prepare(`UPDATE users SET phone=?, email=?, first_name=?, last_name=?, name=?, username=?, password_hash=?, avatar=?, bio=?, public_key=?, online=?, last_seen=?, hide_online=?, updated_at=? WHERE id=?`).run(
        item.phone || '', item.email || '', item.first_name || '', item.last_name || '', item.name || '',
        item.username || null, item.password_hash || '', item.avatar || '', item.bio || '', item.public_key || '',
        item.online ? 1 : 0, item.last_seen || 0, item.hide_online ? 1 : 0, item.updated_at || Date.now(), Number(item.id)
      );
    } else if (table === 'chats') {
      if (item.id === undefined || item.id === null) return;
      this.db.prepare(`UPDATE chats SET type=?, name=?, avatar=?, description=?, owner_id=?, is_pinned=?, is_channel=?, folder_id=?, updated_at=? WHERE id=?`).run(
        item.type || 'private', item.name || '', item.avatar || '', item.description || '', item.owner_id || null,
        item.is_pinned ? 1 : 0, item.is_channel ? 1 : 0, item.folder_id || null, item.updated_at || Date.now(), Number(item.id)
      );
    } else if (table === 'messages') {
      if (item.id === undefined || item.id === null) return;
      // sticker_id обязан обновляться здесь: иначе markDirty() после
      // создания/редактирования стикер-сообщения затёр бы его в NULL.
      this.db.prepare(`UPDATE messages SET encrypted_content=?, iv=?, header=?, type=?, reply_to=?, forwarded_from=?, edited=?, deleted_for_all=?, deleted_by=?, reactions=?, pinned=?, expires_at=?, sticker_id=? WHERE id=?`).run(
        item.type === 'sticker' ? null : (item.encrypted_content || ''),
        item.type === 'sticker' ? null : (item.iv || ''),
        item.type === 'sticker' ? null : (item.header || ''),
        item.type || 'text', item.reply_to || null,
        item.forwarded_from || null, item.edited ? 1 : 0, item.deleted_for_all ? 1 : 0,
        JSON.stringify(item.deleted_by || []), JSON.stringify(item.reactions || {}), item.pinned ? 1 : 0,
        item.expires_at || null, item.type === 'sticker' ? (item.sticker_id || null) : null, Number(item.id)
      );
    } else if (table === 'chat_members') {
      if (item.chat_id === undefined || item.user_id === undefined) return;
      this.db.prepare(`UPDATE chat_members SET role=?, last_read_message_id=?, hidden=?, cleared_at=? WHERE chat_id=? AND user_id=?`).run(
        item.role || 'member', item.last_read_message_id || 0, item.hidden ? 1 : 0, item.cleared_at || 0,
        Number(item.chat_id), Number(item.user_id)
      );
    } else if (table === 'sessions') {
      if (item.id === undefined || item.id === null) return;
      this.db.prepare(`UPDATE sessions SET token=?, token_hash=?, expires_at=?, last_used=?, user_agent=? WHERE id=?`).run(
        item.token || '', item.token_hash || '', item.expires_at || 0, item.last_used || Date.now(),
        item.user_agent || '', Number(item.id)
      );
    } else if (table === 'verification_codes') {
      if (item.id === undefined || item.id === null) return;
      this.db.prepare(`UPDATE verification_codes SET phone=?, code=?, attempts=?, expires_at=?, used=? WHERE id=?`).run(
        item.phone || '', item.code || '', item.attempts || 0, item.expires_at || 0, item.used ? 1 : 0, Number(item.id)
      );
    } else if (table === 'folders') {
      if (item.id === undefined || item.id === null) return;
      this.db.prepare(`UPDATE folders SET user_id=?, name=?, emoji=?, color=?, chat_ids=?, updated_at=? WHERE id=?`).run(
        Number(item.user_id), item.name || '', item.emoji || '', item.color || '',
        JSON.stringify(item.chat_ids || []), item.updated_at || Date.now(), Number(item.id)
      );
    }
  }

  _syncTracked() {
    if (!this.db || !this._tracked.size) return;
    const entries = Array.from(this._tracked.entries());
    this._tracked.clear();
    const sync = this.db.transaction(() => {
      for (const [item, table] of entries) this._updateRow(table, item);
    });
    try { sync(); } catch (e) { console.error('[DB] Sync failed:', e.message); }
  }

  _replaceCollection(table, rows) {
    const items = Array.isArray(rows) ? rows : [];
    const keep = new Set();
    if (table === 'chat_members') {
      items.forEach(m => keep.add(`${m.chat_id}:${m.user_id}`));
      const existing = this.db.prepare('SELECT chat_id, user_id FROM chat_members').all();
      for (const m of existing) {
        if (!keep.has(`${m.chat_id}:${m.user_id}`)) {
          this.db.prepare('DELETE FROM chat_members WHERE chat_id=? AND user_id=?').run(m.chat_id, m.user_id);
        }
      }
      for (const m of items) this.addChatMember(m);
    } else if (table === 'messages') {
      items.forEach(m => keep.add(Number(m.id)));
      const existing = this.db.prepare('SELECT id FROM messages').all();
      for (const m of existing) {
        if (!keep.has(Number(m.id))) this.db.prepare('DELETE FROM messages WHERE id=?').run(m.id);
      }
      for (const m of items) this.addMessage(m);
    }
  }

  // ==================== USERS ====================
  findUserById(id) {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    return r ? this._track(this._mapUser(r), 'users') : null;
  }

  findUserByPhone(phone) {
    const r = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    return r ? this._track(this._mapUser(r), 'users') : null;
  }

  findUserByEmail(email) {
    const r = this.db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email || ''));
    return r ? this._track(this._mapUser(r), 'users') : null;
  }

  isUsernameTaken(username, excludeUserId = null) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    if (excludeUserId) {
      const r = this.db.prepare('SELECT COUNT(*) as c FROM users WHERE lower(username)=? AND id != ?').get(clean, Number(excludeUserId));
      return !!(r && r.c > 0);
    }
    const r = this.db.prepare('SELECT COUNT(*) as c FROM users WHERE lower(username)=?').get(clean);
    return !!(r && r.c > 0);
  }

  addUser(u) {
    const id = u.id || this.nextId('users');
    this.db.prepare(`INSERT OR REPLACE INTO users(id,phone,email,first_name,last_name,name,username,password_hash,avatar,bio,public_key,online,last_seen,hide_online,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, u.phone || '', u.email || '', u.first_name || '', u.last_name || '', u.name || '', u.username || null,
      u.password_hash || '', u.avatar || '', u.bio || '', u.public_key || '', u.online ? 1 : 0,
      u.last_seen || 0, u.hide_online ? 1 : 0, u.created_at || Date.now(), u.updated_at || Date.now()
    );
    return this.findUserById(id);
  }

  updateUser(id, patch) {
    const allowed = ['phone', 'email', 'first_name', 'last_name', 'name', 'username', 'password_hash', 'avatar', 'bio', 'public_key', 'online', 'last_seen', 'hide_online', 'updated_at'];
    const sets = [];
    const values = [];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        sets.push(k + ' = ?');
        values.push((k === 'online' || k === 'hide_online') ? (patch[k] ? 1 : 0) : patch[k]);
      }
    }
    if (!sets.length) return this.findUserById(id);
    values.push(Number(id));
    this.db.prepare('UPDATE users SET ' + sets.join(',') + ' WHERE id = ?').run(...values);
    return this.findUserById(id);
  }

  _mapUser(r) {
    return new User(r);
  }

  // ==================== CHATS ====================
  findChatById(id) {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(Number(id));
    return r ? this._track(r, 'chats') : null;
  }

  addChat(c) {
    const id = c.id || this.nextId('chats');
    this.db.prepare(`INSERT OR REPLACE INTO chats(id,type,name,avatar,description,owner_id,is_pinned,is_channel,folder_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, c.type || 'private', c.name || '', c.avatar || '', c.description || '', c.owner_id || null,
      c.is_pinned ? 1 : 0, c.is_channel ? 1 : 0, c.folder_id || null, c.created_at || Date.now(), c.updated_at || Date.now()
    );
    return this.findChatById(id);
  }

  updateChat(id, patch) {
    const allowed = ['type', 'name', 'avatar', 'description', 'owner_id', 'is_pinned', 'is_channel', 'folder_id', 'updated_at'];
    const sets = [];
    const values = [];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        sets.push(k + ' = ?');
        values.push((k === 'is_pinned' || k === 'is_channel') ? (patch[k] ? 1 : 0) : patch[k]);
      }
    }
    if (!sets.length) return this.findChatById(id);
    values.push(Number(id));
    this.db.prepare('UPDATE chats SET ' + sets.join(',') + ' WHERE id = ?').run(...values);
    return this.findChatById(id);
  }

  deleteChat(chatId) {
    const cid = Number(chatId);
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(cid);
    this.db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(cid);
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(cid);
    this.db.prepare('DELETE FROM group_keys WHERE chat_id = ?').run(cid);
    this.removeChatFromAllFolders(cid);
    return true;
  }

  getChatMembers(chatId) {
    return this._wrap('chat_members', this.db.prepare('SELECT * FROM chat_members WHERE chat_id = ?').all(Number(chatId)));
  }

  isChatMember(chatId, userId) {
    return !!this.db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(Number(chatId), Number(userId));
  }

  getChatMember(chatId, userId) {
    const r = this.db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(Number(chatId), Number(userId));
    return r ? this._track(r, 'chat_members') : null;
  }

  addChatMember(cm) {
    this.db.prepare(`INSERT OR REPLACE INTO chat_members(chat_id,user_id,role,joined_at,last_read_message_id,hidden,cleared_at) VALUES(?,?,?,?,?,?,?)`).run(
      Number(cm.chat_id), Number(cm.user_id), cm.role || 'member', cm.joined_at || Date.now(),
      cm.last_read_message_id || 0, cm.hidden ? 1 : 0, cm.cleared_at || 0
    );
    return this.getChatMember(cm.chat_id, cm.user_id);
  }

  removeChatMember(chatId, userId) {
    this.db.prepare('DELETE FROM chat_members WHERE chat_id=? AND user_id=?').run(Number(chatId), Number(userId));
    return true;
  }

  updateChatMember(chatId, userId, patch) {
    const allowed = ['role', 'last_read_message_id', 'hidden', 'cleared_at'];
    const sets = [];
    const values = [];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        sets.push(k + ' = ?');
        values.push((k === 'hidden') ? (patch[k] ? 1 : 0) : patch[k]);
      }
    }
    if (!sets.length) return this.getChatMember(chatId, userId);
    values.push(Number(chatId), Number(userId));
    this.db.prepare('UPDATE chat_members SET ' + sets.join(',') + ' WHERE chat_id=? AND user_id=?').run(...values);
    return this.getChatMember(chatId, userId);
  }

  hideChatForUser(chatId, userId) {
    this.db.prepare('UPDATE chat_members SET hidden=1, cleared_at=? WHERE chat_id=? AND user_id=?').run(Date.now(), Number(chatId), Number(userId));
    return true;
  }

  restoreChatForUser(chatId, userId) {
    const m = this.getChatMember(chatId, userId);
    if (!m) return false;
    if (m.hidden) {
      this.db.prepare('UPDATE chat_members SET hidden=0 WHERE chat_id=? AND user_id=?').run(Number(chatId), Number(userId));
      return true;
    }
    return false;
  }

  getChatClearedAt(chatId, userId) {
    const m = this.getChatMember(chatId, userId);
    return m && m.cleared_at ? Number(m.cleared_at) : 0;
  }

  restoreHiddenChatMembers(chatId) {
    const rows = this.db.prepare('SELECT user_id FROM chat_members WHERE chat_id=? AND hidden=1').all(Number(chatId));
    this.db.prepare('UPDATE chat_members SET hidden=0 WHERE chat_id=? AND hidden=1').run(Number(chatId));
    return rows.map(r => r.user_id);
  }

  getChatMemberIds(chatId) {
    return this.db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(Number(chatId)).map(r => r.user_id);
  }

  getChatMembersWithDetails(chatId) {
    return this._wrap('chat_members', this.db.prepare('SELECT * FROM chat_members WHERE chat_id = ?').all(Number(chatId)));
  }

  // ==================== MESSAGES ====================
  findMessageById(id) {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
    return r ? this._track(this._mapMessage(r), 'messages') : null;
  }

  addMessage(message) {
    const id = message.id || this.nextId('messages');
    const deletedBy = Array.isArray(message.deleted_by) ? JSON.stringify(message.deleted_by) : JSON.stringify(message.deleted_by || []);
    const reactions = typeof message.reactions === 'object' ? JSON.stringify(message.reactions || {}) : (message.reactions || '{}');
    // E2EE-инвариант: type='sticker' -> encrypted_content/iv/header пустые, sticker_id задан;
    // для остальных типов sticker_id всегда NULL.
    const isSticker = message.type === 'sticker';
    const stickerId = isSticker ? (message.sticker_id || null) : null;
    this.db.prepare(`INSERT OR REPLACE INTO messages(id,chat_id,sender_id,encrypted_content,iv,header,type,reply_to,forwarded_from,edited,deleted_for_all,deleted_by,reactions,pinned,expires_at,sticker_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, Number(message.chat_id), Number(message.sender_id), isSticker ? null : (message.encrypted_content || ''),
      isSticker ? null : (message.iv || ''), isSticker ? null : (message.header || ''),
      message.type || 'text', message.reply_to || null, message.forwarded_from || null,
      message.edited ? 1 : 0, message.deleted_for_all ? 1 : 0, deletedBy, reactions,
      message.pinned ? 1 : 0, message.expires_at || null, stickerId, message.created_at || Date.now()
    );
    return this.findMessageById(id);
  }

  updateMessage(id, patch) {
    const allowed = ['encrypted_content', 'iv', 'header', 'type', 'reply_to', 'forwarded_from', 'edited', 'deleted_for_all', 'deleted_by', 'reactions', 'pinned', 'expires_at', 'sticker_id'];
    const sets = [];
    const values = [];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        sets.push(k + ' = ?');
        if (k === 'deleted_by' || k === 'reactions') values.push(JSON.stringify(patch[k] || (k === 'deleted_by' ? [] : {})));
        else if (k === 'edited' || k === 'deleted_for_all' || k === 'pinned') values.push(patch[k] ? 1 : 0);
        else values.push(patch[k]);
      }
    }
    if (!sets.length) return this.findMessageById(id);
    values.push(Number(id));
    this.db.prepare('UPDATE messages SET ' + sets.join(',') + ' WHERE id = ?').run(...values);
    return this.findMessageById(id);
  }

  deleteMessage(id) {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(Number(id));
    return true;
  }

  deleteMessagesByIds(ids) {
    const list = Array.from(ids || []).map(Number).filter(Number.isInteger);
    if (!list.length) return 0;
    const del = this.db.prepare('DELETE FROM messages WHERE id = ?');
    const tx = this.db.transaction(() => { for (const id of list) del.run(id); });
    tx();
    return list.length;
  }

  getChatMessages(chatId, limit = 50, beforeId = null) {
    let sql = 'SELECT * FROM messages WHERE chat_id = ?';
    const params = [Number(chatId)];
    if (beforeId) { sql += ' AND id < ?'; params.push(Number(beforeId)); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(Number(limit));
    const rows = this.db.prepare(sql).all(...params).reverse();
    return this._wrap('messages', rows.map(r => this._mapMessage(r)));
  }

  getMessagesByChat(chatId) {
    return this._wrap('messages', this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC').all(Number(chatId)).map(r => this._mapMessage(r)));
  }

  getPinnedMessages(chatId) {
    return this._wrap('messages', this.db.prepare('SELECT * FROM messages WHERE chat_id = ? AND pinned = 1 ORDER BY id ASC').all(Number(chatId)).map(r => this._mapMessage(r)));
  }

  _mapMessage(r) {
    return {
      id: r.id, chat_id: r.chat_id, sender_id: r.sender_id,
      encrypted_content: r.encrypted_content, iv: r.iv, header: r.header,
      type: r.type, reply_to: r.reply_to, forwarded_from: r.forwarded_from,
      edited: r.edited, deleted_for_all: r.deleted_for_all,
      deleted_by: safeJson(r.deleted_by, []),
      reactions: safeJson(r.reactions, {}),
      pinned: r.pinned, expires_at: r.expires_at, sticker_id: r.sticker_id || null, created_at: r.created_at
    };
  }

  // ==================== SESSIONS ====================
  _mapSession(r) {
    const Session = require('../models/Session');
    return new Session(r);
  }

  addSession(s) {
    const id = s.id || this.nextId('sessions');
    this.db.prepare(`INSERT OR REPLACE INTO sessions(id,user_id,token,token_hash,expires_at,created_at,last_used,user_agent,ip) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, Number(s.user_id), s.token || '', s.token_hash || '', s.expires_at || 0,
      s.created_at || Date.now(), s.last_used || Date.now(), s.user_agent || '', s.ip || ''
    );
    return this.findSessionById(id);
  }

  findSessionById(id) {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(id));
    return r ? this._track(this._mapSession(r), 'sessions') : null;
  }

  findSessionByToken(token) {
    const r = this.db.prepare('SELECT * FROM sessions WHERE token = ? OR token_hash = ?').get(token, token);
    return r ? this._track(this._mapSession(r), 'sessions') : null;
  }

  findSessionByHash(hash) {
    const r = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
    return r ? this._track(this._mapSession(r), 'sessions') : null;
  }

  deleteSession(id) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(Number(id));
    return true;
  }

  deleteSessionByToken(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return true;
  }

  deleteSessionByHash(hash) {
    const info = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return info.changes > 0;
  }

  purgeExpiredSessions(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at > 0 AND expires_at < ?').run(now);
  }

  // ==================== FILES ====================
  addFile(f) {
    const id = f.id || this.nextId('files');
    this.db.prepare(`INSERT OR REPLACE INTO files(id,filename,original_name,size,mimetype,uploader_id,created_at) VALUES(?,?,?,?,?,?,?)`).run(
      id, f.filename || '', f.original_name || '', f.size || 0, f.mimetype || '', f.uploader_id || null, f.created_at || Date.now()
    );
    return this.findFileById(id);
  }

  findFileById(id) {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(Number(id));
    return r ? this._track(r, 'files') : null;
  }

  // ==================== VERIFICATION CODES ====================
  addVerificationCode(v) {
    const id = v.id || this.nextId('verification_codes');
    this.db.prepare(`INSERT OR REPLACE INTO verification_codes(id,phone,code,attempts,expires_at,used,created_at) VALUES(?,?,?,?,?,?,?)`).run(
      id, v.phone || '', v.code || '', v.attempts || 0, v.expires_at || 0, v.used ? 1 : 0, v.created_at || Date.now()
    );
    v.id = id;
    return v;
  }

  findVerificationCode(phone) {
    return this._wrap('verification_codes', this.db.prepare('SELECT * FROM verification_codes WHERE phone = ? ORDER BY id ASC').all(phone));
  }

  findLatestVerificationCode(phone) {
    const r = this.db.prepare('SELECT * FROM verification_codes WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phone);
    return r ? this._track(r, 'verification_codes') : null;
  }

  deleteVerificationCode(phone) {
    this.db.prepare('DELETE FROM verification_codes WHERE phone = ?').run(phone);
    return true;
  }

  // ==================== FOLDERS ====================
  _mapFolder(r) {
    return { ...r, chat_ids: safeJson(r.chat_ids, []) };
  }

  getFolders(userId) {
    const rows = this.db.prepare('SELECT * FROM folders WHERE user_id = ?').all(Number(userId));
    return this._wrap('folders', rows.map(r => this._mapFolder(r)));
  }

  findFolderById(id) {
    const r = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(Number(id));
    return r ? this._track(this._mapFolder(r), 'folders') : null;
  }

  createFolder(userId, name, emoji, color) {
    const folder = {
      id: this.nextId('folders'),
      user_id: Number(userId),
      name: String(name || '').slice(0, 80),
      emoji: emoji || '',
      color: color || '',
      chat_ids: [],
      created_at: Date.now(),
      updated_at: Date.now()
    };
    this.addFolder(folder);
    return this.findFolderById(folder.id);
  }

  addFolder(f) {
    const id = f.id || this.nextId('folders');
    this.db.prepare(`INSERT OR REPLACE INTO folders(id,user_id,name,emoji,color,chat_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(
      id, Number(f.user_id), f.name || '', f.emoji || '', f.color || '', JSON.stringify(f.chat_ids || []),
      f.created_at || Date.now(), f.updated_at || Date.now()
    );
    return this.findFolderById(id);
  }

  updateFolder(id, userIdOrPatch, maybePatch) {
    const hasUser = maybePatch !== undefined;
    const userId = hasUser ? Number(userIdOrPatch) : null;
    const patch = (hasUser ? maybePatch : userIdOrPatch) || {};
    const folder = this.findFolderById(id);
    if (!folder) return null;
    if (userId !== null && Number(folder.user_id) !== userId) return null;
    const sets = [];
    const values = [];
    if (patch.name !== undefined) { sets.push('name=?'); values.push(String(patch.name).slice(0, 80)); }
    if (patch.emoji !== undefined) { sets.push('emoji=?'); values.push(patch.emoji || ''); }
    if (patch.color !== undefined) { sets.push('color=?'); values.push(patch.color || ''); }
    if (patch.chat_ids !== undefined) { sets.push('chat_ids=?'); values.push(JSON.stringify(patch.chat_ids || [])); }
    sets.push('updated_at=?');
    values.push(Date.now());
    values.push(Number(id));
    this.db.prepare('UPDATE folders SET ' + sets.join(',') + ' WHERE id = ?').run(...values);
    return this.findFolderById(id);
  }

  deleteFolder(id, userId = null) {
    const folder = this.findFolderById(id);
    if (!folder) return false;
    if (userId !== null && Number(folder.user_id) !== Number(userId)) return false;
    this.db.prepare('UPDATE chats SET folder_id = NULL WHERE folder_id = ?').run(Number(id));
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(Number(id));
    return true;
  }

  removeChatFromAllFolders(chatId) {
    const cid = Number(chatId);
    const rows = this.db.prepare('SELECT id, chat_ids FROM folders').all();
    for (const r of rows) {
      const arr = safeJson(r.chat_ids, []);
      const filtered = arr.filter(x => Number(x) !== cid);
      if (filtered.length !== arr.length) {
        this.db.prepare('UPDATE folders SET chat_ids=? WHERE id=?').run(JSON.stringify(filtered), r.id);
      }
    }
    this.db.prepare('UPDATE chats SET folder_id = NULL WHERE id = ?').run(cid);
  }

  // ==================== GROUP KEYS ====================
  findGroupKey(chatId) {
    const r = this.db.prepare('SELECT * FROM group_keys WHERE chat_id = ?').get(Number(chatId));
    if (!r) return null;
    return { ...r, wrapped: safeJson(r.wrapped, {}) };
  }

  saveGroupKey(chatId, version, wrapped, createdBy) {
    this.db.prepare(`INSERT OR REPLACE INTO group_keys(chat_id,version,wrapped,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)`).run(
      Number(chatId), version || 1, JSON.stringify(wrapped || {}), createdBy || null, Date.now(), Date.now()
    );
    return this.findGroupKey(chatId);
  }

  getUserChatsWithDetails(userId) {
    return this._wrap('chats', this.db.prepare(`SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id = c.id WHERE cm.user_id = ? AND (cm.hidden IS NULL OR cm.hidden = 0) ORDER BY c.updated_at DESC, c.id DESC`).all(Number(userId)));
  }

  // ==================== COMPATIBILITY COLLECTIONS ====================
  get users() { return this._wrap('users', this.db.prepare('SELECT * FROM users').all().map(r => this._mapUser(r))); }
  get chats() { return this._wrap('chats', this.db.prepare('SELECT * FROM chats').all()); }
  get messages() { return this._wrap('messages', this.db.prepare('SELECT * FROM messages').all().map(r => this._mapMessage(r))); }
  get chatMembers() { return this._wrap('chat_members', this.db.prepare('SELECT * FROM chat_members').all()); }
  get sessions() { return this._wrap('sessions', this.db.prepare('SELECT * FROM sessions').all().map(r => this._mapSession(r))); }
  get files() { return this._wrap('files', this.db.prepare('SELECT * FROM files').all()); }
  get folders() { return this._wrap('folders', this.db.prepare('SELECT * FROM folders').all().map(r => this._mapFolder(r))); }
  get groupKeys() { return this.db.prepare('SELECT * FROM group_keys').all().map(r => ({ ...r, wrapped: safeJson(r.wrapped, {}) })); }
  get verificationCodes() { return this._wrap('verification_codes', this.db.prepare('SELECT * FROM verification_codes').all()); }

  // ==================== USER STICKERS (legacy-методы удалены) ====================
  // Старая таблица user_stickers мигрирует в sticker_packs/stickers методом
  // migrateLegacyStickers() и DROP'ается. Ниже — новый слой доступа к пакам.

  // ---------- Паки ----------

  /**
   * Список паков по SQL-условию прав (prepared statements, без конкатенации id).
   * @param {string} where - 'author_id = ?' или '(is_public = 1 OR author_id = ?)'
   */
  listStickerPacks(where, userId, limit, offset) {
    return this.db.prepare(
      `SELECT * FROM sticker_packs WHERE ${where} ORDER BY order_index ASC, created_at DESC LIMIT ? OFFSET ?`
    ).all(Number(userId), Number(limit), Number(offset));
  }

  countStickerPacks(where, userId) {
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM sticker_packs WHERE ${where}`).get(Number(userId));
    return r ? r.c : 0;
  }

  findStickerPackById(id) {
    return this.db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(String(id)) || null;
  }

  /** INSERT OR IGNORE: идемпотентно при гонке/повторной миграции. true — создан. */
  createStickerPack(pack) {
    const info = this.db.prepare(`INSERT OR IGNORE INTO sticker_packs
      (id, name, author_id, cover_sticker_id, is_public, order_index, created_at, updated_at)
      VALUES (@id, @name, @author_id, @cover_sticker_id, @is_public, @order_index, @created_at, @updated_at)`).run(pack);
    return info.changes > 0 ? this.findStickerPackById(pack.id) : null;
  }

  updateStickerPack(id, patch) {
    const allowed = ['name', 'is_public', 'cover_sticker_id', 'order_index'];
    const sets = [];
    const values = [];
    for (const k of allowed) {
      if (patch[k] !== undefined) { sets.push(k + ' = ?'); values.push(patch[k]); }
    }
    if (!sets.length) return this.findStickerPackById(id);
    sets.push('updated_at = ?');
    values.push(Date.now(), String(id));
    this.db.prepare(`UPDATE sticker_packs SET ${sets.join(',')} WHERE id = ?`).run(...values);
    return this.findStickerPackById(id);
  }

  deleteStickerPack(id) {
    // Каскад ON DELETE CASCADE снимает stickers, favorites, recent.
    const info = this.db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(String(id));
    return info.changes > 0;
  }

  nextPackOrderIndex(userId) {
    const r = this.db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM sticker_packs WHERE author_id = ?').get(Number(userId));
    return (r ? r.m : -1) + 1;
  }

  reorderStickerPacks(ids) {
    const upd = this.db.prepare('UPDATE sticker_packs SET order_index = ?, updated_at = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      ids.forEach((id, i) => upd.run(i, Date.now(), String(id)));
    });
    tx();
    return true;
  }

  // ---------- Стикеры ----------

  findStickerById(id) {
    return this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(String(id)) || null;
  }

  /** Поиск стикера по относительному пути '<pack>/<file>' (для раздачи). */
  findStickerByFile(relFile) {
    return this.db.prepare("SELECT * FROM stickers WHERE file_path LIKE 'stickers/' || ?").get(String(relFile)) || null;
  }

  listStickersByPack(packId) {
    return this.db.prepare('SELECT * FROM stickers WHERE pack_id = ? ORDER BY order_index ASC, created_at ASC').all(String(packId));
  }

  countStickersInPack(packId) {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM stickers WHERE pack_id = ?').get(String(packId));
    return r ? r.c : 0;
  }

  createSticker(sticker) {
    this.db.prepare(`INSERT INTO stickers
      (id, pack_id, file_path, mime_type, width, height, emoji_tags, order_index, created_at)
      VALUES (@id, @pack_id, @file_path, @mime_type, @width, @height, @emoji_tags, @order_index, @created_at)`).run(sticker);
    return sticker;
  }

  updateSticker(id, patch) {
    const allowed = ['emoji_tags', 'order_index'];
    const sets = [];
    const values = [];
    for (const k of allowed) {
      if (patch[k] !== undefined) { sets.push(k + ' = ?'); values.push(patch[k]); }
    }
    if (!sets.length) return this.findStickerById(id);
    values.push(String(id));
    this.db.prepare(`UPDATE stickers SET ${sets.join(',')} WHERE id = ?`).run(...values);
    return this.findStickerById(id);
  }

  deleteSticker(id) {
    const info = this.db.prepare('DELETE FROM stickers WHERE id = ?').run(String(id));
    return info.changes > 0;
  }

  nextStickerOrderIndex(packId) {
    const r = this.db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM stickers WHERE pack_id = ?').get(String(packId));
    return (r ? r.m : -1) + 1;
  }

  /** Присваивает order_index по позиции в массиве; чужие пака id игнорируются. */
  reorderStickers(packId, ids) {
    const upd = this.db.prepare('UPDATE stickers SET order_index = ? WHERE id = ? AND pack_id = ?');
    const tx = this.db.transaction(() => {
      ids.forEach((id, i) => upd.run(i, String(id), String(packId)));
    });
    tx();
    return true;
  }

  // ---------- Избранное / недавние ----------

  addFavoriteSticker(userId, stickerId) {
    this.db.prepare('INSERT OR IGNORE INTO user_favorite_stickers(user_id, sticker_id, added_at) VALUES(?,?,?)')
      .run(Number(userId), String(stickerId), Date.now());
    return true;
  }

  removeFavoriteSticker(userId, stickerId) {
    const info = this.db.prepare('DELETE FROM user_favorite_stickers WHERE user_id = ? AND sticker_id = ?')
      .run(Number(userId), String(stickerId));
    return info.changes > 0;
  }

  listFavoriteStickers(userId) {
    return this.db.prepare(`SELECT s.* FROM stickers s
      JOIN user_favorite_stickers f ON f.sticker_id = s.id
      WHERE f.user_id = ? ORDER BY f.added_at DESC`).all(Number(userId));
  }

  touchRecentSticker(userId, stickerId) {
    this.db.prepare(`INSERT INTO user_recent_stickers(user_id, sticker_id, used_at) VALUES(?,?,?)
      ON CONFLICT(user_id, sticker_id) DO UPDATE SET used_at = excluded.used_at`)
      .run(Number(userId), String(stickerId), Date.now());
    // Удержание не более 20 записей на пользователя.
    this.db.prepare(`DELETE FROM user_recent_stickers WHERE user_id = ? AND sticker_id NOT IN (
      SELECT sticker_id FROM user_recent_stickers WHERE user_id = ? ORDER BY used_at DESC LIMIT 20)`)
      .run(Number(userId), Number(userId));
    return true;
  }

  listRecentStickers(userId, limit = 20) {
    return this.db.prepare(`SELECT s.* FROM stickers s
      JOIN user_recent_stickers r ON r.sticker_id = s.id
      WHERE r.user_id = ? ORDER BY r.used_at DESC LIMIT ?`).all(Number(userId), Number(limit));
  }

  clearRecentStickers(userId) {
    this.db.prepare('DELETE FROM user_recent_stickers WHERE user_id = ?').run(Number(userId));
    return true;
  }

  get counters() {
    const rows = this.db.prepare('SELECT * FROM counters').all();
    const out = {};
    for (const r of rows) out[r.name] = r.value;
    return { ...DEFAULT_COUNTERS, ...out };
  }

  set chatMembers(rows) { this._replaceCollection('chat_members', rows); }
  set messages(rows) { this._replaceCollection('messages', rows); }

  markDirty() {
    this._syncTracked();
    this.dirty = false;
  }

  save() {
    this._syncTracked();
    this.dirty = false;
    return true;
  }

  startAutoSave() {}
  stopAutoSave() {}
  flush() { this._syncTracked(); }
}

let instance;
module.exports = {
  getDatabase: () => {
    if (!instance) {
      instance = new Database();
      instance.load();
    }
    return instance;
  }
};