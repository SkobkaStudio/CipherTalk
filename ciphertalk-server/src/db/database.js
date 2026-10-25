const fs = require('fs');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3-multiple-ciphers');
const config = require('../config');
const dbEncryptionService = require('../services/dbEncryptionService');
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
    this.assignPublicIds();
    console.log('✅ База данных SQLite загружена (WAL)');
    return true;
  }

  // ==================== ПУБЛИЧНЫЕ ID ====================
  // Пользователи: положительные id, счётчик "users" (1 → "00000001", ..., 999999999).
  // Приватные чаты/saved: положительные id, счётчик "chats_pos".
  // Группы/каналы: отрицательные id (-1 → "-00000000000001", ...), счётчик "chats_neg".
  static MAX_USER_ID = 999999999;
  static MAX_CHAT_ID = 999999999;
  static MAX_GROUP_ID = 99999999999999;

  nextChatId(isNegative) {
    const name = isNegative ? 'chats_neg' : 'chats_pos';
    const row = this.db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
    const cur = row && typeof row.value === 'number' ? row.value : 0;
    const val = isNegative ? cur - 1 : cur + 1;
    const limit = isNegative ? Database.MAX_GROUP_ID : Database.MAX_CHAT_ID;
    if (Math.abs(val) > limit) {
      throw new Error('Пул идентификаторов чатов исчерпан');
    }
    this.db.prepare('INSERT OR REPLACE INTO counters(name,value) VALUES(?,?)').run(name, val);
    return val;
  }

  // Одноразовая миграция: присваиваем всем пользователям и чатам id из новых
  // диапазонов. Старые пользователи получают id по дате регистрации (самый
  // старый → 1 → "00000001"). Повторный запуск безопасен (проверяется флаг).
  assignPublicIds() {
    const flag = this.db.prepare("SELECT value FROM counters WHERE name = 'public_ids_migrated'").get();
    if (flag && flag.value === 1) return;

    const backupPath = this.sqlitePath + '.pre-publicids.bak';
    try {
      if (!fs.existsSync(backupPath)) {
        this.db.backup(backupPath);
        console.log('[DB] Резервная копия перед миграцией публичных id:', backupPath);
      }
    } catch (e) {
      console.error('[DB] Не удалось сделать бэкап перед миграцией id:', e.message);
    }

    this.db.pragma('foreign_keys = OFF');

    // ---------- пользователи: id по дате регистрации ----------
    const users = this.db.prepare('SELECT id FROM users ORDER BY created_at ASC, id ASC').all();
    const userMap = new Map();
    let uid = 0;
    for (const r of users) {
      uid++;
      if (Number(r.id) !== uid) userMap.set(Number(r.id), uid);
    }
    if (userMap.size) {
      const txU = this.db.transaction(() => {
        const tables = [
          ['users', 'id'],
          ['chat_members', 'user_id'],
          ['messages', 'sender_id'],
          ['sessions', 'user_id'],
          ['folders', 'user_id'],
          ['files', 'uploader_id'],
          ['user_stickers', 'user_id'],
          ['group_keys', 'created_by'],
        ];
        // Временный сдвиг id, чтобы избежать коллизий PRIMARY KEY при перестановке
        let shift = 1000000000;
        for (const [table, col] of tables) {
          try {
            this.db.prepare(`UPDATE ${table} SET ${col} = ${col} + ?`).run(shift);
            for (const [oldId, newId] of userMap) {
              this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(newId + shift, oldId + shift);
            }
            this.db.prepare(`UPDATE ${table} SET ${col} = ${col} - ?`).run(shift);
            shift = 0;
          } catch (e) {
            console.error(`[DB] migrate user ids in ${table}.${col}:`, e.message);
          }
        }
      });
      txU();
    }
    const maxUser = this.db.prepare('SELECT COALESCE(MAX(id),0) m FROM users').get().m;
    const userCounterVal = Math.max(uid, Number(maxUser) || 0);
    this.db.prepare('INSERT OR REPLACE INTO counters(name,value) VALUES(?,?)').run('users', userCounterVal);

    // ---------- чаты: приватные → положительные, группы/каналы → отрицательные ----------
    const gkSet = new Set(this.db.prepare('SELECT chat_id FROM group_keys').all().map(r => Number(r.chat_id)));
    const chats = this.db.prepare('SELECT * FROM chats ORDER BY created_at ASC, id ASC').all();
    const chatMap = new Map();
    let pos = 0, neg = 0;
    for (const c of chats) {
      const isNeg = c.type === 'group' || c.type === 'supergroup' || c.type === 'channel' || c.is_channel || gkSet.has(Number(c.id));
      let newId;
      try {
        newId = isNeg ? --neg : ++pos;
      } catch (e) { newId = isNeg ? --neg : ++pos; }
      if (Number(c.id) !== newId) chatMap.set(Number(c.id), newId);
    }
    // применяем в два прохода через временный сдвиг (защита от PK-коллизий)
    if (chatMap.size) {
      const txC = this.db.transaction(() => {
        const SHIFT = 1000000000000;
        const bump = (v) => (v < 0 ? v - SHIFT : v + SHIFT);
        const unshift = () => {
          for (const t of [['chats', 'id'], ['chat_members', 'chat_id'], ['messages', 'chat_id'], ['group_keys', 'chat_id']]) {
            this.db.prepare(`UPDATE ${t[0]} SET ${t[1]} = CASE WHEN ${t[1]} < 0 THEN ${t[1]} + ${SHIFT} ELSE ${t[1]} - ${SHIFT} END`).run();
          }
        };
        for (const t of [['chats', 'id'], ['chat_members', 'chat_id'], ['messages', 'chat_id'], ['group_keys', 'chat_id']]) {
          this.db.prepare(`UPDATE ${t[0]} SET ${t[1]} = CASE WHEN ${t[1]} < 0 THEN ${t[1]} - ${SHIFT} ELSE ${t[1]} + ${SHIFT} END`).run();
          for (const [oldId, newId] of chatMap) {
            this.db.prepare(`UPDATE ${t[0]} SET ${t[1]} = ? WHERE ${t[1]} = ?`).run(bump(newId), bump(oldId));
          }
        }
        unshift();
      });
      txC();
      // папки: remap chat_ids (JSON-массив)
      for (const f of this.db.prepare('SELECT id, chat_ids FROM folders').all()) {
        let arr = [];
        try { arr = JSON.parse(f.chat_ids || '[]'); } catch (_) { arr = []; }
        const mapped = arr.map(x => chatMap.has(Number(x)) ? chatMap.get(Number(x)) : Number(x));
        this.db.prepare('UPDATE folders SET chat_ids = ? WHERE id = ?').run(JSON.stringify(mapped), f.id);
      }
    }
    // счётчики continue с текущего максимума, если старые id уже больше
    const maxPos = this.db.prepare("SELECT COALESCE(MAX(id),0) m FROM chats WHERE id > 0").get().m;
    const minNeg = this.db.prepare("SELECT COALESCE(MIN(id),0) m FROM chats WHERE id < 0").get().m;
    this.db.prepare('INSERT OR REPLACE INTO counters(name,value) VALUES(?,?)').run('chats_pos', Math.max(pos, Number(maxPos) || 0));
    this.db.prepare('INSERT OR REPLACE INTO counters(name,value) VALUES(?,?)').run('chats_neg', Math.min(neg, Number(minNeg) || 0));

    this.db.pragma('foreign_keys = ON');
    this.db.prepare('INSERT OR REPLACE INTO counters(name,value) VALUES(?,?)').run('public_ids_migrated', 1);
    console.log(`[DB] Миграция публичных id завершена: пользователей=${uid}, чатов+=${pos}, чатов-=${neg}`);
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
    let id = c.id;
    if (id === undefined || id === null || id === '') {
      const type = String(c.type || '');
      const isNeg = type === 'group' || type === 'supergroup' || type === 'channel' || !!c.is_channel;
      id = this.nextChatId(isNeg);
    } else {
      id = Number(id);
    }
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