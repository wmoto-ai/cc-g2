// 受信ファイル(photo / voice / audio / 対応 MIME の document)→ inbox 保存 → reply relay 注入の統合テスト。
// Telegram API は transformer スタブ、file download は fetchFn スタブ、Hub は fixture サーバ。
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_ID, createHarness, OTHER_USER_ID, USER_ID, type Harness } from '../fixtures/harness'
import { waitFor } from '../fixtures/util'

let h: Harness | undefined

afterEach(async () => {
  await h?.close()
  h = undefined
})

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09])
const PDF = Buffer.from('%PDF-1.7\n%テスト\n', 'utf8')
const MARKDOWN = Buffer.from('# レビュー結果\n- 指摘1\n- 指摘2\n', 'utf8')
const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00])
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00])
// ftyp box: size 0x14 + 'ftyp' + major 'isom' + minor + compatible 'isom'
const MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d,
])

/** inbox の中身(未作成 = 何も保存されていなければ空) */
async function listInbox(harness: Harness): Promise<string[]> {
  return readdir(harness.inboxDir).catch(() => [])
}

/** Stop 通知を投稿し、その message_id を返す(relay allowlist に telegram を含めた状態で) */
async function postStopNotification(harness: Harness): Promise<number> {
  await harness.startSse()
  harness.hub.setRelay({ enabled: true, sources: ['g2', 'web', 'telegram'] })
  harness.hub.pushStopNotification()
  await waitFor(() => harness.stub.callsOf('sendMessage').length >= 1)
  return harness.stub.lastMessageId()
}

