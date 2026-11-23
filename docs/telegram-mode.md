# Telegram モード仕様書

> 公開向け仕様（Even Hub Store 配布版の主経路）

cc-g2 には 2 つのトランスポートモードがあります。

- **hub モード**: 自宅 / 同一 LAN / Tailscale で、ローカルの Notification Hub に直結する経路（開発・QR 起動・サイドロード向け）
- **telegram モード**: Hub や Tailscale への到達性がなくても、Telegram を輸送路にして G2 体験（通知一覧・詳細・承認・音声コメント・画像）を成立させる外出先向けの経路

このドキュメントは telegram モードの仕様（アーキテクチャ・互換性契約・セットアップ・脅威モデル）を公開向けに明文化したものです。

## 1. アーキテクチャ

telegram モードは 3 つの要素で構成されます。

```text
┌────────────────────┐   Bot API      ┌──────────┐   MTProto/WSS   ┌────────────────────┐
│ Mac 側アダプタ      │ (long-polling) │          │  (userbot)      │ グラス側ミニアプリ  │
│ telegram-adapter    │ ◄────────────► │ Telegram │ ◄─────────────► │ cc-g2 (Even App     │
│ ・アダプタ bot         │                │          │                 │ WebView + GramJS)   │
│ ・Hub (:8787) 購読  │                │          │                 │                    │
└────────────────────┘                └──────────┘                 └────────────────────┘
        ▲
        │ SSE + reconciliation
        ▼
  Notification Hub (cc-g2)
```

- **Mac 側アダプタ**（[packages/telegram-adapter](../packages/telegram-adapter/README.md)）は、ローカルの Notification Hub を購読し、承認・通知・画像を **アダプタ bot** としてチャットに投稿します。Bot API の long-polling で動くため、Hub を外部公開する必要はありません。
- **グラス側ミニアプリ**（cc-g2 の WebView）は、GramJS の **userbot**（あなた自身の Telegram アカウント）として同じチャットを購読し、承認ボタンの押下・返信・画像取得を行います。

**真実の源は アダプタ bot とのチャットそのもの**です。Hub の notification id / approval id をミニアプリが知る必要はなく、ミニアプリはチャット履歴と inline ボタン・reply_to だけで G2 体験を再構成します。この分離により、ミニアプリ側に承認 id の解決や二重決裁防止といった状態を持たずに済みます。

## 2. 安定マーカー行仕様（互換性契約）

アダプタが投稿する各メッセージの種別（Stop 通知 / 汎用通知 / 画像 / 承認 / ステータス）を、ミニアプリは **本文中の安定マーカー行のみ**で判定します（本文を先頭から 1 行ずつ見て、最初に一致したマーカー行を使います。承認の決着後は本文の後ろにフッタが付くため、マーカーが最終行とは限りません。userbot 自身が送ったメッセージは判定の対象外です）。フッタ文言やタイトルの絵文字など、マーカー以外の要素はパース対象にしません。これはメッセージ文面の変更でミニアプリが壊れないための互換性契約です。

| マーカー行 | 種別 |
|---|---|
| `· cc-g2:stop` | Stop（セッション完了）通知。返信するとセッションへ注入される |
| `· cc-g2:generic` | 汎用通知（運用ジョブ等）。返信中継の対象外 |
| `· cc-g2:image` | 画像メッセージ（photo 付き） |
| `· cc-g2:approval` | 承認依頼。inline ボタンで決裁する |
| `· cc-g2:status` | ピン留めステータス（§3）。通知一覧には出さない |

### セッションタグ meta 行（任意・後方互換）

種別マーカー行の**直後**に、任意で**セッションタグ meta 行**が付くことがあります。

```text
· cc-g2:meta sess=<slug>
```

- **用途**: 通知一覧のセッション別絞り込み。ミニアプリは `<slug>` を `NotificationItem.metadata.sessionLabel` に載せます。
- **付与対象**: 承認 / Stop / 画像（cwd かセッションラベルが届いているとき）。汎用通知（`· cc-g2:generic`）とステータス（`· cc-g2:status`）には付きません。
- `<slug>`: セッションラベル（無ければ cwd 末尾の repo 名）を正規化した文字列。空白は `-` に畳み、`[A-Za-z0-9._-]` 以外を除去、最大 24 文字。正規化後に空になる場合は meta 行自体を付けません。
- **後方互換**: meta 行は任意です。meta 行が無い旧メッセージも従来どおり分類・表示され、種別マーカー行の文言・仕様は一切変わりません。meta 行は種別判定（classify）に影響せず、本文（`fullText`）からは除去されます。

### 定義元とテスト

マーカー定数は 2 か所に定義され、相互検証テストで一致が保証されます。

- アダプタ側（投稿する側）: `packages/telegram-adapter/src/telegram/format.ts` の `G2_MARKER` / `G2_META`
- ミニアプリ側（読む側）: `src/transport/telegram/model.ts` の `TG_MARKER` / `TG_META`
- 相互検証: `test/telegram-model.test.ts`

**制約**:

- マーカー行の**文言は変更禁止**です（両定数とテストを同時に更新しない限り互換性が壊れます）。
- ミニアプリは**マーカー以外（フッタ文言・サマリ行）をパースしません**。文面は自由に変えられますが、本文中にマーカー行とまったく同じ 1 行を含めると、そちらが先に一致して誤分類されるため避けてください。
- 承認メッセージも `· cc-g2:approval` マーカーで判定します。decide 後の `editMessageText` で inline keyboard が消えるため、ボタン有無だけでは閉じた承認を判別できないためです（マーカー導入以前に投稿された承認は、callback_data のプレフィックス `apr|` / `dny|` / `cmt|` へのフォールバックで判定します）。

