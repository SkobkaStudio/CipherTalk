# CipherTalk

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20%2B%20SQLCipher-lightgrey.svg)](https://www.sqlite.org/)
[![E2EE](https://img.shields.io/badge/E2EE-P--256%20%2B%20AES--256--GCM-red.svg)](https://github.com/SkobkaStudio/CipherTalk)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P%20DTLS--SRTP-purple.svg)](https://webrtc.org/)
[![PWA](https://img.shields.io/badge/PWA-Ready-orange.svg)](https://web.dev/progressive-web-apps/)
[![Tests](https://img.shields.io/badge/Tests-325%2B%20assertions-brightgreen.svg)](#proof-of-work-test-results)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](ciphertalk-server/package.json)

> **End-to-end encrypted messenger with NVC architecture, P2P calls, and privacy-first design.**  
> **Мессенджер с end-to-end шифрованием, P2P-звонками и максимальным упором на конфиденциальность.**

---

## Table of Contents / Содержание

- [English](#english)
  - [Overview](#overview)
  - [Features](#features)
  - [Architecture](#architecture)
  - [Tech Stack](#tech-stack)
  - [Project Structure](#project-structure)
  - [Detailed Installation & Setup Guide (Linux & Windows)](#detailed-installation--setup-guide-linux--windows)
  - [Configuration (.env)](#configuration-env)
  - [Running the Server](#running-the-server)
  - [Using CipherTalk (User Guide)](#using-ciphertalk-user-guide)
  - [E2EE Technical Details](#e2ee-technical-details)
  - [API Reference](#api-reference)
  - [WebSocket Events](#websocket-events)
  - [Testing](#testing)
  - [Deployment (Docker, Tunnel)](#deployment-docker-tunnel)
  - [Troubleshooting](#troubleshooting)
- [Русский](#русский)
  - [Обзор](#обзор)
  - [Возможности](#возможности)
  - [Архитектура](#архитектура-1)
  - [Стек технологий](#стек-технологий)
  - [Структура проекта](#структура-проекта)
  - [Подробная инструкция по установке и запуску (Linux и Windows)](#подробная-инструкция-по-установке-и-запуску-linux-и-windows)
  - [Настройка конфигурации (.env)](#настройка-конфигурации-env)
  - [Запуск сервера](#запуск-сервера)
  - [Использование CipherTalk (руководство пользователя)](#использование-ciphertalk-руководство-пользователя)
  - [E2EE — технические детали](#e2ee--технические-детали)
  - [API-справочник](#api-справочник)
  - [События WebSocket](#события-websocket)
  - [Тестирование](#тестирование)
  - [Деплой (Docker, туннель)](#деплой-docker-туннель)
  - [Устранение неполадок](#устранение-неполадок)
- [Proof of Work: Test Results](#proof-of-work-test-results)
- [License](#license)

---


## English

### Overview

CipherTalk is a privacy-focused, end-to-end encrypted messenger. All private messages are encrypted client-side using the Web Crypto API with ECDH P-256, AES-256-GCM, HKDF-SHA256, per-message keys, and directional ratchet chains (forward secrecy). The server is "blind" — it cannot read message contents and only stores encrypted payloads (`encrypted_content`, `iv`, `header`), metadata required for delivery, and wrapped group keys.

**Project Info:** Version 2.0.0 | NVC Architecture | SQLite WAL + SQLCipher at-rest encryption | P2P WebRTC calls | PWA-ready

### Features

#### Security & E2EE
- **Direct E2EE**: ECDH P-256 exchange → shared secret → HKDF root → separate send/recv chains. Each message derives a unique message key; chain ratchet forward. Skipped keys cached (up to 1000) for out-of-order delivery.
- **AAD binding**: Encryption authenticated data binds ciphertext to `chatId|header` to prevent cross-chat replay.
- **Group E2EE**: Random 32-byte group key, per-member ECDH+AES-GCM wrapping. Server stores only wrapped blobs.
- **File encryption**: Per-file key derived via HKDF with random salt, AES-256-GCM.
- **Safety Numbers**: 60-digit verification for key authenticity.
- **Key rotation**: Public key updates handled with session re-establishment.
- **SQLCipher at-rest**: DB file encrypted; key in `<db>.dbkey` (mode 0600). Fail-closed if key missing/corrupted.
- **App-layer encryption**: AES-256-GCM + scrypt for sensitive data; keys generated/stored securely.
- **Passwords**: PBKDF2-SHA512 (100000 iterations), constant-time compare, legacy migration supported.
- **JWT sessions**: HMAC-SHA256, token hash stored, revocable on logout.
- **Phone masking** in WS snapshots.
- **No Math.random for secrets** — uses `crypto.randomBytes/randomInt`.

#### Messaging
- Private, group, saved messages (Favorites)
- Replies, forwarding (re-encrypted to target), reactions, edit, delete-for-all, pin
- Typing indicators, read receipts
- Folders, hide/clear chats, member management
- Message expiry, file sharing up to 50 MB (encrypted)

#### Calls
- P2P Audio/Video via WebRTC (DTLS-SRTP)
- STUN (default Google) + TURN with time-limited HMAC-SHA1 credentials (secret never sent to client)
- Access-controlled signaling, busy/unavailable handling
- Authenticated `/api/ice-servers`

#### UI/UX
- Themes: Cyberpunk/Matrix/AMOLED
- 77-icon SVG sprite, theme-colored with glow
- Motion system (ripple/stagger/springs/shimmers) respecting `prefers-reduced-motion`
- Incremental rendering, pagination (`beforeId`), decrypted preview cache
- Responsive: Desktop (3-col), Tablet (2-col), Phone (1-col + bottom nav + safe areas + bottom sheets)
- Custom vector cursor (auto-disabled on touch)
- i18n RU/EN
- PWA + Service Worker
- Typography customization
- Public URL + QR on login/settings

#### Infra
- NVC, modular services, `.env` config
- Docker/Docker Compose
- Cloudflare Tunnel scripts
- Graceful shutdown, auto JSON→SQLite migration, WAL

### Architecture
- **Backend**: Express, `ws`, `better-sqlite3-multiple-ciphers`
- **Models**: User, Chat, Message, File, Session, VerificationCode
- **Controllers**: auth, profile, chat
- **Services**: encryptionService, dbEncryptionService, smsService, websocketService, presenceService, sessionService, iceService, tunnelService, qrService, messageExpiry
- **Middleware**: auth, security, upload
- **Client**: `app.js`, `e2ee.js`, `calls.js`, `chat-features.js`, `motion.js`, `cursor.js`, `icons.js`, `i18n.js`, `sw.js`

### Tech Stack
**Backend:** Node.js, Express 4.18, ws 8.14, better-sqlite3-multiple-ciphers 13.0.3, crypto, multer 2.4, qrcode-generator  
**Frontend:** Vanilla JS/HTML/CSS, Web Crypto API  
**Testing:** Jest 29.6 + custom Node scripts  
**DevOps:** dotenv, Docker

### Project Structure
```
CipherTalk/
├── ciphertalk-server/        # Main server app
│   ├── server.js             # Entry
│   ├── package.json
│   ├── src/                  # app, config, db, models, controllers, routes, middleware, services
│   ├── public/               # Client files
│   ├── tests/                # Test suites
│   ├── scripts/              # tunnel/migrate scripts
│   └── bin/                  # cloudflared
├── README.md
├── LICENSE
└── docker-compose.yml
```

### Detailed Installation & Setup Guide (Linux & Windows)

#### Prerequisites
- **Node.js 18+ (LTS recommended)**: [nodejs.org](https://nodejs.org/)
- **Git**: [git-scm.com](https://git-scm.com/) (or download ZIP)
- **OS**: Linux (Ubuntu/Debian/Armbian) or Windows 10/11

#### Step 1: Get the project
**Linux/macOS (terminal):**
```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk/ciphertalk-server
```

**Windows - Git Bash / Terminal:**
```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk\ciphertalk-server
```

**Windows - ZIP:**
1. Download ZIP from GitHub
2. Extract to folder (e.g., `C:\Projects\CipherTalk\`)
3. Open `CipherTalk\ciphertalk-server` folder

#### Step 2: Open terminal in correct directory
**Linux:** `cd` into `ciphertalk-server`
**Windows CMD:** In Explorer go to `ciphertalk-server`, type `cmd` in address bar → Enter
**Windows PowerShell:** Right-click → Open in Terminal (or `Shift+Right-click` → Open PowerShell here)
**Windows Terminal/Git Bash:** Same as above

#### Step 3: Install dependencies
```bash
npm install
```
> On Windows, if native modules (`better-sqlite3-multiple-ciphers`) fail to build, use Node.js LTS 20.x and ensure build tools are available (usually automatic with recent Node). On most systems it builds fine.

#### Step 4: Configure environment
```bash
# Linux/macOS
cp .env.example .env

# Windows CMD
copy .env.example .env

# Windows PowerShell
Copy-Item .env.example .env -ErrorAction SilentlyContinue
```
Edit `.env` with your editor (`nano`, `vim`, `notepad`, `VS Code`).

#### Step 5: Start server
```bash
npm start
```
On first run keys/DB are created automatically.

#### Step 6: Open in browser
Go to [http://localhost:3000](http://localhost:3000)

### Configuration (.env)

Key variables (see `.env.example` for full list):

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `DB_FILE` | `./ciphertalk-db.json` | Base name; SQLite becomes `.sqlite` |
| `DB_ENCRYPTION` | `true` | SQLCipher at-rest |
| `DB_KEY_FILE` | `<DB_FILE>.dbkey` | Key file (mode 0600) |
| `UPLOADS_DIR` | `./uploads` | Upload directory |
| `MAX_FILE_SIZE` | `52428800` | 50MB hard-capped |
| `JWT_SECRET` | auto | Auto-generated to `<DB_FILE>.jwt-secret` if empty |
| `ENCRYPTION_KEY` | auto | App-layer key; auto-generated to `<DB_FILE>.key` if empty |
| `TRUST_PROXY` | - | Set if behind reverse proxy (e.g. `1`) |
| `CORS_ORIGIN` | - | Comma list or empty for same-origin only |
| `SMS_PROVIDER` | `console` | `console` \| `http` \| `twilio` |
| `SMS_CONSOLE_ALLOW` | `false` | Allow codes in logs in prod (tests only) |
| `STUN_URLS` | Google STUN | Comma-separated |
| `TURN_URL` | - | e.g. `turn:host:3478?transport=udp` |
| `TURN_SECRET` | - | coturn static-auth-secret |
| `TURN_USERNAME`/`TURN_CREDENTIAL` | - | Static fallback |
| `OWNER_PHONE` | `+79039952506` | Owner badge |
| `CODE_EXPIRY_MINUTES` | `5` | OTP expiry |
| `PASSWORD_MIN_LENGTH` | `6` | Min password |
| `USERNAME_MIN_LENGTH` | `3` | Min username |

### Running the Server

```bash
# Production
npm start

# Development with auto-restart
npm run dev

# Stop: Ctrl+C (graceful shutdown)
```

**First run creates:**
- `ciphertalk-db.sqlite` (+ `-wal`, `-shm` during use)
- `ciphertalk-db.json.dbkey` (0600)
- `ciphertalk-db.json.jwt-secret` (0600)
- `ciphertalk-db.json.key` (0600)
- `uploads/`

### Using CipherTalk (User Guide)

#### Registration/Login
1. Open [http://localhost:3000](http://localhost:3000)
2. Register with phone/username/password or use OTP login (if SMS configured; in dev `console` shows code)
3. Complete profile if desired

#### Chats
- **New chat**: Find user → start private chat (E2EE session auto-established)
- **Groups**: Create group, add members
- **Saved Messages**: Access personal notes
- **Folders**: Organize chats
- **Replies/Forward/Reactions**: Use context menu
- **Files**: Attach files (encrypted)

#### Calls
- Click call/video call in chat
- Grant mic/camera permissions
- Uses P2P; if direct fails configure TURN

#### Settings
- **Appearance**: Theme, custom cursor, typography, motion
- **Privacy**: Hide online status
- **Security**: Sessions, logout
- **Public Access**: View tunnel URL/QR (if tunnel running)
- **Language**: RU/EN

#### Safety Numbers
Compare 60-digit safety number with contact to verify keys.

### E2EE Technical Details

**Direct session:**
1. Identity ECDH P-256 keypairs (client)
2. `shared = ECDH(privA, pubB)`
3. `salt = SHA256(sorted(pubA,pubB).join('|'))`
4. `root = HKDF(shared,salt,"CT-v1|root")`
5. `chain1 = HKDF(root,salt,"CT-v1|chain-1")`, `chain2 = HKDF(root,salt,"CT-v1|chain-2")` → assigned by key order
6. Per message: `mk = HMAC(chain,"CT-v1|mk")`, `msgKey = HKDF(mk,rand16,"CT-v1|msg")`, `chain = HMAC(chain,"CT-v1|next")`
7. AES-256-GCM, IV 12 bytes, AAD `context|header`

**Group:** 32-byte key generated by creator, wrapped per member via ECDH+AES-GCM.

**Files:** `fileKey = HKDF(sessionFileKey, salt, "CT-v1|file")`, AES-256-GCM.

### API Reference

| Endpoint | Method | Auth | Description |
| --- | --- | --- | --- |
| `/api/health` | GET | No | Status, counts, publicUrl |
| `/api/public-url` | GET | No | Tunnel info |
| `/api/public-url/qr.svg` | GET | No | QR of public URL |
| `/api/auth/*` | POST | No | Register/login/OTP |
| `/api/me`, `/api/profile/*` | GET/PUT | Yes | Profile |
| `/api/users/search` | GET | Yes | Search users |
| `/api/chats/*` | Various | Yes | Chats/messages/folders/pins/reactions |
| `/api/upload` | POST | Yes | File upload |
| `/api/ice-servers` | GET | Yes | ICE config |

### WebSocket Events
Real-time: `auth`, `message`, `typing`, `read`, `presence`, `call_*`, `reaction`, etc. Auth required after connect.

### Testing

```bash
cd ciphertalk-server

# Jest (smoke/e2ee/i18n)
npm test

# All custom tests
node tests/e2ee_crypto_test.js
node tests/e2ee_ratchet.test.js
node tests/e2ee_client_flow.test.js
node tests/call_signal_test.js
node tests/full_integration_test.js
node tests/security_regression_test.js
node tests/sms_provider_test.js
node tests/public_access_test.js
node tests/client_identity_scope_test.js
node tests/perf_render_test.js
node tests/responsive_cursor_test.js
node tests/icons_test.js
node tests/integration_check.js
```
All 325+ assertions pass (see Proof of Work).

### Deployment (Docker, Tunnel)

**Docker:**
```bash
docker compose up -d
# or build manually
```

**Cloudflare Tunnel:**
```bash
npm run tunnel:setup
npm run tunnel
```
Public URL/QR shown in UI.

### Troubleshooting

| Issue | Solution |
| --- | --- |
| `better-sqlite3` install fails on Windows | Use Node.js LTS 20.x, update npm, retry. On some systems need VS Build Tools (usually auto). |
| "Файл ключа БД не найден" | DB encrypted but key missing — restore `<DB_FILE>.dbkey`. Don't delete keys. |
| Can't connect from other devices | Set `TRUST_PROXY` if behind proxy; use tunnel or LAN IP. |
| WebRTC fails both sides | Configure TURN with `TURN_URL` + `TURN_SECRET`. |
| Port in use | Change `PORT` in `.env`. |
| SMS not sending | Set `SMS_PROVIDER=http` or `twilio` with creds; `console` for dev. |

---


## Русский

### Обзор
CipherTalk — конфиденциальный мессенджер с end-to-end шифрованием. Сообщения шифруются на клиенте (Web Crypto API: ECDH P-256, AES-256-GCM, HKDF-SHA256, ключи на сообщение, направленные ratchet-цепочки). Сервер «слепой» — не видит открытый текст.

### Возможности
См. полный список выше. Ключевое: E2EE личных/групповых чатов, шифрование файлов, P2P-звонки, SQLCipher, PWA, адаптив, i18n, кастомизация.

### Архитектура
NVC: Models/Controllers/Services/Routes, модульные сервисы, WebSocket, SQLite+SQLCipher.

### Стек технологий
Node.js + Express + ws + better-sqlite3-multiple-ciphers + Web Crypto API + Vanilla JS

### Структура проекта
Аналогична английской секции.

### Подробная инструкция по установке и запуску (Linux и Windows)

#### Требования
- Node.js 18+ (рекомендуется LTS) — [nodejs.org](https://nodejs.org/)
- Git — [git-scm.com](https://git-scm.com/) или ZIP
- Linux/Windows 10-11

#### Шаг 1. Скачать проект
**Linux:**
```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk/ciphertalk-server
```

**Windows (Git Bash/Terminal):**
```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk\ciphertalk-server
```

**Windows (ZIP):** Распаковать архив, открыть папку `ciphertalk-server`.

#### Шаг 2. Открыть терминал в папке
В проводнике открыть `ciphertalk-server`, в адресной строке набрать `cmd` → Enter (или `powershell`).

#### Шаг 3. Установить зависимости
```bash
npm install
```

#### Шаг 4. Настроить .env
```bash
# Linux
cp .env.example .env

# Windows CMD
copy .env.example .env

# Windows PowerShell
Copy-Item .env.example .env -ErrorAction SilentlyContinue
```
Отредактируйте `.env` под свои нужды.

#### Шаг 5. Запустить
```bash
npm start
```

#### Шаг 6. Открыть
[http://localhost:3000](http://localhost:3000)

### Настройка конфигурации (.env)
См. таблицу выше. В dev можно оставить `SMS_PROVIDER=console` — коды будут в консоли.

### Запуск сервера
```bash
npm start      # продакшен
npm run dev    # разработка с nodemon
# Стоп — Ctrl+C
```

### Использование CipherTalk (руководство пользователя)
- **Регистрация/вход** — по телефону/логину/паролю или по коду
- **Чаты** — личные, групповые, сохранённые
- **Сообщения** — ответы, пересылка, реакции, редактирование/удаление
- **Файлы** — до 50 МБ, зашифрованы
- **Звонки** — аудио/видео P2P
- **Настройки** — темы, курсор, типографика, анимации, приватность, язык
- **Безопасность** — коды безопасности для проверки ключей
- **Публичный доступ** — туннель + QR

### E2EE — технические детали
См. английский раздел выше.

### API-справочник
См. таблицу эндпоинтов выше.

### События WebSocket
Аутентификация, сообщения, набор, прочтение, присутствие, звонки.

### Тестирование
```bash
npm test  # Jest
# + отдельные скрипты из tests/
```
Все тесты проходят (325+ проверок).

### Деплой (Docker, туннель)
```bash
docker compose up -d
npm run tunnel:setup && npm run tunnel
```

### Устранение неполадок
См. таблицу выше. Ключевые: `better-sqlite3` на Windows (Node LTS 20), ключи БД не удалять, для звонков за NAT нужен TURN.

---


## Proof of Work: Test Results

All tests executed in `ciphertalk-server/`.

### 1) Jest Test Suite (`npm test`)
```text
PASS tests/e2ee.test.js
PASS tests/i18n.test.js
PASS tests/smoke.test.js
Test Suites: 3 passed, 3 total
Tests:       10 passed, 10 total
Time:        1.568 s
Ran all test suites.
```

### 2) E2EE Crypto Test
```text
=== E2EE Crypto Test ===
✓ ECDH key exchange successful
✓ AES-256 key derived
✓ All messages encrypted/decrypted successfully
✓ Each message has unique IV
=== TEST PASSED ===
```

### 3) E2EE Ratchet & Group/File Tests
```text
=== ИТОГ: passed=32, failed=0 ===
```
Covered: identity/ECDH, directed chains, per-message keys/IV, forward secrecy, out-of-order/skipped keys, AAD cross-chat protection, group wrap/unwrap, file encryption, 40-message exchange, session serialization.

### 4) E2EE Client Flow
```text
Пройдено: 13, провалено: 0
```

### 5) WebRTC Call Signaling
```text
=== ИТОГО: passed=20, failed=0 ===
```

### 6) Full Integration
```text
=== ИТОГО: passed=53, failed=0 ===
```

### 7) Security Regression
```text
=== ИТОГО: passed=25, failed=0 ===
```
Includes SQLCipher encryption, fail-closed, key permissions, WS re-auth, phone masking, busy handling.

### 8) SMS Provider
```text
=== ИТОГО: passed=17, failed=0 ===
```

### 9) Public Access/QR
```text
Публичный доступ: 19/19 проверок пройдено
```

### 10) Client Identity/Settings
```text
=== ИТОГО: passed=54, failed=0 ===
```

### 11) Performance/Motion
```text
=== ИТОГО: passed=36, failed=0 ===
```

### 12) Responsive/Cursor
```text
Адаптивность и курсор: 19/19 проверок пройдено
```

### 13) Icons
```text
=== ИТОГО: passed=25, failed=0 ===
```

**Grand Total: 325+ assertions across 13 test suites, 0 failures.**

---


## License

[MIT License](LICENSE) — Copyright (c) 2024 SkobkaStudio

---

*CipherTalk — Private. Encrypted. Yours. / Приватный. Зашифрованный. Твой.*
