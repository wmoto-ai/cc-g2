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
# 稼働中 Hub の承認モード（/api/health の approvalMode）。取得できなければ空を返す。
hub_approval_mode() {
  curl -s --max-time 1 "http://127.0.0.1:$HUB_PORT/api/health" 2>/dev/null \
    | jq -r '.approvalMode // empty' 2>/dev/null || true
}
# 要求承認モード。他の CC_G2_* 設定と同様に env → .env.local → .env の順で解決する。
requested_approval_mode() {
  resolve_env_var "CC_G2_APPROVAL_MODE" "CC_G2_APPROVAL_MODE" "$G2_PROJECT_DIR" "nonblocking"
}
is_vite_running() { lsof -i ":$VITE_PORT" -P 2>/dev/null | grep -q LISTEN; }
is_voice_entry_running() {
  curl -s --max-time 1 "http://127.0.0.1:$VOICE_ENTRY_PORT/health" >/dev/null 2>&1
}
is_tg_adapter_running() {
  tmux has-session -t "$TG_ADAPTER_SESSION" 2>/dev/null
}

# resolve_qr_url — QR に載せる接続先 URL を返す（Tailscale IP 優先、なければ LAN IP）
resolve_qr_url() {
  local ip
  ip=$(tailscale ip -4 2>/dev/null | head -1 || true)
  if [ -z "$ip" ]; then
    ip=$(ipconfig getifaddr en0 2>/dev/null || true)
    [ -n "$ip" ] && warn "Tailscale 未接続: LAN IP (${ip}) を使用（同一 WiFi 内のみ接続可）" >&2
  fi
  [ -n "$ip" ] || return 1
  printf 'http://%s:%s' "$ip" "$VITE_PORT"
}

# render_qr_url <url> — QR コードを現在の端末に描画する
render_qr_url() {
  local url="$1"
  local qr_log="${G2_PROJECT_DIR}/tmp/notification-hub/qr.log"
  mkdir -p "$(dirname "$qr_log")" 2>/dev/null || true
  echo
  info "iPhone Even App → ${BOLD}${url}${NC}"
  echo
  # npx は初回ダウンロードやネットワーク不調でハングしうるためタイムアウトで打ち切る
  if run_with_timeout "${CC_G2_QR_TIMEOUT_SEC:-20}" npx --yes @evenrealities/evenhub-cli qr -u "$url" 2>>"$qr_log"; then
    :
  elif command -v qrencode &>/dev/null; then
    qrencode -t ansiutf8 "$url"
  else
    warn "QRコード表示ツールが見つかりません (evenhub-cli / qrencode)。詳細: $qr_log"
    info "iPhone で直接アクセス: $url"
  fi
  echo
}

show_qr() {
  [ "$SHOW_QR" = "0" ] && return
  local url
  if ! url="$(resolve_qr_url)"; then
    warn "Tailscale / LAN の IP が取得できないため QRコードをスキップ"
    return
  fi
  render_qr_url "$url"
}

# ensure_qr_pane_for_session <session> [base_pane]
#   agent ペインの真上に QR 常駐ペインを作る（生きていれば何もしない）。
#   tmux の外（attach 直前）からも呼べる。ペインは手動で閉じるまで残る。
ensure_qr_pane_for_session() {
  [ "$SHOW_QR" = "0" ] && return 0
  local session="$1"
  local base_pane="${2:-}"
  local existing
  existing="$(tmux show-options -v -t "$session" @cc_g2_qr_pane 2>/dev/null || true)"
  if pane_alive "$existing"; then
    return 0
  fi
  local agent_pane
  agent_pane="$(tmux show-options -v -t "$session" @cc_g2_agent_pane 2>/dev/null || true)"
  if [ -n "$agent_pane" ] && ! pane_alive "$agent_pane"; then
    agent_pane=""
  fi
  [ -n "$agent_pane" ] || agent_pane="${base_pane:-${session}:0.0}"
  # agent ペイン未記録の旧セッション対策: split で :0.0 が QR ペインにずれる前に
  # 現時点の %id を解決して記録し、以後の返信ルーティングを agent ペインに固定する
  if [[ "$agent_pane" != %* ]]; then
    local agent_pane_id
    agent_pane_id="$(tmux display-message -p -t "$agent_pane" '#{pane_id}' 2>/dev/null || true)"
    if [ -n "$agent_pane_id" ]; then
      agent_pane="$agent_pane_id"
      tmux set-option -t "$session" @cc_g2_agent_pane "$agent_pane" 2>/dev/null || true
    fi
  fi
  local url
  if ! url="$(resolve_qr_url)"; then
    warn "Tailscale / LAN の IP が取得できないため QRコードをスキップ"
    return 0
  fi
  # 低いウィンドウで agent ペインが潰れないよう QR ペイン高をクランプする。
  # QR が読める高さ（約14行）を確保できない場合はペインを作らずインライン表示
  local qr_lines="${CC_G2_QR_PANE_LINES:-20}"
  local win_h
  win_h="$(tmux display-message -p -t "$agent_pane" '#{window_height}' 2>/dev/null || true)"
  if [ -n "$win_h" ] && [ "$win_h" -ge 10 ] 2>/dev/null; then
    local max_lines=$((win_h - 9))
    if [ "$qr_lines" -gt "$max_lines" ] 2>/dev/null; then
      qr_lines="$max_lines"
    fi
  fi
  if [ "$qr_lines" -lt 14 ] 2>/dev/null; then
    warn "ウィンドウが低いため QR ペインをスキップ（広い画面で cc-g2 qr を実行してください）"
    render_qr_url "$url"
    return 0
  fi
  local qr_pane
  # $0 は相対パス起動だと split 先ペインの cwd で解決できないため絶対パスで自己参照する
  local launcher="${SCRIPT_DIR}/cc-g2.sh"
  qr_pane="$(tmux split-window -v -b -l "$qr_lines" -d -P -F '#{pane_id}' -t "$agent_pane" \
    "$(printf '%q' "$launcher") __render-qr-pane $(printf '%q' "$url")" 2>/dev/null || true)"
  if [ -n "$qr_pane" ]; then
    tmux set-option -t "$session" @cc_g2_qr_pane "$qr_pane" 2>/dev/null || true
  else
    warn "QRペインを作成できませんでした（画面が狭い可能性）。cc-g2 qr で再試行できます"
    render_qr_url "$url"
  fi
}

