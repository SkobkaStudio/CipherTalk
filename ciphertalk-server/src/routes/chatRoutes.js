const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const authMiddleware = require('../middleware/auth');

// Получить чаты пользователя
router.get('/chats/:userId', authMiddleware.optional, chatController.getUserChats);

// Получить сообщения чата
router.get('/messages/:chatId', chatController.getMessages);

// Создать группу
router.post('/create-group', authMiddleware.optional, chatController.createGroup);

// Добавить участника
router.post('/add-member', authMiddleware.optional, chatController.addMember);

module.exports = router;