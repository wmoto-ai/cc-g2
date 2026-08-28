# cc-g2 — Claude Code / Codex CLI / Copilot CLI を G2 から操作するスマートグラス連携

[English README](./README.md)

<p align="center">
  <img src="./docs/assets/cc-g2-shako-banner.jpg" alt="cc-g2 SHAKO banner" width="900">
</p>

Even G2 と Claude Code / Codex CLI / Copilot CLI をつなぎ、承認・拒否・音声コメント・完了通知確認をグラスから行うためのハンズフリー companion layer です。PC の前にいなくても、iPhone 経由で G2 から agent の permission request に応答できます。

![cc-g2 simulator demo](./docs/screenshots/cc-g2-simulator.gif)

Even G2 で通知を開き、音声で返答し、その内容を Claude Code / Codex CLI / Copilot CLI に返す流れをシミュレーターで確認できます。

## できること

- **承認 / 拒否**: Claude Code / Codex CLI / Copilot CLI の tool permission request に G2 から応答
- **AskUserQuestion への回答**: Claude Code の質問に、G2 の選択肢リストから回答
- **音声コメント**: 拒否時に音声で指示を返す
- **完了通知の確認**: Claude Code / Codex CLI / Copilot CLI の完了通知を G2 で確認
- **通知一覧 / 詳細表示**: G2 で最近の通知を確認
- **画像表示**: Claude Code / Codex CLI から送った画像・スクリーンショットを G2 のレンズに表示（`scripts/g2-send-image.sh`、使い方プロンプトは起動時に両 CLI へ自動注入）
- **音声でセッション起動**: G2 に話しかけて Claude Code / Codex CLI セッションを起動（Even App カスタム AI 連携）

## 対応 CLI

cc-g2 は Claude Code / Codex CLI / Copilot CLI に対応しています。CLI によって使えるフック方式や機能が一部異なります。

| | Claude Code | Codex CLI | Copilot CLI |
|---|---|---|---|
| 起動 | `cc-g2` | `cc-g2 codex` | `cc-g2 copilot` |
| フック方式 | HTTP hook（`--settings`） | command hook（`-c hooks=`） | hooks JSON（`$COPILOT_HOME/hooks/cc-g2.json`） |
| 承認 / 拒否（G2・Telegram） | ✅ | ✅ | ✅ |
| AskUserQuestion 回答 | ✅ | — | — |
| 完了通知 | ✅ | ✅ | ✅ |
| 返信リレー（tmux / herdr キー注入） | ✅ | ✅ | ✅ |
| ローカル決着検知（PostToolUse） | ✅ | ✅（auto_review 含む） | ✅ |
| 音声セッション起動（Voice Entry） | ✅ | ✅ | — |
| BYOK（ローカルモデル） | — | — | ✅（`COPILOT_PROVIDER_*`） |

- **ローカル決着検知**: ターミナルでの手動承認や、codex の `approvals_reviewer=auto_review` による自動承認を PostToolUse フックで検知し、Hub の承認を自動解決します（Telegram のボタンが閉じ、G2 の表示も更新されます）。
- **画像表示**（「できること」参照）は Claude Code / Codex CLI のみ対応です（Copilot CLI にはプロンプト注入の手段がないため）。
- Copilot CLI のローカル決着検知は実装済みですが、実機未検証です。

## 既知の制限

G2 表示制限、リスト操作の挙動、シミュレーターと実機の差異については [docs/known-limitations.md](docs/known-limitations.md) を参照してください。

## 構成

cc-g2 には 2 つのトランスポートモードがあります。

**hub モード**（自宅 / 同一 LAN / Tailscale — 開発・QR 起動・サイドロード向け）:

```text
┌──────────────┐   Tailscale    ┌──────────────┐   BLE    ┌─────────┐
│ PC (Mac)     │ ◄───────────► │ iPhone       │ ◄──────► │ Even G2 │
│ Claude/Codex │               │ Even App     │          │         │
│ Hub (:8787)  │               │ Vite (:5173) │          │         │
│ Voice(:8797) │               │              │          │         │
└──────────────┘               └──────────────┘          └─────────┘
```

