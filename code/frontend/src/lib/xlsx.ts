import { entryText, listByPrefix, unzip, type ZipArchive } from './zip'
import { attr, childElements, descendants, escapeXml, firstChild, parseXml, parseXmlFromZip, type XmlNode } from './xml'
import type { Sheet, SheetCell, SheetJsModule, WorkBookLike } from 'sheetjs'

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

export interface SheetData {
  name: string
  rows: string[][]
  /** 行号对应的真实表格行号（1 开始） */
  rowNumbers: number[]
  columnLabels: string[]
  truncated: boolean
  /** 已截断时的完整说明，如「已截断，仅显示前 20000 行（共 128416 行）」 */
  truncatedNote?: string
  /** 实际装进内存的行数 */
  shownRows?: number
  totalRows: number
  totalCols: number
}

export interface XlsxParseOptions {
  /** 回退解析器最多装载的行数（默认 20000） */
  maxRows?: number
  /** 回退解析器最多装载的单元格数（默认 400000，防止宽表拖死主线程） */
  maxCells?: number
  signal?: AbortSignal
  onProgress?: (progress: { done: number; total: number; sheet: string; rows: number }) => void
}

export interface XlsxInspectResult {
  sheetCount: number
  estimatedRows: number
  largestSheet: string
}

export interface XlsxParseResult {
  sheets: SheetData[]
  warnings: string[]
}

export interface PersistedRow {
  r: number
  cells: string[]
}

export interface PersistedSheet {
  name: string
  rows: PersistedRow[]
  columns: string[]
  totalRows: number
  totalCols: number
  truncated: boolean
  truncatedNote?: string
  shownRows?: number
}

const MAX_ROWS = 4000
const MAX_COLS = 200
/** 回退解析器的装载上限：显式提示后仍然只占用可控内存 */
export const FALLBACK_MAX_ROWS = 20000
export const FALLBACK_MAX_CELLS = 400000
/** 超过 2 MB 的工作簿需要用户确认后再解析 */
export const LARGE_XLSX_BYTES = 2 * 1024 * 1024

export const columnLabel = (index: number): string => {
  let n = index + 1
  let label = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}

