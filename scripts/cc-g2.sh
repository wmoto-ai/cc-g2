#!/bin/bash
# cc-g2 — Claude Code + Even G2 ワンコマンド起動
#
# どのディレクトリからでも実行可能。
# 1. tmux セッションを自動作成（未起動時のみ）
# 2. Notification Hub + Vite dev server をバックグラウンドで起動（未起動時のみ）
# 3. Tailscale IP の QR コードを表示（iPhone Even App 接続用）
# 4. MOSHI_NOTIFY=1 で Claude Code を起動
#
# 使い方:
#   cc-g2                  # カレントディレクトリで Claude Code + G2
#   cc-g2 new              # 同じディレクトリでも新しい tmux セッションで起動
#   cc-g2 --codex          # Claude Code (Codex Proxy 設定) + G2
#   cc-g2 !                # インフラ再起動してから Claude Code + G2
#   cc-g2 stop             # G2 インフラ全停止
#   cc-g2 status           # 状態確認
#   cc-g2 -p "prompt"      # プロンプト付き起動（claude に引数をそのまま渡す）
#
# 環境変数:
#   SHOW_QR=0              # QRコード表示を無効化
#   CC_G2_ENABLE_STATUSLINE=0/1  # 省略時は auto（~/.claude/settings.json に statusLine.command があれば有効）

set -euo pipefail

resolve_script_path() {
  local source="$1"
  while [ -L "$source" ]; do
    local dir
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="${dir}/${source}"
  done
  printf '%s' "$source"
}

SCRIPT_PATH="$(resolve_script_path "${BASH_SOURCE[0]}")"
G2_PROJECT_DIR="${G2_PROJECT_DIR:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd -P)}"
HUB_PORT="${HUB_PORT:-8787}"
VITE_PORT="${VITE_PORT:-5173}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'
INTERNAL_JSON="${CC_G2_INTERNAL_JSON:-0}"

info()  {
  if [ "$INTERNAL_JSON" = "1" ]; then
    echo -e "${GREEN}[g2]${NC} $*" >&2
  else
    echo -e "${GREEN}[g2]${NC} $*"
  fi
}
warn()  {
  if [ "$INTERNAL_JSON" = "1" ]; then
    echo -e "${YELLOW}[g2]${NC} $*" >&2
  else
    echo -e "${YELLOW}[g2]${NC} $*"
  fi
}
error() { echo -e "${RED}[g2]${NC} $*" >&2; }

SHOW_QR="${SHOW_QR:-1}"
ENABLE_STATUSLINE="${CC_G2_ENABLE_STATUSLINE:-}"
FORCE_INFRA_RESTART=0
FORCE_NEW_SESSION=0
HUB_AUTH_TOKEN_FILE="${G2_PROJECT_DIR}/tmp/notification-hub/hub-auth-token"
VOICE_ENTRY_PORT="${CC_G2_VOICE_ENTRY_PORT:-8797}"
VOICE_ENTRY_BIND="${CC_G2_VOICE_ENTRY_BIND:-0.0.0.0}"
VOICE_ENTRY_TOKEN_FILE="${G2_PROJECT_DIR}/tmp/voice-entry/voice-entry-token"
VOICE_ENTRY_LAST_SESSION_FILE="${G2_PROJECT_DIR}/tmp/voice-entry/last-session.json"
VOICE_ENTRY_LOG_FILE="${G2_PROJECT_DIR}/tmp/voice-entry/voice-entry.log"
VOICE_ENTRY_REPO_ROOTS="${CC_G2_REPO_ROOTS:-}"
VOICE_ENTRY_SCAN_DEPTH="${CC_G2_REPO_SCAN_DEPTH:-3}"
VOICE_ENTRY_ENABLED="${CC_G2_VOICE_ENTRY_ENABLED:-}"

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
  local value=""
  value="$(read_env_file_var "$G2_PROJECT_DIR/.env.local" "GROQ_API_KEY" || true)"
  [ -n "$value" ] || value="$(read_env_file_var "$G2_PROJECT_DIR/.env" "GROQ_API_KEY" || true)"
  printf '%s' "$value"
}