## 3. ステータスペイロード v1

telegram モードでは ctx%（コンテキスト使用率）とセッション状態を、アダプタが**ピン留めメッセージ 1 件**に定期反映します（メッセージ編集は push 通知されないため、通知を汚さずに状態を配れます）。

ピン留めメッセージには人間向けサマリ行と、ミニアプリが機械的に読む **JSON 1 行**が含まれます。

```json
{"v":1,"ts":1720000000,"ctx":[{"sessionId":"…","cwd":"…","usedPercentage":42,"model":"…"}],"activity":[{"tmuxTarget":"…","label":"…","state":"active"}]}
```

- `v`: ペイロードバージョン（現在 `1`）
- `ts`: 生成時刻（unix 秒）
- `ctx`: コンテキスト使用率のセッション配列
- `activity`: セッション状態の配列（`state` は `active` / `waiting` / `done` / `idle` / `error` / `dead`）

### 定義元

- 生成側: `packages/telegram-adapter/src/telegram/format.ts` の `StatusPayload` / `buildStatusPayload` / `formatStatusMessage`
- 解析側: `src/transport/telegram/model.ts` の `parseStatusPayload`

### 運用パラメータ

- **更新間隔**: アダプタの環境変数 `STATUS_INTERVAL_MS`（既定 30 秒 = `30000`）。`0` で無効。有効化する場合は Bot API のレート制限に配慮して `10000`（10 秒）以上が必須。
- **stale 判定**: ミニアプリは `ts` が **5 分より古い**ペイロードを無視します（`src/transport/telegram/transport.ts` の `STATUS_STALE_SEC = 300`）。アダプタ停止中に残ったピンを誤って読まないための保護です。

## 4. 承認・コメント

- **承認 / 拒否**: ミニアプリは inline ボタンの `click`（内部的には `messages.GetBotCallbackAnswer`）で実ボタンを押します。approval id の解決・鮮度チェック・二重決裁防止・ボタン無効化は**すべてアダプタ側**でそのまま効くため、ミニアプリに状態は不要です。
- **コメント / 音声返信**: 対象メッセージに `reply_to` を付けて送信します。承認へのコメントは comment-deny として、Stop 通知への返信はセッションへの注入として、アダプタの既存経路で処理されます。

## 5. セットアップ

1. **api_id / api_hash を取得**: [my.telegram.org](https://my.telegram.org) にログインし、API development tools で application を作成して `api_id` と `api_hash` を控えます。
2. **自分の bot を作成**: Telegram の [@BotFather](https://t.me/BotFather) で bot を新規作成し、bot token を取得します。
3. **アダプタを起動**: Mac 側で [packages/telegram-adapter](../packages/telegram-adapter/README.md) を起動します（bot token・Hub 接続・allowlist を設定）。アダプタが Hub を購読し、アダプタ bot として投稿を始めます。
4. **ミニアプリでログイン**: グラス側 cc-g2 の設定画面で telegram モードを選び、`api_id` / `api_hash` を入力してログイン（電話番号 → コード → 必要なら 2FA パスワード）します。ログイン後、対象チャット（アダプタ bot とのチャット）を指定します。
5. **Soniox API キー（任意）**: 音声コメントを使う場合、設定画面に Soniox のリアルタイム STT キーを入力します（§6 参照）。

モード切替は設定画面のトグルで行い、保存後に画面リロードで反映されます（起動時の優先順位: URL パラメータ > 保存済み設定 > ビルド時デフォルト `VITE_TRANSPORT` > `hub`）。

## 6. 音声（Soniox）

telegram モードでは Hub の STT エンドポイントに到達できないため、音声コメントの文字起こしは **Soniox のリアルタイム STT（WSS 直結）**を使います。設定画面で入力した API キーは端末内に保存され、`wss://stt-rt.soniox.com` へ直接ストリームします。

- キーは**使用量上限（spend cap）を設定した専用キー**の使用を推奨します。
- Soniox キー未設定でも通知・承認は動作します（音声コメントのみ利用不可）。

## 7. 脅威モデル（正直な記載）

telegram モードは、ERGram（GramJS を Even App WebView で動かす先行実装）と同水準のセキュリティ制約を持ちます。**採用にあたっては以下を理解した上で判断してください。**

- **StringSession はアカウント全権限相当の機密**です。ミニアプリはこれを Even App のローカルストレージ（`setLocalStorage`）に**平文で保存**します（ERGram と同じ制約）。端末やストレージが侵害されるとアカウントを乗っ取られ得ます。
- **bot チャットは E2E 暗号化ではありません**。メッセージ本文は Telegram 社に可読で、保持期間の制約は Telegram 社のポリシーに従います。
- 緩和策として、**エージェント専用の Telegram アカウント**（守るべき個人資産を持たないアカウント）を使い、**2FA（クラウドパスワード）を有効化**し、不要になったら設定画面の **Log out & revoke**を実行することを強く推奨します。これは `auth.LogOut` でサーバ側セッションの失効を試みますが、通信障害などで失効に失敗してもローカルのセッションは消去されます。実行後は Telegram の「設定 → デバイス」で、該当セッションが消えていることを確認してください。


## 8. 通信先ドメイン

telegram モードがアクセスするドメイン（`app.json` の network.whitelist で許可）:

- Telegram Web DC 5 系統: `pluto` / `venus` / `aurora` / `vesta` / `flora` の `*.web.telegram.org`（wss + https）
- `stt-rt.soniox.com`（音声 STT、wss + https）
- `my.telegram.org`（api_id / api_hash 取得）
