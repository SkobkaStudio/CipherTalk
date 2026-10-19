const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Создаем директорию для загрузок
if (!fs.existsSync(config.uploadsPath)) {
  fs.mkdirSync(config.uploadsPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination: config.uploadsPath,
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
    // Оставляем только безопасное расширение
    const ext = path.extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16);
    cb(null, uniqueName + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSize, files: 1 }
});

class UploadMiddleware {
  single(fieldName) {
    return upload.single(fieldName);
  }

  handleError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `Файл слишком большой (максимум ${Math.floor(config.maxFileSize / (1024 * 1024))} МБ)`
        });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: 'Ошибка загрузки файла' });
    }
    next();
  }
}

module.exports = new UploadMiddleware();
