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
#   cc-g2 copilot          # GitHub Copilot CLI + G2
#   cc-g2 --copilot        # GitHub Copilot CLI + G2
#   cc-g2 --help           # ヘルプ表示
#   cc-g2 --version        # バージョン表示
#   cc-g2 !                # インフラ再起動してから Claude Code + G2
#   cc-g2 qr               # QR コードを再表示（tmux 内なら QR ペインを作り直す）
#   cc-g2 stop             # G2 インフラ全停止
#   cc-g2 status           # 状態確認
#   cc-g2 -p "prompt"      # プロンプト付き起動（claude に引数をそのまま渡す）
#
# 環境変数:
#   SHOW_QR=0              # QRコード表示を無効化
#   CC_G2_ENABLE_STATUSLINE=0/1  # 省略時は auto（~/.claude/settings.json に statusLine.command があれば有効）
#   CC_G2_APPROVAL_MODE=longpoll  # 承認をブロッキング（旧挙動）に戻す（既定 nonblocking）。
#                         # nonblocking では CLI のダイアログが即表示され、
#                         # G2/Telegram の決定はキー注入で届く。
#                         # モード切替は Hub 再起動が必要（cc-g2 !）

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
COPILOT_BIN="${COPILOT_BIN:-copilot}"

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

# QR 常駐ペイン内の描画プロセス（tmux split-window から起動される内部コマンド）。
# トークン更新などの起動時副作用より前に処理して即座に描画する。
if [ "${1:-}" = "__render-qr-pane" ]; then
  render_qr_url "${2:-}"
  info "この QR ペインは常駐します（閉じる: Ctrl-D / 再表示: cc-g2 qr）"
  exec "${SHELL:-/bin/bash}"
fi

print_usage() {
  cat <<'EOF'
cc-g2 — Claude Code / Codex CLI + Even G2 launcher

Usage:
  cc-g2 [options] [-- <agent args>]
  cc-g2 new [options] [-- <agent args>]
  cc-g2 --new [options] [-- <agent args>]
  cc-g2 codex [-- <codex args>]
  cc-g2 --codex [-- <codex args>]
  cc-g2 copilot [-- <copilot args>]
  cc-g2 --copilot [-- <copilot args>]
  cc-g2 qr
  cc-g2 stop
  cc-g2 status
  cc-g2 doctor

Options:
  --codex          Launch Codex CLI with G2 hooks
  --native-codex   Launch Codex CLI with G2 hooks (legacy alias)
  --copilot        Launch GitHub Copilot CLI with G2 hooks
  --new            Force a new tmux session
  !                Restart Hub/Vite/Voice Entry before launch
  --help, -h       Show this help
  --version, -v    Show cc-g2 version

Environment:
  SHOW_QR=0        Hide QR code
  CC_G2_QR_PANE_LINES   QR pane height in lines (default: 20, effective min: 14 —
                        shorter windows fall back to inline display)
  CC_G2_QR_TIMEOUT_SEC  evenhub-cli QR render timeout (default: 20)
  G2_PROJECT_DIR   Override the cc-g2 package/project directory
  HUB_PORT         Hub port (default: 8787)
  VITE_PORT        Vite port (default: 5173)
  CC_G2_APPROVAL_MODE=longpoll
                   Revert to blocking approval (hook waits for the G2/Telegram
                   decision). Default is nonblocking: the CLI dialog shows
                   immediately and remote decisions arrive via key injection.
                   Switching modes needs a Hub restart (cc-g2 !).
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

# Telegram adapter
TG_ADAPTER_SESSION="${CC_TG_SESSION:-cc-tg-adapter}"
TG_ADAPTER_DATA_DIR="${CC_TG_DATA_DIR:-$HOME/.local/share/cc-tg-adapter/data}"
TG_ADAPTER_INBOX_DIR="${CC_TG_INBOX_DIR:-$HOME/.local/share/cc-tg-adapter/inbox}"
TG_ADAPTER_LOG_FILE="${CC_TG_LOG_FILE:-$HOME/.local/share/cc-tg-adapter/adapter.log}"
TG_ADAPTER_ENABLED=""
TG_ADAPTER_BOT_TOKEN=""
TG_ADAPTER_ALLOWED_USER_IDS=""
TG_ADAPTER_CHAT_ID=""
TG_ADAPTER_BOT_ENV_FILE=""

GROQ_API_KEY_RESOLVED="$(resolve_groq_api_key)"
OPENAI_API_KEY_RESOLVED="$(resolve_openai_api_key)"
SONIOX_API_KEY_RESOLVED="$(resolve_soniox_api_key)"
ENABLE_STATUSLINE="$(resolve_statusline_flag)"
VOICE_ENTRY_ENABLED="$(resolve_voice_entry_enabled)"
VOICE_ENTRY_REPO_ROOTS="$(resolve_repo_roots)"

TG_ADAPTER_ENABLED="$(resolve_tg_adapter_enabled)"
if [ "$TG_ADAPTER_ENABLED" = "1" ]; then
  TG_ADAPTER_BOT_TOKEN="$(resolve_tg_bot_token)"
  TG_ADAPTER_ALLOWED_USER_IDS="$(resolve_tg_allowed_user_ids)"
  TG_ADAPTER_CHAT_ID="$(resolve_tg_chat_id)"
  TG_ADAPTER_BOT_ENV_FILE="$(resolve_tg_bot_env_file)"
fi

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
      copilot|--copilot|-copilot)
        printf 'copilot'
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
COPILOT_BIN="$(resolve_copilot_bin)"

