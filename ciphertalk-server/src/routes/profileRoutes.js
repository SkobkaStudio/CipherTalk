const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const authMiddleware = require('../middleware/auth');

const c = profileController;

router.post('/update-profile', authMiddleware.authenticate, c.updateProfile.bind(c));

router.get('/profile/:userId', authMiddleware.authenticate, c.getProfile.bind(c));
router.get('/profile', authMiddleware.authenticate, c.getProfile.bind(c));

router.get('/search-users', authMiddleware.authenticate, c.searchUsers.bind(c));
router.get('/users/search', authMiddleware.authenticate, c.searchUsers.bind(c));

module.exports = router;
