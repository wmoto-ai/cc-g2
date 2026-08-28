#!/usr/bin/env bash
# scripts/lib/tmux-session.sh — cc-g2 tmux セッション管理・内部コマンド
# source して使う。直接実行しない。
#
# 呼び出し側の前提:
#   - set -euo pipefail 済み
#   - lib/infra.sh（ensure_infra）を source 済み
#   - ENABLE_STATUSLINE, ORIG_STATUSLINE_CMD が定義済み
#   - info / warn / error はエントリ側（cc-g2.sh）で定義済み
#   - launch_tmux_session_detached は "$0"（エントリスクリプトのパス）を
#     ネスト起動コマンドとして使う

make_tmux_session_name() {
  local work_dir="$1"
  local agent_mode="${2:-claude}"
  local base slug hash
  base="$(basename "$work_dir")"
  slug="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')"
  hash="$(printf '%s' "$work_dir" | shasum | awk '{print substr($1,1,4)}')"
  if [ "$agent_mode" = "codex" ]; then
    printf 'g2-%s-%s-codex' "$slug" "$hash"
  elif [ "$agent_mode" = "copilot" ]; then
    printf 'g2-%s-%s-copilot' "$slug" "$hash"
  else
    printf 'g2-%s-%s' "$slug" "$hash"
  fi
}

make_unique_tmux_session_name() {
  local work_dir="$1"
  local agent_mode="${2:-claude}"
  local base candidate suffix
  base="$(make_tmux_session_name "$work_dir" "$agent_mode")"
  candidate="$base"
  suffix=2
  while tmux has-session -t "$candidate" 2>/dev/null; do
    candidate="${base}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s' "$candidate"
}

json_out() {
  jq -nc "$@"
}

# build_g2_tmux_env <session_name> [agent_mode]
#   tmux new-session に渡す -e 環境変数列を配列 G2_TMUX_ENV にセットする。
#   cc-g2.sh（対話起動）と launch_tmux_session_detached（voice-entry 起動）で共用。
#   注意: 既存の tmux サーバーがあると新セッションの環境はサーバー起動時の env を
#   引き継ぐため、外側の呼び出しで指定された設定値はここで明示的に渡す必要がある。
#   agent_mode は copilot 用 BYOK env の伝搬 gate に使う（グローバル AGENT_MODE は
#   launch-detached 経路で copilot を表さないため、呼び出し側から明示的に渡す）。
build_g2_tmux_env() {
  local session_name="$1"
  local agent_mode="${2:-${AGENT_MODE:-claude}}"
  G2_TMUX_ENV=(
    -e _CC_G2_INSIDE=1
    -e MOSHI_NOTIFY=1
    -e CC_G2_TMUX_TARGET="${session_name}:0.0"
    -e CC_G2_ENABLE_STATUSLINE="${ENABLE_STATUSLINE}"
    -e CC_G2_ORIG_STATUSLINE_CMD="${ORIG_STATUSLINE_CMD}"
    -e HUB_PORT="${HUB_PORT}"
    -e VITE_PORT="${VITE_PORT}"
    -e SHOW_QR="${SHOW_QR}"
    -e CLAUDE_BIN="${CLAUDE_BIN}"
    -e CODEX_BIN="${CODEX_BIN}"
    -e COPILOT_BIN="${COPILOT_BIN:-}"
    -e G2_PROJECT_DIR="${G2_PROJECT_DIR}"
    -e CC_G2_VOICE_ENTRY_ENABLED="${VOICE_ENTRY_ENABLED}"
    -e CC_G2_VOICE_ENTRY_PORT="${VOICE_ENTRY_PORT}"
    -e CC_G2_VOICE_ENTRY_BIND="${VOICE_ENTRY_BIND}"
    -e CC_G2_REPO_ROOTS="${VOICE_ENTRY_REPO_ROOTS}"
    -e CC_G2_REPO_SCAN_DEPTH="${VOICE_ENTRY_SCAN_DEPTH}"
    -e CC_G2_QR_PANE_LINES="${CC_G2_QR_PANE_LINES:-}"
    -e CC_G2_QR_TIMEOUT_SEC="${CC_G2_QR_TIMEOUT_SEC:-}"
  )
  # Copilot CLI の BYOK 用 env（ローカルモデル copilot-qwen 等）を tmux 境界で
  # 失わないよう伝搬する。COPILOT_MODEL / COPILOT_HOME に加え、動的な
  # COPILOT_PROVIDER_* 群を列挙して追加する。
  # これらは BYOK の API キーを含み得るため、copilot モードのセッションにのみ渡し、
  # claude/codex セッションには注入しない（COPILOT_BIN は鍵ではないので常時渡す）。
  if [ "$agent_mode" = "copilot" ]; then
    [ -n "${COPILOT_MODEL:-}" ] && G2_TMUX_ENV+=(-e COPILOT_MODEL="${COPILOT_MODEL}")
    [ -n "${COPILOT_HOME:-}" ] && G2_TMUX_ENV+=(-e COPILOT_HOME="${COPILOT_HOME}")
    local __copilot_var
    while IFS= read -r __copilot_var; do
      [ -n "$__copilot_var" ] || continue
      G2_TMUX_ENV+=(-e "${__copilot_var}=${!__copilot_var}")
    done < <(compgen -v 2>/dev/null | grep '^COPILOT_PROVIDER_' || true)
  fi
}