# --- main ---
run_internal_command "${1:-}" "${@:2}"

case "${1:-}" in
  new|--new) FORCE_NEW_SESSION=1; shift ;;
  codex)   AGENT_MODE="codex"; shift; set -- --codex "$@" ;;
  copilot) AGENT_MODE="copilot"; shift; set -- --copilot "$@" ;;
  stop)    cmd_stop; exit 0 ;;
  status)  cmd_status; exit 0 ;;
  doctor)  cmd_doctor; exit 0 ;;
  qr)      cmd_qr; exit 0 ;;
  '!')     info "インフラを再起動します"; cmd_stop; FORCE_INFRA_RESTART=1; shift ;;
esac

case "${1:-}" in
  -codex|--codex|--native-codex) AGENT_MODE="codex" ;;
  -copilot|--copilot) AGENT_MODE="copilot" ;;
esac

if [ "$FORCE_INFRA_RESTART" = "1" ]; then
  refresh_hub_auth_token
fi

# herdr ペイン内 (HERDR_ENV=1) では tmux セッションを作らず現在ペインで直接起動する。
# reply-relay は herdr:<pane_id> プレフィックス付きターゲットを見て herdr バックエンド
# (reply-relay-herdr.sh) に委譲する。`cc-g2 new` は従来どおり tmux セッションを作る。
if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ] \
  && [ -z "${TMUX:-}" ] && [ "$FORCE_NEW_SESSION" != "1" ]; then
  export CC_G2_TMUX_TARGET="herdr:${HERDR_PANE_ID}"
  info "herdr ペイン ${HERDR_PANE_ID} で直接起動（tmux セッションは作成しません）"
