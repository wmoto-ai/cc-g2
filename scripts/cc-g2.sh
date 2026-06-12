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
#   cc-g2 --new            # new と同じ
#   cc-g2 codex            # Codex CLI + G2
#   cc-g2 --codex          # Codex CLI + G2
#   cc-g2 --native-codex   # Codex CLI + G2 (互換 alias)
#   cc-g2 --help           # ヘルプ表示
#   cc-g2 --version        # バージョン表示
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
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd -P)"
G2_PROJECT_DIR="${G2_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/tokens.sh
source "${SCRIPT_DIR}/lib/tokens.sh"
# shellcheck source=lib/infra.sh
source "${SCRIPT_DIR}/lib/infra.sh"
# shellcheck source=lib/tmux-session.sh
source "${SCRIPT_DIR}/lib/tmux-session.sh"
# shellcheck source=lib/doctor.sh
source "${SCRIPT_DIR}/lib/doctor.sh"
# shellcheck source=lib/agent-launch.sh
source "${SCRIPT_DIR}/lib/agent-launch.sh"
HUB_PORT="${HUB_PORT:-8787}"
VITE_PORT="${VITE_PORT:-5173}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
CODEX_BIN="${CODEX_BIN:-codex}"

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

print_usage() {
  cat <<'EOF'
cc-g2 — Claude Code / Codex CLI + Even G2 launcher

Usage:
  cc-g2 [options] [-- <agent args>]
  cc-g2 new [options] [-- <agent args>]
  cc-g2 --new [options] [-- <agent args>]
  cc-g2 codex [-- <codex args>]
  cc-g2 --codex [-- <codex args>]
  cc-g2 stop
  cc-g2 status
  cc-g2 doctor

Options:
  --codex          Launch Codex CLI with G2 hooks
  --native-codex   Launch Codex CLI with G2 hooks (legacy alias)
  --new            Force a new tmux session
  !                Restart Hub/Vite/Voice Entry before launch
  --help, -h       Show this help
  --version, -v    Show cc-g2 version

Environment:
  SHOW_QR=0        Hide QR code
  G2_PROJECT_DIR   Override the cc-g2 package/project directory
  HUB_PORT         Hub port (default: 8787)
  VITE_PORT        Vite port (default: 5173)
EOF
}

SHOW_QR="${SHOW_QR:-1}"
ENABLE_STATUSLINE="${CC_G2_ENABLE_STATUSLINE:-}"
FORCE_INFRA_RESTART=0
FORCE_NEW_SESSION=0
AGENT_MODE="claude"
HUB_AUTH_TOKEN_FILE="${G2_PROJECT_DIR}/tmp/notification-hub/hub-auth-token"
VOICE_ENTRY_PORT="${CC_G2_VOICE_ENTRY_PORT:-8797}"
VOICE_ENTRY_BIND="${CC_G2_VOICE_ENTRY_BIND:-0.0.0.0}"
VOICE_ENTRY_TOKEN_FILE="${G2_PROJECT_DIR}/tmp/voice-entry/voice-entry-token"
VOICE_ENTRY_LAST_SESSION_FILE="${G2_PROJECT_DIR}/tmp/voice-entry/last-session.json"
VOICE_ENTRY_LOG_FILE="${G2_PROJECT_DIR}/tmp/voice-entry/voice-entry.log"
VOICE_ENTRY_REPO_ROOTS="${CC_G2_REPO_ROOTS:-}"
VOICE_ENTRY_SCAN_DEPTH="${CC_G2_REPO_SCAN_DEPTH:-3}"
VOICE_ENTRY_ENABLED="${CC_G2_VOICE_ENTRY_ENABLED:-}"

GROQ_API_KEY_RESOLVED="$(resolve_groq_api_key)"
OPENAI_API_KEY_RESOLVED="$(resolve_openai_api_key)"
SONIOX_API_KEY_RESOLVED="$(resolve_soniox_api_key)"
ENABLE_STATUSLINE="$(resolve_statusline_flag)"
VOICE_ENTRY_ENABLED="$(resolve_voice_entry_enabled)"
VOICE_ENTRY_REPO_ROOTS="$(resolve_repo_roots)"

detect_agent_mode() {
  while [ $# -gt 0 ]; do
    case "$1" in
      new|--new|'!')
        shift
        ;;
      codex|--codex|--native-codex|-codex)
        printf 'codex'
        return
        ;;
      *)
        printf 'claude'
        return
        ;;
    esac
  done
  printf 'claude'
}

refresh_hub_auth_token
refresh_voice_entry_token

ORIG_STATUSLINE_CMD="$(resolve_original_statusline_cmd)"

if [ -z "$ENABLE_STATUSLINE" ]; then
  if [ -n "$ORIG_STATUSLINE_CMD" ]; then
    ENABLE_STATUSLINE=1
  else
    ENABLE_STATUSLINE=0
  fi
