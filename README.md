# CipherTalk

**CipherTalk** — полноценный мессенджер на Rust: асинхронный HTTP-сервер на `axum 0.7`, хранение данных в распределённой SQLite-базе **rqlite**, авторизация по JWT (HS256), пароли на argon2, доставка сообщений в реальном времени через WebSocket и `tokio::sync::broadcast`. Код разделён по слоям MVC (models / controllers / services / db), фронтенд — чистые HTML, CSS и JavaScript без фреймворков и сборщиков, в тёмной теме с адаптивом под десктоп и мобильные.

---

## Возможности

- Регистрация и вход по имени пользователя и паролю.
- Пароли хранятся только в виде argon2id-хешей.
- JWT (HS256) на всех защищённых маршрутах, срок жизни — 7 дней.
- Список чатов пользователя, создание чата, вход в публичный чат по ID.
- История сообщений с ограничением `limit` (по умолчанию 50, максимум 200).
- Мгновенная доставка сообщений по WebSocket всем подписчикам чата.
- Подписка только на чаты, в которых пользователь состоит.
- Автопереподключение WebSocket через 2 секунды.
- Тёмная тема, CSS-переменные, аккуратная анимация сообщений, автоскролл.
- Адаптивная вёрстка: на мобильном список чатов и чат переключаются.
- Рендер сообщений и имён через `textContent` — без XSS.
- Единый запуск `./run.sh`: rqlite, сборка, сервер.
- Обновление кода прямо из git: `./run.sh -u -dev` / `./run.sh -u -main`.
- Единый формат ошибок API: `{"error":"..."}`.
- Проверка состояния БД при старте и понятная подсказка, если rqlite не запущен.

---

## Стек

| Слой | Технология |
|---|---|
| Язык | Rust 2021, `cargo` |
| HTTP / WebSocket | `axum 0.7` + `tokio` (полный async) |
| База данных | **rqlite** (распределённый SQLite поверх HTTP API) |
| HTTP-клиент к БД | `reqwest` (rustls, без OpenSSL) |
| Сериализация | `serde`, `serde_json` |
| Авторизация | `jsonwebtoken` (JWT HS256), `argon2` |
| Статика и CORS | `tower-http`: `ServeDir`, `ServeFile`, `CorsLayer`, `TraceLayer` |
| Логи | `tracing`, `tracing-subscriber` |
| WebSocket-утилиты | `futures-util` (split sink/stream) |
| Фронтенд | ванильные HTML + CSS + JS, без npm/React/Vite |

---

## Требования

| Компонент | Зачем |
|---|---|
| **Rust** (stable, edition 2021) и `cargo` | сборка сервера |
| **Docker** *или* бинарник `rqlited` | база данных rqlite на порту `4001` |
| **curl** | проверка `readyz` в `run.sh` и отладка API |

`rqlited` можно не устанавливать глобально: положите бинарник в корень проекта — `run.sh` найдёт `./rqlited`. Скачать: <https://github.com/rqlite/rqlite/releases>.

---

## Быстрый старт

```bash
./run.sh
```

Затем откройте: <http://localhost:3000/>

Что делает `run.sh`:

1. **Разбирает флаги.** Без флагов — обычный запуск; `-u -dev` / `-u -main` — обновление из git; `-h` — справка. Неизвестный флаг завершает работу с кодом 1.
2. **Обновляет код (только с `-u`).** Использует существующий `.git` с `origin`, иначе создаёт служебный bare-репозиторий `.ciphertalk-src/repo`, делает `git fetch --depth 1`, останавливает старый сервер и распаковывает ветку поверх проекта. Если `run.sh` изменился — перезапускает уже новую версию скрипта.
3. **Проверяет rqlite.** Делает `GET $RQLITE_URL/readyz`. Если база не запущена — поднимает контейнер `ciphertalk-rqlite` через Docker, либо `rqlited` из `PATH`, либо локальный `./rqlited`. Ждёт готовности до 30 секунд.
4. **Ищет `cargo`.** Если его нет в `PATH`, проверяет `$HOME/.cargo/bin`, `/root/.cargo/bin`, `/usr/local/cargo/bin`, `/usr/bin`. Если не нашёл — подсказывает rustup и выходит с кодом 1.
5. **Собирает и запускает.** `cargo build --release`, затем `exec ./target/release/messenger` с переменными `PORT`, `JWT_SECRET`, `RQLITE_URL`.