# ensure_qr_pane — 現在のペインの真上に QR 常駐ペインを作る（cc-g2.sh の tmux 内側用）
ensure_qr_pane() {
  [ "$SHOW_QR" = "0" ] && return 0
  local session=""
  if [ -n "${TMUX_PANE:-}" ]; then
    session="$(tmux display-message -p '#S' 2>/dev/null || true)"
  fi
  if [ -z "$session" ]; then
    show_qr
    return 0
  fi
  ensure_qr_pane_for_session "$session" "$TMUX_PANE"
}

# cmd_qr — QR を再表示する（cc-g2 qr）。tmux 内ならペインを作り直し、外なら直接描画
cmd_qr() {
  # 明示コマンドなので SHOW_QR=0 でも表示する（ensure_qr_pane_for_session のガードを上書き）
  SHOW_QR=1
  local url
  if ! url="$(resolve_qr_url)"; then
    error "Tailscale / LAN の IP が取得できません"
    exit 1
  fi
  if [ -n "${TMUX:-}" ]; then
    local session
    session="$(tmux display-message -p '#S' 2>/dev/null || true)"
    if [ -n "$session" ]; then
      local existing
      existing="$(tmux show-options -v -t "$session" @cc_g2_qr_pane 2>/dev/null || true)"
      if [ -n "$existing" ]; then
        tmux kill-pane -t "$existing" 2>/dev/null || true
        tmux set-option -u -t "$session" @cc_g2_qr_pane 2>/dev/null || true
      fi
      ensure_qr_pane_for_session "$session" "${TMUX_PANE:-}"
      return 0
    fi
  fi
  render_qr_url "$url"
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
      HUB_APPROVAL_MODE="$(requested_approval_mode)" \
      GROQ_API_KEY="$GROQ_API_KEY_RESOLVED" \
      OPENAI_API_KEY="$OPENAI_API_KEY_RESOLVED" \
      SONIOX_API_KEY="$SONIOX_API_KEY_RESOLVED" \
      HUB_ALLOWED_ORIGINS="$allowed_origins" \
      HUB_REPLY_RELAY_SOURCES="${HUB_REPLY_RELAY_SOURCES:-g2,web,telegram}" \
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
    # ensure_infra は稼働中 Hub の env 変更を反映しない（token mismatch と同様）。
    # 要求モードと稼働 Hub の承認モードが違う場合は自動再起動せず warn のみ出す。
    local requested_mode running_mode
    requested_mode="$(requested_approval_mode)"
    running_mode="$(hub_approval_mode)"
    if [ -n "$running_mode" ] && [ "$running_mode" != "$requested_mode" ]; then
      warn "承認モード不一致: 稼働中 Hub=${running_mode} / 要求=${requested_mode}。反映には Hub 再起動が必要です（cc-g2 !）"
    fi
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

  # Telegram adapter (opt-in: TELEGRAM_BOT_TOKEN が設定されていれば自動起動)
  if [ "$TG_ADAPTER_ENABLED" = "1" ]; then
    local need_tg=false

    if ! is_tg_adapter_running; then
      need_tg=true
    elif $need_hub; then
      warn "Hub auth token changed; restarting Telegram adapter"
      kill_tg_adapter
      need_tg=true
    fi

    if $need_tg; then
      info "Telegram adapter 起動 (session: $TG_ADAPTER_SESSION)..."
      if start_tg_adapter; then
        sleep 1.5
        if is_tg_adapter_running; then
          info "Telegram adapter: OK"
        else
          warn "Telegram adapter: 起動直後にプロセスが終了しました"
          warn "  ログ: $TG_ADAPTER_LOG_FILE"
        fi
      fi
    else
      info "Telegram adapter: 既に起動済み (session: $TG_ADAPTER_SESSION)"
    fi
  fi

}