resolve_statusline_flag() {
  if [ -n "${CC_G2_ENABLE_STATUSLINE:-}" ]; then
    printf '%s' "$CC_G2_ENABLE_STATUSLINE"
    return
  fi
  local value=""
  value="$(read_env_file_var "$G2_PROJECT_DIR/.env.local" "CC_G2_ENABLE_STATUSLINE" || true)"
  [ -n "$value" ] || value="$(read_env_file_var "$G2_PROJECT_DIR/.env" "CC_G2_ENABLE_STATUSLINE" || true)"
  printf '%s' "$value"
}

load_or_create_hub_auth_token() {
  if [ -n "${HUB_AUTH_TOKEN:-}" ]; then
    printf '%s' "$HUB_AUTH_TOKEN"
    return
  fi
  if [ -f "$HUB_AUTH_TOKEN_FILE" ]; then
    cat "$HUB_AUTH_TOKEN_FILE"
    return
  fi
  mkdir -p "$(dirname "$HUB_AUTH_TOKEN_FILE")"
  node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' | tee "$HUB_AUTH_TOKEN_FILE" >/dev/null
}

load_or_create_voice_entry_token() {
  local token="${CC_G2_VOICE_ENTRY_TOKEN:-}"
  if [ -n "$token" ] && [ "$token" != "replace-me" ]; then
    printf '%s' "$token"
    return
  fi
  if [ -f "$VOICE_ENTRY_TOKEN_FILE" ]; then
    token="$(cat "$VOICE_ENTRY_TOKEN_FILE")"
    if [ -n "$token" ] && [ "$token" != "replace-me" ]; then
      printf '%s' "$token"
      return
    fi
  fi
  mkdir -p "$(dirname "$VOICE_ENTRY_TOKEN_FILE")"
  node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' | tee "$VOICE_ENTRY_TOKEN_FILE" >/dev/null
}

resolve_voice_entry_enabled() {
  if [ -n "$VOICE_ENTRY_ENABLED" ]; then
    printf '%s' "$VOICE_ENTRY_ENABLED"
    return
  fi
  local from_file=""
  from_file="$(read_env_file_var "$G2_PROJECT_DIR/.env.local" "CC_G2_VOICE_ENTRY_ENABLED" || true)"
  [ -n "$from_file" ] || from_file="$(read_env_file_var "$G2_PROJECT_DIR/.env" "CC_G2_VOICE_ENTRY_ENABLED" || true)"
  if [ -n "$from_file" ]; then
    printf '%s' "$from_file"
    return
  fi
  if [ -n "${CC_G2_VOICE_ENTRY_TOKEN:-}" ]; then
    printf '1'
    return
  fi
  printf '1'
}

resolve_repo_roots() {
  if [ -n "$VOICE_ENTRY_REPO_ROOTS" ]; then
    printf '%s' "$VOICE_ENTRY_REPO_ROOTS"
    return
  fi
  local from_file=""
  from_file="$(read_env_file_var "$G2_PROJECT_DIR/.env.local" "CC_G2_REPO_ROOTS" || true)"
  [ -n "$from_file" ] || from_file="$(read_env_file_var "$G2_PROJECT_DIR/.env" "CC_G2_REPO_ROOTS" || true)"
  if [ -n "$from_file" ]; then
    printf '%s' "$from_file"
    return
  fi
  printf '%s' "${HOME}/Repos"
}

GROQ_API_KEY_RESOLVED="$(resolve_groq_api_key)"
ENABLE_STATUSLINE="$(resolve_statusline_flag)"
VOICE_ENTRY_ENABLED="$(resolve_voice_entry_enabled)"
VOICE_ENTRY_REPO_ROOTS="$(resolve_repo_roots)"

refresh_hub_auth_token() {
  unset HUB_AUTH_TOKEN
  HUB_AUTH_TOKEN="$(load_or_create_hub_auth_token)"
}

refresh_voice_entry_token() {
  unset CC_G2_VOICE_ENTRY_TOKEN
  VOICE_ENTRY_TOKEN="$(load_or_create_voice_entry_token)"
}

refresh_hub_auth_token
refresh_voice_entry_token

