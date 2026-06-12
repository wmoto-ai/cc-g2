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

# G2 画像送信のプロンプト注入（Claude Code: --append-system-prompt / Codex: developer_instructions）
# HUB_AUTH_TOKEN / HUB_PORT は起動時の env で渡るため、プロンプト側に秘密情報は含めない
build_g2_image_prompt() {
G2_IMAGE_PROMPT="ユーザーの Even G2 スマートグラスに画像やスクリーンショットを表示できる。表示したいときは次を実行する: bash ${G2_SEND_IMAGE_SCRIPT} <画像ファイル> --title \"<短いタイトル>\" （必要な環境変数は設定済み）。スクリーンショットを直接送る場合は <画像ファイル> の代わりに --capture（全画面）または --capture-window（最前面ウィンドウ）。G2 の表示は 576x288 のグレースケールなので、見せたい部分を縦横比 2:1 でトリミングしてから送ると画面いっぱいに表示される。文字を読ませたい場合はスクリーンショットの縮小ではなく、大きな白文字・黒背景で描き直した 2:1 の合成画像を作ると読みやすい。送信に成功すると G2 に通知が届き、ユーザーが通知から「画像を見る」を選んで表示する。"
}

build_codex_hooks_config() {
  CODEX_HOOK_CMD="bash ${CODEX_HOOK_SCRIPT}"
  CODEX_STOP_CMD="bash ${CODEX_STOP_NOTIFY_SCRIPT}"
  CODEX_HOOK_CMD_TOML=$(jq -Rnr --arg s "$CODEX_HOOK_CMD" '$s | @json')
  CODEX_STOP_CMD_TOML=$(jq -Rnr --arg s "$CODEX_STOP_CMD" '$s | @json')
  CODEX_HOOKS_CONFIG="{ PermissionRequest = [{ matcher = \"\", hooks = [{ type = \"command\", command = ${CODEX_HOOK_CMD_TOML}, timeout = 600, statusMessage = \"G2 承認待ち...\" }] }], Stop = [{ hooks = [{ type = \"command\", command = ${CODEX_STOP_CMD_TOML}, timeout = 30, statusMessage = \"G2 完了通知を送信中...\" }] }] }"
}

launch_codex_agent() {
  info "Hooks: PermissionRequest (command) + Stop (通知)"
  info "Model Route: Codex CLI (--codex)"
  CODEX_ENV=(
    MOSHI_NOTIFY=1
    HUB_PORT="$HUB_PORT"
    HUB_URL="http://127.0.0.1:${HUB_PORT}"
    HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN"
    CC_G2_TMUX_TARGET="${CC_G2_TMUX_TARGET:-}"
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
          headers: {"X-Tmux-Target": "$CC_G2_TMUX_TARGET", "X-CC-G2-Token": $hub_token},
          allowedEnvVars: ["CC_G2_TMUX_TARGET"]
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
info "Hooks: PermissionRequest (HTTP) + Stop (通知)"
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
