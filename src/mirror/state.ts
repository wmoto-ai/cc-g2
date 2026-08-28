/**
 * G2 ミラー表示モデル。
 *
 * bridge 境界（src/mirror/bridge-tap.ts）で観測した SDK payload から
 * 「いま G2 に表示されているはずの内容」を保持する。SDK・DOM に依存しない
 * 純粋なモデルと購読可能ストアのみを置く（描画は renderer.ts、送信は publisher.ts）。
 *
 * 更新規則:
 * - createStartUp / rebuild → containers 全置換（rebuild は実機で「失敗を返すが描画は
 *   更新される」ことがあるため、結果でなく呼び出しで更新する。フォールバックの
 *   createStartUp は同一 payload の再適用で冪等）
 * - textContainerUpgrade → 同 ID+name の text container の content 置換
 * - updateImageRawData → 同 ID+name の image container に PNG バイト列を保持
 *   （base64 変換等の重い処理は購読側が転送ウィンドウ外で行う）
 */

export type MirrorTextContainer = {
  kind: 'text'
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  content: string
}

export type MirrorListContainer = {
  kind: 'list'
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  items: string[]
  selectBorder: boolean
}

export type MirrorImageContainer = {
  kind: 'image'
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  /** updateImageRawData で届いた PNG（未転送なら null） */
  png: Uint8Array | null
}

export type MirrorContainer = MirrorTextContainer | MirrorListContainer | MirrorImageContainer

export type G2DisplayState = {
  /** レイアウト置換・部分更新のたびに増える通し番号 */
  seq: number
  containers: MirrorContainer[]
  updatedAt: number
}

// SDK payload の duck-typing（SDK クラスへの import 依存を持たない。
// プロパティ名は characterization テストが固定している SDK 境界と同一）
type LayoutPayloadLike = {
  textObject?: Array<{
    containerID?: number
    containerName?: string
    xPosition?: number
    yPosition?: number
    width?: number
    height?: number
    content?: string
  }>
  listObject?: Array<{
    containerID?: number
    containerName?: string
    xPosition?: number
    yPosition?: number
    width?: number
    height?: number
    itemContainer?: { itemName?: string[]; isItemSelectBorderEn?: number }
  }>
  imageObject?: Array<{
    containerID?: number
    containerName?: string
    xPosition?: number
    yPosition?: number
    width?: number
    height?: number
  }>
}

type TextUpgradeLike = { containerID?: number; containerName?: string; content?: string }
type ImageUpdateLike = { containerID?: number; containerName?: string; imageData?: ArrayLike<number> }

export function containersFromLayoutPayload(payload: unknown): MirrorContainer[] {
  const p = (payload ?? {}) as LayoutPayloadLike
  const containers: MirrorContainer[] = []
  for (const t of p.textObject ?? []) {
    containers.push({
      kind: 'text',
      id: t.containerID ?? 0,
      name: t.containerName ?? '',
      x: t.xPosition ?? 0,
      y: t.yPosition ?? 0,
      w: t.width ?? 0,
      h: t.height ?? 0,
      content: t.content ?? '',
    })
  }
  for (const l of p.listObject ?? []) {
    containers.push({
      kind: 'list',
      id: l.containerID ?? 0,
      name: l.containerName ?? '',
      x: l.xPosition ?? 0,
      y: l.yPosition ?? 0,
      w: l.width ?? 0,
      h: l.height ?? 0,
      items: [...(l.itemContainer?.itemName ?? [])],
      selectBorder: (l.itemContainer?.isItemSelectBorderEn ?? 0) === 1,
    })
  }
  for (const i of p.imageObject ?? []) {
    containers.push({
      kind: 'image',
      id: i.containerID ?? 0,
      name: i.containerName ?? '',
      x: i.xPosition ?? 0,
      y: i.yPosition ?? 0,
      w: i.width ?? 0,
      h: i.height ?? 0,
      png: null,
    })
  }
  return containers
}

export type MirrorStore = ReturnType<typeof createMirrorStore>

export function createMirrorStore() {
  let state: G2DisplayState = { seq: 0, containers: [], updatedAt: 0 }
  const listeners = new Set<(s: G2DisplayState) => void>()

  function emit() {
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // 購読側の失敗を bridge 呼び出し経路に波及させない
      }
    }
  }

  return {
    getState: (): G2DisplayState => state,

    subscribe(listener: (s: G2DisplayState) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** createStartUpPageContainer / rebuildPageContainer の payload で全置換 */
    replaceLayout(payload: unknown): void {
      state = {
        seq: state.seq + 1,
        containers: containersFromLayoutPayload(payload),
        updatedAt: Date.now(),
      }
      emit()
    },

    /** textContainerUpgrade: 同 ID+name の text container の content を置換 */
    applyTextUpgrade(payload: unknown): void {
      const u = (payload ?? {}) as TextUpgradeLike
      let changed = false
      const containers = state.containers.map((c) => {
        if (c.kind === 'text' && c.id === (u.containerID ?? -1) && c.name === (u.containerName ?? '')) {
          changed = true
          return { ...c, content: u.content ?? '' }
        }
        return c
      })
      if (!changed) return
      state = { seq: state.seq + 1, containers, updatedAt: Date.now() }
      emit()
    },

    /** updateImageRawData: 同 ID+name の image container に PNG バイト列を保持 */
    applyImageData(payload: unknown): void {
      const u = (payload ?? {}) as ImageUpdateLike
      let changed = false
      const containers = state.containers.map((c) => {
        if (c.kind === 'image' && c.id === (u.containerID ?? -1) && c.name === (u.containerName ?? '')) {
          changed = true
          return { ...c, png: u.imageData ? Uint8Array.from(u.imageData) : null }
        }
        return c
      })
      if (!changed) return
      state = { seq: state.seq + 1, containers, updatedAt: Date.now() }
      emit()
    },
  }
}