**telegram モード**（外出先 / Store 配布版の主経路 — Hub や Tailscale への到達性がなくても動く）:

```text
┌──────────────┐   Bot API    ┌──────────┐  MTProto  ┌──────────────┐   BLE    ┌─────────┐
│ Mac アダプタ  │ ◄─────────► │ Telegram │ ◄───────► │ iPhone       │ ◄──────► │ Even G2 │
│ cc-tg bot    │              │          │ (userbot) │ Even App +   │          │         │
│ Hub 購読      │              │          │           │ cc-g2 WebView│          │         │
└──────────────┘              └──────────┘           └──────────────┘          └─────────┘
```

- **Notification Hub** (`:8787`): 通知と承認の中央管理
- **Vite** (`:5173`): G2 向け Web UI
- **Voice Entry** (`:8797`): 音声セッション起動（オプション）
- **各 CLI のフック**（Claude Code: HTTP hook / Codex CLI: command hook / Copilot CLI: hooks JSON）: PermissionRequest を Hub に送信
- **Telegram アダプタ**: Hub を購読して Telegram に承認 UI・通知・画像を届ける常駐アダプタ → [packages/telegram-adapter](packages/telegram-adapter/README.md)

> ホスト / ポート（Hub・Vite の `0.0.0.0` bind、`:8787` / `:5173` / `:8797`）は環境変数（`HUB_PORT` / `VITE_PORT` / `CC_G2_VOICE_ENTRY_PORT` 等）で上書きできます。

Hub は明示的な permission prompt を中継して応答するためのもので、Claude Code / Codex CLI のユーザー設定や組織ポリシーを上書きして独自に広く許可するものではありません。

### モードの使い分け

| モード | 用途 | 到達性の前提 |
|------|------|------------|
| **hub** | 自宅 / dev、QR 起動、サイドロード | iPhone → Mac（同一 LAN / Tailscale） |
| **telegram** | 外出先、Even Hub Store 配布版の主経路 | Telegram（Hub / Tailscale 不要） |

telegram モードは、Hub や Tailscale への到達性がなくても G2 体験（通知一覧・詳細・承認・音声コメント・画像）を Telegram 経由で成立させます。セットアップは [Telegram adapter README](packages/telegram-adapter/README.md) を参照してください。Telegram の bot チャットは E2E 暗号化ではなく、ミニアプリの Telegram セッションは Even App のローカルストレージに保存されるため、2FA を有効にしたエージェント専用アカウントを推奨します。

## 推奨構成

`cc-g2` は、**tmux + Tailscale + iPhone + Even G2** の構成で使うと安定しやすいです。

- **tmux**: Claude Code / Codex CLI セッションを維持し、reply relay の前提になります
- **Tailscale**: iPhone からローカル Hub へ安全にアクセスしやすくなります。同じ WiFi ならローカル IP でも接続可能ですが、外出先や別ネットワークからの接続には Tailscale が便利です
- **Moshi などの補助通知**: 必須ではありませんが、離席中の通知確認を補助しやすくなります
- **通知運用**: G2 で承認待ちや完了を確認できます

参考: <https://getmoshi.app/articles/mac-remote-endless-agent-setup>

## 前提条件

- **macOS** 推奨
- **Node.js (LTS)** + **pnpm**
- **tmux**
- **jq**
- **Tailscale**（`SHOW_QR=0` で省略可）
- **Claude Code** (`claude` コマンド)
- **Codex CLI** (`codex` コマンド、`cc-g2 --codex` / `cc-g2 codex` 利用時のみ)
- **GitHub Copilot CLI** (`copilot` コマンド、`cc-g2 --copilot` / `cc-g2 copilot` 利用時のみ)

> `cc-g2` は trusted network 前提です。インターネット公開向けではありません。

## クイックスタート

### 1. インストール

GitHub から直接入れる場合:

