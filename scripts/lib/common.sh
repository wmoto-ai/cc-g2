#!/usr/bin/env bash
# scripts/lib/common.sh — cc-g2 共通ライブラリ
# source して使う。直接実行しない。
#
# 呼び出し側の前提:
#   - set -euo pipefail 済み
#   - HOOK_INPUT, DEBUG_DIR, CURRENT_STEP が定義済み（stop-notify 系で使う関数のみ）

# ─── ENV ファイルからの変数読み取り ──────────────────────────────

read_env_file_var() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 1
  awk -F= -v target="$key" '
    $1 == target {
      sub(/^[^=]*=/, "", $0)
      print $0
      exit
    }
  ' "$file"
}

# resolve_env_var <env_var_name> <env_file_key> <project_dir> [default_value]
#   1. 環境変数が既に設定されていればそれを返す
#   2. .env.local → .env の順でファイルから探す
#   3. 見つからなければ default_value を返す
resolve_env_var() {
  local env_var_name="$1"
  local env_file_key="$2"
  local project_dir="$3"
  local default_value="${4:-}"

  local current_value="${!env_var_name:-}"
  if [ -n "$current_value" ]; then
    printf '%s' "$current_value"
    return
  fi

  local value=""
  value="$(read_env_file_var "$project_dir/.env.local" "$env_file_key" || true)"
  [ -n "$value" ] || value="$(read_env_file_var "$project_dir/.env" "$env_file_key" || true)"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return
  fi
  printf '%s' "$default_value"
}

# ─── バイナリ解決 ────────────────────────────────────────────

# resolve_bin <var_name> <fallback_command>
#   環境変数 $var_name が設定済みで実行可能ならそれを、
#   なければ fallback_command を PATH から探す。
resolve_bin() {
  local var_name="$1"
  local fallback="$2"

  local current="${!var_name:-}"
  if [ -n "$current" ] && command -v "$current" >/dev/null 2>&1; then
    command -v "$current"
    return
  fi
  if command -v "$fallback" >/dev/null 2>&1; then
    command -v "$fallback"
    return
  fi
  printf '%s' "${current:-$fallback}"
}

# ─── tmux ターゲット解決 ─────────────────────────────────────

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

# ─── transcript からアシスタントメッセージ抽出 ───────────────

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

  # fallback: jq の JSONL パースが失敗する場合に grep で最後の assistant を取り出す
  if [ -z "$msg" ]; then
    msg=$(tail -200 "$path" | \
      grep '"type":"assistant"' | \
      tail -1 | \
      jq -r '.message.content[]? | select(.type=="text") | .text // empty' 2>/dev/null)
  fi

  printf '%s' "$msg"
}

# ─── デバッグダンプ（ERR trap 用） ──────────────────────────

# dump_debug_on_error <debug_file_prefix>
#   呼び出し側が trap 'dump_debug_on_error "prefix"' ERR で使う。
#   HOOK_INPUT, CURRENT_STEP, CWD, TRANSCRIPT_PATH, TMUX_TARGET,
#   LAST_MESSAGE_FULL, LAST_MESSAGE_CLEAN は呼び出し側のグローバル変数を参照する。
dump_debug_on_error() {
  local rc="$?"
  local file_prefix="${1:-hook-fail}"
  local last_message_full="${LAST_MESSAGE_FULL-}"
  local last_message_clean="${LAST_MESSAGE_CLEAN-}"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local prefix="${DEBUG_DIR}/${file_prefix}-${ts}-$$"
  {
    echo "timestamp=${ts}"
    echo "step=${CURRENT_STEP}"
    echo "exit_code=${rc}"
    echo "hook_input_bytes=${#HOOK_INPUT}"
    echo "cwd=${CWD:-}"
    echo "session_id=${SESSION_ID:-}"
    echo "transcript_path=${TRANSCRIPT_PATH:-}"
    echo "tmux_target=${TMUX_TARGET:-}"
    echo "lang=${LANG:-}"
    echo "lc_all=${LC_ALL:-}"
    echo "jq_version=$(jq --version 2>/dev/null || echo unknown)"
    echo "iconv_version=$(iconv --version 2>/dev/null | head -n 1 || echo unknown)"
    echo "last_message_full_bytes=${#last_message_full}"
    echo "last_message_clean_bytes=${#last_message_clean}"
  } > "${prefix}.txt" 2>/dev/null || true
  printf '%s' "$HOOK_INPUT" > "${prefix}.hook-input.json" 2>/dev/null || true
  if [ -n "${TRANSCRIPT_PATH:-}" ] && [ -f "${TRANSCRIPT_PATH:-}" ]; then
    tail -n 800 "${TRANSCRIPT_PATH}" > "${prefix}.transcript-tail.jsonl" 2>/dev/null || true
  fi
}

# ─── 通知送信 (curl + エラーログ) ──────────────────────────────

# post_notification_payload <payload> <error_log_file> [extra_error_fields...]
#   HUB_URL, HUB_AUTH_TOKEN, CURRENT_STEP は呼び出し側のグローバル変数を参照。
#   payload: jq で構築済みの JSON 文字列
#   error_log_file: エラー時に追記するログファイルパス
#   extra_error_fields: エラーログに追加する "key=value" 文字列群
post_notification_payload() {
  local payload="$1"
  local error_log_file="$2"
  shift 2

  CURRENT_STEP="post_notify"
  local http_code
  http_code="$(
    curl -s -o /dev/null -w '%{http_code}' -X POST "${HUB_URL}/api/notify/moshi" \
      -H "Content-Type: application/json" \
      ${HUB_AUTH_TOKEN:+-H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}"} \
      -d "$payload" \
      --connect-timeout 3 \
      --max-time 5 || true
  )"

  if [ "${http_code:-000}" -lt 200 ] || [ "${http_code:-000}" -ge 300 ]; then
    CURRENT_STEP="post_notify_http_${http_code:-000}"
    {
      echo "timestamp=$(date -u +%Y%m%dT%H%M%SZ)"
      echo "step=${CURRENT_STEP}"
      echo "notify_http_code=${http_code:-000}"
      for field in "$@"; do
        echo "$field"
      done
    } >> "$error_log_file" 2>/dev/null || true
  fi
}

# ─── 起動待ちループ ──────────────────────────────────────────

# wait_for <check_cmd> <max_retries> <sleep_interval>
#   check_cmd が成功するまでリトライ。成功したら 0、タイムアウトで 1 を返す。
wait_for() {
  local check_cmd="$1"
  local max_retries="$2"
  local sleep_interval="$3"
  local retries=0
  while ! eval "$check_cmd" && [ $retries -lt "$max_retries" ]; do
    sleep "$sleep_interval"
    retries=$((retries + 1))
  done
  eval "$check_cmd"
}
