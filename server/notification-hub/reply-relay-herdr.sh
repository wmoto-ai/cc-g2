#!/usr/bin/env bash
set -euo pipefail

# Reads `{ reply, notification }` JSON from stdin (reply-relay.sh と同じ入力インターフェース)。
# notification metadata の target が `herdr:<pane_id>` の通知を herdr CLI で対象ペインへ届ける。
# 通常は reply-relay.sh がプレフィックスを検出して本スクリプトへ委譲する。
# HUB_REPLY_RELAY_CMD に直接指定して単体で使うこともできる。
#
# herdr 送信の作法 (実測):
#   send-text 直後の即 Enter はペースト完了前で空打ちになる。
#   send-text → sleep → pane read で入力欄への反映を確認 → send-keys Enter とする。
#   herdr の pane_id はペイン close で消えるため、送信直前に agent list で存在を再確認し、
#   消えていたら stub 扱い (非ゼロ exit で reply record に failed として残す)。

PAYLOAD="$(cat)"
if [[ -z "${PAYLOAD}" ]]; then
  echo "empty payload" >&2
  exit 1
fi

RELAY_LOG_FILE="${RELAY_LOG_FILE:-tmp/notification-hub/reply-relay-events.jsonl}"
RELAY_AGENT_LOG_FILE="${RELAY_AGENT_LOG_FILE:-tmp/notification-hub/reply-relay-agent.log}"
RELAY_MESSAGE_STYLE="${RELAY_MESSAGE_STYLE:-simple}"
# reply-relay.sh からの委譲時は payload 追記済みのため 1 が渡り、二重記録を防ぐ
RELAY_SKIP_PAYLOAD_LOG="${RELAY_SKIP_PAYLOAD_LOG:-0}"
HERDR_BIN="${HERDR_BIN:-herdr}"
RELAY_HERDR_SEND_TEXT_WAIT="${RELAY_HERDR_SEND_TEXT_WAIT:-1}"
RELAY_HERDR_READ_LINES="${RELAY_HERDR_READ_LINES:-15}"

