#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# CipherTalk — единый запуск.
#
#   ./run.sh                — обычный запуск (rqlite + сборка + сервер)
#   ./run.sh -u -dev        — git pull ветки dev-rust-v, пересборка, запуск
#   ./run.sh -u -main       — git pull ветки main, пересборка, запуск
#   ./run.sh -h | --help    — справка
#
# Порядок: разбор флагов → (опционально) обновление → проверка/запуск
# rqlite → поиск cargo → cargo build --release → exec сервера.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# Работаем из каталога проекта, даже если скрипт вызвали из другого места.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RQLITE_URL="${RQLITE_URL:-http://localhost:4001}"
PORT="${PORT:-3000}"
JWT_SECRET="${JWT_SECRET:-dev-secret-change-me}"
REPO_URL="${REPO_URL:-https://github.com/SkobkaStudio/CipherTalk.git}"

DO_UPDATE=false
UPDATE_BRANCH=""

usage() {
  cat <<'EOF'
CipherTalk — единый запуск (Rust + axum + rqlite + WebSocket)

Использование:
  ./run.sh                обычный запуск: rqlite + cargo build --release + сервер
  ./run.sh -u -dev        обновить код с ветки dev-rust-v, собрать и запустить
  ./run.sh -u -main       обновить код с ветки main, собрать и запустить
  ./run.sh -h | --help    показать эту справку

Переменные окружения:
  PORT         порт HTTP-сервера          (по умолчанию 3000)
  RQLITE_URL   адрес rqlite                (по умолчанию http://localhost:4001)
  JWT_SECRET   секрет подписи JWT          (по умолчанию dev-secret-change-me)
  RUST_LOG     уровень логов               (например, info или debug)

После запуска откройте: http://localhost:3000/
EOF
}

# ─── разбор флагов ────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    -u | --update)
      DO_UPDATE=true
      ;;
    -dev)
      UPDATE_BRANCH="dev-rust-v"
      ;;
    -main)
      UPDATE_BRANCH="main"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "❌ Неизвестный флаг: $arg" >&2
      echo "   Справка: ./run.sh -h" >&2
      exit 1
      ;;
  esac
done

if [ "$DO_UPDATE" = true ] && [ -z "$UPDATE_BRANCH" ]; then
  echo "❌ Укажи ветку обновления: ./run.sh -u -dev  или  ./run.sh -u -main" >&2
  exit 1
fi

if [ "$DO_UPDATE" = false ] && [ -n "$UPDATE_BRANCH" ]; then
  echo "❌ Флаги -dev/-main используются только вместе с -u:" >&2
  echo "   ./run.sh -u -dev   или   ./run.sh -u -main" >&2
  exit 1
fi

# ─── обновление кода из git ───────────────────────────────────────
if [ "$DO_UPDATE" = true ]; then
  echo "==> Обновляю код: ветка '$UPDATE_BRANCH' ($REPO_URL)"

  OLD_RUN_MD5="$(md5sum ./run.sh 2>/dev/null | awk '{print $1}' || true)"

  # Если в проекте уже есть git-репозиторий с origin — используем его.
  # Иначе создаём отдельный bare-репозиторий в .ciphertalk-src/repo,
  # который не пострадает при распаковке архива поверх проекта.
  if [ -d .git ] \
     && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     && git remote get-url origin >/dev/null 2>&1; then
    GIT_DIR=".git"
    echo "==> Использую существующий git-репозиторий (.git)"
  else
    mkdir -p .ciphertalk-src
    if [ ! -d .ciphertalk-src/repo ]; then
      echo "==> Создаю служебный bare-репозиторий .ciphertalk-src/repo"
      git init --bare -q .ciphertalk-src/repo
      git -C .ciphertalk-src/repo remote add origin "$REPO_URL"
    fi
    git -C .ciphertalk-src/repo remote set-url origin "$REPO_URL"
    GIT_DIR=".ciphertalk-src/repo"
  fi

  if ! git -C "$GIT_DIR" fetch --depth 1 origin \
      "+refs/heads/$UPDATE_BRANCH:refs/remotes/origin/$UPDATE_BRANCH"; then
    echo "❌ Не удалось получить ветку '$UPDATE_BRANCH'." >&2
    echo "   Проверь имя ветки и доступ к $REPO_URL" >&2
    exit 1
  fi

  # Останавливаем старый сервер, чтобы он не мешал перезаписи и пересборке.
  pkill -f 'target/release/messenger' 2>/dev/null || true
  sleep 1

  # Распаковываем дерево ветки поверх текущей папки. Служебный .git не трогаем.
  git -C "$GIT_DIR" archive --format=tar "origin/$UPDATE_BRANCH" | tar -x -C .

  echo "==> Код обновлён до '$UPDATE_BRANCH' ($(git -C "$GIT_DIR" rev-parse --short "origin/$UPDATE_BRANCH" 2>/dev/null || echo '?'))"

  # Если run.sh изменился — перезапускаемся, чтобы работать уже новой версией.
  NEW_RUN_MD5="$(md5sum ./run.sh 2>/dev/null | awk '{print $1}' || true)"
  if [ -f ./run.sh ] && [ -n "$OLD_RUN_MD5" ] && [ -n "$NEW_RUN_MD5" ] \
     && [ "$NEW_RUN_MD5" != "$OLD_RUN_MD5" ]; then
    echo "==> run.sh обновился — перезапускаю свежую версию…"
    chmod +x ./run.sh
    exec ./run.sh
  fi
