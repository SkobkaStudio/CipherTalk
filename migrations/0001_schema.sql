-- ============================================================================
-- CipherTalk — core relational schema (PostgreSQL 16+)
--
-- Design notes
--   * BIGINT identity keys mirror Telegram's int64 ids and keep WS payloads
--     compact. No UUIDs in hot paths.
--   * Soft deletes are used for messages only (`deleted_at`); membership and
--     chats are hard-deleted with explicit service-level rules.
--   * Private chats are deduplicated by `private_key` ("min_id:max_id"), which
--     makes "open DM with user X" an idempotent INSERT .. ON CONFLICT.
--   * Read state is stored per member as a watermark (`last_read_message_id`),
--     exactly like Telegram: update-only, monotonically increasing.
--   * `chats.last_message_*` is denormalised for the chat-list query. It is
--     maintained exclusively by triggers in 0002_triggers.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT        NOT NULL,
    email         TEXT,
    password_hash TEXT        NOT NULL,
    display_name  TEXT        NOT NULL,
    bio           TEXT        NOT NULL DEFAULT '',
    avatar_url    TEXT,
    last_seen_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_username_format
        CHECK (username ~ '^[A-Za-z0-9_]{3,32}$'),
    CONSTRAINT users_display_name_len
        CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 64),
    CONSTRAINT users_bio_len
        CHECK (char_length(bio) <= 280),
    CONSTRAINT users_email_format
        CHECK (
            email IS NULL
            OR (
                char_length(email) <= 254
                AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
            )
        )
);

-- Usernames and emails are case-insensitive (stored lowercased by services,
-- but the DB is the final guard against races and manual SQL).
CREATE UNIQUE INDEX users_username_lower_uniq ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email)) WHERE email IS NOT NULL;

-- Prefix search (`GET /api/users/search?q=`) on a non-C locale needs
-- text_pattern_ops to use an index for `lower(username) LIKE 'q%'`.
CREATE INDEX users_username_prefix_idx ON users (lower(username) text_pattern_ops);

-- ---------------------------------------------------------------------------
-- chats
-- ---------------------------------------------------------------------------
CREATE TABLE chats (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind            TEXT        NOT NULL,
    title           TEXT,
    description     TEXT        NOT NULL DEFAULT '',
    avatar_url      TEXT,
    private_key     TEXT,
    created_by      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    last_message_id BIGINT,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chats_kind_valid
        CHECK (kind IN ('private', 'group')),
    CONSTRAINT chats_title_len
        CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 128),
    CONSTRAINT chats_description_len
        CHECK (char_length(description) <= 512),
    CONSTRAINT chats_private_key_format
        CHECK (private_key IS NULL OR private_key ~ '^[0-9]+:[0-9]+$'),
    -- Canonical ordering is part of the contract: "min_id:max_id".
    CONSTRAINT chats_private_key_canonical
        CHECK (
            private_key IS NULL
            OR split_part(private_key, ':', 1)::BIGINT < split_part(private_key, ':', 2)::BIGINT
        ),
    -- Private chats have no title (it is derived from the peer) and always
    -- carry a dedup key; groups always have a title and never a dedup key.
    CONSTRAINT chats_shape
        CHECK (
            (kind = 'private' AND private_key IS NOT NULL AND title IS NULL)
            OR
            (kind = 'group' AND private_key IS NULL AND title IS NOT NULL)
        )
);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chat_id     BIGINT      NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    sender_id   BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    content     TEXT        NOT NULL,
    reply_to_id BIGINT      REFERENCES messages (id) ON DELETE SET NULL,
    edited_at   TIMESTAMPTZ,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT messages_content_len
        CHECK (char_length(content) <= 4096),
    -- A tombstone may carry an empty body; a live message may not.
    CONSTRAINT messages_content_not_blank
        CHECK (deleted_at IS NOT NULL OR char_length(btrim(content)) > 0)
);

-- Circular reference: chats.last_message_id -> messages.id. Kept as a
-- separate ALTER so that both tables can be created in dependency order.
ALTER TABLE chats
    ADD CONSTRAINT chats_last_message_fk
    FOREIGN KEY (last_message_id) REFERENCES messages (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- chat_members
-- ---------------------------------------------------------------------------
CREATE TABLE chat_members (
    chat_id              BIGINT      NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    user_id              BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role                 TEXT        NOT NULL DEFAULT 'member',
    last_read_message_id BIGINT      REFERENCES messages (id) ON DELETE SET NULL,
    joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    muted_until          TIMESTAMPTZ,

    PRIMARY KEY (chat_id, user_id),
    CONSTRAINT chat_members_role_valid
        CHECK (role IN ('owner', 'admin', 'member'))
);

-- ---------------------------------------------------------------------------
-- sessions (refresh-token rotation + revocation list)
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id            BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    refresh_token_hash TEXT        NOT NULL,
    user_agent         TEXT        NOT NULL DEFAULT '',
    ip_address         INET,
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sessions_refresh_hash_uniq UNIQUE (refresh_token_hash),
    CONSTRAINT sessions_token_hash_len CHECK (char_length(refresh_token_hash) = 64)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Private-chat deduplication (only applicable to kind = 'private').
CREATE UNIQUE INDEX chats_private_key_uniq
    ON chats (private_key) WHERE private_key IS NOT NULL;

-- Chat list: most recently active first.
CREATE INDEX chats_activity_idx ON chats (last_message_at DESC, id DESC);

-- History pagination: WHERE chat_id = $1 AND id < $cursor ORDER BY id DESC.
CREATE INDEX messages_chat_id_idx ON messages (chat_id, id DESC);
CREATE INDEX messages_sender_idx ON messages (sender_id) WHERE sender_id IS NOT NULL;
CREATE INDEX messages_reply_to_idx ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;

-- "Chats of user" and membership checks.
CREATE INDEX chat_members_user_idx ON chat_members (user_id, chat_id);

-- At most one owner per chat (groups); partial unique index doubles as a
-- cheap constraint for ownership-transfer flows.
CREATE UNIQUE INDEX chat_members_single_owner_idx
    ON chat_members (chat_id) WHERE role = 'owner';

-- Session lookup / cleanup.
CREATE INDEX sessions_user_active_idx
    ON sessions (user_id, last_used_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx
    ON sessions (expires_at) WHERE revoked_at IS NULL;
