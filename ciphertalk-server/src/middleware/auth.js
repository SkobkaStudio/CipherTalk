const sessionService = require('../services/sessionService');

class AuthMiddleware {
  /**
   * Проверка Bearer-токена сессии. userId из тела запроса больше не
   * используется как доказательство личности (это позволяло IDOR).
   */
  authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (!token || scheme.toLowerCase() !== 'bearer') {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const auth = sessionService.verify(token);
    if (!auth) {
      return res.status(401).json({ error: 'Сессия недействительна или истекла' });
    }

    req.user = auth.user;
    req.userId = auth.user.id;
    req.session = auth.session;
    req.token = token;
    next();
  }
}

module.exports = new AuthMiddleware();
