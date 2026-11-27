-- ============================================================================
-- CipherTalk — Web Push subscriptions and GIF stickers
-- ============================================================================

ALTER TABLE attachments
    DROP CONSTRAINT IF EXISTS attachments_kind_valid;

ALTER TABLE attachments
    ADD CONSTRAINT attachments_kind_valid
    CHECK (kind IN ('photo', 'video', 'voice', 'file', 'sticker'));

CREATE TABLE push_subscriptions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint    TEXT        NOT NULL UNIQUE,
    p256dh      TEXT        NOT NULL,
    auth        TEXT        NOT NULL,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT push_endpoint_len CHECK (char_length(endpoint) BETWEEN 12 AND 2048),
    CONSTRAINT push_p256dh_len  CHECK (char_length(p256dh) BETWEEN 80 AND 100),
    CONSTRAINT push_auth_len    CHECK (char_length(auth) BETWEEN 20 AND 36)
);

CREATE INDEX push_subscriptions_user_idx
    ON push_subscriptions (user_id);
