#!/usr/bin/env bash
# scripts/lib/agent-launch.sh — cc-g2 エージェント起動（claude / codex）
# source して使う。直接実行しない。
#
# G2_IMAGE_PROMPT / CODEX_HOOKS_CONFIG / SETTINGS_JSON の生成と
# claude / codex の exec 起動を担う。本体コードは cc-g2.sh から無編集移動。
#
# 呼び出し側の前提:
#   - set -euo pipefail 済み
#   - lib/common.sh（resolve_bin）を source 済み
#   - G2_PROJECT_DIR, HUB_PORT, HUB_AUTH_TOKEN, CLAUDE_BIN, CODEX_BIN,
#     STATUSLINE_SCRIPT, STOP_NOTIFY_SCRIPT, CODEX_HOOK_SCRIPT,
#     CODEX_STOP_NOTIFY_SCRIPT, G2_SEND_IMAGE_SCRIPT, STATUSLINE_CMD,
#     ORIG_STATUSLINE_CMD, CLAUDE_ARGS が定義済み
#   - info / warn / error はエントリ側（cc-g2.sh）で定義済み
#   - launch_* は exec するため戻らない

resolve_original_statusline_cmd() {
  if [ -n "${CC_G2_ORIG_STATUSLINE_CMD:-}" ]; then
    printf '%s' "$CC_G2_ORIG_STATUSLINE_CMD"
    return
  fi

  local settings_file="${HOME}/.claude/settings.json"
  if [ -f "$settings_file" ] && command -v jq >/dev/null 2>&1; then
    local cmd
    cmd="$(jq -r '.statusLine // empty | if type=="object" then .command // empty else . end' "$settings_file" 2>/dev/null || true)"
    if [ -n "$cmd" ] && [ "$cmd" != "null" ]; then
      printf '%s' "$cmd"
      return
    fi
  fi
}

resolve_claude_bin() { resolve_bin "CLAUDE_BIN" "claude"; }
resolve_codex_bin() { resolve_bin "CODEX_BIN" "codex"; }
resolve_copilot_bin() { resolve_bin "COPILOT_BIN" "copilot"; }

# G2 画像送信のプロンプト注入（Claude Code: --append-system-prompt / Codex: developer_instructions）
# HUB_AUTH_TOKEN / HUB_PORT は起動時の env で渡るため、プロンプト側に秘密情報は含めない
build_g2_image_prompt() {
G2_IMAGE_PROMPT="ユーザーの Even G2 スマートグラスに画像やスクリーンショットを表示できる。表示したいときは次を実行する: bash ${G2_SEND_IMAGE_SCRIPT} <画像ファイル> --title \"<短いタイトル>\" （必要な環境変数は設定済み）。スクリーンショットを直接送る場合は <画像ファイル> の代わりに --capture（全画面）または --capture-window（最前面ウィンドウ）。G2 の表示は 576x288 のグレースケールなので、見せたい部分を縦横比 2:1 でトリミングしてから送ると画面いっぱいに表示される。文字を読ませたい場合はスクリーンショットの縮小ではなく、大きな白文字・黒背景で描き直した 2:1 の合成画像を作ると読みやすい。送信に成功すると G2 に通知が届き、ユーザーが通知から「画像を見る」を選んで表示する。"
}

build_codex_hooks_config() {
  CODEX_HOOK_CMD="bash ${CODEX_HOOK_SCRIPT}"
  CODEX_POSTTOOL_CMD="bash ${CODEX_POSTTOOL_SCRIPT}"
  CODEX_STOP_CMD="bash ${CODEX_STOP_NOTIFY_SCRIPT}"
  CODEX_HOOK_CMD_TOML=$(jq -Rnr --arg s "$CODEX_HOOK_CMD" '$s | @json')
  CODEX_POSTTOOL_CMD_TOML=$(jq -Rnr --arg s "$CODEX_POSTTOOL_CMD" '$s | @json')
  CODEX_STOP_CMD_TOML=$(jq -Rnr --arg s "$CODEX_STOP_CMD" '$s | @json')
  # PostToolUse: ローカル決着（手動承認 / auto_review）検知。ツール実行を妨げないよう短タイムアウト。
  CODEX_HOOKS_CONFIG="{ PermissionRequest = [{ matcher = \"\", hooks = [{ type = \"command\", command = ${CODEX_HOOK_CMD_TOML}, timeout = 600, statusMessage = \"G2 承認待ち...\" }] }], PostToolUse = [{ matcher = \"\", hooks = [{ type = \"command\", command = ${CODEX_POSTTOOL_CMD_TOML}, timeout = 10 }] }], Stop = [{ hooks = [{ type = \"command\", command = ${CODEX_STOP_CMD_TOML}, timeout = 30, statusMessage = \"G2 完了通知を送信中...\" }] }] }"
}

