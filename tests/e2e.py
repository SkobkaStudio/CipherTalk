#!/usr/bin/env python3
"""End-to-end smoke test for CipherTalk (HTTP + WebSocket).

Run against a live server:
    BASE_URL=http://127.0.0.1:8080 python3 tests/e2e.py

Requires: requests, websockets.
Creates throwaway users with a random suffix; safe to run repeatedly.
"""
import asyncio
import json
import os
import random
import string
import sys
import time

import requests
import websockets

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8080")
SUFFIX = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
PASSWORD = "correct-Horse-42!"


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"  ok: {message}")


def register(session, username, display_name):
    response = session.post(
        f"{BASE}/api/auth/register",
        json={
            "username": username,
            "password": PASSWORD,
            "display_name": display_name,
            "email": f"{username}@example.com",
        },
        timeout=15,
    )
    if response.status_code != 200:
        raise AssertionError(f"register {username}: {response.status_code} {response.text}")
    data = response.json()
    check("access_token" in data, f"register {username} returns access token")
    check(
        "ct_refresh" in session.cookies,
        f"register {username} sets refresh cookie",
    )
    return data


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def ws_url(token):
    scheme = "wss" if BASE.startswith("https") else "ws"
    host = BASE.split("://", 1)[1]
    return f"{scheme}://{host}/ws?token={token}"


async def recv_json(ws, timeout=6):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def wait_for(ws, event_type, timeout=6):
    """Consume events until the requested type arrives (ignoring echoes)."""
    while True:
        event = await recv_json(ws, timeout=timeout)
        if event.get("type") == event_type:
            return event


async def websocket_checks(alice, bob, chat_id, message_id):
    alice_ws = await websockets.connect(ws_url(alice["access_token"]))
    bob_ws = await websockets.connect(ws_url(bob["access_token"]))
    try:
        ready_a = await recv_json(alice_ws)
        check(ready_a["type"] == "ready", "alice websocket ready")
        ready_b = await recv_json(bob_ws)
        check(ready_b["type"] == "ready", "bob websocket ready")

        for ws in (alice_ws, bob_ws):
            await ws.send(json.dumps({"type": "subscribe", "chat_id": chat_id}))
        await wait_for(alice_ws, "subscribed")
        await wait_for(bob_ws, "subscribed")

        # Bob types and Alice receives the ephemeral event.
        await bob_ws.send(json.dumps({"type": "typing", "chat_id": chat_id}))
        typing = await wait_for(alice_ws, "typing")
        check(
            typing["type"] == "typing" and typing["user_id"] == bob["user"]["id"],
            "alice receives bob typing event",
        )

        # Alice sends a message over HTTP; it must arrive over WS.
        response = requests.post(
            f"{BASE}/api/chats/{chat_id}/messages",
            headers={**auth(alice["access_token"]), "Content-Type": "application/json"},
            json={"content": "realtime hello"},
            timeout=15,
        )
        check(response.status_code == 201, "alice sends realtime message")
        new_message = response.json()

        event = await wait_for(bob_ws, "message.new")
        check(
            event["type"] == "message.new" and event["message"]["id"] == new_message["id"],
            "bob receives message.new in realtime",
        )

        # Read receipt flows back to Alice.
        await bob_ws.send(
            json.dumps(
                {
                    "type": "read",
                    "chat_id": chat_id,
                    "message_id": new_message["id"],
                }
            )
        )
        read_event = await wait_for(alice_ws, "read.updated")
        check(
            read_event["type"] == "read.updated" and read_event["user_id"] == bob["user"]["id"],
            "alice receives read.updated",
        )

        # Ping/pong.
        await alice_ws.send(json.dumps({"type": "ping"}))
        await wait_for(alice_ws, "pong")
    finally:
        await alice_ws.close()
        await bob_ws.close()