# tmux 外で実行された場合、tmux セッション内で自分自身を再実行する。
# G2 の reply-relay は tmux pane ID を使って返信先を特定するため、
# tmux 内で動いていないと返信が届かない。
elif [ -z "${TMUX:-}" ] || [ "$FORCE_NEW_SESSION" = "1" ]; then
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
    # attach 経路は agent 起動時の QR 表示を通らないため、ここでペインを保証する
    ensure_qr_pane_for_session "$TMUX_SESSION"
    exec tmux attach-session -t "$TMUX_SESSION"
  else
    # _CC_G2_INSIDE=1 をマーカーにして tmux 内での再帰を防ぐ
    # tmux new-session -e で環境変数を明示的に渡す
    build_g2_tmux_env "$TMUX_SESSION" "$AGENT_MODE"
    if [ $# -gt 0 ]; then
      tmux_cmd="$(build_nested_cmd "$@")"
    else
      tmux_cmd="$(build_nested_cmd)"
    fi
    if ! tmux new-session -s "$TMUX_SESSION" -c "$WORK_DIR" \
      "${G2_TMUX_ENV[@]}" \
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

# G2 返信の送信先を pane 固有 ID（%N）に固定する。ペインインデックス（:0.0）は
# QR ペイン追加等で位置が変わるとズレて誤配信するため使わない。
# セッション名はラベル表示用（deriveSessionLabel）に別変数で併送する。
if [ -n "${TMUX_PANE:-}" ]; then
  export CC_G2_TMUX_TARGET="$TMUX_PANE"
  CC_G2_TMUX_SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
  export CC_G2_TMUX_SESSION
  if [ -n "$CC_G2_TMUX_SESSION" ]; then
    tmux set-option -t "$CC_G2_TMUX_SESSION" @cc_g2_agent_pane "$TMUX_PANE" 2>/dev/null || true
  fi
fi

# 起動時オプションを前処理。
# codex / --codex / --native-codex / copilot / --copilot は cc-g2 側で吸収し、
# 起動対象本体へは渡さない（残余引数は CLAUDE_ARGS としてパススルー）。
USE_NATIVE_CODEX=0
USE_COPILOT=0
CLAUDE_ARGS=()
# literal `--` 以降はエージェント本体への引数なので、モードキーワード照合をやめて
# そのまま CLAUDE_ARGS に積む（例: `cc-g2 -- --copilot` は claude に --copilot を渡す）。
# `--` より前に来る tmux 自己再実行の内部マーカー（--codex/--copilot）は従来どおり吸収する。
SEEN_ARG_SEPARATOR=0
for arg in "$@"; do
  if [ "$SEEN_ARG_SEPARATOR" = "0" ] && [ "$arg" = "--" ]; then
    SEEN_ARG_SEPARATOR=1
    CLAUDE_ARGS+=("$arg")
    continue
  fi
  if [ "$SEEN_ARG_SEPARATOR" = "0" ]; then
    if [ "$arg" = "codex" ] || [ "$arg" = "-codex" ] || [ "$arg" = "--codex" ] || [ "$arg" = "--native-codex" ]; then
      USE_NATIVE_CODEX=1
      continue
    fi
    if [ "$arg" = "copilot" ] || [ "$arg" = "-copilot" ] || [ "$arg" = "--copilot" ]; then
      USE_COPILOT=1
      continue
    fi
  fi
  CLAUDE_ARGS+=("$arg")
done

# QR コードを agent ペインの真上の常駐ペインに表示
# （exec で claude/codex の TUI に切り替わっても隠れない）
ensure_qr_pane

if [ "$USE_NATIVE_CODEX" -eq 1 ]; then
  info "Codex CLI 起動 (MOSHI_NOTIFY=1)"
elif [ "$USE_COPILOT" -eq 1 ]; then
  info "GitHub Copilot CLI 起動 (MOSHI_NOTIFY=1)"
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
CODEX_POSTTOOL_SCRIPT="${G2_PROJECT_DIR}/scripts/codex-posttool-bridge.sh"
CODEX_STOP_NOTIFY_SCRIPT="${G2_PROJECT_DIR}/scripts/codex-stop-notify.sh"
COPILOT_HOOK_SCRIPT="${G2_PROJECT_DIR}/scripts/copilot-hook-bridge.sh"
COPILOT_POSTTOOL_SCRIPT="${G2_PROJECT_DIR}/scripts/copilot-posttool-bridge.sh"
COPILOT_STOP_NOTIFY_SCRIPT="${G2_PROJECT_DIR}/scripts/copilot-stop-notify.sh"
STATUSLINE_CMD=""
[ "$ENABLE_STATUSLINE" = "1" ] && [ -x "$STATUSLINE_SCRIPT" ] && STATUSLINE_CMD="bash ${STATUSLINE_SCRIPT}"

# G2 画像送信のプロンプト注入は lib/agent-launch.sh の build_g2_image_prompt が行う
G2_SEND_IMAGE_SCRIPT="${G2_PROJECT_DIR}/scripts/g2-send-image.sh"
build_g2_image_prompt

if [ "$USE_NATIVE_CODEX" -eq 1 ]; then
  build_codex_hooks_config
  launch_codex_agent
fi

if [ "$USE_COPILOT" -eq 1 ]; then
  build_copilot_hooks_config
  launch_copilot_agent
fi

build_claude_settings_json
launch_claude_agent
