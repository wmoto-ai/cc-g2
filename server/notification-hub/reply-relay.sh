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

# herdr ターゲット（herdr:<pane_id> プレフィックス）は tmux では解決できないため、
# herdr バックエンド (reply-relay-herdr.sh) に委譲する。tmux 経路の挙動は変えない。
if [[ "${RELAY_ENABLE_HERDR:-1}" == "1" && "$notification_tmux_target" == herdr:* ]]; then
  HERDR_RELAY_SCRIPT="${HERDR_RELAY_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/reply-relay-herdr.sh}"
  rc=0
  printf '%s' "$PAYLOAD" | RELAY_SKIP_PAYLOAD_LOG=1 bash "$HERDR_RELAY_SCRIPT" || rc=$?
  exit "$rc"
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
# - GitHub Copilot CLI shows as "copilot" (Homebrew) or "node" (npm).
is_agent_cmd() {
  [[ "$1" == "claude" || "$1" == "codex" || "$1" == "copilot" || "$1" == "node" || "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# 承認対象ペインが GitHub Copilot CLI か判定する。
# npm 版 copilot は pane_current_command が "node" になり codex と区別できないため、
# 通知 metadata の agentName（copilot-hook が copilot をセット）を最優先し、
# フォールバックとして Homebrew 版で見える pane_current_command "copilot" を使う。
is_copilot_target() {
  local target="$1"
  local an
  an="$(printf '%s' "${notification_agent_name:-}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$an" == *copilot* ]]; then
    return 0
  fi
  local cmd
  cmd="$(tmux display-message -p -t "$target" '#{pane_current_command}' 2>/dev/null || true)"
  [[ "$cmd" == "copilot" ]]
}

# 承認対象ペインが Codex CLI か判定する。
# 通知 metadata の agentName=codex を最優先し、フォールバックで pane_current_command
# が codex 系（codex / node）。is_copilot_target を先に判定するので、ここに来る node は
# copilot でない前提だが、確実性のため agentName を優先する。
is_codex_target() {
  local target="$1"
  local an
  an="$(printf '%s' "${notification_agent_name:-}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$an" == *codex* ]]; then
    return 0
  fi
  local cmd
  cmd="$(tmux display-message -p -t "$target" '#{pane_current_command}' 2>/dev/null || true)"
  [[ "$cmd" == "codex" ]]
}

# 承認ダイアログが対象ペインに表示されているか（fail-closed 用の precheck）。
# ノンブロッキング承認注入（RELAY_APPROVAL_PRECHECK=1）では、ローカルで既に決着して
# ダイアログが消えている場合に stray キーを撃たないよう、実在確認できたときだけ注入する。
# claude/codex/copilot いずれの権限プロンプトも「Do you want …」＋番号選択肢や y/n を含む。
# 入力欄のみの通常状態と区別できれば十分（過度に厳密にしない）。
APPROVAL_DIALOG_PATTERN='do you want|[0-9]\. (yes|no)|❯ *[0-9]|\(y/n\)|allow this|esc to (stop|cancel|interrupt)'
approval_dialog_present() {
  local target="$1"
  local screen
  screen="$(tmux capture-pane -p -t "$target" 2>/dev/null || true)"
  [[ -n "$screen" ]] || return 1
  printf '%s' "$screen" | grep -qiE "$APPROVAL_DIALOG_PATTERN"
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
  [[ "$v" == *copilot* ]] && hint="copilot"

  [[ -z "$cwd" && -z "$hint" && -z "$project" ]] && return 1

  local panes
  # 第5フィールドは「このペインが QR 常駐ペインか」(1/0)。QR ペインは表示専用の
  # 生きたシェルで、agent 終了後はスコアが agent ペインと同点になり index 順で
  # 先に選ばれてしまうため、候補から除外する（@cc_g2_qr_pane はセッションオプション）
  panes="$(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{session_attached} #{pane_active} #{?#{==:#{pane_id},#{@cc_g2_qr_pane}},1,0} #{pane_current_path}')"

  printf '%s\n' "$panes" | awk -v cwd="$cwd" -v hint="$hint" -v project="$project" -v session_label="$session_label" '
    function slugify(s,    t) {
      t = tolower(s)
      gsub(/[^a-z0-9_-]/, "-", t)
      return t
    }
    function is_agent(c) { return (c=="claude" || c=="codex" || c=="copilot" || c=="node" || c ~ /^[0-9]+\.[0-9]+\.[0-9]+$/) }
    function is_shell(c) { return (c=="zsh" || c=="bash") }
    function is_candidate(c) { return is_agent(c) || is_shell(c) }
    function agent_hint_match(c, h) {
      if (h == "") return 0
      if (h == "claude") return (c=="claude" || c ~ /^[0-9]+\.[0-9]+\.[0-9]+$/)
      if (h == "codex") return (c=="codex" || c=="node")
      if (h == "copilot") return (c=="copilot" || c=="node")
      return 0
    }
    function project_match(session, proj,    slug) {
      if (proj == "") return 0
      slug = slugify(proj)
      return (session ~ ("^g2-" slug "-[0-9a-f]{4}(-codex|-copilot)?(-[0-9]+)?$")) || (session == ("cc-g2-" slug))
    }
    function session_label_match(session, proj, label,    slug, wanted) {
      if (!project_match(session, proj) || label == "") return 0
      slug = slugify(proj)
      if (label == "#1") {
        return (session ~ ("^g2-" slug "-[0-9a-f]{4}(-codex|-copilot)?$")) || (session == ("cc-g2-" slug))
      }
      wanted = substr(label, 2)
      if (wanted ~ /^[0-9]+$/) {
        return session ~ ("^g2-" slug "-[0-9a-f]{4}(-codex|-copilot)?-" wanted "$")
      }
      return 0
    }
    ($3+0) >= 1 && ($5+0) == 0 && is_candidate($2) {
      split($1, parts, ":")
      session = parts[1]
      has_project = project_match(session, project)
      has_session_label = session_label_match(session, project, session_label)
      has_cwd = (cwd != "" && index(cwd, $6) == 1)
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
    # cc-g2 経由起動では pane_current_command が "zsh"/"bash" になるので許容。
    # 旧形式ターゲット（session:0.0）が QR 常駐ペインを指してしまった場合
    # （QR ペイン導入前のセッションに新版で attach した等）は使わず自動検出に落とす
    local probe cmd
    probe="$(tmux display-message -p -t "$notification_tmux_target" '#{pane_current_command}|#{?#{==:#{pane_id},#{@cc_g2_qr_pane}},1,0}' 2>/dev/null || true)"
    cmd="${probe%%|*}"
    if [[ -n "$cmd" && "${probe##*|}" != "1" ]]; then
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
    # 注意: tmux 3.6 は不存在 target でも display-message が exit 0 を返すことが
    # あるため、出力の有無で存在判定する。ターゲットが QR 常駐ペインを指す場合
    # （旧形式 session:0.0 の移行エッジ）はシェルに y/n を打ち込まず失敗させる。
    local probe
    probe="$(tmux display-message -p -t "$notification_tmux_target" '#{pane_id}|#{?#{==:#{pane_id},#{@cc_g2_qr_pane}},1,0}' 2>/dev/null || true)"
    if [ -n "${probe%%|*}" ] && [ "${probe##*|}" != "1" ]; then
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

    # ノンブロッキング承認注入の fail-closed precheck: ダイアログ非表示なら注入しない。
    if [[ "${RELAY_APPROVAL_PRECHECK:-0}" == "1" ]] && ! approval_dialog_present "$target"; then
      echo "approval dialog not found on $target; skip injection" >&2
      printf 'tmux approval precheck failed target=%s (dialog not found)\n' "$target" >> "$RELAY_AGENT_LOG_FILE"
      exit 1
    fi

    # Copilot CLI TUI は y/n ではなく番号選択リスト（1. Yes / 2. No + コメント）。
    # 承認は 1 の単押しで即実行（Enter 不要）、拒否/コメントは 2 でオプション 2 に
    # 移動して以後の文字がインライン入力欄に入るので、テキスト → Enter で送る。
    # claude/codex 流の Escape 前置はダイアログ自体をキャンセルするため送らない。
    if is_copilot_target "$target"; then
      if [[ "$reply_action" == "approve" ]]; then
        tmux send-keys -t "$target" 1
        tmux display-message -t "$target" "G2 approve applied (copilot)"
        return
      fi
      # deny / comment: オプション 2 は空 Enter だと無反応のため必ずテキストを送る
      local copilot_text="$reply_comment"
      if [[ "$reply_action" == "deny" ]] \
        && { [[ -z "$copilot_text" ]] || [[ "$copilot_text" == "deny" ]] || [[ "$copilot_text" == "拒否" ]]; }; then
        copilot_text="拒否"
      fi
      [[ -n "$copilot_text" ]] || copilot_text="拒否"
      tmux send-keys -t "$target" 2
      sleep 0.4
      tmux send-keys -t "$target" -l "$copilot_text"
      sleep 0.05
      tmux send-keys -t "$target" Enter
      tmux display-message -t "$target" "G2 ${reply_action} applied (copilot)"
      return
    fi

    # Codex CLI TUI（0.144.1 実測）は番号選択式:
    #   1. Yes, proceed (y) / 2. Yes, and don't ask again (p) / 3. No, and tell Codex …(esc)
    # 承認は y の単押しで即実行（Escape 前置なし・Enter なし）。Escape はリクエストごと
    # キャンセルしてしまうため送らない。拒否は 3（即キャンセルしてプロンプトに戻り、
    # 続けてコメントを新規メッセージとして送れる）。
    if is_codex_target "$target"; then
      if [[ "$reply_action" == "approve" ]]; then
        tmux send-keys -t "$target" y
        tmux display-message -t "$target" "G2 approve applied (codex)"
        return
      fi
      # deny / comment: 3 で拒否。コメントがあれば続けてテキスト → Enter
      tmux send-keys -t "$target" 3
      local codex_comment="$reply_comment"
      if [[ "$reply_action" == "deny" ]] \
        && { [[ "$codex_comment" == "deny" ]] || [[ "$codex_comment" == "拒否" ]]; }; then
        codex_comment=""
      fi
      if [[ -n "$codex_comment" ]]; then
        sleep 0.4
        tmux send-keys -t "$target" -l "$codex_comment"
        sleep 0.05
        tmux send-keys -t "$target" Enter
      fi
      tmux display-message -t "$target" "G2 ${reply_action} applied (codex)"
      return
    fi

    # 残りは Claude Code（copilot でも codex でもないデフォルト経路）。
    # 現行 Claude Code v2.1（実測）は番号選択式:
    #   ❯ 1. Yes / 2. Yes, and always allow … / 3. No（Esc to cancel）
    # 承認 = 1 単押し（Escape 前置なし・Enter なし）。Escape はキャンセルするため送らない。
    # 拒否 = 3。拒否後はユーザーがメッセージを打てるので、コメントがあれば続けて送る。
    # 通常運用の claude は longpoll で HTTP hook が allow/deny を返すため、この注入分岐が
    # 使われるのは nonblocking 時のみ。
    if [[ "$reply_action" == "approve" ]]; then
      tmux send-keys -t "$target" 1
      tmux display-message -t "$target" "G2 approve applied (claude)"
      return
    fi
    # deny / comment: 3 で拒否。コメントがあれば続けてテキスト → Enter
    tmux send-keys -t "$target" 3
    local claude_comment="$reply_comment"
    if [[ "$reply_action" == "deny" ]] \
      && { [[ "$claude_comment" == "deny" ]] || [[ "$claude_comment" == "拒否" ]]; }; then
      claude_comment=""
    fi
    if [[ -n "$claude_comment" ]]; then
      sleep 0.4
      tmux send-keys -t "$target" -l "$claude_comment"
      sleep 0.05
      tmux send-keys -t "$target" Enter
    fi
    tmux display-message -t "$target" "G2 ${reply_action} applied (claude)"
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
