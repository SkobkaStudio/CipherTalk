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
    cb(null, uniqueName + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSize }
});

class UploadMiddleware {
  single(fieldName) {
    return upload.single(fieldName);
  }

  array(fieldName, maxCount) {
    return upload.array(fieldName, maxCount);
  }

  handleError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'FILE_TOO_LARGE') {
        return res.status(413).json({ error: 'Файл слишком большой' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(500).json({ error: 'Ошибка загрузки файла' });
    }
    next();
  }
}

module.exports = new UploadMiddleware();