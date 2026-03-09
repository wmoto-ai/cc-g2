#!/usr/bin/env bash
set -euo pipefail

# Even G2 シミュレータ起動（スマホ画面 + G2 グラス画面）
# pnpm dlx で evenhub-simulator を直接実行する。even-dev は不要。

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SIMULATOR_PORT:-5173}"
HUB_PORT="${HUB_PORT:-8787}"
SIMULATOR_VERSION="${SIMULATOR_VERSION:-0.5.3}"
URL="http://127.0.0.1:${PORT}"
CACHE_DIR="/tmp/cc-g2-sim/.npm-cache"
LOG_DIR="/tmp/cc-g2-sim"
HUB_AUTH_TOKEN_FILE="${REPO_DIR}/tmp/notification-hub/hub-auth-token"
HUB_AUTH_TOKEN="${HUB_AUTH_TOKEN:-}"

read_env_file_var() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 1
  awk -F= -v target="$key" '
    $1 == target {
      sub(/^[^=]*=/, "", $0)
      print $0
      exit
    }
  ' "$file"
}

resolve_groq_api_key() {
  if [ -n "${GROQ_API_KEY:-}" ]; then
    printf '%s' "$GROQ_API_KEY"
    return
  fi
  if [ -n "${VITE_GROQ_API_KEY:-}" ]; then
    printf '%s' "$VITE_GROQ_API_KEY"
    return
  fi
  local value=""
  value="$(read_env_file_var "$REPO_DIR/.env.local" "GROQ_API_KEY" || true)"
  [ -n "$value" ] || value="$(read_env_file_var "$REPO_DIR/.env.local" "VITE_GROQ_API_KEY" || true)"
  [ -n "$value" ] || value="$(read_env_file_var "$REPO_DIR/.env" "GROQ_API_KEY" || true)"
  [ -n "$value" ] || value="$(read_env_file_var "$REPO_DIR/.env" "VITE_GROQ_API_KEY" || true)"
  printf '%s' "$value"
}

GROQ_API_KEY_RESOLVED="$(resolve_groq_api_key)"

mkdir -p "$CACHE_DIR" "$LOG_DIR"

if [ -z "$HUB_AUTH_TOKEN" ] && [ -f "$HUB_AUTH_TOKEN_FILE" ]; then
  HUB_AUTH_TOKEN="$(cat "$HUB_AUTH_TOKEN_FILE")"
fi

# Notification Hub が未起動なら起動（通知テストに必要）
if ! curl -s --max-time 1 "http://127.0.0.1:${HUB_PORT}/api/health" >/dev/null 2>&1; then
  echo "[start] Notification Hub on ${HUB_PORT}"
  ALLOWED_ORIGINS="http://127.0.0.1:${PORT},http://localhost:${PORT}"
  (
    cd "$REPO_DIR"
    nohup env HUB_BIND=0.0.0.0 HUB_PORT=$HUB_PORT HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" GROQ_API_KEY="$GROQ_API_KEY_RESOLVED" HUB_ALLOWED_ORIGINS="$ALLOWED_ORIGINS" \
      HUB_REPLY_RELAY_CMD='bash server/notification-hub/reply-relay.sh' \
      RELAY_ENABLE_TMUX=1 \
      RELAY_TMUX_AUTO_DETECT=1 \
      RELAY_TMUX_USE_NOTIFICATION_TARGET=1 \
      RELAY_TMUX_STRICT_APPROVAL_TARGET=1 \
      RELAY_MESSAGE_STYLE='simple' \
      RELAY_TMUX_SUBMIT_KEY='C-j' \
      RELAY_TMUX_SUBMIT_FALLBACK_KEY='Enter' \
      RELAY_LOG_FILE='tmp/notification-hub/reply-relay-events.jsonl' \
      RELAY_AGENT_LOG_FILE='tmp/notification-hub/reply-relay-agent.log' \
      node server/notification-hub/index.mjs > "$LOG_DIR/hub.log" 2>&1 &
    echo $! > "$LOG_DIR/hub.pid"
  )
  for _ in $(seq 1 10); do
    if curl -s --max-time 1 "http://127.0.0.1:${HUB_PORT}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  if curl -s --max-time 1 "http://127.0.0.1:${HUB_PORT}/api/health" >/dev/null 2>&1; then
    echo "[ok] Hub is up on ${HUB_PORT}"
  else
    echo "[warn] Hub may still be starting (check $LOG_DIR/hub.log)"
  fi
else
  echo "[ok] Hub already running on ${HUB_PORT}"
fi

# Vite が PORT で未起動なら起動
if ! lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[start] Vite on ${PORT}"
  (
    cd "$REPO_DIR"
    nohup env VITE_HUB_TOKEN="$HUB_AUTH_TOKEN" pnpm exec vite --host 0.0.0.0 --port ${PORT} > "$LOG_DIR/vite.log" 2>&1 &
    echo $! > "$LOG_DIR/vite.pid"
  )
  for _ in $(seq 1 30); do
    if curl -fsS "$URL" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! curl -fsS "$URL" >/dev/null 2>&1; then
  echo "[error] Vite is not reachable at $URL"
  echo "Check log: $LOG_DIR/vite.log"
  exit 1
fi

echo "[ok] Vite is up: $URL"
echo "[start] Even Hub Simulator ${SIMULATOR_VERSION} (スマホ画面 + G2 グラス画面)"
exec env npm_config_cache="$CACHE_DIR" pnpm dlx "@evenrealities/evenhub-simulator@${SIMULATOR_VERSION}" "$URL"
