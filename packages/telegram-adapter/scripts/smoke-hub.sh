#!/usr/bin/env bash
# 検証用 Hub への手動スモーク。
# 承認 / Stop 通知 / 画像 / hook 模擬を curl で注入し、アダプタの実機前確認に使う。
#
# 使い方:
#   HUB=http://127.0.0.1:8788 TOKEN=verify-token scripts/smoke-hub.sh approval
#   scripts/smoke-hub.sh stop
#   scripts/smoke-hub.sh image ./test.png
#   scripts/smoke-hub.sh pending
#   scripts/smoke-hub.sh get <approvalId>
#   scripts/smoke-hub.sh hook   # decide されるまでロングポーリング(コメント付き deny の到達確認)
set -euo pipefail

HUB="${HUB:-http://127.0.0.1:8788}"
TOKEN="${TOKEN:-}"

auth_args=()
if [ -n "$TOKEN" ]; then
  auth_args=(-H "X-CC-G2-Token: $TOKEN")
fi

cmd="${1:-help}"
case "$cmd" in
  approval)
    curl -sS -X POST "$HUB/api/approvals" ${auth_args[@]+"${auth_args[@]}"} -H 'Content-Type: application/json' \
      -d '{"toolName":"Bash","toolInput":{"command":"pnpm test"},"cwd":"/tmp/demo","agentName":"claude-code"}'
    echo
    ;;
  stop)
    curl -sS -X POST "$HUB/api/notify/moshi" ${auth_args[@]+"${auth_args[@]}"} -H 'Content-Type: application/json' \
      -d '{"title":"Session finished","body":"作業が完了しました","hookType":"stop","metadata":{"sessionId":"smoke-1","tmuxTarget":"demo:0.0"}}'
    echo
    ;;
  image)
    file="${2:?usage: smoke-hub.sh image <path.png>}"
    curl -sS -X POST "$HUB/api/images?title=SmokeTest" ${auth_args[@]+"${auth_args[@]}"} \
      -H 'Content-Type: image/png' --data-binary "@$file"
    echo
    ;;
  pending)
    curl -sS "$HUB/api/approvals" ${auth_args[@]+"${auth_args[@]}"}
    echo
    ;;
  get)
    id="${2:?usage: smoke-hub.sh get <approvalId>}"
    curl -sS "$HUB/api/approvals/$id" ${auth_args[@]+"${auth_args[@]}"}
    echo
    ;;
  hook)
    # PermissionRequest hook クライアントの模擬。decide されると CC に返る応答
    # (approve: behavior=allow / コメント付き deny: message に "G2: <コメント>")が表示される。
    echo "hook long-polling... (Telegram 側で decide してください)" >&2
    curl -sS -X POST "$HUB/api/hooks/permission-request" ${auth_args[@]+"${auth_args[@]}"} \
      -H 'Content-Type: application/json' \
      -d '{"tool_name":"Bash","tool_input":{"command":"rm -rf tmp"},"cwd":"/tmp/demo","session_id":"smoke-e2e"}'
    echo
    ;;
  *)
    cat <<'EOF'
usage: [HUB=http://127.0.0.1:8788] [TOKEN=...] scripts/smoke-hub.sh <cmd>
  approval        承認リクエストを作成(Telegram に inline keyboard が届く)
  stop            Stop 通知を送る(返信中継の確認用)
  image <png>     画像通知を送る
  pending         pending 承認一覧
  get <id>        承認の状態確認(status/decidedBy/comment)
  hook            PermissionRequest hook を模擬(decide まで待って hook 応答を表示)
EOF
    ;;
esac
