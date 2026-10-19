const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const authMiddleware = require('../middleware/auth');

const c = chatController;

// Все операции с чатами — только для авторизованных
router.get('/chats', authMiddleware.authenticate, c.getUserChats.bind(c));
router.get('/chats/:userId', authMiddleware.authenticate, c.getUserChats.bind(c));

router.get('/messages/:chatId', authMiddleware.authenticate, c.getMessages.bind(c));

router.post('/create-group', authMiddleware.authenticate, c.createGroup.bind(c));
router.post('/add-member', authMiddleware.authenticate, c.addMember.bind(c));

module.exports = router;
