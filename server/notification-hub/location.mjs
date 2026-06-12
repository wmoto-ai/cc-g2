// --- 位置情報 (Overland / 汎用 GPS ロガー対応) ---
// lastLocation は store が所有（再代入されるため store.lastLocation 経由で読み書き）。
import { store, log } from './store.mjs'
import { sendJson, parseJsonBody } from './http-util.mjs'

/** POST /api/location */
async function handleLocationPost(req, res) {
  const p = await parseJsonBody(req, res)
  if (!p) return
  // Overland GeoJSON format: { locations: [{ geometry: { coordinates: [lng, lat] }, properties: { timestamp, ... } }] }
  const locations = Array.isArray(p.locations) ? p.locations : []
  if (locations.length > 0) {
    const latest = locations[locations.length - 1]
    const coords = latest?.geometry?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) {
      return sendJson(res, 400, { ok: false, error: 'Invalid coordinates array' })
    }
    const lat = Number(coords[1])
    const lng = Number(coords[0])
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return sendJson(res, 400, { ok: false, error: 'Invalid latitude/longitude values' })
    }
    const alt = coords.length >= 3 ? Number(coords[2]) : NaN
    const props = latest.properties && typeof latest.properties === 'object' ? latest.properties : {}
    const spd = Number(props.speed)
    const bat = Number(props.battery_level)
    store.lastLocation = {
      lat,
      lng,
      altitude: Number.isFinite(alt) ? alt : null,
      timestamp: String(props.timestamp || '') || new Date().toISOString(),
      speed: Number.isFinite(spd) ? spd : null,
      battery: Number.isFinite(bat) ? bat : null,
      receivedAt: new Date().toISOString(),
    }
    log(`location updated: lat=${store.lastLocation.lat} lng=${store.lastLocation.lng}`)
  }
  return sendJson(res, 200, { ok: true })
}

/** GET /api/location */
function handleLocationGet(req, res) {
  if (!store.lastLocation) {
    return sendJson(res, 200, { ok: true, location: null, message: 'No location data received yet' })
  }
  return sendJson(res, 200, { ok: true, location: store.lastLocation })
}

export { handleLocationPost, handleLocationGet }