fi

# --- 依存コマンドチェック ---
for arg in "$@"; do
  case "$arg" in
    --help|-h|help)
      print_usage
      exit 0
      ;;
  esac
done

AGENT_MODE="$(detect_agent_mode "$@")"

# --version / --help は依存チェックより前に処理（tmux などが無くても確認できるように）
case "${1:-}" in
  --version|-v|version)
    ver="$(node -p "require('${G2_PROJECT_DIR}/package.json').version" 2>/dev/null \
      || sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${G2_PROJECT_DIR}/package.json" | head -1)"
    echo "cc-g2 ${ver:-unknown}"
    exit 0 ;;
  --help|-h|help)
    print_usage; exit 0 ;;
esac
check_deps
CLAUDE_BIN="$(resolve_claude_bin)"
CODEX_BIN="$(resolve_codex_bin)"

# --- main ---
run_internal_command "${1:-}" "${@:2}"

case "${1:-}" in
  new|--new) FORCE_NEW_SESSION=1; shift ;;
  codex)   AGENT_MODE="codex"; shift; set -- --codex "$@" ;;
  stop)    cmd_stop; exit 0 ;;
  status)  cmd_status; exit 0 ;;
  doctor)  cmd_doctor; exit 0 ;;
  '!')     info "インフラを再起動します"; cmd_stop; FORCE_INFRA_RESTART=1; shift ;;
esac

case "${1:-}" in
  -codex|--codex|--native-codex) AGENT_MODE="codex" ;;
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
    TMUX_SESSION="$(make_unique_tmux_session_name "$WORK_DIR" "$AGENT_MODE")"
  else
    TMUX_SESSION="$(make_tmux_session_name "$WORK_DIR" "$AGENT_MODE")"
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
    tmux_cmd="\"$0\""
    if [ $# -gt 0 ]; then
      tmux_cmd+="$(printf ' %q' "$@")"
    fi
    tmux_cmd+="; exec \$SHELL"
    if ! tmux new-session -s "$TMUX_SESSION" -c "$WORK_DIR" \
      "${tmux_env[@]}" \
      "$tmux_cmd"; then
      echo >&2
      echo "[g2] tmux セッションの作成に失敗しました。" >&2
      echo "[g2] 対話型ターミナル（Terminal.app / iTerm2 / Ghostty など）から実行してください。" >&2
      exit 1
    fi
  fi
fi

# ここに来るのは tmux 内で実行された場合。
# 初回起動直後や既存プロセスの token mismatch を取りこぼさないよう、
# agent 起動直前にも infra を再確認する。
ensure_infra

# 起動時オプションを前処理。
# codex / --codex / --native-codex は cc-g2 側で吸収し、起動対象本体へは渡さない。
USE_NATIVE_CODEX=0
CLAUDE_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "codex" ] || [ "$arg" = "-codex" ] || [ "$arg" = "--codex" ] || [ "$arg" = "--native-codex" ]; then
    USE_NATIVE_CODEX=1
    continue
  fi
  CLAUDE_ARGS+=("$arg")
done

# QR コードを tmux 内で表示（スキャンしてから Enter で Claude Code 起動）
show_qr

if [ "$USE_NATIVE_CODEX" -eq 1 ]; then
  info "Codex CLI 起動 (MOSHI_NOTIFY=1)"
else
  info "Claude Code 起動 (MOSHI_NOTIFY=1)"
fi
info "CWD: $(pwd)"
echo

# --settings で G2 用 hook を注入
# (どのディレクトリから実行しても PermissionRequest / Stop が動く)
STATUSLINE_SCRIPT="${G2_PROJECT_DIR}/scripts/cc-g2-statusline.sh"
STOP_NOTIFY_SCRIPT="${G2_PROJECT_DIR}/scripts/cc-g2-stop-notify.sh"
CODEX_HOOK_SCRIPT="${G2_PROJECT_DIR}/scripts/codex-hook-bridge.sh"
CODEX_STOP_NOTIFY_SCRIPT="${G2_PROJECT_DIR}/scripts/codex-stop-notify.sh"
STATUSLINE_CMD=""
[ "$ENABLE_STATUSLINE" = "1" ] && [ -x "$STATUSLINE_SCRIPT" ] && STATUSLINE_CMD="bash ${STATUSLINE_SCRIPT}"

# G2 画像送信のプロンプト注入は lib/agent-launch.sh の build_g2_image_prompt が行う
G2_SEND_IMAGE_SCRIPT="${G2_PROJECT_DIR}/scripts/g2-send-image.sh"
build_g2_image_prompt

if [ "$USE_NATIVE_CODEX" -eq 1 ]; then
  build_codex_hooks_config
  launch_codex_agent
fi

build_claude_settings_json
launch_claude_agent
