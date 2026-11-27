#!/usr/bin/env bash
# CipherTalk auto-update: pull dev-rust-v, rebuild incrementally, restart,
# stream logs, and stop the service if it enters a restart loop.
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/SkobkaStudio/CipherTalk.git}"
BRANCH="${BRANCH:-dev-rust-v}"
APP_DIR="${APP_DIR:-/opt/ciphertalk}"
SERVICE="${SERVICE:-ciphertalk}"
SERVICE_USER="${SERVICE_USER:-ciphertalk}"
LOG_FILE="${LOG_FILE:-/var/log/ciphertalk-update.log}"
BUILD_LOG="${BUILD_LOG:-/var/log/ciphertalk-build.log}"
LOCK_FILE="${LOCK_FILE:-/run/ciphertalk-update.lock}"
STARTUP_GRACE="${STARTUP_GRACE:-45}"
CHECK_INTERVAL="${CHECK_INTERVAL:-4}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "update.sh: запускать от root" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$BUILD_LOG")"
exec > >(tee -a "$LOG_FILE") 2>&1

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "update.sh: уже выполняется другой процесс обновления" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d /tmp/ciphertalk-update.XXXXXX)"
LOG_PID=""
BASELINE_RESTARTS=""
HEALTH_URL=""

cleanup() {
  if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
    wait "$LOG_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

die() {
  echo
  echo "ОШИБКА: $*" >&2
  exit 1
}

on_error() {
  local code=$?
  echo
  echo "ОШИБКА: команда завершилась с кодом $code (строка ${BASH_LINENO[0]}): ${BASH_COMMAND}" >&2
  exit "$code"
}
trap on_error ERR

service_state() { systemctl show "$SERVICE" -p ActiveState --value; }
service_substate() { systemctl show "$SERVICE" -p SubState --value; }
restart_count() { systemctl show "$SERVICE" -p NRestarts --value; }

stop_loop() {
  local reason="$1"
  [[ -n "$LOG_PID" ]] && kill "$LOG_PID" 2>/dev/null || true
  LOG_PID=""
  echo
  echo "============================================================" >&2
  echo "ОШИБКА: служба $SERVICE остановлена." >&2
  echo "Причина: $reason" >&2
  echo "Последние 80 строк журнала:" >&2
  echo "============================================================" >&2
  journalctl -u "$SERVICE" -n 80 --no-pager >&2 || true
  echo "============================================================" >&2
  systemctl stop "$SERVICE" 2>/dev/null || true
  exit 1
}

check_health_once() {
  curl -fsS --max-time 4 "$HEALTH_URL" >/dev/null 2>&1
}

check_loop() {
  local state substate restarts
  state="$(service_state)"
  substate="$(service_substate)"
  restarts="$(restart_count)"

  if [[ "$state" != "active" || "$substate" == "auto-restart" ]]; then
    stop_loop "состояние $state/$substate, служба не работает"
  fi
  if [[ -n "$BASELINE_RESTARTS" && "$restarts" -gt "$BASELINE_RESTARTS" ]]; then
    stop_loop "обнаружен цикл перезапуска (NRestarts: $BASELINE_RESTARTS -> $restarts)"
  fi
  if ! check_health_once; then
    stop_loop "health-check не проходит: $HEALTH_URL"
  fi
}

echo "== CipherTalk update ========================================="
echo "Ветка:     $BRANCH"
echo "Репозиторий: $REPO_URL"
echo "Каталог:   $APP_DIR"
echo "Служба:    $SERVICE"
echo "Начало:    $(date '+%F %T %Z')"
echo "=============================================================="

command -v git >/dev/null || die "git не установлен"
command -v curl >/dev/null || die "curl не установлен"
command -v flock >/dev/null || die "flock не установлен"

# ffmpeg/ffprobe нужны для создания GIF-стикеров.
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "ffmpeg/ffprobe не найдены — устанавливаю..."
  DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::ForceIPv4=true update -qq
  DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::ForceIPv4=true install -y -qq ffmpeg
fi

[[ -d "$APP_DIR" ]] || die "каталог $APP_DIR не найден"
[[ -f "$APP_DIR/.env" ]] || die "не найден $APP_DIR/.env"

export CARGO_HOME="${CARGO_HOME:-/root/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-/root/.rustup}"
export SQLX_OFFLINE=true
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
CARGO_BIN="${CARGO_BIN:-$CARGO_HOME/bin/cargo}"
[[ -x "$CARGO_BIN" ]] || CARGO_BIN="$(command -v cargo || true)"
[[ -n "$CARGO_BIN" ]] || die "cargo не найден"

if [[ -d "$APP_DIR/.git" ]]; then
  echo "[1/5] git fetch/reset $BRANCH..."
  git -C "$APP_DIR" fetch --prune --depth=1 origin "$BRANCH" || die "не удалось скачать ветку $BRANCH"
  git -C "$APP_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH" || die "не удалось переключиться на $BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  git -C "$APP_DIR" clean -fd >/dev/null 2>&1 || true
  SRC_DIR="$APP_DIR"
else
  echo "[1/5] git clone $BRANCH..."
  GIT_TERMINAL_PROMPT=0 git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$WORK_DIR/repo" \
    || die "не удалось склонировать $REPO_URL ($BRANCH)"
  SRC_DIR="$WORK_DIR/repo"

  echo "[2/5] синхронизация изменённых и новых файлов..."
  for dir in src web migrations .sqlx deploy tests docs; do
    if [[ -d "$SRC_DIR/$dir" ]]; then
      mkdir -p "$APP_DIR/$dir"
      rsync -a --delete "$SRC_DIR/$dir/" "$APP_DIR/$dir/"
    fi
  done
  for file in Cargo.toml Cargo.lock build.rs README.md Dockerfile docker-compose.yml .dockerignore .env.example rust-toolchain.toml update.sh; do
    [[ -f "$SRC_DIR/$file" ]] && cp -a "$SRC_DIR/$file" "$APP_DIR/$file"
  done
fi

cd "$APP_DIR"

echo "[3/5] сборка release (инкрементальная, только изменённое)..."
echo "Лог сборки: $BUILD_LOG"
if ! "$CARGO_BIN" build --release --locked --offline 2>&1 | tee "$BUILD_LOG"; then
  echo
  echo "Офлайн-сборка не удалась, пробую онлайн (нужны новые зависимости)..."
  "$CARGO_BIN" build --release --locked 2>&1 | tee -a "$BUILD_LOG" \
    || die "сборка не удалась; служба не перезапускалась. Смотрите $BUILD_LOG"
fi
[[ -x "$APP_DIR/target/release/ciphertalk" ]] || die "бинарник target/release/ciphertalk не найден"

echo "[4/5] установка бинарника и службы..."
install -o root -g "$SERVICE_USER" -m 750 target/release/ciphertalk "$APP_DIR/ciphertalk"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 \
  "$APP_DIR/uploads" "$APP_DIR/uploads/avatars" "$APP_DIR/uploads/tmp"
if [[ -f "$APP_DIR/deploy/ciphertalk.service" ]]; then
  install -o root -g root -m 644 "$APP_DIR/deploy/ciphertalk.service" "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
fi
systemctl enable "$SERVICE" >/dev/null 2>&1 || true

PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/.env" | tail -1)"
PORT="${PORT:-8081}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/health/ready}"

echo "[5/5] перезапуск $SERVICE..."
systemctl restart "$SERVICE"
BASELINE_RESTARTS="$(restart_count)"
echo "NRestarts после старта: $BASELINE_RESTARTS"

echo "Запускаю журнал: journalctl -u $SERVICE -f (Ctrl-C оставит службу запущенной)"
journalctl -u "$SERVICE" -f -n 40 --no-pager &
LOG_PID=$!

# Даем приложению подняться, затем проверяем состояние и health.
healthy=0
deadline=$((SECONDS + STARTUP_GRACE))
while (( SECONDS < deadline )); do
  sleep "$CHECK_INTERVAL"
  state="$(service_state)"
  substate="$(service_substate)"
  restarts="$(restart_count)"
  if [[ "$state" != "active" || "$substate" == "auto-restart" ]]; then
    stop_loop "состояние $state/$substate после запуска"
  fi
  if [[ "$restarts" -gt "$BASELINE_RESTARTS" ]]; then
    stop_loop "служба перезапускается (NRestarts: $BASELINE_RESTARTS -> $restarts)"
  fi
  if check_health_once; then
    healthy=1
    echo "OK: служба активна, health-check пройден: $HEALTH_URL"
    break
  fi
done

if [[ "$healthy" -ne 1 ]]; then
  stop_loop "health-check не прошёл за ${STARTUP_GRACE}s: $HEALTH_URL"
fi

# Дальше следим за циклом, пока пользователь смотрит логи.
while kill -0 "$LOG_PID" 2>/dev/null; do
  check_loop
  sleep "$CHECK_INTERVAL"
done

echo "Журнал закрыт. Служба $SERVICE оставлена в состоянии: $(service_state)"
