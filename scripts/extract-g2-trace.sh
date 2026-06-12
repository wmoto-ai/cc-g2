#!/usr/bin/env bash
# G2 描画トレース抽出（リファクタ Phase 0: docs/refactor-plan.md）
#
# tmp/notification-hub/client-events.jsonl から G2 の描画系ログ
# （createStartUp / rebuild / 画像タイル / 描画失敗）を時系列で抽出し、
# タイムスタンプ・経過時間など実行ごとに揺れる部分を正規化して出力する。
#
# 使い方:
#   ./scripts/extract-g2-trace.sh > /tmp/trace-before.txt   # リファクタ前に代表フローを実行してから
#   ./scripts/extract-g2-trace.sh > /tmp/trace-after.txt    # リファクタ後に同じフローを実行してから
#   diff /tmp/trace-before.txt /tmp/trace-after.txt
#
# 代表フロー（シミュレーター http://localhost:5173/?autoconnect=1&logmirror=1 で実施）:
#   1. 起動 → 待機画面
#   2. DblTap → 通知一覧 → 通知選択 → 詳細 → ページ送り
#   3. 詳細 → アクション → コメント → 録音 → 停止 → 確認 → キャンセル
#   4. 画像付き通知 → 画像を見る → 戻る（または ?imgopen=latest）
#   5. AskUserQuestion 通知 → 選択肢表示 → 回答
#
# 注意: トレースは Hub に溜まった通知データに依存するため、before/after は
#   同じ Hub データ・同じ操作手順で連続して取得すること。
set -euo pipefail

JSONL="${1:-tmp/notification-hub/client-events.jsonl}"
SINCE="${SINCE:-}" # 例: SINCE=2026-06-10T12:00 で以降のみ抽出

if [[ ! -f "$JSONL" ]]; then
  echo "not found: $JSONL" >&2
  exit 1
fi

jq -r --arg since "$SINCE" '
  select(.source == "web-client")
  | select($since == "" or .createdAt >= $since)
  | select(.message | test("G2 (createStartUp|rebuild|startup描画失敗)|G2画像|G2に|textContainerUpgrade"))
  | .message
' "$JSONL" \
  | sed -E 's/^\[[0-9:]+\] //' \
  | sed -E 's/\([0-9]+ms(, png=[0-9]+B)?\)/(NNms\1)/g' \
  | sed -E 's/total=[0-9]+ms/total=NNms/g' \
  | sed -E 's/[0-9]+\/[0-9]+ [A-Z][a-z]{2} [0-9]{2}:[0-9]{2}/DATE TIME/g' \
  | sed -E 's/\([0-9]+(m|h|d|s)\)/(AGE)/g; s/\(now\)/(AGE)/g'
