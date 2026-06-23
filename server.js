/**
 * 🛡️ ANTI-SCAM MESSENGER - BACKEND
 * Запуск: node server.js
 * Зависимости: npm install express ws sqlite3 bcrypt multer cors
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
const DB_FILE = path.join(DATA_DIR, 'antiscam.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ========== СМС (DEMO) ==========
const SMS_CONFIG = {
  demoMode: true,
  apiId: 'YOUR_SMS_RU_KEY'
};

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(24).toString('hex'))
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// ========== БАЗА ДАННЫХ ==========
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error('[-] Ошибка БД:', err.message);
  else {
    console.log('[+] БД подключена:', DB_FILE);
    createTables();
  }
});

function createTables() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
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
  });
}

// ========== СЕССИИ ==========
const activeSessions = new Map();
const onlineClients = new Map();

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Токен отсутствует' });
  if (activeSessions.has(token)) {
    req.userPhone = activeSessions.get(token);
    next();
  } else {
    res.status(403).json({ error: 'Сессия недействительна' });
  }
}

// ========== СМС-СЕРВИС ==========
async function sendVerificationSms(phone, code) {
  // 🔥 ВСЕГДА выводим код в консоль (даже в реальном режиме — для отладки)
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📡 СМС-КОД ДЛЯ +7${phone}: ${code}`);
  console.log(`${'='.repeat(60)}\n`);

  if (SMS_CONFIG.demoMode) return true;

  try {
    const text = `Код Anti-Scam: ${code}`;
    const res = await fetch(`https://sms.ru/sms/send?api_id=${SMS_CONFIG.apiId}&to=7${phone}&msg=${encodeURIComponent(text)}&json=1`);
    const data = await res.json();
    return data.status === "OK";
  } catch (error) {
    console.error('[-] Ошибка СМС:', error);
    return false;
  }
}

// ========== REST API ==========

// 1. Запрос OTP
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
      const sent = await sendVerificationSms(phone, code);
      if (sent) res.json({ message: 'Код отправлен' });
      else res.status(500).json({ error: 'Ошибка отправки СМС' });
    });
});

// 2. Верификация OTP
app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Укажите телефон и код' });

  db.get(`SELECT * FROM otp_codes WHERE phone = ?`, [phone], (err, row) => {
    if (err || !row) return res.status(400).json({ error: 'Код не запрошен' });
    if (Date.now() > row.expires_at) {
      db.run(`DELETE FROM otp_codes WHERE phone = ?`, [phone]);
      return res.status(400).json({ error: 'Код истёк' });
    }
    if (row.code !== code) return res.status(400).json({ error: 'Неверный код' });

    db.run(`DELETE FROM otp_codes WHERE phone = ?`, [phone]);
    db.get(`SELECT phone, name FROM users WHERE phone = ?`, [phone], (err, user) => {
      if (err) return res.status(500).json({ error: 'Ошибка БД' });
      if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.set(token, phone);
        res.json({ status: 'login_success', token, user });
      } else {
        res.json({ status: 'need_registration', phone });
      }
    });
  });
});

// 3. Регистрация
app.post('/api/auth/register', async (req, res) => {
  const { phone, name, password } = req.body;
  if (!phone || !name || !password || password.length < 6) {
    return res.status(400).json({ error: 'Все поля обязательны, пароль мин. 6 символов' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    db.run(`INSERT INTO users (phone, name, password_hash) VALUES (?, ?, ?)`,
      [phone, name, hash], (err) => {
        if (err) return res.status(400).json({ error: 'Номер уже занят' });
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.set(token, phone);
        res.status(201).json({ token, user: { phone, name } });
      });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 4. Вход по паролю
app.post('/api/auth/login-password', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Укажите телефон и пароль' });

  db.get(`SELECT * FROM users WHERE phone = ?`, [phone], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Пользователь не найден' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Неверный пароль' });
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.set(token, phone);
    res.json({ token, user: { phone: user.phone, name: user.name } });
  });
});

// 5. Поиск пользователя
app.get('/api/users/find/:phone', requireAuth, (req, res) => {
  const targetPhone = req.params.phone;
  db.get(`SELECT phone, name FROM users WHERE phone = ?`, [targetPhone], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Не найден' });
    res.json(row);
  });
});

// 6. История сообщений
app.get('/api/messages/history/:contactPhone', requireAuth, (req, res) => {
  const myPhone = req.userPhone;
  const contactPhone = req.params.contactPhone;
  db.all(`SELECT * FROM messages WHERE 
    (sender_phone = ? AND receiver_phone = ?) OR 
    (sender_phone = ? AND receiver_phone = ?) 
    ORDER BY timestamp ASC`,
    [myPhone, contactPhone, contactPhone, myPhone],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Ошибка загрузки' });
      res.json(rows);
    });
});

// 7. Загрузка медиа
app.post('/api/media/upload', requireAuth, upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ mediaUrl: `/api/media/download/${req.file.filename}` });
});

// 8. Скачивание медиа
app.get('/api/media/download/:filename', requireAuth, (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).json({ error: 'Файл не найден' });
});

// ========== WEBSOCKET ==========
wss.on('connection', (ws) => {
  let authenticatedPhone = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // Авторизация
      if (data.type === 'auth') {
        const token = data.token;
        if (activeSessions.has(token)) {
          authenticatedPhone = activeSessions.get(token);
          onlineClients.set(authenticatedPhone, ws);
          ws.send(JSON.stringify({ type: 'auth_success' }));
          console.log(`[+] WS: +7${authenticatedPhone} онлайн`);
        } else {
          ws.send(JSON.stringify({ type: 'error', error: 'Неверный токен' }));
          ws.close();
        }
        return;
      }

      if (!authenticatedPhone) {
        ws.send(JSON.stringify({ type: 'error', error: 'Требуется авторизация' }));
        return;
      }

      // 🔑 ОБМЕН КЛЮЧАМИ ШИФРОВАНИЯ
      if (data.type === 'key_exchange') {
        const { receiverPhone, chatKey } = data;
        console.log(`[🔑] Ключ: +7${authenticatedPhone} → +7${receiverPhone}`);
        if (onlineClients.has(receiverPhone)) {
          onlineClients.get(receiverPhone).send(JSON.stringify({
            type: 'key_exchange',
            fromPhone: authenticatedPhone,
            chatKey
          }));
        }
        ws.send(JSON.stringify({ type: 'key_exchange_ack', receiverPhone }));
        return;
      }

      // Сообщение
      if (data.type === 'message') {
        const { receiverPhone, encryptedText, mediaUrl, mediaType } = data;
        const messageId = crypto.randomUUID();
        const timestamp = Date.now();

        db.run(`INSERT INTO messages (id, sender_phone, receiver_phone, encrypted_text, media_url, media_type, timestamp) 
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [messageId, authenticatedPhone, receiverPhone, encryptedText, mediaUrl, mediaType || 'text', timestamp],
          (err) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', error: 'Ошибка сохранения' }));
              return;
            }
            const payload = {
              type: 'new_message',
              id: messageId,
              senderPhone: authenticatedPhone,
              receiverPhone,
              encryptedText,
              mediaUrl,
              mediaType: mediaType || 'text',
              timestamp
            };
            if (onlineClients.has(receiverPhone)) {
              onlineClients.get(receiverPhone).send(JSON.stringify(payload));
            }
            ws.send(JSON.stringify({ type: 'msg_delivered', messageId }));
          });
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'Неверный формат' }));
    }
  });

  ws.on('close', () => {
    if (authenticatedPhone) {
      onlineClients.delete(authenticatedPhone);
      console.log(`[-] WS: +7${authenticatedPhone} оффлайн`);
    }
  });
});

// ========== ЗАПУСК ==========
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 ANTI-SCAM MESSENGER ЗАПУЩЕН!`);
  console.log(`📂 Данные: ${DATA_DIR}`);
  console.log(`🌐 HTTP: http://localhost:${PORT}`);
  console.log(`🔌 WS: ws://localhost:${PORT}`);
  console.log(`📱 SMS Demo Mode: ВКЛЮЧЁН (коды в консоли)`);
  console.log(`${'='.repeat(60)}\n`);
});