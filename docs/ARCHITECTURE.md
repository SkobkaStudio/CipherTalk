# CipherTalk — архитектура

## 1. Обзор

CipherTalk — модульный монолит: один Rust-бинарник раздаёт и REST API, и
статический фронтенд, а также держит WebSocket-соединения. Такой вариант
сохраняет простоту деплоя (один процесс + Postgres + Redis), но внутри строго
разделён на слои, поэтому любой узел позже можно вынести в отдельный сервис.

```
Браузер (web/index.html + web/app.js)
   │  HTTPS :443 / WSS (Nginx → 127.0.0.1:8081)
   ▼
Axum Router
   ├─ middleware: Trace → CORS → Security headers → Rate limit → Auth
   ├─ controllers: извлечение DTO, валидация формата, вызов сервиса
   ├─ services:    бизнес-логика, транзакции, SQL, Redis
   ├─ ws:          реестр соединений, комнаты чатов, Redis Pub/Sub
   └─ ServeDir:    web/ (SPA + Tailwind CDN)
        │
        ├── PostgreSQL 16+  — источник истины
        └── Redis 7+        — кэш сессий, rate limit, Pub/Sub
```

Ключевой принцип: **HTTP-запросы и WS-события проходят одни и те же проверки
членства и авторизации**. WebSocket не является «доверенным» каналом: каждое
действие (`subscribe`, `read`, `typing`, отправка) валидируется на сервере.

## 2. Структура модулей

```
src/
├── main.rs            сборка приложения, роутинг, graceful shutdown
├── config.rs          типизированная конфигурация из env
├── db.rs              PgPool + Redis ConnectionManager
├── models/
│   ├── mod.rs
│   ├── user.rs        User, PublicUser, UserSearchHit
│   ├── chat.rs        Chat, ChatSummary, ChatKind, ChatRole
│   ├── message.rs     Message, MessageDto, MessagePage
│   ├── media.rs       AttachmentDto
│   ├── push.rs        push subscription DTO
│   └── ws.rs          ClientEvent / ServerEvent, включая call.* / user.updated
├── controllers/
│   ├── auth.rs        register / login / refresh / logout
│   ├── users.rs       me / update / search
│   ├── chats.rs       list / create private / create group / members
│   ├── messages.rs    history / send / edit / delete / read
│   ├── media.rs       upload / content / thumbnail / avatar / stickers
│   ├── push.rs        VAPID key / subscribe / test
│   └── health.rs      liveness / readiness
├── services/
│   ├── auth.rs        Argon2, JWT, refresh rotation, sessions
│   ├── users.rs
│   ├── chats.rs
│   ├── media.rs       валидация, хранение, ffmpeg-стикеры
│   ├── push.rs        RFC 8291 encryption + VAPID + curl delivery
│   └── messages.rs    транзакции, членство, DTO
├── middleware/
│   ├── auth.rs        Bearer JWT → Extension<AuthUser>, кэш сессии
│   ├── rate_limit.rs  Redis fixed-window middleware
│   └── security.rs
├── utils/
│   ├── error.rs       AppError (thiserror) + IntoResponse
│   ├── password.rs    Argon2id hash/verify
│   ├── jwt.rs         encode/decode claims
│   ├── validation.rs  username, сообщения, лимиты
│   └── pagination.rs  limit/offset/before_id
├── state.rs           AppState
└── ws.rs              WsManager + RealtimeHub + /ws + call relay
```

Контроллеры не содержат SQL. Сервисы не знают про `StatusCode` и типы Axum.
SQL — только в сервисах, через `sqlx::query!` / `query_as!` (compile-time
проверка схемы) с bind-параметрами.

## 3. Модель данных

Миграции: [`0001_schema.sql`](../migrations/0001_schema.sql),
[`0002_triggers.sql`](../migrations/0002_triggers.sql) и
[`0003_media.sql`](../migrations/0003_media.sql) и
[`0004_push_stickers.sql`](../migrations/0004_push_stickers.sql).

| Таблица | Назначение | Ключевые решения |
|---|---|---|
| `users` | аккаунты | username/email уникальны без учёта регистра (индексы по `lower()`), Argon2id-хэш |
| `chats` | диалоги и группы | `kind = private \| group`; у личного чата `title = NULL`, имя берётся у собеседника |
| `chat_members` | участие | PK `(chat_id, user_id)`, роль, watermark прочтения `last_read_message_id` |
| `messages` | сообщения | soft delete `deleted_at`, `reply_to_id`, id монотонно растут |
| `sessions` | refresh-сессии | хранится только SHA-256 от refresh-токена; отзыв через `revoked_at` |
| `attachments` | фото/видео/голос/файлы/стикеры | `message_id` nullable до отправки, `storage_key`, `thumbnail_key`, метаданные |
| `push_subscriptions` | Web Push подписки | endpoint unique, p256dh/auth, user_agent |

