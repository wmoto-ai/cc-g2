# cc-g2 — Claude Code / Codex CLI を G2 から操作するスマートグラス連携

[English README](./README.md)

Even G2 と Claude Code / Codex CLI をつなぎ、承認・拒否・音声コメント・完了通知確認をグラスから行うためのハンズフリー companion layer です。PC の前にいなくても、iPhone 経由で G2 から agent の permission request に応答できます。

![cc-g2 simulator demo](./docs/screenshots/cc-g2-simulator.gif)

Even G2 で通知を開き、音声で返答し、その内容を Claude Code や Codex CLI に返す流れをシミュレーターで確認できます。

## できること

- **承認 / 拒否**: Claude Code / Codex CLI の tool permission request に G2 から応答
- **AskUserQuestion への回答**: Claude Code の質問に、G2 の選択肢リストから回答
- **音声コメント**: 拒否時に音声で指示を返す
- **完了通知の確認**: Claude Code / Codex CLI の完了通知を G2 で確認
- **通知一覧 / 詳細表示**: G2 で最近の通知を確認
- **音声でセッション起動**: G2 に話しかけて Claude Code / Codex CLI セッションを起動（Even App カスタム AI 連携）

## 現在の制限

- **AskUserQuestion 対応は G2 向けの簡易 UI です**: 質問と選択肢を G2 に表示し、複数質問も順番に回答できます。**その他（音声）** から自由入力の回答も送れます。ただし、長い質問文や選択肢が多い場合は G2 の表示制限により PC 側での確認が必要になることがあります。
- **通知は主に完了通知と承認関連を想定**: README では、現時点で確認しやすいフローを中心に案内しています。
- **実機のリスト操作には既知挙動があります**: 一部のリスト画面では、実機でスクロール方向が物理感覚と逆に見えることがあります。詳細は [docs/known-limitations.md](docs/known-limitations.md) を参照してください。
- **シミュレーターと実機は挙動が異なります**: 最終確認は実機を優先してください。

## 構成

```text
┌──────────────┐   Tailscale    ┌──────────────┐   BLE    ┌─────────┐
│ PC (Mac)     │ ◄───────────► │ iPhone       │ ◄──────► │ Even G2 │
│ Claude/Codex │               │ Even App     │          │         │
│ Hub (:8787)  │               │ Vite (:5173) │          │         │
│ Voice(:8797) │               │              │          │         │
└──────────────┘               └──────────────┘          └─────────┘
```

- **Notification Hub** (`:8787`): 通知と承認の中央管理
- **Vite** (`:5173`): G2 向け Web UI
- **Voice Entry** (`:8797`): 音声セッション起動（オプション）
- **Claude Code HTTP hook / Codex command hook**: PermissionRequest を Hub に送信

Hub は明示的な permission prompt を中継して応答するためのもので、Claude Code / Codex CLI のユーザー設定や組織ポリシーを上書きして独自に広く許可するものではありません。

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
Claude Code / Codex CLI ─ PermissionRequest hook ─► Hub
     │                                              │
     │                                   通知 / 承認待ちを作成
     │                                              │
     │◄──────────── 承認 / 拒否 / コメント ─────── G2
```

- **承認**: Claude Code / Codex CLI がそのまま実行
- **拒否**: Claude Code / Codex CLI が中止
- **コメント**: 拒否 + 指示テキストとして返却
- **Hub 未起動**: agent 側の通常 UI / エラー処理へフォールバック

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

「Hey Even, cc-g2 private のテスト直して」のように話しかけると:
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
├── server/notification-hub/  # Notification Hub
├── server/voice-entry/       # Voice Entry サーバー
├── scripts/                  # 起動 / hook / simulator 用スクリプト
├── test/                     # テスト
├── .claude/settings.json     # この repo 作業用の設定
└── .env.example              # 環境変数テンプレート
```

## トラブルシューティング

- まず `cc-g2 doctor` で依存関係と Hub / Vite の状態を確認
- 調子が悪いときは `cc-g2 !` でインフラを再起動
- **PC 再起動後は `cc-g2 !` が必要**: Hub や Voice Entry のトークンが不整合になるため、PC 再起動後は必ず `cc-g2 !` で再起動してください
- Approval Dashboard を開く場合は `TOKEN=$(cat tmp/notification-hub/hub-auth-token)` の後に `http://127.0.0.1:8787/ui?token=${TOKEN}` を使います
- **Voice entry が起動しない**: `cc-g2 status` で確認。`.env.local` に `CC_G2_VOICE_ENTRY_ENABLED=0` が設定されていないか確認し、`cc-g2 !` で再起動
- **Even App から接続できない**: `cat tmp/voice-entry/voice-entry-token` でトークンを確認。Even App の Bearer トークンと一致しているか、Tailscale で iPhone → Mac に到達できるかも確認
- **設定変更が反映されない**: `cc-g2 !` でインフラを再起動。tmux セッション外からは `cc-g2 stop && cc-g2`

## 既知の制限 / 参考リンク

- [docs/known-limitations.md](docs/known-limitations.md)
- <https://getmoshi.app/articles/mac-remote-endless-agent-setup>

## ライセンス

MIT
