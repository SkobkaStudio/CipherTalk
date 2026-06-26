const { getDatabase } = require('../db/database');
const encryptionService = require('../services/encryptionService');

class ProfileController {
  constructor() {
    this.db = getDatabase();
  }

  // Обновление профиля
  updateProfile(req, res) {
    try {
      const { userId, firstName, lastName, username, avatar, publicKey, oldPassword, newPassword } = req.body;
      const user = this.db.findUserById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (firstName !== undefined) {
        user.first_name = firstName;
      }
      if (lastName !== undefined) {
        user.last_name = lastName;
      }
      if (firstName !== undefined || lastName !== undefined) {
        user.name = user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
      }
      
      if (username !== undefined) {
        const clean = username.replace(/^@/, '').toLowerCase();
        if (this.db.isUsernameTaken(clean, userId)) {
          return res.status(400).json({ error: 'Username занят' });
        }
        user.username = clean;
      }
      
      if (avatar !== undefined) {
        user.avatar = avatar;
      }
      if (publicKey !== undefined) {
        user.public_key = publicKey;
      }
      
      if (newPassword && oldPassword) {
        if (!user.verifyPassword(oldPassword)) {
          return res.status(400).json({ error: 'Неверный текущий пароль' });
        }
        user.setPassword(newPassword);
      }

      res.json({ success: true, user: user.toSafeJSON() });
    } catch (error) {
      console.error('Update profile error:', error);
      res.status(500).json({ error: 'Ошибка обновления профиля' });
    }
  }

  // Получение профиля
  getProfile(req, res) {
    try {
      const userId = parseInt(req.params.userId) || parseInt(req.query.userId);
      const user = this.db.findUserById(userId);
      if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }
      res.json(user.toSafeJSON());
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Ошибка получения профиля' });
    }
  }

  // Поиск пользователей
  searchUsers(req, res) {
    try {
      const { query, userId } = req.query;
      if (!query) return res.json([]);

      const uid = parseInt(userId);
      const q = query.toLowerCase().replace(/^@/, '');
      
      const users = this.db.users
        .filter(u => u.id !== uid && (
          u.name.toLowerCase().includes(q) ||
          u.phone.toLowerCase().includes(q) ||
          (u.username && u.username.toLowerCase().includes(q))
        ))
        .slice(0, 20)
        .map(u => u.toSafeJSON());

      res.json(users);
    } catch (error) {
      console.error('Search users error:', error);
      res.status(500).json({ error: 'Ошибка поиска' });
    }
  }
}

module.exports = new ProfileController();