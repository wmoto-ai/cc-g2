#!/usr/bin/env bash
set -euo pipefail

# Reads `{ reply, notification }` JSON from stdin.
# 1) Always appends JSONL to RELAY_LOG_FILE.
# 2) Optionally forwards to claude CLI as non-interactive prompts.

PAYLOAD="$(cat)"
if [[ -z "${PAYLOAD}" ]]; then
  echo "empty payload" >&2
  exit 1
fi

RELAY_LOG_FILE="${RELAY_LOG_FILE:-tmp/notification-hub/reply-relay-events.jsonl}"
RELAY_ENABLE_TMUX="${RELAY_ENABLE_TMUX:-0}"
RELAY_TMUX_TARGET="${RELAY_TMUX_TARGET:-}"
RELAY_TMUX_AUTO_DETECT="${RELAY_TMUX_AUTO_DETECT:-1}"
RELAY_TMUX_USE_NOTIFICATION_TARGET="${RELAY_TMUX_USE_NOTIFICATION_TARGET:-1}"
RELAY_PROJECT_DIR="${RELAY_PROJECT_DIR:-}"
RELAY_EXTRA_NOTE="${RELAY_EXTRA_NOTE:-}"
RELAY_ASYNC="${RELAY_ASYNC:-1}"
RELAY_AGENT_LOG_FILE="${RELAY_AGENT_LOG_FILE:-tmp/notification-hub/reply-relay-agent.log}"
RELAY_MESSAGE_STYLE="${RELAY_MESSAGE_STYLE:-simple}"
RELAY_TMUX_SUBMIT_KEY="${RELAY_TMUX_SUBMIT_KEY:-}"
RELAY_TMUX_SUBMIT_FALLBACK_KEY="${RELAY_TMUX_SUBMIT_FALLBACK_KEY:-}"
RELAY_TMUX_PREPARE_INPUT="${RELAY_TMUX_PREPARE_INPUT:-1}"
RELAY_TMUX_STRICT_APPROVAL_TARGET="${RELAY_TMUX_STRICT_APPROVAL_TARGET:-1}"

