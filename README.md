# CipherTalk

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20%2B%20SQLCipher-lightgrey.svg)](https://www.sqlite.org/)
[![E2EE](https://img.shields.io/badge/E2EE-P--256%20%2B%20AES--256--GCM-red.svg)](https://github.com/SkobkaStudio/CipherTalk)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P%20DTLS--SRTP-purple.svg)](https://webrtc.org/)
[![PWA](https://img.shields.io/badge/PWA-Ready-orange.svg)](https://web.dev/progressive-web-apps/)
[![Tests](https://img.shields.io/badge/Tests-325%2B%20assertions-brightgreen.svg)](#11-proof-of-work-tests)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](ciphertalk-server/package.json)

> *"Privacy is not a feature. It's a fundamental right."*  
> *"Конфиденциальность — не функция. Это базовое право."*

> **End-to-end encrypted messenger built with privacy-first principles, P2P media, and zero-knowledge architecture.**  
> **Мессенджер с сквозным шифрованием, построенный по принципу максимальной конфиденциальности и нулевого доверия к серверу.**

---

## 📑 Table of Contents / Оглавление

- [🇬🇧 ENGLISH VERSION](#-english-version)
  - [1. Introduction](#1-introduction)
  - [2. Project Statistics](#2-project-statistics)
  - [3. Core Features (Deep Dive)](#3-core-features-deep-dive)
  - [4. Architecture & Deep Dive](#4-architecture--deep-dive)
  - [5. Tech Stack (Detailed)](#5-tech-stack-detailed)
  - [6. Project Structure (Complete File Tree)](#6-project-structure-complete-file-tree)
  - [7. Detailed Installation Guide](#7-detailed-installation-guide)
  - [8. User Guide](#8-user-guide)
  - [9. API Reference (Complete)](#9-api-reference-complete)
  - [10. WebSocket Events (Complete)](#10-websocket-events-complete)
  - [11. Proof of Work (Tests)](#11-proof-of-work-tests)
  - [12. Troubleshooting (FAQ)](#12-troubleshooting-faq)
- [🇷🇺 RUSSIAN VERSION](#-russian-version)
  - [1. Введение](#1-введение)
  - [2. Статистика проекта](#2-статистика-проекта)
  - [3. Ключевые возможности (подробный обзор)](#3-ключевые-возможности-подробный-обзор)
  - [4. Архитектура и внутреннее устройство](#4-архитектура-и-внутреннее-устройство)
  - [5. Технологический стек](#5-технологический-стек)
  - [6. Структура проекта](#6-структура-проекта)
  - [7. Подробная инструкция по установке](#7-подробная-инструкция-по-установке)
  - [8. Руководство пользователя](#8-руководство-пользователя)
  - [9. API-справочник](#9-api-справочник)
  - [10. События WebSocket](#10-события-websocket)
  - [11. Доказательства работоспособности (Proof of Work)](#11-доказательства-работоспособности-proof-of-work)
  - [12. Решение проблем (FAQ)](#12-решение-проблем-faq)
- [📝 LICENSE & FOOTER](#-license--footer)

---


## 🇬🇧 ENGLISH VERSION


### 1. Introduction

**CipherTalk** is a fully functional, production-lean end-to-end encrypted (E2EE) instant messaging application. The project was engineered from the ground up with a strict "server-blind" philosophy: the server must never be able to decrypt private communications, even if fully compromised.

#### Philosophy
- **Zero-Knowledge**: Plaintext messages never leave the client unencrypted. The server stores only ciphertext, IVs, headers, and wrapped keys.
- **Forward Secrecy**: Each message uses derived keys with chain ratcheting. Past messages cannot be decrypted if current chain keys are compromised.
- **Post-Compromise Considerations**: Key rotation and per-message key derivation limit blast radius.
- **Defense in Depth**: SQLCipher at-rest, app-layer encryption, PBKDF2, JWT with revocation, security headers, fail-closed behavior.
- **User Sovereignty**: Full control over sessions, privacy settings, and self-hostable.

#### Why "CipherTalk"?
The name reflects the core mission — *ciphered conversation*. Every byte of private communication is mathematically protected using modern cryptographic primitives available in the browser (Web Crypto API) and Node.js `crypto` module.


### 2. Project Statistics

| Category | Value | Notes |
| --- | --- | --- |
| **Version** | `2.0.0` | Current release |
| **Architecture** | `NVC` (Node.js Views/Controllers) | Clean separation of concerns |
| **Backend Files** | `~40+` | Routes, controllers, services, models, middleware |
| **Frontend Files** | `18` | `app.js`, `e2ee.js`, `calls.js`, `chat-features.js`, `motion.js`, `cursor.js`, `icons.js`, `i18n.js`, `sw.js`, styles, etc. |
| **Test Suites** | `13` | Jest + custom Node.js test scripts |
| **Test Assertions** | **325+** | All passing with 0 failures |
| **Dependencies (prod)** | `10` | express, ws, better-sqlite3-multiple-ciphers, cors, dotenv, multer, qrcode-generator |
| **Dependencies (dev)** | `5` | jest, jsqr, nodemon, puppeteer-core, qrcode |
| **Supported Languages** | `RU / EN` | Full i18n coverage |
| **Supported Layouts** | `Desktop / Tablet / Phone` | Fully responsive with safe areas |
| **Themes** | `Cyberpunk / Matrix / AMOLED` | With custom cursor per theme |
| **Icons** | `77` | Themed SVG sprite, no emoji in UI |


### 3. Core Features (Deep Dive)

#### 🔐 Security (E2EE, Ratchet, SQLCipher, JWT, PBKDF2)

##### End-to-End Encryption (Direct Chats)
- **Key Exchange**: ECDH with curve `P-256` (secp256r1). Both peers derive identical shared secret.
- **Session Derivation**: `sharedSecret → HKDF-SHA256(salt, info="CT-v1|root") → rootKey`. Salt = `SHA256(sorted(pubA,pubB).join('|'))` for symmetric session regardless of initiator.
- **Directional Chains**: Root splits into `chainSend` and `chainRecv` via HKDF with different info labels. Keys differ per direction preventing reflection attacks.
- **Per-Message Keys**: For each message, `msgKey = HKDF(HMAC(chainKey, "CT-v1|mk"), randomSalt(16), "CT-v1|msg")`. After encryption, `chainKey = HMAC(chainKey, "CT-v1|next")` (symmetric ratchet).
- **Forward Secrecy**: Previous keys unrecoverable from current chain key.
- **Post-Quantum Consideration**: Currently classical ECDH P-256; architecture allows algorithm upgrade.
- **AAD**: `AES-GCM` uses Additional Authenticated Data = `${context}|${header}` binding to chat/context.
- **IV**: 96-bit random IV per encryption (`crypto.getRandomValues` / `crypto.randomBytes`).

##### Double-Ratchet Style Handling
- **Skipped Keys**: Out-of-order messages cached in `session.skipped[<n>]` up to `MAX_SKIP = 1000`.
- **Send Chain Retention**: Up to `MAX_SEND_KEYS = 300` for potential own-message verification flows.
- **Session Serialization**: Full session state (chains, counters, skipped keys) persisted encrypted/local in client.

##### Group E2EE
- **Group Key Generation**: Cryptographically random 32 bytes by group creator.
- **Key Wrapping**: For each member, derive KEK from `ECDH(creatorPriv, memberPub)`, wrap group key with `AES-256-GCM`. Store `{ wrapped, iv, nonce? }` per member.
- **Distribution**: Server relays wrapped blobs; never sees raw group key.
- **Rotation**: New group key can be generated and re-wrapped on membership changes (supported by architecture).

##### File Encryption
- **Derivation**: `fileKey = HKDF(sessionFileKey, randomSalt(16), "CT-v1|file")`
- **Encryption**: AES-256-GCM with fresh IV
- **Transport**: Encrypted blob uploaded to server; server stores encrypted file, cannot decrypt.

##### Database Encryption (SQLCipher)
- **Engine**: `better-sqlite3-multiple-ciphers`
- **Key Storage**: Separate file `<DB_FILE>.dbkey` with `0600` permissions, hex-encoded 32 bytes
- **Fail-Closed**: If key missing but encrypted DB exists → startup aborts. If key corrupted → aborts, never overwritten.
- **Migration Safety**: Plain SQLite detected when expecting encrypted → moved to backup, prevents accidental data loss
- **WAL Mode**: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`
- **Validation**: On load, verifies file header not plaintext SQLite when encryption expected

##### Application-Layer Encryption
- **Service**: `encryptionService` (AES-256-GCM, 96-bit IV, 128-bit tag)
- **Key Derivation**: `scryptSync(password/envKey, SALT='CipherTalk-at-rest', 32)` or random 32 bytes from `<DB_FILE>.key`
- **Format**: `CTV1.<ivBase64>.<tagBase64>.<ciphertextBase64>`

##### Authentication & Sessions
- **Passwords**: `pbkdf2Sync(password, salt, 100000, 64, 'sha512')` stored as `pbkdf2-sha512$iterations$salt$hash`. Legacy `salt:hash` (10000) supported.
- **Constant-Time Compare**: `crypto.timingSafeEqual` for password/hash/token comparisons
- **JWT**: HMAC-SHA256 signed tokens. Secret from `JWT_SECRET` or auto-generated to `<DB_FILE>.jwt-secret` (0600)
- **Token Storage**: Sessions table stores `token_hash = SHA256(token)`, raw token never stored
- **Revocation**: Logout deletes/revokes session server-side
- **Session TTL**: Configurable (default 30 days), cleanup job runs hourly
- **OTP**: Cryptographically random 6 digits via `crypto.randomInt`

##### Additional Security Measures
- **Phone Masking**: In WebSocket user snapshots, phone numbers masked
- **Security Headers**: Via `middleware/security.js`
- **CORS**: Restrictive by default (same-origin), configurable via `CORS_ORIGIN`
- **Upload Security**: Auth required, `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, served as `application/octet-stream`
- **Fail-Closed**: Corrupted secrets never auto-regenerated
- **Trust Proxy**: Configurable hop count


#### 💬 Messaging (Chats, Groups, Files, Replies, Reactions, Pin, Expiry)

- **Private Chats**: 1:1 with automatic E2EE session setup
- **Group Chats**: Multi-member with group key distribution
- **Saved Messages**: Personal "Favorites" chat
- **Replies**: Quote original message
- **Forwarding**: Decrypt locally, re-encrypt for target context
- **Reactions**: Per-message reactions
- **Edit/Delete**: Edit messages, delete-for-all
- **Pinning**: Pin messages in chat
- **Typing Indicators**: Real-time via WebSocket
- **Read Receipts**: Track read status
- **Folders**: Organize chats into custom folders
- **Hide/Clear**: Chat visibility management
- **Message Expiry**: Time-based expiration support
- **File Sharing**: Up to 50MB, encrypted, served securely
- **Pagination**: History loaded with `beforeId`


#### 📞 Calls (WebRTC, STUN/TURN, DTLS-SRTP)

- **P2P Media**: Direct peer connection where possible
- **Encryption**: DTLS-SRTP enforced by WebRTC
- **Signaling**: WebSocket-based, access-controlled (must share private chat)
- **STUN**: Google public STUN by default
- **TURN**: Optional, with short-lived credentials via `static-auth-secret` (HMAC-SHA1). Secret never exposed to browser
- **Credential Generation**: `username = <expiry>:<random>`, `credential = base64(HMAC-SHA1(secret, username))`
- **States**: offer/answer/candidate/end/busy/unavailable
- **Protection**: Cannot call without chat, cannot signal to ended calls, offline users get `call_unavailable`


#### 🎨 UI/UX (Glassmorphism, Themes, Custom Cursor, Motion, PWA)

- **Themes**: Cyberpunk (neon pink), Matrix (green), AMOLED (black)
- **Icon System**: 77 SVG icons in sprite, theme-colored, glow + hover pulse
- **Motion Engine**: Ripple, stagger, spring modals, shimmer skeletons, animated ticks, View Transitions API cross-fade
- **Reduced Motion**: Respects `prefers-reduced-motion`
- **Incremental Rendering**: DOM reuse, cached decrypted previews
- **Responsive Layouts**: Desktop 3-column, Tablet 2-column, Phone 1-column + bottom nav + safe-area + bottom sheets
- **Custom Cursor**: Vector arrow, theme-colored, glow, hand on interactive elements, disabled on touch
- **i18n**: Russian/English
- **PWA**: Manifest, Service Worker, installable, standalone
- **Typography**: Font selection, weight, line-height, custom fonts


#### 🛠️ Infrastructure (NVC, SQLite WAL, Docker, Cloudflare Tunnel)

- **NVC Pattern**: Models, Views (client), Controllers, Routes + Services
- **Database**: SQLite WAL with indexes, SQLCipher
- **Modular Services**: All cross-cutting concerns extracted
- **Config**: Centralized in `src/config/index.js` from `.env`
- **Uploads**: Isolated directory, auth-protected static serving with headers
- **Health**: `/api/health` endpoint
- **Graceful Shutdown**: SIGINT/SIGTERM handlers, WS stop, DB flush
- **Auto-Migration**: JSON → SQLite
- **Docker**: Dockerfile + docker-compose.yml
- **Tunnel**: Cloudflare quick/named tunnel scripts


### 4. Architecture & Deep Dive

#### NVC Pattern Diagram
```
┌─────────────────────────────────────────────────────────────────┐
│                            CLIENT (Browser)                      │
│  app.js | e2ee.js(WebCrypto) | calls.js(WebRTC) | i18n | motion │
└─────────────────────────────┬───────────────────────────────────┘
                              │ REST (JSON) + WebSocket
┌─────────────────────────────▼───────────────────────────────────┐
│                         Express App (src/app.js)                 │
│  Middleware: security, cors, auth, upload | Static: public/uploads│
└─────────────────────────────┬───────────────────────────────────┘
                              │ Routes
        ┌─────────────────────┼─────────────────────┐
      Routes              Controllers           Services
    authRoutes           authController        encryptionService
    chatRoutes           chatController        websocketService
    profileRoutes        profileController     presenceService/smsService
                              │                    sessionService/iceService
                              ▼                        │
                            Models ──────────────────┘
                              │
                              ▼
                        Database (SQLite/WAL + SQLCipher)
```

#### Complete SQL Schema

```sql
-- users
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  phone TEXT, email TEXT,
  first_name TEXT, last_name TEXT, name TEXT, username TEXT,
  password_hash TEXT,
  avatar TEXT, bio TEXT,
  public_key TEXT,        -- ECDH P-256 SPKI base64
  online INTEGER DEFAULT 0,
  last_seen INTEGER DEFAULT 0,
  hide_online INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE UNIQUE INDEX idx_users_phone ON users(phone);
CREATE UNIQUE INDEX idx_users_username ON users(username);

-- chats
CREATE TABLE chats (
  id INTEGER PRIMARY KEY,
  type TEXT,              -- 'private' | 'group' | 'saved'
  name TEXT, avatar TEXT, description TEXT,
  owner_id INTEGER,
  is_pinned INTEGER DEFAULT 0,
  is_channel INTEGER DEFAULT 0,
  folder_id INTEGER,
  created_at INTEGER, updated_at INTEGER
);

-- chat_members
CREATE TABLE chat_members (
  chat_id INTEGER, user_id INTEGER,
  role TEXT,
  joined_at INTEGER,
  last_read_message_id INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  cleared_at INTEGER DEFAULT 0,
  PRIMARY KEY(chat_id, user_id)
);
CREATE INDEX idx_chat_members_user ON chat_members(user_id);

-- messages (server-blind)
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER,
  sender_id INTEGER,
  encrypted_content TEXT, -- ciphertext
  iv TEXT,                -- base64
  header TEXT,            -- JSON metadata
  type TEXT,              -- text|file|sticker|system
  reply_to INTEGER,
  forwarded_from INTEGER,
  edited INTEGER DEFAULT 0,
  deleted_for_all INTEGER DEFAULT 0,
  deleted_by TEXT,        -- JSON array
  reactions TEXT,         -- JSON
  pinned INTEGER DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER
);
CREATE INDEX idx_messages_chat ON messages(chat_id, id);

-- sessions
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  token TEXT,             -- legacy/ref
  token_hash TEXT,        -- SHA256
  expires_at INTEGER,
  created_at INTEGER,
  last_used INTEGER,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- files
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  original_name TEXT,
  size INTEGER,
  mimetype TEXT,
  uploader_id INTEGER,
  created_at INTEGER
);

-- folders
CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  name TEXT,
  emoji TEXT,
  color TEXT,
  chat_ids TEXT,          -- JSON
  created_at INTEGER,
  updated_at INTEGER
);

-- group_keys (wrapped)
CREATE TABLE group_keys (
  chat_id INTEGER PRIMARY KEY,
  version INTEGER DEFAULT 1,
  wrapped TEXT,           -- JSON: { memberId: {wrapped,iv,...}, ... }
  created_by INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

-- verification_codes, counters (as implemented)
```

#### E2EE Mathematics (Step by Step)

**1) Identity Generation (Client)**
```javascript
const pair = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
);
// Export: publicKey = SPKI base64, privateKey = PKCS8 base64
```

**2) Direct Session**
```javascript
shared = ECDH(privA, pubB)  // 32 bytes
first = min(pubA,pubB), second = max(pubA,pubB)
salt = SHA256(textToBytes(first + '|' + second))
root = HKDF(ikm=shared, salt, info='CT-v1|root', len=32)
chain1 = HKDF(root, salt, 'CT-v1|chain-1', 32)
chain2 = HKDF(root, salt, 'CT-v1|chain-2', 32)
// Assign by pubkey order: if myPub < peerPub → send=chain1, recv=chain2
```

**3) Message Encryption**
```javascript
chainKey = currentSendChain
mk = HMAC(chainKey, 'CT-v1|mk')        // message key material
salt16 = randomBytes(16)
msgKey = HKDF(mk, salt16, 'CT-v1|msg', 32)
header = { v:1, n:sendCount, ts:Date.now(), s: bytesToB64(salt16) }
aad = textToBytes(context + '|' + JSON.stringify(header))
{iv,data} = AES-GCM.encrypt(msgKey, plaintext, iv=random12, aad)
sendChain = HMAC(chainKey, 'CT-v1|next')  // ratchet
sendCount++
```

**4) Message Decryption**
```javascript
header = JSON.parse(payload.header)
mk = HMAC(chainKey, 'CT-v1|mk')
msgKey = HKDF(mk, b64ToBytes(header.s), 'CT-v1|msg', 32)
aad = textToBytes(context + '|' + payload.header)
plaintext = AES-GCM.decrypt(msgKey, payload.iv, payload.content, aad)
chainKey = HMAC(chainKey, 'CT-v1|next')
```

**5) Group Key Wrap/Unwrap**
```javascript
// Wrap
kek = HKDF(ECDH(creatorPriv, memberPub), salt, 'CT-v1|group-wrap', 32)
wrapped = AES-GCM.encrypt(kek, groupKey32, iv)

// Unwrap
kek = HKDF(ECDH(memberPriv, creatorPub), salt, 'CT-v1|group-wrap', 32)
groupKey = AES-GCM.decrypt(kek, wrapped.iv, wrapped.data)
```

**6) File Encryption**
```javascript
salt16 = randomBytes(16)
fileKey = HKDF(sessionFileKey, salt16, 'CT-v1|file', 32)
{iv,data} = AES-GCM.encrypt(fileKey, fileBytes)
payload = { iv, data, salt: bytesToB64(salt16) }
```


### 5. Tech Stack (Detailed)

| Technology | Version | Purpose | Why |
| --- | --- | --- | --- |
| **Node.js** | 18+ | Runtime | Modern JS, built-in crypto, async I/O |
| **Express.js** | ^4.18.2 | Web framework | Minimal, flexible, battle-tested |
| **ws** | ^8.14.2 | WebSocket server | Lightweight, native WS, great for real-time |
| **better-sqlite3-multiple-ciphers** | ^13.0.3 | SQLite + SQLCipher | Fast sync API, WAL, encryption support |
| **cors** | ^2.8.5 | CORS middleware | Controlled cross-origin access |
| **dotenv** | ^16.3.1 | Env config | 12-factor config |
| **multer** | ^2.4.0 | File uploads | Multipart handling |
| **qrcode-generator** | ^2.0.4 | QR generation | SVG QR for public URL |
| **Jest** | ^29.6.1 | Testing | Unit/smoke tests |
| **jsqr** | ^1.4.0 | QR decode tests | Verify QR content |
| **puppeteer-core** | ^25.15.0 | Browser tests | UI/integration validation |
| **qrcode** | ^1.5.4 | QR utils | Test helpers |
| **nodemon** | ^3.0.1 | Dev | Auto-restart |

**Client:** Vanilla HTML5/CSS3/ES6+, Web Crypto API, Service Worker, CSS Custom Properties.


### 6. Project Structure (Complete File Tree)

```
CipherTalk/
├── LICENSE
├── README.md                    # This documentation
├── docker-compose.yml
├── do-mvc.md
├── ANALYSIS_REPORT.md
├── FINAL_REPORT.md
├── old/                         # Legacy files
└── ciphertalk-server/
    ├── server.js               # Entry point
    ├── package.json            # Scripts & deps
    ├── package-lock.json
    ├── .env                    # Environment (local)
    ├── .env.example            # Template
    ├── Dockerfile
    ├── .dockerignore
    ├── .public-url
    ├── bin/
    │   └── cloudflared         # Tunnel binary
    ├── scripts/
    │   ├── tunnel.js           # Tunnel manager
    │   ├── tunnel-setup.js     # Tunnel setup
    │   └── migrate_to_sqlite.js
    ├── src/
    │   ├── app.js              # Express app, middleware, routes, WS
    │   ├── config/
    │   │   └── index.js        # Central config
    │   ├── db/
    │   │   └── database.js     # SQLite/SQLCipher layer
    │   ├── models/
    │   │   ├── User.js
    │   │   ├── Chat.js
    │   │   ├── Message.js
    │   │   ├── File.js
    │   │   ├── Session.js
    │   │   └── VerificationCode.js
    │   ├── controllers/
    │   │   ├── authController.js
    │   │   ├── chatController.js
    │   │   └── profileController.js
    │   ├── routes/
    │   │   ├── authRoutes.js
    │   │   ├── chatRoutes.js
    │   │   └── profileRoutes.js
    │   ├── middleware/
    │   │   ├── auth.js
    │   │   ├── security.js
    │   │   └── upload.js
    │   └── services/
    │       ├── encryptionService.js
    │       ├── dbEncryptionService.js
    │       ├── smsService.js
    │       ├── websocketService.js
    │       ├── presenceService.js
    │       ├── sessionService.js
    │       ├── iceService.js
    │       ├── tunnelService.js
    │       ├── qrService.js
    │       └── messageExpiry.js
    ├── public/
    │   ├── index.html
    │   ├── app.js
    │   ├── e2ee.js              # E2EE client
    │   ├── calls.js
    │   ├── chat-features.js
    │   ├── motion.js
    │   ├── cursor.js
    │   ├── icons.js
    │   ├── i18n.js
    │   ├── sw.js
    │   ├── manifest.json
    │   ├── layout.css
    │   ├── features.css
    │   ├── motion.css
    │   ├── icons.css
    │   ├── cursor.css
    │   ├── owner.css
    │   └── icons/              # SVG icons
    ├── tests/                  # All test suites
    │   ├── e2ee.test.js
    │   ├── e2ee_crypto_test.js
    │   ├── e2ee_ratchet.test.js
    │   ├── e2ee_client_flow.test.js
    │   ├── smoke.test.js
    │   ├── full_integration_test.js
    │   ├── security_regression_test.js
    │   ├── call_signal_test.js
    │   ├── sms_provider_test.js
    │   ├── public_access_test.js
    │   ├── client_identity_scope_test.js
    │   ├── perf_render_test.js
    │   ├── responsive_cursor_test.js
    │   ├── icons_test.js
    │   ├── integration_check.js
    │   └── i18n.test.js
    └── uploads/                # Encrypted file storage
```


### 7. Detailed Installation Guide

#### Prerequisites
| Requirement | Version | Link |
| --- | --- | --- |
| **Node.js** | >= 18.0.0 (LTS recommended: 20.x) | [nodejs.org](https://nodejs.org/) |
| **npm** | >= 9.x | Bundled with Node.js |
| **Git** | Latest | [git-scm.com](https://git-scm.com/) |
| **OS** | Linux, Armbian, Windows 10/11 | — |

#### Linux / Armbian
```bash
# 1) Install Node.js (if needed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2) Clone
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk/ciphertalk-server

# 3) Install deps
npm install

# 4) Configure
cp .env.example .env
nano .env  # Edit as needed

# 5) Run
npm start
```

#### Windows (CMD)
```cmd
REM 1) Open cmd in ciphertalk-server folder (type cmd in address bar)
REM 2)
npm install
copy .env.example .env
notepad .env
npm start
```

#### Windows (PowerShell)
```powershell
npm install
Copy-Item .env.example .env -ErrorAction SilentlyContinue
notepad .env
npm start
```

#### Windows (Git Bash)
```bash
npm install
cp .env.example .env
nano .env  # or vim
npm start
```

#### Access
Open [http://localhost:3000](http://localhost:3000)


### 8. User Guide

1. **Register** - Create account with phone/username/password or OTP
2. **Find Users** - Search and start private chat (E2EE auto-initializes)
3. **Chat** - Send encrypted messages, files, reactions, replies
4. **Groups** - Create group, add members (group E2EE)
5. **Calls** - Audio/video P2P calls
6. **Safety Numbers** - Verify contacts in chat info
7. **Settings** - Themes, cursor, typography, motion, privacy, language
8. **Public Access** - View/share tunnel URL + QR if enabled


### 9. API Reference (Complete)

#### Health & Public
| Method | Endpoint | Auth | Description | Example Response |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | No | Server status | `{"status":"ok","timestamp":"...","users":N,"chats":N,"messages":N,"publicUrl":null}` |
| `GET` | `/api/public-url` | No | Tunnel info | `{"url":null,"mode":null,"updatedAt":null,"available":false}` |
| `GET` | `/api/public-url/qr.svg` | No | QR code SVG | SVG image |

#### Auth
| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/send-code` | No | Send OTP |
| `POST` | `/api/auth/verify-code` | No | Verify OTP → login token |
| `POST` | `/api/auth/login-code` | No | Exchange login token for session |
| `POST` | `/api/auth/register` | No | Register with password |
| `POST` | `/api/auth/login` | No | Login with password |
| `POST` | `/api/auth/logout` | Yes | Revoke session |

#### Profile & Users
| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/me` | Yes | Current user |
| `PUT` | `/api/profile` | Yes | Update profile |
| `GET` | `/api/users/search?q=...` | Yes | Search users |
| `POST` | `/api/profile/privacy` | Yes | Update privacy settings |

#### Chats & Messages
| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/chats` | Yes | List chats |
| `POST` | `/api/chats/private` | Yes | Create/get private chat |
| `POST` | `/api/chats/group` | Yes | Create group |
| `GET` | `/api/chats/:id/messages` | Yes | Get messages (paginated) |
| `POST` | `/api/chats/:id/messages` | Yes | Send message |
| `PUT` | `/api/messages/:id` | Yes | Edit message |
| `DELETE` | `/api/messages/:id` | Yes | Delete message |
| `POST` | `/api/messages/:id/reaction` | Yes | Add/remove reaction |
| `POST` | `/api/messages/:id/pin` | Yes | Pin/unpin |
| `POST` | `/api/chats/:id/read` | Yes | Mark read |

#### Files & ICE
| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/upload` | Yes | Upload file (multipart) |
| `GET` | `/uploads/:filename` | Yes | Download (encrypted blob) |
| `GET` | `/api/ice-servers` | Yes | WebRTC ICE config |


### 10. WebSocket Events (Complete)

**Client → Server:** `auth`, `message`, `typing`, `read`, `call_offer`, `call_answer`, `call_candidate`, `call_end`, `ping`  
**Server → Client:** `auth_ok`, `auth_error`, `message`, `typing`, `read_receipt`, `user_online`, `user_offline`, `call_offer`, `call_answer`, `call_candidate`, `call_end`, `call_busy`, `call_unavailable`, `pong`, `error`

All signaling protected by chat membership checks.


### 11. Proof of Work (Tests)

All tests run from `ciphertalk-server/`.

#### Jest
```text
PASS tests/e2ee.test.js
PASS tests/i18n.test.js
PASS tests/smoke.test.js
Test Suites: 3 passed, 3 total
Tests: 10 passed, 10 total
Time: 1.568 s
```

#### E2EE Crypto
```text
=== E2EE Crypto Test ===
✓ ECDH key exchange successful
✓ AES-256 key derived
✓ All messages encrypted/decrypted successfully
✓ Each message has unique IV
=== TEST PASSED ===
```

#### E2EE Ratchet
```text
=== ИТОГ: passed=32, failed=0 ===
```

#### E2EE Client Flow
```text
Пройдено: 13, провалено: 0
```

#### Call Signaling
```text
=== ИТОГО: passed=20, failed=0 ===
```

#### Full Integration
```text
=== ИТОГО: passed=53, failed=0 ===
```

#### Security Regression
```text
=== ИТОГО: passed=25, failed=0 ===
```

#### SMS Provider
```text
=== ИТОГО: passed=17, failed=0 ===
```

#### Public Access/QR
```text
Публичный доступ: 19/19 проверок пройдено
```

#### Client Identity/Settings
```text
=== ИТОГО: passed=54, failed=0 ===
```

#### Performance/Motion
```text
=== ИТОГО: passed=36, failed=0 ===
```

#### Responsive/Cursor
```text
Адаптивность и курсор: 19/19 проверок пройдено
```

#### Icons
```text
=== ИТОГО: passed=25, failed=0 ===
```

**GRAND TOTAL: 325+ ASSERTIONS | 13 TEST SUITES | 0 FAILURES**


### 12. Troubleshooting (FAQ)

| Problem | Cause | Solution |
| --- | --- | --- |
| `Cannot find module better-sqlite3...` | Native build failed | Use Node.js LTS 20.x, reinstall (`npm rebuild`) or reinstall deps |
| `Файл ключа БД не найден` | Missing `.dbkey` for encrypted DB | Restore key file from backup. Never delete keys |
| `Не удалось запустить... повреждённый ключ` | Corrupted key | Restore correct key or use backup DB |
| Port 3000 busy | Another process | Change `PORT` in `.env` or kill process |
| Calls don't connect behind NAT | No TURN | Configure `TURN_URL` + `TURN_SECRET` |
| Camera/mic blocked | Browser permissions | Allow in browser settings |
| Can't access from LAN | Firewall/bind | Check firewall, use correct IP; set `TRUST_PROXY` if behind proxy |
| CORS errors | Cross-origin blocked | Set `CORS_ORIGIN` or use same origin |


---


## 🇷🇺 RUSSIAN VERSION


### 1. Введение

**CipherTalk** — полнофункциональный мессенджер с end-to-end шифрованием, созданный по принципу «сервер ничего не знает». Сервер никогда не получает открытый текст приватных сообщений — только шифротекст, IV, заголовки и «завёрнутые» групповые ключи.

#### Философия
- **Нулевое доверие**: Расшифровка возможна только у получателей
- **Forward Secrecy**: Ключи обновляются, прошлые сообщения не расшифровать при компрометации текущих
- **Многоуровневая защита**: SQLCipher, прикладное шифрование, PBKDF2, JWT с отзывом
- **Самохостинг**: Полный контроль над данными
- **Приватность по умолчанию**: Минимум метаданных

#### Почему «CipherTalk»?
От слова *cipher* (шифр) — зашифрованный диалог.


### 2. Статистика проекта

| Категория | Значение | Примечание |
| --- | --- | --- |
| **Версия** | `2.0.0` | Текущий релиз |
| **Архитектура** | `NVC` | Models/Controllers/Services/Routes |
| **Тестов** | `13 наборов` | Jest + кастомные скрипты |
| **Проверок** | **325+** | Все пройдены, 0 ошибок |
| **Фронтенд-модулей** | `18` | Клиентские скрипты и стили |
| **Сервисов бэкенда** | `10` | Модульные сервисы |
| **Языки** | `RU / EN` | Полная локализация |
| **Адаптив** | `ПК/Планшет/Телефон` | С учётом safe-area |

### 3. Ключевые возможности (подробный обзор)

#### Безопасность и E2EE
- **Личные чаты**: ECDH P-256 → HKDF → направленные цепочки, ключ на сообщение, ratchet вперёд
- **AAD-привязка**: Защита от подмены между чатами
- **Группы**: Случайный групповой ключ, индивидуальная обёртка для каждого участника
- **Файлы**: Отдельное шифрование с уникальным солью
- **Коды безопасности**: Верификация ключей собеседника
- **Ротация ключей**: Обновление с переустановкой сессии
- **SQLCipher**: Шифрование БД at-rest, ключ в `.dbkey` (0600), fail-closed
- **Пароли**: PBKDF2-SHA512 100000 итераций, постоянное сравнение
- **JWT**: HMAC-SHA256, хранение хеша токена, отзыв при выходе
- **Маскирование телефонов**, строгие заголовки, fail-closed

#### Сообщения и чаты
Личные/групповые/сохранённые, ответы, пересылка, реакции, редактирование, удаление для всех, закрепление, индикатор набора, прочтение, папки, скрытие/очистка, истечение, файлы до 50 МБ.

#### Звонки
P2P WebRTC, DTLS-SRTP, STUN/TURN с временными учётными данными, контроль доступа.

#### Интерфейс
Тёмные темы, SVG-иконки, Motion-система с учётом reduced-motion, инкрементальный рендер, 3 раскладки, кастомный курсор, RU/EN, PWA.

#### Инфраструктура
NVC, SQLite WAL + SQLCipher, модульные сервисы, Docker, Cloudflare Tunnel, graceful shutdown.

### 4. Архитектура и внутреннее устройство

См. схему NVC, полную SQL-схему и математику E2EE выше.

### 5. Технологический стек
См. подробную таблицу выше.

### 6. Структура проекта
Полное дерево файлов описано выше с назначением директорий.

### 7. Подробная инструкция по установке

#### Linux/Armbian
```bash
git clone https://github.com/SkobkaStudio/CipherTalk.git
cd CipherTalk/ciphertalk-server
npm install
cp .env.example .env
npm start
```

#### Windows (CMD/PowerShell/Git Bash)
```cmd
npm install
copy .env.example .env
npm start
```
```powershell
npm install
Copy-Item .env.example .env -ErrorAction SilentlyContinue
npm start
```

Открыть http://localhost:3000

### 8. Руководство пользователя
Регистрация, поиск пользователей, чаты, группы, файлы, звонки, коды безопасности, настройки, публичный доступ.

### 9. API-справочник
Полный список эндпоинтов с описанием в английской секции.

### 10. События WebSocket
auth/message/typing/read/call_* события.

### 11. Доказательства работоспособности (Proof of Work)
Все 13 тестовых наборов пройдены успешно, **325+ проверок, 0 ошибок**. Логи приведены выше.

### 12. Решение проблем (FAQ)
Проблемы с `better-sqlite3`, ключами БД, NAT/TURN, портом, CORS — решения в таблице выше.


---


## 📝 LICENSE & FOOTER

### License
This project is licensed under the **MIT License**. See [LICENSE](LICENSE) file for details.

Copyright (c) 2026 SkobkaStudio

### Contributing
Contributions are welcome! Feel free to open issues or submit pull requests.

### Support
If you find this project useful, please consider giving it a ⭐ on GitHub!

### Final Words

> *"The best place to hide a secret is where no one expects it to be hidden — in plain sight of mathematics."*

**CipherTalk — Private. Encrypted. Yours.**  
**CipherTalk — Приватный. Зашифрованный. Твой.**

**Built with ❤️ for privacy. Engineered with 🔐 for security.**

---

*Last Updated: October 2026 | Version 2.0.0 | All tests passing ✅*
