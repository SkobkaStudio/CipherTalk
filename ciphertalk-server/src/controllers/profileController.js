const { getDatabase } = require('../db/database');
const { maskPhone, maskEmail } = require('../utils/mask');

const MAX_AVATAR_BYTES = 1.5 * 1024 * 1024;

class ProfileController {
  constructor() {
    this.db = getDatabase();
  }

  // Обновление профиля (только своего — userId берётся из сессии).
  // Сначала валидируем все поля, потом применяем: при ошибке профиль
  // не должен остаться частично изменённым.
  updateProfile(req, res) {
    try {
      const {
        firstName, lastName, name, username, avatar, bio, publicKey,
        oldPassword, newPassword, hideOnline, email
      } = req.body;
      const user = this.db.findUserById(req.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updates = {};

      if (firstName !== undefined) {
        const clean = String(firstName).trim().slice(0, 60);
        if (clean.length < 2) return res.status(400).json({ error: 'Имя минимум 2 символа' });
        updates.first_name = clean;
      }
      if (lastName !== undefined) updates.last_name = String(lastName).trim().slice(0, 60);
      if (name !== undefined) {
        const clean = String(name).trim().slice(0, 120);
        if (!clean) return res.status(400).json({ error: 'Имя не может быть пустым' });
        updates.name = clean;
      }

      if (username !== undefined) {
        const clean = String(username).replace(/^@/, '').trim().toLowerCase();
        if (!/^[a-z0-9_]{3,32}$/.test(clean)) {
          return res.status(400).json({ error: 'Username некорректный (3-32, латиница/цифры/_)' });
        }
        if (this.db.isUsernameTaken(clean, req.userId)) {
          return res.status(400).json({ error: 'Username занят' });
        }
        updates.username = clean;
      }

      if (email !== undefined) {
        const clean = String(email).trim().toLowerCase().slice(0, 120);
        if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
          return res.status(400).json({ error: 'Некорректный email' });
        }
        const taken = clean && this.db.users.some(u => u.id !== req.userId && (u.email || '').toLowerCase() === clean);
        if (taken) return res.status(400).json({ error: 'Email уже используется' });
        updates.email = clean;
      }

      if (bio !== undefined) updates.bio = String(bio).trim().slice(0, 500);

      if (avatar !== undefined) {
        if (!this.isValidAvatar(avatar)) {
          return res.status(400).json({ error: 'Некорректное изображение профиля' });
        }
        updates.avatar = avatar;
      }

      if (publicKey !== undefined) {
        if (typeof publicKey !== 'string' || publicKey.length > 4096) {
          return res.status(400).json({ error: 'Некорректный public key' });
        }
        updates.public_key = publicKey;
      }

      if (newPassword || oldPassword) {
        if (!newPassword || String(newPassword).length < 6) {
          return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
        }
        if (!user.verifyPassword(oldPassword)) {
          return res.status(400).json({ error: 'Неверный текущий пароль' });
        }
      }

      // Валидация пройдена — применяем изменения атомарно.
      Object.assign(user, updates);
      if (updates.first_name !== undefined || updates.last_name !== undefined) {
        if (name === undefined) {
          user.name = user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
        }
      }
      if (hideOnline !== undefined) user.hide_online = hideOnline ? 1 : 0;
      if (newPassword || oldPassword) user.setPassword(newPassword);

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
      const json = user.toSafeJSON();
      // Чужой телефон скрываем — публичная карточка не должна светить номер.
      if (user.id !== req.userId) {
        json.phone = maskPhone(user.phone);
        json.email = maskEmail(user.email);
      }
      res.json(json);
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Ошибка получения профиля' });
    }
  }

  /**
   * Поиск пользователей по username / email / телефону / имени.
   * Регистр не учитывается. Телефон и email в выдаче маскируются.
   */
  searchUsers(req, res) {
    try {
      const query = String(req.query.query || req.query.q || req.query.search || '').trim();
      if (!query) return res.json([]);

      const q = query.toLowerCase().replace(/^@/, '').trim();
      if (!q) return res.json([]);

      const digits = q.replace(/\D/g, '');
      const users = this.db.users
        .filter(u => u.id !== req.userId && (
          (u.username || '').toLowerCase().includes(q) ||
          (u.email || '').toLowerCase().includes(q) ||
          (u.name || '').toLowerCase().includes(q) ||
          (u.first_name || '').toLowerCase().includes(q) ||
          (u.last_name || '').toLowerCase().includes(q) ||
          (digits.length >= 3 && (u.phone || '').replace(/\D/g, '').includes(digits))
        ))
        .slice(0, 50)
        .map(u => {
          const json = u.toSafeJSON();
          json.phone = maskPhone(u.phone);
          json.email = maskEmail(u.email);
          if (u.hide_online) json.online = 0;
          return json;
        });

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