const columnIndex = (ref: string): number | null => {
  const match = /^([A-Z]+)\d*$/i.exec(ref.trim())
  if (!match) return null
  const letters = match[1].toUpperCase()
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function strFromSi(si: Element): string {
  const direct = firstChild(si, 't')
  if (direct) return direct.textContent ?? ''
  return descendants(si, 't')
    .map((t) => t.textContent ?? '')
    .join('')
}

function resolveSharedStrings(archive: ZipArchive | null): string[] {
  const doc = parseXmlFromZip(archive, 'xl/sharedStrings.xml')
  if (!doc) return []
  return descendants(doc.documentElement, 'si').map(strFromSi)
}

function workbookSheetOrder(archive: ZipArchive | null): { name: string; path: string }[] {
  const doc = parseXmlFromZip(archive, 'xl/workbook.xml')
  if (!doc) return []
  const relDoc = parseXmlFromZip(archive, 'xl/_rels/workbook.xml.rels')
  const relMap = new Map<string, string>()
  if (relDoc) {
    descendants(relDoc, 'Relationship').forEach((rel) => {
      const id = attr(rel, 'Id')
      const target = attr(rel, 'Target')
      if (id && target) relMap.set(id, target)
    })
  }
  const out: { name: string; path: string }[] = []
  descendants(doc, 'sheet').forEach((sheet) => {
    const name = attr(sheet, 'name') ?? '未命名工作表'
    const rid = attr(sheet, 'id')
    const target = rid ? relMap.get(rid) : null
    const path = target
      ? target.startsWith('/')
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, '')}`
      : ''
    if (path) out.push({ name, path })
  })
  return out
}

function cellValue(cell: XmlNode, shared: string[]): string {
  const type = attr(cell, 't') ?? 'n'
  if (type === 'inlineStr') {
    const is = firstChild(cell, 'is')
    return is ? strFromSi(is) : ''
  }
  const v = firstChild(cell, 'v')?.textContent ?? ''
  if (type === 's') {
    const index = Number(v)
    return Number.isFinite(index) ? (shared[index] ?? '') : ''
  }
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE'
  if (type === 'str' || type === 'e') return v
  return v
}

interface RowWalkOptions {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

const ROW_CHUNK = 2000

/** 让出主线程：大表逐块解析时，等待态与「取消」才有机会生效 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function parseSheetXml(
  xml: Document | null,
  shared: string[],
  maxRows: number = MAX_ROWS,
  options: RowWalkOptions = {},
): Promise<{ rows: PersistedRow[]; totalRows: number; totalCols: number; truncated: boolean }> {
  if (!xml) return { rows: [], totalRows: 0, totalCols: 0, truncated: false }
  const root = xml.documentElement
  const data = firstChild(root, 'sheetData') ?? root
  // 大文件热路径：sheetData / row 的子元素是直接子节点，用 childElements 避免递归全树扫描
  const rowEls = childElements(data, 'row')
  const rows: PersistedRow[] = []
  let totalCols = 0
  let lastRow = 0
  let index = 0
  for (const rowEl of rowEls) {
    if (index % ROW_CHUNK === 0) {
      options.signal?.throwIfAborted()
      options.onProgress?.(index, rowEls.length)
      if (index > 0) await yieldToUi()
    }
    const r = Number(attr(rowEl, 'r') ?? `${index + 1}`)
    index++
    lastRow = Math.max(lastRow, r)
    if (rows.length >= maxRows) continue
    const cells: string[] = []
    let colCursor = 0
    childElements(rowEl, 'c').forEach((cell) => {
      const ref = attr(cell, 'r')
      const col = ref ? columnIndex(ref) : null
      const target = col ?? colCursor
      colCursor = target + 1
      if (target >= MAX_COLS) return
      while (cells.length < target) cells.push('')
      try {
        cells[target] = cellValue(cell, shared)
      } catch {
        cells[target] = ''
      }
    })
    totalCols = Math.max(totalCols, cells.length)
    rows.push({ r, cells })
  }

  const dimension = descendants(root, 'dimension')[0]
  const ref = attr(dimension, 'ref')
  if (ref) {
    const end = ref.split(':').pop()
    if (end) {
      const endCol = columnIndex(end)
      const endRow = Number(/(\d+)/.exec(end)?.[1] ?? '0')
      if (endCol !== null) totalCols = Math.max(totalCols, endCol + 1)
      if (endRow) lastRow = Math.max(lastRow, endRow)
    }
  }

  return { rows, totalRows: lastRow || rows.length, totalCols, truncated: rowEls.length > maxRows }
}

function toSheetData(name: string, parsed: Awaited<ReturnType<typeof parseSheetXml>>): SheetData {
  return {
    name,
    rows: parsed.rows.map((row) => row.cells),
    rowNumbers: parsed.rows.map((row) => row.r),
    columnLabels: Array.from({ length: parsed.totalCols }, (_, i) => columnLabel(i)),
    truncated: parsed.truncated,
    totalRows: parsed.totalRows,
    totalCols: parsed.totalCols,
  }
}

/** 解析 xlsx：优先用运行时加载的 xlsx 模块（主路径保持不变），失败时回退到内置 XML 解析。 */
export async function parseXlsx(buffer: ArrayBuffer, options: XlsxParseOptions = {}): Promise<XlsxParseResult> {
  const warnings: string[] = []
  try {
    const { loadSheetJS } = await import('./sheetjs-loader')
    const XLSX = await loadSheetJS()
    const wb: WorkBookLike = XLSX.readAsync
      ? await XLSX.readAsync(buffer)
      : XLSX.read(buffer, { type: 'array' })
    const sheets: SheetData[] = []
    wb.SheetNames.forEach((name) => {
      const sheet = wb.Sheets[name] as Sheet | undefined
      const rows: PersistedRow[] = []
      let totalCols = 0
      let range: { s: { r: number; c: number }; e: { r: number; c: number } } | null = null
      try {
        range = XLSX.utils.decode_range((sheet?.['!ref'] as string | undefined) ?? 'A1')
      } catch {
        range = null
      }
      if (sheet && range) {
        const endRow = Math.min(range.e.r, range.s.r + MAX_ROWS - 1)
        const endCol = Math.min(range.e.c, range.s.c + MAX_COLS - 1)
        for (let r = range.s.r; r <= endRow; r++) {
          const cells: string[] = []
          for (let c = range.s.c; c <= endCol; c++) {
            const raw = sheet[XLSX.utils.encode_cell({ r, c })]
            const cell = raw && !Array.isArray(raw) ? (raw as SheetCell) : null
            let value = ''
            if (cell) {
              if (cell.w !== undefined && cell.w !== null && cell.w !== '') value = String(cell.w)
              else if (cell.v !== undefined && cell.v !== null) value = String(cell.v)
            }
            cells.push(value)
          }
          totalCols = Math.max(totalCols, cells.length)
          rows.push({ r: r + 1, cells })
        }
      }
      const totalRows = range ? range.e.r + 1 : rows.length + 1
      const totalColsReal = range ? Math.max(totalCols, range.e.c + 1) : totalCols
      sheets.push({
        name,
        rows: rows.map((row) => row.cells),
        rowNumbers: rows.map((row) => row.r),
        columnLabels: Array.from({ length: totalColsReal }, (_, i) => columnLabel(i)),
        truncated: totalRows > MAX_ROWS || (range ? range.e.c + 1 > MAX_COLS : false),
        totalRows,
        totalCols: totalColsReal,
      })
    })
    if (!sheets.length) warnings.push('工作簿中没有工作表')
    return { sheets, warnings }
  } catch {
    warnings.push('已切换内置解析器读取工作簿')
    return parseXlsxFallback(buffer, warnings, options)
  }
}

/** 估算工作簿规模：只解压 + 正则读 <dimension>，不做 DOM 解析（大文件也就几十毫秒）。 */
export async function inspectXlsxWorkbook(buffer: ArrayBuffer): Promise<XlsxInspectResult> {
  const archive = await unzip(buffer)
  const order = workbookSheetOrder(archive)
  const entries = order.length
    ? order
    : listByPrefix(archive, 'xl/worksheets/')
        .filter((name) => /^xl\/worksheets\/.*\.xml$/i.test(name))
        .sort()
        .map((name, index) => ({ name: `工作表${index + 1}`, path: name }))
  let estimatedRows = 0
  let largestSheet = ''
  for (const entry of entries) {
    const xml = entryText(archive, entry.path) ?? ''
    const match = /<dimension[^>]*ref="[A-Z]+\d+(?::[A-Z]+(\d+))?"/i.exec(xml)
    const rows = match?.[1] ? Number(match[1]) : 0
    if (rows > estimatedRows) {
      estimatedRows = rows
      largestSheet = entry.name
    }
  }
  return { sheetCount: entries.length, estimatedRows, largestSheet }
}

/**
 * 只截取 <sheetData> 中前 maxRows 行（以及 maxCells 个单元格）再交给 DOMParser。
 * 这样大文件的 DOM 规模从百万节点降到可控范围，解析时间随之降到秒级。
 */
function sliceSheetData(
  xml: string,
  maxRows: number,
  maxCells: number,
): { xml: string; shownRows: number; truncatedBy: '' | 'rows' | 'cells' } {
  const open = xml.indexOf('<sheetData')
  if (open < 0) return { xml, shownRows: 0, truncatedBy: '' }
  const close = xml.indexOf('</sheetData>', open)
  if (close < 0) return { xml, shownRows: 0, truncatedBy: '' }
  const head = xml.slice(0, open)
  const body = xml.slice(open, close)
  const tail = xml.slice(close + '</sheetData>'.length)
  const tag = /<row[\s>]|<c[\s>]/g
  let rows = 0
  let cells = 0
  let lastRowStart = -1
  let cutAt = -1
  let truncatedBy: '' | 'rows' | 'cells' = ''
  let match: RegExpExecArray | null
  while ((match = tag.exec(body))) {
    if (match[0].charAt(1) === 'r') {
      if (rows >= maxRows) {
        cutAt = match.index
        truncatedBy = 'rows'
        break
      }
      rows += 1
      lastRowStart = match.index
    } else {
      if (cells + 1 > maxCells) {
        cutAt = lastRowStart >= 0 ? lastRowStart : match.index
        truncatedBy = 'cells'
        rows = Math.max(0, rows - 1)
        break
      }
      cells += 1
    }
  }
  if (cutAt < 0) return { xml, shownRows: rows, truncatedBy: '' }
  return { xml: head + body.slice(0, cutAt) + '</sheetData>' + tail, shownRows: rows, truncatedBy }
}

function truncationNote(shownRows: number, totalRows: number, by: '' | 'rows' | 'cells') {
  const total = totalRows > shownRows ? totalRows : shownRows
  const suffix = by === 'cells' ? '，受单元格上限限制' : ''
  return `已截断，仅显示前 ${shownRows} 行（共 ${total} 行${suffix}）`
}

/**
 * 内置解析器：直接读 xl/worksheets/*.xml，不依赖第三方库。
 * 大文件保护：先按行/单元格上限裁剪 XML 文本，再解析；解析过程可中止、可上报进度。
 */
export async function parseXlsxFallback(
  buffer: ArrayBuffer,
  warnings: string[] = [],
  options: XlsxParseOptions = {},
): Promise<XlsxParseResult> {
  const maxRows = options.maxRows ?? FALLBACK_MAX_ROWS
  const maxCells = options.maxCells ?? FALLBACK_MAX_CELLS
  const signal = options.signal
  signal?.throwIfAborted()

  const archive = await unzip(buffer)
  signal?.throwIfAborted()
  const shared = resolveSharedStrings(archive)
  let order = workbookSheetOrder(archive)
  if (!order.length) {
    order = listByPrefix(archive, 'xl/worksheets/')
      .filter((name) => name.toLowerCase().endsWith('.xml'))
      .sort()
      .map((name, index) => ({ name: `工作表${index + 1}`, path: name }))
  }
  const sheets: SheetData[] = []
  for (let index = 0; index < order.length; index++) {
    const entry = order[index]
    signal?.throwIfAborted()
    try {
      const raw = entryText(archive, entry.path) ?? ''
      const sliced = sliceSheetData(raw, maxRows, maxCells)
      options.onProgress?.({ done: index, total: order.length, sheet: `${entry.name} · 解析 XML`, rows: 0 })
      await yieldToUi()
      const parsed = await parseSheetXml(parseXml(sliced.xml), shared, maxRows, {
        signal,
        onProgress: (done, total) => {
          options.onProgress?.({
            done: index,
            total: order.length,
            sheet: `${entry.name} · ${done}/${total} 行`,
            rows: done,
          })
        },
      })
      const shownRows = parsed.rows.length
      const truncated = sliced.truncatedBy !== '' || shownRows < parsed.totalRows
      const note = truncated ? truncationNote(shownRows, parsed.totalRows, sliced.truncatedBy) : undefined
      if (note) warnings.push(`工作表「${entry.name}」${note}`)
      const sheet = toSheetData(entry.name, parsed)
      sheet.truncated = truncated
      sheet.truncatedNote = note
      sheet.shownRows = shownRows
      sheets.push(sheet)
      options.onProgress?.({
        done: index + 1,
        total: order.length,
        sheet: entry.name,
        rows: shownRows,
      })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      warnings.push(`工作表「${entry.name}」部分内容无法解析，已展示可读部分`)
    }
  }
  if (!sheets.length) warnings.push('无法读取任何工作表')
  return { sheets, warnings }
}

/* ------------------------------------------------------------------ */
/* 持久化与回写                                                         */
/* ------------------------------------------------------------------ */

export function persistedFromSheet(sheet: SheetData): PersistedSheet {
  return {
    name: sheet.name,
    rows: sheet.rows.map((cells, index) => ({ r: sheet.rowNumbers[index] ?? index + 1, cells })),
    columns: sheet.columnLabels,
    totalRows: sheet.totalRows,
    totalCols: sheet.totalCols,
    truncated: sheet.truncated,
    truncatedNote: sheet.truncatedNote,
    shownRows: sheet.shownRows ?? sheet.rows.length,
  }
}

/** 以 [{name, rows}] 生成 SheetJS 工作簿（保留工作表名称）。 */
export function buildWorkbook(
  XLSX: SheetJsModule,
  sheets: PersistedSheet[],
): WorkBookLike {
  const wb: WorkBookLike = { SheetNames: [], Sheets: Object.create(null) as Record<string, Sheet> }
  sheets.forEach((sheet, sheetIndex) => {
    const safeName = sheet.name || `Sheet${sheetIndex + 1}`
    // 按真实行号还原（空行保留位置），保证回写后行号与视图一致
    const maxRow = sheet.rows.reduce((max, row) => Math.max(max, row.r), 1)
    const aoa: string[][] = Array.from({ length: maxRow }, () => [])
    sheet.rows.forEach((row) => {
      const target = aoa[row.r - 1]
      if (!target) return
      row.cells.forEach((cell, colIndex) => {
        target[colIndex] = cell
      })
      for (let i = 0; i < target.length; i++) if (target[i] === undefined) target[i] = ''
    })
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const width = sheet.rows.reduce((max, row) => Math.max(max, row.cells.length), 0)
    if (width > 0) {
      ws['!cols'] = Array.from({ length: width }, (_, i) => {
        const longest = sheet.rows.reduce((max, row) => Math.max(max, (row.cells[i] ?? '').length), 6)
        return { wch: Math.min(Math.max(longest + 2, 8), 52) }
      })
    }
    wb.SheetNames.push(safeName)
    wb.Sheets[safeName] = ws
  })
  return wb
}

export function sheetText(sheets: PersistedSheet[]): string {
  return sheets
    .map((sheet) => {
      const lines = sheet.rows.map((row) => row.cells.join('\t'))
      return `# ${sheet.name}\n${lines.join('\n')}`
    })
    .join('\n\n')
}

/** 搜索工作表所有单元格（返回命中位置）。 */
export function findInSheets(sheets: PersistedSheet[], query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: { sheet: number; row: number; col: number; text: string }[] = []
  sheets.forEach((sheet, sheetIndex) => {
    sheet.rows.forEach((row) => {
      row.cells.forEach((cell, col) => {
        if (cell && cell.toLowerCase().includes(q)) {
          hits.push({ sheet: sheetIndex, row: row.r, col, text: cell })
        }
      })
    })
  })
  return hits
}

/** 允许外部把表格变更为单元格字符串（编辑回写）。 */
export function setCell(sheets: PersistedSheet[], sheetIndex: number, rowNumber: number, col: number, value: string): PersistedSheet[] {
  return sheets.map((sheet, index) => {
    if (index !== sheetIndex) return sheet
    return {
      ...sheet,
      rows: sheet.rows.map((row) => {
        if (row.r !== rowNumber) return row
        const cells = row.cells.slice()
        while (cells.length <= col) cells.push('')
        cells[col] = value
        return { ...row, cells }
      }),
    }
  })
}

export { entryText, escapeXml }
