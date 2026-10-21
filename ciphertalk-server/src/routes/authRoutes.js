const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');

// Контроллер — синглтон: методы передаём с сохранением this, иначе
// внутри обработчика this === undefined.
const c = authController;

// Публичные
router.post('/send-code', c.sendCode.bind(c));
router.post('/verify-code', c.verifyCode.bind(c));
router.post('/register', c.register.bind(c));
router.post('/login', c.login.bind(c));
router.post('/login-code', c.loginWithCode.bind(c));
router.get('/check-username', c.checkUsername.bind(c));

// Требуют сессию
router.get('/me', authMiddleware.authenticate, c.me.bind(c));
router.post('/logout', authMiddleware.authenticate, c.logout.bind(c));

module.exports = router;
