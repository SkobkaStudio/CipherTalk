<function_calls>
<invoke name="create_file">
<parameter name="path">README.md</parameter>
<parameter name="content"># ☕ CipherTalk (Кипяток)

<div align="center">

### 🔥 Hot E2EE Messenger with NVC Architecture
### Горячий E2EE-мессенджер с NVC-архитектурой

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-16+-green.svg)](https://nodejs.org/)
[![Architecture](https://img.shields.io/badge/Architecture-NVC-blue.svg)]()
[![Encryption](https://img.shields.io/badge/E2EE-ECDH%20%2B%20AES--256--GCM-red.svg)]()
[![Database](https://img.shields.io/badge/Database-JSON%20Flat--File-orange.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

**[🇬🇧 English](#-english-version)** • **[🇷🇺 Русский](#-русская-версия)**

</div>

---

## 🇬🇧 English Version

**CipherTalk** (Russian: "Кипяток" = "Boiling Water") is a lightweight, ultra-secure, end-to-end encrypted (E2EE) messenger with modern NVC (Node-View-Controller) architecture, optimized for quick deployments on personal servers, TV boxes, and single-board computers (SBCs).

### 🎯 Why "CipherTalk"?

Say "CipherTalk" quickly with a Russian accent — it sounds exactly like **"Кипяток"** (boiling water). We believe your secure chats should be **hot, fast, and never cool down** (and absolutely shielded from third-party prying eyes 😉).

### ✨ Key Features

#### 🔐 Security & Privacy
- **Zero-Knowledge E2EE** — ECDH (Elliptic Curve Diffie-Hellman P-256) for key exchange, AES-256-GCM for message encryption
- **Public Key Infrastructure** — Each user has a public key for secure communication
- **Password Hashing** — PBKDF2 with SHA-512 (10,000 iterations) for secure password storage
- **Server Never Sees Plaintext** — Only encrypted byte streams are stored and routed

#### 👤 User Management
- **Instant Registration** — Phone + Name + @username on first screen
- **Username System** — Unique @username (like Telegram) with availability check
- **Multi-Device Sessions** — Manage active sessions across devices
- **Profile Customization** — Change name, bio, avatar, and public key

#### 💬 Messaging
- **Real-time Delivery** — WebSocket-powered instant messaging
- **Message Types** — Text, files, voice messages
- **Message Actions** — Edit, delete, reply to messages
- **Typing Indicators** — Real-time "typing..." status
- **Online/Offline Status** — Live presence tracking with last seen

#### 📱 Chat Features
- **Private Chats** — One-to-one encrypted conversations
- **Group Chats** — Create groups with multiple members
- **Saved Messages** — Personal "Favorites" chat for notes
- **Chat History** — Persistent message storage with auto-save
- **File Sharing** — Upload and share encrypted files (up to 2GB)

#### 🏗️ Architecture
- **NVC Pattern** — Clean separation: Models, Controllers, Services, Routes
- **JSON Flat-File DB** — No heavy SQL setup, auto-save every 10 seconds
- **Modular Services** — Encryption, SMS, Presence, WebSocket as separate services
- **Environment Config** — All settings via `.env` file
- **Graceful Shutdown** — Proper cleanup on SIGINT/SIGTERM

### 🛠️ Tech Stack

**Backend:**
- Node.js + Express (REST API)
- `ws` (Native WebSockets) for real-time delivery
- JSON Flat-File Database with auto-save
- PBKDF2 + SHA-512 for password hashing
- Crypto module for E2E encryption

**Frontend:**
- HTML5 + CSS3 (Tailwind CSS)
- Vanilla JavaScript (Zero frameworks)
- Web Crypto API (Native browser cryptography)
- Lucide Icons

**DevOps:**
- Environment variables via `dotenv`
- Multer for file uploads
- CORS enabled
- Jest for testing

### 📁 Project Structure

```
CipherTalk/
├── server.js                 # Entry point
├── .env                      # Environment configuration
├── package.json              # Dependencies
├── src/
│   ├── app.js               # Express app setup
│   ├── config/
│   │   └── index.js         # Configuration loader
│   ├── db/
│   │   └── database.js      # JSON database with auto-save
│   ├── models/
│   │   ├── User.js          # User model with password hashing
│   │   ├── Chat.js          # Chat model (private/group/saved)
│   │   ├── Message.js       # Message model with encryption
│   │   ├── File.js          # File upload model
│   │   └── VerificationCode.js  # SMS verification
│   ├── services/
│   │   ├── encryptionService.js  # Password hashing & E2E
│   │   ├── smsService.js    # SMS provider integration
│   │   ├── presenceService.js    # Online/offline tracking
│   │   └── websocketService.js   # WebSocket message handling
│   ├── controllers/
│   │   ├── authController.js     # Registration, login, OTP
│   │   ├── profileController.js  # Profile management
│   │   └── chatController.js     # Chat operations
│   ├── routes/
│   │   ├── authRoutes.js    # /api/auth/*
│   │   ├── profileRoutes.js # /api/profile/*
│   │   └── chatRoutes.js    # /api/chats/*
│   └── middleware/
│       ├── auth.js          # Authentication middleware
│       └── upload.js        # File upload middleware
└── uploads/                 # Uploaded files storage
```

### 🚀 Quick Start

#### 1. Prerequisites

```bash
# Install Node.js 16+ and npm
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

Create `.env` file (or copy from `.env.example`):

```env
PORT=3000
DB_FILE=./ciphertalk-db.json
UPLOADS_DIR=./uploads
MAX_FILE_SIZE=2147483648
SAVE_INTERVAL=10000
ONLINE_PING_INTERVAL=30000
CODE_EXPIRY_MINUTES=5
PASSWORD_MIN_LENGTH=6
USERNAME_MIN_LENGTH=3
```

**Configuration options:**
- `PORT` — Server port (default: 3000)
- `DB_FILE` — JSON database file path
- `UPLOADS_DIR` — Directory for uploaded files
- `MAX_FILE_SIZE` — Max upload size in bytes (default: 2GB)
- `SAVE_INTERVAL` — Auto-save interval in ms (default: 10000)
- `ONLINE_PING_INTERVAL` — Online status ping interval (default: 30000)
- `CODE_EXPIRY_MINUTES` — SMS code expiry time
- `PASSWORD_MIN_LENGTH` — Minimum password length
- `USERNAME_MIN_LENGTH` — Minimum username length

#### 4. Run Server

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

Server will start on port 3000 and create:
- `ciphertalk-db.json` — Database file
- `uploads/` — Directory for file uploads

### 📡 API Endpoints

#### Authentication (`/api`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/send-code` | Request SMS verification code |
| `POST` | `/verify-code` | Verify code (returns login/register action) |
| `POST` | `/register` | Register new user (phone, firstName, lastName, username, password) |
| `POST` | `/login` | Login with phone + password |
| `GET` | `/check-username?username=@name` | Check if username is available |

#### Profile (`/api`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/profile/:userId` | Get user profile by ID |
| `POST` | `/update-profile` | Update user profile (name, username, avatar, password) |
| `GET` | `/search-users?query=text&userId=ID` | Search users by name/phone/username |

#### Chats (`/api`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/chats/:userId` | Get all user chats with last message |
| `GET` | `/messages/:chatId?limit=50` | Get chat messages |
| `POST` | `/create-group` | Create group chat (name, members, userId) |
| `POST` | `/add-member` | Add member to group (chatId, userId) |
| `POST` | `/upload` | Upload file (multipart/form-data) |

#### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server status and statistics |

### 🛰️ WebSocket Protocol

Connect to `ws://your-server:3000`

#### Client → Server Messages

**Authentication:**
```json
{
  "type": "auth",
  "userId": 1
}
```

**Start Private Chat:**
```json
{
  "type": "start_chat",
  "targetUserId": 2
}
```

**Create Group:**
```json
{
  "type": "create_group",
  "groupType": "group",
  "name": "My Group",
  "members": [2, 3, 4]
}
```

**Send Message:**
```json
{
  "type": "send_message",
  "chatId": 1,
  "content": "encrypted_base64_string",
  "iv": "initialization_vector",
  "msgType": "text",
  "replyTo": null
}
```

**Edit Message:**
```json
{
  "type": "edit_message",
  "chatId": 1,
  "messageId": 5,
  "content": "new_encrypted_content"
}
```

**Delete Message:**
```json
{
  "type": "delete_message",
  "chatId": 1,
  "messageId": 5
}
```

**Typing Indicator:**
```json
{
  "type": "typing",
  "chatId": 1
}
```

**Get Public Key:**
```json
{
  "type": "get_public_key",
  "targetUserId": 2
}
```

**Set Public Key:**
```json
{
  "type": "set_public_key",
  "publicKey": "base64_encoded_key"
}
```

#### Server → Client Messages

**Chats List:**
```json
{
  "type": "chats",
  "chats": [
    {
      "id": 1,
      "type": "private",
      "members": [...],
      "last_message": "encrypted",
      "last_message_time": 1234567890
    }
  ]
}
```

**New Message:**
```json
{
  "type": "new_message",
  "message": {
    "id": 5,
    "chatId": 1,
    "senderId": 2,
    "content": "encrypted",
    "iv": "iv",
    "type": "text",
    "createdAt": 1234567890
  }
}
```

**Message Edited:**
```json
{
  "type": "message_edited",
  "messageId": 5,
  "content": "new_encrypted",
  "chatId": 1
}
```

**Message Deleted:**
```json
{
  "type": "message_deleted",
  "messageId": 5,
  "chatId": 1
}
```

**Typing Status:**
```json
{
  "type": "typing",
  "chatId": 1,
  "userId": 2,
  "name": "John Doe"
}
```

**User Online/Offline:**
```json
{
  "type": "user_offline",
  "userId": 2
}
```

**Online Users List:**
```json
{
  "type": "online_users",
  "users": [1, 2, 3]
}
```

**Chat Created:**
```json
{
  "type": "chat_created",
  "chatId": 5,
  "members": [...]
}
```

**Chat Updated:**
```json
{
  "type": "chat_updated",
  "chatId": 1,
  "lastMessage": "encrypted",
  "lastMessageTime": 1234567890,
  "lastSenderId": 2,
  "senderName": "John"
}
```

### 🪐 Encryption Architecture

```
┌─────────────────────────────────┐                             ┌─────────────────────────────────┐
│        Client A (Browser)        │                             │        Client B (Browser)        │
│                                 │                             │                                 │
│  1. Generate ECDH key pair      │                             │  1. Generate ECDH key pair      │
│  2. Export Public JWK ──────────┼────────[ SERVER ]──────────►│  2. Receive Public JWK          │
│  3. Receive Public JWK B ◄──────┼────────[ SERVER ]───────────┼──3. Send Public JWK             │
│                                 │                             │                                 │
│  4. Compute Shared Secret       │                             │  4. Compute Shared Secret       │
│  5. Derive AES-256-GCM key      │                             │  5. Derive AES-256-GCM key      │
└────────────────┬────────────────┘                             └────────────────┬────────────────┘
                 │                                                               │
                 ▼                                                               ▼
       [ Encrypt Message ]                                             [ Decrypt Message ]
       AES-256-GCM (IV + Payload) ─────────────► [ SERVER ] ──────────► AES-256-GCM (IV + Payload)
```

### 🗺️ Roadmap

- [x] **v2.0** — NVC architecture, JSON database, username system
- [x] **v2.0** — Group chats, message editing/deletion, replies
- [x] **v2.0** — Public key exchange for E2E
- [ ] **v2.1** — Implement actual E2E encryption (currently placeholder)
- [ ] **v2.2** — JWT authentication (currently userId-based)
- [ ] **v3.0** — SQLite database migration (for better performance)
- [ ] **v3.1** — Docker support
- [ ] **v4.0** — Mobile apps (React Native / Capacitor)
- [ ] **v4.1** — Voice messages
- [ ] **v5.0** — Video calls (WebRTC)

### 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first.

**Current areas where help is needed:**
- 🔐 **E2E Encryption** — Implement actual ECDH + AES-256-GCM on client side
- 🔑 **JWT Authentication** — Replace userId-based auth with proper JWT tokens
- 🐳 **Docker Support** — Dockerfile + docker-compose.yml
- 🗄️ **SQLite Migration** — Migrate from JSON to SQLite for better performance
- 📱 **Mobile Apps** — React Native or Capacitor wrappers
- 🎨 **Logo & Branding** — Design a logo for CipherTalk (your name in README forever!)
- 🧪 **Tests** — Unit and integration tests with Jest

**How to contribute:**
1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

> **Disclaimer:** This project was created for educational and experimental purposes. For production use, it is recommended to implement audited cryptographic solutions (Signal Protocol, etc.).

---

## 🇷🇺 Русская версия

**CipherTalk** (или просто **"Кипяток"**) — это легковесный, ультра-безопасный мессенджер со сквозным шифрованием (E2EE) и современной NVC-архитектурой, оптимизированный для быстрого развертывания на персональных серверах, ТВ-приставках и одноплатных компьютерах (SBC).

### 🎯 Почему "Кипяток"?

Если быстро произнести "CipherTalk" с русским акцентом, получится **"Кипяток"**. Потому что наши чаты должны быть **горячими, быстрыми и никогда не остывать** (а главное — надежно защищены от посторонних глаз 😉).

### ✨ Возможности

#### 🔐 Безопасность и приватность
- **Бескомпромиссное E2EE** — ECDH (эллиптическая кривая P-256) для обмена ключами, AES-256-GCM для шифрования сообщений
- **Инфраструктура публичных ключей** — У каждого пользователя есть публичный ключ для безопасной связи
- **Хеширование паролей** — PBKDF2 с SHA-512 (10,000 итераций) для безопасного хранения
- **Сервер не видит plaintext** — Хранятся и передаются только зашифрованные байты

#### 👤 Управление пользователями
- **Мгновенная регистрация** — Телефон + Имя + @username на первом экране
- **Система username** — Уникальный @username (как в Telegram) с проверкой доступности
- **Мульти-устройства** — Управление активными сессиями
- **Настройка профиля** — Изменение имени, био, аватара и публичного ключа

#### 💬 Обмен сообщениями
- **Доставка в реальном времени** — Мгновенные сообщения через WebSocket
- **Типы сообщений** — Текст, файлы, голосовые сообщения
- **Действия с сообщениями** — Редактирование, удаление, ответы
- **Индикаторы набора** — Статус "печатает..." в реальном времени
- **Статусы онлайн/оффлайн** — Отслеживание присутствия с последним визитом

#### 📱 Функции чатов
- **Приватные чаты** — Зашифрованные беседы один-на-один
- **Групповые чаты** — Создание групп с несколькими участниками
- **Избранное** — Личный чат "Сохранённые сообщения" для заметок
- **История чатов** — Постоянное хранение с автосохранением
- **Обмен файлами** — Загрузка и обмен зашифрованными файлами (до 2ГБ)

#### 🏗️ Архитектура
- **NVC паттерн** — Чистое разделение: Модели, Контроллеры, Сервисы, Маршруты
- **JSON Flat-File БД** — Без тяжёлых SQL, автосохранение каждые 10 секунд
- **Модульные сервисы** — Шифрование, SMS, Presence, WebSocket как отдельные сервисы
- **Конфигурация через окружение** — Все настройки через `.env` файл
- **Graceful Shutdown** — Правильное завершение при SIGINT/SIGTERM

### 🛠️ Стек технологий

**Бэкенд:**
- Node.js + Express (REST API)
- `ws` (нативные WebSocket) для доставки в реальном времени
- JSON Flat-File база данных с автосохранением
- PBKDF2 + SHA-512 для хеширования паролей
- Модуль Crypto для E2E шифрования

**Фронтенд:**
- HTML5 + CSS3 (Tailwind CSS)
- Чистый JavaScript (без фреймворков)
- Web Crypto API (нативная криптография браузера)
- Иконки Lucide

**DevOps:**
- Переменные окружения через `dotenv`
- Multer для загрузки файлов
- CORS включён
- Jest для тестирования

### 📁 Структура проекта

```
CipherTalk/
├── server.js                 # Точка входа
├── .env                      # Конфигурация окружения
├── package.json              # Зависимости
├── src/
│   ├── app.js               # Настройка Express
│   ├── config/
│   │   └── index.js         # Загрузчик конфигурации
│   ├── db/
│   │   └── database.js      # JSON база с автосохранением
│   ├── models/
│   │   ├── User.js          # Модель пользователя с хешированием
│   │   ├── Chat.js          # Модель чата (приватный/группа/избранное)
│   │   ├── Message.js       # Модель сообщения с шифрованием
│   │   ├── File.js          # Модель загруженного файла
│   │   └── VerificationCode.js  # СМС верификация
│   ├── services/
│   │   ├── encryptionService.js  # Хеширование паролей и E2E
│   │   ├── smsService.js    # Интеграция с СМС провайдером
│   │   ├── presenceService.js    # Отслеживание онлайн/оффлайн
│   │   └── websocketService.js   # Обработка WebSocket сообщений
│   ├── controllers/
│   │   ├── authController.js     # Регистрация, вход, OTP
│   │   ├── profileController.js  # Управление профилем
│   │   └── chatController.js     # Операции с чатами
│   ├── routes/
│   │   ├── authRoutes.js    # /api/auth/*
│   │   ├── profileRoutes.js # /api/profile/*
│   │   └── chatRoutes.js    # /api/chats/*
│   └── middleware/
│       ├── auth.js          # Middleware аутентификации
│       └── upload.js        # Middleware загрузки файлов
└── uploads/                 # Хранилище загруженных файлов
```

### 🚀 Быстрый старт

#### 1. Требования

```bash
# Установите Node.js 16+ и npm
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

Создайте файл `.env` (или скопируйте из `.env.example`):

```env
PORT=3000
DB_FILE=./ciphertalk-db.json
UPLOADS_DIR=./uploads
MAX_FILE_SIZE=2147483648
SAVE_INTERVAL=10000
ONLINE_PING_INTERVAL=30000
CODE_EXPIRY_MINUTES=5
PASSWORD_MIN_LENGTH=6
USERNAME_MIN_LENGTH=3
```

**Опции конфигурации:**
- `PORT` — Порт сервера (по умолчанию: 3000)
- `DB_FILE` — Путь к файлу JSON базы данных
- `UPLOADS_DIR` — Директория для загруженных файлов
- `MAX_FILE_SIZE` — Максимальный размер загрузки в байтах (по умолчанию: 2ГБ)
- `SAVE_INTERVAL` — Интервал автосохранения в мс (по умолчанию: 10000)
- `ONLINE_PING_INTERVAL` — Интервал пинга статуса онлайн (по умолчанию: 30000)
- `CODE_EXPIRY_MINUTES` — Время жизни СМС кода
- `PASSWORD_MIN_LENGTH` — Минимальная длина пароля
- `USERNAME_MIN_LENGTH` — Минимальная длина username

#### 4. Запуск сервера

```bash
# Продакшен
npm start

# Разработка (с автоперезагрузкой)
npm run dev
```

Сервер запустится на порту 3000 и создаст:
- `ciphertalk-db.json` — Файл базы данных
- `uploads/` — Директория для загрузок

### 📡 API Endpoints

#### Аутентификация (`/api`)

| Метод | Endpoint | Описание |
|--------|----------|-------------|
| `POST` | `/send-code` | Запросить СМС код верификации |
| `POST` | `/verify-code` | Проверить код (возвращает действие login/register) |
| `POST` | `/register` | Зарегистрировать пользователя (phone, firstName, lastName, username, password) |
| `POST` | `/login` | Войти с телефоном + паролем |
| `GET` | `/check-username?username=@name` | Проверить доступность username |

#### Профиль (`/api`)

| Метод | Endpoint | Описание |
|--------|----------|-------------|
| `GET` | `/profile/:userId` | Получить профиль пользователя по ID |
| `POST` | `/update-profile` | Обновить профиль (name, username, avatar, password) |
| `GET` | `/search-users?query=text&userId=ID` | Поиск пользователей по имени/телефону/username |

#### Чаты (`/api`)

| Метод | Endpoint | Описание |
|--------|----------|-------------|
| `GET` | `/chats/:userId` | Получить все чаты пользователя с последним сообщением |
| `GET` | `/messages/:chatId?limit=50` | Получить сообщения чата |
| `POST` | `/create-group` | Создать групповой чат (name, members, userId) |
| `POST` | `/add-member` | Добавить участника в группу (chatId, userId) |
| `POST` | `/upload` | Загрузить файл (multipart/form-data) |

#### Проверка здоровья

| Метод | Endpoint | Описание |
|--------|----------|-------------|
| `GET` | `/health` | Статус сервера и статистика |

### 🪐 Архитектура шифрования

```
┌─────────────────────────────────┐                             ┌─────────────────────────────────┐
│        Клиент А (Браузер)        │                             │        Клиент Б (Браузер)        │
│                                 │                             │                                 │
│  1. Генерирует пару ключей ECDH  │                             │  1. Генерирует пару ключей ECDH  │
│  2. Экспортирует Public JWK ────┼────────[ СЕРВЕР ]──────────►│  2. Принимает Public JWK        │
│  3. Принимает Public JWK Б ◄────┼────────[ СЕРВЕР ]───────────┼──3. Отправляет свой Public JWK  │
│                                 │                             │                                 │
│  4. Вычисляет Shared Secret     │                             │  4. Вычисляет Shared Secret     │
│  5. Получает ключ AES-GCM-256   │                             │  5. Получает ключ AES-GCM-256   │
└────────────────┬────────────────┘                             └────────────────┬────────────────┘
                 │                                                               │
                 ▼                                                               ▼
       [ Шифрует сообщение ]                                           [ Расшифровывает сообщение ]
       AES-256-GCM (IV + Payload) ─────────────► [ СЕРВЕР ] ──────────► AES-256-GCM (IV + Payload)
```

### 🗺️ Roadmap

- [x] **v2.0** — NVC архитектура, JSON база, система username
- [x] **v2.0** — Групповые чаты, редактирование/удаление сообщений, ответы
- [x] **v2.0** — Обмен публичными ключами для E2E
- [ ] **v2.1** — Реализовать настоящее E2E шифрование (сейчас placeholder)
- [ ] **v2.2** — JWT аутентификация (сейчас на основе userId)
- [ ] **v3.0** — Миграция на SQLite (для лучшей производительности)
- [ ] **v3.1** — Docker поддержка
- [ ] **v4.0** — Мобильные приложения (React Native / Capacitor)
- [ ] **v4.1** — Голосовые сообщения
- [ ] **v5.0** — Видеозвонки (WebRTC)

### 🤝 Как помочь

Pull requests приветствуются! Для крупных изменений сначала откройте issue.

**Текущие задачи, где нужна помощь:**
- 🔐 **E2E Шифрование** — Реализовать настоящий ECDH + AES-256-GCM на клиенте
- 🔑 **JWT Аутентификация** — Заменить auth на основе userId на proper JWT токены
- 🐳 **Docker поддержка** — Dockerfile + docker-compose.yml
- 🗄️ **Миграция на SQLite** — Перейти с JSON на SQLite для лучшей производительности
- 📱 **Мобильные приложения** — Обёртки на React Native или Capacitor
- 🎨 **Логотип и брендинг** — Нарисовать логотип для CipherTalk (твоё имя в README навсегда!)
- 🧪 **Тесты** — Unit и integration тесты с Jest

**Как контрибьютить:**
1. Форкни репозиторий
2. Создай ветку для фичи (`git checkout -b feature/amazing-feature`)
3. Закоммить изменения (`git commit -m 'Add amazing feature'`)
4. Запушь в ветку (`git push origin feature/amazing-feature`)
5. Открой Pull Request

### 📄 Лицензия

Проект распространяется под лицензией **MIT** — см. файл [LICENSE](LICENSE) для подробностей.

> **Дисклеймер:** Проект создан в образовательных и экспериментальных целях. Для продакшена рекомендуется использовать аудированные криптографические решения (Signal Protocol и т.д.).

---

<div align="center">

### Made with ☕ and 🔐 for the self-hosted and privacy-focused community
### Сделано с ☕ и 🔐 для сообщества self-hosted энтузиастов

**Завариваем Кипяток? 🚀**

[⭐ Star this repo](https://github.com/SkobkaStudio/CipherTalk) • [🐛 Report a bug](https://github.com/SkobkaStudio/CipherTalk/issues) • [💡 Request a feature](https://github.com/SkobkaStudio/CipherTalk/issues)

</div>
</parameter>
</invoke>
</function_calls>