// --- 画像保存 (G2 画像表示用) ---
// imagesById は store が所有し、ここでは参照のみ。
// handleImagePost は BODY_TOO_LARGE を呼び出し元（index.mjs の try/catch）へ伝播させる。
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { statSync } from 'node:fs'
import path from 'node:path'
import { getString, readRequestBodyBinary } from './notification-utils.mjs'
import { hubMaxImageBytes, hubMaxImages, imagesDir } from './config.mjs'
import { store, log } from './store.mjs'
import { sendJson } from './http-util.mjs'
import { sseBroadcastNotificationAdded } from './sse.mjs'
import { addNotification } from './notifications.mjs'

const { imagesById } = store

const IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** マジックバイトで画像形式を判定する（Content-Type 申告は信用しない） */
function detectImageType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', contentType: 'image/png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' }
  }
  return null
}

/** 保存数上限を超えた古い画像を削除する */
async function pruneOldImages() {
  if (imagesById.size <= hubMaxImages) return
  const sorted = [...imagesById.entries()].sort((a, b) => (a[1].createdAt < b[1].createdAt ? -1 : 1))
  while (sorted.length > hubMaxImages) {
    const [id, entry] = sorted.shift()
    imagesById.delete(id)
    try {
      await unlink(path.join(imagesDir, entry.file))
      log(`image pruned id=${id}`)
    } catch {
      // 既に消えていても無視
    }
  }
}

/** 起動時に imagesDir をスキャンして imagesById を再構築する */
async function loadStoredImages() {
  let files = []
  try {
    files = await readdir(imagesDir)
  } catch {
    return
  }
  for (const file of files) {
    const m = file.match(/^([0-9a-f-]{36})\.(png|jpg)$/)
    if (!m || !IMAGE_ID_RE.test(m[1])) continue
    let createdAt
    try {
      createdAt = statSync(path.join(imagesDir, file)).mtime.toISOString()
    } catch {
      continue
    }
    imagesById.set(m[1], {
      file,
      contentType: m[2] === 'png' ? 'image/png' : 'image/jpeg',
      createdAt,
    })
  }
}

function matchImagePath(pathname) {
  const m = pathname.match(/^\/api\/images\/([0-9a-f-]{36})$/)
  if (!m || !IMAGE_ID_RE.test(m[1])) return null
  return m[1]
}

/** POST /api/images */
async function handleImagePost(req, res, url) {
  const body = await readRequestBodyBinary(req, { maxBytes: hubMaxImageBytes })
  const imageType = detectImageType(body)
  if (!imageType) {
    return sendJson(res, 415, { ok: false, error: 'Unsupported image format (png/jpeg only)' })
  }

  const imageId = randomUUID()
  const file = `${imageId}.${imageType.ext}`
  await writeFile(path.join(imagesDir, file), body)
  imagesById.set(imageId, {
    file,
    contentType: imageType.contentType,
    createdAt: new Date().toISOString(),
  })
  await pruneOldImages()

  const title = getString(url.searchParams.get('title')) || 'Screenshot'
  const sessionId = getString(url.searchParams.get('sessionId'))
  const result = await addNotification(
    {
      title,
      body: `画像が届きました (${imageType.ext}, ${Math.round(body.length / 1024)}KB)`,
      metadata: {
        imageId,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    'image notification',
  )
  if (!result.duplicate) sseBroadcastNotificationAdded(result.item)
  log(`image received id=${imageId} type=${imageType.ext} bytes=${body.length}`)
  return sendJson(res, 201, { ok: true, imageId, notificationId: result.item.id })
}

/** GET /api/images/:id */
async function handleImageGet(req, res, imageId) {
  const entry = imagesById.get(imageId)
  if (!entry) return sendJson(res, 404, { ok: false, error: 'Image not found' })
  let data
  try {
    data = await readFile(path.join(imagesDir, entry.file))
  } catch {
    imagesById.delete(imageId)
    return sendJson(res, 404, { ok: false, error: 'Image not found' })
  }
  res.statusCode = 200
  res.setHeader('Content-Type', entry.contentType)
  res.setHeader('Content-Length', data.length)
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.end(data)
  return
}

export { matchImagePath, loadStoredImages, handleImagePost, handleImageGet }
