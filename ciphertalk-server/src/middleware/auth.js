const { getDatabase } = require('../db/database');

class AuthMiddleware {
  constructor() {
    this.db = getDatabase();
  }

  // Простая проверка (для будущего использования с JWT)
  authenticate(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    // Здесь будет проверка JWT
    // Пока пропускаем
    next();
  }

  // Проверка userId в запросе
  requireUserId(req, res, next) {
    const userId = parseInt(req.body.userId || req.query.userId);
    
    if (!userId) {
      return res.status(401).json({ error: 'Требуется userId' });
    }

    const user = this.db.findUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    req.user = user;
    req.userId = userId;
    next();
  }

  // Для тестов (отключает проверку)
  optional(req, res, next) {
    const userId = parseInt(req.body.userId || req.query.userId);
    if (userId) {
      const user = this.db.findUserById(userId);
      if (user) {
        req.user = user;
        req.userId = userId;
      }
    }
    next();
  }
}

module.exports = new AuthMiddleware();