Денормализации и инварианты:

* `chats.private_key` = `"<min(user_id)>:<max(user_id)>"`. Уникальный частичный
  индекс делает создание личного чата идемпотентным:
  `INSERT ... ON CONFLICT (private_key) DO NOTHING` + `SELECT`.
* `chats.last_message_id / last_message_at` обновляются **только триггерами** в
  той же транзакции, что и вставка/удаление сообщения. Гонка «удалили последнее
  сообщение, пока приходило новое» разрешается блокировкой строки чата и
  монотонным условием `NEW.id > last_message_id`.
* `chat_members.last_read_message_id` — watermark, обновляется только вверх.
  Непрочитанные считаются как `count(*) WHERE id > watermark AND sender_id <> me`.
* `chat_members` имеет частичный уникальный индекс «один owner на чат».
* Мягко удалённое сообщение остаётся tombstone-ом (`content = ''`,
  `deleted_at NOT NULL`) и не двигает `last_message_id` назад.
* Вложение создаётся до сообщения (`message_id IS NULL`) и привязывается к нему
  в одной транзакции; `messages.has_attachment` разрешает пустой caption.
* Файлы лежат в `UPLOAD_DIR` под случайными именами; в БД — ключ и метаданные.

Идентификаторы — `BIGINT GENERATED ALWAYS AS IDENTITY` (int64, как в Telegram).

## 4. Аутентификация и сессии

```
POST /api/auth/register ──► users + sessions(refresh_hash) ──► access JWT + Set-Cookie(refresh)
POST /api/auth/login    ──► verify Argon2id ────────────────► access JWT + Set-Cookie(refresh)
POST /api/auth/refresh  ──► rotate refresh (hash swap) ─────► новый access JWT + новая cookie
POST /api/auth/logout   ──► revoked_at = now(), DEL redis-кэша, очистка cookie
```

* **Access token**: JWT HS256, TTL 15 минут, claims `sub` (user id), `sid`
  (session id), `username`, `iss`, `iat`, `exp`. Хранится только в памяти JS —
  не в `localStorage`. После перезагрузки страницы фронтенд вызывает
  `/api/auth/refresh` (cookie уйдёт автоматически) и получает новый access.
* **Refresh token**: 256 бит CSPRNG, base64url, TTL 30 дней. В БД лежит SHA-256.
  Cookie: `HttpOnly; SameSite=Lax; Path=/api/auth; Secure` (Secure включается
  конфигом в production). Ротация при каждом refresh; повторное использование
  старого токена невозможно, потому что хэш перезаписан.
* **Middleware**: JWT-подпись/exp/iss → проверка сессии в Redis
  (`ct:sess:{sid}`, TTL 60 c) → при промахе запрос в `sessions` + `users` →
  `Extension<AuthUser>`. Logout удаляет ключ, поэтому окно устаревшего кэша
  ограничено 60 секундами; сама сессия в БД уже отозвана.
* CSRF: refresh/logout меняют состояние, но cookie `SameSite=Lax` не уходит на
  cross-site POST; CORS допускает только явно разрешённые origin.
* Медиа: HttpOnly-cookie `ct_media` (Path `/api/attachments`) с JWT на 24 ч;
  проверяется членство и `deleted_at IS NULL`. Для API-клиентов — Bearer.
* Микрофон/камера разрешены `Permissions-Policy` только для self; звонки и
  запись — только HTTPS/localhost.
* Web Push: VAPID ES256, RFC 8291 aes128gcm; приватный ключ только в env,
  endpoint проверяется на HTTPS, payload шифруется ключом подписки. Service
  worker не кэширует историю и показывает уведомление только когда нет
  видимой вкладки.
* Стикеры конвертируются на сервере ffmpeg в GIF (≤320 px, ≤5 секунд),
  исходный файл удаляется; в БД хранится только GIF.

Пароли: Argon2id (19 MiB, t=2, p=1, соль на пользователя), верификация
constant-time средствами `argon2`.

## 5. Realtime

**Handshake.** `GET /ws?token=<access_jwt>`. Браузерный WebSocket не умеет
заголовки, поэтому токен в query. Чтобы он не попадал в логи, span для WS
строится по path без query; токен живёт 15 минут. Проверяются Origin,
подпись JWT и сессия; при ошибке — HTTP 401 до upgrade.

