#!/usr/bin/env bash
# scripts/lib/doctor.sh — cc-g2 依存チェック・診断（doctor / status）
# source して使う。直接実行しない。
#
# 呼び出し側の前提:
#   - set -euo pipefail 済み
#   - lib/infra.sh（is_*_running）, lib/tokens.sh（*_token_matches）を source 済み
#   - AGENT_MODE, CLAUDE_BIN, CODEX_BIN, COPILOT_BIN, G2_PROJECT_DIR, HUB_PORT, VITE_PORT,
#     VOICE_ENTRY_PORT, VOICE_ENTRY_ENABLED, BOLD, NC が定義済み
#   - info / warn / error はエントリ側（cc-g2.sh）で定義済み

check_deps() {
  local missing=()
  for cmd in tmux curl lsof jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if [ "$AGENT_MODE" = "codex" ]; then
    if ! command -v "$CODEX_BIN" >/dev/null 2>&1 && ! command -v codex >/dev/null 2>&1; then
      missing+=("codex")
    fi
  elif [ "$AGENT_MODE" = "copilot" ]; then
    if ! command -v "${COPILOT_BIN:-copilot}" >/dev/null 2>&1 && ! command -v copilot >/dev/null 2>&1; then
      missing+=("copilot")
    fi
  elif ! command -v "$CLAUDE_BIN" >/dev/null 2>&1 && ! command -v claude >/dev/null 2>&1; then
    missing+=("claude")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    error "必須コマンドが見つかりません: ${missing[*]}"
    error "インストールしてから再実行してください"
    exit 1
  fi
  if ! command -v tailscale >/dev/null 2>&1; then
    warn "tailscale が見つかりません（QRコード表示に必要。SHOW_QR=0 で省略可）"
  fi
}

cmd_status() { cmd_doctor; }

cmd_doctor() {
  echo -e "${BOLD}=== cc-g2 doctor ===${NC}"
  local ok=true

  # 依存コマンド
  for cmd in tmux curl lsof jq node; do
    if command -v "$cmd" >/dev/null 2>&1; then
      info "$cmd: $(command -v "$cmd")"
    else
      warn "$cmd: not found"; ok=false
    fi
  done
  if command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    info "claude: $CLAUDE_BIN"
  elif command -v claude >/dev/null 2>&1; then
    info "claude: $(command -v claude)"
  else
    warn "claude: not found"; ok=false
  fi
  if command -v "$CODEX_BIN" >/dev/null 2>&1; then
    info "codex: $CODEX_BIN"
  elif command -v codex >/dev/null 2>&1; then
    info "codex: $(command -v codex)"
  else
    warn "codex: not found"
  fi

  # Tailscale
  if command -v tailscale >/dev/null 2>&1; then
    local ts_ip
    ts_ip=$(tailscale ip -4 2>/dev/null || true)
    if [ -n "$ts_ip" ]; then
      info "Tailscale: $ts_ip"
    else
      warn "Tailscale: installed but not connected (実機QRには必要 / simulator-only なら継続可)"
    fi
  else
    warn "Tailscale: not found (QR コード表示に必要)"
  fi

  # Hub
  if is_hub_running; then
    info "Hub (port $HUB_PORT): running"
    if hub_auth_token_matches; then
      info "Hub auth token: enabled"
    else
      warn "Hub auth token: mismatch (run cc-g2 !)"
      ok=false
    fi
    warn "Hub is intended for Tailscale/local trusted networks only"
  else
    warn "Hub (port $HUB_PORT): stopped"
  fi

  # Vite
  if is_vite_running; then
    info "Vite (port $VITE_PORT): running"
  else
    warn "Vite (port $VITE_PORT): stopped"
  fi

  if [ "$VOICE_ENTRY_ENABLED" = "1" ]; then
    if is_voice_entry_running; then
      info "Voice entry (port $VOICE_ENTRY_PORT): running"
      if voice_entry_token_matches; then
        info "Voice entry token: enabled"
      else
        warn "Voice entry token: mismatch (run cc-g2 !)"
        ok=false
      fi
    else
      warn "Voice entry (port $VOICE_ENTRY_PORT): stopped"
    fi
  else
    info "Voice entry: disabled"
  fi

  # Telegram adapter
  if [ "$TG_ADAPTER_ENABLED" = "1" ]; then
    if is_tg_adapter_running; then
      info "Telegram adapter (session: $TG_ADAPTER_SESSION): running"
    else
      warn "Telegram adapter (session: $TG_ADAPTER_SESSION): stopped"
    fi
  else
    info "Telegram adapter: disabled (TELEGRAM_BOT_TOKEN 未設定)"
  fi

  # G2 プロジェクト
  if [ -d "$G2_PROJECT_DIR" ] && [ -f "$G2_PROJECT_DIR/package.json" ]; then
    info "Project: $G2_PROJECT_DIR"
  else
    warn "Project: $G2_PROJECT_DIR (not found)"; ok=false
  fi
  if [ -d "$G2_PROJECT_DIR/node_modules" ]; then
    info "node_modules: installed"
  else
    warn "node_modules: not found (run: cd $G2_PROJECT_DIR && pnpm install)"; ok=false
  fi

  echo
  if $ok; then
    info "All checks passed"
  else
    warn "Some checks failed — see warnings above"
  fi
}
