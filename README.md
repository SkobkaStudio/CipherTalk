# ☕ CipherTalk (Кипяток)

**Горячий E2EE-мессенджер для TV-боксов и одноплатных компьютеров**

🇬🇧 [English](#-english-version) | 🇷🇺 [Русский](#-русская-версия)

---

## 🇬🇧 English Version

**CipherTalk** (Russian: "Кипяток" = "Boiling Water") is a lightweight, secure client-server messenger utilizing a **hybrid end-to-end encryption (E2EE) model**. It is optimized for low-power TV boxes and single-board computers (SBCs) running Armbian/Debian/Ubuntu.

### 🎯 Why "CipherTalk"?

Say "CipherTalk" quickly with a Russian accent — it sounds exactly like "Кипяток" (boiling water). Because chats should be hot, fast, and never cool down (and definitely shouldn't leak to third parties 😉).

### 🏛️ Architecture & "The Whole Truth" (How It Actually Works)

Version 4.0 is fully built on **JSON communications via REST API and WebSockets**.

    ┌─────────────────────────┐             REST (JSON)             ┌─────────────────────────┐
    │        Client A         ├────────────────────────────────────>│      Node.js Server     │
    │  (Pure HTML5/JS/AES)    │                                     │       (Express)         │
    └────────────┬────────────┘                                     └────────────┬────────────┘
                 │                                                               │
                 │ WebSocket (JSON Frames)                                       │ Writes JSON
                 └──────────────────> [ WS Gateway ] <───────────────────────────┤ to tables
                                            │                                    ▼
                                     Updates Presence / Messages        ┌─────────────────┐
                                     (typing, uploading, online)        │ SQLite Database │
                                                                        │  (antiscam.db)  │
                                                                        └─────────────────┘

### 🛡️ The Encryption Reality (Hybrid E2EE Key Sync)

- **Message Encryption:** Messages and image Base64 strings are encrypted in the client's memory using **AES-256** (CryptoJS) before sending. The server receives only the encrypted ciphertext JSON and stores it in the `messages` table.
- **Key Storage & Escrow:** To support multi-device synchronization and prevent key loss upon browser reloads, symmetric chat keys are synced via the server. When a chat is initiated, a unique AES key is generated on the client, and sent to the server database (`chat_keys` table) using the `POST /api/keys/save` API.
- **Stateless Browser Storage:** The browser's `localStorage` is used only for storing active session credentials (`as_auth`: phone, token, name, deviceId). All chat history and symmetric keys are fetched dynamically from the server into client-side RAM upon application startup and cleared completely on logout.

### 📡 JSON REST API Reference

All requests and responses use `application/json` format. Protected endpoints require the `Authorization: Bearer <token>` header.

#### 🔑 Authentication

- `POST /api/auth/request-otp` — Request an SMS code.
  - Payload: `{ "phone": "9001234567" }` (10 digits)
- `POST /api/auth/verify-otp` — Verify SMS code.
  - Payload: `{ "phone": "9001234567", "code": "1234", "deviceId": "web_123", "deviceName": "Chrome" }`
- `POST /api/auth/register` — Register a new profile with a password.
  - Payload: `{ "phone": "9001234567", "name": "Alice", "password": "secure_pass", "deviceId": "web_123", "deviceName": "Chrome" }`
- `POST /api/auth/login-password` — Authorization via password.
  - Payload: `{ "phone": "9001234567", "password": "secure_pass", "deviceId": "web_123", "deviceName": "Chrome" }`
- `GET /api/auth/sessions` — Get a list of all active sessions/devices.
- `DELETE /api/auth/sessions/:deviceId` — Terminate/revoke a specific device session.

#### 👤 Profiles

- `GET /api/profile` — Get the current user's profile details.
- `POST /api/profile/update` — Update display name and bio.
  - Payload: `{ "name": "Alice Cooper", "bio": "Retro rock enthusiast" }`
- `POST /api/profile/avatar` — Upload custom avatar (uses `multipart/form-data`, limit 5MB).
- `GET /api/users/:phone/profile` — Get a specific contact's profile details along with their `lastSeen` status.
- `GET /api/users/find/:phone` — Lookup user by phone number.

#### 💬 Messages & Media

- `GET /api/messages/history/:contactPhone` — Retrieve the encrypted conversation history.
- `POST /api/media/upload` — Upload an encrypted binary image file (limit 15MB).
- `GET /api/media/download/:filename` — Download the raw encrypted binary file.

#### 🔑 Symmetric Key Exchange

- `POST /api/keys/save` — Save a shared chat key to the database.
  - Payload: `{ "contactPhone": "9001234567", "chatKey": "32_byte_hex_key" }`
- `GET /api/keys/all` — Fetch all symmetric chat keys assigned to your account.

### 🛰️ JSON WebSocket Protocol

WebSockets are used to handle real-time delivery and user activities.

#### 1. Authorization Frame

Must be sent immediately after opening the connection:

    {
      "type": "auth",
      "token": "YOUR_SESSION_TOKEN"
    }

#### 2. Send Message

    {
      "type": "message",
      "receiverPhone": "9001234567",
      "encryptedText": "U2FsdGVkX19H...encrypted_aes_payload...",
      "mediaUrl": "/api/media/download/abc123filename",
      "mediaType": "text"
    }

#### 3. Real-Time Indicators

**Typing Status:**

    {
      "type": "typing",
      "receiverPhone": "9001234567",
      "isTyping": true
    }

**Uploading Photo Status:**

    {
      "type": "uploading_photo",
      "receiverPhone": "9001234567",
      "isUploading": true
    }

### 🗄️ Database Schema (SQLite)

The SQLite database (`server-data/antiscam.db`) automatically initializes with 6 tables:

| Table | Description |
|-------|-------------|
| `users` | Account registration records (passwords hashed with bcrypt) |
| `otp_codes` | Temporary 4-digit SMS codes with UNIX expiration timestamps |
| `messages` | Raw encrypted message logs |
| `chat_keys` | Symmetrically shared chat keys synced between authorized devices |
| `user_sessions` | Session tokens assigned to each login/device |
| `user_activity` | Tracker for real-time presence indicators (`last_seen`, `is_online`) |

### 🚀 Developer Setup (Quick Start)

#### 1. Prerequisites

Ensure you have **Node.js (v18 or higher)** and **npm** installed.

#### 2. Installation

Clone this repository and install all node packages:

    git clone <your-repo-url>
    cd CipherTalk
    npm install

#### 3. Run

    node server.js

The server will boot on port 3000 and automatically write the structural folders in `server-data/`.

### 🤝 Contributing Guidelines

We are actively looking for contributors! Whether you want to fix a typo, optimize the UI, or refactor the backend, your help is welcome.

**How to create a Pull Request:**

1. **Fork** the repository.
2. Create a feature branch: `git checkout -b feature/amazing-feature`.
3. Commit your changes: `git commit -m 'feat: add dark mode support'`.
4. Push to the branch: `git push origin feature/amazing-feature`.
5. Open a **Pull Request** against the `main` branch.

**Code Style Requirements:**

- Keep the frontend dependency-free (Vanilla JS, pure HTML/CSS).
- Ensure any added features do not break backend SQLite autoconfiguration.
- Always sanitize manual inputs to prevent SQL Injection/XSS.

### 🛠️ Open Issues & Roadmap (Good First Issues)

| Task | Stack | Difficulty | Status |
|------|-------|------------|--------|
| 🐳 **Dockerization:** Create `Dockerfile` and `docker-compose.yml` | DevOps | 🟢 Easy | Open |
| 🎨 **Dark Theme Support:** Implement dark UI switcher using CSS variables | Front-end | 🟢 Easy | Open |
| 📞 **Global Phone Support:** Remove strict `+7` prefix requirement | Full-stack | 🟡 Medium | Open |
| 🌍 **SMS Gateway Integration:** Implement real SMS provider APIs | Back-end | 🟡 Medium | Open |
| 📦 **Media Upload Progress:** Add visual loader for file attachments | Front-end | 🟢 Easy | Open |

---

## 🇷🇺 Русская Версия

**CipherTalk** (или просто «Кипяток») — это легковесный, безопасный клиент-серверный мессенджер с **гибридной моделью сквозного шифрования (E2EE)**, специально оптимизированный для TV-боксов и одноплатных компьютеров (SBC) под управлением Armbian/Debian/Ubuntu.

### 🎯 Почему «Кипяток»?

Если быстро произнести "CipherTalk" с русским акцентом, получится «Кипяток». Потому что чаты должны быть горячими, быстрыми и никогда не остывать (и уж точно не должны утекать третьим лицам 😉).

### 🏛️ Архитектура и «Вся Правда» (Как это работает на самом деле)

Версия 4.0 полностью построена на передаче **JSON-данных через REST API и веб-сокеты**.

    ┌─────────────────────────┐             REST (JSON)             ┌─────────────────────────┐
    │         Клиент          ├────────────────────────────────────>│         Сервер          │
    │  (Pure HTML5/JS/AES)    │                                     │       (Express)         │
    └────────────┬────────────┘                                     └────────────┬────────────┘
                 │                                                               │
                 │ WebSocket (JSON-фреймы)                                       │ Пишет JSON
                 └──────────────────> [ WS Шлюз ] <──────────────────────────────┤ в таблицы
                                            │                                    ▼
                                     Обновление статусов                ┌─────────────────┐
                                     (печать, онлайн, отправка)         │   База SQLite   │
                                                                        │  (antiscam.db)  │
                                                                        └─────────────────┘

### 🛡️ Реальное положение дел с E2EE (Гибридный обмен ключами)

- **Шифрование сообщений:** Текст и Base64-код картинок шифруются в памяти браузера по алгоритму **AES-256** (CryptoJS) перед отправкой в сеть. Сервер получает исключительно зашифрованный JSON-контент и складывает его в таблицу `messages`.
- **Синхронизация ключей:** Чтобы поддержать работу на нескольких устройствах и исключить потерю доступа к чатам после перезагрузки страницы, симметричные ключи шифрования синхронизируются через сервер. При создании чата клиент генерирует ключ и сохраняет его на сервере в таблице `chat_keys` через `POST /api/keys/save`.
- **Хранение данных на клиенте:** `localStorage` браузера используется только для хранения данных текущей сессии (`as_auth`: телефон, токен, имя, deviceId). Переписка и симметричные ключи загружаются с сервера в оперативную память клиента только при входе и полностью стираются при выходе из аккаунта.

### 📡 Документация JSON REST API

Все запросы и ответы используют формат `application/json`. Защищенные запросы требуют заголовок `Authorization: Bearer <токен>`.

#### 🔑 Авторизация и регистрация

- `POST /api/auth/request-otp` — Запросить СМС-код.
  - Тело запроса: `{ "phone": "9001234567" }` (10 цифр без +7)
- `POST /api/auth/verify-otp` — Проверить СМС-код.
  - Тело запроса: `{ "phone": "9001234567", "code": "1234", "deviceId": "web_123", "deviceName": "Chrome" }`
- `POST /api/auth/register` — Регистрация нового аккаунта с паролем.
  - Тело запроса: `{ "phone": "9001234567", "name": "Иван", "password": "secure_pass", "deviceId": "web_123", "deviceName": "Chrome" }`
- `POST /api/auth/login-password` — Вход по паролю.
  - Тело запроса: `{ "phone": "9001234567", "password": "secure_pass", "deviceId": "web_123", "deviceName": "Chrome" }`
- `GET /api/auth/sessions` — Получить список всех активных сессий (устройств).
- `DELETE /api/auth/sessions/:deviceId` — Удалить сессию (разлогинить устройство).

#### 👤 Профили

- `GET /api/profile` — Получить данные своего профиля.
- `POST /api/profile/update` — Обновить отображаемое имя и био.
  - Тело запроса: `{ "name": "Иван Сидоров", "bio": "Любитель самосборного ПО" }`
- `POST /api/profile/avatar` — Загрузить аватар (`multipart/form-data`, лимит 5МБ).
- `GET /api/users/:phone/profile` — Просмотр профиля контакта с его статусом `lastSeen`.
- `GET /api/users/find/:phone` — Поиск пользователя по телефону в базе.

#### 💬 Переписка и медиа

- `GET /api/messages/history/:contactPhone` — Получить историю зашифрованной переписки.
- `POST /api/media/upload` — Загрузить зашифрованный бинарный файл изображения (лимит 15МБ).
- `GET /api/media/download/:filename` — Скачать зашифрованный файл.

#### 🔑 Обмен ключами

- `POST /api/keys/save` — Сохранить симметричный ключ чата на сервер.
  - Тело запроса: `{ "contactPhone": "9001234567", "chatKey": "32_byte_hex_key" }`
- `GET /api/keys/all` — Получить все свои симметричные ключи чатов с сервера.

### 🛰️ Протокол JSON WebSockets

Интерактивное общение и реалтайм статусы передаются в виде JSON-пакетов.

#### 1. Авторизация при подключении

Должна быть отправлена первым кадром после рукопожатия:

    {
      "type": "auth",
      "token": "ВАШ_ТОКЕН_СЕССИИ"
    }

#### 2. Отправка сообщения

    {
      "type": "message",
      "receiverPhone": "9001234567",
      "encryptedText": "U2FsdGVkX19H...зашифрованная_строка...",
      "mediaUrl": "/api/media/download/abc123filename",
      "mediaType": "text"
    }

#### 3. Статусы активности

**Печатает:**

    {
      "type": "typing",
      "receiverPhone": "9001234567",
      "isTyping": true
    }

**Загружает фото:**

    {
      "type": "uploading_photo",
      "receiverPhone": "9001234567",
      "isUploading": true
    }

### 🗄️ Схема Базы Данных SQLite

База данных SQLite (`server-data/antiscam.db`) автоматически создает 6 таблиц:

| Таблица | Описание |
|---------|----------|
| `users` | Профили пользователей (пароли хешируются через bcrypt) |
| `otp_codes` | Временные 4-значные СМС-коды с UNIX-временем истечения |
| `messages` | Зашифрованные сообщения |
| `chat_keys` | Синхронизированные симметричные ключи шифрования чатов |
| `user_sessions` | Выданные авторизационные токены устройств |
| `user_activity` | Хранилище статусов активности (`last_seen`, `is_online`) |

### 🚀 Быстрый старт для разработчиков

#### 1. Требования

Убедитесь, что установлены **Node.js (версия 18+)** и менеджер пакетов **npm**.

#### 2. Установка

Склонируйте репозиторий проекта и установите пакеты:

    git clone <your-repo-url>
    cd CipherTalk
    npm install

#### 3. Настройка СМС

По умолчанию включен демонстрационный режим (`demoMode: true`). В этом режиме СМС-коды не отправляются платно через шлюз, а пишутся напрямую в консоль сервера (терминал).

#### 4. Запуск бэкенда

    node server.js

Сервер запустится на порту 3000 и автоматически подготовит инфраструктуру базы данных в папке `server-data/`.

### 🤝 Руководство по контрибьютингу

Мы активно ищем контрибьюторов! Любая помощь — от оптимизации стилей на клиенте до рефакторинга базы на сервере — очень приветствуется.

**Как отправить Pull Request:**

1. Сделайте **Fork** репозитория.
2. Создайте ветку: `git checkout -b feature/amazing-feature`.
3. Закоммитьте: `git commit -m 'feat: add dark mode support'`.
4. Запушьте: `git push origin feature/amazing-feature`.
5. Откройте **Pull Request** в ветку `main`.

**Требования к коду:**

- Фронтенд должен оставаться чистым (Vanilla JS, без фреймворков).
- Новые фичи бэкенда не должны ломать автосоздание базы SQLite.
- Всегда валидируйте входящие данные для предотвращения SQL-инъекций и XSS.

### 🛠️ Текущие задачи и бэклог (Good First Issues)

| Задача | Стек | Сложность | Статус |
|--------|------|-----------|--------|
| 🐳 **Контейнеризация:** Написать `Dockerfile` и `docker-compose.yml` | DevOps | 🟢 Легко | Свободно |
| 🎨 **Темная тема:** Добавить переключатель ночной темы через CSS-переменные | Front-end | 🟢 Легко | Свободно |
| 📞 **Международные номера:** Убрать жесткую привязку префикса `+7` | Full-stack | 🟡 Средне | Свободно |
| 🌍 **Интеграция СМС-шлюза:** Добавить поддержку реальных провайдеров | Back-end | 🟡 Средне | Свободно |
| 📦 **Прогресс загрузки:** Добавить лоадер при отправке медиафайлов | Front-end | 🟢 Легко | Свободно |

---

## 📄 Лицензия / License

Этот проект распространяется под свободной лицензией **MIT** — см. файл `LICENSE` для подробностей.

This project is licensed under the **MIT License** — see the `LICENSE` file for details.

---

<div align="center">

**Сделано с ☕ и 🔐 для сообщества self-hosted энтузиастов**

*Made with ☕ and 🔐 for the self-hosted community*

</div>

---

## ✅ Что изменено по твоему запросу:

- ❌ **Удалены** все ссылки на GitHub (`github.com/SkobkaStudio/CipherTalk`)
- ❌ **Удалены** email (`support@skobka.studio`)
- ❌ **Удалены** упоминания Telegram
- ✅ **Заменены** на плейсхолдер `<your-repo-url>` в командах git clone
- ✅ **Исправлена** проблема с выходом из блока кода — использовал отступы вместо ``` внутри markdown
- ✅ **README написан полностью** от начала до конца

## 📋 Как сохранить:

```bash
# Создай файл
nano README.md

# Вставь весь текст ВЫШЕ (между двумя линиями ---)
# Сохрани: Ctrl+O → Enter → Ctrl+X
```