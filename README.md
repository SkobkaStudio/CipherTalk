# ☕ CipherTalk (Кипяток)

<div align="center">

**Горячий E2EE-мессенджер для TV-боксов и одноплатных компьютеров**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-16+-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Armbian%20%7C%20Debian%20%7C%20Ubuntu-blue.svg)]()
[![Version](https://img.shields.io/badge/Version-4.0-orange.svg)]()

[🇬🇧 English](#-english-version) | [🇷🇺 Русский](#-русская-версия)

</div>

---

## 🇬🇧 English Version

**CipherTalk** (Russian: "Кипяток" = "Boiling Water") is a lightweight, secure, end-to-end encrypted (E2EE) messenger specifically optimized for TV boxes and single-board computers (SBCs) running Armbian/Debian/Ubuntu.

### 🎯 Why "CipherTalk"?

Say "CipherTalk" quickly with a Russian accent — it sounds like "Кипяток" (boiling water). Because chats should be **hot, fast, and never cool down** (and definitely shouldn't leak to third parties 😉).

### ✨ Key Features

- 🔐 **End-to-End Encryption (E2EE)** — AES-256 encryption on client side, server never sees plaintext
- 👤 **User Profiles** — avatars, bio, custom names
- 📱 **Multi-Device Sessions** — manage active sessions across devices
- ⏰ **Real-time Statuses** — online/offline, "typing...", "uploading photo..."
- 💬 **Instant Messaging** — WebSocket-based real-time delivery
- 📸 **Media Sharing** — encrypted image uploads (up to 15MB)
- 🗄️ **SQLite Database** — single file, minimal resources, easy backup
- 📲 **SMS Verification** — sms.ru integration with free demo mode
- 🚀 **Low Footprint** — runs on 512MB RAM (tested on X96 Max Plus with Armbian)

### 🛠️ Tech Stack

**Backend:**
- Node.js + Express
- WebSocket (ws) for real-time communication
- SQLite3 for data storage
- bcrypt for password hashing
- CryptoJS (AES-256) for client-side encryption

**Frontend:**
- Pure HTML + JavaScript (no frameworks)
- localStorage for encryption keys
- Responsive design

### 🚀 Quick Start

#### 1. Prerequisites
```bash
sudo apt update
sudo apt install nodejs npm -y
```

#### 2. Installation
```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk
npm install
```

#### 3. Configuration
Edit `server.js` and configure SMS service:
```javascript
const SMS_CONFIG = {
  demoMode: true,            // Keep 'true' for FREE testing (codes in console)
  apiId: 'YOUR_SMS_RU_KEY'   // Set real apiId for production SMS
};
```

#### 4. Run
```bash
node server.js
```

Server will start on port 3000 and create `server-data/` directory automatically.

### 📡 API Endpoints

#### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/request-otp` | Request SMS verification code |
| POST | `/api/auth/verify-otp` | Verify code and get session token |
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login-password` | Login with phone + password |
| GET | `/api/auth/sessions` | Get all active sessions |
| DELETE | `/api/auth/sessions/:deviceId` | Terminate specific session |

#### Profile
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/profile` | Get current user profile |
| POST | `/api/profile/update` | Update name and bio |
| POST | `/api/profile/avatar` | Upload avatar image |
| GET | `/api/users/:phone/profile` | Get user profile by phone |
| GET | `/api/users/find/:phone` | Search user by phone |

#### Messages & Media
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/messages/history/:contactPhone` | Get chat history |
| POST | `/api/media/upload` | Upload encrypted media |
| GET | `/api/media/download/:filename` | Download media file |

#### Encryption Keys
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/keys/save` | Save chat encryption key |
| GET | `/api/keys/all` | Get all chat keys |

### 🛰️ WebSocket Protocol

Connect to `ws://your-server:3000`

**Authentication:**
```json
{ "type": "auth", "token": "YOUR_SESSION_TOKEN" }
```

**Send Message:**
```json
{
  "type": "message",
  "receiverPhone": "9001234567",
  "encryptedText": "U2FsdGVkX1...",
  "mediaUrl": "/api/media/download/abc...",
  "mediaType": "text"
}
```

**Typing Status:**
```json
{
  "type": "typing",
  "receiverPhone": "9001234567",
  "isTyping": true
}
```

**Upload Status:**
```json
{
  "type": "uploading_photo",
  "receiverPhone": "9001234567",
  "isUploading": true
}
```

---

## 🇷🇺 Русская версия

**CipherTalk** (или просто **"Кипяток"**) — это легковесный, безопасный мессенджер со сквозным шифрованием (E2EE), специально оптимизированный для TV-боксов и одноплатных компьютеров под управлением Armbian/Debian/Ubuntu.

### 🎯 Почему "Кипяток"?

Если быстро произнести "CipherTalk" с русским акцентом, получится "Кипяток". Потому что чаты должны быть **горячими, быстрыми и никогда не остывать** (и точно не утекать к третьим лицам 😉).

### ✨ Возможности

- 🔐 **Сквозное шифрование (E2EE)** — AES-256 на клиенте, сервер не видит plaintext
- 👤 **Профили пользователей** — аватарки, био, имена
- 📱 **Мульти-устройства** — управление сессиями на разных устройствах
- ⏰ **Статусы в реальном времени** — онлайн/оффлайн, "печатает...", "загружает фото..."
- 💬 **Мгновенные сообщения** — доставка через WebSocket
- 📸 **Обмен медиа** — загрузка зашифрованных изображений (до 15МБ)
- 🗄️ **База SQLite** — один файл, минимум ресурсов, простой бэкап
- 📲 **СМС-верификация** — интеграция с sms.ru + бесплатный демо-режим
- 🚀 **Минимум ресурсов** — работает на 512МБ RAM (тестировано на X96 Max Plus с Armbian)

### 🛠️ Стек технологий

**Бэкенд:**
- Node.js + Express
- WebSocket (ws) для real-time общения
- SQLite3 для хранения данных
- bcrypt для хеширования паролей
- CryptoJS (AES-256) для шифрования на клиенте

**Фронтенд:**
- Чистый HTML + JavaScript (без фреймворков)
- localStorage для ключей шифрования
- Адаптивный дизайн

### 🚀 Быстрый старт

#### 1. Требования
```bash
sudo apt update
sudo apt install nodejs npm -y
```

#### 2. Установка
```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk
npm install
```

#### 3. Конфигурация
Открой `server.js` и настрой СМС-сервис:
```javascript
const SMS_CONFIG = {
  demoMode: true,            // Оставь 'true' для БЕСПЛАТНОГО тестирования (коды в консоли)
  apiId: 'YOUR_SMS_RU_KEY'   // Укажи реальный apiId для продакшена
};
```

#### 4. Запуск
```bash
node server.js
```

Сервер запустится на порту 3000 и автоматически создаст директорию `server-data/`.

### 📊 Архитектура

```
┌─────────────┐
│   Клиент    │ ← Шифрует сообщения AES-256
│ (HTML/JS)   │   Хранит ключ в localStorage
└──────┬──────┘
       │ WebSocket / REST API
       ▼
┌─────────────┐
│   Сервер    │ ← Хранит только зашифрованные данные
│ (Node.js)   │   Не видит plaintext
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   SQLite    │ ← Один файл antiscam.db
└─────────────┘   Минимум ресурсов
```

### 🗺️ Roadmap

- [x] **v4.0** — Профили, статусы, мульти-устройства
- [ ] **v4.1** — Фикс потери ключей шифрования при перезагрузке
- [ ] **v4.2** — Поддержка международных номеров телефонов
- [ ] **v5.0** — Docker-поддержка для упрощения развёртывания
- [ ] **v5.1** — UI/UX улучшения (тёмная тема, мобильная адаптация)
- [ ] **v6.0** — Мобильные приложения (Android APK)
- [ ] **v6.1** — Десктопные приложения (Windows EXE, Linux)
- [ ] **v7.0** — Голосовые сообщения

### 🤝 Как помочь?

Проект открытый (MIT License), и мы будем рады любой помощи!

#### Текущие задачи:

1. **🔐 Фикс потери ключей шифрования** (Critical)
   - Проблема: при перезагрузке страницы ключ AES-256 не восстанавливается
   - Сложность: средняя
   - Issue: [#1](https://github.com/SkobkaStudio/CipherTalk/issues/1)

2. **🌍 Поддержка международных номеров**
   - Проблема: сейчас работает только с +7
   - Сложность: низкая
   - Issue: [#1](https://github.com/SkobkaStudio/CipherTalk/issues/1)

3. **🐳 Docker-поддержка**
   - Нужно: Dockerfile + docker-compose.yml
   - Сложность: низкая (отличная задача для новичков!)

4. **🎨 UI/UX улучшения**
   - Нужно: адаптивность, тёмная тема, индикаторы загрузки
   - Сложность: низкая

5. **🎨 Логотип и брендинг**
   - Нужно: нарисовать логотип для CipherTalk (Кипяток)
   - Идея: чашка/чайник с паром + замок/щит
   - Форматы: SVG, PNG, ICO
   - Бонус: твоё имя в README навсегда! 😎

#### Как контрибьютить:

1. Форкни репозиторий
2. Создай ветку для своей фичи (`git checkout -b feature/amazing-feature`)
3. Закоммить изменения (`git commit -m 'Add amazing feature'`)
4. Запушь в ветку (`git push origin feature/amazing-feature`)
5. Открой Pull Request

### 📄 Лицензия

Этот проект распространяется под лицензией MIT — см. файл [LICENSE](LICENSE) для подробностей.

**Важно:** Проект создан в образовательных целях. Для продакшена рекомендуется использовать проверенные криптографические протоколы (Signal Protocol, Matrix и т.д.).

### 🔗 Ссылки

- **Репозиторий:** [github.com/SkobkaStudio/CipherTalk](https://github.com/SkobkaStudio/CipherTalk)
- **Issues:** [github.com/SkobkaStudio/CipherTalk/issues](https://github.com/SkobkaStudio/CipherTalk/issues)
- **Документация API:** В этом README

---

<div align="center">

**Сделано с ☕ и 🔐 для сообщества self-hosted энтузиастов**

**Завариваем?** 🚀

</div>