const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { getDatabase } = require('./db/database');
const WebSocketService = require('./services/websocketService');
const uploadMiddleware = require('./middleware/upload');
const authMiddleware = require('./middleware/auth');
const securityHeaders = require('./middleware/security');
const sessionService = require('./services/sessionService');
const iceService = require('./services/iceService');
const tunnelService = require('./services/tunnelService');
const qrService = require('./services/qrService');
const File = require('./models/File');
const UserSticker = require('./models/UserSticker');

// Лимит для пользовательских стикеров — 1 МБ (требование ТЗ), независимо от
// общего config.maxFileSize для обычных вложений.
const STICKER_MAX_SIZE = 1024 * 1024;
const multer = require('multer');
const stickerStorage = multer.diskStorage({
  destination: config.uploadsPath,
  filename: (req, file, cb) => {
    const uniqueName = 'sticker-' + Date.now() + '-' + require('crypto').randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16);
    cb(null, uniqueName + ext);
  }
});
const uploadSticker = multer({
  storage: stickerStorage,
  limits: { fileSize: STICKER_MAX_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Допустимы только PNG/JPEG/WebP/GIF'));
  }
});

// Детект анимации по «сырым» байтам файла (буфер читается асинхронно один раз).
async function isAnimatedImage(buffer, mimetype) {
  if (mimetype === 'image/gif') {
    // GIF87a/GIF89a + наличие Graphics Control Extension и более одного кадра:
    // простой эвристический признак — блок 0x21 0xF9 встречается >= 2 раз.
    let frames = 0;
    for (let i = 0; i + 1 < buffer.length; i++) {
      if (buffer[i] === 0x21 && buffer[i + 1] === 0xF9) frames++;
      if (frames >= 2) return true;
    }
    return false;
  }
  if (mimetype === 'image/webp') {
    // Анимированный WebP содержит чанк ANIM/ANMF.
    return buffer.includes('ANIM') || buffer.includes('ANMF');
  }
  return false;
}

// Роуты
const authRoutes = require('./routes/authRoutes');
const profileRoutes = require('./routes/profileRoutes');
const chatRoutes = require('./routes/chatRoutes');
const { createStickerRouter } = require('./routes/stickerRoutes'); // стикеры: POST/GET/DELETE /api/stickers

class App {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.db = getDatabase();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // За обратным прокси включается явно через TRUST_PROXY (число хопов).
    if (process.env.TRUST_PROXY) {
      const hops = Number(process.env.TRUST_PROXY);
      this.app.set('trust proxy', Number.isInteger(hops) && hops > 0 ? hops : 1);
    } else {
      this.app.set('trust proxy', 1);
    }

