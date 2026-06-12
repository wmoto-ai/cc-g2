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

has_tmux_session() {
  local session_name="$1"
  tmux has-session -t "$session_name" 2>/dev/null
}

launch_tmux_session_detached() {
  local work_dir="$1"
  local prompt="$2"
  local agent_mode="$3"
  local session_name="$(make_unique_tmux_session_name "$work_dir" "$agent_mode")"
  local tmux_env=(
    -e _CC_G2_INSIDE=1
    -e MOSHI_NOTIFY=1
    -e CC_G2_TMUX_TARGET="${session_name}:0.0"
    -e CC_G2_ENABLE_STATUSLINE="${ENABLE_STATUSLINE}"
    -e CC_G2_ORIG_STATUSLINE_CMD="${ORIG_STATUSLINE_CMD}"
  )
  local nested_args=()
  if [ "$agent_mode" = "codex" ]; then
    nested_args+=("--codex")
  fi
  if [ -n "$prompt" ]; then
    nested_args+=("$prompt")
  fi
  local nested_cmd
  nested_cmd="\"$0\""
  if [ ${#nested_args[@]} -gt 0 ]; then
    nested_cmd+="$(printf ' %q' "${nested_args[@]}")"
  fi
  nested_cmd+="; exec \$SHELL"
  ensure_infra
  tmux new-session -d -s "$session_name" -c "$work_dir" \
    "${tmux_env[@]}" \
    "$nested_cmd"
  json_out --arg sessionName "$session_name" --arg tmuxTarget "${session_name}:0.0" --arg workdir "$work_dir" '{ok:true,sessionName:$sessionName,tmuxTarget:$tmuxTarget,workdir:$workdir}'
}

send_to_tmux_session() {
  local session_name="$1"
  local text="$2"
  local pane_target="${session_name}:0.0"
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
