#!/usr/bin/env bash
# copilot-hook-bridge.sh
# GitHub Copilot CLI permissionRequest hook → cc-g2 Notification Hub bridge
#
# Copilot hooks は command 型のみ対応のため、このスクリプトが stdin JSON を
# 受け取り、Hub の HTTP API に POST して承認結果を Copilot 形式の stdout JSON に
# 変換する。Codex 版 (codex-hook-bridge.sh) との差分:
#   - stdin は camelCase の .toolName / .toolInput / .sessionId / .cwd
#   - X-Agent-Source: copilot
#   - stdout は {"behavior":"allow"} / {"behavior":"deny","message":...}
#   - 応答が取れないときは無出力 exit 0 で TUI プロンプトへフォールスルー
#
# 環境変数:
#   HUB_URL        Hub のベース URL（デフォルト: http://127.0.0.1:8787）
#   HUB_PORT       HUB_URL 未指定時の Hub ポート（デフォルト: 8787）
#   HUB_AUTH_TOKEN  Hub の認証トークン（未設定なら cc-g2 外の起動とみなし即通過）
#   CC_G2_TMUX_TARGET  tmux セッション識別子（任意）

set -euo pipefail

# env ゲート: cc-g2 経由の起動でのみ HUB_AUTH_TOKEN が env に入る。
# グローバル配置の Copilot hook が cc-g2 外の copilot に干渉しないよう、
# 未設定なら何も出力せず通常の権限フローへ通す。
if [ -z "${HUB_AUTH_TOKEN:-}" ]; then
  exit 0
fi

# スクリプトの場所からプロジェクトルートを推定
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

HUB_PORT="${HUB_PORT:-8787}"
HUB_URL="${HUB_URL:-http://127.0.0.1:${HUB_PORT}}"
CC_G2_TMUX_TARGET="${CC_G2_TMUX_TARGET:-}"
CC_G2_TMUX_SESSION="${CC_G2_TMUX_SESSION:-}"

HUB_AUTH_TOKEN="$(resolve_hub_auth_token "$PROJECT_DIR")"

# jq が必要
if ! command -v jq &>/dev/null; then
  echo "copilot-hook-bridge: jq is required but not found" >&2
  exit 0
fi

# stdin から Copilot の JSON を読み取る
INPUT=$(cat)

if [ -z "$INPUT" ]; then
  # 入力がなければ何もせず通過
  exit 0
fi

# Copilot 入力から toolName, toolInput, sessionId, cwd を抽出
TOOL_NAME=$(echo "$INPUT" | jq -r '.toolName // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.toolInput // {}')
SESSION_ID=$(echo "$INPUT" | jq -r '.sessionId // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$CWD" ]; then
  CWD="$(pwd)"
fi

# session_id がなければ Copilot 側の情報から生成
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="copilot-$$"
fi

# Hub に POST するペイロードを構築（既存 Hub スキーマ: snake_case）
PAYLOAD=$(jq -n \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg cwd "$CWD" \
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
  -H "X-Agent-Source: copilot"
  -w "\n%{http_code}"
)

if [ -n "$HUB_AUTH_TOKEN" ]; then
  CURL_ARGS+=(-H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}")
fi

if [ -n "$CC_G2_TMUX_TARGET" ]; then
  CURL_ARGS+=(-H "X-Tmux-Target: ${CC_G2_TMUX_TARGET}")
fi

if [ -n "$CC_G2_TMUX_SESSION" ]; then
  CURL_ARGS+=(-H "X-Tmux-Session: ${CC_G2_TMUX_SESSION}")
fi

CURL_ARGS+=(-d "$PAYLOAD")

RESPONSE=$(curl "${CURL_ARGS[@]}" 2>/dev/null) || {
  # Hub に接続できない場合はそのまま通過（ブロックしない）
  echo "copilot-hook-bridge: Hub に接続できません (${HUB_URL})" >&2
  exit 0
}

# レスポンスから HTTP ステータスとボディを分離
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  echo "copilot-hook-bridge: Hub から HTTP ${HTTP_CODE} が返りました" >&2
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
    # Copilot permissionRequest 形式で許可を返す
    jq -n '{ behavior: "allow" }'
    exit 0
    ;;
  deny)
    # Copilot permissionRequest 形式で拒否を返す
    jq -n --arg message "${DENY_MESSAGE:-G2から拒否されました}" \
      '{ behavior: "deny", message: $message }'
    exit 0
    ;;
  *)
    # 不明な decision → そのまま通過
    exit 0
    ;;
esac