**Соединение.** На каждое WS:
1. `ConnectionManager` регистрирует `conn_id → mpsc::Sender<ServerEvent>` и
   `chat_id → { conn_id }` (реестр подписок). У соединения ровно один
   исходящий канал, поэтому `select!` не разрастается с числом чатов.
2. Клиент присылает `subscribe` на чаты; сервер проверяет членство в БД.
3. `select!` обслуживает входящие кадры, исходящий mpsc и ping/pong
   (ping 30 c, таймаут 90 c; полный буфер соединения → разрыв 1013).
4. Отдельная задача-диспетчер получает realtime-события и раскладывает их по
   `mpsc::Sender` только тех соединений, которые подписаны на `chat_id`.

**Мультиинстансность.** Сервис после commit публикует событие в Redis-канал
`ct:events` (один канал на инсталляцию) и сразу же отдаёт его локальному
диспетчеру — это даёт нулевую задержку и работу в одиночном инстансе даже при
недоступном Redis. В событии есть `origin` (id инстанса): свой экземпляр
игнорирует вернувшееся из Pub/Sub событие, поэтому дублей нет. Каждый инстанс
фильтрует поток по своим локальным подпискам. Нагрузка на Pub/Sub растёт
линейно от числа событий; при необходимости канал шардируется по
`hash(chat_id) % N`, а фильтрация остаётся локальной. Удаление участника
публикуется в `ct:control`, чтобы сокеты на всех инстансах перестали получать
чат. HTTP-инстансы stateless, sticky sessions не нужны.

**События клиент → сервер**

```json
{"type":"subscribe","chat_id":42}
{"type":"unsubscribe","chat_id":42}
{"type":"read","chat_id":42,"message_id":1001}
{"type":"typing","chat_id":42}
{"type":"ping"}
```

**События сервер → клиент**

```json
{"type":"ready","user_id":7,"session_id":12}
{"type":"subscribed","chat_id":42}
{"type":"message.new","chat_id":42,"message":{...}}
{"type":"message.edited","chat_id":42,"message":{...}}
{"type":"message.deleted","chat_id":42,"message_id":1001}
{"type":"typing","chat_id":42,"user_id":9,"display_name":"Bob"}
{"type":"read.updated","chat_id":42,"user_id":9,"message_id":1000}
{"type":"chat.removed","chat_id":42}
{"type":"error","code":"not_a_member","message":"..."}
{"type":"pong"}
```

Гарантии: доставка at-least-once, порядок определяется монотонным `message.id`;
клиент дедуплицирует по id. При разрыве — exponential backoff с jitter и
дозагрузка истории `GET /api/chats/{id}/messages?after_id=...`. Событие
публикуется **после commit** транзакции: сначала локальному диспетчеру, затем
в Redis (best effort). Если Redis недоступен, БД остаётся корректной,
клиенты этого инстанса получают события, а остальные синхронизируются через
REST. Outbox-таблица — следующий шаг для строгой гарантии доставки.

## 6. HTTP API (контракт)

Все ответы — JSON в `snake_case`. Ошибки:

```json
{"error":{"code":"chat_not_found","message":"Чат не найден"}}
```

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| POST | `/api/auth/register` | — | `{username,password,display_name,email?}` → токены + cookie |
| POST | `/api/auth/login` | — | `{username,password}` → токены + cookie |
| POST | `/api/auth/refresh` | cookie | ротация refresh, новый access |
| POST | `/api/auth/logout` | Bearer + cookie | отзыв сессии |
| GET | `/api/users/me` | Bearer | профиль |
| PATCH | `/api/users/me` | Bearer | `display_name`, `bio`, `avatar_url` |
| GET | `/api/users/search?q=` | Bearer | поиск по username (prefix, limit 20) |
| GET | `/api/chats` | Bearer | список чатов: peer, last_message, unread_count |
| POST | `/api/chats/private` | Bearer | `{user_id}` → идемпотентный личный чат |
| POST | `/api/chats/group` | Bearer | `{title, member_ids[]}` → группа |
| GET | `/api/chats/{id}` | Bearer | карточка чата + участники |
| POST | `/api/chats/{id}/members` | Bearer | добавить участников (owner/admin) |
| DELETE | `/api/chats/{id}/members/{user_id}` | Bearer | выйти / удалить (правила ролей) |
| GET | `/api/chats/{id}/messages` | Bearer | `limit`, `offset`, `before_id`, `after_id` |
| POST | `/api/chats/{id}/messages` | Bearer | `{content, reply_to_id?}` |
| PATCH | `/api/messages/{id}` | Bearer | редактирование (только автор) |
| DELETE | `/api/messages/{id}` | Bearer | soft delete (автор или админ группы) |
| POST | `/api/chats/{id}/read` | Bearer | `{message_id}` — watermark |
| POST | `/api/chats/{id}/attachments` | Bearer | multipart: file, kind, thumbnail |
| GET | `/api/attachments/{id}/content` | media cookie/Bearer | файл с Range |
| GET | `/api/attachments/{id}/thumbnail` | media cookie/Bearer | превью |
| POST/DELETE | `/api/users/me/avatar` | Bearer | загрузка/удаление аватара |
| GET | `/api/push/public-key` | Bearer | VAPID public key |
| POST | `/api/push/subscribe` | Bearer | сохранить подписку |
| POST | `/api/push/unsubscribe` | Bearer | удалить подписку |
| GET | `/ws` | JWT query | WebSocket + call signaling + user.updated |

