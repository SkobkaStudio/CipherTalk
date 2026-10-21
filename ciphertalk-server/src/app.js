const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const config = require('./config');
const { getDatabase } = require('./db/database');
const WebSocketService = require('./services/websocketService');
const uploadMiddleware = require('./middleware/upload');
const authMiddleware = require('./middleware/auth');
const sessionService = require('./services/sessionService');
const File = require('./models/File');

// Роуты
const authRoutes = require('./routes/authRoutes');
const profileRoutes = require('./routes/profileRoutes');
const chatRoutes = require('./routes/chatRoutes');

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
    // CORS: по умолчанию same-origin. Разрешаем список через CORS_ORIGIN.
    const allowedOrigins = (process.env.CORS_ORIGIN || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);

    this.app.use(cors({
      origin: allowedOrigins.length ? allowedOrigins : true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
    }));

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

    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        users: this.db.users.length,
        chats: this.db.chats.length,
        messages: this.db.messages.length
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
      console.log(`📦 База данных: ${config.dbFile}`);
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
