#!/bin/bash
# ============================================================
# Интеграционный тест CipherTalk: регистрация, логин, чаты,
# сообщения, статика. Запуск: bash test_api.sh
# ============================================================
set -e
B=http://localhost:3000

echo "== GET / (статика index.html) =="
curl -s $B/ | head -8

echo; echo "== Регистрация alice =="
TOKEN_A=$(curl -s -X POST $B/api/register -d '{"username":"alice","password":"secret123","displayName":"Алиса"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
echo "token A: ${TOKEN_A:0:25}..."

echo "== Регистрация bob =="
TOKEN_B=$(curl -s -X POST $B/api/register -d '{"username":"bob","password":"secret456","displayName":"Боб"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
echo "token B: ${TOKEN_B:0:25}..."

echo "== Логин alice =="
curl -s -X POST $B/api/login -d '{"username":"alice","password":"secret123"}' | head -c 160; echo

echo "== /api/me =="
curl -s $B/api/me -H "Authorization: Bearer $TOKEN_A"; echo

echo "== Создание личного чата alice->bob =="
CHAT=$(curl -s -X POST $B/api/chats -H "Authorization: Bearer $TOKEN_A" -d '{"withUserId":2}')
echo "$CHAT"
CID=$(echo "$CHAT" | python3 -c "import sys,json;print(json.load(sys.stdin)['chatId'])")

echo "== Отправка сообщения от alice =="
curl -s -X POST $B/api/messages -H "Authorization: Bearer $TOKEN_A" \
  -d "{\"chatId\":$CID,\"text\":\"Привет, Боб\"}"; echo

echo "== Ответное сообщение от bob =="
curl -s -X POST $B/api/messages -H "Authorization: Bearer $TOKEN_B" \
  -d "{\"chatId\":$CID,\"text\":\"Здравствуй, Алиса\"}"; echo

echo "== История сообщений (взгляд bob) =="
curl -s "$B/api/messages?chatId=$CID" -H "Authorization: Bearer $TOKEN_B"; echo

echo "== Список чатов bob =="
curl -s $B/api/chats -H "Authorization: Bearer $TOKEN_B"; echo

echo "== Список пользователей =="
curl -s $B/api/users -H "Authorization: Bearer $TOKEN_A"; echo

echo "== Невалидный токен -> 401 =="
curl -s -o /dev/null -w "%{http_code}\n" $B/api/chats -H "Authorization: Bearer bad.token.here"

echo "DONE"
