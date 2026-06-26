const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const authMiddleware = require('../middleware/auth');

// Обновление профиля
router.post('/update-profile', authMiddleware.optional, profileController.updateProfile);

// Получение профиля
router.get('/profile/:userId', profileController.getProfile);
router.get('/profile', profileController.getProfile);

// Поиск пользователей
router.get('/search-users', profileController.searchUsers);

module.exports = router;