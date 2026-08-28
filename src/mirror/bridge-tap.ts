/**
 * bridge 境界の観測タップ。
 *
 * conn.bridge を透過 Proxy でラップし、G2 描画に使われる 4 メソッド
 * （createStartUpPageContainer / rebuildPageContainer / textContainerUpgrade /
 * updateImageRawData）の payload を MirrorStore へ同期反映する。
 * render-core.ts（凍結）・screens・glasses-ui は一切変更しない。
 *
 * 実装条件:
 * - get は Reflect.get(target, prop)（receiver を渡さない）で値を取り、SDK の
 *   getter / private fields / brand check を元 bridge の this で解決する
 * - function はプロパティ毎にキャッシュした wrapper を返し、
 *   Reflect.apply(fn, target, args) で元 bridge を this として呼ぶ
 * - 観測は wrapper 内で同期抽出のみ（await 追加・遅延挿入ゼロ）。観測側の例外は
 *   握り潰して bridge 呼び出しへ波及させない
 *
 * ラップは src/app/connect.ts の initBridge() 直後・描画前に 1 回だけ行うこと。
 * render-core の WeakMap キー（layoutByBridge 等）は conn.bridge 参照のため、
 * 途中差し替えはレイアウト状態の分裂を招く。
 */
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { MirrorStore } from './state'

const LAYOUT_METHODS = new Set(['createStartUpPageContainer', 'rebuildPageContainer'])

export function wrapBridgeForMirror(bridge: EvenAppBridge, store: MirrorStore): EvenAppBridge {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const wrapperCache = new Map<PropertyKey, Function>()

  return new Proxy(bridge, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value

      let wrapper = wrapperCache.get(prop)
      if (!wrapper) {
        wrapper = function (...args: unknown[]) {
          try {
            if (LAYOUT_METHODS.has(prop as string)) {
              store.replaceLayout(args[0])
            } else if (prop === 'textContainerUpgrade') {
              store.applyTextUpgrade(args[0])
            } else if (prop === 'updateImageRawData') {
              store.applyImageData(args[0])
            }
          } catch {
            // 観測失敗はミラー表示の欠けに留め、G2 描画には影響させない
          }
          return Reflect.apply(value, target, args)
        }
        wrapperCache.set(prop, wrapper)
      }
      return wrapper
    },
  }) as EvenAppBridge
}
