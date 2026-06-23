# 🛡️ Anti-Scam Messenger Backend

![Node.js](https://img.shields.io/badge/Node.js-20.x-green)
![Platform](https://img.shields.io/badge/Platform-Armbian%20%7C%20Debian%20%7C%20Ubuntu-blue)
![Database](https://img.shields.io/badge/Database-SQLite3-lightblue)
![License](https://img.shields.io/badge/License-Educational%20Use-lightgrey)

[🇬🇧 English Version](#english-version) | [🇷🇺 Русская версия](#русская-версия)

---

<a name="english-version"></a>
## 🇬🇧 English Version

A high-performance, secure, and lightweight backend for **Anti-Scam Messenger**, specifically optimized to run on single-board computers under Armbian / Debian / Ubuntu (such as Orange Pi, Raspberry Pi, etc.).

This server is designed to handle user authentication, transmit secure end-to-end encrypted (E2EE) messages, and store encrypted media assets with minimal CPU and RAM usage.

### 🔑 Key Security & Design Features

- **End-to-End Encryption (E2EE):** The server acts strictly as a secure transport layer. All chat messages and images are encrypted on the client side using **AES-256** (CryptoJS) before transmission. The server never reads or stores raw messages.
- **Safe Password Storage:** Passwords are never stored in plain text. The backend utilizes `bcrypt` with a high salt rounds factor (12) to secure all passwords.
- **Isolated Data Directory (`server-data`):** All persistent data (the SQLite database and uploaded encrypted media files) is automatically kept inside a single, isolated folder for easy backups.
- **Smart SMS Verification:** Equipped with a built-in SMS gateway integration (`sms.ru`) for user registration. It features a free **Demo Mode** which prints verification codes directly to the terminal console during development.
- **Real-time Engine:** Built on top of native WebSockets (`ws`) to guarantee instant, real-time message delivery.
- **Low Footprint:** Powered by SQLite3, which stores all database records in a single local file without requiring heavy background database services.

### 🚀 Getting Started on Armbian

#### 1. Prerequisites
Make sure you have Node.js and npm installed on your Armbian device:
```bash
sudo apt update
sudo apt install nodejs npm -y
```

#### 2. Install Dependencies
Clone your repository, navigate to the project directory, and install the required Node.js packages:
```bash
npm install express ws sqlite3 bcrypt multer cors
```

#### 3. Configuration
Open `server.js` and configure the SMS Service:
```javascript
const SMS_CONFIG = {
  demoMode: true,            // Keep 'true' to print SMS codes in terminal for FREE testing
  apiId: 'YOUR_SMS_RU_KEY'   // Set your real apiId if you decide to enable real SMS delivery
};
```

#### 4. Run the Server
Start your server with:
```bash
node server.js
```
> The server will automatically create the `server-data/` directory, initialize `antiscam.db`, and start listening on port `3000`.

### 🛰️ API & Network Architecture

#### HTTP REST Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/request-otp` | Request a 4-digit SMS verification code |
| POST | `/api/auth/verify-otp` | Verify SMS code; returns a secure session token |
| POST | `/api/auth/register` | Finalize registration with name and password |
| POST | `/api/auth/login-password` | Fast login using phone & password |
| GET | `/api/users/find/:phone` | Find another registered user to start a chat |
| GET | `/api/messages/history/:contactPhone` | Retrieve encrypted message history with a contact |
| POST | `/api/media/upload` | Upload an encrypted image file (returns a secure URL) |
| GET | `/api/media/download/:filename` | Download a secure encrypted media file |

#### WebSocket Protocol
Client should establish a connection to `ws://your-armbian-ip:3000`.

**Authorize WebSocket Session** — send auth packet immediately after connection:
```json
{ "type": "auth", "token": "YOUR_SESSION_TOKEN" }
```

**Send Message / Media Block:**
```json
{
  "type": "message",
  "receiverPhone": "9001234567",
  "encryptedText": "U2FsdGVkX1...",
  "mediaUrl": "/api/media/download/abc...",
  "mediaType": "text"
}
```
> `mediaType` can be `'text'` or `'image'`.

---

<a name="русская-версия"></a>
## 🇷🇺 Русская версия

Высокопроизводительный, безопасный и легковесный бэкенд для проекта **Anti-Scam Messenger**, разработанный специально для одноплатных компьютеров под управлением Armbian / Debian / Ubuntu (Orange Pi, Raspberry Pi и др.).

Этот сервер предназначен для авторизации пользователей, мгновенной передачи сообщений по сквозному шифрованию (E2EE) и хранения зашифрованных медиафайлов с минимальным расходом ресурсов процессора и оперативной памяти.

### 🔑 Главные преимущества и безопасность

- **Сквозное шифрование (E2EE):** Сервер работает исключительно как защищенный транспортный узел. Сообщения и изображения шифруются на устройствах пользователей по стандарту **AES-256** (CryptoJS) до отправки. Сервер никогда не видит и не хранит переписку в открытом виде.
- **Безопасное хранение паролей:** Пароли никогда не хранятся в открытом виде. Бэкенд использует криптостойкий алгоритм `bcrypt` с солью для полной безопасности учетных записей.
- **Изолированная папка `server-data`:** Все динамические данные (база данных SQLite и зашифрованные изображения) автоматически хранятся в одной изолированной папке, что упрощает резервное копирование и перенос на другой сервер.
- **СМС-Верификация:** Поддерживает интеграцию с популярным СМС-шлюзом (`sms.ru`). Для разработки предусмотрен бесплатный **Демо-режим**, который выводит коды верификации прямо в консоль сервера.
- **Мгновенный обмен:** Работает на нативных WebSockets (`ws`) для моментальной доставки сообщений без задержек.
- **Минимум ресурсов:** Благодаря базе данных SQLite3, все записи хранятся в одном локальном файле. Нет необходимости держать запущенными тяжелые СУБД вроде MySQL или PostgreSQL.

### 🚀 Запуск на плате Armbian

#### 1. Установка окружения
Убедись, что на твоём устройстве установлены Node.js и пакетный менеджер npm:
```bash
sudo apt update
sudo apt install nodejs npm -y
```

#### 2. Установка зависимостей
Склонируй проект, перейди в папку и установи необходимые Node.js библиотеки:
```bash
npm install express ws sqlite3 bcrypt multer cors
```

#### 3. Конфигурация
Открой файл `server.js` и настрой СМС-службу:
```javascript
const SMS_CONFIG = {
  demoMode: true,            // Оставь 'true' для БЕСПЛАТНОГО вывода СМС-кодов прямо в терминал сервера
  apiId: 'YOUR_SMS_RU_KEY'   // Замени на ключ от sms.ru, если решишь включить реальную отправку СМС
};
```

#### 4. Запуск сервера
Запусти бэкенд следующей командой:
```bash
node server.js
```
> При первом старте скрипт сам создаст директорию `server-data/`, базу `antiscam.db` и запустит сервер на порту `3000`.

### 🛰️ Описание API и Протокола

#### HTTP REST Эндпоинты
| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| POST | `/api/auth/request-otp` | Запрос 4-значного СМС-кода на телефон |
| POST | `/api/auth/verify-otp` | Верификация кода; возвращает токен сессии |
| POST | `/api/auth/register` | Завершение регистрации нового аккаунта (Имя, Пароль) |
| POST | `/api/auth/login-password` | Быстрый вход по телефону и паролю |
| GET | `/api/users/find/:phone` | Поиск зарегистрированного пользователя в базе |
| GET | `/api/messages/history/:contactPhone` | Загрузка зашифрованной истории переписки |
| POST | `/api/media/upload` | Загрузка зашифрованного изображения (возвращает защищённый URL) |
| GET | `/api/media/download/:filename` | Скачивание зашифрованного медиафайла |

#### Протокол WebSocket
Клиент должен подключиться по адресу `ws://armbian-ip-адрес:3000`.

**Авторизация WebSocket сессии** — сразу после соединения отправь пакет авторизации:
```json
{ "type": "auth", "token": "ТОКЕН_СЕССИИ_ПОЛУЧЕННЫЙ_ПРИ_ВХОДЕ" }
```

**Отправка зашифрованного сообщения или картинки:**
```json
{
  "type": "message",
  "receiverPhone": "9001234567",
  "encryptedText": "U2FsdGVkX1...",
  "mediaUrl": "/api/media/download/abc...",
  "mediaType": "text"
}
```
> `mediaType` может быть `'text'` или `'image'`.

---

## 📄 License / Лицензия

This project is open-source and created for educational purposes.
Данный проект является открытым и создан исключительно в образовательных целях.