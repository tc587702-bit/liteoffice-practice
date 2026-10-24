// 运行时模块 sheetjs：由 sheetjs-loader.ts 从 npm 包 `xlsx` 适配而来，
// 此处只声明项目内部使用的最小外形，供 TypeScript 检查使用。
declare module 'sheetjs' {
  export interface SheetCell {
    v?: string | number | boolean | null
    w?: string
    t?: string
    f?: string
  }

  export interface Sheet {
    [address: string]: SheetCell | { wch?: number }[] | undefined
  }

  export interface WorkBookLike {
    SheetNames: string[]
    Sheets: Record<string, Sheet>
  }

  export interface CellRange {
    s: { r: number; c: number }
    e: { r: number; c: number }
  }

  export interface SheetJsModule {
    read: (data: ArrayBuffer | Uint8Array, opts?: Record<string, unknown>) => WorkBookLike
    readAsync?: (data: ArrayBuffer) => Promise<WorkBookLike>
    write: (workbook: WorkBookLike, opts?: Record<string, unknown>) => ArrayBuffer
    utils: {
      decode_range: (ref: string) => CellRange
      encode_cell: (addr: { r: number; c: number }) => string
      aoa_to_sheet: (data: (string | number | boolean | null)[][]) => Sheet
    }
  }

  const XLSX: SheetJsModule
  export default XLSX
}