resolve_original_statusline_cmd() {
  if [ -n "${CC_G2_ORIG_STATUSLINE_CMD:-}" ]; then
    printf '%s' "$CC_G2_ORIG_STATUSLINE_CMD"
    return
  fi

  local settings_file="${HOME}/.claude/settings.json"
  if [ -f "$settings_file" ] && command -v jq >/dev/null 2>&1; then
    local cmd
    cmd="$(jq -r '.statusLine // empty | if type=="object" then .command // empty else . end' "$settings_file" 2>/dev/null || true)"
    if [ -n "$cmd" ] && [ "$cmd" != "null" ]; then
      printf '%s' "$cmd"
      return
    fi
  fi
}

ORIG_STATUSLINE_CMD="$(resolve_original_statusline_cmd)"

if [ -z "$ENABLE_STATUSLINE" ]; then
  if [ -n "$ORIG_STATUSLINE_CMD" ]; then
    ENABLE_STATUSLINE=1
  else
    ENABLE_STATUSLINE=0
  fi
fi

resolve_claude_bin() {
  if [ -n "${CLAUDE_BIN:-}" ] && command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    command -v "$CLAUDE_BIN"
    return
  fi
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return
  fi
  printf '%s' "${CLAUDE_BIN:-claude}"
}

make_tmux_session_name() {
  local work_dir="$1"
  local base slug hash
  base="$(basename "$work_dir")"
  slug="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')"
  hash="$(printf '%s' "$work_dir" | shasum | awk '{print substr($1,1,4)}')"
  printf 'g2-%s-%s' "$slug" "$hash"
}

make_unique_tmux_session_name() {
  local work_dir="$1"
  local base candidate suffix
  base="$(make_tmux_session_name "$work_dir")"
  candidate="$base"
  suffix=2
  while tmux has-session -t "$candidate" 2>/dev/null; do
    candidate="${base}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s' "$candidate"
}

json_out() {
  jq -nc "$@"
}

has_tmux_session() {
  local session_name="$1"
  tmux has-session -t "$session_name" 2>/dev/null
}

launch_tmux_session_detached() {
  local work_dir="$1"
  local prompt="$2"
  local use_codex="$3"
  local session_name="$(make_unique_tmux_session_name "$work_dir")"
  local tmux_env=(
    -e _CC_G2_INSIDE=1
    -e MOSHI_NOTIFY=1
    -e CC_G2_TMUX_TARGET="${session_name}:0.0"
    -e CC_G2_ENABLE_STATUSLINE="${ENABLE_STATUSLINE}"
    -e CC_G2_ORIG_STATUSLINE_CMD="${ORIG_STATUSLINE_CMD}"
  )
  local nested_args=()
  if [ "$use_codex" = "1" ]; then
    nested_args+=("--codex")
  fi
  if [ -n "$prompt" ]; then
    nested_args+=("$prompt")
  fi
  local nested_cmd
  nested_cmd="\"$0\""
  if [ ${#nested_args[@]} -gt 0 ]; then
    nested_cmd+="$(printf ' %q' "${nested_args[@]}")"
  fi
  nested_cmd+="; exec \$SHELL"
  ensure_infra
  tmux new-session -d -s "$session_name" -c "$work_dir" \
    "${tmux_env[@]}" \
    "$nested_cmd"
  json_out --arg sessionName "$session_name" --arg tmuxTarget "${session_name}:0.0" --arg workdir "$work_dir" '{ok:true,sessionName:$sessionName,tmuxTarget:$tmuxTarget,workdir:$workdir}'
}

send_to_tmux_session() {
  local session_name="$1"
  local text="$2"
  local pane_target="${session_name}:0.0"
  text="${text//$'\r'/ }"
  text="${text//$'\n'/ }"
  tmux send-keys -t "$pane_target" -l "$text"
  tmux send-keys -t "$pane_target" Enter
  json_out --arg sessionName "$session_name" --arg tmuxTarget "$pane_target" '{ok:true,sessionName:$sessionName,tmuxTarget:$tmuxTarget}'
}

run_internal_command() {
  local command="$1"
  shift || true
  case "$command" in
    launch-detached)
      local work_dir=""
      local prompt=""
      local use_codex=0
      while [ $# -gt 0 ]; do
        case "$1" in
          --workdir) work_dir="$2"; shift 2 ;;
          --prompt) prompt="$2"; shift 2 ;;
          --codex) use_codex=1; shift ;;
          *) error "Unknown launch-detached arg: $1"; exit 1 ;;
        esac
      done
      [ -n "$work_dir" ] || { error "launch-detached requires --workdir"; exit 1; }
      launch_tmux_session_detached "$work_dir" "$prompt" "$use_codex"
      exit 0
      ;;
    send)
      local session_name=""
      local text=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --session) session_name="$2"; shift 2 ;;
          --text) text="$2"; shift 2 ;;
          *) error "Unknown send arg: $1"; exit 1 ;;
        esac
      done
      [ -n "$session_name" ] || { error "send requires --session"; exit 1; }
      send_to_tmux_session "$session_name" "$text"
      exit 0
      ;;
    has-session)
      local session_name=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --session) session_name="$2"; shift 2 ;;
          *) error "Unknown has-session arg: $1"; exit 1 ;;
        esac
      done
      [ -n "$session_name" ] || { error "has-session requires --session"; exit 1; }
      if has_tmux_session "$session_name"; then
        json_out --arg sessionName "$session_name" '{ok:true,exists:true,sessionName:$sessionName}'
      else
        json_out --arg sessionName "$session_name" '{ok:true,exists:false,sessionName:$sessionName}'
      fi
      exit 0
      ;;
  esac
}

