/**
====================================================================
ANTI-SCAM MESSENGER v4.0 - ПРОФИЛИ + СТАТУСЫ + ПЕЧАТЬ
====================================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ========== ХРАНИЛИЩЕ ==========
const DATA_DIR = path.join(__dirname, 'server-data');
const UPLOADS_DIR = path.join(DATA_DIR, 'encrypted_media');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const DB_FILE = path.join(DATA_DIR, 'antiscam.db');

[DATA_DIR, UPLOADS_DIR, AVATARS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const SMS_CONFIG = { demoMode: true, apiId: 'YOUR_SMS_RU_KEY' };

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Multer для медиа
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(24).toString('hex'))
});
const uploadMedia = multer({ storage: mediaStorage, limits: { fileSize: 15 * 1024 * 1024 } });

// Multer для аватарок
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => cb(null, req.userPhone + '_' + Date.now() + path.extname(file.originalname))
});
const uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// ========== БАЗА ДАННЫХ ==========
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error('[-] Ошибка БД:', err.message);
  else {
    console.log('[+] БД подключена');
    createTables();
  }
});

function createTables() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      avatar_url TEXT,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS otp_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_phone TEXT NOT NULL,
      receiver_phone TEXT NOT NULL,
      encrypted_text TEXT NOT NULL,
      media_url TEXT,
      media_type TEXT,
      timestamp INTEGER NOT NULL
    )`);
    
    // 🔑 Ключи шифрования
    db.run(`CREATE TABLE IF NOT EXISTS chat_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_phone TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      chat_key TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_phone, contact_phone)
    )`);
    
    // 📱 Сессии устройств
    db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT,
      token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (phone) REFERENCES users(phone)
    )`);
    
    //  Активность пользователя (last_seen)
    db.run(`CREATE TABLE IF NOT EXISTS user_activity (
      phone TEXT PRIMARY KEY,
      last_seen INTEGER NOT NULL,
      is_online INTEGER DEFAULT 0
    )`);
  });
}

// ========== СЕССИИ И СТАТУСЫ ==========
const activeSessions = new Map();
const onlineClients = new Map(); // phone -> Set of ws
const userStatus = new Map();    // phone -> { typing: bool, uploading: bool, lastSeen: timestamp }

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Токен отсутствует' });
  
  db.get(`SELECT phone, device_id FROM user_sessions WHERE token = ?`, [token], (err, session) => {
    if (err || !session) return res.status(403).json({ error: 'Сессия недействительна' });
    req.userPhone = session.phone;
    req.deviceId = session.device_id;
    req.token = token;
    db.run(`UPDATE user_sessions SET last_active = CURRENT_TIMESTAMP WHERE token = ?`, [token]);
    next();
  });
}

// Обновить last_seen
function updateLastSeen(phone) {
  const now = Date.now();
  db.run(`INSERT OR REPLACE INTO user_activity (phone, last_seen, is_online) VALUES (?, ?, 1)`, [phone, now]);
  userStatus.set(phone, { ...userStatus.get(phone), lastSeen: now });
}

// ========== СМС ==========
async function sendVerificationSms(phone, code) {
  console.log(`\n${'='.repeat(60)}\n СМС ДЛЯ +7${phone}: ${code}\n${'='.repeat(60)}\n`);
  if (SMS_CONFIG.demoMode) return true;
  try {
    const res = await fetch(`https://sms.ru/sms/send?api_id=${SMS_CONFIG.apiId}&to=7${phone}&msg=${encodeURIComponent(`Код Anti-Scam: ${code}`)}&json=1`);
    return (await res.json()).status === "OK";
  } catch (e) { return false; }
}

// ========== REST API ==========

app.post('/api/auth/request-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10 || !/^\d+$/.test(phone)) {
    return res.status(400).json({ error: 'Введите 10 цифр' });
  }
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  db.run(`INSERT OR REPLACE INTO otp_codes (phone, code, expires_at) VALUES (?, ?, ?)`,
    [phone, code, expiresAt], async (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка БД' });
      await sendVerificationSms(phone, code);
      res.json({ message: 'Код отправлен' });
    });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, code, deviceId, deviceName } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Укажите телефон и код' });
  
  db.get(`SELECT * FROM otp_codes WHERE phone = ?`, [phone], (err, row) => {
    if (err || !row) return res.status(400).json({ error: 'Код не запрошен' });
    if (Date.now() > row.expires_at) {
      db.run(`DELETE FROM otp_codes WHERE phone = ?`, [phone]);
      return res.status(400).json({ error: 'Код истёк' });
    }
    if (row.code !== code) return res.status(400).json({ error: 'Неверный код' });
    
    db.run(`DELETE FROM otp_codes WHERE phone = ?`, [phone]);
    db.get(`SELECT phone, name, avatar_url, bio FROM users WHERE phone = ?`, [phone], (err, user) => {
      if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        db.run(`INSERT INTO user_sessions (phone, device_id, device_name, token) VALUES (?, ?, ?, ?)`,
          [phone, deviceId || 'web_' + Date.now(), deviceName || 'Веб-браузер', token], (err) => {
            if (err) return res.status(500).json({ error: 'Ошибка создания сессии' });
            activeSessions.set(token, { phone, deviceId });
            res.json({ status: 'login_success', token, user, deviceId });
          });
      } else {
        res.json({ status: 'need_registration', phone });
      }
    });
  });
});

app.post('/api/auth/register', async (req, res) => {
  const { phone, name, password, deviceId, deviceName } = req.body;
  if (!phone || !name || !password || password.length < 6) {
    return res.status(400).json({ error: 'Все поля обязательны, пароль мин. 6 символов' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    db.run(`INSERT INTO users (phone, name, password_hash) VALUES (?, ?, ?)`,
      [phone, name, hash], (err) => {
        if (err) return res.status(400).json({ error: 'Номер занят' });
        const token = crypto.randomBytes(32).toString('hex');
        db.run(`INSERT INTO user_sessions (phone, device_id, device_name, token) VALUES (?, ?, ?, ?)`,
          [phone, deviceId || 'web_' + Date.now(), deviceName || 'Веб-браузер', token], (err2) => {
            if (err2) return res.status(500).json({ error: 'Ошибка сессии' });
            activeSessions.set(token, { phone, deviceId });
            res.status(201).json({ token, user: { phone, name, avatar_url: null, bio: '' }, deviceId });
          });
      });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/auth/login-password', async (req, res) => {
  const { phone, password, deviceId, deviceName } = req.body;
  db.get(`SELECT * FROM users WHERE phone = ?`, [phone], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Пользователь не найден' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Неверный пароль' });
    
    const token = crypto.randomBytes(32).toString('hex');
    db.run(`INSERT INTO user_sessions (phone, device_id, device_name, token) VALUES (?, ?, ?, ?)`,
      [phone, deviceId || 'web_' + Date.now(), deviceName || 'Веб-браузер', token], (err) => {
        if (err) return res.status(500).json({ error: 'Ошибка сессии' });
        activeSessions.set(token, { phone, deviceId });
        res.json({ token, user: { phone: user.phone, name: user.name, avatar_url: user.avatar_url, bio: user.bio }, deviceId });
      });
  });
});

// Получить свои сессии
app.get('/api/auth/sessions', requireAuth, (req, res) => {
  db.all(`SELECT device_id, device_name, created_at, last_active FROM user_sessions 
          WHERE phone = ? ORDER BY last_active DESC`, [req.userPhone], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Ошибка' });
    res.json(rows);
  });
});

// Удалить сессию
app.delete('/api/auth/sessions/:deviceId', requireAuth, (req, res) => {
  const { deviceId } = req.params;
  db.run(`DELETE FROM user_sessions WHERE phone = ? AND device_id = ?`, 
    [req.userPhone, deviceId], (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка' });
      res.json({ message: 'Сессия удалена' });
    });
});

//  ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ (для просмотра)
app.get('/api/users/:phone/profile', requireAuth, (req, res) => {
  const targetPhone = req.params.phone;
  db.get(`SELECT phone, name, bio, avatar_url, registered_at FROM users WHERE phone = ?`, 
    [targetPhone], (err, row) => {
      if (err || !row) return res.status(404).json({ error: 'Не найден' });
      
      // Получаем last_seen из таблицы активности
      db.get(`SELECT last_seen FROM user_activity WHERE phone = ?`, [targetPhone], (err2, act) => {
        const isOnline = onlineClients.has(targetPhone);
        res.json({
          ...row,
          lastSeen: act ? act.last_seen : null,
          isOnline
        });
      });
    });
});

// Поиск пользователя
app.get('/api/users/find/:phone', requireAuth, (req, res) => {
  db.get(`SELECT phone, name, avatar_url FROM users WHERE phone = ?`, [req.params.phone], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Не найден' });
    res.json(row);
  });
});

app.get('/api/messages/history/:contactPhone', requireAuth, (req, res) => {
  db.all(`SELECT * FROM messages WHERE (sender_phone = ? AND receiver_phone = ?) OR (sender_phone = ? AND receiver_phone = ?) ORDER BY timestamp ASC`,
    [req.userPhone, req.params.contactPhone, req.params.contactPhone, req.userPhone],
    (err, rows) => err ? res.status(500).json({ error: 'Ошибка' }) : res.json(rows));
});

app.post('/api/media/upload', requireAuth, uploadMedia.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ mediaUrl: `/api/media/download/${req.file.filename}` });
});

app.get('/api/media/download/:filename', requireAuth, (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  fs.existsSync(filePath) ? res.sendFile(filePath) : res.status(404).json({ error: 'Не найдено' });
});

// 🔑 Ключи
app.post('/api/keys/save', requireAuth, (req, res) => {
  const { contactPhone, chatKey } = req.body;
  db.run(`INSERT OR REPLACE INTO chat_keys (owner_phone, contact_phone, chat_key) VALUES (?, ?, ?)`,
    [req.userPhone, contactPhone, chatKey], (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка' });
      res.json({ message: 'Ключ сохранён' });
    });
});

app.get('/api/keys/all', requireAuth, (req, res) => {
  db.all(`SELECT contact_phone, chat_key FROM chat_keys WHERE owner_phone = ?`, 
    [req.userPhone], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Ошибка' });
      res.json(rows);
    });
});

// 👤 Профиль текущего пользователя
app.get('/api/profile', requireAuth, (req, res) => {
  db.get(`SELECT phone, name, avatar_url, bio FROM users WHERE phone = ?`, [req.userPhone],
    (err, row) => err || !row ? res.status(404).json({ error: 'Не найден' }) : res.json(row));
});

// Обновить профиль
app.post('/api/profile/update', requireAuth, (req, res) => {
  const { name, bio } = req.body;
  if (!name) return res.status(400).json({ error: 'Имя обязательно' });
  db.run(`UPDATE users SET name = ?, bio = ? WHERE phone = ?`, [name, bio || '', req.userPhone],
    (err) => err ? res.status(500).json({ error: 'Ошибка' }) : res.json({ message: 'Профиль обновлён' }));
});

// Загрузить аватар
app.post('/api/profile/avatar', requireAuth, uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const avatarUrl = `/api/avatars/${req.file.filename}`;
  db.run(`UPDATE users SET avatar_url = ? WHERE phone = ?`, [avatarUrl, req.userPhone],
    (err) => err ? res.status(500).json({ error: 'Ошибка' }) : res.json({ avatarUrl }));
});

app.get('/api/avatars/:filename', (req, res) => {
  const filePath = path.join(AVATARS_DIR, req.params.filename);
  fs.existsSync(filePath) ? res.sendFile(filePath) : res.status(404).json({ error: 'Не найдено' });
});

// ========== WEBSOCKET ==========
wss.on('connection', (ws) => {
  let sessionInfo = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'auth') {
        const token = data.token;
        db.get(`SELECT phone, device_id FROM user_sessions WHERE token = ?`, [token], (err, session) => {
          if (session) {
            sessionInfo = session;
            if (!onlineClients.has(session.phone)) {
              onlineClients.set(session.phone, new Set());
            }
            onlineClients.get(session.phone).add(ws);
            
            // Обновляем статус онлайн
            updateLastSeen(session.phone);
            userStatus.set(session.phone, { typing: false, uploading: false, lastSeen: Date.now() });
            
            ws.send(JSON.stringify({ type: 'auth_success' }));
            console.log(`[+] WS: +7${session.phone} (${session.device_id}) онлайн`);
            
            // Оповещаем всех, кто имеет чат с этим пользователем
            broadcastPresence(session.phone, true);
          } else {
            ws.send(JSON.stringify({ type: 'error', error: 'Неверный токен' }));
            ws.close();
          }
        });
        return;
      }

      if (!sessionInfo) {
        ws.send(JSON.stringify({ type: 'error', error: 'Требуется авторизация' }));
        return;
      }

      // Обновляем last_seen при любой активности
      updateLastSeen(sessionInfo.phone);

      // 📝 СТАТУС "ПЕЧАТАЕТ"
      if (data.type === 'typing') {
        const { receiverPhone, isTyping } = data;
        const status = userStatus.get(sessionInfo.phone) || { typing: false, uploading: false, lastSeen: Date.now() };
        status.typing = isTyping;
        userStatus.set(sessionInfo.phone, status);
        
        if (onlineClients.has(receiverPhone)) {
          onlineClients.get(receiverPhone).forEach(client => {
            client.send(JSON.stringify({
              type: 'user_typing',
              fromPhone: sessionInfo.phone,
              isTyping
            }));
          });
        }
        return;
      }

      // 📸 СТАТУС "ОТПРАВЛЯЕТ ФОТО"
      if (data.type === 'uploading_photo') {
        const { receiverPhone, isUploading } = data;
        const status = userStatus.get(sessionInfo.phone) || { typing: false, uploading: false, lastSeen: Date.now() };
        status.uploading = isUploading;
        userStatus.set(sessionInfo.phone, status);
        
        if (onlineClients.has(receiverPhone)) {
          onlineClients.get(receiverPhone).forEach(client => {
            client.send(JSON.stringify({
              type: 'user_uploading',
              fromPhone: sessionInfo.phone,
              isUploading
            }));
          });
        }
        return;
      }

      // 💬 Сообщение
      if (data.type === 'message') {
        const { receiverPhone, encryptedText, mediaUrl, mediaType } = data;
        const messageId = crypto.randomUUID();
        const timestamp = Date.now();

        db.run(`INSERT INTO messages (id, sender_phone, receiver_phone, encrypted_text, media_url, media_type, timestamp) 
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [messageId, sessionInfo.phone, receiverPhone, encryptedText, mediaUrl, mediaType || 'text', timestamp],
          (err) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', error: 'Ошибка сохранения' }));
              return;
            }
            const payload = {
              type: 'new_message',
              id: messageId,
              senderPhone: sessionInfo.phone,
              receiverPhone,
              encryptedText,
              mediaUrl,
              mediaType: mediaType || 'text',
              timestamp
            };
            if (onlineClients.has(receiverPhone)) {
              onlineClients.get(receiverPhone).forEach(client => client.send(JSON.stringify(payload)));
            }
            ws.send(JSON.stringify({ type: 'msg_delivered', messageId }));
          });
      }

    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'Неверный формат' }));
    }
  });

  ws.on('close', () => {
    if (sessionInfo) {
      if (onlineClients.has(sessionInfo.phone)) {
        onlineClients.get(sessionInfo.phone).delete(ws);
        if (onlineClients.get(sessionInfo.phone).size === 0) {
          onlineClients.delete(sessionInfo.phone);
          
          // Обновляем last_seen и статус оффлайн
          db.run(`UPDATE user_activity SET last_seen = ?, is_online = 0 WHERE phone = ?`, 
            [Date.now(), sessionInfo.phone]);
          const status = userStatus.get(sessionInfo.phone) || {};
          status.lastSeen = Date.now();
          userStatus.set(sessionInfo.phone, status);
          
          broadcastPresence(sessionInfo.phone, false);
        }
      }
      console.log(`[-] WS: +7${sessionInfo.phone} оффлайн`);
    }
  });
});

// Оповестить о смене статуса (онлайн/оффлайн)
function broadcastPresence(phone, isOnline) {
  const payload = {
    type: 'presence',
    phone,
    isOnline,
    lastSeen: Date.now()
  };
  // Отправляем всем, кто онлайн (они сами решат, показывать или нет)
  onlineClients.forEach((clients, clientPhone) => {
    if (clientPhone !== phone) {
      clients.forEach(client => client.send(JSON.stringify(payload)));
    }
  });
}

// ========== ЗАПУСК ==========
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 ANTI-SCAM v4.0 ЗАПУЩЕН!`);
  console.log(`📱 Профили | ⏰ Статусы | ️ Печать | 📸 Загрузка фото`);
  console.log(`${'='.repeat(60)}\n`);
});