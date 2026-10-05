// 単体起動のエントリポイント(tmux 常駐 / pnpm start)。本体は adapter.ts。
import { startTelegramAdapter } from './adapter'
import { errorMessage, redactSecrets } from './logger'

startTelegramAdapter(process.env, { standalone: true }).catch((err) => {
  // ここに来るのは設定不備・token 不正など起動時失敗のみ。念のため token をマスクして出す
  const secrets = [process.env.TELEGRAM_BOT_TOKEN ?? '', process.env.HUB_AUTH_TOKEN ?? '']
  console.error(`fatal: ${redactSecrets(errorMessage(err), secrets)}`)
  process.exit(1)
})