# --- 依存コマンドチェック ---
check_deps() {
  local missing=()
  for cmd in tmux curl lsof jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1 && ! command -v claude >/dev/null 2>&1; then
    missing+=("claude")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    error "必須コマンドが見つかりません: ${missing[*]}"
    error "インストールしてから再実行してください"
    exit 1
  fi
  if ! command -v tailscale >/dev/null 2>&1; then
    warn "tailscale が見つかりません（QRコード表示に必要。SHOW_QR=0 で省略可）"
  fi
}
check_deps
CLAUDE_BIN="$(resolve_claude_bin)"

is_hub_running()  { curl -s --max-time 1 "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1; }
is_vite_running() { lsof -i ":$VITE_PORT" -P 2>/dev/null | grep -q LISTEN; }
is_voice_entry_running() {
  curl -s --max-time 1 "http://127.0.0.1:$VOICE_ENTRY_PORT/health" >/dev/null 2>&1
}
voice_entry_token_matches() {
  [ "$VOICE_ENTRY_ENABLED" = "1" ] || return 0
  [ -n "${VOICE_ENTRY_TOKEN:-}" ] || return 1
  local code
  code=$(
    curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
      -H "authorization: Bearer ${VOICE_ENTRY_TOKEN}" \
      "http://127.0.0.1:${VOICE_ENTRY_PORT}/auth-check" 2>/dev/null || true
  )
  [ "$code" = "200" ]
}
hub_auth_token_matches() {
  [ -n "${HUB_AUTH_TOKEN:-}" ] || return 1
  [ -f "$HUB_AUTH_TOKEN_FILE" ] || return 1
  local code
  for _ in 1 2; do
    code=$(
      curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
        -H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}" \
        "http://127.0.0.1:${HUB_PORT}/api/auth-check" 2>/dev/null || true
    )
    [ "$code" = "200" ] && return 0
    sleep 0.2
  done
  return 1
}

show_qr() {
  [ "$SHOW_QR" = "0" ] && return
  local ts_ip
  ts_ip=$(tailscale ip -4 2>/dev/null || true)
  if [ -z "$ts_ip" ]; then
    warn "Tailscale 未接続: QRコードをスキップ"
    return
  fi
  local url="http://${ts_ip}:${VITE_PORT}"
  echo
  info "iPhone Even App → ${BOLD}${url}${NC}"
  info "QRコードを表示中..."
  echo
  if npx --yes @evenrealities/evenhub-cli qr -u "$url" 2>/dev/null; then
    :
  elif command -v qrencode &>/dev/null; then
    qrencode -t ansiutf8 "$url"
  else
    warn "QRコード表示ツールが見つかりません (evenhub-cli / qrencode)"
    info "iPhone で直接アクセス: $url"
  fi
  echo
}

