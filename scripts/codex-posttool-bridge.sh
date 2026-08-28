#!/usr/bin/env bash
# codex-posttool-bridge.sh
# Codex CLI PostToolUse hook → cc-g2 Notification Hub bridge
#
# 「ツールが実行された = ローカルで承認された」の確実なシグナル。
# stdin の PostToolUse JSON を Hub の /api/hooks/tool-executed に転送し、
# 該当 sessionId の pending 承認をローカル決着として解決させる
# （nonblocking モードでリモートのボタンを閉じるため）。
#
# 設計上ツール実行を絶対に妨げない: Hub 未接続・失敗・タイムアウトでも exit 0。
#
# 環境変数:
#   HUB_URL        Hub のベース URL（デフォルト: http://127.0.0.1:8787）
#   HUB_PORT       HUB_URL 未指定時の Hub ポート（デフォルト: 8787）
#   HUB_AUTH_TOKEN  Hub の認証トークン（未設定なら cc-g2 外の起動とみなし即通過）

set -euo pipefail

# env ゲート: cc-g2 経由の起動でのみ HUB_AUTH_TOKEN が env に入る。
if [ -z "${HUB_AUTH_TOKEN:-}" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

HUB_PORT="${HUB_PORT:-8787}"
HUB_URL="${HUB_URL:-http://127.0.0.1:${HUB_PORT}}"
HUB_AUTH_TOKEN="$(resolve_hub_auth_token "$PROJECT_DIR")"

if [ -z "$HUB_AUTH_TOKEN" ]; then
  exit 0
fi

# jq が無ければ何もせず通過
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT="$(cat)"
if [ -z "$INPUT" ]; then
  exit 0
fi

# PostToolUse 入力から突合キーを抽出（snake_case）
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}')
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')

# セッションかツール名が取れなければ突合できないので通過
if [ -z "$TOOL_NAME" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

PAYLOAD=$(jq -n \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg session_id "$SESSION_ID" \
  '{
    tool_name: $tool_name,
    tool_input: $tool_input,
    session_id: $session_id,
    hook_event_name: "PostToolUse"
  }')

CURL_ARGS=(
  -s
  --connect-timeout 1
  --max-time 5
  -X POST
  "${HUB_URL}/api/hooks/tool-executed"
  -H "Content-Type: application/json"
  -H "X-Agent-Source: codex"
  -H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}"
  -d "$PAYLOAD"
)

# 失敗してもツール実行を妨げないよう常に exit 0
curl "${CURL_ARGS[@]}" >/dev/null 2>&1 || true
exit 0