```bash
pnpm add -g github:wmoto-ai/cc-g2
```

git clone から入れる場合:

```bash
git clone https://github.com/wmoto-ai/cc-g2.git
cd cc-g2
pnpm install
pnpm link --global
```

### 2. 設定

```bash
cd "$(pnpm root -g)/@wmoto-ai/cc-g2"
cp .env.example .env.local
```

git clone から入れた場合は、clone したリポジトリのディレクトリで設定してください。

`.env.local` の主な設定:

| 変数 | 用途 |
|------|------|
| `GROQ_API_KEY` | G2 音声コメント用 STT（Groq、オプション） |
| `OPENAI_API_KEY` | OpenAI Realtime Whisper 用（オプション） |
| `SONIOX_API_KEY` | Soniox リアルタイム STT 用（オプション） |
| `VITE_STT_PROVIDER` | STT エンジン: `groq`（デフォルト、REST バッチ）、`openai-realtime`、または `soniox`（WebSocket ストリーミング） |
| `CC_G2_VOICE_ENTRY_ENABLED=0` | Voice Entry を無効化（デフォルト: 有効） |

`.env.local` を変えたら `cc-g2 !` でインフラを再起動します。tmux セッション外からは `cc-g2 stop && cc-g2` で再起動してください。

### 3. 起動

```bash
cc-g2
```

起動時に以下が自動で行われます。

1. Hub + Vite をバックグラウンド起動
2. Claude Code の hook を注入
3. tmux セッション作成
4. QR コード表示
5. Claude Code 起動

Codex CLI で起動する場合:

```bash
cc-g2 --codex
# または
cc-g2 codex
```

この場合は Codex CLI の hook を注入し、Codex CLI を G2 hook 付きで起動します。

Copilot CLI で起動する場合:

```bash
cc-g2 --copilot
# または
cc-g2 copilot
```

この場合は GitHub Copilot CLI の hook（`$COPILOT_HOME/hooks/cc-g2.json`）を用意し、Copilot CLI を G2 hook 付きで起動します。ローカルモデル（BYOK）を使う場合は `COPILOT_MODEL` / `COPILOT_PROVIDER_*` を環境に設定しておくと、copilot モードの tmux セッションにのみ伝播します。

> **初回起動時の注意**: Copilot CLI はフォルダの trust 確認が TUI に出るので、承認するとフック（G2 承認・通知）が有効になります。Codex CLI も hooks 構成を変更した直後の初回起動で「Hooks need review」の確認が一度出るので、承認してください。

### 4. 最初の確認

- `command -v cc-g2`
- `cc-g2 doctor`
- iPhone の Even App で QR コードを読める
- G2 で待機画面が見える
- ダブルタップで通知一覧が開く

## cc-g2 コマンド

| コマンド | 説明 |
|---------|------|
| `cc-g2` | インフラ起動 + QR 表示 + Claude Code 起動 |
| `cc-g2 new` | 新しい tmux セッションで起動 |
| `cc-g2 --codex` | インフラ起動 + QR 表示 + Codex CLI を G2 hook 付きで起動 |
| `cc-g2 codex` | `cc-g2 --codex` と同じ |
| `cc-g2 --native-codex` | `cc-g2 --codex` の互換エイリアス |
| `cc-g2-codex` | `cc-g2 --codex` のエイリアス |
| `cc-g2 --copilot` | インフラ起動 + QR 表示 + GitHub Copilot CLI を G2 hook 付きで起動 |
| `cc-g2 copilot` | `cc-g2 --copilot` と同じ |
| `cc-g2-copilot` | `cc-g2 --copilot` のエイリアス |
| `cc-g2 !` | インフラ再起動してから起動 |
| `cc-g2 stop` | Hub + Vite を停止 |
| `cc-g2 status` | 起動状況を確認 |
| `cc-g2 doctor` | 依存コマンド・Tailscale・Hub/Vite・node_modules を確認 |
| `cc-g2 -p "プロンプト"` | プロンプト付きで Claude Code を起動 |