ensure_infra() {
  local need_hub=false need_vite=false need_voice=false

  if ! is_hub_running; then
    need_hub=true
  fi
  if ! is_vite_running; then
    need_vite=true
  fi
  if [ "$VOICE_ENTRY_ENABLED" = "1" ] && ! is_voice_entry_running; then
    need_voice=true
  fi

  if ! $need_hub && ! hub_auth_token_matches; then
    warn "Hub auth token mismatch detected; restarting Hub and Vite"
    kill_port "$HUB_PORT" "Hub"
    kill_port "$VITE_PORT" "Vite"
    need_hub=true
    need_vite=true
  fi

  if [ "$VOICE_ENTRY_ENABLED" = "1" ] && ! $need_voice && ! voice_entry_token_matches; then
    warn "Voice entry token mismatch detected; restarting voice entry"
    kill_port "$VOICE_ENTRY_PORT" "VoiceEntry"
    need_voice=true
  fi

  if $need_hub || $need_vite || $need_voice; then
    info "G2 インフラを起動中..."

    if ! [ -d "$G2_PROJECT_DIR" ]; then
      error "G2 project not found: $G2_PROJECT_DIR"
      error "Set G2_PROJECT_DIR to override."
      exit 1
    fi
  fi

  # Hub 起動
  if $need_hub; then
    info "Notification Hub 起動 (port $HUB_PORT)..."
    local hub_log="${G2_PROJECT_DIR}/tmp/notification-hub/hub.log"
    local allowed_origins="http://127.0.0.1:${VITE_PORT},http://localhost:${VITE_PORT}"
    local ts_ip
    ts_ip=$(tailscale ip -4 2>/dev/null || true)
    if [ -n "$ts_ip" ]; then
      allowed_origins="${allowed_origins},http://${ts_ip}:${VITE_PORT}"
    fi
    mkdir -p "$(dirname "$hub_log")"
    nohup env -C "$G2_PROJECT_DIR" \
      HUB_BIND=0.0.0.0 \
      HUB_PORT=$HUB_PORT \
      HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" \
      GROQ_API_KEY="$GROQ_API_KEY_RESOLVED" \
      HUB_ALLOWED_ORIGINS="$allowed_origins" \
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
      node server/notification-hub/index.mjs \
      >> "$hub_log" 2>&1 &

    # Hub 起動待ち
    local retries=0
    while ! is_hub_running && [ $retries -lt 10 ]; do
      sleep 0.5
      retries=$((retries + 1))
    done
    if is_hub_running; then
      info "Hub: OK"
    else
      warn "Hub: 起動に時間がかかっています（バックグラウンドで継続中）"
    fi
  else
    info "Hub: 既に起動済み (port $HUB_PORT)"
  fi

  # Vite 起動
  if $need_vite; then
    info "Vite dev server 起動 (port $VITE_PORT)..."
    local vite_log="${G2_PROJECT_DIR}/tmp/notification-hub/vite.log"
    nohup env -C "$G2_PROJECT_DIR" \
      VITE_HUB_TOKEN="$HUB_AUTH_TOKEN" \
      ./node_modules/.bin/vite --host 0.0.0.0 --port "$VITE_PORT" \
      >> "$vite_log" 2>&1 &

    local retries=0
    while ! is_vite_running && [ $retries -lt 10 ]; do
      sleep 0.5
      retries=$((retries + 1))
    done
    if is_vite_running; then
      info "Vite: OK"
    else
      warn "Vite: 起動に時間がかかっています（バックグラウンドで継続中）"
    fi
  else
    info "Vite: 既に起動済み (port $VITE_PORT)"
  fi

  if [ "$VOICE_ENTRY_ENABLED" = "1" ]; then
    if $need_voice; then
      info "Voice entry 起動 (port $VOICE_ENTRY_PORT)..."
      local voice_log="$VOICE_ENTRY_LOG_FILE"
      mkdir -p "$(dirname "$voice_log")"
      nohup env -C "$G2_PROJECT_DIR" \
        CC_G2_VOICE_ENTRY_PORT="$VOICE_ENTRY_PORT" \
        CC_G2_VOICE_ENTRY_BIND="$VOICE_ENTRY_BIND" \
        CC_G2_VOICE_ENTRY_TOKEN="$VOICE_ENTRY_TOKEN" \
        CC_G2_VOICE_ENTRY_LOG_FILE="$VOICE_ENTRY_LOG_FILE" \
        CC_G2_VOICE_ENTRY_LAST_SESSION_FILE="$VOICE_ENTRY_LAST_SESSION_FILE" \
        CC_G2_REPO_ROOTS="$VOICE_ENTRY_REPO_ROOTS" \
        CC_G2_REPO_SCAN_DEPTH="$VOICE_ENTRY_SCAN_DEPTH" \
        node server/voice-entry/index.mjs \
        >> "$voice_log" 2>&1 &

      local retries=0
      while ! is_voice_entry_running && [ $retries -lt 10 ]; do
        sleep 0.5
        retries=$((retries + 1))
      done
      if is_voice_entry_running; then
        info "Voice entry: OK"
      else
        warn "Voice entry: 起動に時間がかかっています（バックグラウンドで継続中）"
      fi
    else
      info "Voice entry: 既に起動済み (port $VOICE_ENTRY_PORT)"
    fi
  fi

}