describe('受信ファイル → inbox 保存 → reply relay 注入', () => {
  it('Stop 通知への返信 photo が保存され、パス+キャプション(1 行化)が中継される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('photo-1', { filePath: 'photos/file_1.jpg', bytes: JPEG })

    await h.dispatch(
      h.stub.makePhotoUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'photo-1',
        caption: 'これを見て\n直して',
        replyTo: stopMsgId,
      }),
    )

    // 最大解像度(配列末尾)の file_id で getFile される
    expect(h.stub.callsOf('getFile')[0]!.payload.file_id).toBe('photo-1')

    expect(h.hub.replies).toHaveLength(1)
    expect(h.hub.replies[0]!.rawBody.source).toBe('telegram')
    const relayText = String(h.hub.replies[0]!.rawBody.replyText)
    expect(relayText).toMatch(/^画像を受信: \S+\.jpg（キャプション: これを見て 直して）$/)

    const savedPath = relayText.replace('画像を受信: ', '').replace(/（キャプション.*$/, '')
    expect(path.isAbsolute(savedPath)).toBe(true)
    expect(path.dirname(savedPath)).toBe(h.inboxDir)
    expect(await readFile(savedPath)).toEqual(JPEG)

    // 受信物は本人限定で保存される(MediaFlow が dir 0700 で作成 / file 0600 で書き込み)
    expect((await stat(savedPath)).mode & 0o777).toBe(0o600)
    expect((await stat(h.inboxDir)).mode & 0o777).toBe(0o700)

    const feedback = h.stub.callsOf('sendMessage').at(-1)!
    expect(String(feedback.payload.text)).toContain('セッションに送信しました')
  })

  it('MIME 申告と実データが不一致な document は拒否される(PNG 申告で中身 JPEG)', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('doc-fake', { filePath: 'documents/fake.png', bytes: JPEG })

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-fake',
        mimeType: 'image/png',
        fileName: 'innocent.png',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    const text = String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)
    expect(text).toContain('検証できませんでした')
  })

  it('TTL 超過した Stop 通知への画像返信は追跡外として案内を返す', async () => {
    h = await createHarness({ stopReplyTtlMs: 50 })
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('photo-late', { filePath: 'photos/late.jpg', bytes: JPEG })
    await new Promise((resolve) => setTimeout(resolve, 80))

    await h.dispatch(
      h.stub.makePhotoUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'photo-late',
        replyTo: stopMsgId,
      }),
    )

    expect(h.stub.callsOf('getFile')).toHaveLength(0)
    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    const text = String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)
    expect(text).toContain('返信先を特定できませんでした')
  })

  it('画像 MIME の document は MIME 由来の拡張子で保存される(キャプションなし)', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('doc-1', { filePath: 'documents/file_2.bin', bytes: PNG })

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-1',
        mimeType: 'image/png',
        fileName: 'screen.png',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(1)
    const relayText = String(h.hub.replies[0]!.rawBody.replyText)
    expect(relayText).toMatch(/^画像を受信: \S+\.png$/)
    const savedPath = relayText.replace('画像を受信: ', '')
    expect(await readFile(savedPath)).toEqual(PNG)
  })

  it('PDF document は %PDF 検証を経て .pdf で保存され「PDFを受信」で中継される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('doc-pdf-1', { filePath: 'documents/report.pdf', bytes: PDF })

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-pdf-1',
        mimeType: 'application/pdf',
        fileName: 'report.pdf',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(1)
    const relayText = String(h.hub.replies[0]!.rawBody.replyText)
    expect(relayText).toMatch(/^PDFを受信: \S+\.pdf$/)
    expect(await readFile(relayText.replace('PDFを受信: ', ''))).toEqual(PDF)
  })

  it('PDF 申告で中身が PDF でない document は拒否される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('doc-pdf-fake', { filePath: 'documents/fake.pdf', bytes: JPEG })

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-pdf-fake',
        mimeType: 'application/pdf',
        fileName: 'fake.pdf',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    expect(String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)).toContain('検証できませんでした')
  })

  it('text/markdown document は .md で保存され「テキストを受信」で中継される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('doc-md', { filePath: 'documents/notes.md', bytes: MARKDOWN })

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-md',
        mimeType: 'text/markdown',
        fileName: 'notes.md',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(1)
    const relayText = String(h.hub.replies[0]!.rawBody.replyText)
    expect(relayText).toMatch(/^テキストを受信: \S+\.md$/)
    expect(await readFile(relayText.replace('テキストを受信: ', ''))).toEqual(MARKDOWN)
  })

  it('テキスト申告で NUL バイトを含む document はバイナリ偽装として拒否される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('doc-txt-fake', {
      filePath: 'documents/evil.txt',
      bytes: Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]),
    })

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-txt-fake',
        mimeType: 'text/plain',
        fileName: 'evil.txt',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    expect(String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)).toContain('検証できませんでした')
  })

  it('text/plain 申告でも既知バイナリ magic(%PDF)で始まる中身は拒否される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('doc-txt-pdf', { filePath: 'documents/sneaky.txt', bytes: PDF })

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-txt-pdf',
        mimeType: 'text/plain',
        fileName: 'sneaky.txt',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    expect(String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)).toContain('検証できませんでした')
  })

  it('text/plain + file_name が .md / .csv なら該当拡張子で保存される(file_name は検証には使わない)', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('doc-plain-md', { filePath: 'documents/a.bin', bytes: MARKDOWN })
    h.stub.setFile('doc-plain-csv', {
      filePath: 'documents/b.bin',
      bytes: Buffer.from('a,b,c\n1,2,3\n', 'utf8'),
    })

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-plain-md',
        mimeType: 'text/plain',
        fileName: 'NOTES.MD',
        replyTo: stopMsgId,
      }),
    )
    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-plain-csv',
        mimeType: 'text/plain',
        fileName: 'data.csv',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(2)
    expect(String(h.hub.replies[0]!.rawBody.replyText)).toMatch(/^テキストを受信: \S+\.md$/)
    expect(String(h.hub.replies[1]!.rawBody.replyText)).toMatch(/^テキストを受信: \S+\.csv$/)
  })

  it('voice は .ogg で保存され「音声を受信」+ Read 不可の注記つきで中継される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('voice-1', { filePath: 'voice/msg.oga', bytes: OGG })

    await h.dispatch(
      h.stub.makeVoiceUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'voice-1',
        caption: '口頭メモ',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(1)
    const relayText = String(h.hub.replies[0]!.rawBody.replyText)
    expect(relayText).toMatch(/^音声を受信: \S+\.ogg（キャプション: 口頭メモ）/)
    expect(relayText).toContain('音声ファイルは Read では読めません')
    const savedPath = relayText.replace('音声を受信: ', '').replace(/（キャプション.*$/, '')
    expect(await readFile(savedPath)).toEqual(OGG)
  })

  it('audio(audio/mpeg)は .mp3 で保存され、magic 不一致(中身 OGG)は拒否される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('audio-ok', { filePath: 'music/track.mp3', bytes: MP3 })
    h.stub.setFile('audio-fake', { filePath: 'music/fake.mp3', bytes: OGG })

    await h.dispatch(
      h.stub.makeAudioUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'audio-ok',
        mimeType: 'audio/mpeg',
        fileName: 'track.mp3',
        replyTo: stopMsgId,
      }),
    )
    expect(h.hub.replies).toHaveLength(1)
    const relayText = String(h.hub.replies[0]!.rawBody.replyText)
    expect(relayText).toMatch(/^音声を受信: \S+\.mp3/)
    expect(relayText).toContain('音声ファイルは Read では読めません')

    await h.dispatch(
      h.stub.makeAudioUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'audio-fake',
        mimeType: 'audio/mpeg',
        fileName: 'fake.mp3',
        replyTo: stopMsgId,
      }),
    )
    expect(h.hub.replies).toHaveLength(1) // 2 件目は中継されない
    expect(await listInbox(h)).toHaveLength(1) // 保存されたのは正常系の 1 件のみ
    expect(String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)).toContain('検証できませんでした')
  })

  it('video(video/mp4)は .mp4 で保存され「動画を受信」+ Read 不可の注記つきで中継される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('video-1', { filePath: 'videos/clip.bin', bytes: MP4 })

    await h.dispatch(
      h.stub.makeVideoUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'video-1',
        mimeType: 'video/mp4',
        fileName: 'clip.mp4',
        caption: 'デモ動画',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(1)
    const relayText = String(h.hub.replies[0]!.rawBody.replyText)
    expect(relayText).toMatch(/^動画を受信: \S+\.mp4（キャプション: デモ動画）/)
    expect(relayText).toContain('動画ファイルは Read では読めません')
    const savedPath = relayText.replace('動画を受信: ', '').replace(/（キャプション.*$/, '')
    expect(await readFile(savedPath)).toEqual(MP4)
  })

  it('video_note は MIME 申告なしでも mp4 固定で保存される', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('vnote-1', { filePath: 'video_notes/note.bin', bytes: MP4 })

    await h.dispatch(
      h.stub.makeVideoNoteUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'vnote-1',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(1)
    const relayText = String(h.hub.replies[0]!.rawBody.replyText)
    expect(relayText).toMatch(/^動画を受信: \S+\.mp4/)
    expect(relayText).toContain('動画ファイルは Read では読めません')
  })

  it('reply_to なしの画像は保存せず使い方の案内(Send as File 含む)を返す', async () => {
    h = await createHarness()

    await h.dispatch(
      h.stub.makePhotoUpdate({ fromId: USER_ID, chatId: CHAT_ID, fileId: 'photo-x' }),
    )

    expect(h.stub.callsOf('getFile')).toHaveLength(0)
    expect(h.stub.fileDownloadUrls).toHaveLength(0)
    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    const guide = String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)
    expect(guide).toContain('返信')
    expect(guide).toContain('再圧縮')
    expect(guide).toContain('Send as File')
  })

  it('非許可送信者の画像は無応答で破棄される(fail-closed)', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('photo-evil', { filePath: 'photos/file_3.jpg', bytes: JPEG })
    const callsBefore = h.stub.calls.length

    await h.dispatch(
      h.stub.makePhotoUpdate({
        fromId: OTHER_USER_ID,
        chatId: CHAT_ID,
        fileId: 'photo-evil',
        replyTo: stopMsgId,
      }),
    )

    expect(h.stub.calls.length).toBe(callsBefore) // sendMessage も getFile も呼ばれない
    expect(h.stub.fileDownloadUrls).toHaveLength(0)
    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
  })

  it('サイズ上限を超える画像は申告サイズの時点で拒否し、ダウンロードしない', async () => {
    h = await createHarness({ inboxMaxBytes: 5 })
    const stopMsgId = await postStopNotification(h)

    await h.dispatch(
      h.stub.makePhotoUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'photo-big',
        fileSize: 6,
        replyTo: stopMsgId,
      }),
    )

    expect(h.stub.callsOf('getFile')).toHaveLength(0)
    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    expect(String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)).toContain('大きすぎます')
  })

  it('申告なしでも実バイト数が上限を超えたら保存しない', async () => {
    h = await createHarness({ inboxMaxBytes: 5 })
    const stopMsgId = await postStopNotification(h)
    h.stub.setFile('photo-sneaky', { filePath: 'photos/file_4.jpg', bytes: JPEG }) // 7 bytes > 5

    await h.dispatch(
      h.stub.makePhotoUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'photo-sneaky',
        replyTo: stopMsgId,
      }),
    )

    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    expect(String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)).toContain('大きすぎます')
  })

  it('対応外 MIME の document は拒否し、ダウンロードしない', async () => {
    h = await createHarness()
    const stopMsgId = await postStopNotification(h)

    await h.dispatch(
      h.stub.makeDocumentUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'doc-zip',
        mimeType: 'application/zip',
        fileName: 'archive.zip',
        replyTo: stopMsgId,
      }),
    )

    expect(h.stub.callsOf('getFile')).toHaveLength(0)
    expect(h.hub.replies).toHaveLength(0)
    expect(await listInbox(h)).toHaveLength(0)
    const text = String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)
    expect(text).toContain('対応していないファイル形式')
  })

  it('relay allowlist に telegram がないと保存はするが stubbed の案内を返す', async () => {
    h = await createHarness()
    await h.startSse()
    h.hub.setRelay({ enabled: true, sources: ['g2', 'web'] })
    h.hub.pushStopNotification()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    const stopMsgId = h.stub.lastMessageId()
    h.stub.setFile('photo-2', { filePath: 'photos/file_5.jpg', bytes: JPEG })

    await h.dispatch(
      h.stub.makePhotoUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        fileId: 'photo-2',
        replyTo: stopMsgId,
      }),
    )

    expect(await listInbox(h)).toHaveLength(1)
    const text = String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)
    expect(text).toContain('HUB_REPLY_RELAY_SOURCES')
  })
})
