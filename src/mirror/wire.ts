/**
 * G2 ミラー表示状態のワイヤ形式（Hub 経由配信用）。
 *
 * WebView → Hub への POST と、ビューア（mirror.html）が GET で受け取る JSON の
 * 変換のみを置く。PNG バイト列は base64 文字列にする（JSON 化のため）。
 */
import type { G2DisplayState, MirrorContainer } from './state'

export type WireContainer =
  | Extract<MirrorContainer, { kind: 'text' | 'list' }>
  | {
      kind: 'image'
      id: number
      name: string
      x: number
      y: number
      w: number
      h: number
      pngBase64: string | null
    }

export type G2DisplayWire = {
  seq: number
  updatedAt: number
  containers: WireContainer[]
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function toWireState(state: G2DisplayState): G2DisplayWire {
  return {
    seq: state.seq,
    updatedAt: state.updatedAt,
    containers: state.containers.map((c): WireContainer => {
      if (c.kind !== 'image') return c
      const { png, ...rest } = c
      return { ...rest, pngBase64: png ? base64FromBytes(png) : null }
    }),
  }
}

export function fromWireState(wire: G2DisplayWire): G2DisplayState {
  return {
    seq: wire.seq ?? 0,
    updatedAt: wire.updatedAt ?? 0,
    containers: (wire.containers ?? []).map((c): MirrorContainer => {
      if (c.kind !== 'image') return c
      const { pngBase64, ...rest } = c
      return { ...rest, png: pngBase64 ? bytesFromBase64(pngBase64) : null }
    }),
  }
}
