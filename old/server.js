const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));

// ==================== JSON БАЗА ДАННЫХ ====================
const DB_FILE = './ciphertalk-db.json';

let db = {
  users: [],
  verification_codes: [],
  chats: [],
  chat_members: [],
  messages: [],
  files: [],
  counters: { users: 0, chats: 0, messages: 0, files: 0 }
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      console.log('✅ База данных загружена');
    }
  } catch (e) {
    console.error('Ошибка загрузки БД:', e);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения БД:', e);
  }
}

loadDB();
setInterval(saveDB, 10000);

// ==================== ХЕШИРОВАНИЕ ПАРОЛЕЙ ====================
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const testHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === testHash;
}

// ==================== ЗАГРУЗКА ФАЙЛОВ ====================
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
    cb(null, uniqueName + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  
  db.counters.files++;
  const fileRecord = {
    id: db.counters.files,
    filename: req.file.filename,
    original_name: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploader_id: parseInt(req.body.userId) || 0,
    created_at: Date.now()
  };
  db.files.push(fileRecord);
  
  res.json({
    fileId: fileRecord.id,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    url: `/uploads/${req.file.filename}`
  });
});

app.use('/uploads', express.static(uploadsDir));

// ==================== API ====================

// 1. Отправка кода + проверка существует ли пользователь
app.post('/api/send-code', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Введите номер телефона' });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = Date.now() + 5 * 60 * 1000;

  db.verification_codes = db.verification_codes.filter(c => c.phone !== phone);
  db.verification_codes.push({ phone, code, expires_at: expiresAt });

  const existingUser = db.users.find(u => u.phone === phone);

  console.log(`\n🔐 CipherTalk - Код подтверждения:`);
  console.log(`📱 Номер: ${phone}`);
  console.log(`🔑 Код: ${code}`);
  console.log(`👤 Статус: ${existingUser ? 'СУЩЕСТВУЕТ (нужен пароль)' : 'НОВЫЙ (нужна регистрация)'}`);
  console.log(`⏰ Действителен до: ${new Date(expiresAt).toLocaleString()}\n`);

  res.json({ 
    success: true, 
    message: 'Код отправлен',
    exists: !!existingUser
  });
});

// 2. Проверка username на занятость
app.get('/api/check-username', (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ available: false, error: 'Пустой username' });

  const clean = username.replace(/^@/, '').toLowerCase();
  
  if (clean.length < 3) {
    return res.json({ available: false, error: 'Минимум 3 символа' });
  }
  
  if (!/^[a-z0-9_]+$/.test(clean)) {
    return res.json({ available: false, error: 'Только латиница, цифры и _' });
  }

  const taken = db.users.some(u => (u.username || '').toLowerCase() === clean);
  
  res.json({ 
    available: !taken,
    username: clean
  });
});

// 3. Проверка кода (возвращает что нужно дальше)
app.post('/api/verify-code', (req, res) => {
  const { phone, code } = req.body;

  const record = db.verification_codes.find(
    c => c.phone === phone && c.code === code && c.expires_at > Date.now()
  );
  
  if (!record) return res.status(400).json({ error: 'Неверный или просроченный код' });

  db.verification_codes = db.verification_codes.filter(c => c.phone !== phone);

  const existingUser = db.users.find(u => u.phone === phone);

  if (existingUser) {
    // Пользователь существует - нужен пароль
    res.json({ 
      success: true,
      action: 'login',
      phone,
      name: existingUser.name
    });
  } else {
    // Новый пользователь - нужна регистрация
    res.json({ 
      success: true,
      action: 'register',
      phone
    });
  }
});

