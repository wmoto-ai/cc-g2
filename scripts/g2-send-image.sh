#!/bin/bash
# g2-send-image.sh: 画像を Notification Hub に送って G2 グラスで表示できるようにする
#
# Claude Code / Codex CLI から呼ばれる共通スクリプト。
# cc-g2.sh が両 CLI に「画像を見せたいときはこれを実行せよ」という指示を注入する。
#
# 使い方:
#   g2-send-image.sh <file> [--title "タイトル"]
#   g2-send-image.sh --capture [--title "タイトル"]            # 全画面スクショして送信
#   g2-send-image.sh --capture-window [--title "タイトル"]     # 最前面ウィンドウをスクショして送信
#
# 環境変数: HUB_PORT (default: 8787), HUB_AUTH_TOKEN (optional)
#
# 出力: 成功時 "OK imageId=<uuid> notificationId=<uuid>" を stdout に出す。
#       失敗時は stderr にエラーを出して非ゼロ exit。

set -euo pipefail

HUB_PORT="${HUB_PORT:-8787}"
HUB_AUTH_TOKEN="${HUB_AUTH_TOKEN:-}"
HUB_URL="http://127.0.0.1:${HUB_PORT}"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

FILE=""
TITLE=""
MODE="file"

while [ $# -gt 0 ]; do
  case "$1" in
    --capture) MODE="capture"; shift ;;
    --capture-window) MODE="capture-window"; shift ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) fail "unknown option: $1" ;;
    *) FILE="$1"; shift ;;
  esac
done

command -v curl >/dev/null 2>&1 || fail "curl not found"

if ! curl -s --max-time 2 "${HUB_URL}/api/health" >/dev/null 2>&1; then
  fail "Notification Hub (${HUB_URL}) is not running. Start it with: cc-g2"
fi

CLEANUP_FILE=""
cleanup() {
  if [ -n "$CLEANUP_FILE" ]; then
    rm -f "$CLEANUP_FILE"
  fi
}
trap cleanup EXIT

if [ "$MODE" = "capture" ] || [ "$MODE" = "capture-window" ]; then
  command -v screencapture >/dev/null 2>&1 || fail "screencapture not found (macOS only)"
  FILE="$(mktemp /tmp/g2-send-image-XXXXXX).png"
  CLEANUP_FILE="$FILE"
  if [ "$MODE" = "capture-window" ]; then
    # 最前面ウィンドウ(影なし)。ウィンドウ選択 UI を出さずに最前面をキャプチャする
    screencapture -x -o -m "$FILE" 2>/dev/null || screencapture -x "$FILE" \
      || fail "screencapture failed (Screen Recording permission?)"
  else
    screencapture -x "$FILE" || fail "screencapture failed (Screen Recording permission?)"
  fi
  [ -z "$TITLE" ] && TITLE="Screenshot $(date +%H:%M)"
fi

[ -n "$FILE" ] || { usage >&2; fail "no input file"; }
[ -f "$FILE" ] || fail "file not found: $FILE"

# G2 表示は最大 576x288 のため、転送前に長辺 1200px へ縮小して帯域を節約する
# (最終リサイズは iPhone WebView 側の canvas で行う)
UPLOAD_FILE="$FILE"
if command -v sips >/dev/null 2>&1; then
  WIDTH=$(sips -g pixelWidth "$FILE" 2>/dev/null | awk '/pixelWidth/ {print $2}' || echo 0)
  HEIGHT=$(sips -g pixelHeight "$FILE" 2>/dev/null | awk '/pixelHeight/ {print $2}' || echo 0)
  if [ "${WIDTH:-0}" -gt 1200 ] || [ "${HEIGHT:-0}" -gt 1200 ]; then
    RESIZED="$(mktemp /tmp/g2-send-image-resized-XXXXXX).png"
    if sips -Z 1200 "$FILE" --out "$RESIZED" >/dev/null 2>&1; then
      UPLOAD_FILE="$RESIZED"
      [ -n "$CLEANUP_FILE" ] && rm -f "$CLEANUP_FILE"
      CLEANUP_FILE="$RESIZED"
    else
      rm -f "$RESIZED"
    fi
  fi
fi

[ -z "$TITLE" ] && TITLE="$(basename "$FILE")"

# URL エンコード (jq @uri)
TITLE_ENC=$(printf '%s' "$TITLE" | jq -sRr '@uri' 2>/dev/null || printf '%s' "Screenshot")

AUTH_ARGS=()
[ -n "$HUB_AUTH_TOKEN" ] && AUTH_ARGS=(-H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}")

RESPONSE=$(curl -s --max-time 15 -X POST \
  "${HUB_URL}/api/images?title=${TITLE_ENC}" \
  -H 'Content-Type: application/octet-stream' \
  "${AUTH_ARGS[@]}" \
  --data-binary "@${UPLOAD_FILE}") || fail "upload failed (curl error)"

OK=$(printf '%s' "$RESPONSE" | jq -r '.ok // false' 2>/dev/null || echo false)
if [ "$OK" != "true" ]; then
  fail "hub rejected image: $(printf '%s' "$RESPONSE" | head -c 300)"
fi

IMAGE_ID=$(printf '%s' "$RESPONSE" | jq -r '.imageId')
NOTIFICATION_ID=$(printf '%s' "$RESPONSE" | jq -r '.notificationId')
echo "OK imageId=${IMAGE_ID} notificationId=${NOTIFICATION_ID}"
echo "G2 glasses: open the notification and select 'View image'." >&2
