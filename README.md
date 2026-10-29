<div align="center">

# 💬 CipherTalk

**Мессенджер с реальным временем — Rust + axum + rqlite**

[![Rust](https://img.shields.io/badge/Rust-1.75%2B-000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![axum](https://img.shields.io/badge/axum-0.7-4A4AFF?style=for-the-badge)](https://github.com/tokio-rs/axum)
[![rqlite](https://img.shields.io/badge/rqlite-%E2%89%A57-00ADD8?style=for-the-badge)](https://rqlite.io)
[![License](https://img.shields.io/badge/license-MIT-a6e3a1?style=for-the-badge)](#-лицензия)

**JWT · WebSocket · MVC · тёмная тема · без сборщиков на фронте**

</div>

---

<div align="center">

| 🚀 Быстрый старт | 🧱 Стек | 📦 Размер |
|:---:|:---:|:---:|
| `./run.sh` | Rust · axum · rqlite | ~6 МБ бинарник |

</div>

---

## ✨ Возможности

<table>
<tr>
<td width="50%" valign="top">

### 🔐 Безопасность
- **argon2**-хеширование паролей
- **JWT (HS256)** на все защищённые роуты
- Параметризованные SQL-запросы — никакой конкатенации
- `textContent`, а не `innerHTML` — XSS-безопасный рендер

</td>
<td width="50%" valign="top">

### ⚡ Реальное время
- **WebSocket** через `tokio::sync::broadcast`
- Подписка на чаты с проверкой членства
- Автопереподключение при обрыве
- Мгновенная доставка всем участникам

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎨 Фронтенд
- Ванильные **HTML / CSS / JS**
- Тёмная тема, CSS-переменные
- Адаптив: десктоп + мобильный
- Без npm, React, Vite и сборщиков

</td>
<td width="50%" valign="top">

### 🧩 Архитектура
- Чистый **MVC**: models / controllers / services
- Слой БД изолирован в `db.rs`
- JWT-мидлварь отдельно
- Один бинарник, раздаёт и API, и фронт

</td>
</tr>
</table>

---

## 🧱 Стек

<table>
<tr>
<td align="center" width="120"><b>HTTP / WS</b></td>
<td><a href="https://github.com/tokio-rs/axum">axum 0.7</a> + <a href="https://tokio.rs">tokio</a> — async-сервер и WebSocket</td>
</tr>
<tr>
<td align="center"><b>База данных</b></td>
<td><a href="https://rqlite.io">rqlite</a> — распределённый SQLite через HTTP API</td>
</tr>
<tr>
<td align="center"><b>HTTP-клиент</b></td>
<td>reqwest (rustls) — запросы к rqlite</td>
</tr>
<tr>
<td align="center"><b>Авторизация</b></td>
<td>jsonwebtoken (HS256) + argon2</td>
</tr>
<tr>
<td align="center"><b>Статика</b></td>
<td>tower-http: <code>ServeDir</code>, <code>ServeFile</code>, <code>CorsLayer</code></td>
</tr>
<tr>
<td align="center"><b>Логи</b></td>
<td>tracing, tracing-subscriber</td>
</tr>
<tr>
<td align="center"><b>Фронтенд</b></td>
<td>ванильные HTML + CSS + JS, без сборщиков</td>
</tr>
</table>

---

## 📋 Требования

<table>
<tr>
<td valign="middle" width="40">🦀</td>
<td><b>Rust</b> (stable, edition 2021) и <code>cargo</code></td>
</tr>
<tr>
<td valign="middle">🐳</td>
<td><b>Docker</b> <em>или</em> бинарник <a href="https://github.com/rqlite/rqlite/releases"><code>rqlited</code></a> в <code>PATH</code></td>
</tr>
<tr>
<td valign="middle">🌐</td>
<td><b><code>curl</code></b> — для запуска и проверок</td>
</tr>
</table>

---

## 🚀 Быстрый старт

```bash
# Всё в одной команде: rqlite + сборка + сервер
./run.sh

# Открыть в браузере
# http://localhost:3000/
```

<details>
<summary><b>Что делает <code>run.sh</code> под капотом</b> (нажми, чтобы развернуть)</summary>

1. Проверяет `GET $RQLITE_URL/readyz`
2. Если rqlite не запущен — стартует контейнер `ciphertalk-rqlite` (или `rqlited`)
3. Ждёт готовности rqlite (до 30 секунд)
4. Выполняет `cargo build --release`
5. Запускает `./target/release/messenger` на `PORT` (по умолчанию `3000`)

</details>

> ⏹ **Остановить:** `Ctrl+C`.  
> 🐳 **Остановить rqlite-контейнер:** `docker rm -f ciphertalk-rqlite`.

---

## 🛠 Ручной запуск

Если `run.sh` не подходит (отладка, кастомный rqlite):

```bash
# 1. База
docker run --rm -p 4001:4001 rqlite/rqlite
#   или
rqlited -node-id 1 ./data-rqlite

# 2. Сервер (в другом терминале)
export RQLITE_URL=http://localhost:4001
export JWT_SECRET=dev-secret-change-me
export PORT=3000
cargo run --release
```

> 💡 Сервер сам создаёт таблицы при первом старте (`CREATE TABLE IF NOT EXISTS`).
> Если rqlite недоступен — сервер завершится с понятной ошибкой и подсказкой.

---

## ⚙️ Переменные окружения

<table>
<thead>
<tr>
<th>Переменная</th>
<th>По умолчанию</th>
<th>Назначение</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>PORT</code></td>
<td><code>3000</code></td>
<td>Порт HTTP-сервера (слушает <code>0.0.0.0</code>)</td>
</tr>
<tr>
<td><code>RQLITE_URL</code></td>
<td><code>http://localhost:4001</code></td>
<td>Базовый URL rqlite (без завершающего <code>/</code>)</td>
</tr>
<tr>
<td><code>JWT_SECRET</code></td>
<td><em>случайный при старте</em></td>
<td>Секрет HMAC для JWT. <b>Если не задан</b> — генерируется случайный и печатается WARN. Все токены станут недействительны после перезапуска. В проде задавать обязательно.</td>
</tr>
<tr>
<td><code>RUST_LOG</code></td>
<td><code>info</code></td>
<td>Уровень логов tracing (<code>debug</code>, <code>trace</code>, …)</td>
</tr>
</tbody>
</table>

---

## 📁 Структура проекта

```
.
├── 🦀 Cargo.toml
├── 🔒 Cargo.lock
├── 🚀 run.sh                  # единый запуск (rqlite + сервер)
├── 📖 README.md
├── src/
│   ├── main.rs                # сборка роутера, запуск
│   ├── config.rs              # PORT, RQLITE_URL, JWT_SECRET
│   ├── db.rs                  # клиент rqlite + миграции
│   ├── ws.rs                  # WebSocket + broadcast-брокер
│   ├── models/                # структуры данных (serde)
│   │   ├── mod.rs
│   │   ├── user.rs
│   │   ├── chat.rs
│   │   └── message.rs
│   ├── controllers/           # HTTP-хендлеры axum, без SQL
│   │   ├── mod.rs
│   │   ├── auth.rs
│   │   ├── chats.rs
│   │   └── messages.rs
│   ├── services/              # бизнес-логика и все SQL
│   │   ├── mod.rs
│   │   ├── auth_service.rs
│   │   └── chat_service.rs
│   ├── middleware/            # JWT-мидлварь → Extension<Claims>
│   │   └── mod.rs
│   └── utils/                 # jwt, password, error
│       ├── mod.rs
│       ├── jwt.rs
│       ├── password.rs
│       └── error.rs
└── web/                       # фронтенд, раздаётся тем же сервером
    ├── index.html
    ├── app.js
    └── style.css
```

---

## 🏛 Архитектура

<div align="center">

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (SPA)                          │
│         HTML / CSS / JS   ·   WebSocket   ·   fetch         │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP + WS
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                        axum router                          │
│  ┌───────────────┐   ┌───────────────────────────────────┐  │
│  │  middleware   │──▶│         controllers               │  │
│  │ require_auth  │   │   auth · chats · messages         │  │
│  └───────────────┘   └───────────────┬───────────────────┘  │
│                                      │                      │
│                                      ▼                      │
│                      ┌───────────────────────────────┐      │
│                      │           services            │      │
│                      │   auth_service · chat_service │      │
│                      └───────────────┬───────────────┘      │
│                                      │                      │
│              ┌───────────────────────┼───────────────────┐  │
│              ▼                       ▼                   ▼  │
│      ┌───────────────┐       ┌───────────────┐   ┌────────┐ │
│      │     db.rs     │       │     ws.rs     │   │ utils  │ │
│      │ rqlite client │       │  broadcast    │   │ jwt…   │ │
│      └───────┬───────┘       └───────┬───────┘   └────────┘ │
└──────────────┼───────────────────────┼──────────────────────┘
               │ HTTP /db/execute       │ broadcast
               ▼                       ▼
        ┌─────────────┐         ┌─────────────┐
        │   rqlite    │         │  WS-клиенты │
        │  (SQLite)   │         │  (все чаты) │
        └─────────────┘         └─────────────┘
```

</div>

### Слои

<table>
<tr>
<td align="center" width="120"><b>Models</b></td>
<td><code>src/models/</code> — только структуры с <code>serde</code> (<code>User</code>, <code>Chat</code>, <code>Message</code>) и DTO запросов/ответов. Никакой логики.</td>
</tr>
<tr>
<td align="center"><b>Controllers</b></td>
<td><code>src/controllers/</code> — HTTP-хендлеры axum. Извлекают параметры (<code>State</code>, <code>Extension&lt;Claims&gt;</code>, <code>Path</code>, <code>Query</code>, <code>Json</code>), вызывают сервисы, возвращают <code>Json</code>/<code>AppError</code>. <b>Не содержат SQL</b>.</td>
</tr>
<tr>
<td align="center"><b>Services</b></td>
<td><code>src/services/</code> — вся бизнес-логика и SQL. Валидация, проверка прав (<code>is_member</code>), публикация в WS-канал после сохранения. <b>Не знают про HTTP</b>.</td>
</tr>
<tr>
<td align="center"><b>DB</b></td>
<td><code>src/db.rs</code> — клиент rqlite. Все значения — только позиционные параметры (<code>?</code>). Здесь же миграции.</td>
</tr>
<tr>
<td align="center"><b>Middleware</b></td>
<td><code>src/middleware/mod.rs</code> — <code>require_auth</code>: проверяет <code>Bearer JWT</code>, кладёт <code>Claims</code> в <code>req.extensions_mut()</code>. Хендлеры читают через штатный <code>Extension&lt;Claims&gt;</code>.</td>
</tr>
<tr>
<td align="center"><b>WS</b></td>
<td><code>src/ws.rs</code> — <code>GET /ws?token=…</code>. Проверка токена <em>до</em> апгрейда, split на read/write, фильтрация <code>broadcast::Receiver&lt;Message&gt;</code> по <code>chat_id</code>.</td>
</tr>
</table>

### 🔄 Поток отправки сообщения

```
POST /api/chats/:id/messages
  │
  ├─▶ middleware::require_auth          (Claims → extensions)
  ├─▶ controllers::messages::send
  ├─▶ services::chat_service            (is_member → save_message)
  ├─▶ db.rs                             (exec_params → rqlite)
  ├─▶ state.tx.send(msg)                (broadcast всем WS-клиентам)
  └─▶ 200 OK + JSON клиенту
```

---

## 🌐 HTTP API

Все ответы — JSON. Ошибки — `{ "error": "текст" }` с корректным статусом.

### 🟢 Публичные (без JWT)

<table>
<thead>
<tr><th>Метод</th><th>Путь</th><th>Тело</th><th>Ответ</th></tr>
</thead>
<tbody>
<tr>
<td align="center"><code>GET</code></td>
<td><code>/healthz</code></td>
<td>—</td>
<td><code>ok</code> (plain text)</td>
</tr>
<tr>
<td align="center"><code>POST</code></td>
<td><code>/api/register</code></td>
<td><code>{"username","password"}</code></td>
<td><code>{"token","user_id"}</code></td>
</tr>
<tr>
<td align="center"><code>POST</code></td>
<td><code>/api/login</code></td>
<td><code>{"username","password"}</code></td>
<td><code>{"token","user_id"}</code></td>
</tr>
</tbody>
</table>

### 🔒 Требуют `Authorization: Bearer <JWT>`

<table>
<thead>
<tr><th>Метод</th><th>Путь</th><th>Тело</th><th>Ответ</th></tr>
</thead>
<tbody>
<tr>
<td align="center"><code>GET</code></td>
<td><code>/api/chats</code></td>
<td>—</td>
<td><code>[{"id","name","owner_id","created_at"}]</code></td>
</tr>
<tr>
<td align="center"><code>POST</code></td>
<td><code>/api/chats</code></td>
<td><code>{"name"}</code></td>
<td><code>{"chat_id"}</code> (создатель сразу в <code>chat_members</code>)</td>
</tr>
<tr>
<td align="center"><code>POST</code></td>
<td><code>/api/chats/:id/join</code></td>
<td>—</td>
<td><code>{"ok":true}</code></td>
</tr>
<tr>
<td align="center"><code>GET</code></td>
<td><code>/api/chats/:id/messages?limit=50</code></td>
<td>—</td>
<td><code>[{Message}]</code> по возрастанию <code>id</code></td>
</tr>
<tr>
<td align="center"><code>POST</code></td>
<td><code>/api/chats/:id/messages</code></td>
<td><code>{"body"}</code></td>
<td><code>{Message}</code></td>
</tr>
</tbody>
</table>

<details>
<summary><b>Пример <code>Message</code></b></summary>

```json
{
  "id": 1,
  "chat_id": 1,
  "user_id": 1,
  "username": "alice",
  "body": "привет",
  "created_at": 1730000000
}
```
</details>

### 📊 Коды статусов

| Код | Значение |
|:---:|---|
| `200` | Успех |
| `201` | Регистрация создана |
| `400` | Ошибка валидации |
| `401` | Нет/невалидный токен |
| `403` | Не участник чата |
| `404` | Не найдено |
| `409` | Имя занято |
| `500` | Внутренняя ошибка |

---

## 🔌 WebSocket

> **Подключение:** `ws(s)://<host>/ws?token=<JWT>`

JWT проверяется **до** апгрейда — при невалидном токене возвращается `401`, соединение не поднимается.

### Клиент → сервер

```json
{"type":"subscribe","chat_id":1}
{"type":"unsubscribe","chat_id":1}
```

> 🛡 Подписка разрешена только на чаты, где пользователь состоит в `chat_members`.
> Иначе: `{"type":"error","error":"not a member of chat"}`.

### Сервер → клиент

```json
{"type":"subscribed","chat_id":1}
{"type":"message","chat_id":1,"user_id":1,"username":"alice","body":"привет","created_at":1730000000}
{"type":"error","error":"…"}
```

> ⚡ Событие `message` приходит **всем** WS-подписчикам чата одновременно с `POST /api/chats/:id/messages`.

---

## 🗄 Схема БД

Таблицы создаются при старте (`db.migrate()`), идемпотентно:

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER,
  user_id INTEGER,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_members_user  ON chat_members(user_id);
```

> ### ⚠️ Особенности rqlite, учтённые в коде
>
> - `POST /db/execute` **не возвращает** `last_insert_rowid()` и **не поддерживает** `RETURNING`.
> - После `INSERT` id получается отдельным `SELECT`:
>   - по уникальному полю (`username`, `name + owner_id`) — для users/chats,
>   - по `MAX(id)+1` — для messages.
> - Если rqlite недоступен при старте — сервер завершится с подсказкой, как его запустить.

---

## 🧑‍💻 Разработка

```bash
cargo check                    # быстрая проверка типов
cargo run                      # debug-сборка и запуск
RUST_LOG=debug cargo run       # подробные логи
cargo fmt                      # форматирование
cargo clippy -- -D warnings    # линтер
```

Перед коммитом:

```bash
cargo check && cargo build --release
./run.sh   # smoke-тест всего стека
```

---

## ✅ Проверка

Запустить `./run.sh`, затем в другом терминале:

```bash
# живость
curl -s localhost:4001/readyz
curl -s localhost:3000/healthz

# регистрация
curl -s -X POST localhost:3000/api/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123"}'

# логин → токен в переменную
TOKEN=$(curl -s -X POST localhost:3000/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123"}' \
  | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# создать чат
curl -s -X POST localhost:3000/api/chats \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"general"}'

# отправить и получить сообщения
curl -s -X POST localhost:3000/api/chats/1/messages \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"body":"привет"}'

curl -s localhost:3000/api/chats/1/messages \
  -H "authorization: Bearer $TOKEN"

# данные реально в rqlite
curl -s -X POST localhost:4001/db/query \
  -H 'content-type: application/json' \
  -d '["SELECT id, username FROM users"]'

curl -s -X POST localhost:4001/db/query \
  -H 'content-type: application/json' \
  -d '["SELECT id, chat_id, body FROM messages"]'
```

> 🖥 **Браузер:** открой `http://localhost:3000/`, зарегистрируй `alice`, создай чат.
> Открой приватное окно, зарегистрируй `bob`, вступи в чат по ID —
> сообщения должны появляться у обоих мгновенно.

---

## 🚧 Известные ограничения

<table>
<tr>
<td align="center" width="40">🔑</td>
<td>Нет refresh-токенов: срок жизни JWT — 7 дней</td>
</tr>
<tr>
<td align="center">🔒</td>
<td>Пароли хешируются argon2 без pepper; <code>JWT_SECRET</code> — из env</td>
</tr>
<tr>
<td align="center">🌍</td>
<td>Чаты «публичные»: любой аутентифицированный может вступить, зная <code>id</code>. Приватность — вне текущей версии</td>
</tr>
<tr>
<td align="center">🛡</td>
<td>Нет rate-limit и капчи на <code>/api/register</code> и <code>/api/login</code></td>
</tr>
<tr>
<td align="center">🌐</td>
<td>CORS открыт (<code>CorsLayer::permissive()</code>) — сузить до origin в проде</td>
</tr>
<tr>
<td align="center">📜</td>
<td>Нет пагинации истории: <code>?limit=</code> возвращает последние N (макс. 200). Курсорная пагинация — в следующих версиях</td>
</tr>
</table>

---

## 📄 Лицензия

<div align="center">

**MIT** — делай что хочешь, только не удаляй копирайт.

Учебный проект. Используй как угодно.

</div>

---

<div align="center">

<sub>Сделано с 🦀 и ❤️ на Rust</sub>

</div>
