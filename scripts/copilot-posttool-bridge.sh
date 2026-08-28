#!/usr/bin/env bash
# copilot-posttool-bridge.sh
# GitHub Copilot CLI postToolUse hook → cc-g2 Notification Hub bridge
#
# 「ツールが成功実行された = ローカルで承認された」の確実なシグナル。
# stdin の camelCase ペイロードを Hub の /api/hooks/tool-executed に転送し、
# 該当 sessionId の pending 承認をローカル決着として解決させる
# （nonblocking モードでリモートのボタンを閉じるため）。
#
# 注意:
#   - postToolUse は「成功時のみ」発火する。失敗は別イベント postToolUseFailure だが
#     今回は配線しない（成功時のローカル決着検知のみで十分）。
#   - 突合キーは .toolArgs（.toolInput ではない）。preToolUse 実測では toolArgs が
#     オブジェクトでなく JSON 文字列で来る例があるため、文字列なら fromjson でパースする。
#   - copilot の toolName は小文字（例 "bash"）。Hub 側で大文字小文字を無視して突合する
#     ため、ここでは変換しない。
#   - 設計上ツール実行を絶対に妨げない: Hub 未接続・失敗・タイムアウトでも exit 0。
#
# 環境変数:
#   HUB_URL / HUB_PORT
#   HUB_AUTH_TOKEN（未設定なら cc-g2 外の起動とみなし即通過）

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

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  exit 0
fi

# 突合キーを抽出（camelCase）
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.toolName // empty')
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.sessionId // empty')

# toolArgs はオブジェクトか JSON 文字列のどちらか。文字列なら fromjson でパースし、
# パースに失敗したら突合できないので静かに通過する。
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '
  (.toolArgs // {}) as $a
  | if ($a | type) == "string" then ($a | fromjson) else $a end
' 2>/dev/null || true)
if [ -z "$TOOL_INPUT" ]; then
  exit 0
fi

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
  -H "X-Agent-Source: copilot"
  -H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}"
  -d "$PAYLOAD"
)

# 失敗してもツール実行を妨げないよう常に exit 0
curl "${CURL_ARGS[@]}" >/dev/null 2>&1 || true
exit 0