Обновление с ветки:

```bash
./run.sh -u -dev     # ветка dev-rust-v
./run.sh -u -main    # ветка main
```

Справка:

```bash
./run.sh -h
```

---

## Ручной запуск (для отладки)

Терминал 1 — база:

```bash
# вариант с Docker
docker run --rm -p 4001:4001 rqlite/rqlite

# или локальный бинарник
./rqlited -node-id 1 ./data-rqlite
```

Терминал 2 — сервер:

```bash
export RQLITE_URL=http://localhost:4001
export PORT=3000
export JWT_SECRET=dev-secret-change-me
export RUST_LOG=info

cargo run --release
```

Откройте <http://localhost:3000/>. Схема БД создаётся автоматически при старте.

---

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `3000` | Порт HTTP-сервера |
| `RQLITE_URL` | `http://localhost:4001` | Базовый URL rqlite |
| `JWT_SECRET` | `dev-secret-change-me` (в `run.sh`) | Секрет подписи JWT. Если переменная пуста/не задана, сервер генерирует случайный секрет и пишет WARN в лог |
| `RUST_LOG` | `info,tower_http=warn` | Фильтр логов `tracing` (`debug`, `info`, `warn`, …) |

> Для продакшена обязательно задайте длинный случайный `JWT_SECRET` и поставьте сервер за TLS-прокси.

---

## Структура проекта

```
.
├── Cargo.toml              # зависимости и метаданные пакета (license = "MIT")
├── Cargo.lock              # зафиксированные версии зависимостей
├── run.sh                  # единый запуск: обновление, rqlite, сборка, сервер
├── README.md               # этот файл
├── LICENSE                 # MIT
├── .gitignore
├── rqlited                 # опционально: локальный бинарник rqlite (в .gitignore)
├── data-rqlite/            # данные rqlite (в .gitignore)
├── src/
│   ├── main.rs             # точка входа, роутер, статика, graceful shutdown
│   ├── config.rs           # PORT, RQLITE_URL, JWT_SECRET из env
│   ├── db.rs               # HTTP-клиент rqlite + миграции + Row
│   ├── ws.rs               # AppState, WebSocket, broadcast-брокер
│   ├── models/
│   │   ├── mod.rs
│   │   ├── user.rs         # User, AuthRequest, AuthResponse
│   │   ├── chat.rs         # Chat, CreateChatRequest
│   │   └── message.rs      # Message, SendMessageRequest
│   ├── controllers/
│   │   ├── mod.rs          # JSON-ошибки извлечения тела
│   │   ├── auth.rs         # register, login
│   │   ├── chats.rs        # list, create, join
│   │   └── messages.rs     # history, send
│   ├── services/
│   │   ├── mod.rs
│   │   ├── auth_service.rs # валидация, argon2, JWT, SQL по users
│   │   └── chat_service.rs # SQL по chats, chat_members, messages
│   ├── middleware/
│   │   └── mod.rs          # require_auth: Bearer -> Extension<Claims>
│   └── utils/
│       ├── mod.rs
│       ├── error.rs        # AppError -> IntoResponse ({error})
│       ├── jwt.rs          # Claims, create/decode, now_ts
│       └── password.rs     # argon2 hash/verify
└── web/
    ├── index.html          # auth-screen, app-screen, profile-modal, chat-modal
    ├── style.css           # тёмная тема, переменные, адаптив, анимации
    ├── app.js              # состояние, API, WebSocket, рендер, автоскролл
    └── favicon.svg         # иконка приложения
```

---

## Архитектура MVC

