const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');

// Отправка кода
router.post('/send-code', authMiddleware.optional, authController.sendCode);

// Проверка кода
router.post('/verify-code', authController.verifyCode);

// Регистрация
router.post('/register', authController.register);

// Вход
router.post('/login', authController.login);

// Проверка username
router.get('/check-username', authController.checkUsername);

module.exports = router;