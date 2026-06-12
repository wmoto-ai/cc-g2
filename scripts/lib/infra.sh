#!/usr/bin/env bash
# scripts/lib/infra.sh — cc-g2 インフラ（Hub・Vite・Voice Entry）の起動・停止・状態確認
# source して使う。直接実行しない。
#
# 警告: このファイルには「関数定義のみ」を置くこと。トップレベルの処理・変数定義・
# コマンド実行を追加してはならない（source 順や cc-g2.sh の初期化タイミングが壊れる）。
#
# 呼び出し側の前提:
#   - set -euo pipefail 済み
#   - lib/common.sh（wait_for）, lib/tokens.sh（*_token_matches）を source 済み
#   - G2_PROJECT_DIR, HUB_PORT, VITE_PORT, HUB_AUTH_TOKEN, HUB_AUTH_TOKEN_FILE,
#     GROQ_API_KEY_RESOLVED, OPENAI_API_KEY_RESOLVED, SONIOX_API_KEY_RESOLVED,
#     VOICE_ENTRY_* 一式, SHOW_QR, BOLD, NC が定義済み
#   - info / warn / error はエントリ側（cc-g2.sh）で定義済み

# ─── 起動状態チェック ────────────────────────────────────────

is_hub_running()  { curl -s --max-time 1 "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1; }
is_vite_running() { lsof -i ":$VITE_PORT" -P 2>/dev/null | grep -q LISTEN; }
is_voice_entry_running() {
  curl -s --max-time 1 "http://127.0.0.1:$VOICE_ENTRY_PORT/health" >/dev/null 2>&1
}

show_qr() {
  [ "$SHOW_QR" = "0" ] && return
  local ts_ip
  ts_ip=$(tailscale ip -4 2>/dev/null || true)
  if [ -z "$ts_ip" ]; then
    warn "Tailscale 未接続: QRコードをスキップ"
    return
  fi
  local url="http://${ts_ip}:${VITE_PORT}"
  echo
  info "iPhone Even App → ${BOLD}${url}${NC}"
  info "QRコードを表示中..."
  echo
  if npx --yes @evenrealities/evenhub-cli qr -u "$url" 2>/dev/null; then
    :
  elif command -v qrencode &>/dev/null; then
    qrencode -t ansiutf8 "$url"
  else
    warn "QRコード表示ツールが見つかりません (evenhub-cli / qrencode)"
    info "iPhone で直接アクセス: $url"
  fi
  echo
}

ensure_infra() {
  local need_hub=false need_vite=false need_voice=false

  if ! is_hub_running; then
    need_hub=true
  fi
  if ! is_vite_running; then
    need_vite=true
  fi
  if [ "$VOICE_ENTRY_ENABLED" = "1" ] && ! is_voice_entry_running; then
    need_voice=true
  fi

  if ! $need_hub && ! hub_auth_token_matches; then
    warn "Hub auth token mismatch detected; restarting Hub and Vite"
    kill_port "$HUB_PORT" "Hub"
    kill_port "$VITE_PORT" "Vite"
    need_hub=true
    need_vite=true
  fi

  if [ "$VOICE_ENTRY_ENABLED" = "1" ] && ! $need_voice && ! voice_entry_token_matches; then
    warn "Voice entry token mismatch detected; restarting voice entry"
    kill_port "$VOICE_ENTRY_PORT" "VoiceEntry"
    need_voice=true
  fi

  if $need_hub || $need_vite || $need_voice; then
    info "G2 インフラを起動中..."

    if ! [ -d "$G2_PROJECT_DIR" ]; then
      error "G2 project not found: $G2_PROJECT_DIR"
      error "Set G2_PROJECT_DIR to override."
      exit 1
    fi
  fi

  # Hub 起動
  if $need_hub; then
    info "Notification Hub 起動 (port $HUB_PORT)..."
    local hub_log="${G2_PROJECT_DIR}/tmp/notification-hub/hub.log"
    local allowed_origins="http://127.0.0.1:${VITE_PORT},http://localhost:${VITE_PORT}"
    local ts_ip
    ts_ip=$(tailscale ip -4 2>/dev/null || true)
    if [ -n "$ts_ip" ]; then
      allowed_origins="${allowed_origins},http://${ts_ip}:${VITE_PORT}"
    fi
    mkdir -p "$(dirname "$hub_log")"
    nohup env -C "$G2_PROJECT_DIR" \
      HUB_BIND=0.0.0.0 \
      HUB_PORT=$HUB_PORT \
      HUB_AUTH_TOKEN="$HUB_AUTH_TOKEN" \
      GROQ_API_KEY="$GROQ_API_KEY_RESOLVED" \
      OPENAI_API_KEY="$OPENAI_API_KEY_RESOLVED" \
      SONIOX_API_KEY="$SONIOX_API_KEY_RESOLVED" \
      HUB_ALLOWED_ORIGINS="$allowed_origins" \
      HUB_REPLY_RELAY_CMD='bash server/notification-hub/reply-relay.sh' \
      RELAY_ENABLE_TMUX=1 \
      RELAY_TMUX_AUTO_DETECT=1 \
      RELAY_TMUX_USE_NOTIFICATION_TARGET=1 \
      RELAY_TMUX_STRICT_APPROVAL_TARGET=1 \
      RELAY_MESSAGE_STYLE='simple' \
      RELAY_TMUX_SUBMIT_KEY='C-j' \
      RELAY_TMUX_SUBMIT_FALLBACK_KEY='Enter' \
      RELAY_LOG_FILE='tmp/notification-hub/reply-relay-events.jsonl' \
      RELAY_AGENT_LOG_FILE='tmp/notification-hub/reply-relay-agent.log' \
      node server/notification-hub/index.mjs \
      >> "$hub_log" 2>&1 &

    # Hub 起動待ち
    if wait_for is_hub_running 10 0.5; then
      info "Hub: OK"
    else
      warn "Hub: 起動に時間がかかっています（バックグラウンドで継続中）"
    fi
  else
    info "Hub: 既に起動済み (port $HUB_PORT)"
  fi

  # Vite 起動
  if $need_vite; then
    info "Vite dev server 起動 (port $VITE_PORT)..."
    local vite_log="${G2_PROJECT_DIR}/tmp/notification-hub/vite.log"
    nohup env -C "$G2_PROJECT_DIR" \
      VITE_HUB_TOKEN="$HUB_AUTH_TOKEN" \
      ./node_modules/.bin/vite --host 0.0.0.0 --port "$VITE_PORT" \
      >> "$vite_log" 2>&1 &

    if wait_for is_vite_running 10 0.5; then
      info "Vite: OK"
    else
      warn "Vite: 起動に時間がかかっています（バックグラウンドで継続中）"
    fi
  else
    info "Vite: 既に起動済み (port $VITE_PORT)"
  fi

  if [ "$VOICE_ENTRY_ENABLED" = "1" ]; then
    if $need_voice; then
      info "Voice entry 起動 (port $VOICE_ENTRY_PORT)..."
      local voice_log="$VOICE_ENTRY_LOG_FILE"
      mkdir -p "$(dirname "$voice_log")"
      nohup env -C "$G2_PROJECT_DIR" \
        CC_G2_VOICE_ENTRY_PORT="$VOICE_ENTRY_PORT" \
        CC_G2_VOICE_ENTRY_BIND="$VOICE_ENTRY_BIND" \
        CC_G2_VOICE_ENTRY_TOKEN="$VOICE_ENTRY_TOKEN" \
        CC_G2_VOICE_ENTRY_LOG_FILE="$VOICE_ENTRY_LOG_FILE" \
        CC_G2_VOICE_ENTRY_LAST_SESSION_FILE="$VOICE_ENTRY_LAST_SESSION_FILE" \
        CC_G2_REPO_ROOTS="$VOICE_ENTRY_REPO_ROOTS" \
        CC_G2_REPO_SCAN_DEPTH="$VOICE_ENTRY_SCAN_DEPTH" \
        node server/voice-entry/index.mjs \
        >> "$voice_log" 2>&1 &

      if wait_for is_voice_entry_running 10 0.5; then
        info "Voice entry: OK"
      else
        warn "Voice entry: 起動に時間がかかっています（バックグラウンドで継続中）"
      fi
    else
      info "Voice entry: 既に起動済み (port $VOICE_ENTRY_PORT)"
    fi
  fi

}

kill_port() {
  local port="$1" name="$2"
  local pids
  pids=$(lsof -t -i ":$port" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    return
  fi
  # 全 PID を kill（親プロセス + 子 node プロセス）
  echo "$pids" | xargs kill 2>/dev/null || true
  # 残留確認 → SIGKILL
  sleep 0.3
  local remaining
  remaining=$(lsof -t -i ":$port" 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    echo "$remaining" | xargs kill -9 2>/dev/null || true
  fi
  info "${name} stopped (pid: $(echo $pids | tr '\n' ' '))"
}

cmd_stop() {
  info "G2 インフラを停止中..."
  kill_port "$HUB_PORT" "Hub"
  kill_port "$VITE_PORT" "Vite"
  kill_port "$VOICE_ENTRY_PORT" "VoiceEntry"
  rm -f "$HUB_AUTH_TOKEN_FILE" 2>/dev/null || true
  info "Done."
}
