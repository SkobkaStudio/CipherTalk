const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const config = require('./config');
const { getDatabase } = require('./db/database');
const WebSocketService = require('./services/websocketService');
const uploadMiddleware = require('./middleware/upload');

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
    // CORS
    this.app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
    }));

    // JSON
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Статика
    this.app.use('/uploads', express.static(config.uploadsPath));
  }

  setupRoutes() {
    // API маршруты
    this.app.use('/api', authRoutes);
    this.app.use('/api', profileRoutes);
    this.app.use('/api', chatRoutes);

    // Загрузка файлов
    this.app.post('/api/upload', 
      uploadMiddleware.single('file'),
      uploadMiddleware.handleError,
      (req, res) => {
        if (!req.file) {
          return res.status(400).json({ error: 'No file' });
        }
        
        const fileId = this.db.nextId('files');
        const File = require('./models/File');
        const file = new File({
          id: fileId,
          filename: req.file.filename,
          original_name: req.file.originalname,
          size: req.file.size,
          mimetype: req.file.mimetype,
          uploader_id: parseInt(req.body.userId) || 0
        });
        this.db.files.push(file);
        
        res.json({
          fileId: file.id,
          filename: req.file.filename,
          originalName: req.file.originalname,
          size: req.file.size,
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
  }

  setupWebSocket() {
    this.wsService = new WebSocketService(this.server);
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
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    });
  }

  start() {
    const PORT = config.port;
    
    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Получен SIGINT, завершение...');
      this.db.save();
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.log('\n🛑 Получен SIGTERM, завершение...');
      this.db.save();
      process.exit(0);
    });

    this.server.listen(PORT, () => {
      console.log(`\n🚀 CipherTalk сервер запущен на порту ${PORT}`);
      console.log(`📦 База данных: ${config.dbFile}`);
      console.log(`📁 Загрузки: ${config.uploadsPath}`);
      console.log(`🌐 API: http://localhost:${PORT}/api/`);
      console.log(`📡 WebSocket: ws://localhost:${PORT}\n`);
    });
  }

  getApp() {
    return this.app;
  }

  getServer() {
    return this.server;
  }
}

module.exports = App;