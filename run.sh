#!/usr/bin/env bash
# Единый запуск: поднимает rqlite (если не поднят) и сервер мессенджера.
#
# Флаги обновления кода (можно комбинировать с любыми другими флагами):
#   ./run.sh -u -dev    — скачивает код с ветки dev-rust-v и перезапускает
#   ./run.sh -u -main   — скачивает код с ветки main и пересобирает/перезапускает
#
# Порядок важен: сначала все флаги, потом запуск. После успешного обновления
# скрипт сам перезапускается без флагов, чтобы запустить свежий run.sh из репо.
set -euo pipefail

RQLITE_URL=${RQLITE_URL:-http://localhost:4001}
PORT=${PORT:-3000}
# Секрет JWT намеренно НЕ имеет дефолта из репозитория: с публично известным
# секретом любой мог бы подписать токен на чужой id. Если JWT_SECRET не задан,
# берём локальный файл .jwt_secret, а если его нет — генерируем (chmod 600).
JWT_SECRET_FILE=${JWT_SECRET_FILE:-.jwt_secret}
RQLITED_VERSION=${RQLITED_VERSION:-v10.6.6}

REPO_URL="https://github.com/SkobkaStudio/CipherTalk.git"
DO_UPDATE=false
UPDATE_BRANCH=""

# ─── разбор флагов ────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    -u|--update)     DO_UPDATE=true ;;
    -dev)            UPDATE_BRANCH="dev-rust-v" ;;
    -main)           UPDATE_BRANCH="main" ;;
    -h|--help)
      echo "Использование: ./run.sh [-u -dev | -u -main]"
      echo "  без флагов   — обычный запуск (rqlite + сборка + сервер)"
      echo "  -u -dev      — обновить код с ветки dev-rust-v и запустить"
      echo "  -u -main     — обновить код с ветки main и запустить"
      exit 0 ;;
    *)
      echo "Неизвестный флаг: $arg (справка: ./run.sh --help)" >&2
      exit 1 ;;
  esac
done

if [ "$DO_UPDATE" = true ] && [ -z "$UPDATE_BRANCH" ]; then
  echo "Укажи ветку: ./run.sh -u -dev  или  ./run.sh -u -main" >&2
  exit 1
fi

