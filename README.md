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

> ⚠️ **О шифровании.** В этой ветке **нет end-to-end шифрования**: сообщения
> хранятся и передаются в открытом виде (TLS — на уровне reverse-proxy, если вы
> его поставите). Клиентское E2EE было в JS-версии (`old-javascript-v`), в
> Rust-переписывании его пока нет. Не используйте проект для действительно
> секретной переписки.

---

## ✨ Возможности

### 🔐 Безопасность
- **argon2id**-хеширование паролей, JWT (HS256) на защищённых роутах
- Параметризованные SQL-запросы — конкатенации пользовательских данных нет
- `textContent`, а не `innerHTML` — XSS-безопасный рендер
- Код подтверждения: TTL 5 минут, 5 попыток, кулдаун на перевыдачу
- Rate-limit по IP на auth-эндпоинты (429 + `Retry-After`)
- Одноразовые тикеты на WebSocket — JWT не попадает в URL и логи
- CSP, `nosniff`, `X-Frame-Options: DENY` на всех ответах

### ⚡ Реальное время
- **WebSocket** через `tokio::sync::broadcast`
- Подписка на чаты с проверкой членства
- Автопереподключение при обрыве
- Мгновенная доставка всем участникам

### 🎨 Фронтенд
- Ванильные **HTML / CSS / JS**, без npm/React/Vite
- Тёмная тема, CSS-переменные, адаптив под мобильные

### 🧩 Архитектура
- Чистый **MVC**: models / controllers / services
- Слой БД изолирован в `db.rs`, JWT-мидлварь отдельно
- Один бинарник, раздаёт и API, и фронт

---

## 🧱 Стек

| Слой | Технологии |
|---|---|
| HTTP / WS | axum 0.7 + tokio |
| База данных | rqlite (SQLite поверх HTTP API) |
| HTTP-клиент | reqwest (rustls, без openssl) |
| Авторизация | jsonwebtoken (HS256) + argon2 |
| Статика | tower-http: `ServeDir`, `ServeFile`, `CorsLayer` |
| Логи | tracing, tracing-subscriber (локальное время) |

---

## 📋 Требования

- **Rust** (stable, edition 2021) и `cargo`
- **Docker** *или* бинарник `rqlited`. Если нет ни того, ни другого, `run.sh`
  скачает rqlite нужной версии сам (`RQLITED_VERSION`, по умолчанию `v10.6.6`)
- `curl` — для запуска и проверок

---

## 🚀 Быстрый старт

```bash
# Всё в одной команде: rqlite + сборка + сервер
./run.sh

# Открыть в браузере
# http://localhost:3000/
```

Что делает `run.sh`:

1. Проверяет `GET $RQLITE_URL/readyz`
2. Поднимает rqlite (docker / `rqlited` / скачивает бинарник), только на `127.0.0.1`
3. Ждёт готовности rqlite (до 30 секунд)
4. Берёт `JWT_SECRET` из окружения или из файла `.jwt_secret` (создаёт его при первом запуске)
5. Выполняет `cargo build --release`
6. Запускает `./target/release/messenger` на `PORT` (по умолчанию `3000`)

> ⏹ **Остановить:** `Ctrl+C`.
> 🐳 **Остановить rqlite-контейнер:** `docker rm -f ciphertalk-rqlite`.

Обновление кода из GitHub:

```bash
./run.sh -u -dev    # ветка dev-rust-v
./run.sh -u -main   # ветка main
```

---

## 🛠 Ручной запуск

```bash
# 1. База (только loopback — у rqlite нет аутентификации)
docker run --rm -p 127.0.0.1:4001:4001 rqlite/rqlite
#   или
rqlited -http-addr 127.0.0.1:4001 -node-id 1 ./data-rqlite

# 2. Сервер (в другом терминале)
export RQLITE_URL=http://localhost:4001
export JWT_SECRET="$(openssl rand -base64 48)"
export PORT=3000
cargo run --release
```

Сервер сам создаёт таблицы при первом старте (`CREATE TABLE IF NOT EXISTS`) и
досоздаёт новые колонки в существующих. Если rqlite недоступен — выйдет с
понятной ошибкой и подсказкой.