cmd_status() { cmd_doctor; }

kill_port() {
  local port="$1" name="$2"
  local pids
  pids=$(lsof -t -i ":$port" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    return
  fi
  # 全 PID を kill（親プロセス + 子 node プロセス）
  echo "$pids" | xargs kill 2>/dev/null || true
  # 残留確認 → SIGKILL
  sleep 0.3
  local remaining
  remaining=$(lsof -t -i ":$port" 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    echo "$remaining" | xargs kill -9 2>/dev/null || true
  fi
  info "${name} stopped (pid: $(echo $pids | tr '\n' ' '))"
}

cmd_stop() {
  info "G2 インフラを停止中..."
  kill_port "$HUB_PORT" "Hub"
  kill_port "$VITE_PORT" "Vite"
  kill_port "$VOICE_ENTRY_PORT" "VoiceEntry"
  rm -f "$HUB_AUTH_TOKEN_FILE" 2>/dev/null || true
  info "Done."
}

cmd_doctor() {
  echo -e "${BOLD}=== cc-g2 doctor ===${NC}"
  local ok=true

  # 依存コマンド
  for cmd in tmux curl lsof jq node; do
    if command -v "$cmd" >/dev/null 2>&1; then
      info "$cmd: $(command -v "$cmd")"
    else
      warn "$cmd: not found"; ok=false
    fi
  done
  if command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    info "claude: $CLAUDE_BIN"
  elif command -v claude >/dev/null 2>&1; then
    info "claude: $(command -v claude)"
  else
    warn "claude: not found"; ok=false
  fi

  # Tailscale
  if command -v tailscale >/dev/null 2>&1; then
    local ts_ip
    ts_ip=$(tailscale ip -4 2>/dev/null || true)
    if [ -n "$ts_ip" ]; then
      info "Tailscale: $ts_ip"
    else
      warn "Tailscale: installed but not connected (実機QRには必要 / simulator-only なら継続可)"
    fi
  else
    warn "Tailscale: not found (QR コード表示に必要)"
  fi

  # Hub
  if is_hub_running; then
    info "Hub (port $HUB_PORT): running"
    if hub_auth_token_matches; then
      info "Hub auth token: enabled"
    else
      warn "Hub auth token: mismatch (run cc-g2 !)"
      ok=false
    fi
    warn "Hub is intended for Tailscale/local trusted networks only"
  else
    warn "Hub (port $HUB_PORT): stopped"
  fi

  # Vite
  if is_vite_running; then
    info "Vite (port $VITE_PORT): running"
  else
    warn "Vite (port $VITE_PORT): stopped"
  fi

  if [ "$VOICE_ENTRY_ENABLED" = "1" ]; then
    if is_voice_entry_running; then
      info "Voice entry (port $VOICE_ENTRY_PORT): running"
      if voice_entry_token_matches; then
        info "Voice entry token: enabled"
      else
        warn "Voice entry token: mismatch (run cc-g2 !)"
        ok=false
      fi
    else
      warn "Voice entry (port $VOICE_ENTRY_PORT): stopped"
    fi
  else
    info "Voice entry: disabled"
  fi

  # G2 プロジェクト
  if [ -d "$G2_PROJECT_DIR" ] && [ -f "$G2_PROJECT_DIR/package.json" ]; then
    info "Project: $G2_PROJECT_DIR"
  else
    warn "Project: $G2_PROJECT_DIR (not found)"; ok=false
  fi
  if [ -d "$G2_PROJECT_DIR/node_modules" ]; then
    info "node_modules: installed"
  else
    warn "node_modules: not found (run: cd $G2_PROJECT_DIR && pnpm install)"; ok=false
  fi

  echo
  if $ok; then
    info "All checks passed"
  else
    warn "Some checks failed — see warnings above"
  fi
}

# --- main ---
run_internal_command "${1:-}" "${@:2}"

case "${1:-}" in
  new)     FORCE_NEW_SESSION=1; shift ;;
  stop)    cmd_stop; exit 0 ;;
  status)  cmd_status; exit 0 ;;
  doctor)  cmd_doctor; exit 0 ;;
  '!')     info "インフラを再起動します"; cmd_stop; FORCE_INFRA_RESTART=1; shift ;;