async def group_removal_checks(alice, bob, group_id):
    bob_ws = await websockets.connect(ws_url(bob["access_token"]))
    try:
        await wait_for(bob_ws, "ready")
        await bob_ws.send(json.dumps({"type": "subscribe", "chat_id": group_id}))
        await wait_for(bob_ws, "subscribed")

        response = requests.delete(
            f"{BASE}/api/chats/{group_id}/members/{bob['user']['id']}",
            headers=auth(alice["access_token"]),
            timeout=15,
        )
        check(response.status_code == 200, "owner removes Bob from group")
        removed = await wait_for(bob_ws, "chat.removed")
        check(removed["chat_id"] == group_id, "Bob receives chat.removed")

        response = requests.post(
            f"{BASE}/api/chats/{group_id}/messages",
            headers={**auth(alice["access_token"]), "Content-Type": "application/json"},
            json={"content": "after removal"},
            timeout=15,
        )
        check(response.status_code == 201, "owner can still post after removal")
        try:
            leaked = await recv_json(bob_ws, timeout=1.2)
            raise AssertionError(f"removed member still receives realtime events: {leaked}")
        except asyncio.TimeoutError:
            check(True, "removed member receives no further realtime events")

        denied = requests.get(
            f"{BASE}/api/chats/{group_id}/messages",
            headers=auth(bob["access_token"]),
            timeout=15,
        )
        check(denied.status_code == 404, "removed member cannot read group history")
    finally:
        await bob_ws.close()