環境変数:

- `SHOW_QR=0` — QR コード表示を無効化
- `G2_PROJECT_DIR` — cc-g2 リポジトリのパス
- `HUB_PORT` / `VITE_PORT` — ポート変更
- `CC_G2_ENABLE_STATUSLINE=0` — StatusLine 連携を無効化

Voice Entry 関連:

| 変数 | 説明 |
|------|------|
| `CC_G2_VOICE_ENTRY_ENABLED` | デフォルト有効。`0` で無効化 |
| `CC_G2_REPO_ROOTS` | リポジトリスキャン対象（デフォルト: `~/Repos`） |

StatusLine 連携は既定で有効です。`~/.claude/settings.json` に `statusLine.command` があれば自動継承します。

## G2 の操作方法

### 入力デバイス

- **G2 テンプル**: スワイプ・タップ
- **Even R1 スマートリング**: スワイプ・タップ
- **音声**: コメント送信時に使用

### ジェスチャー

| 操作 | 動作 |
|------|------|
| **上 / 下スワイプ** | リスト移動、ページ送り |
| **シングルタップ** | 選択・決定 |
| **ダブルタップ** | 戻る・キャンセル・録音停止 |

### 通知画面

- **待機画面**: ダブルタップで通知一覧
- **通知一覧**: タップで詳細、ダブルタップで待機画面へ戻る
- **通知詳細**: スワイプでページ送り、ダブルタップで一覧へ戻る
- **アクション画面**: `コメント / 拒否 / 承認 / 戻る` を選択

### 音声コメント

1. アクション画面で **コメント** を選ぶ
2. G2 のマイクに向かって話す
3. **ダブルタップで録音停止**
4. STT 結果を確認して **送信 / 再録 / キャンセル** を選ぶ
5. **スワイプで録音キャンセル** も可能

コメントは Claude Code / Codex CLI に **拒否 + 指示テキスト** として返ります。

### AskUserQuestion への回答

Claude Code が `AskUserQuestion` を出した場合、cc-g2 は通常の通知詳細ではなく、質問画面を G2 に直接表示します。

1. G2 で質問文を確認する
2. スワイプで選択肢を移動する
3. シングルタップで選択する
4. 複数質問の場合は順番に回答する
5. 自由入力したい場合は **その他（音声）** を選び、音声で回答する

選択した回答は Hub 経由で、対応する Claude Code の質問へ回答 payload として返されます。

## 承認の流れ

```text
Claude Code / Codex CLI / Copilot CLI ─ PermissionRequest hook ─► Hub
     │                                                            │
     │                                             通知 / 承認待ちを作成
     │                                                            │
     │◄──────────────── 承認 / 拒否 / コメント ─────────────── G2
```

- **承認**: Claude Code / Codex CLI / Copilot CLI がそのまま実行
- **拒否**: Claude Code / Codex CLI / Copilot CLI が中止
- **コメント**: 拒否 + 指示テキストとして返却
- **Hub 未起動**: agent 側の通常 UI / エラー処理へフォールバック

### 承認モード（nonblocking / longpoll）

既定は **nonblocking** です。フックは即座に応答し、CLI 側のダイアログがそのまま表示されます。G2 / Telegram での決定は tmux / herdr のキー注入で CLI に届き、ローカルとリモートで先に決めた方が優先されます。ターミナルでの手動承認や codex の auto_review でローカル決着した場合は、PostToolUse 検知で Hub の承認が自動解決され、Telegram のボタンが閉じて G2 の表示も更新されます。ターン終了時に未実行のまま残った承認は「実行されず終了」として掃除されます。

`.env.local` に `CC_G2_APPROVAL_MODE=longpoll` を設定すると、旧挙動（フックが決定を待つブロッキング）に戻せます。切り替えには Hub の再起動（`cc-g2 !`）が必要です。

## 音声セッション起動 (Voice Entry)

