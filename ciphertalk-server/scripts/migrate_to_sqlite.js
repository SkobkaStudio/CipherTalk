#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3-multiple-ciphers');
const dbEncryptionService = require('../src/services/dbEncryptionService');
const config = require('../src/config');

const jsonPath = config.dbFile || './ciphertalk-db.json';
const dbPath = jsonPath.replace(/\.json$/, '.sqlite') || './ciphertalk-db.sqlite';

console.log('[MIGRATE] Reading JSON from', jsonPath);
let raw = fs.readFileSync(jsonPath, 'utf8');
let json = raw;
if (dbEncryptionService.isEncryptedFile(raw)) {
  json = dbEncryptionService.decryptFile(raw);
  console.log('[MIGRATE] Decrypted at-rest JSON');
} else {
  console.log('[MIGRATE] Plain JSON');
}
const data = JSON.parse(json);
console.log('[MIGRATE] Users:', (data.users||[]).length, 'Chats:', (data.chats||[]).length, 'Messages:', (data.messages||[]).length);

const encryptionKey = config.dbEncryption ? dbEncryptionService.getKey() : null;

if (fs.existsSync(dbPath)) {
  const bak = dbPath + '.bak.' + Date.now();
  fs.copyFileSync(dbPath, bak);
  console.log('[MIGRATE] Backed up existing SQLite to', bak);
  fs.unlinkSync(dbPath);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (e) {}
  }
}

const db = new Database(dbPath);
if (encryptionKey) {
  db.pragma("cipher='sqlcipher'");
  db.pragma(`key="x'${encryptionKey.toString('hex')}'"`);
}
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
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
`);

const tx = db.transaction(() => {
  // counters
  const c = data.counters || {};
  const insC = db.prepare('INSERT OR REPLACE INTO counters(name,value) VALUES(?,?)');
  for (const k of ['users','chats','messages','files','sessions','folders']) {
    insC.run(k, c[k] || 0);
  }

  // users
  const insU = db.prepare(`INSERT OR REPLACE INTO users(id,phone,email,first_name,last_name,name,username,password_hash,avatar,bio,public_key,online,last_seen,hide_online,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const u of (data.users||[])) {
    insU.run(u.id, u.phone||'', u.email||'', u.first_name||'', u.last_name||'', u.name||'', u.username||null, u.password_hash||'', u.avatar||'', u.bio||'', u.public_key||'', u.online?1:0, u.last_seen||0, u.hide_online?1:0, u.created_at||Date.now(), u.updated_at||Date.now());
  }

  // chats
  const insCh = db.prepare(`INSERT OR REPLACE INTO chats(id,type,name,avatar,description,owner_id,is_pinned,is_channel,folder_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for (const ch of (data.chats||[])) {
    insCh.run(ch.id, ch.type||'private', ch.name||'', ch.avatar||'', ch.description||'', ch.owner_id||null, ch.is_pinned?1:0, ch.is_channel?1:0, ch.folder_id||null, ch.created_at||Date.now(), ch.updated_at||Date.now());
  }

  // members
  const insM = db.prepare(`INSERT OR REPLACE INTO chat_members(chat_id,user_id,role,joined_at,last_read_message_id,hidden,cleared_at) VALUES(?,?,?,?,?,?,?)`);
  for (const m of (data.chat_members||[])) {
    insM.run(m.chat_id, m.user_id, m.role||'member', m.joined_at||Date.now(), m.last_read_message_id||0, m.hidden?1:0, m.cleared_at||0);
  }

  // messages
  const insMsg = db.prepare(`INSERT OR REPLACE INTO messages(id,chat_id,sender_id,encrypted_content,iv,header,type,reply_to,forwarded_from,edited,deleted_for_all,deleted_by,reactions,pinned,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const msg of (data.messages||[])) {
    insMsg.run(msg.id, msg.chat_id, msg.sender_id, msg.encrypted_content||'', msg.iv||'', msg.header||'', msg.type||'text', msg.reply_to||null, msg.forwarded_from||null, msg.edited?1:0, msg.deleted_for_all?1:0, JSON.stringify(msg.deleted_by||[]), JSON.stringify(msg.reactions||{}), msg.pinned?1:0, msg.expires_at||null, msg.created_at||Date.now());
  }

  // sessions
  const insS = db.prepare(`INSERT OR REPLACE INTO sessions(id,user_id,token,token_hash,expires_at,created_at,last_used,user_agent,ip) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const s of (data.sessions||[])) {
    insS.run(s.id, s.user_id, s.token||'', s.token_hash||'', s.expires_at||0, s.created_at||Date.now(), s.last_used||Date.now(), s.user_agent||'', s.ip||'');
  }

  // files
  const insF = db.prepare(`INSERT OR REPLACE INTO files(id,filename,original_name,size,mimetype,uploader_id,created_at) VALUES(?,?,?,?,?,?,?)`);
  for (const f of (data.files||[])) {
    insF.run(f.id, f.filename||'', f.original_name||'', f.size||0, f.mimetype||'', f.uploader_id||null, f.created_at||Date.now());
  }

  // vcodes
  const insV = db.prepare(`INSERT OR REPLACE INTO verification_codes(id,phone,code,attempts,expires_at,used,created_at) VALUES(?,?,?,?,?,?,?)`);
  for (const v of (data.verification_codes||[])) {
    insV.run(v.id, v.phone||'', v.code||'', v.attempts||0, v.expires_at||0, v.used?1:0, v.created_at||Date.now());
  }

  // folders
  const insFo = db.prepare(`INSERT OR REPLACE INTO folders(id,user_id,name,emoji,color,chat_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
  for (const fo of (data.folders||[])) {
    insFo.run(fo.id, fo.user_id, fo.name||'', fo.emoji||'📁', fo.color||'', JSON.stringify(fo.chat_ids||[]), fo.created_at||Date.now(), fo.updated_at||Date.now());
  }

  // group keys
  const insGK = db.prepare(`INSERT OR REPLACE INTO group_keys(chat_id,version,wrapped,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)`);
  for (const gk of (data.group_keys||[])) {
    insGK.run(gk.chat_id, gk.version||1, JSON.stringify(gk.wrapped||{}), gk.created_by||null, gk.created_at||Date.now(), gk.updated_at||Date.now());
  }
});

tx();
db.close();
console.log('[MIGRATE] DONE. SQLite created at', dbPath);