# ─── обновление кода из GitHub ────────────────────────────────────
if [ "$DO_UPDATE" = true ]; then
  echo "==> Обновляю код с ветки '$UPDATE_BRANCH' ($REPO_URL)"

  # Если внутри проекта уже есть свой git-репозиторий с историей —
  # используем его; иначе работаем в отдельном bare-репозитории .ciphertalk-src,
  # который переживает перезаписи файлов (его содержимое не трогаем при checkout).
  if [ -d .git ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     && git remote get-url origin >/dev/null 2>&1; then
    GIT_DIR=".git"; WORK_DIR="."
  else
    mkdir -p .ciphertalk-src
    if [ ! -d .ciphertalk-src/repo ]; then
      git init --bare -q .ciphertalk-src/repo
      git -C .ciphertalk-src/repo remote add origin "$REPO_URL"
    fi
    GIT_DIR=".ciphertalk-src/repo"; WORK_DIR="."
    git -C "$GIT_DIR" remote set-url origin "$REPO_URL"
  fi

  git -C "$GIT_DIR" fetch --depth 1 origin "+refs/heads/$UPDATE_BRANCH:refs/remotes/origin/$UPDATE_BRANCH" \
    || { echo "Не удалось получить ветку '$UPDATE_BRANCH'. Проверь имя ветки и доступ к репо." >&2; exit 1; }

  # Останавливаем старый сервер, чтобы он не мешал перезаписи и пересборке
  pkill -f 'target/release/messenger' 2>/dev/null || true
  sleep 1

  # Распаковываем дерево ветки поверх текущей папки (кроме .git-служебных файлов)
  TMP_TAR=$(mktemp)
  trap 'rm -f "$TMP_TAR"' EXIT
  git -C "$GIT_DIR" archive --format=tar "origin/$UPDATE_BRANCH" > "$TMP_TAR"
  tar -xf "$TMP_TAR" -C "$WORK_DIR"
  rm -f "$TMP_TAR"; trap - EXIT

  echo "==> Код обновлён до ветки '$UPDATE_BRANCH' ($(git -C "$GIT_DIR" rev-parse --short "origin/$UPDATE_BRANCH"))"

  # Перезапускаем СВЕЖИЙ run.sh без флагов, если он отличается от нашего текста
  NEW_SH_HASH=$(md5sum ./run.sh 2>/dev/null | cut -d' ' -f1 || echo "")
  OLD_SH_HASH=$(md5sum "$0" | cut -d' ' -f1)
  if [ -f ./run.sh ] && [ "$NEW_SH_HASH" != "$OLD_SH_HASH" ]; then
    echo "==> run.sh обновился — перезапускаю свежую версию..."
    chmod +x ./run.sh
    exec ./run.sh
  fi
  # Иначе продолжаем в этом же процессе: сразу пойдём в сборку и запуск ниже.
fi

# ─── JWT-секрет ───────────────────────────────────────────────────
ensure_jwt_secret() {
  if [ -n "${JWT_SECRET:-}" ]; then
    echo "==> JWT_SECRET взят из переменной окружения"
    return
  fi
  if [ -s "$JWT_SECRET_FILE" ]; then
    JWT_SECRET="$(cat "$JWT_SECRET_FILE")"
    echo "==> JWT_SECRET прочитан из $JWT_SECRET_FILE"
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  else
    JWT_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  fi
  (umask 077; printf '%s' "$JWT_SECRET" > "$JWT_SECRET_FILE")
  echo "==> Сгенерирован JWT_SECRET -> $JWT_SECRET_FILE (в git не попадает)"
}

# ─── rqlited: локальный бинарник или скачивание ───────────────────
download_rqlited() {
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "==> Неизвестная архитектура $(uname -m): скачай rqlited вручную" >&2; return 1 ;;
  esac
  tmp="$(mktemp -d)"
  url="https://github.com/rqlite/rqlite/releases/download/${RQLITED_VERSION}/rqlite-${RQLITED_VERSION}-linux-${arch}.tar.gz"
  echo "==> rqlited не найден, скачиваю ${RQLITED_VERSION} (${arch})..."
  if ! curl -fsSL "$url" -o "$tmp/rqlite.tgz"; then rm -rf "$tmp"; return 1; fi
  if ! tar -xzf "$tmp/rqlite.tgz" -C "$tmp"; then rm -rf "$tmp"; return 1; fi
  if ! cp "$tmp"/rqlite-*/rqlited ./rqlited; then rm -rf "$tmp"; return 1; fi
  chmod +x ./rqlited
  rm -rf "$tmp"
  echo "==> rqlited скачан в ./rqlited (каталог в .gitignore)"
  return 0
}

echo "==> Проверяю rqlite на $RQLITE_URL"
if ! curl -sf "$RQLITE_URL/readyz" >/dev/null 2>&1; then
  echo "==> rqlite не запущен, стартую..."
  if command -v docker >/dev/null 2>&1; then
    docker rm -f ciphertalk-rqlite >/dev/null 2>&1 || true
    # Только loopback: у rqlite по умолчанию нет аутентификации, и порт,
    # опубликованный на 0.0.0.0, отдаёт всю переписку любому в сети.
    docker run -d --name ciphertalk-rqlite -p 127.0.0.1:4001:4001 rqlite/rqlite >/dev/null
  elif command -v rqlited >/dev/null 2>&1; then
    mkdir -p ./data-rqlite
    nohup rqlited -http-addr 127.0.0.1:4001 -node-id 1 ./data-rqlite >/tmp/rqlite.log 2>&1 &
  elif [ -x ./rqlited ]; then
    mkdir -p ./data-rqlite
    nohup ./rqlited -http-addr 127.0.0.1:4001 -node-id 1 ./data-rqlite >/tmp/rqlite.log 2>&1 &
  elif download_rqlited; then
    mkdir -p ./data-rqlite
    nohup ./rqlited -http-addr 127.0.0.1:4001 -node-id 1 ./data-rqlite >/tmp/rqlite.log 2>&1 &
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

# --- находим cargo (после установки rustup он лежит в ~/.cargo/bin,
#     но PATH в текущей сессии может быть не обновлён) ---
if ! command -v cargo >/dev/null 2>&1; then
  for c in "$HOME/.cargo/bin/cargo" "/root/.cargo/bin/cargo" "/usr/local/cargo/bin/cargo" "/usr/bin/cargo"; do
    [ -x "$c" ] && export PATH="$(dirname "$c"):$PATH" && break
  done
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "==> cargo не найден." >&2
  echo "    Установи Rust:" >&2
  echo "      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" >&2
  echo "      source \"\$HOME/.cargo/env\"" >&2
  exit 1
fi

ensure_jwt_secret

echo "==> Собираю мессенджер (release)"
cargo build --release

echo "==> Запускаю сервер на http://localhost:$PORT"
echo "    Открой в браузере: http://localhost:$PORT/"
PORT="$PORT" JWT_SECRET="$JWT_SECRET" RQLITE_URL="$RQLITE_URL" \
  exec ./target/release/messenger
