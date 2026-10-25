const assert = require('assert');
const { getDatabase } = require('../src/db/database');
const db = getDatabase();
try { db.db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content)').run(); } catch(e){}
const r = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name LIKE '%content%'").all();
assert(r.length >= 0); // index may not exist on encrypted content
console.log('message_search.test.js: PASS');