История: `limit` (1..100, default 50) + `before_id` (cursor, рекомендуется) или
`offset` (совместимость с ТЗ). Ответ `{items, has_more, next_before_id}`.

## 7. Redis: ключи и роли

| Ключ / канал | Тип | TTL | Назначение |
|---|---|---|---|
| `ct:sess:{session_id}` | string (`user_id`) | 60 c | быстрый allow в auth middleware |
| `ct:rl:{scope}:{subject}:{bucket}` | counter | окно | fixed-window rate limit (`auth:ip`, `api:ip`) |
| `ct:events` | pub/sub | — | fan-out realtime-событий между инстансами (origin-дедуп) |
| `ct:control` | pub/sub | — | eviction удалённых участников на всех инстансах |

Redis не хранит сообщения и не является источником истины. Потеря Redis
деградирует только realtime и rate limit (fail-open с записью в лог), но не
данные.

## 8. Ошибки и наблюдаемость

* `AppError` (thiserror) — единственный тип ошибки сервисов: `Unauthorized`,
  `Forbidden`, `NotFound`, `Conflict`, `Validation`, `RateLimited`,
  `Internal(anyhow::Error)`. `IntoResponse` отдаёт стабильный `code` и
  человекочитаемый `message`; внутренние детали пишутся в `tracing` и никогда
  не уходят клиенту.
* Никаких `.unwrap()`/`.expect()` в обработчиках и сервисах; только в
  `main`-bootstrap с понятным сообщением.
* `TraceLayer` + JSON-логи, request id, латентность; SQLx `slow`-логи по
  порогу; health endpoints `/health/live`, `/health/ready` (проверка Pg + Redis).
* Метрики (Prometheus) — за рамками MVP, но точки вставки — middleware.

## 9. Безопасность

* Все SQL-запросы — bind-параметры; compile-time проверка через `sqlx::query!`.
* Каждая операция над чатом/сообщением проверяет членство SQL-джойном, а не
  доверяет `chat_id` из запроса.
* Валидация: username `^[a-zA-Z0-9_]{3,32}$`, сообщение 1..4096 символов после
  trim, запрет пустых/управляющих символов, лимит участников группы.
* Rate limit: распределённый Redis fixed-window по IP; отдельный строгий
  лимит для auth-маршрутов, fail-open при недоступном Redis.
* CORS allowlist из конфига; security headers: CSP (без inline-скриптов, кроме
  разрешённого CDN Tailwind), `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`.
* Фронтенд рендерит текст сообщений через `textContent`, а не `innerHTML`.
* `ServeDir` защищён от path traversal самим tower-http; API и статика
  разнесены, SPA-fallback отдаёт только `index.html` для не-`/api` путей.

## 10. Конфигурация

Все значения читаются один раз в `config.rs` и валидируются на старте
(секрет ≥ 32 байт, URL парсятся, TTL > 0). Полный список — в
[`.env.example`](../.env.example). Секреты никогда не логируются.

## 11. Масштабирование и границы MVP

* HTTP-слой stateless → горизонтальное масштабирование за LB.
* WS: соединения живут на инстансах, события идут через Redis Pub/Sub.
* Postgres — узкое место записи; дальше: партиционирование `messages` по
  `chat_id`, реплики на чтение, вынос media в S3, outbox для realtime.
* Медиа хранится на локальном диске узла; для нескольких узлов нужен S3/MinIO
  или общий NFS. Звонки 1:1 работают через STUN; для сложного NAT — TURN.
* В MVP нет: каналов, ботов, историй, секретных чатов, облачных файлов 2 ГБ,
  групповых звонков, реакций, поиска по сообщениям, E2E-шифрования. Схема
  оставляет место для reactions/search. Web Push на iOS требует PWA.

## 12. Проверки

```bash
# 1. Схема (нужен пустой Postgres с применёнными миграциями)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/schema_smoke.sql

# 2. Компиляция с compile-time проверкой SQL
cargo check --all-targets

# 3. Форматирование и линты
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```