def main():
    print(f"E2E against {BASE} (suffix {SUFFIX})")

    alice_name = f"alice_{SUFFIX}"
    bob_name = f"bob_{SUFFIX}"
    charlie_name = f"charlie_{SUFFIX}"

    alice_s = requests.Session()
    bob_s = requests.Session()
    charlie_s = requests.Session()

    alice = register(alice_s, alice_name, "Alice")
    bob = register(bob_s, bob_name, "Bob")
    charlie = register(charlie_s, charlie_name, "Charlie")

    # Session restore through the HttpOnly refresh cookie.
    refreshed = alice_s.post(f"{BASE}/api/auth/refresh", timeout=15)
    check(refreshed.status_code == 200, "refresh via cookie works")
    alice_token = refreshed.json()["access_token"]

    me = requests.get(f"{BASE}/api/users/me", headers=auth(alice_token), timeout=15)
    check(me.status_code == 200 and me.json()["username"] == alice_name, "GET /users/me")

    search = requests.get(
        f"{BASE}/api/users/search",
        params={"q": bob_name[:8]},
        headers=auth(alice_token),
        timeout=15,
    )
    check(search.status_code == 200, "user search works")
    check(
        any(user["id"] == bob["user"]["id"] for user in search.json()),
        "search finds Bob",
    )

    create = requests.post(
        f"{BASE}/api/chats/private",
        headers=auth(alice_token),
        json={"user_id": bob["user"]["id"]},
        timeout=15,
    )
    check(create.status_code == 200, f"create private chat ({create.text[:120]})")
    chat = create.json()
    chat_id = chat["id"]
    check(chat["kind"] == "private" and chat["peer"]["id"] == bob["user"]["id"], "private chat peer")

    # Idempotent DM creation.
    again = requests.post(
        f"{BASE}/api/chats/private",
        headers=auth(bob["access_token"]),
        json={"user_id": alice["user"]["id"]},
        timeout=15,
    )
    check(again.status_code == 200 and again.json()["id"] == chat_id, "private chat is idempotent")

    send = requests.post(
        f"{BASE}/api/chats/{chat_id}/messages",
        headers={**auth(alice["access_token"]), "Content-Type": "application/json"},
        json={"content": "Hello Bob"},
        timeout=15,
    )
    check(send.status_code == 201, f"send message ({send.text[:120]})")
    message = send.json()
    check(message["sender"]["username"] == alice_name, "message sender is Alice")

    chats = requests.get(f"{BASE}/api/chats", headers=auth(bob["access_token"]), timeout=15)
    check(chats.status_code == 200, "chat list works")
    bob_chat = next((c for c in chats.json()["items"] if c["id"] == chat_id), None)
    check(bob_chat is not None, "Bob sees the chat")
    check(bob_chat["unread_count"] == 1, "unread count is 1 for Bob")

    history = requests.get(
        f"{BASE}/api/chats/{chat_id}/messages",
        headers=auth(bob["access_token"]),
        timeout=15,
    )
    check(history.status_code == 200, "history works")
    page = history.json()
    check(page["items"][-1]["id"] == message["id"], "history contains the message")

    read = requests.post(
        f"{BASE}/api/chats/{chat_id}/read",
        headers=auth(bob["access_token"]),
        json={"message_id": message["id"]},
        timeout=15,
    )
    check(read.status_code == 200, "mark read works")

    chats = requests.get(f"{BASE}/api/chats", headers=auth(bob["access_token"]), timeout=15)
    bob_chat = next(c for c in chats.json()["items"] if c["id"] == chat_id)
    check(bob_chat["unread_count"] == 0, "unread count cleared")

    edit = requests.patch(
        f"{BASE}/api/messages/{message['id']}",
        headers={**auth(alice["access_token"]), "Content-Type": "application/json"},
        json={"content": "Hello Bob (edited)"},
        timeout=15,
    )
    check(edit.status_code == 200 and edit.json()["edited_at"], "edit message works")

    forbidden = requests.delete(
        f"{BASE}/api/messages/{message['id']}",
        headers=auth(bob["access_token"]),
        timeout=15,
    )
    check(forbidden.status_code == 403, "Bob cannot delete Alice's message")

    outsider = requests.get(
        f"{BASE}/api/chats/{chat_id}",
        headers=auth(charlie["access_token"]),
        timeout=15,
    )
    check(outsider.status_code == 404, "non-member cannot read the chat")

    deleted = requests.delete(
        f"{BASE}/api/messages/{message['id']}",
        headers=auth(alice["access_token"]),
        timeout=15,
    )
    check(deleted.status_code == 200 and deleted.json()["is_deleted"], "soft delete works")

    group = requests.post(
        f"{BASE}/api/chats/group",
        headers={**auth(alice["access_token"]), "Content-Type": "application/json"},
        json={"title": f"Rust {SUFFIX}", "member_ids": [bob["user"]["id"]]},
        timeout=15,
    )
    check(group.status_code == 201, f"create group ({group.text[:120]})")
    group_id = group.json()["id"]
    check(group.json()["my_role"] == "owner", "creator is group owner")

    group_send = requests.post(
        f"{BASE}/api/chats/{group_id}/messages",
        headers={**auth(bob["access_token"]), "Content-Type": "application/json"},
        json={"content": "group hello"},
        timeout=15,
    )
    check(group_send.status_code == 201, "group message works")

    reply = requests.post(
        f"{BASE}/api/chats/{group_id}/messages",
        headers={**auth(alice["access_token"]), "Content-Type": "application/json"},
        json={"content": "reply", "reply_to_id": group_send.json()["id"]},
        timeout=15,
    )
    check(
        reply.status_code == 201 and reply.json()["reply_to"]["id"] == group_send.json()["id"],
        "reply preview works",
    )

    asyncio.run(websocket_checks(alice, bob, chat_id, message["id"]))
    asyncio.run(group_removal_checks(alice, bob, group_id))

    logout = alice_s.post(
        f"{BASE}/api/auth/logout",
        headers=auth(alice["access_token"]),
        timeout=15,
    )
    check(logout.status_code == 200, "logout works")

    after_logout = requests.get(
        f"{BASE}/api/users/me",
        headers=auth(alice["access_token"]),
        timeout=15,
    )
    check(after_logout.status_code == 401, "access token is revoked after logout")

    refresh_after_logout = alice_s.post(f"{BASE}/api/auth/refresh", timeout=15)
    check(refresh_after_logout.status_code == 401, "refresh is revoked after logout")

    print("\nE2E PASSED")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"\nE2E FAILED: {exc}")
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001 - test script
        print(f"\nE2E ERROR: {type(exc).__name__}: {exc}")
        sys.exit(2)
