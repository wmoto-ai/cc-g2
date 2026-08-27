# telegram-adapter

cc-g2 の Notification Hub (:8787) を購読して Telegram に承認 UI・通知・メディアを届ける常駐アダプタ。

## Phase 1 の機能

- Hub SSE 購読 + 起動時/定期/再接続時の pending reconciliation(取りこぼしゼロ)
- 承認の inline keyboard(Approve / Deny / コメント付き Deny)→ `POST /api/approvals/:id/decide`
- decide 後・別経路決着・期限切れ時のボタン無効化(editMessageText)
- Stop 通知の転送と返信中継(`POST /api/notifications/:id/reply`、source=telegram)
- 画像通知の sendPhoto 転送
- 受信ファイルの中継: Stop 通知への返信として photo / voice / audio / video / video_note /
  document を送ると `~/.local/share/cc-tg-adapter/inbox/` に保存し、ローカルパスを
  「画像を受信/PDFを受信/テキストを受信/音声を受信/動画を受信: <パス>(キャプション: ...)」
  としてそのセッションへ注入。対応形式は画像(JPEG/PNG/GIF/WebP)・PDF・テキスト(txt/md/csv)・
  音声(mp3/m4a/wav/ogg)・動画(mp4/mov/webm)。画像・PDF・テキストはエージェントが Read で
  そのまま閲覧可能、音声・動画は Read 不可のため注入テキストに文字起こしスキル等への誘導を
  添える。Telegram の photo は再圧縮されるため、原本が必要な場合はファイルとして送信
  (Send as File)する。取得サイズは Bot API `getFile` の 20MB 上限(公式 FAQ で確認済みの
  現行仕様)に従う — 20MB 超はローカル Bot API サーバー(self-host、download 無制限)+
  apiRoot 差し替えで将来対応可能
- 平文テキストのフォールバック(reply を付けられないクライアント = Even Hub ミニアプリ
  ERGram 等からの会話用): 非 reply の平文を最新の Stop 通知への返信としてセッションへ
  中継する(TTL 超過・該当なしは従来どおり案内)。**承認の決裁は inline keyboard
  (callback)経路のみ** — テキストから decide は行わない
- `message.from.id` allowlist + chat 固定の fail-closed アクセス制御

## セットアップ(ゼロから)

前提: cc-g2 の Notification Hub が起動していること(リポジトリルートの
`scripts/cc-g2.sh` がエージェント起動時に自動で立てる。Hub 単体の確認は
`curl http://127.0.0.1:8787/api/health`)。コメント返信の中継まで使うには
Hub 側の起動環境に `HUB_REPLY_RELAY_SOURCES=g2,web,telegram` が必要。

1. **bot を作る**: Telegram で [@BotFather](https://t.me/BotFather) に `/newbot` を送り、
   表示された token(`123456789:AAH...` 形式)を控える。
   ⚠️ **1 つの bot token を同時に polling できるのは 1 プロセスだけ**(2 つ目は 409 で落ちる)。
   公式 Claude Code telegram plugin 等が同じ bot を使っている場合は、そちらを止めるか
   このアダプタ用に別 bot を作ること。
   **注意**: 公式 plugin は「インストールされているだけ」で(`--channels` 無しでも)
   新規 Claude セッションごとに polling プロセスを起動し、アダプタを 409 で殺す。
   同じ bot を使うなら `claude plugin disable telegram@claude-plugins-official` が必要
   (実測 2026-07-07)。
2. **自分の user id を調べる**: [@userinfobot](https://t.me/userinfobot) に DM すると
   数値 id(例 `123456789`)が返ってくる。
3. **依存を入れる**: ワークスペースルート(このリポジトリのルート)で `pnpm install`。
4. **設定を書く**: `cp env.example .env` して token と user id を埋める(`chmod 600 .env`)。
   各項目の説明は env.example のコメント参照。
5. **起動**: 下記の「本番常駐」スクリプトを推奨。フォアグラウンドで試すなら
   `pnpm start:env`(`.env` を `node --env-file` で読んで起動)。
   `pnpm start` は環境変数を読まない素の起動(op run 等と組み合わせる用)。

1Password で secret を管理している場合は、.env に op:// 参照を書いて
`op run --env-file=.env -- pnpm start`(サービスアカウント運用なら `op-sa run`)でもよい。

### 本番常駐(独立 tmux セッション)

エージェントセッションやシェルの寿命に紐づかない常駐は専用スクリプトで:

```bash
scripts/start-prod.sh                  # tmux セッション cc-tg-adapter として起動
tmux attach -t cc-tg-adapter           # ログを見る(detach は C-b d)
tail -f ~/.local/share/cc-tg-adapter/adapter.log   # ファイルでも追える
tmux kill-session -t cc-tg-adapter     # 停止
```

```bash
# 例: user id を指定して常駐起動
TELEGRAM_ALLOWED_USER_IDS=123456789 scripts/start-prod.sh
```

token は実行時にのみ読み込む(bot token は `.env` を `node --env-file` で、
Hub token は hub-auth-token ファイルを tmux 内シェルで cat 展開)。
既定の bot env は `packages/telegram-adapter/.env`。公式 telegram plugin の env を
流用する場合は `CC_TG_BOT_ENV_FILE=~/.claude/channels/telegram/.env` を指定。
接続先・token ファイル・ログ等は `CC_TG_*` / `HUB_BASE_URL` 環境変数で上書き可能
(既定値はスクリプト冒頭参照)。

**注意**: Hub の認証トークン(`HUB_AUTH_TOKEN`)の実体は「**Hub を起動した
チェックアウトの `tmp/notification-hub/hub-auth-token`**」に自動生成されるファイル。
既定はこのリポジトリのルートを見るが、Hub を別チェックアウト(worktree 等)から
起動した場合は `CC_TG_HUB_TOKEN_FILE` を追従させること(ずれると **401 で承認機能が
沈黙する** — エラーにならず Telegram に何も届かなくなるので気づきにくい)。

## 開発

```bash
pnpm test                 # vitest(fixture Hub + grammY スタブ、ネットワーク不要)
pnpm typecheck            # tsc --noEmit
scripts/smoke-hub.sh      # 検証用 Hub への手動スモーク
```

本番 Hub 側には `HUB_REPLY_RELAY_SOURCES=g2,web,telegram` の設定が必要です。

## 実機投入時の注意: 通知が鳴らないと承認に気づけない

本番切り分け(2026-07-07)での実例: 配信は完全に成功していた(Telegram API が message_id を
返却・サーバ上に実在)のに、**端末の通知が鳴らず承認に気づけなかった**。G2 は視界に入るため
気づけるが、Telegram はスマホがサイレントだと承認が放置され、そのまま期限切れ
(hook 600 秒タイムアウト)になる。投入前に以下を確認すること:

- **bot チャットのミュート解除**(チャット個別のミュート・アーカイブ・通知例外を確認)
- **push 通知を確実に出す送り方を守る**: Telegram は `editMessageText` では push 通知を出さない。
  ユーザーに気づかせたいイベント(承認依頼・完了報告)は必ず**新規メッセージ**で送る
  (現実装は承認投稿 = 新規 sendMessage なので push が出る。ボタン無効化のフッタ追記は
  edit なので通知されない — これは意図どおり)
- 端末側の**通知音・バナー設定**(OS の集中モード/おやすみモード含む)と、
  必要なら ack 用リアクションや通知音カスタマイズの導入を検討
