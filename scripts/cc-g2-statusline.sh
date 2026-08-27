#!/bin/bash
# cc-g2-statusline — Claude Code StatusLine hook wrapper
#
# 既存の StatusLine スクリプトの表示を維持しつつ、
# コンテキスト占有率を Notification Hub に送信する。
#
# 環境変数:
#   HUB_PORT (default: 8787) — Notification Hub のポート
#   CC_G2_ORIG_STATUSLINE_CMD — 元の StatusLine command
#     未設定時は ~/.claude/scripts/statusline.sh を使用

input=$(cat)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

HUB_PORT="${HUB_PORT:-8787}"
HUB_AUTH_TOKEN="$(resolve_hub_auth_token "$PROJECT_DIR")"
ORIG_STATUSLINE_CMD="${CC_G2_ORIG_STATUSLINE_CMD:-}"

# コンテキスト占有率をトークン数から計算（used_percentageは初期nullの場合があるため）
if command -v jq &>/dev/null; then
  usage=$(echo "$input" | jq '.context_window.current_usage')
  if [ "$usage" != "null" ] && [ -n "$usage" ]; then
    current=$(echo "$usage" | jq '(.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)')
    size=$(echo "$input" | jq '.context_window.context_window_size // 200000')
    pct=$(( (current * 100 + size / 2) / size ))
  else
    pct=0
  fi
  session=$(echo "$input" | jq -r '.session_id // "unknown"')
  cwd=$(echo "$input" | jq -r '.cwd // ""')
  model=$(echo "$input" | jq -r '.model.display_name // "claude"')
else
  eval "$(echo "$input" | node -e '
    const d = JSON.parse(require("fs").readFileSync(0,"utf8") || "{}");
    const cw = d.context_window || {};
    const cu = cw.current_usage || {};
    const current = (cu.input_tokens||0) + (cu.cache_creation_input_tokens||0) + (cu.cache_read_input_tokens||0);
    const size = cw.context_window_size || 200000;
    const pct = Math.round(current * 100 / size);
    const q = v => String(v||"").replace(/\x27/g,"\x27\\\x27\x27");
    console.log([
      `pct=\x27${pct}\x27`,
      `model=\x27${q((d.model||{}).display_name||"claude")}\x27`,
      `session=\x27${q(d.session_id||"unknown")}\x27`,
      `cwd=\x27${q(d.cwd||"")}\x27`,
    ].join("\n"));
  ' 2>/dev/null)"
fi

# Hub にコンテキスト情報を送信（非同期、失敗は無視）
# current_usage が null（セッション開始直後）の場合は pct=0 を送信しない
if [ "${pct:-0}" -gt 0 ]; then
  curl -s -X POST "http://127.0.0.1:${HUB_PORT}/api/context-status" \
    -H "Content-Type: application/json" \
    ${HUB_AUTH_TOKEN:+-H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}"} \
    -d "{\"sessionId\":\"${session}\",\"cwd\":\"${cwd}\",\"usedPercentage\":${pct},\"model\":\"${model}\"}" \
    &>/dev/null &
fi

# 元の StatusLine command に委譲（PC上の表示はそのまま維持）
if [ -n "$ORIG_STATUSLINE_CMD" ]; then
  echo "$input" | /bin/sh -lc "$ORIG_STATUSLINE_CMD"
else
  # フォールバック: 簡易表示
  echo "${model} | ctx:${pct:-0}%"
fi
