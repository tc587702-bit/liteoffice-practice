import * as XLSX from 'xlsx'
import type { SheetJsModule } from 'sheetjs'

/**
 * SheetJS 直接使用 npm 包 `xlsx`（不再从 public/vendor 或任何 http 地址动态 import）。
 * 本模块只做一层轻量适配：把 npm 模块收窄为项目内部使用的 SheetJsModule 形状，
 * 调用方（xlsx.ts / exporter.ts）依旧通过 loadSheetJS() 延迟加载，
 * 因此 xlsx 仍然被 Vite 拆成独立 chunk，不进入首屏主包。
 */
let loading: Promise<SheetJsModule> | null = null

export function loadSheetJS(): Promise<SheetJsModule> {
  if (!loading) {
    loading = Promise.resolve(XLSX as unknown as SheetJsModule).then((lib) => {
      if (typeof lib.read !== 'function' || !lib.utils) {
        throw new Error('SheetJS 模块结构异常')
      }
      return lib
    })
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}