| Слой | Модули | Ответственность |
|---|---|---|
| **Model** | `src/models/*` | Структуры `User`, `Chat`, `Message` и DTO запросов/ответов с `serde` |
| **View** | `web/*` | SPA на чистом HTML/CSS/JS: экран авторизации, список чатов, лента, модалки |
| **Controller** | `src/controllers/*` | Извлечение `Path`/`Query`/`Json`/`Extension<Claims>`, HTTP-статусы, вызов сервисов |
| **Service** | `src/services/*` | Бизнес-логика и SQL: валидация, argon2, доступ к чатам, сообщения |
| **DB** | `src/db.rs` | Единственное место, где выполняются HTTP-запросы к rqlite |
| **Middleware** | `src/middleware` | JWT-проверка, `Claims` в расширениях запроса |
| **Realtime** | `src/ws.rs` | `AppState`, WS-апгрейд, подписки, broadcast |

Собственный `FromRequestParts` для авторизации **не используется**. Мидлварь `require_auth` проверяет `Authorization: Bearer <JWT>`, декодирует claims и кладёт их в `request.extensions_mut()`. Хендлеры принимают штатный `Extension<Claims>`.

Защищённые маршруты собраны в отдельный `Router` и обёрнуты:

```rust
.route_layer(axum::middleware::from_fn_with_state(
    state.clone(),
    middleware::require_auth,
))
```

`register` и `login` остаются публичными.

Поток отправки сообщения:

```
POST /api/chats/:id/messages
        │
        ▼
axum Router ──► require_auth (Bearer JWT) ──► Extension<Claims>
        │
        ▼
controllers::messages::send
        │  проверка: чат существует, пользователь — участник
        ▼
services::chat_service::save_message
        │
        ▼
db::Db::execute  ──HTTP──►  rqlite POST /db/execute
        │                         INSERT INTO messages(...)
        ▼
db::Db::query    ──HTTP──►  rqlite POST /db/query
        │                         SELECT ... WHERE chat_id/user_id/created_at/body
        ▼                         (без RETURNING и без last_insert_rowid)
AppState.tx.send(Message)  ──►  broadcast::Sender<Message>
        │
        ▼
ws::handle_socket  ──►  всем соединениям, чья подписка содержит chat_id
        │
        ▼
HTTP 200 {"id":...,"chat_id":...,"user_id":...,"username":...,"body":...,"created_at":...}
```

Порядок слоёв соблюдается: контроллеры не пишут SQL, сервисы не знают про axum, `db.rs` не знает про бизнес-логику.

---

## HTTP API

Все ответы — JSON. Ошибки — `{"error":"текст"}` с корректным HTTP-статусом. Исключение: `GET /healthz` возвращает простой текст `ok`.

### Публичные (без JWT)

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/healthz` | — | `ok` (text/plain) |
| `POST` | `/api/register` | `{"username","password"}` | `201 {"token","user_id","username"}` |
| `POST` | `/api/login` | `{"username","password"}` | `200 {"token","user_id","username"}` |

Правила регистрации: имя — 3–32 символа (буквы, цифры, `_`, `-`, `.`), пароль — 6–128 символов, имя уникально. Невалидные данные → `400`, занятое имя → `409`.

### Защищённые (`Authorization: Bearer <JWT>`)

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/api/chats` | — | `[{"id","name","owner_id","created_at","member_count"}]` |
| `POST` | `/api/chats` | `{"name"}` | `{"chat_id"}` — создатель сразу добавлен в участники |
| `POST` | `/api/chats/:id/join` | — | `{"ok":true}` |
| `GET` | `/api/chats/:id/messages?limit=50` | — | `[{Message}]` по возрастанию `id`, только для участников |
| `POST` | `/api/chats/:id/messages` | `{"body"}` | `{Message}` — сохранённое сообщение |

`Message`:

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

`created_at` — Unix-время в секундах. `limit` по умолчанию 50, отрицательные/нулевые значения приводятся к 50, максимум 200.

### Коды статусов

