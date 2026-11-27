-- ============================================================================
-- Schema smoke test.
--
-- Applies no DDL itself: run it against a scratch database that already has
-- ./migrations applied. Everything happens inside one transaction and is
-- rolled back, so it is safe to re-run.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/schema_smoke.sql
-- ============================================================================
BEGIN;

DO $$
DECLARE
    alice_id         BIGINT;
    bob_id           BIGINT;
    group_id         BIGINT;
    dm_id            BIGINT;
    first_msg        BIGINT;
    second_msg       BIGINT;
    dm_key           TEXT;
    pointer          BIGINT;
    watermark        BIGINT;
BEGIN
    INSERT INTO users (username, email, password_hash, display_name)
    VALUES ('alice', 'alice@example.com', 'not-a-real-hash', 'Alice')
    RETURNING id INTO alice_id;

    INSERT INTO users (username, password_hash, display_name)
    VALUES ('bob', 'not-a-real-hash', 'Bob')
    RETURNING id INTO bob_id;

    -- --- group chat + membership -----------------------------------------
    INSERT INTO chats (kind, title, description, created_by)
    VALUES ('group', 'Rust Talk', 'schema smoke test', alice_id)
    RETURNING id INTO group_id;

    INSERT INTO chat_members (chat_id, user_id, role)
    VALUES (group_id, alice_id, 'owner'),
           (group_id, bob_id, 'member');

    -- --- message insert trigger ------------------------------------------
    INSERT INTO messages (chat_id, sender_id, content)
    VALUES (group_id, alice_id, 'hello')
    RETURNING id INTO first_msg;

    SELECT last_message_id INTO pointer FROM chats WHERE id = group_id;
    ASSERT pointer = first_msg, 'chat.last_message_id was not advanced on insert';

    SELECT last_read_message_id INTO watermark
      FROM chat_members WHERE chat_id = group_id AND user_id = alice_id;
    ASSERT watermark = first_msg, 'sender read watermark was not advanced on insert';

    INSERT INTO messages (chat_id, sender_id, content, reply_to_id)
    VALUES (group_id, bob_id, 'hi', first_msg)
    RETURNING id INTO second_msg;

    SELECT last_read_message_id INTO watermark
      FROM chat_members WHERE chat_id = group_id AND user_id = bob_id;
    ASSERT watermark = second_msg, 'reply author read watermark was not advanced';

    -- --- soft delete must roll the last-message pointer back --------------
    UPDATE messages SET deleted_at = now(), content = ''
     WHERE id = second_msg;

    SELECT last_message_id INTO pointer FROM chats WHERE id = group_id;
    ASSERT pointer = first_msg, 'last_message_id was not recomputed after soft delete';

    -- --- private-chat dedup key -------------------------------------------
    dm_key := LEAST(alice_id, bob_id)::text || ':' || GREATEST(alice_id, bob_id)::text;

    INSERT INTO chats (kind, private_key, created_by)
    VALUES ('private', dm_key, alice_id)
    RETURNING id INTO dm_id;

    INSERT INTO chat_members (chat_id, user_id, role)
    VALUES (dm_id, alice_id, 'member'),
           (dm_id, bob_id, 'member');

    BEGIN
        INSERT INTO chats (kind, private_key, created_by)
        VALUES ('private', dm_key, bob_id);
        RAISE EXCEPTION 'duplicate private chat was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL; -- expected
    END;

    -- --- case-insensitive username uniqueness -----------------------------
    BEGIN
        INSERT INTO users (username, password_hash, display_name)
        VALUES ('ALICE', 'not-a-real-hash', 'Clone');
        RAISE EXCEPTION 'case-insensitive username duplicate was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL; -- expected
    END;

    -- --- live messages cannot be blank ------------------------------------
    BEGIN
        INSERT INTO messages (chat_id, sender_id, content)
        VALUES (group_id, alice_id, '    ');
        RAISE EXCEPTION 'blank live message was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL; -- expected
    END;

    -- --- only one owner per chat ------------------------------------------
    BEGIN
        UPDATE chat_members SET role = 'owner'
         WHERE chat_id = group_id AND user_id = bob_id;
        RAISE EXCEPTION 'second chat owner was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL; -- expected
    END;

    -- --- sessions ---------------------------------------------------------
    INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
    VALUES (alice_id, repeat('a', 64), now() + interval '30 days');
END;
$$;

-- Keep the scratch database clean.
ROLLBACK;