G2 の「Hey Even」で Claude Code / Codex CLI セッションを音声起動できます。Even App のカスタム AI 機能を使い、発話内容からリポジトリを自動判定してセッションを開始します。発話に `codex` を含めると Codex CLI セッションとして起動します。

### 有効化

Voice Entry はデフォルトで有効です。無効化するには `.env.local` に追加して `cc-g2 !` で再起動:

```
CC_G2_VOICE_ENTRY_ENABLED=0
```

### 起動確認

```bash
cc-g2 status
```

`Voice entry (port 8797): running` と表示されれば OK です。

### Even App の設定

1. Even App → Conversate → カスタム AI エージェント設定を開く
2. **エンドポイント URL**:

   ```
   http://<Tailscale ホスト名 or IP>:8797/v1/chat/completions
   ```

   Tailscale を使っている場合はホスト名を推奨:
   ```bash
   tailscale status --self     # ホスト名を確認
   tailscale ip -4             # IP を確認（ホスト名が使えない場合）
   ```

3. **Bearer トークン**: 初回起動時に自動生成されます。以下で確認（cc-g2 リポジトリ内で実行）:
   ```bash
   cd cc-g2
   cat tmp/voice-entry/voice-entry-token
   ```

### 使い方

「Hey Even, cc-g2 のテスト直して」のように話しかけると:
1. Even App が音声→テキスト変換
2. リポジトリを自動判定して新しいセッションを起動
3. 結果は G2 通知で確認

「さっきの続き」「continue」で直前のセッションへの追加指示も可能です。

### 注意

- リポジトリ候補は `CC_G2_REPO_ROOTS`（デフォルト: `~/Repos`）配下を自動スキャンします。

## シミュレーター

実機がなくても確認できます。

```bash
./scripts/start-simulator.sh
```

- ブラウザでスマホ画面 + G2 画面の simulator が開きます（port 5173）
- `?dev=1` を付けると Developer Tools / Event Log を表示できます
- 必要なら `SIMULATOR_VERSION=...` で simulator version を切り替えられます

## G2 画面ミラー / カメラ重畳ビューア

![G2 ミラー カメラ重畳](./docs/screenshots/g2-mirror-camera-overlay.gif)

G2 に表示中の画面を 576x288 の canvas で近似再現できます（デフォルト無効・opt-in）。

### ページ内ミラー

Even App で開く URL に `?mirror=1` を付けると、コンソールに「G2 Mirror」カードが出ます。

### 別端末から見る（ビューア配信）

1. Even App 側の URL に `?mirrorpub=1` を付ける（または Vite を `VITE_MIRROR_PUBLISH=1` で起動）
2. 同じ LAN / tailnet の端末で `http://<PCのIP>:5173/mirror.html` を開く

ビューアは同一 origin の `/api`（Vite dev proxy → Hub）だけを使うため、Hub のポートを意識する必要はありません。

### カメラ重畳（SNS 共有用スクショ）

カメラ（getUserMedia）は HTTPS が必要なため、tailscale serve でビューアを HTTPS 化します。

```bash
tailscale serve --bg --https=443 http://127.0.0.1:5173
# → https://<machine>.<tailnet>.ts.net/mirror.html を iPhone Safari で開く
```

「カメラ開始」でカメラ映像の上にミラーが `mix-blend-mode: screen` で重なります
（黒が透過し、G2 の緑の表示だけが乗る）。「合成して保存」で 1 枚の PNG として保存できます。

注意:

- ミラーは近似です（実機フォント・リスト選択ハイライト・ファームウェアのスクロールは再現しません）
- 画像転送中はミラーの描画/送信を自動で繰り延べます（実機 Even App の安定性対策）

## 開発

```bash
pnpm hub:watch   # Hub のみ起動（watch）
pnpm dev         # Vite dev server
pnpm test        # 正式テスト
pnpm run test:all
pnpm test:watch
```

### 主なテスト

| ファイル | 内容 |
|---------|------|
| `test/hub-approval-api.test.mjs` | 承認 API フロー |
| `test/hub-hook-endpoint.test.mjs` | HTTP hook エンドポイント |
| `test/even-events.test.ts` | G2 イベント処理 |