| Код | Когда |
|---|---|
| `200` | Успешный запрос |
| `201` | Пользователь создан (`/api/register`) |
| `400` | Ошибка валидации, битый JSON, пустое сообщение |
| `401` | Нет/невалидный/просроченный JWT, неверный логин или пароль |
| `403` | Пользователь не состоит в чате |
| `404` | Чат или API-маршрут не найден |
| `409` | Имя пользователя уже занято |
| `500` | Ошибка rqlite или внутренняя ошибка |

---

## WebSocket

Подключение:

```
ws://localhost:3000/ws?token=<JWT>
wss://<host>/ws?token=<JWT>     # за TLS-прокси
```

JWT проверяется **до** апгрейда: при невалидном токене возвращается `401`, WebSocket не открывается.

### Клиент → сервер

```json
{"type":"subscribe","chat_id":1}
{"type":"unsubscribe","chat_id":1}
{"type":"ping"}
```

Подписка разрешена только на чаты, где пользователь состоит в `chat_members`. Иначе сервер присылает событие `error`.

### Сервер → клиент

```json
{"type":"subscribed","chat_id":1}
{"type":"unsubscribed","chat_id":1}
{"type":"message","chat_id":1,"user_id":1,"username":"alice","body":"привет","created_at":1730000000}
{"type":"error","error":"Вы не состоите в этом чате"}
{"type":"pong"}
```

Одно соединение хранит набор подписок и получает сообщения только по ним. Рассылка идёт через `tokio::sync::broadcast`; медленный клиент не блокирует остальных — при отставании в лог пишется WARN. Сообщения отправляются через `POST /api/chats/:id/messages`, а не через WebSocket.

---

## Схема БД

```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER,
    user_id INTEGER,
    PRIMARY KEY(chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Дополнительно создаются индексы:
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
```

### Особенности rqlite

**1. Плоский массив параметров.** rqlite ждёт массив, где первый элемент — SQL, а следующие — позиционные параметры:

```json
[["INSERT INTO users(username, password_hash, created_at) VALUES(?, ?, ?)", "alice", "$argon2id$...", 1730000000]]
```

Вложенный вариант `[["INSERT ...", ["alice"]]]` приводит к ошибке декодирования. В `src/db.rs` параметры всегда разворачиваются в плоский массив, а пользовательские значения передаются только через `?` — конкатенации SQL нет.

**2. Нет `RETURNING`.** После `INSERT` пользователь выбирается по уникальному `username`, а чат — по паре `name + owner_id` с `ORDER BY id DESC LIMIT 1`.

**3. Нет `last_insert_rowid()` в `/db/execute`.** Код не полагается на него. Сообщение после вставки ищется запросом:

```sql
SELECT m.id, m.chat_id, m.user_id, u.username, m.body, m.created_at
FROM messages m
JOIN users u ON u.id = m.user_id
WHERE m.chat_id = ? AND m.user_id = ? AND m.created_at = ? AND m.body = ?
ORDER BY m.id DESC
LIMIT 1
```

**4. Пакетный `/db/execute`.** Создание чата и добавление владельца в участники отправляются одним запросом — rqlite выполняет пакет атомарно.

**5. Строгая схема.** Все `CREATE TABLE IF NOT EXISTS` выполняются при каждом старте; миграции идемпотентны.

---

## Разработка

```bash
# быстрая проверка типов
cargo check

# запуск в release-режиме (rqlite должен быть уже запущен)
cargo run --release

# форматирование
cargo fmt --all

# линтер
cargo clippy --all-targets

# релизная сборка
cargo build --release
```

Фронтенд не требует сборки: файлы из `web/` раздаются напрямую через `ServeDir`, а неизвестные пути отдают `web/index.html` (SPA-fallback). После изменения `web/*` достаточно обновить страницу.

Логи включаются через `RUST_LOG`:

```bash
RUST_LOG=debug cargo run --release
```

---

## Проверка

Полный набор команд (сервер должен быть запущен на `localhost:3000`, rqlite — на `localhost:4001`).

