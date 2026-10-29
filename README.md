# CipherTalk

Мессенджер с реальным временем: Rust + axum + rqlite, чистый HTML/CSS/JS на фронте.
Поддерживает регистрацию, вход по JWT, чаты, историю сообщений и доставку
новых сообщений через WebSocket.

## Содержание

- [Возможности](#возможности)
- [Стек](#стек)
- [Требования](#требования)
- [Быстрый старт](#быстрый-старт)
- [Ручной запуск](#ручной-запуск)
- [Переменные окружения](#переменные-окружения)
- [Структура проекта](#структура-проекта)
- [Архитектура](#архитектура)
- [HTTP API](#http-api)
- [WebSocket](#websocket)
- [Схема БД](#схема-бд)
- [Разработка](#разработка)
- [Проверка](#проверка)
- [Известные ограничения](#известные-ограничения)

## Возможности

- Регистрация и вход, пароли хранятся в виде хешей (argon2).
- JWT (HS256) для авторизации всех `/api/*`, кроме регистрации и входа.
- Список чатов, создание чата, вступление в чат по ID.
- Отправка и загрузка истории сообщений.
- Доставка новых сообщений в реальном времени через WebSocket.
- Тёмная адаптивная тема, работает на телефоне и десктопе.
- Все запросы к БД — только параметризованные (защита от SQL-инъекций).

## Стек

| Слой | Технологии |
|---|---|
| HTTP / WS | [axum](https://github.com/tokio-rs/axum) 0.7, [tokio](https://tokio.rs) |
| БД | [rqlite](https://rqlite.io) (распределённый SQLite через HTTP API) |
| HTTP-клиент к rqlite | reqwest (rustls) |
| JWT | jsonwebtoken (HS256) |
| Пароли | argon2 |
| Статика | tower-http (`ServeDir`, `ServeFile`, `CorsLayer`) |
| Логи | tracing, tracing-subscriber |
| Фронтенд | ванильные HTML + CSS + JS, без сборщиков |

## Требования

- Rust (stable, edition 2021) и `cargo`.
- **Один из вариантов** для rqlite:
  - Docker (рекомендуется), **или**
  - бинарник `rqlited` в `PATH` — [releases](https://github.com/rqlite/rqlite/releases).
- `curl` — для проверок и для `run.sh`.

## Быстрый старт

```bash
# 1. Поднимает rqlite (если не поднят), собирает release и запускает сервер
./run.sh

# 2. Открыть в браузере
#    http://localhost:3000/
```

`run.sh` делает всё сам:

1. Проверяет `GET $RQLITE_URL/readyz`.
2. Если rqlite не запущен — стартует контейнер `ciphertalk-rqlite` (или `rqlited`).
3. Ждёт готовности rqlite (до 30 секунд).
4. Выполняет `cargo build --release`.
5. Запускает `./target/release/messenger` на `PORT` (по умолчанию `3000`).

Остановить: `Ctrl+C`. Остановить rqlite-контейнер: `docker rm -f ciphertalk-rqlite`.

## Ручной запуск

Если `run.sh` не подходит (отладка, кастомный rqlite):

```bash
# 1. rqlite
docker run --rm -p 4001:4001 rqlite/rqlite
# или
rqlited -node-id 1 ./data-rqlite

# 2. сервер (в другом терминале)
export RQLITE_URL=http://localhost:4001
export JWT_SECRET=dev-secret-change-me
export PORT=3000
cargo run --release
```

Сервер сам создаст таблицы при первом старте (`CREATE TABLE IF NOT EXISTS`).
Если rqlite недоступен — сервер завершится с понятной ошибкой и подсказкой.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `3000` | Порт HTTP-сервера (слушает `0.0.0.0`) |
| `RQLITE_URL` | `http://localhost:4001` | Базовый URL rqlite (без завершающего `/`) |
| `JWT_SECRET` | случайный при старте | Секрет HMAC для JWT. **Если не задан**, генерируется случайный и печатается WARN в лог — все выданные токены станут недействительны после перезапуска. В проде задавать обязательно. |
| `RUST_LOG` | `info` | Уровень логов tracing (`debug`, `trace`, ...) |

## Структура проекта

```
.
├── Cargo.toml
├── Cargo.lock
├── run.sh                  # единый запуск (rqlite + сервер)
├── README.md
├── src/
│   ├── main.rs             # сборка роутера, запуск сервера
│   ├── config.rs           # чтение env (PORT, RQLITE_URL, JWT_SECRET)
│   ├── db.rs               # клиент rqlite + миграции схемы
│   ├── ws.rs               # WebSocket-хендлер + broadcast-брокер
│   ├── models/             # структуры данных и DTO (serde)
│   │   ├── mod.rs
│   │   ├── user.rs
│   │   ├── chat.rs
│   │   └── message.rs
│   ├── controllers/        # HTTP-хендлеры axum, без SQL
│   │   ├── mod.rs
│   │   ├── auth.rs
│   │   ├── chats.rs
│   │   └── messages.rs
│   ├── services/           # бизнес-логика и все SQL-запросы
│   │   ├── mod.rs
│   │   ├── auth_service.rs
│   │   └── chat_service.rs
│   ├── middleware/         # JWT-мидлварь, кладёт Claims в extensions
│   │   └── mod.rs
│   └── utils/              # jwt, password, error
│       ├── mod.rs
│       ├── jwt.rs
│       ├── password.rs
│       └── error.rs
└── web/                    # фронтенд, раздаётся тем же сервером
    ├── index.html
    ├── app.js
    └── style.css
```

## Архитектура

MVC-разделение по слоям:

- **Models** (`src/models/`) — только структуры данных с `serde`
  (`User`, `Chat`, `Message`) и DTO запросов/ответов (`AuthRequest`,
  `CreateChatRequest`, `SendMessageRequest`, `AuthResponse`).
  Никакой логики.

- **Controllers** (`src/controllers/`) — HTTP-хендлеры axum. Извлекают
  параметры (`State`, `Extension<Claims>`, `Path`, `Query`, `Json`),
  вызывают сервисы, возвращают `Json`/`AppError`. **Не содержат SQL**
  и не знают про rqlite.

- **Services** (`src/services/`) — вся бизнес-логика и все SQL-запросы
  к rqlite через `db.rs`. Валидация входных данных, проверки прав
  (`is_member`), публикация в WS-канал после сохранения сообщения.
  **Не знают про HTTP**.

- **DB** (`src/db.rs`) — клиент rqlite: `POST /db/execute`, `POST /db/query`.
  Все пользовательские значения передаются **только позиционными
  параметрами** (`?`), никакой конкатенации строк в SQL.
  Здесь же — миграции (`CREATE TABLE IF NOT EXISTS`).

- **Middleware** (`src/middleware/mod.rs`) — `require_auth`:
  проверяет `Authorization: Bearer <JWT>`, при успехе кладёт `Claims`
  в `req.extensions_mut()`. Хендлеры получают их через штатный
  `Extension<Claims>`.

- **WS** (`src/ws.rs`) — `GET /ws?token=<JWT>`. Проверка токена до
  апгрейда, затем разделение сокета на read/write, подписка на
  `tokio::sync::broadcast::Receiver<Message>` и фильтрация по `chat_id`
  из сообщений клиента `{"type":"subscribe","chat_id":N}`.

Поток отправки сообщения:

```
POST /api/chats/:id/messages
  → middleware::require_auth  (кладёт Claims в extensions)
  → controllers::messages::send
  → services::chat_service::is_member / save_message
  → db::Db::query_rows / exec_params  →  rqlite
  → state.tx.send(msg)  →  broadcast  →  все WS-подписчики чата
  → JSON-ответ клиенту
```

## HTTP API

Все ответы — JSON. Ошибки — `{ "error": "текст" }` с корректным статусом.

Публичные (без JWT):

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/healthz` | — | `ok` (plain text) |
| `POST` | `/api/register` | `{"username","password"}` | `{"token","user_id"}` |
| `POST` | `/api/login` | `{"username","password"}` | `{"token","user_id"}` |

Требуют `Authorization: Bearer <JWT>`:

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/api/chats` | — | `[{"id","name","owner_id","created_at"}]` |
| `POST` | `/api/chats` | `{"name"}` | `{"chat_id"}` (создатель сразу в `chat_members`) |
| `POST` | `/api/chats/:id/join` | — | `{"ok":true}` |
| `GET` | `/api/chats/:id/messages?limit=50` | — | `[{Message}]` по возрастанию `id` |
| `POST` | `/api/chats/:id/messages` | `{"body"}` | `{Message}` |

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

Статусы: `200` — успех, `201` — регистрация, `400` — валидация,
`401` — нет/плохой токен, `403` — не участник чата, `404` — не найдено,
`409` — имя занято, `500` — внутренняя ошибка.

## WebSocket

Подключение: `ws(s)://<host>/ws?token=<JWT>`.

JWT проверяется **до** апгрейда — при невалидном токене возвращается
`401` и соединение не поднимается.

Сообщения от клиента:

```json
{"type":"subscribe","chat_id":1}
{"type":"unsubscribe","chat_id":1}
```

Подписка разрешена только на чаты, в которых пользователь состоит
(`chat_members`); иначе сервер ответит `{"type":"error","error":"not a member of chat"}`.

События от сервера:

```json
{"type":"subscribed","chat_id":1}
{"type":"message","chat_id":1,"user_id":1,"username":"alice","body":"привет","created_at":1730000000}
{"type":"error","error":"..."}
```

Событие `message` приходит всем WS-подписчикам чата одновременно
с `POST /api/chats/:id/messages`.

## Схема БД

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

### Особенности rqlite, которые учтены в коде

- `POST /db/execute` **не возвращает** `last_insert_rowid()` и **не
  поддерживает** `RETURNING`. После `INSERT` id получается отдельным
  `SELECT` по уникальному полю (`username`, `name + owner_id`) или по
  `MAX(id)+1` (для сообщений).
- Записи идут через HTTP на `RQLITE_URL`; при недоступности rqlite
  сервер завершится при старте с подсказкой, как его запустить.

## Разработка

```bash
cargo check            # быстрая проверка типов
cargo run              # debug-сборка и запуск
RUST_LOG=debug cargo run
cargo fmt
cargo clippy -- -D warnings
```

Перед отправкой изменений:

```bash
cargo check && cargo build --release
./run.sh   # smoke-тест всего стека
```

## Проверка

Запустить `./run.sh`, затем в другом терминале:

```bash
# живость
curl -s localhost:4001/readyz
curl -s localhost:3000/healthz

# регистрация
curl -s -X POST localhost:3000/api/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123"}'

# логин
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

Браузер: открой `http://localhost:3000/`, зарегистрируй `alice`,
создай чат, открой второе окно в приватном режиме, зарегистрируй `bob`,
вступи в чат по ID — сообщения должны появляться у обоих мгновенно.

## Известные ограничения

- Нет refresh-токенов: срок жизни JWT — 7 дней.
- Пароли хешируются argon2 без pepper; `JWT_SECRET` и секреты — из env.
- Чаты «публичные»: любой аутентифицированный пользователь может
  вступить, зная `id`. Приватность чатов — вне рамок текущей версии.
- Нет rate-limit и капчи на `/api/register` и `/api/login`.
- CORS открыт (`CorsLayer::permissive()`) — удобно для локальной разработки,
  в проде сузить до конкретного origin.
- Нет пагинации истории: `GET .../messages?limit=` возвращает последние
  N (максимум 200). Курсорная пагинация — в следующих версиях.

## Лицензия

Учебный проект. Используй как угодно.