launch_codex_agent() {
  info "Hooks: PermissionRequest (command) + PostToolUse (ローカル決着検知) + Stop (通知)"
  info "Model Route: Codex CLI (--codex)"
  CODEX_ENV=(
    MOSHI_NOTIFY=1
    HUB_PORT="$HUB_PORT"
    HUB_URL="http://127.0.0.1:${HUB_PORT}"
    HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN"
    CC_G2_TMUX_TARGET="${CC_G2_TMUX_TARGET:-}"
    CC_G2_TMUX_SESSION="${CC_G2_TMUX_SESSION:-}"
  )
  G2_IMAGE_PROMPT_TOML=$(jq -Rnr --arg s "$G2_IMAGE_PROMPT" '$s | @json')
  CODEX_ARGS=(
    --enable hooks
    -c "hooks=${CODEX_HOOKS_CONFIG}"
    -c "developer_instructions=${G2_IMAGE_PROMPT_TOML}"
  )
  if [ "${#CLAUDE_ARGS[@]}" -gt 0 ]; then
    exec env "${CODEX_ENV[@]}" "$CODEX_BIN" "${CODEX_ARGS[@]}" "${CLAUDE_ARGS[@]}"
  fi
  exec env \
    "${CODEX_ENV[@]}" \
    "$CODEX_BIN" \
    "${CODEX_ARGS[@]}"
}

# Copilot CLI のフック定義はグローバル配置（$COPILOT_HOME/hooks/*.json）しか
# 効かないため、cc-g2 用の定義ファイルを冪等に生成する。
# フックスクリプト側の HUB_AUTH_TOKEN env ゲートにより、cc-g2 外で起動された
# copilot にはこの定義があっても影響しない設計。
# 注意: repo `.github/hooks/*.json` とユーザーレベル両方にあると二重発火するため、
# ユーザーレベル（$COPILOT_HOME/hooks/）のみに置く。
build_copilot_hooks_config() {
  local copilot_home="${COPILOT_HOME:-$HOME/.copilot}"
  COPILOT_HOOKS_DIR="${copilot_home}/hooks"
  COPILOT_HOOKS_FILE="${COPILOT_HOOKS_DIR}/cc-g2.json"

  # フック定義の bash コマンド文字列。空白入りパスでも壊れないよう %q でエスケープ。
  local hook_cmd posttool_cmd stop_cmd
  hook_cmd="bash $(printf '%q' "$COPILOT_HOOK_SCRIPT")"
  posttool_cmd="bash $(printf '%q' "$COPILOT_POSTTOOL_SCRIPT")"
  stop_cmd="bash $(printf '%q' "$COPILOT_STOP_NOTIFY_SCRIPT")"

  # postToolUse: ローカル決着（手動承認）検知。成功時のみ発火。実行を妨げないよう短タイムアウト。
  local expected
  expected="$(jq -n \
    --arg hook_cmd "$hook_cmd" \
    --arg posttool_cmd "$posttool_cmd" \
    --arg stop_cmd "$stop_cmd" \
    '{
      version: 1,
      hooks: {
        permissionRequest: [
          { type: "command", bash: $hook_cmd, timeoutSec: 600 }
        ],
        postToolUse: [
          { type: "command", bash: $posttool_cmd, timeoutSec: 10 }
        ],
        agentStop: [
          { type: "command", bash: $stop_cmd, timeoutSec: 30 }
        ]
      }
    }')"

  # 冪等化: 既存ファイルが期待値と一致すればスキップ
  if [ -f "$COPILOT_HOOKS_FILE" ]; then
    local current
    current="$(jq -S . "$COPILOT_HOOKS_FILE" 2>/dev/null || true)"
    if [ "$current" = "$(printf '%s' "$expected" | jq -S .)" ]; then
      return 0
    fi
  fi

  # atomic 書き込み: 同一ディレクトリに tmp を作って rename（部分書き込み・並行起動対策）
  mkdir -p "$COPILOT_HOOKS_DIR"
  local tmp_file
  tmp_file="$(mktemp "${COPILOT_HOOKS_DIR}/.cc-g2.json.XXXXXX")"
  printf '%s\n' "$expected" > "$tmp_file"
  mv -f "$tmp_file" "$COPILOT_HOOKS_FILE"
}