> ⚠️ При переходе **со схемы v1** (логин по username) таблицы придётся
> пересоздать. Сервер не делает это молча: он откажется стартовать, пока вы не
> запустите его с `ALLOW_DESTRUCTIVE_MIGRATION=1` (данные будут удалены).

---

## ⚙️ Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `3000` | Порт HTTP-сервера (слушает `0.0.0.0`) |
| `RQLITE_URL` | `http://localhost:4001` | Базовый URL rqlite (без завершающего `/`) |
| `JWT_SECRET` | из `.jwt_secret` | Секрет HMAC для JWT. Если не задан, `run.sh` читает/создаёт файл `.jwt_secret` (права 600, в git не попадает). Без `run.sh` сервер сгенерирует случайный секрет на старте — тогда токены умрут при перезапуске |
| `JWT_SECRET_FILE` | `.jwt_secret` | Путь к файлу с секретом |
| `AUTH_RATE_LIMIT` | `30` | Запросов в минуту с одного IP на `/api/auth/{start,verify,finish,login}` |
| `ALLOW_DESTRUCTIVE_MIGRATION` | — | `1` разрешает сброс таблиц при переходе со схемы v1 |
| `RQLITED_VERSION` | `v10.6.6` | Версия rqlite, которую скачивает `run.sh` |
| `RUST_LOG` | `info` | Уровень логов tracing (`debug`, `trace`, …) |

---

## 📁 Структура проекта

```
.
├── 🦀 Cargo.toml / Cargo.lock
├── 🚀 run.sh                  # единый запуск (rqlite + сервер)
├── 📖 README.md
├── src/
│   ├── main.rs                # роутер, мидлвари, запуск
│   ├── config.rs              # PORT, RQLITE_URL, JWT_SECRET, AUTH_RATE_LIMIT
│   ├── db.rs                  # клиент rqlite + миграции
│   ├── ws.rs                  # WebSocket, тикеты, broadcast-брокер
│   ├── models/                # структуры данных (serde)
│   ├── controllers/           # HTTP-хендлеры axum, без SQL
│   ├── services/              # бизнес-логика и все SQL
│   ├── middleware/            # JWT, rate-limit, security-заголовки
│   └── utils/                 # jwt, password, error, server_id
└── web/                       # фронтенд, раздаётся тем же сервером
    ├── index.html
    ├── app.js
    └── style.css
```

---

## 🏛 Архитектура

```
Browser (SPA: HTML/CSS/JS + WebSocket + fetch)
        │ HTTP + WS
        ▼
    axum router
    ├── middleware: security_headers, rate_limit (auth), require_auth
    ├── controllers: auth · chats · messages
    ├── services: auth_service · chat_service   (валидация, права, SQL)
    ├── ws: broadcast-брокер + подписки
    └── db: rqlite client
        │ POST /db/execute, /db/query
        ▼
    rqlite (SQLite)
```

Поток отправки сообщения:

```
POST /api/chats/:id/messages
  ├─▶ require_auth                      (Claims → extensions)
  ├─▶ controllers::messages::send
  ├─▶ chat_service::is_member → save_message
  ├─▶ db.rs                             (exec_params → rqlite)
  ├─▶ state.tx.send(msg)                (broadcast всем WS-клиентам)
  └─▶ 200 OK + JSON клиенту
```

---

## 🌐 HTTP API

Все ответы — JSON, ошибки — `{ "error": "текст" }` с корректным статусом.