kill_port() {
  local port="$1" name="$2"
  local pids
  pids=$(lsof -t -i ":$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids" ]; then
    return
  fi
  # 全 PID を kill（親プロセス + 子 node プロセス）
  echo "$pids" | xargs kill 2>/dev/null || true
  # 残留確認 → SIGKILL
  sleep 0.3
  local remaining
  remaining=$(lsof -t -i ":$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    echo "$remaining" | xargs kill -9 2>/dev/null || true
  fi
  info "${name} stopped (pid: $(echo $pids | tr '\n' ' '))"
}

kill_tg_adapter() {
  if tmux has-session -t "$TG_ADAPTER_SESSION" 2>/dev/null; then
    tmux kill-session -t "$TG_ADAPTER_SESSION" 2>/dev/null || true
    info "Telegram adapter stopped (session: $TG_ADAPTER_SESSION)"
  fi
}

start_tg_adapter() {
  local pkg_dir="${G2_PROJECT_DIR}/packages/telegram-adapter"
  local hub_token_file="$HUB_AUTH_TOKEN_FILE"

  if [ ! -f "$pkg_dir/src/main.ts" ]; then
    warn "Telegram adapter: 配布ファイルが見つかりません: $pkg_dir/src/main.ts"
    return 1
  fi
  if [ ! -e "${G2_PROJECT_DIR}/node_modules/tsx" ] || \
     [ ! -e "${G2_PROJECT_DIR}/node_modules/grammy" ] || \
     [ ! -e "${G2_PROJECT_DIR}/node_modules/@grammyjs/auto-retry" ]; then
    warn "Telegram adapter: 実行依存が見つかりません (${G2_PROJECT_DIR} で pnpm install)"
    return 1
  fi
  if [ ! -f "$hub_token_file" ]; then
    warn "Telegram adapter: hub-auth-token ファイルが見つかりません: $hub_token_file"
    return 1
  fi

  mkdir -p "$TG_ADAPTER_DATA_DIR" "$TG_ADAPTER_INBOX_DIR" "$(dirname "$TG_ADAPTER_LOG_FILE")"
  chmod 700 "$TG_ADAPTER_INBOX_DIR" 2>/dev/null || true

  local env_prefix=""
  env_prefix+="HUB_BASE_URL='http://127.0.0.1:${HUB_PORT}' "
  env_prefix+="HUB_AUTH_TOKEN=\"\$(cat '${hub_token_file}')\" "
  env_prefix+="DATA_DIR='${TG_ADAPTER_DATA_DIR}' "
  env_prefix+="INBOX_DIR='${TG_ADAPTER_INBOX_DIR}' "
  env_prefix+="LOG_LEVEL=info "
  if [ -n "${TG_ADAPTER_ALLOWED_USER_IDS:-}" ] && [[ "${TG_ADAPTER_ALLOWED_USER_IDS}" != op://* ]]; then
    env_prefix+="TELEGRAM_ALLOWED_USER_IDS='${TG_ADAPTER_ALLOWED_USER_IDS}' "
  fi

  if [ -n "${TG_ADAPTER_CHAT_ID:-}" ] && [[ "${TG_ADAPTER_CHAT_ID}" != op://* ]]; then
    env_prefix+="TELEGRAM_CHAT_ID='${TG_ADAPTER_CHAT_ID}' "
  fi

  local bot_env_file="${TG_ADAPTER_BOT_ENV_FILE:-}"
  if [ -z "$bot_env_file" ]; then
    bot_env_file="${G2_PROJECT_DIR}/packages/telegram-adapter/.env"
    if [ ! -f "$bot_env_file" ]; then
      bot_env_file=""
    fi
  fi

  local node_cmd
  if [ -n "$bot_env_file" ] && [ -f "$bot_env_file" ]; then
    if grep -q 'op://' "$bot_env_file"; then
      local op_sa_bin
      op_sa_bin="$(command -v op-sa 2>/dev/null || true)"
      if [ -z "$op_sa_bin" ]; then
        warn "Telegram adapter: op:// 参照を解決する op-sa が見つかりません"
        return 1
      fi
      node_cmd="'${op_sa_bin}' run --env-file='${bot_env_file}' -- env ${env_prefix}node --import tsx src/main.ts"
    else
      node_cmd="${env_prefix}node --env-file='${bot_env_file}' --import tsx src/main.ts"
    fi
  else
    warn "Telegram adapter: bot token 用の env ファイルが見つかりません"
    warn "  CC_TG_BOT_ENV_FILE を設定するか、packages/telegram-adapter/.env を作成してください"
    return 1
  fi

  tmux new-session -d -s "$TG_ADAPTER_SESSION" -c "$pkg_dir" \
    "${node_cmd} 2>&1 | tee -a '${TG_ADAPTER_LOG_FILE}'"
}

cmd_stop() {
  info "G2 インフラを停止中..."
  kill_tg_adapter
  kill_port "$HUB_PORT" "Hub"
  kill_port "$VITE_PORT" "Vite"
  kill_port "$VOICE_ENTRY_PORT" "VoiceEntry"
  rm -f "$HUB_AUTH_TOKEN_FILE" 2>/dev/null || true
  info "Done."
}