if [[ "${RELAY_LOG_FILE}" != /* ]]; then
  RELAY_LOG_FILE="$(pwd)/${RELAY_LOG_FILE}"
fi
if [[ "${RELAY_AGENT_LOG_FILE}" != /* ]]; then
  RELAY_AGENT_LOG_FILE="$(pwd)/${RELAY_AGENT_LOG_FILE}"
fi

mkdir -p "$(dirname "$RELAY_LOG_FILE")"
printf '%s\n' "$PAYLOAD" >> "$RELAY_LOG_FILE"
mkdir -p "$(dirname "$RELAY_AGENT_LOG_FILE")"

# 1回の Node.js プロセスで全変数を一括パース（8→1プロセスに統合）
eval "$(
  printf '%s' "$PAYLOAD" | node -e '
    const raw = require("fs").readFileSync(0, "utf8");
    const p = JSON.parse(raw || "{}");
    const r = p.reply || {};
    const n = p.notification || {};
    const m = n.metadata || {};

    const action = r.resolvedAction || r.action || "unknown";
    const source = r.source || "unknown";
    const comment = r.comment || r.replyText || "";
    const title = n.title || "(no-title)";
    const nid = n.id || r.notificationId || "(no-id)";

    // Shell-safe output: escape single quotes for eval
    const q = (v) => String(v || "").replace(/\x27/g, "\x27\\\x27\x27");

    // summary
    const summaryLines = [
      "Even G2/ntfy decision received.",
      `action=${action}`,
      `source=${source}`,
      `notification_id=${nid}`,
      `title=${title}`,
    ];
    if (comment) summaryLines.push(`comment=${comment}`);

    // tmux_message
    const style = String(process.env.RELAY_MESSAGE_STYLE || "simple").toLowerCase();
    const normalize = (v) => String(v || "").replace(/^\[ACTION\]\s*/i, "").trim();
    let tmuxMsg;
    if (style === "verbose") {
      const parts = [
        `[G2/ntfy decision] action=${action} source=${source}`,
        `notification_id=${nid}`,
        `title=${title}`,
      ];
      if (comment) parts.push(`comment=${comment}`);
      tmuxMsg = parts.join(" | ");
    } else {
      const nc = normalize(comment);
      if (action === "comment") tmuxMsg = nc || "コメント";
      else if (action === "approve") tmuxMsg = (nc && nc.toLowerCase() !== "approve") ? nc : "承認";
      else if (action === "deny") tmuxMsg = (nc && nc.toLowerCase() !== "deny") ? nc : "拒否";
      else tmuxMsg = nc || action;
    }

    // notification metadata
    const tmuxTarget =
      (typeof m.tmuxTarget === "string" && m.tmuxTarget.trim()) ||
      (typeof m.tmuxPane === "string" && m.tmuxPane.trim()) ||
      (m.tmux && typeof m.tmux.target === "string" && m.tmux.target.trim()) ||
      "";
    const agentName = typeof m.agentName === "string" ? m.agentName.trim() : "";
    const cwd = typeof m.cwd === "string" ? m.cwd.trim() : "";
    const project = typeof m.project === "string" ? m.project.trim() : "";
    const sessionLabel = typeof m.sessionLabel === "string" ? m.sessionLabel.trim() : "";
    const isApproval = (m.hookType === "permission-request" || m.approvalId) ? "1" : "0";
    const replyAction = r.resolvedAction || r.action || "unknown";
    const replyComment = normalize(r.comment || r.replyText || "");

    const lines = [
      `summary=\x27${q(summaryLines.join("\\n"))}\x27`,
      `tmux_message=\x27${q(tmuxMsg)}\x27`,
      `notification_tmux_target=\x27${q(tmuxTarget)}\x27`,
      `notification_agent_name=\x27${q(agentName)}\x27`,
      `notification_cwd=\x27${q(cwd)}\x27`,
      `notification_project=\x27${q(project)}\x27`,
      `notification_session_label=\x27${q(sessionLabel)}\x27`,
      `is_approval_prompt=\x27${q(isApproval)}\x27`,
      `reply_action=\x27${q(replyAction)}\x27`,
      `reply_comment=\x27${q(replyComment)}\x27`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  '
)"

if [[ -n "$RELAY_EXTRA_NOTE" ]]; then
  summary="${summary}\n${RELAY_EXTRA_NOTE}"
fi

run_in_dir() {
  if [[ -n "$RELAY_PROJECT_DIR" ]]; then
    cd "$RELAY_PROJECT_DIR"
  fi
  "$@"
}

# Agent 系プロセス判定:
# - Claude Code native install can show as "claude" or a semantic version.
# - Codex CLI installed via npm/pnpm can show as "codex" or "node".
is_agent_cmd() {
  [[ "$1" == "claude" || "$1" == "codex" || "$1" == "node" || "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# notification metadata + ペイン情報から最適な tmux ターゲットを1回の awk で解決
# 優先度:
#   project+sessionLabel > project+agent > cwd+agent > project+shell > cwd+shell > agent_only > shell_only
resolve_tmux_target_by_metadata() {
  local cwd="${notification_cwd:-}"
  local project="${notification_project:-}"
  local session_label="${notification_session_label:-}"
  local hint=""
  local v
  v="$(printf '%s' "${notification_agent_name}" | tr '[:upper:]' '[:lower:]')"
  [[ "$v" == *claude* ]] && hint="claude"
  [[ "$v" == *codex* ]] && hint="codex"

  [[ -z "$cwd" && -z "$hint" && -z "$project" ]] && return 1

  local panes
  panes="$(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{session_attached} #{pane_active} #{pane_current_path}')"

  printf '%s\n' "$panes" | awk -v cwd="$cwd" -v hint="$hint" -v project="$project" -v session_label="$session_label" '
    function slugify(s,    t) {
      t = tolower(s)
      gsub(/[^a-z0-9_-]/, "-", t)
      return t
    }
    function is_agent(c) { return (c=="claude" || c=="codex" || c=="node" || c ~ /^[0-9]+\.[0-9]+\.[0-9]+$/) }
    function is_shell(c) { return (c=="zsh" || c=="bash") }
    function is_candidate(c) { return is_agent(c) || is_shell(c) }
    function agent_hint_match(c, h) {
      if (h == "") return 0
      if (h == "claude") return (c=="claude" || c ~ /^[0-9]+\.[0-9]+\.[0-9]+$/)
      if (h == "codex") return (c=="codex" || c=="node")
      return 0
    }
    function project_match(session, proj,    slug) {
      if (proj == "") return 0
      slug = slugify(proj)
      return (session ~ ("^g2-" slug "-[0-9a-f]{4}(-codex)?(-[0-9]+)?$")) || (session == ("cc-g2-" slug))
    }
    function session_label_match(session, proj, label,    slug, wanted) {
      if (!project_match(session, proj) || label == "") return 0
      slug = slugify(proj)
      if (label == "#1") {
        return (session ~ ("^g2-" slug "-[0-9a-f]{4}(-codex)?$")) || (session == ("cc-g2-" slug))
      }
      wanted = substr(label, 2)
      if (wanted ~ /^[0-9]+$/) {
        return session ~ ("^g2-" slug "-[0-9a-f]{4}(-codex)?-" wanted "$")
      }
      return 0
    }
    ($3+0) >= 1 && is_candidate($2) {
      split($1, parts, ":")
      session = parts[1]
      has_project = project_match(session, project)
      has_session_label = session_label_match(session, project, session_label)
      has_cwd = (cwd != "" && index(cwd, $5) == 1)
      has_hint = agent_hint_match($2, hint)
      shell_score = is_shell($2) ? 1 : 0
      agent_score = is_agent($2) ? 1 : 0
      score = has_session_label * 100 + has_project * 20 + has_cwd * 10 + has_hint * 4 + agent_score * 2 + shell_score
      if (score > best_score) { best_score = score; best = $1 }
    }
    END { if (best != "") print best }
  '
}

resolve_tmux_target() {
  if [[ -n "$RELAY_TMUX_TARGET" ]]; then
    printf '%s' "$RELAY_TMUX_TARGET"
    return 0
  fi

  # notification metadata に埋め込まれた tmux target を優先
  if [[ "$RELAY_TMUX_USE_NOTIFICATION_TARGET" == "1" ]] && [[ -n "$notification_tmux_target" ]]; then
    # cc-g2 経由起動では pane_current_command が "zsh"/"bash" になるので許容
    local cmd
    cmd="$(tmux display-message -p -t "$notification_tmux_target" '#{pane_current_command}' 2>/dev/null || true)"
    if [[ -n "$cmd" ]]; then
      if is_agent_cmd "$cmd" || [[ "$cmd" == "zsh" || "$cmd" == "bash" ]]; then
        printf '%s' "$notification_tmux_target"
        return 0
      fi
    fi
  fi
  if [[ "$RELAY_TMUX_AUTO_DETECT" != "1" ]]; then
    return 1
  fi
  local target
  target="$(resolve_tmux_target_by_metadata || true)"
  if [[ -n "$target" ]]; then
    printf '%s' "$target"
    return 0
  fi
  return 1
}

send_tmux_message() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux not found but RELAY_ENABLE_TMUX=1" >&2
    exit 1
  fi
  local target
  if [[ "$is_approval_prompt" == "1" ]] && [[ "$RELAY_TMUX_STRICT_APPROVAL_TARGET" == "1" ]] && [[ -n "$notification_tmux_target" ]]; then
    # 承認系は通知metadataの送信元paneに固定して誤配信を防ぐ。
    if tmux display-message -p -t "$notification_tmux_target" '#{pane_id}' >/dev/null 2>&1; then
      target="$notification_tmux_target"
    else
      echo "approval strict target unavailable: $notification_tmux_target" >&2
      exit 1
    fi
  else
    target="$(resolve_tmux_target || true)"
  fi
  if [[ -z "$target" ]]; then
    echo "tmux target not found (set RELAY_TMUX_TARGET or keep a claude pane attached)" >&2
    exit 1
  fi

  # 承認プロンプト中: y/n キーを直接送信（Claude Code TUI のホットキー）
  if [[ "$is_approval_prompt" == "1" ]]; then
    printf 'tmux approval target=%s action=%s comment=%s\n' \
      "$target" "$reply_action" "${reply_comment:0:50}" >> "$RELAY_AGENT_LOG_FILE"

    # 承認ダイアログにフォーカスを戻す（入力欄フォーカス残り対策）
    tmux send-keys -t "$target" Escape
    sleep 0.03

    if [[ "$reply_action" == "approve" ]]; then
      tmux send-keys -t "$target" y
      sleep 0.05
      tmux send-keys -t "$target" Enter
      return
    fi

    # deny / comment 共通: Escape → n → Enter で承認ダイアログを拒否
    send_deny_keys() {
      tmux send-keys -t "$target" Escape
      sleep 0.05
      tmux send-keys -t "$target" n
      sleep 0.03
      tmux send-keys -t "$target" Enter
    }

    # コメント付き拒否後にテキストを入力して送信
    send_comment_after_deny() {
      local text="$1" msg="$2"
      sleep 1.5
      tmux send-keys -t "$target" -l "$text"
      sleep 0.05
      tmux send-keys -t "$target" C-j
      tmux display-message -t "$target" "$msg"
    }

    if [[ "$reply_action" == "deny" ]]; then
      send_deny_keys
      tmux display-message -t "$target" "G2 deny applied (approval canceled)"
      # deny にコメントが付いている場合は指示テキストとして送信
      if [[ -n "$reply_comment" && "$reply_comment" != "deny" && "$reply_comment" != "拒否" ]]; then
        send_comment_after_deny "$reply_comment" "G2 deny+comment applied"
      fi
      return
    fi

    # コメント: 承認ダイアログを拒否してから指示テキストを入力
    if [[ "$reply_action" == "comment" && -n "$reply_comment" ]]; then
      send_deny_keys
      send_comment_after_deny "$reply_comment" "G2 comment applied (deny + instruction)"
      return
    fi

    return
  fi

  # 通常の通知（非承認プロンプト）: 既存ロジック
  local submit_key fallback_key
  submit_key="$RELAY_TMUX_SUBMIT_KEY"
  if [[ -z "$submit_key" ]]; then
    submit_key="Enter"
  fi
  fallback_key="$RELAY_TMUX_SUBMIT_FALLBACK_KEY"
  if [[ -z "$fallback_key" ]]; then
    if [[ "$submit_key" == "Enter" ]]; then
      fallback_key="C-j"
    elif [[ "$submit_key" == "C-j" ]]; then
      fallback_key="Enter"
    fi
  fi

  # 入力欄フォーカスずれ/残留テキストで送信失敗するケースを減らす。
  if [[ "$RELAY_TMUX_PREPARE_INPUT" == "1" ]]; then
    tmux send-keys -t "$target" Escape
    tmux send-keys -t "$target" C-u
  fi

  printf 'tmux target=%s submit_key=%s fallback_key=%s prepare_input=%s\n' \
    "$target" "$submit_key" "$fallback_key" "$RELAY_TMUX_PREPARE_INPUT" >> "$RELAY_AGENT_LOG_FILE"
  tmux send-keys -t "$target" -l "$tmux_message"
  tmux send-keys -t "$target" "$submit_key"
  if [[ -n "$fallback_key" && "$fallback_key" != "$submit_key" ]]; then
    sleep 0.08
    tmux send-keys -t "$target" "$fallback_key"
  fi
}

run_agent_cmd() {
  local cmd="$1"
  if [[ "$RELAY_ASYNC" == "1" ]]; then
    if [[ -n "$RELAY_PROJECT_DIR" ]]; then
      (
        cd "$RELAY_PROJECT_DIR"
        nohup /bin/zsh -lc "$cmd" >> "$RELAY_AGENT_LOG_FILE" 2>&1 &
      )
    else
      nohup /bin/zsh -lc "$cmd" >> "$RELAY_AGENT_LOG_FILE" 2>&1 &
    fi
  else
    run_in_dir /bin/zsh -lc "$cmd" >> "$RELAY_AGENT_LOG_FILE" 2>&1
  fi
}

if [[ "$RELAY_ENABLE_TMUX" == "1" ]]; then
  send_tmux_message
fi

exit 0