### 🟢 Публичные (без JWT)

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/healthz` | — | `ok` (plain text) |
| `POST` | `/api/auth/start` | `{"phone"}` | `{"registered","needs_code"}` |
| `POST` | `/api/auth/verify` | `{"phone","code"}` | `{"ok":true}` |
| `POST` | `/api/auth/finish` | `{"phone","code","first_name","username","password","password_repeat"[,"last_name"]}` | `{"token","user"}` — `201` |
| `POST` | `/api/auth/login` | `{"phone","password"}` | `{"token","user"}` |
| `GET` | `/api/auth/check-username?username=…` | — | `{"available","reason"}` |

> В MVP роль SMS играет лог сервера: `SMS-код для +7999…: 123456`.
> Код живёт 5 минут, даётся 5 попыток; после исчерпания новый выдаётся не
> раньше чем через минуту.

### 🔒 Требуют `Authorization: Bearer <JWT>`

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/api/me` | — | `{"user"}` |
| `GET` | `/api/ws-ticket` | — | `{"ticket","expires_in":30}` |
| `GET` | `/api/chats` | — | `[Chat]` — включает «Избранное» |
| `POST` | `/api/chats/group` | `{"kind":"group"\|"channel","title"[,"member_ids"]}` | `Chat` |
| `POST` | `/api/chats/dm` | `{"user_id"}` | `Chat` (свой id → «Избранное») |
| `POST` | `/api/chats` | `{"name"}` | `{"chat_id"}` — устаревший алиас группы |
| `GET` | `/api/chats/by-id/:server_id` | — | `Chat` |
| `GET` | `/api/users/:server_id` | — | `User` (без телефона) |
| `POST` | `/api/chats/:id/join` | — | `{"ok":true}` — только `group`/`channel` |
| `GET` | `/api/chats/:id/messages?limit=50` | — | `[Message]` (лимит 1…200) |
| `POST` | `/api/chats/:id/messages` | `{"body"}` | `Message` |

<details>
<summary><b>Пример <code>Chat</code> и <code>Message</code></b></summary>

```json
{
  "id": 2,
  "server_id": "-00000000000001",
  "kind": "group",
  "title": "general",
  "owner_id": 1,
  "created_at": 1730000000
}
```

```json
{
  "id": 1,
  "chat_id": 2,
  "user_id": 1,
  "username": "Алиса",
  "body": "привет",
  "created_at": 1730000000
}
```

`username` в `Message` — отображаемое имя: `first_name`, иначе `@username`,
иначе `?`.
</details>

### 📊 Коды статусов

| Код | Значение |
|:---:|---|
| `200` | Успех |
| `201` | Регистрация создана |
| `400` | Ошибка валидации |
| `401` | Нет/невалидный токен, неверный код или пароль |
| `403` | Не участник чата, прямой вход в dm/saved запрещён |
| `404` | Не найдено |
| `409` | Номер/username занят |
| `429` | Rate-limit или исчерпаны попытки кода |
| `500` | Внутренняя ошибка |

---

## 🔌 WebSocket

> **Подключение:** `GET /api/ws-ticket` (с JWT) → `{"ticket": "…"}` →
> `ws(s)://<host>/ws?ticket=<ticket>`

Тикет одноразовый и живёт 30 секунд: он сгорает при подключении, поэтому
утёкший URL сокета (логи прокси, история) уже ничего не даёт. JWT в URL
больше не передаётся. Невалидный/просроченный тикет → `401`, соединение не
поднимается.

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
{"type":"message","chat_id":1,"user_id":1,"username":"Алиса","body":"привет","created_at":1730000000}
{"type":"error","error":"…"}
```

---

## 🗄 Схема БД

Таблицы создаются при старте (`db.migrate()`), идемпотентно; новые колонки
досоздаются через `ALTER TABLE`.

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id     TEXT UNIQUE NOT NULL,   -- "00000001"
  phone         TEXT UNIQUE NOT NULL,   -- "+79990001122"
  username      TEXT UNIQUE,            -- "alice"
  first_name    TEXT,
  last_name     TEXT,
  password_hash TEXT,                   -- argon2id; NULL = регистрация не завершена
  created_at    INTEGER NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#89b4fa'
);

CREATE TABLE phone_codes (
  phone      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,          -- unix-seconds
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER NOT NULL DEFAULT 0 -- для кулдауна перевыдачи
);

CREATE TABLE chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  TEXT UNIQUE NOT NULL,      -- "00000002" (dm/saved) / "-00000000000001" (group)
  kind       TEXT NOT NULL,             -- dm | group | channel | saved
  title      TEXT,
  owner_id   INTEGER,
  created_at INTEGER NOT NULL,
  dm_key     TEXT                       -- "1:2" — один диалог на пару
);

CREATE TABLE chat_members (
  chat_id INTEGER,
  user_id INTEGER,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_chat ON messages(chat_id, id);
CREATE INDEX idx_members_user  ON chat_members(user_id);
CREATE UNIQUE INDEX idx_chats_dm_key ON chats(dm_key) WHERE dm_key IS NOT NULL;
```

