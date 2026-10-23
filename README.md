# ☕ CipherTalk (Кипяток) — Premium E2EE Messenger

<div align="center">

### 🔥 Hot End-to-End Encrypted Messenger with NVC Architecture
### Горячий E2EE-мессенджер с NVC-архитектурой

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-16+-green.svg)](https://nodejs.org/)
[![Architecture](https://img.shields.io/badge/Architecture-NVC-blue.svg)]()
[![Encryption](https://img.shields.io/badge/E2EE-ECDH%20%2B%20AES--256--GCM-red.svg)]()
[![Database](https://img.shields.io/badge/Database-SQLite%20%2B%20WAL-orange.svg)]()
[![UI](https://img.shields.io/badge/UI-Glassmorphism%20%2B%20Custom%20Themes-purple.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

**[🇬🇧 English Version](#-english-version)** • **[🇷🇺 Русская версия](#-русская-версия)**

</div>

<br>
<br>

---

## 🇬🇧 ENGLISH VERSION

<br>

### 📖 Introduction

**CipherTalk** (Russian: "Кипяток" = "Boiling Water") is a lightweight, ultra-secure, end-to-end encrypted (E2EE) messenger. Built on a modern NVC (Node-View-Controller) architecture, it is optimized for quick deployments on personal servers, VPS, and single-board computers (SBCs). The project features a premium, highly customizable user interface designed to compete with top-tier commercial messengers.

The philosophy behind CipherTalk is simple: your secure chats should be **hot, fast, and never cool down**. The server is designed to be "blind", meaning it physically cannot read your messages. All encryption and decryption happen on the client side.

<br>

### 📊 Project Statistics & Proof of Work

*   **Total Codebase Size:** ~193,765 lines (including dependencies, configurations, localizations, and styles).
*   **Recent Mega Update:** 58 files changed, 11,504 insertions(+), 750 deletions(-).
*   **Database Migration:** 100% successful transition from legacy JSON format to SQLite with WAL mode.
*   **Test Coverage:** 100% Passed across 12 test suites (250+ individual checks).
*   **Security Verification:** Server stores only ciphertext (verified by automated tests).

<br>

### ✨ Key Features

#### 🔐 Security & Privacy (Server-Blind Architecture)
*   **Zero-Knowledge E2EE:** 
    *   Utilizes **ECDH (P-256)** for public key exchange.
    *   Utilizes **AES-256-GCM** for message encryption.
    *   Every message is encrypted with a unique Initialization Vector (IV).
    *   The server only stores and routes encrypted byte streams.
*   **JWT Sessions:** 
    *   Replaced insecure ID-based authentication with robust HMAC-SHA256 JSON Web Tokens.
    *   Tokens are cryptographically signed and revoked server-side upon logout.
*   **SQLite + WAL Mode:** 
    *   Write-Ahead Logging (WAL) prevents database locking during concurrent read/write operations.
    *   Ensures ACID compliance and high performance.
*   **Safety Numbers:** 
    *   Generates a 60-digit code for users to compare with their contacts.
    *   Ensures no Man-in-the-Middle (MITM) key substitution has occurred.
*   **Privacy Toggles:** 
    *   PIN-code app lock.
    *   "Ghost Mode" (hides online status and read receipts).
    *   Screenshot protection (where supported by the OS/browser).

#### 💬 Messaging & Media
*   **Real-time Delivery:** 
    *   Instant messaging via WebSockets.
    *   No duplicate messages.
    *   Seamless synchronization across multiple browser tabs.
*   **Rich Interactions:** 
    *   Reply with quotes.
    *   Forward messages.
    *   Edit messages.
    *   Delete for me / Delete for everyone.
    *   Pin important messages.
    *   Emoji reactions.
*   **Media Support:** 
    *   File sharing up to 50MB.
    *   Photo sharing with an elegant fallback UI if the file is lost.
    *   Voice messages recorded via `MediaRecorder` API.
    *   Animated SVG stickers.
*   **WebRTC Calls:** 
    *   Fully functional P2P Audio and Video calls directly in the browser.
    *   Media streams are protected by **DTLS-SRTP**.
    *   Media streams never pass through the server.
*   **Live Status:** 
    *   Real-time typing indicators ("typing...").
    *   Online/Offline presence tracking.
    *   Last seen timestamps.

#### 🎨 Premium UI/UX & Deep Customization
*   **Glassmorphism Design:** 
    *   Luxurious frosted glass effect (`backdrop-filter: blur`).
    *   Customizable opacity and saturation.
*   **12+ Themes:** 
    *   AMOLED (pure #000000).
    *   Cyberpunk.
    *   Matrix.
    *   Neon.
    *   Dracula.
    *   Nord.
    *   Ice.
    *   Sunset.
*   **Custom SVG Icons:** 
    *   77+ scalable SVG icons replacing all system emojis.
    *   Inherit the theme's color palette.
    *   Feature a glowing halo and pulse on hover.
*   **Custom Cursor:** 
    *   A sleek, themed vector arrow.
    *   Neon pink in Cyberpunk, green in Matrix, white in AMOLED.
    *   Glowing hand effect over buttons.
*   **Motion System:** 
    *   Ripple effects on clicks.
    *   Staggered list entrances.
    *   Spring modals and toasts.
    *   Shimmer skeletons.
    *   Typewriter effect for incoming messages.
    *   Falling snow particles.
    *   Respects `prefers-reduced-motion`.
*   **Responsive Layouts:** 
    *   Desktop: 3 columns (Menu, Chat List, Chat Window).
    *   Tablet: 2 columns.
    *   Mobile: 1 column, bottom navigation, safe-area insets, swipe gestures.
*   **Installable PWA:** 
    *   Add to home screen on iOS/Android.
    *   Works as a standalone app without browser UI.

#### 👑 Exclusive Owner Features
*   **Owner Badge:** 
    *   A golden, glowing crown/checkmark.
    *   Visible next to the creator's username.
*   **Panic Button:** 
    *   Instantly wipes local cache.
    *   Clears tokens and logs out.
*   **Super Economy Mode:** 
    *   Disables heavy animations and glassmorphism.
    *   Ensures smooth performance on low-end devices.

<br>

### 🏗️ Architecture & Deep Dive

#### NVC Pattern (Node-View-Controller)
*   **Models:** 
    *   Interact with the SQLite database.
    *   Define schemas (Users, Chats, Messages).
*   **Views:** 
    *   Static frontend files (HTML, CSS).
    *   Vanilla JS rendering logic.
*   **Controllers/Services:** 
    *   Handle business logic.
    *   Manage encryption, WebSocket routing, and API endpoints.

#### SQLite Schema (WAL Mode Enabled)
```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    public_key TEXT,
    online INTEGER DEFAULT 0,
    last_seen INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT CHECK(type IN ('private', 'group', 'saved')),
    name TEXT,
    owner_id INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    msg_type TEXT DEFAULT 'text',
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
```

#### E2EE Flow
1.  Client A generates an ECDH key pair (P-256).
2.  Client A sends its Public Key to the server.
3.  Server relays the Public Key to Client B.
4.  Client B computes a Shared Secret using its Private Key and Client A's Public Key.
5.  Messages are encrypted locally using AES-256-GCM.
6.  The payload `{iv, ciphertext}` is sent to the server.
7.  The server saves only this ciphertext to SQLite.

<br>

### 🛠️ Tech Stack
*   **Backend:** 
    *   Node.js
    *   Express.js
    *   WebSockets (ws)
    *   SQLite (better-sqlite3)
*   **Frontend:** 
    *   Vanilla JavaScript
    *   HTML5
    *   CSS3 (Glassmorphism)
*   **Crypto:** 
    *   Web Crypto API
*   **DevOps:** 
    *   PM2
    *   Cloudflare Tunnel
    *   Docker

<br>

### 📁 Project Structure
```text
CipherTalk/
├── ciphertalk-server/
│   ├── server.js                 # Entry point
│   ├── src/
│   │   ├── app.js               # Express setup
│   │   ├── config/              # Env parser
│   │   ├── db/                  # SQLite & migrations
│   │   ├── models/              # User, Chat, Message
│   │   ├── services/            # Encryption, WebSockets, SMS
│   │   ├── controllers/         # Auth, Profile, Chat logic
│   │   ├── routes/              # Express routes
│   │   └── middleware/          # JWT auth, Multer
│   ├── public/                  # Frontend (app.js, index.html)
│   │   ├── motion.css           # Animation engine
│   │   ├── cursor.css           # Custom cursor
│   │   ├── icons.js             # SVG sprites
│   │   └── layout.css           # Responsive grids
│   └── tests/                   # Jest & Integration tests
```

<br>

### 🚀 Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk/ciphertalk-server

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env

# 4. Start the server
npm run dev
```

<br>

### 📡 API Endpoints

#### `POST /api/auth/register`
```json
{
  "phone": "+79001234567",
  "firstName": "Ivan",
  "lastName": "Ivanov",
  "username": "ivan_coder",
  "password": "StrongPassword123"
}
```
Response:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsIn...",
  "user": {
    "id": 1,
    "username": "ivan_coder"
  }
}
```

#### `POST /api/auth/send-code`
```json
{
  "phone": "+79001234567"
}
```

#### `GET /api/chats/:userId`
```json
{
  "chats": [
    {
      "id": 1,
      "type": "private",
      "last_message": "CTV1:iv:tag:ciphertext...",
      "updated_at": 1770000000
    }
  ]
}
```

<br>

### 🧪 Proof of Work (Test Logs)

**Integration Tests (`npm run test:integration`):**
```text
[TEST] Registration UserA... OK
[TEST] Registration UserB... OK
[TEST] ECDH Key Exchange... OK
[TEST] Chat Creation... OK
[TEST] Send E2EE Message... OK
[TEST] DB Check: plaintext in db: false
--- RESULT: 56 TESTS PASSED, 0 FAILED ---
```

**Security Tests (`npm run test:security`):**
```text
[SEC] Rate Limit (10 attempts)... OK (Blocked after 5)
[SEC] JWT Forgery... OK (401 Unauthorized)
[SEC] IDOR (Access other's chat)... OK (403 Forbidden)
--- RESULT: 25 TESTS PASSED, 0 FAILED ---
```

<br>

### ⚠️ Known Limitations
*   **Browser-bound Keys:** E2EE private keys are in `localStorage`. Clearing browser data loses access to old messages.
*   **TURN Server:** P2P calls use public STUN. Symmetric NAT (mobile networks) requires a TURN server.
*   **Educational Purpose:** Built for portfolio/learning. Audited protocols (Signal) are recommended for production.

<br>

### 🗺️ Roadmap
- [x] **v2.0** — NVC architecture, Group chats, Username.
- [x] **v2.1** — Real E2EE (ECDH P-256 + AES-256-GCM).
- [x] **v2.2** — JWT Authentication.
- [x] **v3.0** — SQLite Database (WAL mode).
- [x] **v3.1** — Docker Support.
- [x] **v4.0** — PWA, Custom Cursor, SVG Icons, 12+ Themes.
- [x] **v4.1** — Voice Messages, Video Circles, Owner Badge.
- [x] **v5.0** — WebRTC Audio/Video Calls.
- [ ] **v5.1** — PostgreSQL support.
- [ ] **v5.2** — Multi-device (key sync).
- [ ] **v5.3** — Native Apps (React Native).
- [ ] **v6.0** — AI assistant for chat summaries.

<br>
<br>
<br>

---

## 🇷🇺 РУССКАЯ ВЕРСИЯ

<br>

### 📖 Введение

**CipherTalk** (или просто **"Кипяток"**) — это легковесный, ультра-безопасный мессенджер со сквозным шифрованием (E2EE). Построен на современной NVC-архитектуре (Node-View-Controller) и оптимизирован для развертывания на личных серверах, VPS и одноплатных компьютерах (SBC). Проект обладает премиальным, гибко настраиваемым интерфейсом, способным конкурировать с топовыми коммерческими аналогами.

Философия CipherTalk проста: ваши чаты должны быть горячими, быстрыми и никогда не остывать. Сервер спроектирован как «слепой» — он физически не может прочитать ваши сообщения. Всё шифрование и расшифровка происходят на стороне клиента.

<br>

### 📊 Статистика и Пруфы

*   **Объем кода:** ~193 765 строк (включая зависимости, конфиги, локализации и стили).
*   **Последнее мега-обновление:** 58 файлов изменено, 11 504 строки добавлено, 750 удалено.
*   **Миграция БД:** 100% успешный переход с JSON на SQLite (WAL).
*   **Тесты:** 100% Passed (12 наборов, 250+ проверок).
*   **Безопасность:** Сервер хранит только шифротекст (подтверждено автотестами).

<br>

### ✨ Возможности

#### 🔐 Безопасность и Приватность (Слепой сервер)
*   **Бескомпромиссное E2EE:** 
    *   ECDH (P-256) для обмена ключами.
    *   AES-256-GCM с уникальным IV для каждого сообщения.
    *   Сервер хранит только зашифрованные байты.
*   **JWT-сессии:** 
    *   Безопасные токены (HMAC-SHA256).
    *   Отзыв токенов на сервере при выходе.
*   **SQLite + WAL:** 
    *   Режим Write-Ahead Logging предотвращает блокировки.
    *   Высокая производительность при одновременной записи.
*   **Коды безопасности (Safety Numbers):** 
    *   60-значный код для сверки ключей.
    *   Защита от MITM-атак.
*   **Приватность:** 
    *   PIN-код на вход.
    *   Режим «Призрак» (скрытие онлайна и галочек прочтения).
    *   Защита от скриншотов.

#### 💬 Обмен сообщениями и Медиа
*   **Доставка в реальном времени:** 
    *   Мгновенные сообщения через WebSocket.
    *   Без дублей и потерь.
    *   Синхронизация между вкладками.
*   **Действия с сообщениями:** 
    *   Ответы с цитатой (Reply).
    *   Пересылка (Forward).
    *   Редактирование (Edit).
    *   Удаление у себя / у всех (Delete).
    *   Закрепление (Pin).
    *   Эмодзи-реакции.
*   **Медиа:** 
    *   Файлы до 50 МБ.
    *   Фото (с красивой заглушкой при потере).
    *   Голосовые сообщения (MediaRecorder).
    *   Видео-кружки.
    *   Анимированные SVG-стикеры.
*   **Звонки (WebRTC):** 
    *   Полноценные P2P аудио- и видеозвонки.
    *   Защищены протоколом DTLS-SRTP.
    *   Медиа не проходит через сервер.
*   **Статусы:** 
    *   Индикатор «Печатает...».
    *   Онлайн/Оффлайн.
    *   Время последнего визита.

#### 🎨 Премиальный UI/UX и Глубокая Кастомизация
*   **Glassmorphism:** 
    *   Эффект матового стекла (`backdrop-filter: blur`).
    *   Настройка прозрачности и насыщенности.
*   **12+ Тем:** 
    *   AMOLED (чистый #000000).
    *   Киберпанк.
    *   Матрица.
    *   Неон.
    *   Dracula.
    *   Nord.
    *   Ледяная.
    *   Закат.
*   **Кастомные SVG-иконки:** 
    *   77+ векторных иконок.
    *   Заменяют все эмодзи.
    *   Меняют цвет под тему, имеют свечение.
*   **Кастомный курсор:** 
    *   Векторная стрелка.
    *   Неоновая в Киберпанке, зеленая в Матрице.
    *   Светящаяся рука над кнопками.
*   **Анимации (Motion System):** 
    *   Ripple-эффект при нажатии.
    *   Каскадное появление списков.
    *   Пружинные модалки.
    *   Скелетоны загрузки.
    *   Эффект «печатной машинки».
    *   Падающие снежинки.
    *   Учитывает `prefers-reduced-motion`.
*   **Адаптив (Mobile First):** 
    *   ПК: 3 колонки.
    *   Планшет: 2 колонки.
    *   Телефон: 1 колонка, нижняя навигация, Safe Area.
    *   Свайпы: вправо = ответ, долгое нажатие = меню.
*   **Устанавливаемое PWA:** 
    *   Добавление на главный экран.
    *   Запуск как нативного приложения.
<br>

### 🏗️ Архитектура и Технические Детали

#### Паттерн NVC (Node-View-Controller)
*   **Models (Модели):** 
    *   Взаимодействуют с базой данных SQLite.
    *   Определяют схемы (Пользователи, Чаты, Сообщения).
*   **Views (Представления):** 
    *   Статические файлы фронтенда (HTML, CSS).
    *   Логика рендеринга на Vanilla JS.
*   **Controllers/Services (Контроллеры/Сервисы):** 
    *   Обрабатывают бизнес-логику.
    *   Шифрование, WebSocket, API.

#### Схема Базы Данных (SQLite + WAL)
```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    public_key TEXT,
    online INTEGER DEFAULT 0,
    last_seen INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT CHECK(type IN ('private', 'group', 'saved')),
    name TEXT,
    owner_id INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    msg_type TEXT DEFAULT 'text',
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
```

#### Схема Шифрования (E2EE)
1.  Клиент А генерирует пару ключей ECDH.
2.  Клиент А отправляет свой публичный ключ на сервер.
3.  Сервер пересылает его Клиенту Б.
4.  Клиент Б вычисляет общий секрет (Shared Secret).
5.  Сообщения шифруются локально (AES-256-GCM).
6.  Отправляется JSON `{iv, ciphertext}`.
7.  Сервер сохраняет только этот шифротекст в БД.

<br>

### 🛠️ Стек технологий
*   **Бэкенд:** 
    *   Node.js
    *   Express
    *   WebSockets (ws)
    *   SQLite (better-sqlite3)
*   **Фронтенд:** 
    *   Vanilla JavaScript
    *   HTML5
    *   CSS3 (Glassmorphism)
*   **Криптография:** 
    *   Web Crypto API
*   **DevOps:** 
    *   PM2
    *   Cloudflare Tunnel
    *   Docker

<br>

### 📁 Структура проекта
```text
CipherTalk/
├── ciphertalk-server/
│   ├── server.js                 # Точка входа
│   ├── src/
│   │   ├── app.js               # Настройка Express
│   │   ├── config/              # Парсер .env
│   │   ├── db/                  # SQLite и миграции
│   │   ├── models/              # User, Chat, Message
│   │   ├── services/            # Encryption, WebSockets, SMS
│   │   ├── controllers/         # Логика Auth, Profile, Chat
│   │   ├── routes/              # Маршруты Express
│   │   └── middleware/          # JWT проверка, Multer
│   ├── public/                  # Клиентская часть
│   │   ├── motion.css           # Движок анимаций
│   │   ├── cursor.css           # Кастомный курсор
│   │   ├── icons.js             # SVG-иконки
│   │   └── layout.css           # Адаптивная сетка
│   └── tests/                   # Jest и Интеграционные тесты
```

<br>

### 🚀 Быстрый старт

```bash
# 1. Клонируем репозиторий
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk/ciphertalk-server

# 2. Устанавливаем зависимости
npm install

# 3. Настраиваем окружение
cp .env.example .env

# 4. Запускаем сервер
npm run dev
```

<br>

### 📡 API Endpoints

#### `POST /api/auth/register`
```json
{
  "phone": "+79001234567",
  "firstName": "Иван",
  "lastName": "Иванов",
  "username": "ivan_coder",
  "password": "StrongPassword123"
}
```
Response:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsIn...",
  "user": {
    "id": 1,
    "username": "ivan_coder"
  }
}
```

#### `POST /api/auth/send-code`
```json
{
  "phone": "+79001234567"
}
```

#### `GET /api/chats/:userId`
```json
{
  "chats": [
    {
      "id": 1,
      "type": "private",
      "last_message": "CTV1:iv:tag:ciphertext...",
      "updated_at": 1770000000
    }
  ]
}
```

<br>

### 🧪 Пруфы (Логи тестов)

**Интеграционные тесты (`npm run test:integration`):**
```text
[TEST] Регистрация UserA... OK
[TEST] Регистрация UserB... OK
[TEST] Обмен ключами ECDH... OK
[TEST] Создание чата... OK
[TEST] Отправка E2EE сообщения... OK
[TEST] Проверка БД: plaintext in db: false
--- ИТОГ: 56 ТЕСТОВ ПРОЙДЕНО, 0 ОШИБОК ---
```

**Тесты безопасности (`npm run test:security`):**
```text
[SEC] Rate Limit (10 попыток)... OK (Блок после 5)
[SEC] Подделка JWT... OK (401 Unauthorized)
[SEC] Доступ к чужому чату (IDOR)... OK (403 Forbidden)
--- ИТОГ: 25 ТЕСТОВ ПРОЙДЕНО, 0 ОШИБОК ---
```

<br>

### ⚠️ Известные ограничения
*   **Ключи в браузере:** 
    *   Приватные ключи в `localStorage`.
    *   Очистка кэша = потеря доступа к старым сообщениям.
*   **TURN-сервер для звонков:** 
    *   P2P-звонки используют STUN.
    *   Мобильные сети (NAT) требуют TURN-сервер.
*   **Учебный проект:** 
    *   Создан в образовательных целях.
    *   Для критических данных используйте Signal Protocol.

<br>

### 🗺️ Roadmap
- [x] **v2.0** — NVC архитектура, Групповые чаты, Username.
- [x] **v2.1** — Настоящее E2EE (ECDH P-256 + AES-256-GCM).
- [x] **v2.2** — JWT Аутентификация.
- [x] **v3.0** — База данных SQLite с режимом WAL.
- [x] **v3.1** — Поддержка Docker.
- [x] **v4.0** — PWA, Кастомный курсор, SVG-иконки, 12+ тем.
- [x] **v4.1** — Голосовые сообщения, Видео-кружки, Галочка Владельца.
- [x] **v5.0** — Аудио/Видеозвонки (WebRTC).
- [ ] **v5.1** — Поддержка PostgreSQL.
- [ ] **v5.2** — Мультидевайс (синхронизация ключей).
- [ ] **v5.3** — Нативные приложения (React Native).
- [ ] **v6.0** — AI-ассистент для пересказа чатов.

<br>
<br>
<br>

---

<div align="center">

### ⭐ Support the Project / Поддержи проект

Если тебе нравится CipherTalk, поставь звезду на GitHub! Это мотивирует на дальнейшую разработку.
If you like CipherTalk, give it a star on GitHub! It motivates further development.

<br>

[⭐ Star this repo](https://github.com/SkobkaStudio/CipherTalk)
[🐛 Report a bug](https://github.com/SkobkaStudio/CipherTalk/issues)
[💡 Request a feature](https://github.com/SkobkaStudio/CipherTalk/issues)

<br>

<b>Made with ☕ and 🔐 for the self-hosted and privacy-focused community</b>
<b>Сделано с ☕ и 🔐 для сообщества self-hosted энтузиастов</b>

</div>
```
