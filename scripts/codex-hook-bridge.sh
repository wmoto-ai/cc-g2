#!/usr/bin/env bash
# codex-hook-bridge.sh
# Codex CLI PermissionRequest hook → cc-g2 Notification Hub bridge
#
# Codex hooks は command 型のみ対応（HTTP hook 未サポート）のため、
# このスクリプトが stdin JSON を受け取り、Hub の HTTP API に POST して
# 承認結果を Codex 形式の stdout JSON に変換する。
#
# 環境変数:
#   HUB_URL        Hub のベース URL（デフォルト: http://127.0.0.1:8787）
#   HUB_PORT       HUB_URL 未指定時の Hub ポート（デフォルト: 8787）
#   HUB_AUTH_TOKEN  Hub の認証トークン
#   CC_G2_TMUX_TARGET  tmux セッション識別子（任意）

set -euo pipefail

# スクリプトの場所からプロジェクトルートを推定
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

HUB_PORT="${HUB_PORT:-8787}"
HUB_URL="${HUB_URL:-http://127.0.0.1:${HUB_PORT}}"
CC_G2_TMUX_TARGET="${CC_G2_TMUX_TARGET:-}"

# HUB_AUTH_TOKEN: 環境変数がなければトークンファイルから自動検出
HUB_AUTH_TOKEN="${HUB_AUTH_TOKEN:-}"
if [ -z "$HUB_AUTH_TOKEN" ]; then
  TOKEN_FILE="${PROJECT_DIR}/tmp/notification-hub/hub-auth-token"
  if [ -f "$TOKEN_FILE" ]; then
    HUB_AUTH_TOKEN="$(cat "$TOKEN_FILE")"
  fi
fi

# jq が必要
if ! command -v jq &>/dev/null; then
  echo "codex-hook-bridge: jq is required but not found" >&2
  exit 1
fi

# stdin から Codex の JSON を読み取る
INPUT=$(cat)

if [ -z "$INPUT" ]; then
  # 入力がなければ何もせず通過
  exit 0
fi

# Codex 入力から tool_name, tool_input を抽出
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# session_id がなければ Codex 側の情報から生成
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="codex-$$"
fi

# Hub に POST するペイロードを構築
PAYLOAD=$(jq -n \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg cwd "$(pwd)" \
  --arg session_id "$SESSION_ID" \
  '{
    tool_name: $tool_name,
    tool_input: $tool_input,
    cwd: $cwd,
    session_id: $session_id,
    hook_event_name: "PermissionRequest"
  }')

# Hub にリクエスト送信
CURL_ARGS=(
  -s
  --connect-timeout 2
  --max-time 310
  -X POST
  "${HUB_URL}/api/hooks/permission-request"
  -H "Content-Type: application/json"
  -H "X-Agent-Source: codex"
  -w "\n%{http_code}"
)

if [ -n "$HUB_AUTH_TOKEN" ]; then
  CURL_ARGS+=(-H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}")
fi

if [ -n "$CC_G2_TMUX_TARGET" ]; then
  CURL_ARGS+=(-H "X-Tmux-Target: ${CC_G2_TMUX_TARGET}")
fi

CURL_ARGS+=(-d "$PAYLOAD")

RESPONSE=$(curl "${CURL_ARGS[@]}" 2>/dev/null) || {
  # Hub に接続できない場合はそのまま通過（ブロックしない）
  echo "codex-hook-bridge: Hub に接続できません (${HUB_URL})" >&2
  exit 0
}

# レスポンスから HTTP ステータスとボディを分離
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  echo "codex-hook-bridge: Hub から HTTP ${HTTP_CODE} が返りました" >&2
  exit 0
fi

# 空のレスポンス（タイムアウト等）→ そのまま通過
if [ -z "$BODY" ] || [ "$BODY" = "{}" ]; then
  exit 0
fi

# Hub レスポンスから decision を抽出
BEHAVIOR=$(echo "$BODY" | jq -r '.hookSpecificOutput.decision.behavior // empty')
DENY_MESSAGE=$(echo "$BODY" | jq -r '.hookSpecificOutput.decision.message // empty')

case "$BEHAVIOR" in
  allow)
    # Codex PermissionRequest 形式で許可を返す
    jq -n '{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }'
    exit 0
    ;;
  deny)
    # Codex PermissionRequest 形式で拒否を返す
    jq -n --arg message "${DENY_MESSAGE:-G2から拒否されました}" \
      '{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": $message } } }'
    exit 0
    ;;
  *)
    # 不明な decision → そのまま通過
    exit 0
    ;;
esac
