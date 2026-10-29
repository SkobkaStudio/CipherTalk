# CipherTalk — мессенджер на Rust (axum + rqlite)

Полностью async мессенджер: HTTP-сервер на **axum 0.7**, база данных — **rqlite**
(распределённый SQLite поверх HTTP API), авторизация — **JWT HS256**, пароли — **argon2**,
реалтайм-доставка сообщений — **WebSocket** через tokio broadcast-брокер.
Фронтенд — чистые HTML/CSS/JS (тёмная тема, адаптив) из каталога `web/`.

## Требования

- Rust (стабильный, edition 2021)
- Docker **или** бинарник `rqlited` (https://github.com/rqlite/rqlite/releases)
- `curl` (для проверок)

## Быстрый старт

```bash
./run.sh
```

Скрипт сам поднимет rqlite (docker или локальный `rqlited`), соберёт сервер в release
и запустит его. После этого откройте в браузере: **http://localhost:3000/**

## Ручной запуск (для отладки)

```bash
# 1. База данных
docker run -p 4001:4001 rqlite/rqlite
# или без docker — скачать бинарник и положить рядом с проектом:
#   wget https://github.com/rqlite/rqlite/releases/download/v8.36.5/rqlited-linux-amd64_.gz
#   gunzip rqlited-linux-amd64_.gz && mv rqlited-linux-amd64_ ./rqlited && chmod +x ./rqlited
#   ./rqlited -node-id 1 ./data-rqlite

# 2. Сервер
cargo run --release
```

## Переменные окружения

| Переменная  | Дефолт                  | Описание                          |
|-------------|-------------------------|-----------------------------------|
| `PORT`      | `3000`                  | Порт HTTP-сервера                 |
| `RQLITE_URL`| `http://localhost:4001` | Адрес API rqlite                  |
| `JWT_SECRET`| *(пусто)*               | Секрет HS256; если пусто — генерируется случайный (токены сбрасываются при рестарте) |

## Структура проекта (MVC)

```
src/
  main.rs          — точка входа: только сборка роутера и запуск
  config.rs        — чтение env (PORT, RQLITE_URL, JWT_SECRET), дефолты
  db.rs            — клиент rqlite (exec/query c позиционными параметрами) + миграции
  models/          — serde-структуры и DTO (User, Chat, Message, запросы/ответы)
  controllers/     — HTTP-хендлеры axum (auth, chats, messages); без SQL,
                     claims получают через Extension<Claims>
  services/        — бизнес-логика и все SQL-запросы (auth_service, chat_service);
                     ничего не знает про HTTP
  middleware/      — require_auth: проверка Bearer JWT, Claims -> request.extensions
  utils/           — jwt.rs (HS256), password.rs (argon2), error.rs (AppError -> IntoResponse)
  ws.rs            — WebSocket-хендлер + broadcast-брокер подписок
web/
  index.html       — экраны login/register, список чатов, окно сообщений
  app.js           — fetch к API, токен в localStorage, WS с автопереподключением
  style.css        — тёмная тема (Catppuccin), адаптив до 720px
run.sh             — единый запуск: rqlite + сборка + сервер
```

## API

Все ответы JSON; ошибки — `{ "error": "..." }` с корректным HTTP-кодом.

| Метод | Путь                        | Auth | Описание                              |
|-------|-----------------------------|------|---------------------------------------|
| POST  | `/api/register`             | –    | `{username,password}` → `{token,user_id}` |
| POST  | `/api/login`                | –    | `{username,password}` → `{token,user_id}` |
| GET   | `/api/chats`                | JWT  | список чатов пользователя             |
| POST  | `/api/chats`                | JWT  | `{name}` → `{chat_id}` (создатель — участник) |
| POST  | `/api/chats/:id/join`       | JWT  | вступление в чат → `{ok:true}`        |
| GET   | `/api/chats/:id/messages?limit=50` | JWT | последние N сообщений по возрастанию |
| POST  | `/api/chats/:id/messages`   | JWT  | `{body}` → сохранённое сообщение + публикация в WS |
| GET   | `/healthz`                  | –    | `ok`                                  |
| WS    | `/ws?token=JWT`             | JWT  | клиент: `{type:"subscribe",chat_id:N}`; сервер: `{type:"message",chat_id,user_id,username,body,created_at}` |

Authorization: заголовок `Authorization: Bearer <token>`.
