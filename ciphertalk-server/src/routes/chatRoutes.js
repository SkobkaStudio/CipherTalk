const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const authMiddleware = require('../middleware/auth');
const uploadMiddleware = require('../middleware/upload');

const c = chatController;

// Все операции с чатами — только для авторизованных
router.get('/chats', authMiddleware.authenticate, c.getUserChats.bind(c));
router.get('/chats/:userId', authMiddleware.authenticate, c.getUserChats.bind(c));

router.get('/messages/:chatId', authMiddleware.authenticate, c.getMessages.bind(c));
router.get('/pinned/:chatId', authMiddleware.authenticate, c.getPinnedMessages.bind(c));

router.post('/create-group', authMiddleware.authenticate, c.createGroup.bind(c));
router.post('/add-member', authMiddleware.authenticate, c.addMember.bind(c));

// Обновление аватара группы/канала: multipart/form-data с полем 'avatar'
// (multer сохраняет файл в uploads/), либо JSON { avatar } — data:/URL.
// PUT — основной метод, POST — совместимость со старыми клиентами.
router.put('/chats/:chatId/avatar', authMiddleware.authenticate, uploadMiddleware.single('avatar'), uploadMiddleware.handleError, c.updateChatAvatar.bind(c));
router.post('/chats/:chatId/avatar', authMiddleware.authenticate, uploadMiddleware.single('avatar'), uploadMiddleware.handleError, c.updateChatAvatar.bind(c));

// Папки чатов
router.get('/folders', authMiddleware.authenticate, c.getFolders.bind(c));
router.post('/folders', authMiddleware.authenticate, c.createFolder.bind(c));
router.put('/folders/:id', authMiddleware.authenticate, c.updateFolder.bind(c));
router.delete('/folders/:id', authMiddleware.authenticate, c.deleteFolder.bind(c));

module.exports = router;
