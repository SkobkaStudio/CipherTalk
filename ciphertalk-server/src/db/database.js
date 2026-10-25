const fs = require('fs');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3-multiple-ciphers');
const config = require('../config');
const dbEncryptionService = require('../services/dbEncryptionService');
// User импортируется один раз в начале файла: так require не вызывается
// из _mapUser при каждой загрузке строки (это ломало цикл инициализации
// модулей и приводило к "TypeError: User is not a constructor").
const User = require('../models/User');
const {
  padDigits,
  formatUserId,
  formatChatId,
  parsePublicId,
  privateChatInternalId,
  USER_ID_DIGITS,
  CHAT_ID_DIGITS,
  MAX_USER_INTERNAL_ID,
  MAX_CHAT_INTERNAL_ID
} = require('../utils/ids');

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
    this.assignPublicIds();
    console.log('✅ База данных SQLite загружена (WAL)');
    return true;
  }

  // ==================== ПУБЛИЧНЫЕ ID ====================
  // Каждому пользователю — 8-значный id (00000001 … 99999999),
  // каждой группе/каналу — отрицательный 14-значный (-00000000000001 …).
  // Внутренний id (INTEGER PRIMARY KEY) остаётся счётчиком и может быть
  // отрицательным (для личных чатов: -min(a,b)*1e6-max(a,b)), поэтому
  // стартовые значения публичных счётчиков считаются от количества записей.
  // Старые пользователи (зарегистрированные до этого обновления) получают
  // id автоматически по дате регистрации — от самого старого к новому.
  // Метод идемпотентен: запускается при каждом старте сервера и досчитывает
  // только отсутствующие значения.
  assignPublicIds() {
    const hasColumn = (table, col) => new Set(
      this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    ).has(col);

    for (const [table, col] of [['users', 'public_id'], ['chats', 'public_id']]) {
      if (!hasColumn(table, col)) {
        try {
          this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`).run();
        } catch (e) {
          if (!/duplicate column name/i.test(e.message)) {
            console.error('[DB] assignPublicIds column error:', e.message);
          }
        }
      }
    }

    try {
      this.db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id)').run();
      this.db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_public_id ON chats(public_id)').run();
    } catch (e) { /* индекс уже есть */ }

    // Счётчики считаются от максимального выданного номера (а не от числа
    // строк): так вставка id «в разрыв» (после досрочного break при лимите)
    // не создаёт дубликаты уникальных public_id.
    const maxAssigned = (table) => {
      const rows = this.db.prepare(`SELECT public_id FROM ${table} WHERE public_id IS NOT NULL AND public_id != ''`).all();
      let mx = 0;
      for (const r of rows) {
        const digits = String(r.public_id).replace(/^-/, '');
        const n = Number(digits);
        if (Number.isFinite(n) && n > mx) mx = Math.floor(n);
      }
      return mx;
    };

    const tx = this.db.transaction(() => {
      // --- Пользователи: счётчик с 1, сортировка по дате регистрации (старые первыми)
      let userCounter = maxAssigned('users');
      const usersWithout = this.db.prepare(
        "SELECT id FROM users WHERE public_id IS NULL OR public_id = '' ORDER BY created_at ASC, id ASC"
      ).all();
      const upU = this.db.prepare('UPDATE users SET public_id = ? WHERE id = ?');
      for (const row of usersWithout) {
        userCounter += 1;
        if (userCounter > MAX_USER_INTERNAL_ID) {
          console.error('[DB] Лимит 8-значных пользовательских id исчерпан (99999999)');
          break;
        }
        upU.run(formatUserId(userCounter), row.id);
      }

      // --- Группы и каналы: отрицательные 14-значные (-00000000000001 …)
      let groupCounter = 0;
      {
        const gRows = this.db.prepare(
          "SELECT public_id FROM chats WHERE public_id LIKE '-%'"
        ).all();
        for (const r of gRows) {
          const n = Number(String(r.public_id).replace(/^-/, ''));
          if (Number.isFinite(n) && n > groupCounter) groupCounter = Math.floor(n);
        }
      }
      const groupsWithout = this.db.prepare(
        "SELECT id FROM chats WHERE (public_id IS NULL OR public_id = '') " +
        "AND type IN ('group', 'supergroup', 'channel') ORDER BY created_at ASC, id ASC"
      ).all();
      const upG = this.db.prepare('UPDATE chats SET public_id = ? WHERE id = ?');
      for (const row of groupsWithout) {
        groupCounter += 1;
        if (groupCounter > MAX_CHAT_INTERNAL_ID) {
          console.error('[DB] Лимит 14-значных id групп/каналов исчерпан');
          break;
        }
        upG.run('-' + padDigits(groupCounter, CHAT_ID_DIGITS), row.id);
      }

      // --- «Избранное»: публичный id = публичный id владельца (ссылка /00000001)
      this.db.prepare(
        "UPDATE chats SET public_id = " +
        "(SELECT u.public_id FROM users u WHERE u.id = chats.owner_id) " +
        "WHERE type = 'saved' AND owner_id IS NOT NULL " +
        "AND (public_id IS NULL OR public_id = '') " +
        "AND EXISTS (SELECT 1 FROM users u WHERE u.id = chats.owner_id AND u.public_id IS NOT NULL AND u.public_id != '')"
      ).run();

      // --- Остальные личные чаты: публичный id = id собеседника (обновляется
      // при каждом старте — участники могли смениться)
      const privChats = this.db.prepare(
        "SELECT id FROM chats WHERE type = 'private' OR (type = 'saved' AND (public_id IS NULL OR public_id = ''))"
      ).all();
      const upP = this.db.prepare('UPDATE chats SET public_id = ? WHERE id = ?');
      const mRow = this.db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY joined_at ASC, rowid ASC LIMIT 2');
      const uPub = this.db.prepare('SELECT public_id FROM users WHERE id = ?');
      for (const row of privChats) {
        const ms = mRow.all(row.id);
        if (!ms.length) continue;
        const otherId = ms.length > 1 ? ms[1].user_id : ms[0].user_id;
        const pu = uPub.get(otherId);
        if (pu && pu.public_id) upP.run(pu.public_id, row.id);
      }
    });

    try {
      tx();
    } catch (e) {
      console.error('[DB] assignPublicIds failed:', e.message);
    }
  }

  /** Внутренний id пользователя -> публичный «00000001» (или строка с числом, если колонка пустая). */
  getPublicUserId(internalId) {
    const r = this.db.prepare('SELECT public_id FROM users WHERE id = ?').get(Number(internalId));
    return (r && r.public_id) || formatUserId(internalId);
  }

  /** Внутренний id чата -> публичный («-00000000000001» для групп/каналов, иначе 8-значный). */
  getPublicChatId(internalId, type, requesterId = null) {
    const cid = Number(internalId);
    if (cid < 0) {
      // Личный чат собеседника: публичный id = id собеседника (8 значных)
      const other = this.getPrivateChatOtherUserId(cid, requesterId != null ? Number(requesterId) : null);
      return other ? this.getPublicUserId(other) : '';
    }
    const r = this.db.prepare('SELECT public_id, type, owner_id FROM chats WHERE id = ?').get(cid);
    if (r && r.public_id) {
      // «Избранное»: токен совпадает с id владельца; если у токена уже есть
      // владелец-пользователь (например, аккаунт удалили и id освободился),
      // отдаём id собеседника, чтобы ссылка вела в нужный диалог.
      if (r.type === 'saved' && requesterId != null && Number(r.owner_id) !== Number(requesterId)) {
        const u = this.db.prepare('SELECT id FROM users WHERE public_id = ? AND id != ?').get(r.public_id, Number(requesterId));
        if (!u) return r.public_id;
      } else {
        return r.public_id;
      }
    }
    if (Number.isInteger(cid) && cid > 0) {
      return formatChatId(cid, (r && r.type) || type || 'private');
    }
    return formatChatId(cid, (r && r.type) || type || 'private');
  }

  /** Для личного чата (id < 0) — внутренний id собеседника. */
  getPrivateChatOtherUserId(negativeChatId, requesterInternalId) {
    const cid = Number(negativeChatId);
    if (cid >= 0) return null;
    const members = this.db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(cid);
    if (!members.length) return null;
    if (requesterInternalId != null) {
      const other = members.find(m => Number(m.user_id) !== Number(requesterInternalId));
      if (other) return Number(other.user_id);
    }
    return Number(members[0].user_id);
  }

  /** Публичный токен из URL -> внутренний id пользователя или чата (для групп — отрицательный). */
  findInternalByPublicToken(token) {
    const t = String(token || '').trim();
    const neg = /^-\d+$/.test(t);
    if (neg) {
      const r = this.db.prepare('SELECT id FROM chats WHERE public_id = ?').get(t);
      return r ? Number(r.id) : null;
    }
    const u = this.db.prepare('SELECT id FROM users WHERE public_id = ?').get(t);
    if (u) return { userId: Number(u.id) };
    const c = this.db.prepare('SELECT id, type FROM chats WHERE public_id = ?').get(t);
    if (c) return { chatId: Number(c.id), type: c.type };
    return null;
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

CREATE TABLE IF NOT EXISTS user_stickers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  name TEXT,
  animated INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_stickers_user ON user_stickers(user_id);
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
      ['messages', 'expires_at', 'expires_at INTEGER']
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
      'CREATE TABLE IF NOT EXISTS user_stickers (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, file_id INTEGER REFERENCES files(id) ON DELETE CASCADE, name TEXT, animated INTEGER DEFAULT 0, created_at INTEGER)',
      'CREATE INDEX IF NOT EXISTS idx_user_stickers_user ON user_stickers(user_id)'
    ];

    for (const sql of schemasToAdd) {
      try {
        this.db.prepare(sql).run();
      } catch (e) {
        // Игнорируем ошибки "table already exists" или "index already exists"
      }
    }
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
      this.db.prepare(`UPDATE messages SET encrypted_content=?, iv=?, header=?, type=?, reply_to=?, forwarded_from=?, edited=?, deleted_for_all=?, deleted_by=?, reactions=?, pinned=?, expires_at=? WHERE id=?`).run(
        item.encrypted_content || '', item.iv || '', item.header || '', item.type || 'text', item.reply_to || null,
        item.forwarded_from || null, item.edited ? 1 : 0, item.deleted_for_all ? 1 : 0,
        JSON.stringify(item.deleted_by || []), JSON.stringify(item.reactions || {}), item.pinned ? 1 : 0,
        item.expires_at || null, Number(item.id)
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
    const publicId = u.public_id || formatUserId(id);
    this.db.prepare(`INSERT OR REPLACE INTO users(id,phone,email,first_name,last_name,name,username,password_hash,avatar,bio,public_key,online,last_seen,hide_online,created_at,updated_at,public_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, u.phone || '', u.email || '', u.first_name || '', u.last_name || '', u.name || '', u.username || null,
      u.password_hash || '', u.avatar || '', u.bio || '', u.public_key || '', u.online ? 1 : 0,
      u.last_seen || 0, u.hide_online ? 1 : 0, u.created_at || Date.now(), u.updated_at || Date.now(), publicId
    );
    return this.findUserById(id);
  }

  /** Внутренний id пользователя по публичному 8-значному id («00000001»). */
  findUserByPublicId(publicId) {
    const t = String(publicId || '').trim();
    if (!t) return null;
    let r = this.db.prepare('SELECT * FROM users WHERE public_id = ?').get(t);
    if (!r) {
      // Фолбэк: старые строки без заполненной колонки — совпадение по числу
      const n = parsePublicId(t);
      if (n != null && n > 0) r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(n);
    }
    return r ? this._track(this._mapUser(r), 'users') : null;
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
    const type = c.type || 'private';
    // Публичный id: группы/каналы — отрицательный 14-значный; личные чаты и
    // «Избранное» получают его позже (для личных он равен id собеседника).
    let publicId = c.public_id || '';
    if (!publicId && Number(id) > 0) publicId = formatChatId(id, type);
    this.db.prepare(`INSERT OR REPLACE INTO chats(id,type,name,avatar,description,owner_id,is_pinned,is_channel,folder_id,created_at,updated_at,public_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, type, c.name || '', c.avatar || '', c.description || '', c.owner_id || null,
      c.is_pinned ? 1 : 0, c.is_channel ? 1 : 0, c.folder_id || null, c.created_at || Date.now(), c.updated_at || Date.now(), publicId
    );
    return this.findChatById(id);
  }

  /** Внутренний id нового личного чата между пользователями a и b (детерминированный, как в Telegram). */
  nextPrivateChatId(a, b) {
    const det = privateChatInternalId(a, b);
    if (det == null) return this.nextId('chats');
    if (!this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(det)) return det;
    return this.nextId('chats'); // на случай конфликта — обычная генерация
  }

  findChatByPublicId(publicId) {
    const t = String(publicId || '').trim();
    if (!t) return null;
    const r = this.db.prepare('SELECT * FROM chats WHERE public_id = ?').get(t);
    return r || null;
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
    this.db.prepare(`INSERT OR REPLACE INTO messages(id,chat_id,sender_id,encrypted_content,iv,header,type,reply_to,forwarded_from,edited,deleted_for_all,deleted_by,reactions,pinned,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, Number(message.chat_id), Number(message.sender_id), message.encrypted_content || '', message.iv || '',
      message.header || '', message.type || 'text', message.reply_to || null, message.forwarded_from || null,
      message.edited ? 1 : 0, message.deleted_for_all ? 1 : 0, deletedBy, reactions,
      message.pinned ? 1 : 0, message.expires_at || null, message.created_at || Date.now()
    );
    return this.findMessageById(id);
  }

  updateMessage(id, patch) {
    const allowed = ['encrypted_content', 'iv', 'header', 'type', 'reply_to', 'forwarded_from', 'edited', 'deleted_for_all', 'deleted_by', 'reactions', 'pinned', 'expires_at'];
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
      pinned: r.pinned, expires_at: r.expires_at, created_at: r.created_at
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

  // ==================== USER STICKERS ====================
  addUserSticker(sticker) {
    const row = {
      id: sticker.id,
      user_id: Number(sticker.user_id),
      file_id: Number(sticker.file_id),
      name: sticker.name || '',
      animated: sticker.animated ? 1 : 0,
      created_at: sticker.created_at || Date.now()
    };
    this.db.prepare(`INSERT INTO user_stickers (id, user_id, file_id, name, animated, created_at)
      VALUES (@id, @user_id, @file_id, @name, @animated, @created_at)`).run(row);
    return row;
  }

  getUserStickers(userId) {
    return this.db.prepare('SELECT * FROM user_stickers WHERE user_id = ? ORDER BY created_at DESC').all(Number(userId));
  }

  getUserStickerById(id) {
    return this.db.prepare('SELECT * FROM user_stickers WHERE id = ?').get(Number(id)) || null;
  }

  deleteUserSticker(id, userId) {
    const info = this.db.prepare('DELETE FROM user_stickers WHERE id = ? AND user_id = ?').run(Number(id), Number(userId));
    return info.changes > 0;
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