```bash
# 1. Живость сервера
curl -s http://localhost:3000/healthz
# ok

# 2. Регистрация
curl -s -X POST http://localhost:3000/api/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
# {"token":"...","user_id":1,"username":"alice"}

# 3. Вход
curl -s -X POST http://localhost:3000/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
# {"token":"...","user_id":1,"username":"alice"}

# 4. Сохраняем токен в переменную
TOKEN=$(curl -s -X POST http://localhost:3000/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

# 5. Список чатов (пока пустой)
curl -s http://localhost:3000/api/chats \
  -H "Authorization: Bearer $TOKEN"
# []

# 6. Создание чата
curl -s -X POST http://localhost:3000/api/chats \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"general"}'
# {"chat_id":1}

# 7. Вход в чат по ID (идемпотентно)
curl -s -X POST http://localhost:3000/api/chats/1/join \
  -H "Authorization: Bearer $TOKEN"
# {"ok":true}

# 8. Отправка сообщения
curl -s -X POST http://localhost:3000/api/chats/1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"body":"Привет, мир!"}'
# {"id":1,"chat_id":1,"user_id":1,"username":"alice","body":"Привет, мир!","created_at":...}

# 9. История сообщений
curl -s "http://localhost:3000/api/chats/1/messages?limit=50" \
  -H "Authorization: Bearer $TOKEN"
# [{"id":1,...}]

# 10. Проверка данных напрямую в rqlite
curl -s -X POST http://localhost:4001/db/query \
  -H 'content-type: application/json' \
  -d '["SELECT id, username FROM users"]'

curl -s -X POST http://localhost:4001/db/query \
  -H 'content-type: application/json' \
  -d '["SELECT id, chat_id, body FROM messages"]'
```

Проверка ошибок:

```bash
# 401 без токена
curl -s http://localhost:3000/api/chats
# {"error":"Требуется заголовок Authorization"}

# 401 с неверным паролем
curl -s -X POST http://localhost:3000/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"wrong"}'
# {"error":"Неверное имя пользователя или пароль"}

# 409 на повторную регистрацию
curl -s -X POST http://localhost:3000/api/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
# {"error":"Имя пользователя уже занято"}
```

Проверка WebSocket (если установлен `websocat`):

```bash
websocat "ws://localhost:3000/ws?token=$TOKEN"
# затем ввести:
{"type":"subscribe","chat_id":1}
# сервер ответит:
{"type":"subscribed","chat_id":1}
# а при POST сообщения в этот чат придёт:
{"type":"message","chat_id":1,"user_id":1,"username":"alice","body":"...","created_at":...}
```

---

## Известные ограничения

- Нет refresh-токенов: access-токен живёт 7 дней, отзыв токена не предусмотрен.
- Чаты «публичные»: любой авторизованный пользователь, зная числовой ID, может войти в чат. Приватных чатов и приглашений нет.
- Нет rate-limit: регистрация, логин и отправка сообщений не ограничены по частоте.
- CORS полностью открыт (`CorsLayer::permissive()`) — подходит для локальной разработки, но не для продакшена.
- Нет пагинации: история отдаётся только последними `limit` сообщениями, без курсоров и подгрузки вверх.
- Нет личных сообщений (DM), загрузки файлов, редактирования/удаления сообщений, реакций и статусов прочтения.
- Нет офлайн-очереди: WebSocket-рассылка живёт в памяти процесса; пропущенные сообщения можно догрузить через историю, но пуш-уведомлений нет.
- Один узел rqlite по умолчанию; для отказоустойчивости нужен кластер и настройка `RQLITE_URL`.
- Нет встроенного TLS и reverse-proxy-конфигурации: для HTTPS/WSS ставьте сервер за nginx/Caddy.
- Нет ограничения числа участников и размера чатов; единственные лимиты — 64 символа в названии и 4000 символов в сообщении.

---

## Лицензия

Проект распространяется под лицензией **MIT**. Полный текст — в файле [LICENSE](LICENSE).

Copyright (c) 2026 SkobkaStudio.
