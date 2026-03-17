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

CURRENT_STEP="init"
dump_debug_on_error() {
  local rc="$?"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local prefix="${DEBUG_DIR}/stop-hook-fail-${ts}-$$"
  {
    echo "timestamp=${ts}"
    echo "step=${CURRENT_STEP}"
    echo "exit_code=${rc}"
    echo "hook_input_bytes=${#HOOK_INPUT}"
    echo "cwd=${CWD:-}"
    echo "transcript_path=${TRANSCRIPT_PATH:-}"
    echo "tmux_target=${TMUX_TARGET:-}"
    echo "lang=${LANG:-}"
    echo "lc_all=${LC_ALL:-}"
    echo "jq_version=$(jq --version 2>/dev/null || echo unknown)"
    echo "iconv_version=$(iconv --version 2>/dev/null | head -n 1 || echo unknown)"
    echo "last_message_full_bytes=${#LAST_MESSAGE_FULL:-0}"
    echo "last_message_clean_bytes=${#LAST_MESSAGE_CLEAN:-0}"
  } > "${prefix}.txt" 2>/dev/null || true
  printf '%s' "$HOOK_INPUT" > "${prefix}.hook-input.json" 2>/dev/null || true
  if [ -n "${TRANSCRIPT_PATH:-}" ] && [ -f "${TRANSCRIPT_PATH:-}" ]; then
    tail -n 800 "${TRANSCRIPT_PATH}" > "${prefix}.transcript-tail.jsonl" 2>/dev/null || true
  fi
}
trap 'dump_debug_on_error' ERR

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

resolve_tmux_target() {
  # cc-g2 が起動時に注入する送信元paneを最優先（セッション名に依存しない）
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
    if [[ "$prefix" =~ -[0-9a-f]{4}$ ]]; then
      printf '#%s' "$suffix"
      return 0
    fi
  fi
  if [[ "$session" =~ -[0-9a-f]{4}$ ]]; then
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
    | if length == 0 then ""
      else last
      end
  ' 2>/dev/null)

  if [ -z "$msg" ] || [ "$msg" = "null" ]; then
    msg=""
  fi

  # fallback
  if [ -z "$msg" ]; then
    msg=$(tail -200 "$path" | \
      grep '"type":"assistant"' | \
      tail -1 | \
      jq -r '.message.content[]? | select(.type=="text") | .text // empty' 2>/dev/null)
  fi

  printf '%s' "$msg"
}

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
    echo "tmux_target=${TMUX_TARGET:-}"
  } >> "${DEBUG_DIR}/stop-hook-last-error.log" 2>/dev/null || true
fi

exit 0
