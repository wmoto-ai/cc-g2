// STT 関連ルート: Groq 文字起こし / OpenAI Realtime・Soniox の一時トークン発行。
// 可変状態は持たない。
import { getString } from './notification-utils.mjs'
import { transcribeAudioWithGroq } from './stt.mjs'
import {
  groqApiKey,
  groqModelDefault,
  hubMaxSttBodyBytes,
  openaiApiKey,
  sonioxApiKey,
} from './config.mjs'
import { log } from './store.mjs'
import { sendJson, parseJsonBody } from './http-util.mjs'

/** POST /api/stt/transcriptions */
async function handleSttTranscription(req, res) {
  const p = await parseJsonBody(req, res, hubMaxSttBodyBytes)
  if (!p) return
  const audioBase64 = getString(p.audioBase64)
  if (!audioBase64) {
    return sendJson(res, 400, { ok: false, error: '`audioBase64` is required' })
  }
  const result = await transcribeAudioWithGroq(
    {
      audioBase64,
      mimeType: getString(p.mimeType),
      model: getString(p.model),
      language: getString(p.language),
      responseFormat: getString(p.response_format),
    },
    {
      apiKey: groqApiKey,
      defaultModel: groqModelDefault,
    },
  )
  if (!result.ok) {
    return sendJson(res, result.status, { ok: false, error: result.error })
  }
  return sendJson(res, 200, result.payload)
}

/** POST /api/stt/realtime-token */
async function handleSttRealtimeToken(req, res) {
  if (!openaiApiKey) {
    return sendJson(res, 400, { ok: false, error: 'OPENAI_API_KEY not configured' })
  }
  try {
    const sessionRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 600 },
        session: {
          type: 'transcription',
          audio: {
            input: {
              transcription: {
                model: 'gpt-realtime-whisper',
                language: 'ja',
              },
            },
          },
        },
      }),
    })
    if (!sessionRes.ok) {
      const errText = await sessionRes.text().catch(() => '')
      log(`OpenAI realtime client_secrets error: HTTP ${sessionRes.status} ${errText.slice(0, 300)}`)
      return sendJson(res, 502, {
        ok: false,
        error: `OpenAI API error: HTTP ${sessionRes.status}`,
      })
    }
    const sessionData = await sessionRes.json()
    const token = sessionData?.value
    const expiresAt = sessionData?.expires_at
      ? new Date(sessionData.expires_at * 1000).toISOString()
      : undefined
    if (!token) {
      log(`OpenAI realtime client_secrets: missing value in response: ${JSON.stringify(sessionData).slice(0, 200)}`)
      return sendJson(res, 502, {
        ok: false,
        error: 'OpenAI API returned unexpected response (missing token)',
      })
    }
    log('OpenAI realtime ephemeral token issued')
    return sendJson(res, 200, { ok: true, token, expiresAt })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`OpenAI realtime session fetch error: ${msg}`)
    return sendJson(res, 502, { ok: false, error: `OpenAI API request failed: ${msg}` })
  }
}

/** POST /api/stt/soniox-token */
async function handleSttSonioxToken(req, res) {
  if (!sonioxApiKey) {
    return sendJson(res, 400, { ok: false, error: 'SONIOX_API_KEY not configured' })
  }
  try {
    const tokenRes = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sonioxApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 120,
        single_use: true,
        max_session_duration_seconds: 300,
      }),
    })
    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '')
      log(`Soniox temporary API key error: HTTP ${tokenRes.status} ${errText.slice(0, 300)}`)
      return sendJson(res, 502, {
        ok: false,
        error: `Soniox API error: HTTP ${tokenRes.status}`,
      })
    }
    const tokenData = await tokenRes.json()
    const token = tokenData?.api_key
    if (!token) {
      log(`Soniox temporary API key: unexpected response: ${JSON.stringify(tokenData).slice(0, 200)}`)
      return sendJson(res, 502, {
        ok: false,
        error: 'Soniox API returned unexpected response (missing api_key)',
      })
    }
    log('Soniox temporary API key issued')
    return sendJson(res, 200, { ok: true, token, expiresAt: tokenData.expires_at })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Soniox temporary API key fetch error: ${msg}`)
    return sendJson(res, 502, { ok: false, error: `Soniox API request failed: ${msg}` })
  }
}

export { handleSttTranscription, handleSttRealtimeToken, handleSttSonioxToken }
