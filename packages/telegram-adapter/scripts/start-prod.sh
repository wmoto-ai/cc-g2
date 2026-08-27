#!/usr/bin/env bash
# 本番 Hub (:8787) 向けにアダプタを独立 tmux セッションとして常駐起動する。
# token は実行時にのみ読み込む(このスクリプトにも tmux コマンドラインにも値は現れない):
#   - TELEGRAM_BOT_TOKEN: bot env ファイル(node --env-file で注入)
#   - HUB_AUTH_TOKEN: Hub が生成した hub-auth-token ファイル(tmux 内シェルで cat 展開)
#
# 使い方: TELEGRAM_ALLOWED_USER_IDS=<あなたの user id> scripts/start-prod.sh
# 停止:   tmux kill-session -t cc-tg-adapter
# ログ:   tmux attach -t cc-tg-adapter または $CC_TG_LOG_FILE を tail
set -euo pipefail

SESSION="${CC_TG_SESSION:-cc-tg-adapter}"
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
BOT_ENV_FILE="${CC_TG_BOT_ENV_FILE:-$PKG_DIR/.env}"
# 注意: Hub は「起動時 cwd の tmp/notification-hub/hub-auth-token」を使う。
# 既定はこのリポジトリのルート(Hub を別チェックアウトから起動した場合は
# CC_TG_HUB_TOKEN_FILE で追従させること。ずれると 401 で承認機能が沈黙する)
HUB_TOKEN_FILE="${CC_TG_HUB_TOKEN_FILE:-$REPO_ROOT/tmp/notification-hub/hub-auth-token}"
DATA_DIR="${CC_TG_DATA_DIR:-$HOME/.local/share/cc-tg-adapter/data}"
INBOX_DIR="${CC_TG_INBOX_DIR:-$HOME/.local/share/cc-tg-adapter/inbox}"
LOG_FILE="${CC_TG_LOG_FILE:-$HOME/.local/share/cc-tg-adapter/adapter.log}"
ALLOWED="${TELEGRAM_ALLOWED_USER_IDS:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
HUB_URL="${HUB_BASE_URL:-http://127.0.0.1:8787}"

env_file_has_key() {
  local key="$1"
  awk -F= -v target="$key" '$1 == target { found = 1 } END { exit found ? 0 : 1 }' "$BOT_ENV_FILE"
}

if [ ! -f "$BOT_ENV_FILE" ]; then
  echo "bot env file not found: $BOT_ENV_FILE" >&2
  echo "TELEGRAM_BOT_TOKEN=<BotFather の token> を書いたファイルを用意し、" >&2
  echo "CC_TG_BOT_ENV_FILE で場所を指定してください(chmod 600 推奨)。" >&2
  exit 1
fi
if [ -z "$ALLOWED" ] && ! env_file_has_key "TELEGRAM_ALLOWED_USER_IDS"; then
  echo "TELEGRAM_ALLOWED_USER_IDS が未設定です(カンマ区切りの数値 user id、必須)。" >&2
  echo "自分の user id は Telegram で @userinfobot に DM すると分かります。" >&2
  echo "例: TELEGRAM_ALLOWED_USER_IDS=123456789 scripts/start-prod.sh" >&2
  exit 1
fi
[ -f "$HUB_TOKEN_FILE" ] || { echo "hub token file not found: $HUB_TOKEN_FILE (Hub 起動済みか、CC_TG_HUB_TOKEN_FILE の場所を確認)" >&2; exit 1; }
mkdir -p "$DATA_DIR" "$INBOX_DIR" "$(dirname "$LOG_FILE")"
chmod 700 "$INBOX_DIR" # 受信物は本人限定(アダプタ側の保存も dir 0700 / file 0600)

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists (attach: tmux attach -t $SESSION)" >&2
  exit 1
fi

# TELEGRAM_CHAT_ID は省略可(アダプタ側で allowlist 先頭にフォールバック)
CHAT_ID_ENV=""
if [ -n "$CHAT_ID" ]; then
  CHAT_ID_ENV="TELEGRAM_CHAT_ID='$CHAT_ID'"
fi

RUNTIME_ENV="HUB_BASE_URL='$HUB_URL' HUB_AUTH_TOKEN=\"\$(cat '$HUB_TOKEN_FILE')\" \
   DATA_DIR='$DATA_DIR' INBOX_DIR='$INBOX_DIR' LOG_LEVEL=info"
if [ -n "$ALLOWED" ]; then
  RUNTIME_ENV="TELEGRAM_ALLOWED_USER_IDS='$ALLOWED' $RUNTIME_ENV"
fi
if [ -n "$CHAT_ID_ENV" ]; then
  RUNTIME_ENV="$CHAT_ID_ENV $RUNTIME_ENV"
fi

if grep -q 'op://' "$BOT_ENV_FILE"; then
  OP_SA_BIN="$(command -v op-sa 2>/dev/null || true)"
  if [ -z "$OP_SA_BIN" ]; then
    echo "op:// 参照を解決する op-sa が見つかりません" >&2
    exit 1
  fi
  NODE_CMD="'$OP_SA_BIN' run --env-file='$BOT_ENV_FILE' -- env $RUNTIME_ENV node --import tsx src/main.ts"
else
  NODE_CMD="$RUNTIME_ENV node --env-file='$BOT_ENV_FILE' --import tsx src/main.ts"
fi

tmux new-session -d -s "$SESSION" -c "$PKG_DIR" \
  "$NODE_CMD 2>&1 | tee -a '$LOG_FILE'"

echo "started tmux session '$SESSION' (hub: $HUB_URL, log: $LOG_FILE)"