esac

if [ "$FORCE_INFRA_RESTART" = "1" ]; then
  refresh_hub_auth_token
fi

# tmux 外で実行された場合、tmux セッション内で自分自身を再実行する。
# G2 の reply-relay は tmux pane ID を使って返信先を特定するため、
# tmux 内で動いていないと返信が届かない。
if [ -z "${TMUX:-}" ] || [ "$FORCE_NEW_SESSION" = "1" ]; then
  # インフラは tmux 外で先に起動（tmux 内から nohup すると問題になる場合がある）
  ensure_infra
  echo

  # セッション名: g2-<basename>-<path hash>
  # basename は読みやすさ用、短い hash で同名ディレクトリ衝突を避ける。
  WORK_DIR="$(pwd)"
  if [ "$FORCE_NEW_SESSION" = "1" ]; then
    TMUX_SESSION="$(make_unique_tmux_session_name "$WORK_DIR")"
  else
    TMUX_SESSION="$(make_tmux_session_name "$WORK_DIR")"
  fi

  info "tmux セッション '${TMUX_SESSION}' を作成中..."

  # 既存セッションがあれば attach、なければ新規作成して cc-g2 を再実行
  if [ "$FORCE_NEW_SESSION" != "1" ] && tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    info "既存セッションにアタッチ"
    exec tmux attach-session -t "$TMUX_SESSION"
  else
    # _CC_G2_INSIDE=1 をマーカーにして tmux 内での再帰を防ぐ
    # tmux new-session -e で環境変数を明示的に渡す
    tmux_env=(
      -e _CC_G2_INSIDE=1
      -e MOSHI_NOTIFY=1
      -e CC_G2_TMUX_TARGET="${TMUX_SESSION}:0.0"
      -e CC_G2_ENABLE_STATUSLINE="${ENABLE_STATUSLINE}"
      -e CC_G2_ORIG_STATUSLINE_CMD="${ORIG_STATUSLINE_CMD}"
    )
    if ! tmux new-session -s "$TMUX_SESSION" -c "$WORK_DIR" \
      "${tmux_env[@]}" \
      "\"$0\" $*; exec \$SHELL"; then
      echo >&2
      echo "[g2] tmux セッションの作成に失敗しました。" >&2
      echo "[g2] 対話型ターミナル（Terminal.app / iTerm2 / Ghostty など）から実行してください。" >&2
      exit 1
    fi
  fi
fi

# ここに来るのは tmux 内で実行された場合
# 通常は _CC_G2_INSIDE=1 ならインフラ起動済みとしてスキップ。
# ただし `cc-g2 !` は明示的に stop 済みなので、tmux 内でも必ず再起動する。
if [ "${_CC_G2_INSIDE:-}" != "1" ] || [ "$FORCE_INFRA_RESTART" = "1" ]; then
  ensure_infra
fi

# 起動時オプションを前処理。
# --codex は cc-g2 側で吸収し、claude 本体へは渡さない。
USE_CODEX_PROXY=0
CLAUDE_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--codex" ]; then
    USE_CODEX_PROXY=1
    continue
  fi
  CLAUDE_ARGS+=("$arg")
done

# QR コードを tmux 内で表示（スキャンしてから Enter で Claude Code 起動）
show_qr

info "Claude Code 起動 (MOSHI_NOTIFY=1)"
info "CWD: $(pwd)"
echo