if [[ "${RELAY_LOG_FILE}" != /* ]]; then
  RELAY_LOG_FILE="$(pwd)/${RELAY_LOG_FILE}"
fi
if [[ "${RELAY_AGENT_LOG_FILE}" != /* ]]; then
  RELAY_AGENT_LOG_FILE="$(pwd)/${RELAY_AGENT_LOG_FILE}"
fi

mkdir -p "$(dirname "$RELAY_LOG_FILE")" "$(dirname "$RELAY_AGENT_LOG_FILE")"
if [[ "$RELAY_SKIP_PAYLOAD_LOG" != "1" ]]; then
  printf '%s\n' "$PAYLOAD" >> "$RELAY_LOG_FILE"
fi

# reply-relay.sh と同じ 1 プロセス一括パース (message / target / approval 判定)
eval "$(
  printf '%s' "$PAYLOAD" | node -e '
    const raw = require("fs").readFileSync(0, "utf8");
    const p = JSON.parse(raw || "{}");
    const r = p.reply || {};
    const n = p.notification || {};
    const m = n.metadata || {};

    const action = r.resolvedAction || r.action || "unknown";
    const comment = r.comment || r.replyText || "";
    const normalize = (v) => String(v || "").replace(/^\[ACTION\]\s*/i, "").trim();

    const style = String(process.env.RELAY_MESSAGE_STYLE || "simple").toLowerCase();
    let msg;
    if (style === "verbose") {
      const parts = [
        `[G2/ntfy decision] action=${action} source=${r.source || "unknown"}`,
        `notification_id=${n.id || r.notificationId || "(no-id)"}`,
        `title=${n.title || "(no-title)"}`,
      ];
      if (comment) parts.push(`comment=${comment}`);
      msg = parts.join(" | ");
    } else {
      const nc = normalize(comment);
      if (action === "comment") msg = nc || "コメント";
      else if (action === "approve") msg = (nc && nc.toLowerCase() !== "approve") ? nc : "承認";
      else if (action === "deny") msg = (nc && nc.toLowerCase() !== "deny") ? nc : "拒否";
      else msg = nc || action;
    }

    const target =
      (typeof m.tmuxTarget === "string" && m.tmuxTarget.trim()) ||
      (typeof m.tmuxPane === "string" && m.tmuxPane.trim()) ||
      (m.tmux && typeof m.tmux.target === "string" && m.tmux.target.trim()) ||
      "";
    const isApproval = (m.hookType === "permission-request" || m.approvalId) ? "1" : "0";
    const agentName = typeof m.agentName === "string" ? m.agentName.trim() : "";
    const replyComment = normalize(comment);

    // 入力欄反映の確認用プローブ: 先頭行の先頭 12 文字 (UTF-8 セーフに JS 側で切る)
    const probeOf = (s) => String(s || "").split("\n")[0].slice(0, 12);

    const q = (v) => String(v || "").replace(/\x27/g, "\x27\\\x27\x27");
    const lines = [
      `herdr_message=\x27${q(msg)}\x27`,
      `herdr_message_probe=\x27${q(probeOf(msg))}\x27`,
      `notification_target=\x27${q(target)}\x27`,
      `is_approval_prompt=\x27${q(isApproval)}\x27`,
      `notification_agent_name=\x27${q(agentName)}\x27`,
      `reply_action=\x27${q(action)}\x27`,
      `reply_comment=\x27${q(replyComment)}\x27`,
      `reply_comment_probe=\x27${q(probeOf(replyComment))}\x27`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  '
)"

if [[ "$notification_target" != herdr:* ]]; then
  echo "not a herdr target: ${notification_target:-<empty>}" >&2
  exit 1
fi
HERDR_TARGET="${notification_target#herdr:}"

# copilot の TUI はペインが focused=true でないと Enter を submit として受理しない
# （claude/codex は focus 非依存で Enter が通る）。agentName で判定し、submit 直前に
# 前面化する（下記 herdr_focus_for_submit）。
agent_name_lc="$(printf '%s' "${notification_agent_name:-}" | tr '[:upper:]' '[:lower:]')"
IS_COPILOT=0
[[ "$agent_name_lc" == *copilot* ]] && IS_COPILOT=1
IS_CODEX=0
[[ "$agent_name_lc" == *codex* ]] && IS_CODEX=1

if ! command -v "$HERDR_BIN" >/dev/null 2>&1; then
  echo "herdr CLI not found (HERDR_BIN=${HERDR_BIN})" >&2
  exit 1
fi

log_agent() {
  printf '%s\n' "$*" >> "$RELAY_AGENT_LOG_FILE"
}

# 送信直前の pane 存在確認 (agent list に居なければ stub 扱い)
agent_list_json="$("$HERDR_BIN" agent list 2>/dev/null || true)"
pane_exists="$(printf '%s' "$agent_list_json" | node -e '
  const raw = require("fs").readFileSync(0, "utf8");
  let ok = "0";
  try {
    const agents = ((JSON.parse(raw) || {}).result || {}).agents || [];
    if (agents.some((a) => a && a.pane_id === process.argv[1])) ok = "1";
  } catch {}
  process.stdout.write(ok);
' "$HERDR_TARGET")"
if [[ "$pane_exists" != "1" ]]; then
  log_agent "herdr pane missing target=${HERDR_TARGET} (stub)"
  echo "herdr pane not found: ${HERDR_TARGET} (agent gone; treated as stub)" >&2
  exit 1
fi

herdr_send_keys() {
  "$HERDR_BIN" pane send-keys "$HERDR_TARGET" "$@"
}

# ペインをベストエフォートで前面化する（focus）。承認ダイアログのキー受理・Enter submit は
# herdr ではペインが focused=true でないと通らないため、承認分岐（claude/codex/copilot）で
# submit 直前に呼ぶ。
herdr_focus_now() {
  "$HERDR_BIN" agent focus "$HERDR_TARGET" >/dev/null 2>&1 || true
}
# 通常返信（非承認）の submit 前 focus。copilot は Enter submit に focus 必須のため前面化し、
# claude/codex は従来どおり focus 非依存で no-op（既存挙動を変えない）。
herdr_focus_for_submit() {
  [[ "$IS_COPILOT" == "1" ]] || return 0
  herdr_focus_now
}

# send-text → 反映確認。未反映なら send-text を 1 回やり直す。確認できたら 0。
herdr_send_text_confirmed() {
  local text="$1"
  local probe="$2"
  local attempt screen
  for attempt in 1 2; do
    "$HERDR_BIN" pane send-text "$HERDR_TARGET" "$text"
    sleep "$RELAY_HERDR_SEND_TEXT_WAIT"
    screen="$("$HERDR_BIN" pane read "$HERDR_TARGET" --lines "$RELAY_HERDR_READ_LINES" 2>/dev/null || true)"
    # 長文/複数行は入力欄で "Pasted text" に畳まれることがある
    if [[ -n "$probe" && "$screen" == *"$probe"* ]] || [[ "$screen" == *"Pasted text"* ]]; then
      return 0
    fi
    log_agent "herdr send-text unconfirmed target=${HERDR_TARGET} attempt=${attempt}"
  done
  return 1
}

# テキストを入力欄に載せて Enter で送信。未確認時も Enter は試すが failed として残す。
herdr_submit_text() {
  local text="$1"
  local probe="$2"
  if herdr_send_text_confirmed "$text" "$probe"; then
    herdr_focus_for_submit
    herdr_send_keys Enter
    return 0
  fi
  herdr_focus_for_submit
  herdr_send_keys Enter
  log_agent "herdr send-text unconfirmed after retry target=${HERDR_TARGET} (Enter sent anyway)"
  return 0
}

# 承認プロンプト: reply-relay.sh の tmux 経路と同じキー操作を herdr send-keys で行う
if [[ "$is_approval_prompt" == "1" ]]; then
  log_agent "herdr approval target=${HERDR_TARGET} action=${reply_action} comment=${reply_comment:0:50}"

  # ノンブロッキング承認注入の fail-closed precheck: ダイアログ非表示なら注入しない。
  # tmux 経路と同じパターンで、herdr pane read の画面に権限プロンプトが出ているか確認する。
  # --source visible 必須: claude は代替画面（alt-screen）を使うため、デフォルトの
  # スクロールバック読みだと内容が空になりダイアログを検出できず fail-closed してしまう。
  # visible は codex/copilot でも上位互換（従来取れていたものは引き続き取れる）。
  if [[ "${RELAY_APPROVAL_PRECHECK:-0}" == "1" ]]; then
    approval_screen="$("$HERDR_BIN" pane read "$HERDR_TARGET" --source visible --lines "$RELAY_HERDR_READ_LINES" 2>/dev/null || true)"
    if ! printf '%s' "$approval_screen" | grep -qiE 'do you want|[0-9]\. (yes|no)|❯ *[0-9]|\(y/n\)|allow this|esc to (stop|cancel|interrupt)'; then
      log_agent "herdr approval precheck failed target=${HERDR_TARGET} (dialog not found)"
      echo "approval dialog not found on herdr:${HERDR_TARGET}; skip injection" >&2
      exit 1
    fi
  fi

  # Copilot CLI TUI は番号選択リスト（1. Yes / 2. No + コメント）。承認は 1 の単押しで
  # 即実行、拒否/コメントは 2 でオプション 2 に移動してテキスト → Enter。
  # claude/codex 流の Escape 前置はダイアログをキャンセルするため送らない。
  # ダイアログのキー受理・Enter submit のためにペインを前面化してから操作する。
  if [[ "$IS_COPILOT" == "1" ]]; then
    herdr_focus_now
    if [[ "$reply_action" == "approve" ]]; then
      herdr_send_keys 1
      exit 0
    fi
    copilot_text="$reply_comment"
    if [[ "$reply_action" == "deny" ]] \
      && { [[ -z "$copilot_text" ]] || [[ "$copilot_text" == "deny" ]] || [[ "$copilot_text" == "拒否" ]]; }; then
      copilot_text="拒否"
    fi
    [[ -n "$copilot_text" ]] || copilot_text="拒否"
    herdr_send_keys 2
    sleep 0.4
    "$HERDR_BIN" pane send-text "$HERDR_TARGET" "$copilot_text"
    sleep "$RELAY_HERDR_SEND_TEXT_WAIT"
    herdr_focus_now
    herdr_send_keys Enter
    exit 0
  fi

  # Codex CLI TUI（実測）は番号選択式（1. Yes(y) / 2. Yes don't ask(p) / 3. No(esc)）。
  # 承認は y の単押し（Escape 前置なし・Enter なし）、拒否は 3 + 任意コメント → Enter。
  # Escape はリクエストごとキャンセルするため送らない。submit のため focus を前置する。
  if [[ "$IS_CODEX" == "1" ]]; then
    herdr_focus_now
    if [[ "$reply_action" == "approve" ]]; then
      herdr_send_keys y
      exit 0
    fi
    herdr_send_keys 3
    codex_comment="$reply_comment"
    if [[ "$reply_action" == "deny" ]] \
      && { [[ "$codex_comment" == "deny" ]] || [[ "$codex_comment" == "拒否" ]]; }; then
      codex_comment=""
    fi
    if [[ -n "$codex_comment" ]]; then
      sleep 0.4
      "$HERDR_BIN" pane send-text "$HERDR_TARGET" "$codex_comment"
      sleep "$RELAY_HERDR_SEND_TEXT_WAIT"
      herdr_focus_now
      herdr_send_keys Enter
    fi
    exit 0
  fi

  # 残りは Claude Code（デフォルト経路）。現行 Claude Code v2.1（実測）は番号選択式:
  #   ❯ 1. Yes / 2. Yes, and always allow … / 3. No（Esc to cancel）
  # 承認 = 1 単押し、拒否 = 3 + 任意コメント → Enter。Escape はキャンセルするため送らない。
  # submit のため focus を前置する。nonblocking 時のみ使用（通常運用は longpoll）。
  herdr_focus_now
  if [[ "$reply_action" == "approve" ]]; then
    herdr_send_keys 1
    exit 0
  fi
  herdr_send_keys 3
  claude_comment="$reply_comment"
  if [[ "$reply_action" == "deny" ]] \
    && { [[ "$claude_comment" == "deny" ]] || [[ "$claude_comment" == "拒否" ]]; }; then
    claude_comment=""
  fi
  if [[ -n "$claude_comment" ]]; then
    sleep 0.4
    "$HERDR_BIN" pane send-text "$HERDR_TARGET" "$claude_comment"
    sleep "$RELAY_HERDR_SEND_TEXT_WAIT"
    herdr_focus_now
    herdr_send_keys Enter
  fi
  exit 0
fi

# 通常の通知への返信: テキスト入力 → Enter
log_agent "herdr target=${HERDR_TARGET} message=${herdr_message:0:50}"
herdr_submit_text "$herdr_message" "$herdr_message_probe"
