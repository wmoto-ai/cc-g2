# 既知の制限事項

> **更新日**: 2026-03-19

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
- Claude Code v2.1.77 時点でも未修正（Issue は stale ラベル付きでオープン）

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

---

## 5. SDK テキスト文字数制限はUTF-8バイト基準（確定）

### 症状

通知詳細画面で日本語混じりの長文テキスト（コードポイント数は1000以下）をcreateStartUpPageContainerに渡すと、G2実機でテキストが表示されない、または描画が不安定になる。

ASCII のみのテキスト（1バイト/文字）では同じコードポイント数で正常に表示される。

### 調査結果 (2026-03-19)

SDKドキュメントの公称文字数制限:

| API | 公称上限 |
|-----|---------|
| `createStartUpPageContainer` | 1,000文字 |
| `rebuildPageContainer` | 1,000文字 |
| `textContainerUpgrade` | 2,000文字 |

**実機境界値テストで確定した実際の上限:**

| テスト内容 | CP数 | UTF-8 bytes | 表示結果 |
|-----------|------|------------|---------|
| 日本語「あ」×333 | 333 cp | 999 bytes | **OK** |
| 日本語「あ」×334 | 334 cp | 1,002 bytes | **NG（表示不可）** |
| ASCII「a」×999 | 999 cp | 999 bytes | **OK** |
| ASCII「a」×1000 | 1,000 cp | 1,000 bytes | **NG（表示不可）** |

**結論: `createStartUpPageContainer` の上限は UTF-8 で 999 バイト（< 1,000 バイト）。** SDK の「1,000文字」はコードポイントではなくUTF-8バイト基準であり、かつ境界値は 999（1,000未満）。

even-aozora-reader が `Array.from()` でコードポイント基準2,000文字を `rebuildPageContainer` に渡して動作しているのは、青空文庫テキスト（日本語のみ、3bytes/文字）で2,000cp = 6,000bytesとなるため `textContainerUpgrade`（公称2,000文字 = 実際は ~1,999 UTF-8 bytes?）の範囲内に収まるケースと推測される。

### 現在の対応 (2026-03-19)

`paginateText()` をUTF-8バイト数基準の分割に変更済み（デフォルト maxBytes=999）。実機境界値テストにより SDK 上限が 999 bytes であることを確認し、1000 から 999 に修正。

---

## 6. Edit通知のold_string/new_stringが途中で切れる

### 症状

G2で通知詳細を開いた時、Edit（ファイル編集）の `old_string` と `new_string` が途中までしか表示されない。

### 原因

Notification Hub の PermissionRequest 処理（`server/notification-hub/index.mjs`）で、Edit通知のプレビュー生成時にold/newをそれぞれ **200文字で切り詰めている**。

```js
// server/notification-hub/index.mjs:600-601
const old = (toolInput?.old_string || '').slice(0, 2000)
const new_ = (toolInput?.new_string || '').slice(0, 2000)
```

ファームウェアスクロール以前は130文字/ページで、当時は200文字で十分だったが、スクロール対応に合わせて2000に引き上げ済み。

### 対応済み (2026-03-19)

- [x] `buildToolPreview()` の Edit old/new を `slice(0, 200)` → `slice(0, 2000)` に引き上げ
- [x] Write の content を `slice(0, 300)` → `slice(0, 2000)` に引き上げ
- [x] default（その他ツール）を `slice(0, 300)` → `slice(0, 2000)` に引き上げ
- [x] approval-ui.html のプレビューも `slice(0, 500)` → `slice(0, 2000)` に引き上げ

---

## 7. ghostリストコンテナからの不要イベント発火

### 症状

通知詳細画面（`screen=detail`）で、非表示のghostリストコンテナ（`notif-list`, y=250, h=18, isEventCapture=0）から `eventType=undefined`（CLICKイベント相当）が繰り返し発火する。

```
[event] screen=detail eventType=undefined list={"containerID":3,"containerName":"notif-list"} sys=undefined
```

特にcreateStartUpフォールバック直後に集中して発生する。

### 原因

ghostリストコンテナは `isEventCapture: 0` だが、createStartUpフォールバック後にファームウェアがイベントルーティングを再構成する際、一時的にイベントを受信してしまうと推測される。

### 現在の対応

`main.ts` のdetail画面ハンドラで `normalized.source === 'list'` のイベントを早期returnで無視している。イベント自体は発火するがアプリ動作に影響しない。

### 解決の見込み

SDK/ファームウェアの改善待ち。アプリ側での対応は現状で十分。