### ディレクトリ構成

```text
cc-g2/
├── src/                      # G2 Web UI (TypeScript + Vite)
│   ├── main.ts               #   エントリ（DOM 構築・dashboard・配線）
│   ├── glasses-ui.ts         #   G2 画面 API のファサード
│   ├── app/                  #   アプリ状態 (AppContext)・接続・整形
│   ├── hub/                  #   Hub との SSE 通信
│   ├── g2/                   #   G2 描画基盤 (render-core ※凍結)・テキスト整形・イベント処理
│   │   └── screens/          #   画面別モジュール（通知 / 質問 / 返信 / 画像）
│   ├── mirror/               #   G2 画面ミラー（bridge タップ・canvas 描画・Hub 配信・ビューア）
│   ├── stt/                  #   音声認識 (Groq / OpenAI / Soniox / WebSpeech)
│   ├── image/                #   画像タイル変換パイプライン
│   └── audio/                #   WAV エンコード
├── server/notification-hub/  # Notification Hub（index.mjs + 機能別モジュール）
├── server/voice-entry/       # Voice Entry サーバー
├── scripts/                  # 起動 / hook / simulator 用スクリプト
│   └── lib/                  #   cc-g2.sh の分割ライブラリ（tokens / infra / tmux / agent-launch / doctor）
├── test/                     # テスト
├── .claude/settings.json     # この repo 作業用の設定
└── .env.example              # 環境変数テンプレート
```

## トラブルシューティング

- まず `cc-g2 doctor` で依存関係と Hub / Vite の状態を確認
- 調子が悪いときは `cc-g2 !` でインフラを再起動
- **PC 再起動後は `cc-g2 !` が必要**: Hub や Voice Entry のトークンが不整合になるため、PC 再起動後は必ず `cc-g2 !` で再起動してください
- Approval Dashboard を開く場合は `cat tmp/notification-hub/hub-auth-token` で確認した値を `http://127.0.0.1:8787/ui?token=<token>` の `<token>` に入れて開きます。token 付き URL はブラウザ履歴に残る可能性があるため、秘密として扱ってください
- **Voice entry が起動しない**: `cc-g2 status` で確認。`.env.local` に `CC_G2_VOICE_ENTRY_ENABLED=0` が設定されていないか確認し、`cc-g2 !` で再起動
- **Even App から接続できない**: `cat tmp/voice-entry/voice-entry-token` でトークンを確認。Even App の Bearer トークンと一致しているか、Tailscale で iPhone → Mac に到達できるかも確認
- **設定変更が反映されない**: `cc-g2 !` でインフラを再起動。tmux セッション外からは `cc-g2 stop && cc-g2`
- **Hub の履歴ファイルが肥大化した**: `tmp/notification-hub/*.jsonl` は無期限に追記されます。`cc-g2 stop` してから `node scripts/prune-hub-history.mjs --dry-run` で削減量を確認し、`node scripts/prune-hub-history.mjs`（デフォルト14日保持、実行前に自動バックアップ）で間引けます
- **診断ログを見たい**: URL パラメータ `?logmirror=1`（またはビルド時 `VITE_LOG_MIRROR`）で info レベルのログを画面にミラーできます。**診断用途のみ・常用は禁止**です（ログ量が増え、機密情報を画面に映す可能性があります）

## Acknowledgments

- [Visionote](https://github.com/takashicompany/visionote) — Even Hub SDK を使った G2 への画像表示。画像パイプラインの実装で参考にした
- [EvenAI Anthropic Bridge](https://github.com/jase-perf/evenai-anthropic-bridge) — G2 向け Claude API ブリッジ。Voice Entry（カスタム AI エージェント）の実装で参考にした

## 既知の制限 / 参考リンク

- [docs/known-limitations.md](docs/known-limitations.md)
- <https://getmoshi.app/articles/mac-remote-endless-agent-setup>

## ライセンス

MIT