    this.app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' }
    }));
    this.app.use(securityHeaders);

    // CORS: по умолчанию same-origin. Разрешаем список через CORS_ORIGIN.
    const allowedOrigins = (process.env.CORS_ORIGIN || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);

    this.app.use(cors({
      // Строгий CORS: только явно разрешённые домены или same-origin
      origin: function (origin, callback) {
        if (!origin) return callback(null, true); // same-origin/non-browser
        if (allowedOrigins.length === 0) {
          // По умолчанию same-origin; разрешаем только localhost и trycloudflare
          if (origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('trycloudflare.com')) {
            return callback(null, true);
          }
          return callback(null, false);
        }
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
    }));

    const apiLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Слишком много запросов, попробуйте позже' }
    });
    this.app.use('/api', apiLimiter);

    this.app.use(express.json({ limit: config.maxJsonBody }));
    this.app.use(express.urlencoded({ extended: true, limit: config.maxJsonBody }));

    // Загруженные файлы — это шифротекст: запрещаем браузеру исполнять их
    // как HTML/SVG (иначе stored XSS с того же origin).
    this.app.use('/uploads', authMiddleware.authenticate, express.static(config.uploadsPath, {
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.setHeader('Content-Type', 'application/octet-stream');
      }
    }));

    // Клиент
    if (fs.existsSync(config.clientPath)) {
      this.app.use(express.static(config.clientPath));
    }
  }

  setupRoutes() {
    // API маршруты
    this.app.use('/api', authRoutes);
    this.app.use('/api', profileRoutes);
    this.app.use('/api', chatRoutes);
    this.app.use('/api/stickers', createStickerRouter(this.db)); // стикеры: POST/GET/DELETE /api/stickers

    try {
      const swaggerUi = require('swagger-ui-express');
      const swaggerSpec = require('./swagger');
      this.app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));
      this.app.use('/api/docs', swaggerUi.serve);
      this.app.get('/api/docs', swaggerUi.setup(swaggerSpec));
    } catch (e) {
      console.error('Swagger init failed:', e.message);
    }

    // Загрузка файлов (только для авторизованных)
    this.app.post('/api/upload',
      authMiddleware.authenticate,
      uploadMiddleware.single('file'),
      uploadMiddleware.handleError,
      (req, res) => {
        if (!req.file) {
          return res.status(400).json({ error: 'Файл не получен' });
        }

        const file = new File({
          id: this.db.nextId('files'),
          filename: req.file.filename,
          original_name: req.file.originalname,
          size: req.file.size,
          mimetype: req.file.mimetype,
          uploader_id: req.userId
        });
        this.db.files.push(file);
        this.db.markDirty();

        res.json({
          fileId: file.id,
          filename: req.file.filename,
          originalName: req.file.originalname,
          size: req.file.size,
          mimetype: req.file.mimetype,
          url: `/uploads/${req.file.filename}`
        });
      }
    );

    // ==================== ПОЛЬЗОВАТЕЛЬСКИЕ СТИКЕРЫ ====================
    // POST /api/stickers — загрузка стикера (PNG/JPEG/WebP/GIF, до 1 МБ).
    // Анимированные GIF/WebP сохраняются как есть; статичные картинки клиент
    // заранее обрезает до квадрата 512x512 через Canvas (см. public/app.js).
    this.app.post('/api/stickers',
      authMiddleware.authenticate,
      (req, res, next) => uploadSticker.single('file')(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'Стикер слишком большой (максимум 1 МБ)' });
          }
          return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
        }
        next();
      }),
      async (req, res) => {
        try {
          if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

          const buffer = fs.readFileSync(path.join(config.uploadsPath, req.file.filename));
          const animated = await isAnimatedImage(buffer, req.file.mimetype);

          const file = new File({
            id: this.db.nextId('files'),
            filename: req.file.filename,
            original_name: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
            uploader_id: req.userId
          });
          this.db.files.push(file);

          const sticker = this.db.addUserSticker(new UserSticker({
            id: this.db.nextId('user_stickers'),
            user_id: req.userId,
            file_id: file.id,
            name: (req.body && req.body.name ? String(req.body.name) : '').slice(0, 64),
            animated,
            created_at: Date.now()
          }));

          this.db.markDirty();
          res.json({
            id: sticker.id,
            fileId: file.id,
            name: sticker.name,
            animated: !!sticker.animated,
            url: `/uploads/${file.filename}`,
            created_at: sticker.created_at
          });
        } catch (e) {
          console.error('Sticker upload error:', e);
          res.status(500).json({ error: 'Ошибка сохранения стикера' });
        }
      }
    );

    // GET /api/stickers — список стикеров текущего пользователя
    this.app.get('/api/stickers', authMiddleware.authenticate, (req, res) => {
      const rows = this.db.getUserStickers(req.userId);
      const filesById = new Map(this.db.files.map((f) => [f.id, f]));
      res.json({
        stickers: rows.map((s) => {
          const f = filesById.get(s.file_id);
          return {
            id: s.id,
            fileId: s.file_id,
            name: s.name,
            animated: !!s.animated,
            url: f ? `/uploads/${f.filename}` : null,
            createdAt: s.created_at
          };
        })
      });
    });

    // DELETE /api/stickers/:id — удаление своего стикера
    this.app.delete('/api/stickers/:id', authMiddleware.authenticate, (req, res) => {
      const id = Number(req.params.id);
      const sticker = this.db.getUserStickerById(id);
      if (!sticker || Number(sticker.user_id) !== Number(req.userId)) {
        return res.status(404).json({ error: 'Стикер не найден' });
      }
      this.db.deleteUserSticker(id, req.userId);
      // Удаляем сам файл с диска и запись из files
      const file = this.db.files.find((f) => f.id === sticker.file_id);
      if (file) {
        const filePath = path.join(config.uploadsPath, file.filename);
        try { fs.unlinkSync(filePath); } catch (e) { /* уже удалён */ }
        const rest = this.db.files.filter((f) => f.id !== file.id);
        this.db.files = rest;
      }
      this.db.markDirty();
      res.json({ ok: true });
    });

    // Health check
    this.app.get('/api/health', (req, res) => {
      const tunnel = tunnelService.getState();
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        users: this.db.users.length,
        chats: this.db.chats.length,
        messages: this.db.messages.length,
        publicUrl: tunnel.available ? tunnel.url : null
      });
    });

    // Публичный адрес мессенджера: чтобы открыть его с любого устройства
    // и любой сети. Данные не секретные — только адрес входа.
    this.app.get('/api/public-url', (req, res) => {
      const tunnel = tunnelService.getState();
      res.set('Cache-Control', 'no-store');
      res.json({
        url: tunnel.available ? tunnel.url : null,
        mode: tunnel.mode,
        updatedAt: tunnel.updatedAt,
        available: tunnel.available
      });
    });

    // QR-код с адресом входа: отсканировать камерой телефона и открыть
    // мессенджер с любого устройства и любой сети.
    this.app.get('/api/public-url/qr.svg', (req, res) => {
      const tunnel = tunnelService.getState();
      if (!tunnel.available) {
        return res.status(503).type('text/plain').send('Туннель не запущен');
      }
      try {
        const svg = qrService.qrSvg(tunnel.url, { ec: 'M', quiet: 3 });
        res.set('Cache-Control', 'no-store');
        res.type('image/svg+xml').send(svg);
      } catch (e) {
        res.status(500).type('text/plain').send('Не удалось построить QR');
      }
    });

    // ICE-серверы для WebRTC: клиент получает STUN и (если настроен) TURN
    // с одноразовыми учётными данными (пароль TURN-сервера не раскрывается).
    // Доступ только авторизованным: иначе анонимы могли бы злоупотреблять
    // ретрансляцией через TURN.
    this.app.get('/api/ice-servers', authMiddleware.authenticate, (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        iceServers: iceService.getIceServers(),
        turnAvailable: iceService.hasTurn()
      });
    });

    // SPA-фоллбэк для клиента
    this.app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
        return next();
      }
      const indexFile = path.join(config.clientPath, 'index.html');
      if (!fs.existsSync(indexFile)) return next();
      res.sendFile(indexFile);
    });
  }

  setupWebSocket() {
    this.wsService = new WebSocketService(this.server);
    this.wsService.startHeartbeat();
    this.wsService.startOnlinePing();
    this.wsService.startExpirySweep();
  }

  setupErrorHandling() {
    // 404
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      console.error('Server error:', err);
      if (res.headersSent) return next(err);
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    });

    // Не падаем молча: логируем и сохраняем БД
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection:', reason);
      this.db.markDirty();
    });
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      this.db.flush();
    });
  }

  start() {
    const PORT = config.port;

    const shutdown = (signal) => {
      console.log(`\n🛑 Получен ${signal}, завершение...`);
      this.wsService.stop();
      if (this.sessionCleanupTimer) clearInterval(this.sessionCleanupTimer);
      this.server.close(() => {
        this.db.flush();
        process.exit(0);
      });
      // Не ждём вечно
      setTimeout(() => {
        this.db.flush();
        process.exit(0);
      }, 3000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Чистка просроченных сессий раз в час
    this.sessionCleanupTimer = setInterval(() => sessionService.purgeExpired(), 60 * 60 * 1000);
    this.sessionCleanupTimer.unref();

    this.server.listen(PORT, () => {
      console.log(`\n🚀 CipherTalk сервер запущен на порту ${PORT}`);
      console.log(`📦 База данных: ${config.dbFile.replace(/\.json$/, '.sqlite')}${config.dbEncryption ? ' (SQLCipher)' : ''}`);
      console.log(`📁 Загрузки: ${config.uploadsPath}`);
      console.log(`🖥️  Клиент: http://localhost:${PORT}/`);
      console.log(`🌐 API: http://localhost:${PORT}/api/`);
      console.log(`📡 WebSocket: ws://localhost:${PORT}\n`);
    });

    return this.server;
  }

  getApp() {
    return this.app;
  }

  getServer() {
    return this.server;
  }

  stop(callback) {
    if (this.sessionCleanupTimer) clearInterval(this.sessionCleanupTimer);
    if (this.wsService) this.wsService.stop();
    try { this.db.flush(); } catch (e) {}
    if (this.server && this.server.listening) {
      this.server.close(callback);
    } else if (callback) {
      callback();
    }
  }
}

module.exports = App;
