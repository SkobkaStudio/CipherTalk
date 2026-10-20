const { getDatabase } = require('../db/database');

const MAX_AVATAR_BYTES = 1.5 * 1024 * 1024;

class ProfileController {
  constructor() {
    this.db = getDatabase();
  }

  // Обновление профиля (только своего — userId берётся из сессии)
  updateProfile(req, res) {
    try {
      const { firstName, lastName, name, username, avatar, bio, publicKey, oldPassword, newPassword } = req.body;
      const user = this.db.findUserById(req.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (firstName !== undefined) user.first_name = String(firstName).trim().slice(0, 60);
      if (lastName !== undefined) user.last_name = String(lastName).trim().slice(0, 60);
      if (name !== undefined) {
        user.name = String(name).trim().slice(0, 120);
      } else if (firstName !== undefined || lastName !== undefined) {
        user.name = user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
      }

      if (username !== undefined) {
        const clean = String(username).replace(/^@/, '').toLowerCase();
        if (this.db.isUsernameTaken(clean, req.userId)) {
          return res.status(400).json({ error: 'Username занят' });
        }
        if (clean && !/^[a-z0-9_]{3,32}$/.test(clean)) {
          return res.status(400).json({ error: 'Username некорректный (3-32, латиница/цифры/_)' });
        }
        user.username = clean;
      }

      if (bio !== undefined) {
        user.bio = String(bio).trim().slice(0, 500);
      }

      if (avatar !== undefined) {
        if (!this.isValidAvatar(avatar)) {
          return res.status(400).json({ error: 'Некорректное изображение профиля' });
        }
        user.avatar = avatar;
      }

      if (publicKey !== undefined) {
        if (typeof publicKey !== 'string' || publicKey.length > 4096) {
          return res.status(400).json({ error: 'Некорректный public key' });
        }
        user.public_key = publicKey;
      }

      if (newPassword || oldPassword) {
        if (!newPassword || String(newPassword).length < 6) {
          return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
        }
        if (!user.verifyPassword(oldPassword)) {
          return res.status(400).json({ error: 'Неверный текущий пароль' });
        }
        user.setPassword(newPassword);
      }

      this.db.markDirty();
      res.json({ success: true, user: user.toSafeJSON() });
    } catch (error) {
      console.error('Update profile error:', error);
      res.status(500).json({ error: 'Ошибка обновления профиля' });
    }
  }

  // Получение профиля
  getProfile(req, res) {
    try {
      const userId = parseInt(req.params.userId || req.query.userId, 10) || req.userId;
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

  // Поиск пользователей (кроме себя)
  searchUsers(req, res) {
    try {
      const query = String(req.query.query || req.query.q || req.query.search || '').trim();
      if (!query) return res.json([]);

      const q = query.toLowerCase().replace(/^@/, '');
      if (q.length < 1) return res.json([]);
      const users = this.db.users
        .filter(u => u.id !== req.userId && (
          (u.name || '').toLowerCase().includes(q) ||
          (u.phone || '').toLowerCase().includes(q) ||
          (u.username || '').toLowerCase().includes(q) ||
          (u.email || '').toLowerCase().includes(q)
        ))
        .slice(0, 50)
        .map(u => u.toSafeJSON());

      res.json(users);
    } catch (error) {
      console.error('Search users error:', error);
      res.status(500).json({ error: 'Ошибка поиска' });
    }
  }

  isValidAvatar(avatar) {
    if (typeof avatar !== 'string' || avatar.length > MAX_AVATAR_BYTES * 1.4) return false;
    if (avatar === '') return true;
    if (avatar.startsWith('data:image/')) {
      return /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar);
    }
    return /^https?:\/\//.test(avatar) || avatar.startsWith('/uploads/');
  }
}

module.exports = new ProfileController();