launch_copilot_agent() {
  info "Hooks: permissionRequest (command) + postToolUse (ローカル決着検知) + agentStop (通知)"
  info "Hooks file: ${COPILOT_HOOKS_FILE:-${COPILOT_HOME:-$HOME/.copilot}/hooks/cc-g2.json}"
  info "Model Route: GitHub Copilot CLI (--copilot)"
  # フックは cwd が trustedFolders に入っている場合のみ発火する。初回はフォルダの
  # trust 確認ダイアログが TUI に出るので、承認するとフック（G2 承認・通知）が有効になる。
  info "初回はフォルダ trust の確認が出ます（承認するとフックが有効になります）"
  # NOTE: Copilot CLI には --append-system-prompt 相当が無いため、G2 画像送信の
  # プロンプト注入（G2_IMAGE_PROMPT）は v1 では省略している。
  COPILOT_ENV=(
    MOSHI_NOTIFY=1
    HUB_PORT="$HUB_PORT"
    HUB_URL="http://127.0.0.1:${HUB_PORT}"
    HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN"
    CC_G2_TMUX_TARGET="${CC_G2_TMUX_TARGET:-}"
    CC_G2_TMUX_SESSION="${CC_G2_TMUX_SESSION:-}"
  )
  if [ "${#CLAUDE_ARGS[@]}" -gt 0 ]; then
    exec env "${COPILOT_ENV[@]}" "$COPILOT_BIN" "${CLAUDE_ARGS[@]}"
  fi
  exec env "${COPILOT_ENV[@]}" "$COPILOT_BIN"
}

build_claude_settings_json() {
CLAUDE_PERMISSION_HOOK_TIMEOUT="${CC_G2_CLAUDE_HOOK_TIMEOUT_SEC:-86400}"
case "$CLAUDE_PERMISSION_HOOK_TIMEOUT" in
  ''|*[!0-9]*) CLAUDE_PERMISSION_HOOK_TIMEOUT=86400 ;;
esac

SETTINGS_JSON=$(jq -nc \
  --arg hub_url "http://127.0.0.1:${HUB_PORT}" \
  --arg hub_token "$HUB_AUTH_TOKEN" \
  --arg statusline_cmd "$STATUSLINE_CMD" \
  --arg stop_cmd "bash ${STOP_NOTIFY_SCRIPT}" \
  --argjson permission_timeout "$CLAUDE_PERMISSION_HOOK_TIMEOUT" \
  '{
    hooks: {
      PermissionRequest: [{
        matcher: "",
        hooks: [{
          type: "http",
          url: ($hub_url + "/api/hooks/permission-request"),
          timeout: $permission_timeout,
          headers: {"X-Tmux-Target": "$CC_G2_TMUX_TARGET", "X-Tmux-Session": "$CC_G2_TMUX_SESSION", "X-CC-G2-Token": $hub_token},
          allowedEnvVars: ["CC_G2_TMUX_TARGET", "CC_G2_TMUX_SESSION"]
        }]
      }],
      PostToolUse: [{
        matcher: "",
        hooks: [{
          type: "http",
          url: ($hub_url + "/api/hooks/tool-executed"),
          timeout: 10,
          headers: {"X-CC-G2-Token": $hub_token}
        }]
      }],
      Stop: [{
        hooks: [{
          type: "command",
          command: $stop_cmd,
          async: true
        }]
      }]
    }
  }
  | if $statusline_cmd != "bash " then
      .statusLine = {type: "command", command: $statusline_cmd}
    else . end
  ')
}

launch_claude_agent() {
info "Hooks: PermissionRequest (HTTP) + PostToolUse (ローカル決着検知) + Stop (通知)"
if [ -n "$STATUSLINE_CMD" ]; then
  info "StatusLine wrapper: ${STATUSLINE_SCRIPT}"
  info "StatusLine delegate: ${ORIG_STATUSLINE_CMD}"
else
  if [ -n "$ORIG_STATUSLINE_CMD" ]; then
    info "StatusLine: disabled (set CC_G2_ENABLE_STATUSLINE=1 to enable)"
  else
    info "StatusLine: no user statusLine.command found in ~/.claude/settings.json"
  fi
fi

if [ "${#CLAUDE_ARGS[@]}" -gt 0 ]; then
  exec env MOSHI_NOTIFY=1 HUB_PORT="$HUB_PORT" HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" CC_G2_ORIG_STATUSLINE_CMD="$ORIG_STATUSLINE_CMD" "$CLAUDE_BIN" --settings "$SETTINGS_JSON" --append-system-prompt "$G2_IMAGE_PROMPT" "${CLAUDE_ARGS[@]}"
fi
exec env MOSHI_NOTIFY=1 HUB_PORT="$HUB_PORT" HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" CC_G2_ORIG_STATUSLINE_CMD="$ORIG_STATUSLINE_CMD" "$CLAUDE_BIN" --settings "$SETTINGS_JSON" --append-system-prompt "$G2_IMAGE_PROMPT"
}
