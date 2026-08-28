#!/usr/bin/env bash
# codex-stop-notify.sh
# Codex CLI Stop hook -> cc-g2 Notification Hub bridge
#
# stdin: Codex Stop hook JSON
# env:
#   HUB_URL / HUB_PORT
#   HUB_AUTH_TOKEN
#   CC_G2_TMUX_TARGET

set -euo pipefail

HOOK_INPUT="$(cat)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEBUG_DIR="${PROJECT_DIR}/tmp/notification-hub"
mkdir -p "$DEBUG_DIR"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CURRENT_STEP="init"
trap 'dump_debug_on_error "codex-stop-hook-fail"' ERR

if [ -z "$HOOK_INPUT" ]; then
  exit 0
fi

CURRENT_STEP="parse_transport"
HUB_PORT="${HUB_PORT:-8787}"
HUB_URL="${HUB_URL:-http://127.0.0.1:${HUB_PORT}}"
HUB_AUTH_TOKEN="$(resolve_hub_auth_token "$PROJECT_DIR")"

CURRENT_STEP="hub_healthcheck"
if ! curl -s --max-time 1 "${HUB_URL}/api/health" >/dev/null 2>&1; then
  exit 0
fi

json_value() {
  local expr="$1"
  printf '%s' "$HOOK_INPUT" | jq -r "$expr // empty" 2>/dev/null || true
}

CURRENT_STEP="parse_fields"
CWD="$(json_value '.cwd')"
if [ -z "$CWD" ]; then
  CWD="$(pwd)"
fi
SESSION_ID="$(json_value '.session_id')"
TRANSCRIPT_PATH="$(json_value '.transcript_path')"
STOP_REASON="$(json_value '.stop_reason')"
LAST_MESSAGE_FULL="$(
  printf '%s' "$HOOK_INPUT" | jq -r '
    .last_assistant_message // .last_message // .assistant_message // .message // .output_text // empty
  ' 2>/dev/null || true
)"

if [ -z "$LAST_MESSAGE_FULL" ] && [ -n "$TRANSCRIPT_PATH" ]; then
  CURRENT_STEP="extract_transcript"
  prev=""
  for _ in 1 2 3 4 5 6 7 8; do
    cur="$(extract_last_assistant_text "$TRANSCRIPT_PATH" | head -c 16000)"
    if [ -n "$cur" ]; then
      LAST_MESSAGE_FULL="$cur"
    fi
    if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then
      break
    fi
    prev="$cur"
    sleep 0.2
  done
fi

CURRENT_STEP="build_payload"
TMUX_TARGET="$(resolve_tmux_target)"
SESSION_LABEL="$(derive_session_label "$(resolve_tmux_session_name)")"
PROJECT="$(basename "${CWD:-unknown}")"
LAST_MESSAGE_CLEAN="$(printf '%s' "$LAST_MESSAGE_FULL" | sed 's/\r$//' | sed 's/[[:space:]]\+$//')"
if [ -z "$LAST_MESSAGE_CLEAN" ]; then
  LAST_MESSAGE_CLEAN="(no final assistant message)"
fi
LAST_MESSAGE="$(printf '%s' "$LAST_MESSAGE_CLEAN" | head -c 200)"
SUMMARY="完了: ${PROJECT}"
if [ -n "$LAST_MESSAGE" ]; then
  LAST_MESSAGE_ONE_LINE="${LAST_MESSAGE//$'\n'/ }"
  SUMMARY="${SUMMARY} - $(printf '%s' "$LAST_MESSAGE_ONE_LINE" | head -c 50)"
fi

FULL_TEXT="Session Complete

Project: ${PROJECT}
CWD: ${CWD:-unknown}
TMUX: ${TMUX_TARGET:-unknown}
Reason: ${STOP_REASON:-unknown}

${LAST_MESSAGE_CLEAN}"

PAYLOAD="$(jq -n \
  --arg title "完了: ${PROJECT}" \
  --arg body "$FULL_TEXT" \
  --arg summary "$SUMMARY" \
  --arg hookType "stop" \
  --arg cwd "${CWD:-}" \
  --arg project "$PROJECT" \
  --arg agent "codex" \
  --arg tmuxTarget "${TMUX_TARGET:-}" \
  --arg sessionLabel "${SESSION_LABEL:-}" \
  --arg sessionId "${SESSION_ID:-}" \
  --arg stopReason "${STOP_REASON:-}" \
  --arg ts "$(date +%s)" \
  '{
    title: $title,
    body: $body,
    summary: $summary,
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
      sessionLabel: (if $sessionLabel == "" then null else $sessionLabel end),
      sessionId: (if $sessionId == "" then null else $sessionId end),
      stopReason: (if $stopReason == "" then null else $stopReason end)
    }
  }')"

post_notification_payload "$PAYLOAD" \
  "${DEBUG_DIR}/codex-stop-hook-last-error.log" \
  "project=${PROJECT:-}" \
  "session_id=${SESSION_ID:-}"

exit 0