fi

# ─── rqlite: проверить или запустить ─────────────────────────────
echo "==> Проверяю rqlite: $RQLITE_URL"
if ! curl -sf --max-time 3 "$RQLITE_URL/readyz" >/dev/null 2>&1; then
  echo "==> rqlite не отвечает, запускаю…"
  mkdir -p ./data-rqlite

  if command -v docker >/dev/null 2>&1; then
    docker rm -f ciphertalk-rqlite >/dev/null 2>&1 || true
    docker run -d --name ciphertalk-rqlite -p 4001:4001 rqlite/rqlite >/dev/null
    echo "==> rqlite запущен в Docker (контейнер ciphertalk-rqlite)"
  elif command -v rqlited >/dev/null 2>&1; then
    nohup rqlited -node-id 1 ./data-rqlite >/tmp/ciphertalk-rqlite.log 2>&1 &
    echo "==> rqlited запущен из PATH (PID $!)"
  elif [ -x ./rqlited ]; then
    nohup ./rqlited -node-id 1 ./data-rqlite >/tmp/ciphertalk-rqlite.log 2>&1 &
    echo "==> локальный ./rqlited запущен (PID $!)"
  else
    echo "❌ rqlite не найден: нет Docker и нет rqlited." >&2
    echo "   Варианты:" >&2
    echo "     1) установить Docker и повторить запуск;" >&2
    echo "     2) скачать rqlited с https://github.com/rqlite/rqlite/releases" >&2
    echo "        и положить его в корень проекта (./rqlited) или в PATH." >&2
    exit 1
  fi

  READY=false
  printf "==> Жду готовности rqlite"
  for _ in $(seq 1 30); do
    if curl -sf --max-time 2 "$RQLITE_URL/readyz" >/dev/null 2>&1; then
      READY=true
      break
    fi
    printf "."
    sleep 1
  done
  printf "\n"

  if [ "$READY" != true ]; then
    echo "❌ rqlite не поднялся за 30 секунд." >&2
    echo "   Проверь лог: /tmp/ciphertalk-rqlite.log" >&2
    exit 1
  fi
  echo "==> rqlite готов"
else
  echo "==> rqlite уже работает"
fi

# ─── поиск cargo ─────────────────────────────────────────────────
if ! command -v cargo >/dev/null 2>&1; then
  for candidate in \
    "$HOME/.cargo/bin/cargo" \
    "/root/.cargo/bin/cargo" \
    "/usr/local/cargo/bin/cargo" \
    "/usr/bin/cargo"; do
    if [ -x "$candidate" ]; then
      export PATH="$(dirname "$candidate"):$PATH"
      break
    fi
  done
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "❌ cargo не найден." >&2
  echo "   Установи Rust через rustup:" >&2
  echo "     curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" >&2
  echo "     source \"\$HOME/.cargo/env\"" >&2
  exit 1
fi

# Некоторые системы (например, контейнеры с read-only root) не дают
# писать в ~/.cargo. Тогда используем локальный CARGO_HOME в проекте.
if [ -z "${CARGO_HOME:-}" ]; then
  CARGO_HOME_CANDIDATE="$HOME/.cargo"
  if mkdir -p "$CARGO_HOME_CANDIDATE" 2>/dev/null \
     && touch "$CARGO_HOME_CANDIDATE/.ciphertalk-write-test" 2>/dev/null; then
    rm -f "$CARGO_HOME_CANDIDATE/.ciphertalk-write-test"
  else
    export CARGO_HOME="$SCRIPT_DIR/.cargo-home"
    mkdir -p "$CARGO_HOME"
    echo "==> ~/.cargo недоступен для записи, использую CARGO_HOME=$CARGO_HOME"
  fi
fi

# Улучшаем устойчивость загрузки крейтов на медленных соединениях.
export CARGO_HTTP_TIMEOUT="${CARGO_HTTP_TIMEOUT:-120}"
export CARGO_HTTP_LOW_SPEED_LIMIT="${CARGO_HTTP_LOW_SPEED_LIMIT:-1}"

# ─── сборка и запуск ─────────────────────────────────────────────
echo "==> Собираю релизную версию (cargo build --release)…"
cargo build --release

echo "==> Запускаю CipherTalk: http://localhost:$PORT/"
export PORT JWT_SECRET RQLITE_URL
exec ./target/release/messenger
