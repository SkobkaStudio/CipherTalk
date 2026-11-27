-- ============================================================================
-- CipherTalk — media attachments
--
-- A message may contain text, one attachment, or both. Uploads are created
-- first (attachments.message_id IS NULL), then linked atomically when the
-- message is sent. Pending uploads can be garbage-collected later.
-- ============================================================================

ALTER TABLE messages
    ADD COLUMN has_attachment BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_content_not_blank;

ALTER TABLE messages
    ADD CONSTRAINT messages_content_not_blank
    CHECK (
        deleted_at IS NOT NULL
        OR has_attachment
        OR char_length(btrim(content)) > 0
    );

CREATE TABLE attachments (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uploader_id   BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id       BIGINT      NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    message_id    BIGINT      UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
    kind          TEXT        NOT NULL,
    file_name     TEXT        NOT NULL,
    mime_type     TEXT        NOT NULL,
    size_bytes    BIGINT      NOT NULL,
    width         INTEGER,
    height        INTEGER,
    duration_ms   INTEGER,
    storage_key   TEXT        NOT NULL UNIQUE,
    thumbnail_key TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT attachments_kind_valid
        CHECK (kind IN ('photo', 'video', 'voice', 'file')),
    CONSTRAINT attachments_size_valid
        CHECK (size_bytes > 0 AND size_bytes <= 104857600),
    CONSTRAINT attachments_file_name_len
        CHECK (char_length(file_name) BETWEEN 1 AND 255),
    CONSTRAINT attachments_dimensions_valid
        CHECK (
            (width IS NULL OR width > 0)
            AND (height IS NULL OR height > 0)
            AND (duration_ms IS NULL OR duration_ms >= 0)
        )
);

-- The UNIQUE(message_id) index already covers lookup by message.
CREATE INDEX attachments_chat_id_idx
    ON attachments (chat_id, created_at DESC);

-- Pending uploads: uploaded but never attached to a message.
CREATE INDEX attachments_pending_idx
    ON attachments (uploader_id, created_at)
    WHERE message_id IS NULL;
