/**
 * G2 ミラーの表示モデル・bridge タップのテスト。
 *
 * - 表示モデル: SDK の実クラス（CreateStartUpPageContainer 等）から containers を
 *   正しく抽出できること（プロパティ名の整合を実クラスで検証する）
 * - bridge タップ: 透過性（this 束縛・戻り値・非対象メソッド無干渉）と、
 *   観測対象 4 メソッドの呼び出しが store に反映されること
 */
import { describe, expect, it } from 'vitest'
import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  ImageContainerProperty,
  TextContainerUpgrade,
  ImageRawDataUpdate,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { containersFromLayoutPayload, createMirrorStore } from '../src/mirror/state'
import { wrapBridgeForMirror } from '../src/mirror/bridge-tap'
import { toWireState, fromWireState, base64FromBytes, bytesFromBase64 } from '../src/mirror/wire'

function buildLayoutPayload() {
  return new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [
      new TextContainerProperty({
        xPosition: 8,
        yPosition: 4,
        width: 560,
        height: 28,
        containerID: 1,
        containerName: 'hdr',
        content: 'ヘッダー',
        isEventCapture: 0,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 8,
        yPosition: 36,
        width: 560,
        height: 240,
        containerID: 2,
        containerName: 'lst',
        itemContainer: new ListItemContainerProperty({
          itemCount: 2,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: ['項目A', '項目B'],
        }),
        isEventCapture: 1,
      }),
    ],
    imageObject: [
      new ImageContainerProperty({
        containerID: 3,
        containerName: 'img-0',
        xPosition: 0,
        yPosition: 0,
        width: 288,
        height: 144,
      }),
    ],
  })
}

describe('containersFromLayoutPayload', () => {
  it('SDK 実クラスの payload から text/list/image を抽出する', () => {
    const containers = containersFromLayoutPayload(buildLayoutPayload())
    expect(containers).toEqual([
      { kind: 'text', id: 1, name: 'hdr', x: 8, y: 4, w: 560, h: 28, content: 'ヘッダー' },
      {
        kind: 'list',
        id: 2,
        name: 'lst',
        x: 8,
        y: 36,
        w: 560,
        h: 240,
        items: ['項目A', '項目B'],
        selectBorder: true,
      },
      { kind: 'image', id: 3, name: 'img-0', x: 0, y: 0, w: 288, h: 144, png: null },
    ])
  })

  it('空・不正 payload では空配列を返す', () => {
    expect(containersFromLayoutPayload(undefined)).toEqual([])
    expect(containersFromLayoutPayload({})).toEqual([])
  })
})

describe('createMirrorStore', () => {
  it('replaceLayout で全置換され seq が進む', () => {
    const store = createMirrorStore()
    expect(store.getState().seq).toBe(0)
    store.replaceLayout(buildLayoutPayload())
    expect(store.getState().seq).toBe(1)
    expect(store.getState().containers).toHaveLength(3)
  })

  it('applyTextUpgrade は ID+name 一致の text のみ更新し、不一致では seq を進めない', () => {
    const store = createMirrorStore()
    store.replaceLayout(buildLayoutPayload())
    store.applyTextUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'hdr', contentOffset: 0, contentLength: 3, content: '更新後' }),
    )
    expect(store.getState().seq).toBe(2)
    const text = store.getState().containers.find((c) => c.kind === 'text')
    expect(text).toMatchObject({ content: '更新後' })

    // 不一致（別名）は no-op
    store.applyTextUpgrade(
      new TextContainerUpgrade({ containerID: 9, containerName: 'nope', contentOffset: 0, contentLength: 1, content: 'x' }),
    )
    expect(store.getState().seq).toBe(2)
  })

  it('applyImageData は ID+name 一致の image に PNG バイト列を保持する', () => {
    const store = createMirrorStore()
    store.replaceLayout(buildLayoutPayload())
    store.applyImageData(
      new ImageRawDataUpdate({ containerID: 3, containerName: 'img-0', imageData: [1, 2, 3] }),
    )
    const image = store.getState().containers.find((c) => c.kind === 'image')
    expect(image).toMatchObject({ png: Uint8Array.from([1, 2, 3]) })
  })

  it('購読者の例外は他の購読者・呼び出し元に波及しない', () => {
    const store = createMirrorStore()
    const seen: number[] = []
    store.subscribe(() => {
      throw new Error('boom')
    })
    store.subscribe((s) => seen.push(s.seq))
    expect(() => store.replaceLayout(buildLayoutPayload())).not.toThrow()
    expect(seen).toEqual([1])
  })
})

