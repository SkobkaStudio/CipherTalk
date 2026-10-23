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
[![Database](https://img.shields.io/badge/Database-SQLite%20%2B%20SQLCipher-orange.svg)]()
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
- **Password Hashing** — PBKDF2 with SHA-512 (100,000 iterations) for secure password storage
- **Server Never Sees Plaintext** — Only encrypted byte streams are stored and routed

#### 👤 User Management
- **Instant Registration** — Phone + Name + @username on first screen
- **Username System** — Unique @username (like Telegram) with availability check
- **Multi-Device Sessions** — Manage active sessions across devices
- **Profile Customization** — Change name, bio, avatar, and public key

#### 💬 Messaging
- **Real-time Delivery** — WebSocket-powered instant messaging
- **Message Types** — Text, files, voice messages, animated SVG stickers
- **Message Actions** — Edit, delete, reply to messages
- **Typing Indicators** — Real-time "typing..." status
- **Online/Offline Status** — Live presence tracking with last seen
- **Themed SVG Icons** — 77 icons in one sprite, recoloured by the theme with a glowing halo and a hover pulse; no system emoji left in the interface

#### 📱 Chat Features
- **Private Chats** — One-to-one encrypted conversations
- **Group Chats** — Create groups with multiple members
- **Saved Messages** — Personal "Favorites" chat for notes
- **Chat History** — Persistent message storage with auto-save
- **File Sharing** — Upload and share encrypted files (up to 50 MB, configurable within the hard cap)
- **Audio & Video Calls** — P2P WebRTC calls; media is protected by DTLS-SRTP and never passes through the server
- **Safety Numbers** — Compare a 60-digit code with your contact to verify there is no key substitution
- **JWT Sessions** — HMAC-SHA256 signed tokens with server-side revocation on logout
- **Motion System** — Ripple, staggered lists, spring modals, shimmer skeletons, animated ticks and a View Transitions theme cross-fade (respects `prefers-reduced-motion`)
- **Incremental Rendering** — DOM nodes are reused, history is paginated with `beforeId`, previews are decrypted once and cached
- **Public Access** — The messenger is reachable from any device and network via a Cloudflare tunnel: the current address and a QR code are shown on the login screen and in settings
- **Custom Cursor** — A vector arrow in the color of the active theme (neon pink in Cyberpunk, green in Matrix, white in AMOLED) with a glowing hand over buttons; can be disabled in Settings → Appearance
- **Three Device Layouts** — Desktop (three columns), tablet (two columns, chat always visible) and phone (single column, bottom navigation, safe-area insets, bottom-sheet modals)
- **Installable PWA** — Add CipherTalk to the home screen, works as a standalone app
- **Docker Deployment** — One-command start with `docker compose up -d` and a persistent volume

#### 🏗️ Architecture
- **NVC Pattern** — Clean separation: Models, Controllers, Services, Routes
- **SQLite + SQLCipher** — WAL mode, indexes, encrypted database file at rest
- **Modular Services** — Encryption, SMS, Presence, WebSocket as separate services
- **Environment Config** — All settings via `.env` file
- **Graceful Shutdown** — Proper cleanup on SIGINT/SIGTERM

### 🛠️ Tech Stack

**Backend:**
- Node.js + Express (REST API)
- `ws` (Native WebSockets) for real-time delivery
- SQLite (better-sqlite3) with SQLCipher at-rest encryption
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
│   │   └── database.js      # SQLite database (SQLCipher)
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
DB_ENCRYPTION=true
UPLOADS_DIR=./uploads
MAX_FILE_SIZE=52428800
SAVE_INTERVAL=10000
ONLINE_PING_INTERVAL=30000
CODE_EXPIRY_MINUTES=5
PASSWORD_MIN_LENGTH=6
USERNAME_MIN_LENGTH=3
```

**Configuration options:**
- `PORT` — Server port (default: 3000)
- `DB_FILE` — legacy JSON file used as a one-time migration source; SQLite path is the same name with `.sqlite`
- `DB_ENCRYPTION` — Encrypt the SQLite file with SQLCipher (default: `true`)
- `DB_KEY_FILE` — Path to the database encryption key (default: `<DB_FILE>.dbkey`, mode `600`)
- `CORS_ORIGIN` — Comma-separated allowed origins (empty = same-origin only)
- `UPLOADS_DIR` — Directory for uploaded files
- `MAX_FILE_SIZE` — Max upload size in bytes (default: 50 MB, hard-capped)
- `JWT_SECRET` — HMAC secret for JWT (auto-generated `<DB_FILE>.jwt-secret` if empty)
- `SAVE_INTERVAL` — Auto-save interval in ms (default: 10000)
- `ONLINE_PING_INTERVAL` — Online status ping interval (default: 30000)
- `CODE_EXPIRY_MINUTES` — SMS code expiry time
- `SMS_PROVIDER` — SMS provider for verification codes: `console` (dev only), `http`, `twilio`
- `SMS_API_URL` / `SMS_API_TOKEN` — generic HTTP SMS provider (`POST {phone, code, text}`)
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` — Twilio Messages API credentials
- `SMS_CONSOLE_ALLOW` — allow printing codes to the server log in production (tests only, default `false`)
- `PASSWORD_MIN_LENGTH` — Minimum password length
- `USERNAME_MIN_LENGTH` — Minimum username length
- `STUN_URLS` — Comma-separated STUN servers (default: Google STUN)
- `TURN_URL` / `TURN_SECRET` — TURN server and its `static-auth-secret` (coturn). The server hands out short-lived TURN credentials, so the TURN password never reaches the browser
- `TURN_USERNAME` / `TURN_CREDENTIAL` — static TURN credentials (fallback)

#### WebRTC: STUN and TURN

By default the client uses public Google STUN servers. If both peers are behind
symmetric NAT, configure a TURN server (e.g. coturn):

```env
TURN_URL=turn:turn.example.com:3478?transport=udp
TURN_SECRET=your-static-auth-secret
```

`GET /api/ice-servers` (authorized only) then returns the STUN list plus a TURN
entry with **temporary** credentials: `username = <expiry>:<random>` and
`credential = base64(HMAC-SHA1(TURN_SECRET, username))` — the coturn REST API
scheme. The shared TURN secret never leaves the server, and the credentials
expire after `TURN_TTL_SECONDS` (default 3600).

#### SMS provider for verification codes

The verification code is never printed to the server log in production.

```env
# Development: print the code to the server log
SMS_PROVIDER=console

# Generic HTTP provider
SMS_PROVIDER=http
SMS_API_URL=https://sms.example.com/send
SMS_API_TOKEN=your-token

# Twilio
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_FROM=+15551234567
```

If the provider is not configured (or the request fails), `/api/send-code`
answers `503` and **no** verification code is created — the client never gets a
"code sent" message for a code nobody delivered.

#### Typography and appearance

`Settings → Typography` lets each account pick the interface font (8 presets or
a custom font stack), the message font size (12–24 px), the weight, the line
height, and whether the font applies to the whole app or only to messages.
Appearance and privacy settings are stored per account
(`ciphertalk_appearance_u<id>`); settings of the device are copied into the
account on first login. Custom font stacks are sanitized (letters, digits,
spaces, quotes and commas only) before they reach CSS.

#### Motion system and performance

`public/motion.css` + `public/motion.js` implement one animation language for
the whole app: ripple on press, staggered list entrances, spring modals and
toasts, shimmer skeletons, reaction pops, animated delivery ticks, a floating
"scroll to latest" button with an unread badge, and a theme cross-fade through
the View Transitions API. The engine is a separate file (CSP allows
`script-src 'self'` only) and respects both the in-app animation level
(`off` / `normal` / `full`) and `prefers-reduced-motion`.

Rendering is incremental instead of "rebuild everything on every event":

- the message list keeps a map of DOM nodes and only rebuilds what changed
  (reaction, edit, read receipt) — untouched messages are never re-created;
- at most 150 messages are kept in the DOM, older history is loaded lazily
  with `beforeId` pagination (`hasMore` in the `messages` payload);
- the chat list reuses its nodes and only moves them when a chat bubbles up;
- chat previews are decrypted once and cached per chat, in idle time.

#### Custom cursor and device layouts

`public/cursor.css` replaces the system pointer with a vector arrow drawn in
SVG (`cursor: url(data:image/svg+xml,...)`), so it needs no JS at render time
and is applied before the first repaint. The arrow is themed: neon pink with a
glow in Cyberpunk, green in Matrix, white in AMOLED, and a matching tint in the
other themes. Over buttons it becomes a glowing hand, over text fields the
system caret stays. Everything lives inside `@media (pointer: fine)` and turns
into `cursor: auto` on touchscreens. The switch in Settings → Appearance
(`cursor-switch`) stores its state in the account appearance settings, and
`public/cursor.js` only controls the `html[data-custom-cursor]` attribute.

`public/layout.css` provides three interface versions:

| Device | Layout |
|---|---|
| Desktop (≥1025px) | menu / chat list / chat; the message column is centred and width-limited for readability |
| Tablet (641–1024px) | chat list / chat, the chat is always visible, the menu is a slide-out panel |
| Phone (≤640px) | single column, bottom navigation (Chats / Search / Group / Profile), safe-area insets for notches, larger touch targets, modals as bottom sheets |

The current mode is written to `<html data-device>` (`phone` / `tablet` /
`desktop`) and `data-pointer` (`fine` / `coarse`).

#### SVG icon system and stickers

`public/icons.js` + `public/icons.css` replace every system emoji in the
interface with a single set of themed SVG icons:

- 77 icons are stored once in a sprite (`<symbol id="mq-i-*">`) that is inlined
  into `index.html` and reused everywhere via `<use href="#mq-i-*">`;
- icons inherit the interface colour through `currentColor`, so every theme
  repaints them automatically — Cyberpunk is neon pink (`#ff2e97`), Matrix is
  green (`#00ff41`), Neon is `#39ff14`;
- per theme there are `--mq-icon`, `--mq-icon-soft`, `--mq-icon-glow` and
  `--mq-icon-glow-strong` for the coloured halo behind an icon;
- hovering an icon triggers a short pulse (`@keyframes mqIconPulse`), which is
  switched off by `data-anim="off"` and `prefers-reduced-motion`;
- emoji that come from translations (modal titles, toasts, menu items) are
  replaced automatically with the matching icon — the replacement only runs
  inside interface chrome (`#modal-content`, `#toast-container`, `.login-box`,
  `.mobile-nav`, …), so user text and messages are never touched;
- reaction values (`👍 ❤️ 😂 …`) stay plain data on the wire, but are drawn with
  their own icons.

Stickers are real pictures, not text emoji: `Icons.STICKERS` holds eleven animated
SVG stickers (heart, thumb, rocket, ghost, robot, fire, party, cat, coffee,
skull, info). They are sent as an encrypted file with the message type `sticker`
(allowed by the server in `ALLOWED_MESSAGE_TYPES`), decrypted on the client and
rendered as `<img class="sticker-message">`.

Run the checks with:

```bash
npm run test:icons
```

#### 4. Run Server

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

Server will start on port 3000 and create:
- `ciphertalk-db.json` — Database file (encrypted at rest, format `CTVDB1.…`)
- `ciphertalk-db.json.dbkey` — Auto-generated database encryption key (mode 600) — **back it up together with the database**
- `ciphertalk-db.json.key` — Auto-generated key for OTP encryption (mode 600)
- `ciphertalk-db.json.jwt-secret` — Auto-generated JWT signing secret (mode 600)
- `uploads/` — Directory for file uploads

#### 5. Docker (optional)

```bash
cd ciphertalk-server
docker compose up -d --build
```

Data and the JWT secret are stored in the `ciphertalk-data` volume (`/data`). The app is available at `http://localhost:3000`.

#### 6. Tests

```bash
cd ciphertalk-server
npm test                # Jest: smoke, i18n parity, E2EE unit
npm run test:e2ee       # ECDH + AES-256-GCM crypto vectors
npm run test:e2ee:ratchet  # ratchet / key rotation
npm run test:e2ee:flow  # client-side E2EE flow (direct, group, media, forward)
npm run test:integration  # full server flow: OTP -> chat -> group -> media
npm run test:calls      # WebRTC signaling (offer/answer/ICE/end, busy, offline) + STUN/TURN
npm run test:client     # client identity scoping (keys/sessions/cache per account)
npm run test:security   # audit regressions (masking, CORS, re-auth, fail-closed, DB encryption)
npm run test:sms        # SMS provider (console/http/twilio, no OTP leaks in production)
npm run test:perf       # incremental rendering, pagination, motion engine
npm run test:public     # public access: tunnel state, URL parsing, QR decoding
npm run test:ui         # custom cursor behaviour and the three device layouts
```

#### Public access from any device and network

The messenger runs on your own machine, but it can be opened from any phone,
laptop or network — the address is published over a Cloudflare tunnel.

```bash
cd ciphertalk-server

# One-time: put the cloudflared binary here (any recent version works)
mkdir -p bin && cp /path/to/cloudflared bin/ && chmod +x bin/cloudflared

# Start the tunnel supervisor (keeps cloudflared alive, publishes the URL)
npm run tunnel
```

The supervisor (`scripts/tunnel.js`):

- spawns `cloudflared` and restarts it with backoff if it dies;
- parses the issued public URL and writes it to `ciphertalk-server/.public-url`
  (atomically, so the server never reads a half-written file);
- checks every 5 minutes that the tunnel still answers, and restarts it if not.

The server exposes the address on its own:

| Endpoint | Purpose |
|---|---|
| `GET /api/public-url` | current public address + mode |
| `GET /api/public-url/qr.svg` | QR code with that address (scan with a phone) |
| `GET /api/health` | health check, also includes `publicUrl` |

The client shows the address on the login screen and in **Settings → Public
access**, with a copy button and a QR code.

**Permanent address.** The default *quick* tunnel issues a random
`*.trycloudflare.com` address that changes on every restart. For a stable
address you need a Cloudflare account and a domain whose DNS is managed by
Cloudflare:

```bash
npm run tunnel:setup -- ciphertalk messenger.example.com
# opens the browser for Cloudflare authorization, creates the tunnel,
# creates the DNS record and writes ~/.cloudflared/config.yml

# then run the supervisor in named mode
TUNNEL_MODE=named TUNNEL_NAME=ciphertalk npm run tunnel
```

Notes:

- HTTPS is required — `crypto.subtle`, camera/microphone and the service
  worker only work in a secure context, so a plain HTTP public IP will not do;
- the tunnel supervisor and the server are managed by pm2 (`pm2 save`);
  for autostart after a reboot run `pm2 startup systemd` once (needs sudo);
- the public address is only an entry point — accounts, passwords and
  end-to-end encryption work exactly as on localhost.

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

### ⚠️ Known limitations

- **At-rest encryption covers the file, not the process.** The SQLite database is encrypted with SQLCipher (key in `<db>.dbkey`, mode `600`); the JWT secret lives in a separate `0600` file. The running server still decrypts rows into memory, so an attacker with code execution on the host sees plaintext.
- **Local cache is plaintext.** The browser keeps a decrypted-message cache in `localStorage` (scoped per account, `ciphertalk_plaintext_u<id>`) so history survives a reload. It is readable by anyone with access to the browser profile or device.
- **Key material is browser-bound.** The E2EE identity (private key) lives in `localStorage`; there is no device verification, no multi-device key management and no secure hardware storage.
- **Bounded key history.** A session keeps the last 300 send-chain keys, so very old messages of your own may become undecryptable after a long offline period.
- **TURN is optional.** Calls work through public STUN out of the box; peers behind symmetric NAT need a self-hosted TURN server (`TURN_URL` + `TURN_SECRET`).
- **One account per browser.** Identity is bound to the account id, so switching accounts in the same browser profile generates a fresh key pair (old history stays in the previous account's scope).
- **SMS provider required in production.** Without `SMS_PROVIDER` (http/twilio) verification codes cannot be delivered and `/api/send-code` answers `503` — codes are never printed to the server log outside development.

### 🗺️ Roadmap

- [x] **v2.0** — NVC architecture, JSON database, username system
- [x] **v2.0** — Group chats, message editing/deletion, replies
- [x] **v2.0** — Public key exchange for E2E
- [x] **v2.1** — Real E2E encryption: ECDH P-256 + AES-256-GCM + ratchet + group keys
- [x] **v2.2** — JWT authentication (HMAC-SHA256, revocation via DB token hash)
- [x] **v3.0** — SQLite database with SQLCipher at-rest encryption
- [x] **v3.1** — Docker support (`Dockerfile`, `docker-compose.yml`)
- [x] **v4.0** — Installable PWA (native React Native/Capacitor apps — planned)
- [x] **v4.1** — Voice messages
- [x] **v5.0** — Audio/video calls (WebRTC + server signaling)

### 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first.

**Current areas where help is needed:**
- 🗄️ **PostgreSQL / scaling** — Optional multi-instance storage backend
- 📱 **Native Mobile Apps** — React Native or Capacitor wrappers on top of the PWA
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
- **Хеширование паролей** — PBKDF2 с SHA-512 (100 000 итераций) для безопасного хранения
- **Сервер не видит plaintext** — Хранятся и передаются только зашифрованные байты

#### 👤 Управление пользователями
- **Мгновенная регистрация** — Телефон + Имя + @username на первом экране
- **Система username** — Уникальный @username (как в Telegram) с проверкой доступности
- **Мульти-устройства** — Управление активными сессиями
- **Настройка профиля** — Изменение имени, био, аватара и публичного ключа

#### 💬 Обмен сообщениями
- **Доставка в реальном времени** — Мгновенные сообщения через WebSocket
- **Типы сообщений** — Текст, файлы, голосовые сообщения, анимированные SVG-стикеры
- **Действия с сообщениями** — Редактирование, удаление, ответы
- **Индикаторы набора** — Статус "печатает..." в реальном времени
- **Статусы онлайн/оффлайн** — Отслеживание присутствия с последним визитом
- **Тематические SVG-иконки** — 77 иконок в одном спрайте, перекрашиваются под тему, со свечением и пульсацией при наведении; системных эмодзи в интерфейсе не осталось

#### 📱 Функции чатов
- **Приватные чаты** — Зашифрованные беседы один-на-один
- **Групповые чаты** — Создание групп с несколькими участниками
- **Избранное** — Личный чат "Сохранённые сообщения" для заметок
- **История чатов** — Постоянное хранение с автосохранением
- **Обмен файлами** — Загрузка и обмен зашифрованными файлами (до 50 МБ, настраивается в пределах жёсткого лимита)
- **Аудио- и видеозвонки** — P2P WebRTC; медиа защищено DTLS-SRTP и не проходит через сервер
- **Коды безопасности** — Сверка 60-значного кода с собеседником для проверки отсутствия подмены ключей
- **JWT-сессии** — Токены с подписью HMAC-SHA256 и отзывом на сервере при выходе
- **Motion-система** — Ripple, каскадные списки, пружинные модалки, шиммер-скелетоны, анимированные галочки и переход темы через View Transitions (учитывает `prefers-reduced-motion`)
- **Инкрементальный рендер** — DOM-узлы переиспользуются, история подгружается через `beforeId`, превью расшифровываются один раз и кэшируются
- **Публичный доступ** — Мессенджер открывается с любого устройства и из любой сети через туннель Cloudflare: актуальный адрес и QR-код показаны на экране входа и в настройках
- **Кастомный курсор** — Векторная стрелка в цвет активной темы (неоново-розовая в Киберпанке, зелёная в Матрице, белая в AMOLED) и светящаяся рука над кнопками; отключается в Настройках → Внешность
- **Три версии интерфейса** — ПК (три колонки), планшет (две колонки, чат всегда виден), телефон (одна колонка, нижняя навигация, безопасные зоны, модалки-шторки)
- **Устанавливаемое PWA** — Добавление на главный экран и запуск как отдельное приложение
- **Docker** — Запуск одной командой `docker compose up -d` с постоянным томом

#### 🏗️ Архитектура
- **NVC паттерн** — Чистое разделение: Модели, Контроллеры, Сервисы, Маршруты
- **SQLite + SQLCipher** — Режим WAL, индексы, зашифрованный файл БД на диске
- **Модульные сервисы** — Шифрование, SMS, Presence, WebSocket как отдельные сервисы
- **Конфигурация через окружение** — Все настройки через `.env` файл
- **Graceful Shutdown** — Правильное завершение при SIGINT/SIGTERM

### 🛠️ Стек технологий

**Бэкенд:**
- Node.js + Express (REST API)
- `ws` (нативные WebSocket) для доставки в реальном времени
- SQLite (better-sqlite3) с шифрованием at-rest через SQLCipher
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
│   │   └── database.js      # SQLite база (SQLCipher)
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
MAX_FILE_SIZE=52428800
SAVE_INTERVAL=10000
ONLINE_PING_INTERVAL=30000
CODE_EXPIRY_MINUTES=5
PASSWORD_MIN_LENGTH=6
USERNAME_MIN_LENGTH=3
```

**Опции конфигурации:**
- `PORT` — Порт сервера (по умолчанию: 3000)
- `DB_FILE` — путь к legacy JSON для однократной миграции; SQLite лежит рядом с тем же именем и `.sqlite`
- `DB_ENCRYPTION` — Шифровать SQLite-файл через SQLCipher (по умолчанию: `true`)
- `DB_KEY_FILE` — Путь к ключу шифрования БД (по умолчанию: `<DB_FILE>.dbkey`, права `600`)
- `CORS_ORIGIN` — Список разрешённых Origin через запятую (пусто = только same-origin)
- `UPLOADS_DIR` — Директория для загруженных файлов
- `MAX_FILE_SIZE` — Максимальный размер загрузки в байтах (по умолчанию: 50 МБ, жёсткий предел)
- `JWT_SECRET` — HMAC-секрет для JWT (если пусто, создаётся `<DB_FILE>.jwt-secret`)
- `SAVE_INTERVAL` — Интервал автосохранения в мс (по умолчанию: 10000)
- `ONLINE_PING_INTERVAL` — Интервал пинга статуса онлайн (по умолчанию: 30000)
- `CODE_EXPIRY_MINUTES` — Время жизни СМС кода
- `SMS_PROVIDER` — SMS-провайдер кодов подтверждения: `console` (только для разработки), `http`, `twilio`
- `SMS_API_URL` / `SMS_API_TOKEN` — generic HTTP-провайдер (`POST {phone, code, text}`)
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` — учётные данные Twilio Messages API
- `SMS_CONSOLE_ALLOW` — разрешить вывод кода в лог сервера в production (только для тестов, по умолчанию `false`)
- `PASSWORD_MIN_LENGTH` — Минимальная длина пароля
- `USERNAME_MIN_LENGTH` — Минимальная длина username
- `STUN_URLS` — Список STUN-серверов через запятую (по умолчанию Google STUN)
- `TURN_URL` / `TURN_SECRET` — TURN-сервер и его `static-auth-secret` (coturn). Сервер выдаёт временные учётные данные, пароль TURN в браузер не попадает
- `TURN_USERNAME` / `TURN_CREDENTIAL` — статические учётные данные TURN (запасной вариант)

#### WebRTC: STUN и TURN

По умолчанию клиент использует публичные Google STUN. Если оба участника за
symmetric NAT, настройте TURN-сервер (например, coturn):

```env
TURN_URL=turn:turn.example.com:3478?transport=udp
TURN_SECRET=your-static-auth-secret
```

Тогда `GET /api/ice-servers` (только для авторизованных) вернёт список STUN и
TURN с **временными** учётными данными: `имя = <срок>:<случайное>` и
`пароль = base64(HMAC-SHA1(TURN_SECRET, имя))` — схема REST API coturn.
Общий секрет TURN остаётся на сервере, а учётные данные истекают через
`TURN_TTL_SECONDS` (по умолчанию 3600).

#### SMS-провайдер для кодов подтверждения

В production код подтверждения **не пишется в лог сервера**.

```env
# Разработка: код выводится в лог сервера
SMS_PROVIDER=console

# Generic HTTP-провайдер
SMS_PROVIDER=http
SMS_API_URL=https://sms.example.com/send
SMS_API_TOKEN=your-token

# Twilio
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_FROM=+15551234567
```

Если провайдер не настроен (или запрос не прошёл), `/api/send-code`
отвечает `503` и код подтверждения **не создаётся** — клиент никогда не
получит «код отправлен» для кода, который никто не доставил.

#### Типографика и внешний вид

В `Настройки → Типографика` каждый аккаунт выбирает шрифт интерфейса
(8 готовых вариантов или своя цепочка шрифтов), размер текста сообщений
(12–24 px), начертание, межстрочный интервал и область применения шрифта —
всё приложение или только сообщения. Настройки вида и приватности хранятся
по аккаунтам (`ciphertalk_appearance_u<id>`); общие настройки устройства
копируются в аккаунт при первом входе. Пользовательские цепочки шрифтов
очищаются от лишних символов (только буквы, цифры, пробелы, кавычки и
запятые) до подстановки в CSS.

#### Motion-система и производительность

`public/motion.css` + `public/motion.js` — единый язык анимаций всего
приложения: ripple при нажатии, каскадное появление списков, пружинные
модальные окна и тосты, шиммер-скелетоны, поп реакций, анимированные галочки
доставки, плавающая кнопка «к последним сообщениям» со счётчиком
непрочитанных и плавный переход темы через View Transitions API. Движок
лежит в отдельном файле (CSP допускает только `script-src 'self'`) и
учитывает и уровень анимаций в настройках (`off` / `normal` / `full`), и
`prefers-reduced-motion`.

Рендер стал инкрементальным вместо «перерисовать всё на каждое событие»:

- список сообщений хранит карту DOM-узлов и пересобирает только изменившиеся
  (реакция, правка, отметка о прочтении) — нетронутые сообщения не создаются заново;
- в DOM держится не более 150 сообщений, старая история подгружается лениво
  через пагинацию `beforeId` (в ответе `messages` приходит `hasMore`);
- список чатов переиспользует узлы и только переставляет их, когда чат всплывает;
- превью чатов расшифровываются один раз, кэшируются и обновляются в свободное время.

#### Кастомный курсор и версии для устройств

`public/cursor.css` заменяет системный указатель векторной стрелкой, нарисованной
в SVG (`cursor: url(data:image/svg+xml,...)`), — без JS в момент отрисовки, поэтому
она появляется до первого кадра. Стрелка окрашивается в цвет темы: неоново-розовая
со свечением в Киберпанке, зелёная в Матрице, белая в AMOLED и с соответствующим
оттенком в остальных темах. Над кнопками она превращается в светящуюся руку, в
полях ввода остаётся системная каретка. Всё завёрнуто в `@media (pointer: fine)` и
на тач-экранах становится `cursor: auto`. Тумблер в Настройках → Внешность
(`cursor-switch`) хранит состояние в настройках внешности аккаунта, а
`public/cursor.js` только управляет атрибутом `html[data-custom-cursor]`.

`public/layout.css` даёт три версии интерфейса:

| Устройство | Раскладка |
|---|---|
| ПК (≥1025px) | меню / список чатов / чат; колонка переписки по центру и ограничена по ширине |
| Планшет (641–1024px) | список чатов / чат, чат всегда на экране, меню — выдвижная панель |
| Телефон (≤640px) | одна колонка, нижняя навигация (Чаты / Поиск / Группа / Профиль), учёт «челок», крупные цели касания, модалки-шторки снизу |

Текущий режим пишется в `<html data-device>` (`phone` / `tablet` / `desktop`)
и `data-pointer` (`fine` / `coarse`).

#### Система SVG-иконок и стикеры

`public/icons.js` + `public/icons.css` заменяют все системные эмодзи в
интерфейсе одним набором тематических SVG-иконок:

- 77 иконок хранятся один раз в спрайте (`<symbol id="mq-i-*">`), который
  встроен прямо в `index.html` и используется везде через `<use href="#mq-i-*">`;
- иконки наследуют цвет интерфейса через `currentColor`, поэтому каждая тема
  перекрашивает их сама: Киберпанк — неоново-розовая (`#ff2e97`), Матрица —
  зелёная (`#00ff41`), Неон — `#39ff14`;
- для каждой темы заданы `--mq-icon`, `--mq-icon-soft`, `--mq-icon-glow` и
  `--mq-icon-glow-strong` для цветного свечения вокруг иконки;
- при наведении иконка коротко пульсирует (`@keyframes mqIconPulse`), анимация
  отключается при `data-anim="off"` и `prefers-reduced-motion`;
- эмодзи из строк перевода (заголовки модалок, тосты, пункты меню)
  заменяются на подходящую иконку автоматически — замена работает только
  внутри служебных областей (`#modal-content`, `#toast-container`, `.login-box`,
  `.mobile-nav`, …), поэтому текст пользователя и сообщения не затрагиваются;
- значения реакций (`👍 ❤️ 😂 …`) остаются обычными данными в протоколе, но
  рисуются специальными иконками.

Стикеры — это настоящие картинки, а не текстовые смайлы: `Icons.STICKERS`
содержит одиннадцать анимированных SVG-стикеров (сердце, палец, ракета,
привидение, робот, огонь, вечеринка, кот, кофе, череп, info). Они отправляются
как зашифрованный файл с типом сообщения `sticker` (сервер разрешает его в
`ALLOWED_MESSAGE_TYPES`), расшифровываются на клиенте и рисуются как
`<img class="sticker-message">`.

Проверки запускаются так:

```bash
npm run test:icons
```

#### 4. Запуск сервера

```bash
# Продакшен
npm start

# Разработка (с автоперезагрузкой)
npm run dev
```

Сервер запустится на порту 3000 и создаст:
- `ciphertalk-db.json` — Файл базы данных (зашифрован at-rest, формат `CTVDB1.…`)
- `ciphertalk-db.json.dbkey` — Автоматический ключ шифрования БД (права 600) — **храните вместе с базой**
- `ciphertalk-db.json.key` — Автоматический ключ шифрования OTP (права 600)
- `ciphertalk-db.json.jwt-secret` — Автоматический секрет подписи JWT (права 600)
- `uploads/` — Директория для загрузок

#### 5. Docker (опционально)

```bash
cd ciphertalk-server
docker compose up -d --build
```

Данные и JWT-секрет хранятся в томе `ciphertalk-data` (`/data`). Приложение доступно на `http://localhost:3000`.

#### 6. Тесты

```bash
cd ciphertalk-server
npm test                # Jest: smoke, i18n-паритет, unit-тесты E2EE
npm run test:e2ee       # векторы ECDH + AES-256-GCM
npm run test:e2ee:ratchet  # ratchet и ротация ключей
npm run test:e2ee:flow  # клиентский сценарий E2EE (личный чат, группа, медиа, пересылка)
npm run test:integration  # полный серверный сценарий: OTP -> чат -> группа -> медиа
npm run test:calls      # WebRTC-сигналинг (offer/answer/ICE/end, занят, офлайн) + STUN/TURN
npm run test:client     # привязка клиентской идентичности к аккаунту (ключи/сессии/кэш)
npm run test:security   # регрессии аудита (маскирование, CORS, re-auth, fail-closed, шифрование БД)
npm run test:sms        # SMS-провайдер (console/http/twilio, без утечки кодов в production)
npm run test:perf       # инкрементальный рендер, пагинация, motion-движок
npm run test:public     # публичный доступ: состояние туннеля, парсинг URL, декодирование QR
npm run test:ui         # кастомный курсор и три версии раскладки
```

#### Публичный доступ с любого устройства и любой сети

Мессенджер работает на вашей машине, но открыть его можно с любого телефона,
ноутбука и из любой сети — адрес публикуется через туннель Cloudflare.

```bash
cd ciphertalk-server

# Один раз: положить бинарник cloudflared (подойдёт любая свежая версия)
mkdir -p bin && cp /path/to/cloudflared bin/ && chmod +x bin/cloudflared

# Запуск супервизора туннеля (держит cloudflared живым, публикует адрес)
npm run tunnel
```

Супервизор (`scripts/tunnel.js`):

- запускает `cloudflared` и перезапускает его с backoff, если он упал;
- вылавливает выданный публичный адрес и атомарно пишет его в
  `ciphertalk-server/.public-url` (сервер никогда не прочитает half-written файл);
- каждые 5 минут проверяет, что туннель отвечает, и перезапускает его, если нет.

Сервер отдаёт адрес сам:

| Endpoint | Назначение |
|----------|------------|
| `GET /api/public-url` | текущий публичный адрес и режим |
| `GET /api/public-url/qr.svg` | QR-код с этим адресом (сканируется телефоном) |
| `GET /api/health` | health-check, дополнительно содержит `publicUrl` |

Клиент показывает адрес на экране входа и в **Настройки → Публичный доступ**:
ссылка с кнопкой «Копировать» и QR-код.

**Постоянный адрес.** По умолчанию работает *quick*-туннель: он выдаёт
случайный адрес `*.trycloudflare.com`, который меняется при каждом перезапуске.
Для постоянного адреса нужен аккаунт Cloudflare и домен, DNS которого
обслуживает Cloudflare:

```bash
npm run tunnel:setup -- ciphertalk messenger.example.com
# откроется браузер для авторизации в Cloudflare, создаётся туннель,
# создаётся DNS-запись и пишется ~/.cloudflared/config.yml

# далее запускаем супервизор в режиме named
TUNNEL_MODE=named TUNNEL_NAME=ciphertalk npm run tunnel
```

Важно:

- HTTPS обязателен — `crypto.subtle`, камера/микрофон и service worker работают
  только в secure context, поэтому голый HTTP по публичному IP не подойдёт;
- супервизор туннеля и сервер управляются через pm2 (`pm2 save`); для
  автозапуска после перезагрузки один раз выполните `pm2 startup systemd`
  (нужен sudo);
- публичный адрес — это лишь точка входа: аккаунты, пароли и сквозное
  шифрование работают точно так же, как на localhost.

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

### ⚠️ Известные ограничения

- **Шифрование at-rest защищает файл, а не процесс.** SQLite-база шифруется через SQLCipher (ключ — в `<db>.dbkey`, права `600`), JWT-секрет лежит отдельным файлом с правами `0600`. Но работающий сервер расшифровывает строки в память, поэтому при выполнении кода на хосте plaintext всё равно доступен.
- **Локальный кэш хранится открытым текстом.** Браузер держит кэш расшифрованных сообщений в `localStorage` (отдельный scope на аккаунт, `ciphertalk_plaintext_u<id>`), чтобы история переживала перезагрузку. Его прочитает любой, у кого есть доступ к профилю браузера или устройству.
- **Ключи привязаны к браузеру.** E2EE-идентичность (приватный ключ) лежит в `localStorage`: нет подтверждения устройств, мультидевайс-менеджмента и хранения ключей в защищённом железе.
- **Ограниченная история ключей.** Сессия хранит последние 300 send-chain ключей, поэтому очень старые собственные сообщения после долгого офлайна могут стать нерасшифровываемыми.
- **TURN опционален.** Звонки из коробки идут через публичный STUN; для участников за symmetric NAT нужен свой TURN-сервер (`TURN_URL` + `TURN_SECRET`).
- **Один аккаунт на браузер.** Идентичность привязана к id аккаунта, поэтому при смене пользователя в том же профиле генерируется новая пара ключей, а старая история остаётся в scope предыдущего аккаунта.
- **В production нужен SMS-провайдер.** Без `SMS_PROVIDER` (http/twilio) код подтверждения доставить нечем и `/api/send-code` отвечает `503` — вне разработки коды не печатаются в лог сервера.

### 🗺️ Roadmap

- [x] **v2.0** — NVC архитектура, JSON база, система username
- [x] **v2.0** — Групповые чаты, редактирование/удаление сообщений, ответы
- [x] **v2.0** — Обмен публичными ключами для E2E
- [x] **v2.1** — Настоящее E2E шифрование: ECDH P-256 + AES-256-GCM + ratchet + групповые ключи
- [x] **v2.2** — JWT аутентификация (HMAC-SHA256, отзыв через хеш токена в БД)
- [x] **v3.0** — SQLite-база с шифрованием at-rest через SQLCipher
- [x] **v3.1** — Docker поддержка (`Dockerfile`, `docker-compose.yml`)
- [x] **v4.0** — Устанавливаемое PWA (нативные React Native/Capacitor — в планах)
- [x] **v4.1** — Голосовые сообщения
- [x] **v5.0** — Аудио/видеозвонки (WebRTC + серверный сигналинг)

### 🤝 Как помочь

Pull requests приветствуются! Для крупных изменений сначала откройте issue.

**Текущие задачи, где нужна помощь:**
- 🗄️ **PostgreSQL / масштабирование** — Опциональный backend для нескольких инстансов
- 📱 **Нативные мобильные приложения** — Обёртки React Native или Capacitor поверх PWA
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