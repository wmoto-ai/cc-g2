# 既知の制限事項

> **更新日**: 2026-03-03

---

## 1. リストスクロール方向の反転

### 症状

G2 実機でリスト画面（通知一覧、アクションメニュー、返信確認）をスワイプすると、物理操作と逆方向にカーソルが移動する。

- 下スワイプ → カーソルが上に移動
- 上スワイプ → カーソルが下に移動

シミュレーターでは正常方向で動作するため、実機でのみ発生する。

### 原因

G2 ファームウェアが ListContainer のハイライト移動を**ネイティブ処理**しており、ソフトウェア側からオーバーライドできない。

SDK (`@evenrealities/even_hub_sdk`) の `ListContainerProperty` には `scrollDirection` 等の制御パラメータが存在しない。

イベントの対応関係:
- `SCROLL_TOP_EVENT (1)` — 物理的な**下**スワイプで発火
- `SCROLL_BOTTOM_EVENT (2)` — 物理的な**上**スワイプで発火

### 過去の調査・検証 (2026-02-24, even-g2-poc)

1. **テキストカーソル方式（疑似リスト）の検証**: ListContainer を TextContainer に置き換え、`>` マーカーで選択状態を表現する方式を実装・テスト → **実機で動作不安定のためロールバック**

2. **発見された制約**:
   - `SCROLL_TOP_EVENT`/`SCROLL_BOTTOM_EVENT` は**境界到達時のみ**発火し、個々のスクロールでは発火しない → 疑似リストでの方向制御が不可能
   - リストコンテナが存在するとスクロール処理を乗っ取り、テキストコンテナのスクロールイベントを阻害する
   - `currentSelectItemIndex` が index=0 の場合に省略される SDK バグあり
   - プログラムからスクロール位置を制御する API は存在しない

3. **外部の確認情報**:
   - `pong-even-g2` README: "Swipe directions are inverted"
   - `nickustinov/even-g2-notes/G2.md`: SDK の既知問題として記載

### 現在の対応

ファームウェア仕様として許容し、安定動作を優先。

- 通知一覧・アクションメニュー: SDK 標準 ListContainer をそのまま使用（方向反転は許容）
- 通知詳細ページ送り: TextContainer のイベントマッピングで正しい方向に対応済み

### 解決の見込み

Even Realities が SDK/ファームウェアをアップデートし、`ListContainerProperty` にスクロール方向の設定パラメータを追加するか、ファームウェア側で方向を修正する必要がある。アプリ側での対応は不可能。

---

## 2. rebuildPageContainer の常時失敗

### 症状

`rebuildPageContainer()` が G2 実機で常に `false` を返す。

### 影響

画面遷移のたびに `createStartUpPageContainer()` にフォールバックするため、1回の画面更新に約3秒かかる。この間のユーザー操作イベントは破棄される。

### 重要な注意点

`rebuildPageContainer()` は戻り値が `false` でも**呼び出し自体にハードウェアのイベントルーティング登録の副作用**がある。スキップするとイベントが受信できなくなる（`textEvent`/`listEvent` が `undefined` になる）。

### 現在の対応

rebuild を毎回呼び出し、失敗後に createStartUp にフォールバックする方式で安定動作。

---

## 3. シミュレーターと実機の挙動差異

| 挙動 | シミュレーター | G2 実機 |
|------|---------------|---------|
| スクロール方向 | 正常 | 反転 |
| rebuildPageContainer | 成功する場合あり | 常に失敗 |
| ダブルタップイベント | `textEvent`/`listEvent` あり | `undefined` の場合あり |
| 描画速度 | 即座 | rebuild + createStartUp で約3秒 |

シミュレーターでの動作確認は参考程度とし、実機での検証を優先すること。

---

## 4. バックグラウンドサブエージェントの権限ダイアログがPCターミナルに表示されない

### 症状

Claude Code がバックグラウンドサブエージェント（`run_in_background=true`）を起動した場合、サブエージェントのツール実行に必要な権限ダイアログが PC のターミナルに表示されない。

- G2 には PermissionRequest フック経由で承認依頼が正常に届く
- PC のターミナルにはダイアログが表示されず、G2 からしか承認できない

フォアグラウンドサブエージェント（`run_in_background=false`）の場合は、PC ターミナルにもダイアログが表示され、PC・G2 の両方から承認可能。

### 原因

Claude Code v2.1.47 で導入された回帰バグ（[GitHub Issue #26851](https://github.com/anthropics/claude-code/issues/26851)）。

- PermissionRequest フックのパイプラインはバックグラウンドサブエージェントでも正常に実行される（G2 への通知は届く）
- しかしターミナル UI の権限ダイアログ描画がバックグラウンドサブエージェントでは行われない
- Claude Code v2.1.63 時点でも未修正

関連 Issue:
- [#26851](https://github.com/anthropics/claude-code/issues/26851): Background subagents no longer surface permission prompts (v2.1.47 regression)
- [#23983](https://github.com/anthropics/claude-code/issues/23983): PermissionRequest hooks not triggered for subagent permission requests
- [#18885](https://github.com/anthropics/claude-code/issues/18885): Allow subagents to forward permission requests to foreground

### 現在の対応

cc-g2 の PermissionRequest HTTP フックが機能するため、G2 からの承認で運用可能。PC からも承認したい場合は Hub の Web UI（`http://127.0.0.1:8787/ui`）を使用できる。

補足:
- Claude Code 側の `allow` / `deny` / managed policy を優先する設計を前提とする
- cc-g2 側は PermissionRequest の通知と承認 UI を提供するだけで、独自に広く許可を追加しない
- セッション終了や stale レコードの掃除は `approve` 扱いではなく cleanup として記録する

### 回避策

- フォアグラウンドサブエージェントを使う（PC・G2 両方で承認可能）
- Hub の Approval Dashboard（Web UI）をブラウザで開いておく
- サブエージェントが使うツールを `permissions.allow` で事前許可する

### 解決の見込み

Claude Code 側のバグ修正待ち。Anthropic が Issue #26851 を修正すれば、バックグラウンドサブエージェントでもターミナルに権限ダイアログが表示されるようになる見込み。
