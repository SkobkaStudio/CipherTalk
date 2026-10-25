const WebSocket = require('ws');
const { getDatabase } = require('../src/db/database');
const sessionService = require('../src/services/sessionService');
const User = require('../src/models/User');
const Chat = require('../src/models/Chat');

async function run() {
  const db = getDatabase();
  const wsUrl = 'ws://127.0.0.1:3000';
  
  const users = [];
  for (let i = 0; i < 50; i++) {
    const phone = '+7999501' + String(i).padStart(4, '0');
    let u = db.findUserByPhone(phone);
    if (!u) {
      u = new User({
        id: db.nextId('users'),
        phone,
        first_name: 'LT',
        last_name: String(i),
        username: 'lt' + i
      });
      u.setPassword('test123456');
      db.users.push(u);
      u = db.findUserByPhone(phone);
    }
    users.push(u);
  }
  db.markDirty();
  
  for (let i = 0; i < Math.min(50, users.length); i++) {
    try {
      const { token } = sessionService.create(users[i].id, { userAgent: 'loadtest' });
      users[i]._token = token;
    } catch (e) {}
  }
  
  let testChatId = null;
  const chat = db.chats.find(c => c.type === 'group' && c.name === 'LoadTest');
  if (chat) testChatId = chat.id;
  else {
    testChatId = db.nextId('chats');
    db.chats.push(new Chat({ id: testChatId, type: 'group', name: 'LoadTest', owner_id: users[0].id }));
    for (let i = 0; i < Math.min(50, users.length); i++) {
      db.chatMembers.push({ chat_id: testChatId, user_id: users[i].id, role: i === 0 ? 'owner' : 'member', joined_at: Date.now() });
    }
    db.markDirty();
  }
  
  const connections = [];
  let connected = 0;
  let errors = 0;
  
  for (let i = 0; i < Math.min(50, users.length); i++) {
    try {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => {
        try { ws.send(JSON.stringify({ type: 'auth', token: users[i]._token })); } catch (e) { errors++; }
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'chats') connected++;
        } catch (e) {}
      });
      ws.on('error', () => { errors++; });
      connections.push(ws);
    } catch (e) { errors++; }
  }
  
  await new Promise(r => setTimeout(r, 4000));
  
  let sent = 0;
  for (let i = 0; i < connections.length; i++) {
    for (let j = 0; j < 10; j++) {
      try {
        if (connections[i].readyState === 1) {
          connections[i].send(JSON.stringify({
            type: 'send_message',
            chatId: testChatId,
            encrypted_content: 'lt' + i + '-' + j,
            iv: 'iv' + i + '-' + j,
            type_msg: 'text'
          }));
          sent++;
        }
      } catch (e) { errors++; }
    }
  }
  
  await new Promise(r => setTimeout(r, 4000));
  
  for (let ws of connections) {
    try { ws.close(); } catch (e) {}
  }
  
  console.log('=== LOAD TEST RESULTS ===');
  console.log('Connections:', connected + '/' + Math.min(50, users.length));
  console.log('Messages sent:', sent);
  console.log('Errors:', errors);
  console.log('Status:', errors < 50 ? 'PASS' : 'CHECK');
}
run().catch(e => { console.error(e.message); process.exit(1); });
