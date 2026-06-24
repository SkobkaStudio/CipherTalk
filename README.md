<div align="center">

# ☕ CipherTalk (КипяТок)

### 🔥 Hot E2EE Messenger for Personal Servers and SBCs
### Горячий E2EE-мессенджер для персональных серверов и одноплатных ПК

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-16+-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Armbian%20%7C%20Debian%20%7C%20Ubuntu%20%7C%20Windows-blue.svg)]()
[![Encryption](https://img.shields.io/badge/E2EE-ECDH%20%2B%20AES--256--GCM-red.svg)]()
[![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS%20%2B%20Tailwind-orange.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

**[🇬🇧 English](#-english-version)** • **[🇷🇺 Русский](#-русская-версия)**

</div>

---

## 🇬🇧 English Version

**CipherTalk** (Russian: "Кипяток" = "Boiling Water") is a lightweight, ultra-secure, end-to-end encrypted (E2EE) messenger specifically optimized for quick deployments on personal servers, TV boxes, and single-board computers (SBCs) running Armbian/Debian/Ubuntu/Windows.

### 🎯 Why "CipherTalk"?

Say "CipherTalk" quickly with a Russian accent — it sounds exactly like **"Кипяток"** (boiling water). We believe your secure chats should be **hot, fast, and never cool down** (and absolutely shielded from third-party prying eyes 😉).

### ✨ Key Features

- 🔐 **Zero-Knowledge End-to-End Encryption (E2EE)** — ECDH (Elliptic Curve Diffie-Hellman P-256) is used to establish shared secrets on client devices. Messages are encrypted using **AES-256-GCM**. The server only routes and stores raw encrypted byte streams and never sees plain text or private keys.
- 👤 **Instant Registration with Usernames** — Prompts for Name, Phone, and `@username` upfront, preventing impersonation and simplifying identity discovery.
- 📱 **Adaptive Telegram-like UI** — Tailored to fit smartphones, tablets, and desktop computers seamlessly (responsive sidebar and main chat routing).
- ⚙️ **Custom Profile Settings** — Change nickname, profile bio, and choose custom avatar colors right from the client application.
- ⏰ **Real-time Status Sync** — WebSocket-powered online/offline indicator, active typing status ("typing..."), and instant multi-device session sync.
- 🗄️ **Lightweight Persistence** — User accounts, chat directories, and encrypted message logs are saved on the disk inside the `server-data/` folder as structured JSON, requiring no heavy SQL database setups.
- 📲 **Developer-Friendly OTP Verification** — 4-digit security codes are securely output directly to the server logs for easy local/production testing.

### 🛠️ Tech Stack

**Backend:**
- Node.js + Express (REST API)
- `ws` (Native WebSockets) for real-time delivery
- JSON Flat-File DB managed locally in `server-data/`

**Frontend:**
- HTML5 + CSS3 via **Tailwind CSS**
- Vanilla JavaScript (Zero frameworks for lightweight footprint)
- **Web Crypto API** (Secure native browser cryptography)
- Lucide Icons

### 🚀 Quick Start

#### 1. Prerequisites

Ensure you have Node.js and NPM installed on your machine:

```bash
sudo apt update
sudo apt install nodejs npm -y
```

#### 2. Installation

Clone this repository and install the production dependencies:

```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk
npm install
```

#### 3. Run Server

Launch the backend server:

```bash
node server.js
```

The server will boot on port **3000** (or `process.env.PORT`) and automatically create the secure `server-data/` storage directory.

#### 4. Configure Client

Make sure to check the top of the `<script>` block in `ciphertalk.html` to configure the API addresses:

```javascript
const BACKEND_URL = 'https://ciphertalk-server.cloudpub.ru'; // Or http://localhost:3000 for local testing
const WS_URL = 'wss://ciphertalk-server.cloudpub.ru';        // Or ws://localhost:3000 for local testing
```

### 📡 API & WebSocket Protocols

#### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/request-code` | Request verification code. Sends code directly to backend console. |
| `POST` | `/api/auth/verify-code` | Validates code, registers user, generates session token. |
| `GET` | `/api/users/search?q=query` | Search users globally by Name, Phone (normalized), or `@username`. |
| `POST` | `/api/profile/update` | Save active user name, username, bio, and avatar color settings. |
| `GET` | `/api/chats/history?userId=ID` | Download stored encrypted message packages for current chat. |

#### WebSocket Signals (`ws.on('message')`)

| Signal | Description |
|--------|-------------|
| `auth` | Initialize WebSocket session. |
| `key_exchange_init` | Sender transmits public JWK key to receiver. |
| `key_exchange_accept` | Receiver generates public key, computes AES shared secret, and returns key back. |
| `secure_message` | Route encrypted payload packet (including AES initialization vector `iv`). |
| `typing` | Broadcast "typing..." status. |

---

## 🇷🇺 Русская версия

**CipherTalk** (или просто **"КипяТок"**) — это легковесный, ультра-безопасный мессенджер со сквозным шифрованием (E2EE), оптимизированный для быстрого развертывания на персональных серверах, домашних ТВ-приставках и одноплатных компьютерах (SBC) под управлением Armbian/Debian/Ubuntu/Windows.

### 🎯 Почему "КипяТок"?

Если быстро произнести "CipherTalk" с русским акцентом, получится **"Кипяток"**. Потому что наши чаты должны быть **горячими, быстрыми и никогда не остывать** (а главное — быть надежно защищены от посторонних глаз 😉).

### ✨ Возможности

- 🔐 **Бескомпромиссное сквозное шифрование (E2EE)** — Общий секрет вычисляется на лету устройствами собеседников по протоколу **ECDH** (эллиптическая кривая P-256). Сами сообщения шифруются алгоритмом **AES-256-GCM**. Сервер выступает лишь в роли ретранслятора зашифрованных байт-кодов и физически не имеет доступа к текстовым данным и ключам.
- 👤 **Регистрация имени пользователя (`@username`) сразу** — Поля ввода имени, телефона и юзернейма находятся прямо на первом экране. Исключает путаницу и упрощает глобальный поиск.
- 📱 **Telegram-style мобильный интерфейс** — Полная адаптация под мобильные телефоны и планшеты (автоматическое переключение боковой панели и окна чата со стрелкой «Назад»).
- ⚙️ **Раздел «Мой Аккаунт»** — Полная настройка своего профиля: изменение имени, уникального `@username` (с проверкой на занятость на сервере), редактирование статуса «о себе» и выбор яркой палитры для аватара.
- ⏰ **Синхронизация статусов live** — Поддержка онлайна, индикатора набора текста собеседником («печатает...») и мгновенная синхронизация истории сообщений между несколькими открытыми вкладками одного пользователя.
- 🗄️ **Локальное хранение на сервере** — Аккаунты, списки открытых диалогов и истории зашифрованных сообщений автоматически сохраняются в папке `server-data/` в структурированном JSON-формате. Данные не пропадут при перезагрузке сервера!
- 📲 **Простой СМС-лог для тестов** — 4-значные коды авторизации отправляются напрямую в консоль (лог) запущенного сервера, что экономит деньги на СМС-шлюзах.

### 🛠️ Стек технологий

**Бэкенд:**
- Node.js + Express для REST API
- Модуль `ws` (WebSockets) для синхронизации в реальном времени
- Хранилище данных JSON в папке `server-data/`

**Фронтенд:**
- HTML5 + CSS3 (**Tailwind CSS**)
- Чистый JavaScript (работает молниеносно, без тяжелых фреймворков)
- **Web Crypto API** (нативное криптографическое ядро браузера)
- Набор иконок Lucide

### 🚀 Быстрый старт

#### 1. Требования

Убедитесь, что в вашей системе установлены Node.js и менеджер пакетов npm:

```bash
sudo apt update
sudo apt install nodejs npm -y
```

#### 2. Установка

Клонируйте репозиторий проекта и установите необходимые зависимости:

```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk
npm install
```

#### 3. Запуск сервера

Запустите серверную часть:

```bash
node server.js
```

Сервер запустится на порту **3000** и автоматически подготовит файловую систему в директории `server-data/` для сохранения зашифрованных чатов.

#### 4. Конфигурация клиента

В начале тегов `<script>` в файле `ciphertalk.html` вы можете переопределить переменные адреса сервера:

```javascript
const BACKEND_URL = 'https://ciphertalk-server.cloudpub.ru'; // Или локальный http://localhost:3000
const WS_URL = 'wss://ciphertalk-server.cloudpub.ru';        // Или локальный ws://localhost:3000
```

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
       [ Шифрует текст ]                                               [ Расшифровывает текст ]
       AES-256-GCM (IV + Payload) ─────────────► [ СЕРВЕР ] ──────────► AES-256-GCM (IV + Payload)
```

---

## 🤝 Contributing / Как помочь

Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.

**Current areas where help is needed:**
- 🐳 **Docker support** — `Dockerfile` + `docker-compose.yml` for one-command deployment
- 🌍 **International phone numbers** — currently only +7 is supported
- 🎨 **Logo and branding** — design a logo for CipherTalk (your name in README forever!)
- 📱 **Mobile apps** — Capacitor/React Native wrappers
- 🧪 **Tests** — unit and integration tests for backend and crypto layer

### How to contribute:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License / Лицензия

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

> **Disclaimer:** This project was created for educational and experimental purposes. For building commercial corporate communication networks, it is recommended to use audited cryptographic solutions (Signal Protocol, Matrix, etc.).

---

<div align="center">

### Made with ☕ and 🔐 for the self-hosted and privacy-focused community

**Завариваем КипяТок? 🚀**

[⭐ Star this repo](https://github.com/SkobkaStudio/CipherTalk) • [🐛 Report a bug](https://github.com/SkobkaStudio/CipherTalk/issues) • [💡 Request a feature](https://github.com/SkobkaStudio/CipherTalk/issues)

</div>