describe('wire（Hub 配信用シリアライズ）', () => {
  it('base64 の往復がバイト一致する', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256)
    expect(bytesFromBase64(base64FromBytes(bytes))).toEqual(bytes)
  })

  it('toWireState / fromWireState の往復で状態が保たれる（png は base64 経由）', () => {
    const store = createMirrorStore()
    store.replaceLayout(buildLayoutPayload())
    store.applyImageData(
      new ImageRawDataUpdate({ containerID: 3, containerName: 'img-0', imageData: [1, 2, 3] }),
    )
    const state = store.getState()
    const wire = toWireState(state)
    const image = wire.containers.find((c) => c.kind === 'image')
    expect(image).toMatchObject({ pngBase64: base64FromBytes(Uint8Array.from([1, 2, 3])) })
    // JSON 化を挟んでも往復できる（Hub 経由の実経路と同じ）
    expect(fromWireState(JSON.parse(JSON.stringify(wire)))).toEqual(state)
  })
})

describe('wrapBridgeForMirror', () => {
  // SDK が private fields / brand check を使っていても壊れないことの検証用
  class FakeBridge {
    #secret = 'ok'
    lastThis: unknown = null
    async createStartUpPageContainer(_payload: unknown) {
      this.lastThis = this
      return 0
    }
    async rebuildPageContainer(_payload: unknown) {
      this.lastThis = this
      return true
    }
    async textContainerUpgrade(_payload: unknown) {
      this.lastThis = this
      return true
    }
    async updateImageRawData(_payload: unknown) {
      this.lastThis = this
      return 0
    }
    async getDeviceInfo() {
      // private field アクセス: this が Proxy だと TypeError になる
      return { model: this.#secret }
    }
  }

  function setup() {
    const store = createMirrorStore()
    const raw = new FakeBridge()
    const wrapped = wrapBridgeForMirror(raw as unknown as EvenAppBridge, store)
    return { store, raw, wrapped: wrapped as unknown as FakeBridge }
  }

  it('観測対象メソッドは store を更新しつつ元 bridge を this として呼ぶ', async () => {
    const { store, raw, wrapped } = setup()
    const result = await wrapped.createStartUpPageContainer(buildLayoutPayload())
    expect(result).toBe(0)
    expect(raw.lastThis).toBe(raw) // Proxy ではなく元 bridge が this
    expect(store.getState().containers).toHaveLength(3)

    await wrapped.rebuildPageContainer(buildLayoutPayload())
    expect(store.getState().seq).toBe(2)

    await wrapped.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'hdr', contentOffset: 0, contentLength: 1, content: '新' }),
    )
    expect(store.getState().containers.find((c) => c.kind === 'text')).toMatchObject({ content: '新' })

    await wrapped.updateImageRawData(
      new ImageRawDataUpdate({ containerID: 3, containerName: 'img-0', imageData: [7] }),
    )
    expect(store.getState().containers.find((c) => c.kind === 'image')).toMatchObject({
      png: Uint8Array.from([7]),
    })
  })

  it('非対象メソッドも private field ごと透過する（brand check 安全）', async () => {
    const { wrapped } = setup()
    await expect(wrapped.getDeviceInfo()).resolves.toEqual({ model: 'ok' })
  })

  it('wrapper はプロパティ毎にキャッシュされ同一参照を返す', () => {
    const { wrapped } = setup()
    expect(wrapped.createStartUpPageContainer).toBe(wrapped.createStartUpPageContainer)
  })

  it('観測側（store 購読者）の例外が bridge 呼び出しを失敗させない', async () => {
    const { store, wrapped } = setup()
    store.subscribe(() => {
      throw new Error('observer boom')
    })
    await expect(wrapped.createStartUpPageContainer(buildLayoutPayload())).resolves.toBe(0)
  })
})
