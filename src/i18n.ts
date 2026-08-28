/**
 * 最小 i18n(ja / en)。重い依存を避けたフラット辞書 + 同期 t()。
 *
 * ロケールは main.ts が起動時に initI18n(locale) で確定する(top-level await で
 * app-settings をロード済みのため同期でよい)。以後 t()/tp() は同期で辞書を引く。
 * 既定は 'ja'(initI18n 前や単体テストは日本語のまま)なので、ja 値は必ず原文と
 * バイト一致させること(G2 payload のスナップショットテストがこれに依存する)。
 *
 * 注意: このモジュールはアプリ内 import を持たない(循環回避のため独立)。
 */

export type Locale = 'ja' | 'en'

/** モジュールレベルでは 'ja'。initI18n で上書きする(既定 = 原文維持) */
let currentLocale: Locale = 'ja'

/** 設定の locale('' = 自動)と navigator.language から表示ロケールを決める */
export function detectLocale(settingLocale: string, navigatorLanguage: string | undefined): Locale {
  if (settingLocale === 'ja' || settingLocale === 'en') return settingLocale
  return (navigatorLanguage ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/** 起動時に一度だけ呼ぶ。以後の t()/tp() はこのロケールで引く */
export function initI18n(settingLocale: string): void {
  currentLocale = detectLocale(settingLocale, globalThis.navigator?.language)
}

export function getLocale(): Locale {
  return currentLocale
}

/** テスト専用: ロケールを直接固定する */
export function setLocale(locale: Locale): void {
  currentLocale = locale
}

/** toLocaleTimeString 等に渡す BCP-47 タグ */
export function localeTag(): string {
  return currentLocale === 'ja' ? 'ja-JP' : 'en-US'
}

type Entry = { ja: string; en: string }

const dict = {
  // --- スマホ側 UI: ヒーロー / ステータス ---
  hero_copy: {
    ja: 'G2 で通知を見て、承認・拒否・音声コメントを返すための companion console。',
    en: 'Companion console to view notifications on G2 and reply with approve, deny, or voice.',
  },
  status_disconnected: { ja: '未接続', en: 'Disconnected' },
  status_unverified: { ja: '未確認', en: 'Unverified' },
  status_connecting: { ja: '接続中...', en: 'Connecting...' },
  status_connect_failed: { ja: '接続失敗', en: 'Connection failed' },
  status_connected_bridge: { ja: '接続済み (Bridge)', en: 'Connected (Bridge)' },
  status_connected_mock: { ja: '接続済み (Mock)', en: 'Connected (Mock)' },
  last_updated: { ja: '最終更新', en: 'Last updated' },
  notif_count: { ja: '{n}件', en: '{n} items' },

  // --- 接続モードカード ---
  transport_card_title: { ja: '接続モード', en: 'Connection Mode' },
  transport_card_copy: {
    ja: 'Hub(自宅/Tailscale 経由)と Telegram(外出先、通知アダプタの bot 経由)を切り替えます。保存すると再読み込みして反映します。',
    en: 'Switch between Hub (home, via Tailscale) and Telegram (on the go, via the notification adapter bot). Saving reloads to apply.',
  },
  transport_hub_label: { ja: 'Hub(ローカル / Tailscale)', en: 'Hub (local / Tailscale)' },
  hub_store_note: {
    ja: '注: Hub モードは開発/サイドロード向けです。Store 配布版は network whitelist の制約でローカル Hub に接続できません。',
    en: 'Note: Hub mode is for development/sideload. The store build cannot reach a local hub due to the network whitelist.',
  },
  hub_url_placeholder: { ja: 'Hub URL(例: http://100.64.0.1:8787)', en: 'Hub URL (e.g. http://100.64.0.1:8787)' },
  hub_token_placeholder: { ja: 'Hub トークン(任意)', en: 'Hub token (optional)' },
  save_and_reload: { ja: '保存して再読み込み', en: 'Save & reload' },
  language_label: { ja: '言語', en: 'Language' },
  language_auto: { ja: '自動', en: 'Auto' },

  // --- Telegram 接続設定カード ---
  tg_card_title: { ja: 'Telegram 接続設定', en: 'Telegram Connection' },
  tg_card_copy: {
    ja: 'Telegram モード: Hub/Tailscale なしで通知アダプタ(telegram-adapter)の bot チャット経由で動作します。',
    en: 'Telegram mode: works without Hub/Tailscale, via the notification adapter (telegram-adapter) bot chat.',
  },
  tg_status_init: { ja: '初期化中...', en: 'Initializing...' },
  tg_chat_placeholder: { ja: 'bot チャット (@bot名 or 数値ID)', en: 'bot chat (@botname or numeric ID)' },
  tg_soniox_placeholder: { ja: 'Soniox API キー (音声用・任意)', en: 'Soniox API key (voice, optional)' },
  tg_save_settings: { ja: '設定を保存', en: 'Save settings' },
  tg_phone_placeholder: { ja: '電話番号 (+81...)', en: 'Phone number (+81...)' },
  tg_login_start: { ja: 'ログイン開始', en: 'Start login' },
  tg_code_placeholder: { ja: 'Telegram に届いたコード', en: 'Code sent via Telegram' },
  tg_code_send: { ja: 'コード送信', en: 'Send code' },
  tg_password_placeholder: { ja: '2FA パスワード', en: '2FA password' },
  send: { ja: '送信', en: 'Send' },
  tg_connected: { ja: '✅ 接続済み', en: '✅ Connected' },
  tg_connecting: { ja: '接続中...', en: 'Connecting...' },
  tg_need_login: { ja: 'ログインが必要です', en: 'Login required' },
  tg_error: { ja: 'エラー', en: 'Error' },
  tg_enter_code: { ja: 'Telegram に届いたログインコードを入力してください', en: 'Enter the login code sent via Telegram' },
  tg_enter_2fa: { ja: '2FA パスワードを入力してください', en: 'Enter your 2FA password' },
  tg_login_error: { ja: 'ログインエラー', en: 'Login error' },
  tg_login_failed: { ja: 'ログイン失敗', en: 'Login failed' },
  // boot.ts(G2 送信失敗として表示される案内)
  tg_not_ready: { ja: 'Telegram 未接続です(設定パネルからログインしてください)', en: 'Telegram not connected (log in from the settings panel)' },
  tg_session_invalid: { ja: 'セッションが無効です。再ログインしてください', en: 'Session invalid. Please log in again.' },
  tg_need_api: { ja: 'API ID / API Hash を先に保存してください', en: 'Save API ID / API Hash first' },

  // --- Recent Notifications カード ---
  recent_copy: { ja: '最新 5 件。スマホ側では状態確認、主操作は G2 側で行います。', en: 'Latest 5. Check status on the phone; do the main actions on G2.' },
  notif_not_fetched: { ja: '未取得', en: 'Not fetched' },
  notif_fetching: { ja: '取得中...', en: 'Fetching...' },
  notif_fetched: { ja: '{n}件取得', en: 'Fetched {n}' },
  notif_fetch_failed: { ja: '取得失敗', en: 'Fetch failed' },
  notif_empty_list: { ja: '通知はまだありません。', en: 'No notifications yet.' },

  // --- Developer Tools ---
  dev_text_test_title: { ja: 'テキスト表示テスト', en: 'Text display test' },
  dev_display_placeholder: { ja: 'G2に表示するテキスト', en: 'Text to show on G2' },
  dev_send_to_g2: { ja: 'G2に送信', en: 'Send to G2' },
  dev_approval_test_title: { ja: '承認UIテスト', en: 'Approval UI test' },
  dev_approval_copy: { ja: 'G2上にリスト表示して承認/拒否を試す', en: 'Show a list on G2 to try approve/deny' },
  dev_send_approval: { ja: '承認リクエスト送信', en: 'Send approval request' },
  dev_not_run: { ja: '未実行', en: 'Not run' },
  dev_mic_test_title: { ja: 'マイクテスト', en: 'Mic test' },
  dev_rec_start: { ja: '録音開始', en: 'Start recording' },
  dev_rec_stop: { ja: '録音停止', en: 'Stop recording' },
  dev_approval_waiting: { ja: '承認待ち...', en: 'Awaiting approval...' },
  dev_result: { ja: '結果', en: 'Result' },
  dev_approval_title: { ja: 'ファイル編集の承認', en: 'Approve file edit' },
  dev_approval_detail: { ja: 'src/auth.ts +12行/-3行', en: 'src/auth.ts +12/-3 lines' },
  debug_ui_copy: {
    ja: 'Developer Tools と Event Log は <code>?dev=1</code> を付けると表示されます。',
    en: 'Developer Tools and Event Log appear when you add <code>?dev=1</code>.',
  },

  // --- マイク / STT ステータス(dev) ---
  mic_waiting: { ja: '待機中', en: 'Idle' },
  mic_recording: { ja: '録音中...', en: 'Recording...' },
  mic_rec_base: { ja: 'マイク録音中...', en: 'Recording...' },
  mic_rec_done: { ja: '録音完了', en: 'Recording done' },
  unit_chunks: { ja: 'チャンク', en: 'chunks' },
  unit_bytes: { ja: 'バイト', en: 'bytes' },
  stt_processing: { ja: 'STT処理中...', en: 'STT processing...' },
  stt_done: { ja: 'STT完了', en: 'STT done' },
  stt_failed: { ja: 'STT失敗', en: 'STT failed' },
  stt_failed_retry: { ja: 'STT失敗\n再試行してください', en: 'STT failed\nPlease retry' },
  rt_stt_failed: { ja: 'Realtime STT開始失敗', en: 'Realtime STT start failed' },

  // --- format.ts 相対時刻 / 返信結果 ---
  rel_none: { ja: 'まだありません', en: 'None yet' },
  rel_now: { ja: 'たった今', en: 'Just now' },
  rel_sec: { ja: '{n}秒前', en: '{n}s ago' },
  rel_min: { ja: '{n}分前', en: '{n}m ago' },
  approval_invalid: { ja: 'この承認は既に無効です', en: 'This approval is no longer valid' },
  approval_link_missing: { ja: '承認リンクが見つかりません', en: 'Approval link not found' },

  // --- notif-info パネル(スマホ側の G2 状態ミラー) ---
  panel_auto_open: { ja: '新着自動表示', en: 'Auto-open new' },
  panel_idle_hint: { ja: '待機中（G2でダブルタップすると通知一覧）', en: 'Idle (double-tap G2 for the list)' },
  label_detail: { ja: '詳細', en: 'Detail' },
  label_actions: { ja: '操作', en: 'Actions' },
  label_image: { ja: '画像', en: 'Image' },
  label_question: { ja: '質問', en: 'Question' },
  label_question_detail: { ja: '質問詳細', en: 'Question detail' },
  panel_detail_ops: { ja: '操作: FW自動スクロール, 境界到達→チャンク切替, DblClick=戻る', en: 'Ops: FW auto-scroll, boundary→next chunk, DblClick=Back' },
  panel_reply_hint: { ja: ' | Click=操作メニュー', en: ' | Click=Action menu' },
  panel_select_back_detail: { ja: 'Click=選択, DblClick=詳細に戻る', en: 'Click=Select, DblClick=Back to detail' },
  panel_image_back: { ja: 'DblClick=操作メニューに戻る', en: 'DblClick=Back to actions' },
  panel_askq_detail_hint: { ja: 'Scroll=ページ送り, 最終→選択肢, DblClick=戻る', en: 'Scroll=Page, last→Options, DblClick=Back' },
  panel_select_back: { ja: 'Click=選択, DblClick=戻る', en: 'Click=Select, DblClick=Back' },
  panel_reply_recording: { ja: '[返信録音中] {bytes} bytes\nDblClick=停止, Swipe=キャンセル', en: '[Recording reply] {bytes} bytes\nDblClick=Stop, Swipe=Cancel' },
  panel_reply_confirm: { ja: '[返信確認]', en: '[Reply confirm]' },
  panel_reply_confirm_hint: { ja: 'Scroll=ページ送り, 最終→操作, DblClick=戻る', en: 'Scroll=Page, last→Actions, DblClick=Back' },
  panel_reply_confirm_actions: { ja: '[返信確認 操作]\n0=送信, 1=再録, 2=キャンセル, 3=本文', en: '[Reply confirm actions]\n0=Send, 1=Re-record, 2=Cancel, 3=Body' },
  panel_reply_sending: { ja: '[返信送信中...]', en: '[Sending reply...]' },

  // --- G2 画面: 待機 / 通知 / 操作 ---
  g2_idle: { ja: '待機中\n\nDblTap = 通知一覧', en: 'Idle\n\nDblTap = List' },
  notif_none: { ja: '通知なし', en: 'No notifications' },
  notif_word: { ja: '通知', en: 'Notif' },
  select_action: { ja: '操作を選択', en: 'Select action' },

  // --- G2 画面: セッション別一覧 ---
  sess_entry: { ja: '▸ セッション', en: '▸ Sessions' },
  sess_header: { ja: 'セッション', en: 'Sessions' },
  sess_all: { ja: 'すべて', en: 'All' },
  sess_filter_header: { ja: '▸{label}', en: '▸{label}' },
  act_comment: { ja: 'コメント', en: 'Comment' },
  act_view_image: { ja: '画像を見る', en: 'View image' },
  act_back: { ja: '◀ 戻る', en: '◀ Back' },

  // --- G2 画面: AskUserQuestion ---
  askq_options_divider: { ja: '--- 選択肢 ---', en: '--- Options ---' },
  askq_other_voice: { ja: 'その他（音声）', en: 'Other (voice)' },

  // --- G2 画面: 返信フロー ---
  reply_header: { ja: '音声返信', en: 'Voice reply' },
  reply_recording_body: { ja: '録音中...\n\nDblClick = 停止\nSwipe = キャンセル', en: 'Recording...\n\nDblClick = Stop\nSwipe = Cancel' },
  reply_confirm_header: { ja: '返信内容 OK?', en: 'Reply OK?' },
  reply_send: { ja: '送信', en: 'Send' },
  reply_rerecord: { ja: '再録', en: 'Re-record' },
  reply_cancel: { ja: 'キャンセル', en: 'Cancel' },
  reply_body: { ja: '◀ 本文', en: '◀ Body' },
  reply_done: { ja: '返信完了', en: 'Reply sent' },
  reply_failed: { ja: '返信失敗', en: 'Reply failed' },
  send_done: { ja: '送信完了', en: 'Sent' },
  send_failed: { ja: '送信失敗', en: 'Send failed' },
  reply_content_title: { ja: '返信内容', en: 'Reply' },
  reply_confirm_scroll_hint: { ja: '送信・再録は最後までスクロール', en: 'Scroll to end for Send/Re-record' },
  answer_label: { ja: '回答: {label}', en: 'Answer: {label}' },

  // --- G2 画面: 画像 ---
  img_transferring: { ja: '\n\n\n\n　　　　　　　　画像を転送中...\n　　　　　　　　(完了まで操作しないでください)', en: '\n\n\n\n        Transferring image...\n        (Please wait until done)' },
  img_transfer_failed: { ja: '画像転送に失敗しました\nダブルタップで戻る', en: 'Image transfer failed\nDouble-tap to go back' },

  // --- 通知バッジ / 本文プレースホルダ ---
  badge_new: { ja: '[●新着]', en: '[●New]' },
  body_none: { ja: '（本文なし）', en: '(no text)' },
  stt_no_result: { ja: '（認識結果なし）', en: '(no speech recognized)' },
} satisfies Record<string, Entry>

export type I18nKey = keyof typeof dict

/** 現在ロケールの文言を返す(未知キーはキー名を返す = 早期に気づける) */
export function t(key: I18nKey): string {
  const entry = dict[key]
  return entry ? entry[currentLocale] : key
}

/** {name} プレースホルダを params で差し替える(語順は ja/en で自由) */
export function tp(key: I18nKey, params: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
}