# build_nested_cmd [args...]
#   tmux セッション内で自分自身（$0 = cc-g2.sh）を再実行し、終了後はシェルに戻る
#   コマンド文字列を出力する。
build_nested_cmd() {
  local cmd="\"$0\""
  if [ $# -gt 0 ]; then
    cmd+="$(printf ' %q' "$@")"
  fi
  cmd+="; exec \$SHELL"
  printf '%s' "$cmd"
}

has_tmux_session() {
  local session_name="$1"
  tmux has-session -t "$session_name" 2>/dev/null
}

launch_tmux_session_detached() {
  local work_dir="$1"
  local prompt="$2"
  local agent_mode="$3"
  local session_name="$(make_unique_tmux_session_name "$work_dir" "$agent_mode")"
  build_g2_tmux_env "$session_name" "$agent_mode"
  local nested_args=()
  [ "$agent_mode" = "codex" ] && nested_args+=("--codex")
  [ "$agent_mode" = "copilot" ] && nested_args+=("--copilot")
  [ -n "$prompt" ] && nested_args+=("$prompt")
  local nested_cmd
  if [ ${#nested_args[@]} -gt 0 ]; then
    nested_cmd="$(build_nested_cmd "${nested_args[@]}")"
  else
    nested_cmd="$(build_nested_cmd)"
  fi
  ensure_infra
  tmux new-session -d -s "$session_name" -c "$work_dir" \
    "${G2_TMUX_ENV[@]}" \
    "$nested_cmd"
  json_out --arg sessionName "$session_name" --arg tmuxTarget "${session_name}:0.0" --arg workdir "$work_dir" '{ok:true,sessionName:$sessionName,tmuxTarget:$tmuxTarget,workdir:$workdir}'
}

send_to_tmux_session() {
  local session_name="$1"
  local text="$2"
  # cc-g2.sh が記録した agent ペインの固有 ID を優先（QR ペイン等でインデックスが
  # ずれても誤配信しない）。記録が無い・ペインが消えた場合は従来の :0.0 に戻す。
  local pane_target
  pane_target="$(tmux show-options -v -t "$session_name" @cc_g2_agent_pane 2>/dev/null || true)"
  if [ -n "$pane_target" ] && ! pane_alive "$pane_target"; then
    pane_target=""
  fi
  [ -n "$pane_target" ] || pane_target="${session_name}:0.0"
  text="${text//$'\r'/ }"
  text="${text//$'\n'/ }"
  tmux send-keys -t "$pane_target" -l "$text"
  tmux send-keys -t "$pane_target" Enter
  json_out --arg sessionName "$session_name" --arg tmuxTarget "$pane_target" '{ok:true,sessionName:$sessionName,tmuxTarget:$tmuxTarget}'
}

run_internal_command() {
  local command="$1"
  shift || true
  case "$command" in
    launch-detached)
      local work_dir=""
      local prompt=""
      local agent_mode="claude"
      while [ $# -gt 0 ]; do
        case "$1" in
          --workdir) work_dir="$2"; shift 2 ;;
          --prompt) prompt="$2"; shift 2 ;;
          --agent) agent_mode="$2"; shift 2 ;;
          codex|--codex|--native-codex|-codex) agent_mode="codex"; shift ;;
          copilot|--copilot|-copilot) agent_mode="copilot"; shift ;;
          *) error "Unknown launch-detached arg: $1"; exit 1 ;;
        esac
      done
      [ -n "$work_dir" ] || { error "launch-detached requires --workdir"; exit 1; }
      launch_tmux_session_detached "$work_dir" "$prompt" "$agent_mode"
      exit 0
      ;;
    send)
      local session_name=""
      local text=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --session) session_name="$2"; shift 2 ;;
          --text) text="$2"; shift 2 ;;
          *) error "Unknown send arg: $1"; exit 1 ;;
        esac
      done
      [ -n "$session_name" ] || { error "send requires --session"; exit 1; }
      send_to_tmux_session "$session_name" "$text"
      exit 0
      ;;
    has-session)
      local session_name=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --session) session_name="$2"; shift 2 ;;
          *) error "Unknown has-session arg: $1"; exit 1 ;;
        esac
      done
      [ -n "$session_name" ] || { error "has-session requires --session"; exit 1; }
      if has_tmux_session "$session_name"; then
        json_out --arg sessionName "$session_name" '{ok:true,exists:true,sessionName:$sessionName}'
      else
        json_out --arg sessionName "$session_name" '{ok:true,exists:false,sessionName:$sessionName}'
      fi
      exit 0
      ;;
    find-session)
      local work_dir=""
      local agent_mode="claude"
      while [ $# -gt 0 ]; do
        case "$1" in
          --workdir) work_dir="$2"; shift 2 ;;
          --agent) agent_mode="$2"; shift 2 ;;
          codex|--codex|--native-codex|-codex) agent_mode="codex"; shift ;;
          copilot|--copilot|-copilot) agent_mode="copilot"; shift ;;
          *) error "Unknown find-session arg: $1"; exit 1 ;;
        esac
      done
      [ -n "$work_dir" ] || { error "find-session requires --workdir"; exit 1; }
      local base_name
      base_name="$(make_tmux_session_name "$work_dir" "$agent_mode")"
      # Pick the latest session matching base_name (highest suffix wins)
      local found=""
      found=$(tmux list-sessions -F '#{session_name}' 2>/dev/null \
        | grep "^${base_name}\(-[0-9]*\)\{0,1\}$" | sort -V | tail -1)
      if [ -n "$found" ]; then
        json_out --arg sessionName "$found" '{ok:true,exists:true,sessionName:$sessionName}'
      else
        json_out '{ok:true,exists:false}'
      fi
      exit 0
      ;;
  esac
}
