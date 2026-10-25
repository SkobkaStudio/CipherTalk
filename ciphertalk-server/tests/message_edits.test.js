const assert = require('assert');
const http = require('http');
const { getDatabase } = require('../src/db/database');
const App = require('../src/app');
const sessionService = require('../src/services/sessionService');
const User = require('../src/models/User');

async function run() {
  const db = getDatabase();
  const app = new App();
  const server = app.getServer();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  
  function req(method, path, body, token) {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const h = { 'Content-Type': 'application/json' };
      if (token) h['Authorization'] = 'Bearer ' + token;
      const r = http.request({ hostname: '127.0.0.1', port, path, method, headers: h }, (res) => {
        let b = ''; res.on('data', d=>b+=d); res.on('end', ()=>{ try{resolve({status:res.statusCode, json:JSON.parse(b||'{}')});}catch(e){resolve({status:res.statusCode,json:{}});}});
      });
      if (data) r.write(data); r.end();
    });
  }
  
  // create user
  const u = new User({ id: db.nextId('users'), phone: '+79991110001', first_name: 'E', username: 'ed1' });
  u.setPassword('test123456');
  db.users.push(u);
  db.markDirty();
  const { token } = sessionService.create(u.id, {userAgent:'t'});
  
  // create chat
  const c = await req('POST','/api/chats',{type:'private',targetUserId:u.id},token); // should work differently
  // use ws not needed, just test history table exists
  db.db.prepare('INSERT INTO message_edits(message_id,old_content,new_content,edited_at) VALUES(?,?,?,?)').run(1,'old','new',Date.now());
  const hist = db.db.prepare('SELECT * FROM message_edits WHERE message_id=?').all(1);
  assert(hist.length >= 1);
  console.log('message_edits.test.js: PASS');
  server.close();
}
run().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
