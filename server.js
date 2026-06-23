/**
 * ====================================================================
 * ANTI-SCAM MESSENGER - SECURE BACKEND
 * ====================================================================
 * Платформа: Node.js (Идеально для Armbian / Debian / Ubuntu)
 * База данных: SQLite3 (Локальный файл, минимальное потребление ресурсов)
 * Безопасность: Bcrypt хеширование, E2EE транзит, JWT-подобные токены,
 * защищенное изолированное хранилище медиафайлов.
 * * Все данные сервера теперь изолированы в папке 'server-data'.
 * * * Установка зависимостей на Armbian:
 * npm install express ws sqlite3 bcrypt multer cors
 * * Запуск сервера:
 * node server.js
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

// Инициализация Express приложения и HTTP-сервера
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ========== НАСТРОЙКА ХРАНИЛИЩА ДАННЫХ ==========
// Создаем единую директорию для всех данных сервера
const DATA_DIR = path.join(__dirname, 'server-data');
const UPLOADS_DIR = path.join(DATA_DIR, 'encrypted_media');
const DB_FILE = path.join(DATA_DIR, 'antiscam.db');

// Автоматически создаем папки, если они еще не существуют
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ========== СЛУЖБА СМС-УВЕДОМЛЕНИЙ ==========
// Внимание: Отправка СМС на реальные телефоны — это всегда платная услуга сотовых операторов.
const SMS_CONFIG = {
  demoMode: true,            // TRUE: Коды пишутся в консоль (БЕСПЛАТНО для тестов). FALSE: Реальная отправка через шлюз.
  apiId: 'YOUR_SMS_RU_KEY'   // API-ключ от личного кабинета на sms.ru (если решите активировать)
};

// Промежуточное ПО (Middleware)
app.use(cors()); // Разрешаем кросс-доменные запросы от браузерного клиента и Expo-приложения
app.use(express.json({ limit: '15mb' })); // Повышенный лимит для отправки зашифрованных картинок

// Настройка Multer для защищенного приема зашифрованных файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    // Присваиваем файлу случайное 48-значное имя без расширения для анонимизации на сервере
    const secureName = crypto.randomBytes(24).toString('hex');
    cb(null, secureName);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 15 * 1024 * 1024 } }); // Лимит 15 МБ

// ========== ИНИЦИАЛИЗАЦИЯ И СТРУКТУРА БАЗЫ ДАННЫХ SQLITE ==========
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error('[-] Ошибка подключения к базе данных SQLite:', err.message);
  } else {
    console.log('[+] База данных SQLite успешно подключена/создана:', DB_FILE);
    createDatabaseTables();
  }
});

function createDatabaseTables() {
  db.serialize(() => {
    // 1. Таблица зарегистрированных пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Таблица временных СМС-кодов авторизации (OTP)
    db.run(`CREATE TABLE IF NOT EXISTS otp_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);

    // 3. Таблица хранения истории зашифрованных сообщений
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_phone TEXT NOT NULL,
      receiver_phone TEXT NOT NULL,
      encrypted_text TEXT NOT NULL, -- Зашифровано сквозным шифрованием (E2EE) на клиенте
      media_url TEXT,               -- Путь к зашифрованной картинке, если передается медиафайл
      media_type TEXT,              -- Тип содержимого: 'text' или 'image'
      timestamp INTEGER NOT NULL
    )`);
  });
}

// ========== СЕССИОННЫЙ КОНТРОЛЬ ==========
// Оперативная память для хранения активных сессий (token -> phone)
const activeSessions = new Map();

// Middleware авторизации для защиты HTTP эндпоинтов
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Токен авторизации отсутствует. Доступ заблокирован.' });

  if (activeSessions.has(token)) {
    req.userPhone = activeSessions.get(token);
    next();
  } else {
    return res.status(403).json({ error: 'Ваша сессия устарела или недействительна. Войдите заново.' });
  }
}

// ========== СЕРВИС ОТПРАВКИ СМС-КОДОВ ==========
async function sendVerificationSms(phone, code) {
  if (SMS_CONFIG.demoMode) {
    console.log(`\n==================================================`);
    console.log(`📡 [СИМУЛЯТОР СМС-ШЛЮЗА ДЛЯ РАЗРАБОТЧИКОВ]`);
    console.log(`Кому: +7 ${phone}`);
    console.log(`Текст сообщения: Ваш код безопасности Anti-Scam: ${code}`);
    console.log(`==================================================\n`);
    return true;
  }

  // Интеграция с реальным API шлюза sms.ru
  try {
    const textMessage = `Код авторизации в мессенджере Anti-Scam: ${code}`;
    const response = await fetch(`https://sms.ru/sms/send?api_id=${SMS_CONFIG.apiId}&to=7${phone}&msg=${encodeURIComponent(textMessage)}&json=1`);
    const data = await response.json();
    return data.status === "OK";
  } catch (error) {
    console.error('[-] Сбой при отправке СМС через шлюз:', error);
    return false;
  }
}


// ====================================================================
//                     REST API ЭНДПОИНТЫ (HTTP)
// ====================================================================

// 1. Запрос одноразового кода на телефон (Шаг 1 авторизации)
app.post('/api/auth/request-otp', (req, res) => {
  const { phone } = req.body;
  
  if (!phone || phone.length !== 10 || !/^\d+$/.test(phone)) {
    return res.status(400).json({ error: 'Укажите корректный 10-значный номер телефона без +7 или 8' });
  }

  // Генерируем надежный случайный 4-значный цифровой код
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // Код активен ровно 5 минут

  db.run(`INSERT OR REPLACE INTO otp_codes (phone, code, expires_at) VALUES (?, ?, ?)`, [phone, code, expiresAt], async (err) => {
    if (err) {
      return res.status(500).json({ error: 'Внутренняя ошибка базы данных при генерации OTP' });
    }

    const isSent = await sendVerificationSms(phone, code);
    if (isSent) {
      res.json({ message: 'Проверочный код успешно сформирован и отправлен.' });
    } else {
      res.status(500).json({ error: 'Технический сбой СМС-шлюза. Обратитесь к администратору.' });
    }
  });
});

// 2. Верификация кода из СМС (Шаг 2 авторизации)
app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ error: 'Необходимо указать телефон и полученный код' });
  }

  db.get(`SELECT * FROM otp_codes WHERE phone = ?`, [phone], (err, row) => {
    if (err || !row) {
      return res.status(400).json({ error: 'Запрос на авторизацию для данного номера отсутствует' });
    }

    if (Date.now() > row.expires_at) {
      db.run(`DELETE FROM otp_codes WHERE phone = ?`, [phone]);
      return res.status(400).json({ error: 'Срок действия кода безопасности истек. Запросите новый.' });
    }

    if (row.code !== code) {
      return res.status(400).json({ error: 'Неверный проверочный код. Попробуйте еще раз.' });
    }

    // Удаляем отработанный код безопасности из БД
    db.run(`DELETE FROM otp_codes WHERE phone = ?`, [phone]);

    // Проверяем, зарегистрирован ли уже пользователь
    db.get(`SELECT phone, name FROM users WHERE phone = ?`, [phone], (err, user) => {
      if (err) return res.status(500).json({ error: 'Ошибка БД при поиске пользователя' });

      if (user) {
        // Пользователь уже зарегистрирован — генерируем токен сессии
        const sessionToken = crypto.randomBytes(32).toString('hex');
        activeSessions.set(sessionToken, phone);
        res.json({ status: 'login_success', token: sessionToken, user });
      } else {
        // Новый аккаунт — направляем клиента на экран завершения регистрации
        res.json({ status: 'need_registration', phone });
      }
    });
  });
});

// 3. Завершение регистрации (Шаг 3: Ввод имени и создание пароля)
app.post('/api/auth/register', async (req, res) => {
  const { phone, name, password } = req.body;

  if (!phone || !name || !password || password.length < 6) {
    return res.status(400).json({ error: 'Все поля обязательны к заполнению. Пароль — не менее 6 знаков.' });
  }

  try {
    // Хешируем пароль с помощью bcrypt с фактором сложности 12
    const saltRounds = 12;
    const hash = await bcrypt.hash(password, saltRounds);

    db.run(`INSERT INTO users (phone, name, password_hash) VALUES (?, ?, ?)`, [phone, name, hash], (err) => {
      if (err) {
        return res.status(400).json({ error: 'Этот номер телефона уже кем-то используется' });
      }

      // Успешно зарегистрирован — генерируем сессионный ключ
      const sessionToken = crypto.randomBytes(32).toString('hex');
      activeSessions.set(sessionToken, phone);

      res.status(201).json({
        token: sessionToken,
        user: { phone, name }
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера при криптографической обработке.' });
  }
});

// 4. Традиционный быстрый вход по паролю
app.post('/api/auth/login-password', (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Укажите номер телефона и пароль' });
  }

  db.get(`SELECT * FROM users WHERE phone = ?`, [phone], async (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: 'Пользователь с таким номером телефона не найден' });
    }

    // Сверяем введенный пароль с хешем bcrypt
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Введен неверный пароль' });
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    activeSessions.set(sessionToken, phone);

    res.json({
      token: sessionToken,
      user: { phone: user.phone, name: user.name }
    });
  });
});

// 5. Поиск пользователя (для добавления нового собеседника в контакты)
app.get('/api/users/find/:phone', requireAuth, (req, res) => {
  const targetPhone = req.params.phone;

  db.get(`SELECT phone, name FROM users WHERE phone = ?`, [targetPhone], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: 'Собеседник с таким номером не найден в базе данных' });
    }
    res.json(row);
  });
});

// 6. Получение зашифрованной истории сообщений с конкретным контактом
app.get('/api/messages/history/:contactPhone', requireAuth, (req, res) => {
  const myPhone = req.userPhone;
  const contactPhone = req.params.contactPhone;

  // Извлекаем переписку между авторизованным пользователем и его собеседником
  db.all(
    `SELECT * FROM messages WHERE 
     (sender_phone = ? AND receiver_phone = ?) OR 
     (sender_phone = ? AND receiver_phone = ?) 
     ORDER BY timestamp ASC`,
    [myPhone, contactPhone, contactPhone, myPhone],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Ошибка загрузки архива сообщений' });
      }
      res.json(rows);
    }
  );
});

// 7. Загрузка защищенного медиафайла / зашифрованной картинки
app.post('/api/media/upload', requireAuth, upload.single('media'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Медиафайл не передан или поврежден.' });
  }

  // Файл на сервер загружается полностью зашифрованным клиентом. 
  // Сервер возвращает URL для скачивания, не зная реального содержимого картинки.
  res.json({
    mediaUrl: `/api/media/download/${req.file.filename}`
  });
});

// 8. Скачивание защищенного зашифрованного медиафайла
app.get('/api/media/download/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(UPLOADS_DIR, filename);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Медиафайл отсутствует на сервере.' });
  }
});


// ====================================================================
//                     WEBSOCKETS (ОБМЕН В РЕАЛЬНОМ ВРЕМЕНИ)
// ====================================================================
// Карта активных WebSocket соединений (phone -> ws connection)
const onlineClients = new Map();

wss.on('connection', (ws, req) => {
  let authenticatedPhone = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // 1. Авторизация WebSocket-канала связи через сессионный токен
      if (data.type === 'auth') {
        const token = data.token;
        if (activeSessions.has(token)) {
          authenticatedPhone = activeSessions.get(token);
          onlineClients.set(authenticatedPhone, ws);
          ws.send(JSON.stringify({ type: 'auth_success' }));
          console.log(`[+] WebSocket: Пользователь +7 ${authenticatedPhone} вошел в сеть.`);
        } else {
          ws.send(JSON.stringify({ type: 'error', error: 'Ошибка токена авторизации WebSocket' }));
          ws.close();
        }
        return;
      }

      // Проверка авторизации текущего WebSocket соединения
      if (!authenticatedPhone) {
        ws.send(JSON.stringify({ type: 'error', error: 'Требуется авторизация сессии WebSocket' }));
        return;
      }

      // 2. Транзит защищенного сквозным шифрованием (E2EE) сообщения получателю
      if (data.type === 'message') {
        const { receiverPhone, encryptedText, mediaUrl, mediaType } = data;

        const messageId = crypto.randomUUID();
        const timestamp = Date.now();

        // Записываем зашифрованные E2EE данные в базу данных
        db.run(
          `INSERT INTO messages (id, sender_phone, receiver_phone, encrypted_text, media_url, media_type, timestamp) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [messageId, authenticatedPhone, receiverPhone, encryptedText, mediaUrl, mediaType || 'text', timestamp],
          (err) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', error: 'Ошибка сохранения сообщения в базу данных' }));
              return;
            }

            const outgoingPayload = {
              type: 'new_message',
              id: messageId,
              senderPhone: authenticatedPhone,
              receiverPhone,
              encryptedText,
              mediaUrl,
              mediaType: mediaType || 'text',
              timestamp
            };

            // Если получатель сейчас в сети — мгновенно передаем ему сообщение по WebSocket
            if (onlineClients.has(receiverPhone)) {
              onlineClients.get(receiverPhone).send(JSON.stringify(outgoingPayload));
            }

            // Подтверждаем отправителю успешную доставку на сервер
            ws.send(JSON.stringify({ type: 'msg_delivered', messageId }));
          }
        );
      }

    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'Неверный формат пакета WebSocket' }));
    }
  });

  ws.on('close', () => {
    if (authenticatedPhone) {
      onlineClients.delete(authenticatedPhone);
      console.log(`[-] WebSocket: Пользователь +7 ${authenticatedPhone} покинул сеть.`);
    }
  });
});

// Запуск объединенного сервера
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`🚀 СЕРВЕР ANTI-SCAM MESSENGER СТАРТОВАЛ НА ARMBIAN!`);
  console.log(`Данные хранятся в: ${DATA_DIR}`);
  console.log(`Локальный адрес хоста: http://localhost:${PORT}`);
  console.log(`Эндпоинт WebSocket: ws://localhost:${PORT}`);
  console.log(`База данных успешно развернута. Ждем подключений!`);
  console.log(`==================================================\n`);
});