> **Особенности rqlite, учтённые в коде**
> - `/db/execute` не возвращает `last_insert_rowid()` и не поддерживает `RETURNING`:
>   id читается отдельным `SELECT` по уникальному полю.
> - `server_id` вычисляется из `MAX(id)`, поэтому конкурентные создания
>   разрешаются через `INSERT … ON CONFLICT DO NOTHING` + повтор.

---

## 🧑‍💻 Разработка

```bash
cargo check                    # быстрая проверка типов
cargo test                     # юнит-тесты (валидация, server_id, dm_key)
cargo run                      # debug-сборка и запуск
RUST_LOG=debug cargo run       # подробные логи
cargo fmt
cargo clippy -- -D warnings
```

Перед коммитом:

```bash
cargo check && cargo test && cargo build --release
./run.sh   # smoke-тест всего стека
```

---

## ✅ Проверка

Запустить `./run.sh`, затем в другом терминале:

```bash
# живость
curl -s localhost:4001/readyz && echo
curl -s localhost:3000/healthz; echo

# 1. старт регистрации: код появится в логе сервера
curl -s -X POST localhost:3000/api/auth/start \
  -H 'content-type: application/json' -d '{"phone":"+79990001122"}'

# 2. код из лога (например 123456) -> verify и finish
CODE=123456
curl -s -X POST localhost:3000/api/auth/verify \
  -H 'content-type: application/json' -d "{\"phone\":\"+79990001122\",\"code\":\"$CODE\"}"

TOKEN=$(curl -s -X POST localhost:3000/api/auth/finish \
  -H 'content-type: application/json' \
  -d "{\"phone\":\"+79990001122\",\"code\":\"$CODE\",\"first_name\":\"Алиса\",\"username\":\"alice\",\"password\":\"password123\",\"password_repeat\":\"password123\"}" \
  | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 3. группа и сообщение
curl -s -X POST localhost:3000/api/chats/group \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"group","title":"general"}'

curl -s -X POST localhost:3000/api/chats/2/messages \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"body":"привет"}'

curl -s "localhost:3000/api/chats/2/messages?limit=50" \
  -H "authorization: Bearer $TOKEN"

# 4. тикет для WebSocket
curl -s localhost:3000/api/ws-ticket -H "authorization: Bearer $TOKEN"
```

> 🖥 **Браузер:** открой `http://localhost:3000/`, зарегистрируй `alice`,
> создай группу. Открой приватное окно, зарегистрируй `bob`, вступи в группу по
> `server_id` (`-00000000000001`) — сообщения появятся у обоих мгновенно.

---

## 🚧 Известные ограничения

| | Ограничение |
|---|---|
| 🔓 | **Нет E2EE.** Сообщения хранятся в БД открытым текстом; обещание «E2EE» в описании репозитория к этой ветке не относится |
| 🗄 | У rqlite нет аутентификации: держите его на loopback (так делает `run.sh`) или закрывайте rqlite-паролем |
| 🔑 | Нет refresh-токенов: JWT живёт 7 дней, отозвать его нельзя |
| 🌍 | Чаты «публичные»: любой аутентифицированный вступает в `group`/`channel`, зная `id` |
| 📜 | Нет пагинации: `?limit=` отдаёт последние N (макс. 200) |
| 🖼 | Нет вложений, удаления и редактирования сообщений |
| 📱 | Код «SMS» пишется в лог сервера — реальной отправки нет |
| 🧮 | Rate-limit in-memory: считается в рамках одного процесса |
| 🌐 | `CorsLayer::permissive()` — для прода сузить до своего origin |

---

## 📄 Лицензия

**MIT** — делай что хочешь, только не удаляй копирайт.

Учебный проект.

---

<div align="center">
<sub>Сделано с 🦀 и ❤️ на Rust</sub>
</div>