// 4. Регистрация нового пользователя
app.post('/api/register', (req, res) => {
  const { phone, firstName, lastName, username, password, publicKey } = req.body;

  // Валидация
  if (!phone) return res.status(400).json({ error: 'Нет номера телефона' });
  if (!firstName || firstName.trim().length < 2) {
    return res.status(400).json({ error: 'Имя обязательно (минимум 2 символа)' });
  }
  if (!username || username.length < 3) {
    return res.status(400).json({ error: 'Username минимум 3 символа' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  }

  // Проверка что номер ещё не занят
  if (db.users.some(u => u.phone === phone)) {
    return res.status(400).json({ error: 'Номер уже зарегистрирован' });
  }

  // Проверка что username свободен
  const cleanUsername = username.replace(/^@/, '').toLowerCase();
  if (db.users.some(u => (u.username || '').toLowerCase() === cleanUsername)) {
    return res.status(400).json({ error: 'Username уже занят' });
  }

  // Создаём пользователя
  db.counters.users++;
  const user = {
    id: db.counters.users,
    phone,
    first_name: firstName.trim(),
    last_name: lastName ? lastName.trim() : '',
    name: lastName ? `${firstName.trim()} ${lastName.trim()}` : firstName.trim(),
    username: cleanUsername,
    avatar: '',
    public_key: publicKey || '',
    password_hash: hashPassword(password),
    online: 0,
    last_seen: 0,
    created_at: Date.now()
  };
  db.users.push(user);
  
  // Создаём "Избранное"
  db.counters.chats++;
  const savedChat = {
    id: db.counters.chats,
    type: 'saved',
    name: 'Избранное',
    avatar: '',
    owner_id: user.id,
    created_at: Date.now()
  };
  db.chats.push(savedChat);
  db.chat_members.push({ chat_id: savedChat.id, user_id: user.id, role: 'owner', joined_at: Date.now() });

  console.log(`\n✅ Новый пользователь зарегистрирован:`);
  console.log(`👤 ${user.name} (@${user.username})`);
  console.log(`📱 ${user.phone}\n`);

  res.json({
    success: true,
    user: {
      id: user.id,
      phone: user.phone,
      firstName: user.first_name,
      lastName: user.last_name,
      name: user.name,
      username: user.username,
      avatar: user.avatar,
      publicKey: user.public_key
    }
  });
});

// 5. Вход по паролю (для существующих пользователей)
app.post('/api/login', (req, res) => {
  const { phone, password, publicKey } = req.body;

  const user = db.users.find(u => u.phone === phone);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  if (!user.password_hash) {
    return res.status(400).json({ error: 'Пароль не установлен. Обратитесь в поддержку.' });
  }

  if (!verifyPassword(password, user.password_hash)) {
    return res.status(400).json({ error: 'Неверный пароль' });
  }

  if (publicKey) user.public_key = publicKey;

  console.log(`\n✅ Вход пользователя: ${user.name} (@${user.username})`);

  res.json({
    success: true,
    user: {
      id: user.id,
      phone: user.phone,
      firstName: user.first_name,
      lastName: user.last_name,
      name: user.name,
      username: user.username,
      avatar: user.avatar,
      publicKey: user.public_key
    }
  });
});

// 6. Обновление профиля
app.post('/api/update-profile', (req, res) => {
  const { userId, firstName, lastName, username, avatar, publicKey, oldPassword, newPassword } = req.body;
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (firstName !== undefined) user.first_name = firstName;
  if (lastName !== undefined) user.last_name = lastName;
  if (firstName !== undefined || lastName !== undefined) {
    user.name = user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
  }
  
  if (username !== undefined) {
    const clean = username.replace(/^@/, '').toLowerCase();
    if (db.users.some(u => u.id !== userId && (u.username || '').toLowerCase() === clean)) {
      return res.status(400).json({ error: 'Username занят' });
    }
    user.username = clean;
  }
  
  if (avatar !== undefined) user.avatar = avatar;
  if (publicKey !== undefined) user.public_key = publicKey;
  
  if (newPassword && oldPassword) {
    if (!verifyPassword(oldPassword, user.password_hash)) {
      return res.status(400).json({ error: 'Неверный текущий пароль' });
    }
    user.password_hash = hashPassword(newPassword);
  }

  res.json({ success: true, user });
});

// 7. Поиск пользователей
app.get('/api/search-users', (req, res) => {
  const { query, userId } = req.query;
  if (!query) return res.json([]);

  const uid = parseInt(userId);
  const q = query.toLowerCase().replace(/^@/, '');
  
  const users = db.users
    .filter(u => u.id !== uid && (
      u.name.toLowerCase().includes(q) ||
      u.phone.toLowerCase().includes(q) ||
      (u.username && u.username.toLowerCase().includes(q))
    ))
    .slice(0, 20)
    .map(u => ({
      id: u.id,
      phone: u.phone,
      name: u.name,
      firstName: u.first_name,
      lastName: u.last_name,
      username: u.username,
      avatar: u.avatar,
      public_key: u.public_key
    }));

  res.json(users);
});

// ==================== WEBSOCKET ====================
const clients = new Map();

wss.on('connection', (ws) => {
  let currentUserId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'auth': {
          currentUserId = msg.userId;
          clients.set(currentUserId, ws);
          
          const user = db.users.find(u => u.id === currentUserId);
          if (user) {
            user.online = 1;
            user.last_seen = Date.now();
          }
          
          const userChats = db.chat_members
            .filter(cm => cm.user_id === currentUserId)
            .map(cm => {
              const chat = db.chats.find(c => c.id === cm.chat_id);
              if (!chat) return null;
              
              const members = db.chat_members
                .filter(m => m.chat_id === chat.id)
                .map(m => {
                  const u = db.users.find(usr => usr.id === m.user_id);
                  return u ? {
                    id: u.id,
                    name: u.name,
                    firstName: u.first_name,
                    lastName: u.last_name,
                    phone: u.phone,
                    username: u.username,
                    avatar: u.avatar,
                    public_key: u.public_key,
                    online: u.online,
                    last_seen: u.last_seen,
                    role: m.role
                  } : null;
                })
                .filter(Boolean);
              
              const chatMessages = db.messages.filter(m => m.chat_id === chat.id);
              const lastMsg = chatMessages[chatMessages.length - 1];
              
              return {
                ...chat,
                role: cm.role,
                members,
                last_message: lastMsg?.encrypted_content || '',
                last_message_time: lastMsg?.created_at || 0,
                last_sender_id: lastMsg?.sender_id || 0
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.last_message_time - a.last_message_time);

          ws.send(JSON.stringify({ type: 'chats', chats: userChats }));
          break;
        }

        case 'get_public_key': {
          const user = db.users.find(u => u.id === msg.targetUserId);
          ws.send(JSON.stringify({
            type: 'public_key',
            userId: msg.targetUserId,
            publicKey: user?.public_key || ''
          }));
          break;
        }

        case 'start_chat': {
          const myChats = db.chat_members.filter(cm => cm.user_id === currentUserId).map(cm => cm.chat_id);
          const targetChats = db.chat_members.filter(cm => cm.user_id === msg.targetUserId).map(cm => cm.chat_id);
          
          let chatId = null;
          for (const cid of myChats) {
            if (targetChats.includes(cid)) {
              const chat = db.chats.find(c => c.id === cid && c.type === 'private');
              if (chat) { chatId = chat.id; break; }
            }
          }

          if (!chatId) {
            db.counters.chats++;
            chatId = db.counters.chats;
            db.chats.push({
              id: chatId,
              type: 'private',
              name: '',
              avatar: '',
              owner_id: null,
              created_at: Date.now()
            });
            db.chat_members.push({ chat_id: chatId, user_id: currentUserId, role: 'member', joined_at: Date.now() });
            db.chat_members.push({ chat_id: chatId, user_id: msg.targetUserId, role: 'member', joined_at: Date.now() });
          }

          const members = db.chat_members
            .filter(m => m.chat_id === chatId)
            .map(m => {
              const u = db.users.find(usr => usr.id === m.user_id);
              return u ? {
                id: u.id, name: u.name, firstName: u.first_name, lastName: u.last_name,
                phone: u.phone, username: u.username, avatar: u.avatar, public_key: u.public_key,
                online: u.online, last_seen: u.last_seen, role: m.role
              } : null;
            })
            .filter(Boolean);

          ws.send(JSON.stringify({ type: 'chat_created', chatId, members }));
          break;
        }

        case 'create_group': {
          db.counters.chats++;
          const chatId = db.counters.chats;
          db.chats.push({
            id: chatId,
            type: msg.groupType || 'group',
            name: msg.name || 'Группа',
            avatar: msg.avatar || '',
            owner_id: currentUserId,
            created_at: Date.now()
          });
          
          db.chat_members.push({ chat_id: chatId, user_id: currentUserId, role: 'owner', joined_at: Date.now() });
          
          if (msg.members && Array.isArray(msg.members)) {
            msg.members.forEach(uid => {
              db.chat_members.push({ chat_id: chatId, user_id: uid, role: 'member', joined_at: Date.now() });
            });
          }

          const members = db.chat_members
            .filter(m => m.chat_id === chatId)
            .map(m => {
              const u = db.users.find(usr => usr.id === m.user_id);
              return u ? {
                id: u.id, name: u.name, firstName: u.first_name, lastName: u.last_name,
                phone: u.phone, username: u.username, avatar: u.avatar, public_key: u.public_key,
                online: u.online, last_seen: u.last_seen, role: m.role
              } : null;
            })
            .filter(Boolean);

          const notification = JSON.stringify({
            type: 'new_chat',
            chat: { id: chatId, type: msg.groupType || 'group', name: msg.name, members }
          });

          members.forEach(m => {
            const client = clients.get(m.id);
            if (client) client.send(notification);
          });
          break;
        }

        case 'send_message': {
          db.counters.messages++;
          const messageId = db.counters.messages;
          const now = Date.now();
          
          const message = {
            id: messageId,
            chat_id: msg.chatId,
            sender_id: currentUserId,
            encrypted_content: msg.content,
            iv: msg.iv || '',
            type: msg.msgType || 'text',
            reply_to: msg.replyTo || null,
            edited: 0,
            created_at: now
          };
          
          db.messages.push(message);

          const sender = db.users.find(u => u.id === currentUserId);
          const payload = JSON.stringify({
            type: 'new_message',
            message: {
              id: message.id,
              chatId: message.chat_id,
              senderId: message.sender_id,
              content: message.encrypted_content,
              iv: message.iv,
              type: message.type,
              replyTo: message.reply_to,
              edited: 0,
              createdAt: message.created_at
            }
          });

          const members = db.chat_members.filter(m => m.chat_id === msg.chatId);
          members.forEach(m => {
            const client = clients.get(m.user_id);
            if (client) client.send(payload);
          });

          members.forEach(m => {
            const client = clients.get(m.user_id);
            if (client) {
              client.send(JSON.stringify({
                type: 'chat_updated',
                chatId: msg.chatId,
                lastMessage: msg.content,
                lastMessageTime: now,
                lastSenderId: currentUserId,
                senderName: sender?.name
              }));
            }
          });
          break;
        }

        case 'edit_message': {
          const msgRec = db.messages.find(m => m.id === msg.messageId && m.sender_id === currentUserId);
          if (msgRec) {
            msgRec.encrypted_content = msg.content;
            msgRec.edited = 1;
          }
          
          const members = db.chat_members.filter(m => m.chat_id === msg.chatId);
          const payload = JSON.stringify({
            type: 'message_edited',
            messageId: msg.messageId,
            content: msg.content,
            chatId: msg.chatId
          });
          members.forEach(m => {
            const client = clients.get(m.user_id);
            if (client) client.send(payload);
          });
          break;
        }

        case 'delete_message': {
          db.messages = db.messages.filter(m => !(m.id === msg.messageId && m.sender_id === currentUserId));
          
          const members = db.chat_members.filter(m => m.chat_id === msg.chatId);
          const payload = JSON.stringify({
            type: 'message_deleted',
            messageId: msg.messageId,
            chatId: msg.chatId
          });
          members.forEach(m => {
            const client = clients.get(m.user_id);
            if (client) client.send(payload);
          });
          break;
        }

        case 'get_messages': {
          const chatMessages = db.messages
            .filter(m => m.chat_id === msg.chatId)
            .slice(-50)
            .map(m => {
              const sender = db.users.find(u => u.id === m.sender_id);
              return {
                id: m.id,
                chat_id: m.chat_id,
                sender_id: m.sender_id,
                sender_name: sender?.name || '',
                sender_avatar: sender?.avatar || '',
                encrypted_content: m.encrypted_content,
                iv: m.iv,
                type: m.type,
                reply_to: m.reply_to,
                edited: m.edited,
                created_at: m.created_at
              };
            });

          ws.send(JSON.stringify({ type: 'messages', chatId: msg.chatId, messages: chatMessages }));
          break;
        }

        case 'typing': {
          const members = db.chat_members.filter(m => m.chat_id === msg.chatId);
          const sender = db.users.find(u => u.id === currentUserId);
          const payload = JSON.stringify({
            type: 'typing',
            chatId: msg.chatId,
            userId: currentUserId,
            name: sender?.name
          });
          members.forEach(m => {
            if (m.user_id !== currentUserId) {
              const client = clients.get(m.user_id);
              if (client) client.send(payload);
            }
          });
          break;
        }

        case 'add_member': {
          const exists = db.chat_members.find(m => m.chat_id === msg.chatId && m.user_id === msg.userId);
          if (!exists) {
            db.chat_members.push({ chat_id: msg.chatId, user_id: msg.userId, role: 'member', joined_at: Date.now() });
          }
          
          const members = db.chat_members
            .filter(m => m.chat_id === msg.chatId)
            .map(m => {
              const u = db.users.find(usr => usr.id === m.user_id);
              return u ? {
                id: u.id, name: u.name, firstName: u.first_name, lastName: u.last_name,
                phone: u.phone, username: u.username, avatar: u.avatar, public_key: u.public_key,
                online: u.online, last_seen: u.last_seen, role: m.role
              } : null;
            })
            .filter(Boolean);

          const payload = JSON.stringify({ type: 'member_added', chatId: msg.chatId, members });
          members.forEach(m => {
            const client = clients.get(m.id);
            if (client) client.send(payload);
          });
          break;
        }

        case 'set_public_key': {
          const user = db.users.find(u => u.id === currentUserId);
          if (user) user.public_key = msg.publicKey;
          break;
        }
      }
    } catch (e) {
      console.error('WS Error:', e);
    }
  });

  ws.on('close', () => {
    if (currentUserId) {
      clients.delete(currentUserId);
      const user = db.users.find(u => u.id === currentUserId);
      if (user) {
        user.online = 0;
        user.last_seen = Date.now();
      }
      
      const payload = JSON.stringify({ type: 'user_offline', userId: currentUserId });
      clients.forEach((client) => {
        try { client.send(payload); } catch(e) {}
      });
    }
  });
});

setInterval(() => {
  const onlineIds = db.users.filter(u => u.online === 1).map(u => u.id);
  const payload = JSON.stringify({ type: 'online_users', users: onlineIds });
  clients.forEach((client) => {
    try { client.send(payload); } catch(e) {}
  });
}, 30000);

process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 CipherTalk сервер запущен на порту ${PORT}`);
  console.log(`📦 База данных: ${DB_FILE}`);
  console.log(`📁 Загрузки: ${uploadsDir}`);
  console.log(`🌐 API: http://localhost:${PORT}/api/`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}\n`);
});