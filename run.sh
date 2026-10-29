#!/usr/bin/env bash
# Единый запуск: поднимает rqlite (если не поднят) и сервер мессенджера.
set -euo pipefail

RQLITE_URL=${RQLITE_URL:-http://localhost:4001}
PORT=${PORT:-3000}
JWT_SECRET=${JWT_SECRET:-dev-secret-change-me}

echo "==> Проверяю rqlite на $RQLITE_URL"
if ! curl -sf "$RQLITE_URL/readyz" >/dev/null 2>&1; then
  echo "==> rqlite не запущен, стартую..."
  if command -v docker >/dev/null 2>&1; then
    docker rm -f ciphertalk-rqlite >/dev/null 2>&1 || true
    docker run -d --name ciphertalk-rqlite -p 4001:4001 rqlite/rqlite >/dev/null
  elif command -v rqlited >/dev/null 2>&1; then
    mkdir -p ./data-rqlite
    nohup rqlited -node-id 1 ./data-rqlite >/tmp/rqlite.log 2>&1 &
  elif [ -x ./rqlited ]; then
    # локально скачанный бинарник (см. README — раздел «без docker»)
    mkdir -p ./data-rqlite
    nohup ./rqlited -node-id 1 ./data-rqlite >/tmp/rqlite.log 2>&1 &
  else
    echo "Нет docker и нет rqlited. Установи docker или скачай rqlited:" >&2
    echo "  https://github.com/rqlite/rqlite/releases" >&2
    exit 1
  fi
  echo -n "==> Жду готовности rqlite"
  for i in $(seq 1 30); do
    if curl -sf "$RQLITE_URL/readyz" >/dev/null 2>&1; then echo " OK"; break; fi
    echo -n "."; sleep 1
  done
  curl -sf "$RQLITE_URL/readyz" >/dev/null || { echo " rqlite не поднялся"; exit 1; }
else
  echo "==> rqlite уже работает"
fi

echo "==> Собираю мессенджер (release)"
cargo build --release

echo "==> Запускаю сервер на http://localhost:$PORT"
echo "    Открой в браузере: http://localhost:$PORT/"
PORT="$PORT" JWT_SECRET="$JWT_SECRET" RQLITE_URL="$RQLITE_URL" \
  exec ./target/release/messenger