# --settings で G2 用 hook を注入
# (どのディレクトリから実行しても PermissionRequest / Stop が動く)
STATUSLINE_SCRIPT="${G2_PROJECT_DIR}/scripts/cc-g2-statusline.sh"
STOP_NOTIFY_SCRIPT="${G2_PROJECT_DIR}/scripts/cc-g2-stop-notify.sh"
STATUSLINE_CMD=""
[ "$ENABLE_STATUSLINE" = "1" ] && [ -x "$STATUSLINE_SCRIPT" ] && STATUSLINE_CMD="bash ${STATUSLINE_SCRIPT}"

SETTINGS_JSON=$(jq -nc \
  --arg hub_url "http://127.0.0.1:${HUB_PORT}" \
  --arg hub_token "$HUB_AUTH_TOKEN" \
  --arg statusline_cmd "$STATUSLINE_CMD" \
  --arg stop_cmd "bash ${STOP_NOTIFY_SCRIPT}" \
  '{
    hooks: {
      PermissionRequest: [{
        matcher: "",
        hooks: [{
          type: "http",
          url: ($hub_url + "/api/hooks/permission-request"),
          timeout: 310,
          headers: {"X-Tmux-Target": "$CC_G2_TMUX_TARGET", "X-CC-G2-Token": $hub_token},
          allowedEnvVars: ["CC_G2_TMUX_TARGET"]
        }]
      }],
      Stop: [{
        hooks: [{
          type: "command",
          command: $stop_cmd,
          async: true
        }]
      }]
    }
  }
  | if $statusline_cmd != "bash " then
      .statusLine = {type: "command", command: $statusline_cmd}
    else . end
  ')

if [ "$USE_CODEX_PROXY" -eq 1 ]; then
  SETTINGS_JSON=$(echo "$SETTINGS_JSON" | jq -c '.teammateMode = "in-process"')
fi

info "Hooks: PermissionRequest (HTTP) + Stop (通知)"
if [ -n "$STATUSLINE_CMD" ]; then
  info "StatusLine wrapper: ${STATUSLINE_SCRIPT}"
  info "StatusLine delegate: ${ORIG_STATUSLINE_CMD}"
else
  if [ -n "$ORIG_STATUSLINE_CMD" ]; then
    info "StatusLine: disabled (set CC_G2_ENABLE_STATUSLINE=1 to enable)"
  else
    info "StatusLine: no user statusLine.command found in ~/.claude/settings.json"
  fi
fi

if [ "$USE_CODEX_PROXY" -eq 1 ]; then
  info "Model Route: Codex Proxy (--codex)"
  if [ "${#CLAUDE_ARGS[@]}" -gt 0 ]; then
    exec env \
      MOSHI_NOTIFY=1 \
      HUB_PORT="$HUB_PORT" \
      HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" \
      CC_G2_ORIG_STATUSLINE_CMD="$ORIG_STATUSLINE_CMD" \
      ANTHROPIC_BASE_URL="http://127.0.0.1:8317" \
      ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-6" \
      ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.4" \
      ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.7" \
      ANTHROPIC_AUTH_TOKEN="sk-dummy" \
      API_TIMEOUT_MS="3000000" \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
      "$CLAUDE_BIN" --settings "$SETTINGS_JSON" "${CLAUDE_ARGS[@]}"
  fi
  exec env \
    MOSHI_NOTIFY=1 \
    HUB_PORT="$HUB_PORT" \
    HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" \
    CC_G2_ORIG_STATUSLINE_CMD="$ORIG_STATUSLINE_CMD" \
    ANTHROPIC_BASE_URL="http://127.0.0.1:8317" \
    ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-6" \
    ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.4" \
    ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.7" \
    ANTHROPIC_AUTH_TOKEN="sk-dummy" \
    API_TIMEOUT_MS="3000000" \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
    "$CLAUDE_BIN" --settings "$SETTINGS_JSON"
fi

if [ "${#CLAUDE_ARGS[@]}" -gt 0 ]; then
  exec env MOSHI_NOTIFY=1 HUB_PORT="$HUB_PORT" HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" CC_G2_ORIG_STATUSLINE_CMD="$ORIG_STATUSLINE_CMD" "$CLAUDE_BIN" --settings "$SETTINGS_JSON" "${CLAUDE_ARGS[@]}"
fi
exec env MOSHI_NOTIFY=1 HUB_PORT="$HUB_PORT" HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" CC_G2_ORIG_STATUSLINE_CMD="$ORIG_STATUSLINE_CMD" "$CLAUDE_BIN" --settings "$SETTINGS_JSON"
