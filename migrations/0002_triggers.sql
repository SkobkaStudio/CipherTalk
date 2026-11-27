-- ============================================================================
-- CipherTalk — integrity triggers
--
-- All denormalised chat state is maintained here, inside the same transaction
-- as the message write. Application code never updates `chats.last_message_*`
-- directly, which keeps the chat list consistent even under concurrent sends.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Generic updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER chats_set_updated_at
    BEFORE UPDATE ON chats
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- New message:
--   1. advance the chat's last-message pointer (monotonic, race-safe);
--   2. mark the message as read for its own sender.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION on_message_inserted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE chats
       SET last_message_id = NEW.id,
           last_message_at = NEW.created_at
     WHERE id = NEW.chat_id
       AND (last_message_id IS NULL OR NEW.id > last_message_id);

    -- Sending implies reading everything up to your own message.
    UPDATE chat_members
       SET last_read_message_id = NEW.id
     WHERE chat_id = NEW.chat_id
       AND user_id = NEW.sender_id
       AND (last_read_message_id IS NULL OR last_read_message_id < NEW.id);

    RETURN NULL;
END;
$$;

CREATE TRIGGER messages_after_insert
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION on_message_inserted();

-- ---------------------------------------------------------------------------
-- Soft delete: if the deleted row was the chat's last message, recompute the
-- pointer. The chat row is locked first so a concurrent insert cannot lose
-- its update; the insert trigger's `NEW.id > last_message_id` guard wins in
-- the opposite ordering.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION on_message_updated()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    next_last_id BIGINT;
    next_last_at TIMESTAMPTZ;
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        -- Serialise pointer maintenance per chat.
        PERFORM 1 FROM chats WHERE id = NEW.chat_id FOR UPDATE;

        IF EXISTS (
            SELECT 1
              FROM chats
             WHERE id = NEW.chat_id
               AND last_message_id = NEW.id
        ) THEN
            SELECT m.id, m.created_at
              INTO next_last_id, next_last_at
              FROM messages m
             WHERE m.chat_id = NEW.chat_id
               AND m.deleted_at IS NULL
             ORDER BY m.id DESC
             LIMIT 1;

            UPDATE chats
               SET last_message_id = next_last_id,
                   last_message_at = COALESCE(next_last_at, created_at)
             WHERE id = NEW.chat_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER messages_after_update
    AFTER UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION on_message_updated();
