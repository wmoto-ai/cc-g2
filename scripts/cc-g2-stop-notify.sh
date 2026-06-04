#!/bin/bash
# cc-g2 Stop hook: Claude Code 完了通知を Notification Hub に送信
# cc-g2.sh の --settings 経由で注入される
#
# stdin: Claude Code Stop hook JSON (transcript_path, cwd, stop_hook_active)
# 環境変数: HUB_PORT (default: 8787)

set -euo pipefail

HOOK_INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEBUG_DIR="${PROJECT_DIR}/tmp/notification-hub"
mkdir -p "$DEBUG_DIR"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CURRENT_STEP="init"
trap 'dump_debug_on_error "stop-hook-fail"' ERR

sanitize_utf8() {
  # transcript に不正 UTF-8 が混ざる場合があるため、payload 前に無害化する
  if command -v iconv >/dev/null 2>&1; then
    # iconv 失敗時は元文字列を返す（ここで落とさない）
    printf '%s' "$1" | iconv -f UTF-8 -t UTF-8//IGNORE 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

# 無限ループ防止
CURRENT_STEP="parse_stop_hook_active"
STOP_HOOK_ACTIVE=$(echo "$HOOK_INPUT" | jq -r '.stop_hook_active')
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

HUB_PORT="${HUB_PORT:-8787}"
HUB_AUTH_TOKEN="${HUB_AUTH_TOKEN:-}"
HUB_URL="http://127.0.0.1:${HUB_PORT}"

# Hub が起動しているか簡易チェック
CURRENT_STEP="hub_healthcheck"
if ! curl -s --max-time 1 "${HUB_URL}/api/health" >/dev/null 2>&1; then
  exit 0
fi

CURRENT_STEP="parse_hook_input"
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$HOOK_INPUT" | jq -r '.cwd // empty')

CURRENT_STEP="resolve_tmux_target"
TMUX_TARGET="$(resolve_tmux_target)"
SESSION_LABEL="$(derive_session_label "${TMUX_TARGET:-}")"

LAST_MESSAGE_FULL=""
if [ -n "$TRANSCRIPT_PATH" ]; then
  CURRENT_STEP="extract_transcript"
  prev=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    cur="$(extract_last_assistant_text "$TRANSCRIPT_PATH" | head -c 16000)"
    if [ -n "$cur" ]; then
      LAST_MESSAGE_FULL="$cur"
    fi
    if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then
      break
    fi
    prev="$cur"
    sleep 0.25
  done
fi

CURRENT_STEP="build_payload"
LAST_MESSAGE_CLEAN="$(printf '%s' "$LAST_MESSAGE_FULL" | sed 's/\r$//' | sed 's/[[:space:]]\+$//' | sed '/^\s*$/N;/^\n$/D')"
if [ -z "$LAST_MESSAGE_CLEAN" ]; then
  LAST_MESSAGE_CLEAN="(no transcript)"
fi
LAST_MESSAGE_CLEAN="$(sanitize_utf8 "$LAST_MESSAGE_CLEAN")"
if [ -z "$LAST_MESSAGE_CLEAN" ]; then
  LAST_MESSAGE_CLEAN="(no transcript)"
fi
LAST_MESSAGE="$(printf '%s' "$LAST_MESSAGE_CLEAN" | head -c 200)"

PROJECT=$(basename "${CWD:-unknown}")
SUMMARY="完了: ${PROJECT}"
if [ -n "$LAST_MESSAGE" ]; then
  LAST_MESSAGE_ONE_LINE="${LAST_MESSAGE//$'\n'/ }"
  SUMMARY="${SUMMARY} - $(printf '%s' "$LAST_MESSAGE_ONE_LINE" | head -c 50)"
fi

FULL_TEXT="Session Complete

Project: ${PROJECT}
CWD: ${CWD:-unknown}
TMUX: ${TMUX_TARGET:-unknown}

${LAST_MESSAGE_CLEAN}"

PAYLOAD=$(jq -n \
  --arg title "完了: ${PROJECT}" \
  --arg body "$FULL_TEXT" \
  --arg summary "$SUMMARY" \
  --arg hookType "stop" \
  --arg cwd "${CWD:-}" \
  --arg project "$PROJECT" \
  --arg agent "claude-code" \
  --arg tmuxTarget "${TMUX_TARGET:-}" \
  --arg sessionLabel "${SESSION_LABEL:-}" \
  --arg ts "$(date +%s)" \
  '{
    title: $title,
    body: $body,
    threadId: (
      "stop_"
      + ($project | gsub("[^a-zA-Z0-9_-]"; "_"))
      + "_" + $ts
      + (if $tmuxTarget == "" then "" else "_" + ($tmuxTarget | gsub("[^a-zA-Z0-9_-]"; "_")) end)
    ),
    hookType: $hookType,
    metadata: {
      hookType: $hookType,
      cwd: $cwd,
      project: $project,
      agentName: $agent,
      tmuxTarget: (if $tmuxTarget == "" then null else $tmuxTarget end),
      sessionLabel: (if $sessionLabel == "" then null else $sessionLabel end)
    }
  }')

post_notification_payload "$PAYLOAD" \
  "${DEBUG_DIR}/stop-hook-last-error.log" \
  "project=${PROJECT:-}" \
  "tmux_target=${TMUX_TARGET:-}"

exit 0
