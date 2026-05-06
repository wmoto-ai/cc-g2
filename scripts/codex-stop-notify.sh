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

CURRENT_STEP="init"
dump_debug_on_error() {
  local rc="$?"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local prefix="${DEBUG_DIR}/codex-stop-hook-fail-${ts}-$$"
  {
    echo "timestamp=${ts}"
    echo "step=${CURRENT_STEP}"
    echo "exit_code=${rc}"
    echo "hook_input_bytes=${#HOOK_INPUT}"
    echo "cwd=${CWD:-}"
    echo "session_id=${SESSION_ID:-}"
    echo "tmux_target=${TMUX_TARGET:-}"
    echo "transcript_path=${TRANSCRIPT_PATH:-}"
    echo "last_message_bytes=${#LAST_MESSAGE_CLEAN:-0}"
  } > "${prefix}.txt" 2>/dev/null || true
  printf '%s' "$HOOK_INPUT" > "${prefix}.hook-input.json" 2>/dev/null || true
}
trap 'dump_debug_on_error' ERR

if [ -z "$HOOK_INPUT" ]; then
  exit 0
fi

CURRENT_STEP="parse_transport"
HUB_PORT="${HUB_PORT:-8787}"
HUB_URL="${HUB_URL:-http://127.0.0.1:${HUB_PORT}}"
HUB_AUTH_TOKEN="${HUB_AUTH_TOKEN:-}"

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

resolve_tmux_target() {
  if [ -n "${CC_G2_TMUX_TARGET:-}" ]; then
    printf '%s' "$CC_G2_TMUX_TARGET"
    return 0
  fi
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    tmux display-message -p '#S:#I.#P' 2>/dev/null || true
  fi
}

derive_session_label() {
  local target="$1"
  local session="${target%%:*}"
  if [ -z "$session" ]; then
    return 0
  fi
  if [[ "$session" =~ -([0-9]+)$ ]]; then
    local suffix="${BASH_REMATCH[1]}"
    local prefix="${session%-${suffix}}"
    if [[ "$prefix" =~ -[0-9a-f]{4}(-codex)?$ ]]; then
      printf '#%s' "$suffix"
      return 0
    fi
  fi
  if [[ "$session" =~ -[0-9a-f]{4}(-codex)?$ ]]; then
    printf '#1'
  fi
}

extract_last_assistant_text() {
  local path="$1"
  [ -f "$path" ] || return 0

  local msg
  msg=$(tail -n 4000 "$path" | jq -Rsr '
    def extract_text:
      if (.message?.content? | type) == "array" then
        (.message.content
          | map(
              if type == "string" then .
              elif .type? == "text" then (.text // "")
              elif .text? then .text
              else ""
              end
            )
          | join("\n"))
      elif (.message?.content? | type) == "string" then
        .message.content
      elif (.content? | type) == "string" then
        .content
      elif (.text? | type) == "string" then
        .text
      else
        ""
      end;

    split("\n")
    | map(fromjson? | select(type=="object"))
    | map(
        select(
          (.type? == "assistant")
          or (.role? == "assistant")
          or (.message?.role? == "assistant")
          or (.message?.type? == "assistant")
        )
        | extract_text
      )
    | map(select(length > 0))
    | if length == 0 then "" else last end
  ' 2>/dev/null)

  if [ -z "$msg" ] || [ "$msg" = "null" ]; then
    msg=""
  fi

  printf '%s' "$msg"
}

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
SESSION_LABEL="$(derive_session_label "${TMUX_TARGET:-}")"
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

CURRENT_STEP="post_notify"
HTTP_CODE="$(
  curl -s -o /dev/null -w '%{http_code}' -X POST "${HUB_URL}/api/notify/moshi" \
    -H "Content-Type: application/json" \
    ${HUB_AUTH_TOKEN:+-H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}"} \
    -d "$PAYLOAD" \
    --connect-timeout 3 \
    --max-time 5 || true
)"

if [ "${HTTP_CODE:-000}" -lt 200 ] || [ "${HTTP_CODE:-000}" -ge 300 ]; then
  CURRENT_STEP="post_notify_http_${HTTP_CODE:-000}"
  {
    echo "timestamp=$(date -u +%Y%m%dT%H%M%SZ)"
    echo "step=${CURRENT_STEP}"
    echo "notify_http_code=${HTTP_CODE:-000}"
    echo "project=${PROJECT:-}"
    echo "session_id=${SESSION_ID:-}"
  } >> "${DEBUG_DIR}/codex-stop-hook-last-error.log" 2>/dev/null || true
fi

exit 0
