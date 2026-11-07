/**
 * 本地工具集（不需要模型、不需要网络）
 *
 * 设计原则：
 *  1. 纯函数：输入文档数据，输出结构化结果，便于单测
 *  2. 不碰 DOM API（除可选传入 docxItems），可在 Node 里直接测
 *  3. 每个工具声明 needsModel: false，离线时照常可用
 *  4. 只读工具不修改任何东西；写入动作不在这里（由 UI 层做 Range 替换）
 */

export interface DocBlock {
  type: 'paragraph' | 'heading' | 'table' | 'image' | 'list' | string
  html: string
  text?: string
  level?: number
}

export interface DocLike {
  title: string
  kind: string
  html: string
  text?: string
  docxItems?: DocBlock[]
}

/** 工具声明（供 UI / 未来的模型调用统一读取） */
export interface ToolMeta {
  name: string
  label: string
  description: string
  reads: boolean
  destructive: boolean
  needsModel: boolean
  requires: string[]
}

export const TOOL_META: Record<string, ToolMeta> = {
  get_stats: {
    name: 'get_stats',
    label: '文档统计',
    description: '字数、段落、表格、图片数量与预计阅读时长',
    reads: true,
    destructive: false,
    needsModel: false,
    requires: ['current_document'],
  },
  get_outline: {
    name: 'get_outline',
    label: '提取大纲',
    description: '按标题层级生成大纲，附段落序号',
    reads: true,
    destructive: false,
    needsModel: false,
    requires: ['current_document'],
  },
  search_document: {
    name: 'search_document',
    label: '全文检索',
    description: '按关键词检索，返回命中段落与位置',
    reads: true,
    destructive: false,
    needsModel: false,
    requires: ['current_document'],
  },
  check_tables: {
    name: 'check_tables',
    label: '表格检查',
    description: '列数不一致、空单元格、缺少表头',
    reads: true,
    destructive: false,
    needsModel: false,
    requires: ['current_document'],
  },
  check_headings: {
    name: 'check_headings',
    label: '标题检查',
    description: '标题跳级、缺少一级标题、多个一级标题',
    reads: true,
    destructive: false,
    needsModel: false,
    requires: ['current_document'],
  },
  check_duplicates: {
    name: 'check_duplicates',
    label: '重复段落检查',
    description: '查找内容相同或高度相似的段落',
    reads: true,
    destructive: false,
    needsModel: false,
    requires: ['current_document'],
  },
  diagnose_report: {
    name: 'diagnose_report',
    label: '文档体检',
    description: '汇总以上检查，生成按位置排序的问题清单',
    reads: true,
    destructive: false,
    needsModel: false,
    requires: ['current_document'],
  },
}

/* ---------------- 基础工具函数 ---------------- */

const stripTags = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** 按块切分 HTML（h1-h6 / p / li / table），用于没有结构化数据时兜底 */
export function splitBlocks(html: string): DocBlock[] {
  const blocks: DocBlock[] = []
  const re = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase()
    const inner = m[2]
    if (tag === 'table') {
      blocks.push({ type: 'table', html: `<table>${inner}</table>`, text: stripTags(inner) })
    } else if (tag.startsWith('h')) {
      blocks.push({ type: 'heading', level: Number(tag[1]), html: `<${tag}>${inner}</${tag}>`, text: stripTags(inner) })
    } else {
      // 统一类型：p → paragraph，li → list（否则下游按 type 过滤会漏）
      const type = tag === 'p' ? 'paragraph' : tag === 'li' ? 'list' : tag
      blocks.push({ type, html: `<${tag}>${inner}</${tag}>`, text: stripTags(inner) })
    }
  }
  return blocks
}

/** 取文档块：优先用解析器产出的 docxItems，否则从 HTML 切 */
export function blocksOf(doc: DocLike): DocBlock[] {
  if (doc.docxItems?.length) return doc.docxItems
  return splitBlocks(doc.html ?? '')
}

const plainTextOf = (doc: DocLike): string => {
  if (doc.text) return doc.text
  const parts = blocksOf(doc).map((b) => b.text ?? stripTags(b.html))
  return parts.filter(Boolean).join('\n')
}

/* ---------------- 统计 ---------------- */

export interface Stats {
  chars: number
  charsNoSpace: number
  paragraphs: number
  headings: number
  tables: number
  images: number
  lists: number
  readingMinutes: number
}

export function getStats(doc: DocLike): Stats {
  const text = plainTextOf(doc)
  const blocks = blocksOf(doc)
  const chars = text.length
  const charsNoSpace = text.replace(/\s/g, '').length
  // 中文按 350 字/分钟，英文按 200 词/分钟，取较保守的混算
  const readingMinutes = Math.max(1, Math.round(charsNoSpace / 350))
  return {
    chars,
    charsNoSpace,
    paragraphs: blocks.filter((b) => b.type === 'paragraph' || b.type === 'p').length,
    headings: blocks.filter((b) => b.type === 'heading').length,
    tables: blocks.filter((b) => b.type === 'table').length,
    images: (doc.html ?? '').match(/<img\b/gi)?.length ?? 0,
    lists: blocks.filter((b) => b.type === 'list' || b.type === 'li').length,
    readingMinutes,
  }
}

/* ---------------- 大纲 ---------------- */

export interface OutlineItem {
  level: number
  text: string
  blockIndex: number
}

export function getOutline(doc: DocLike): OutlineItem[] {
  return blocksOf(doc)
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.type === 'heading')
    .map(({ b, i }) => ({ level: b.level ?? 1, text: (b.text ?? stripTags(b.html)).slice(0, 80), blockIndex: i }))
}

/* ---------------- 检索 ---------------- */

export interface SearchHit {
  blockIndex: number
  snippet: string
  position: number
}

export function searchDocument(doc: DocLike, query: string, opts: { regex?: boolean; limit?: number } = {}): SearchHit[] {
  const limit = opts.limit ?? 20
  const q = query.trim()
  if (!q) return []
  let test: (s: string) => number
  if (opts.regex) {
    let re: RegExp
    try {
      re = new RegExp(q, 'i')
    } catch {
      return []
    }
    test = (s) => s.search(re)
  } else {
    const lower = q.toLowerCase()
    test = (s) => s.toLowerCase().indexOf(lower)
  }

  const hits: SearchHit[] = []
  blocksOf(doc).forEach((b, i) => {
    const text = b.text ?? stripTags(b.html)
    const pos = test(text)
    if (pos >= 0) {
      const from = Math.max(0, pos - 30)
      hits.push({
        blockIndex: i,
        position: pos,
        snippet: (from > 0 ? '…' : '') + text.slice(from, pos + q.length + 40) + '…',
      })
    }
  })
  return hits.slice(0, limit)
}

/* ---------------- 问题模型 ---------------- */

export type Severity = 'error' | 'warning' | 'info'

export interface Issue {
  code: string
  severity: Severity
  title: string
  detail: string
  blockIndex?: number
  tableIndex?: number
  fixable: boolean
  fixHint?: string
}

/* ---------------- 表格检查 ---------------- */

const rowCells = (rowHtml: string): string[] => {
  const cells: string[] = []
  const re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(rowHtml))) cells.push(stripTags(m[2]))
  return cells
}

export function parseTableRows(tableHtml: string): string[][] {
  const rows: string[][] = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(tableHtml))) rows.push(rowCells(m[1]))
  return rows
}

export function checkTables(doc: DocLike): Issue[] {
  const issues: Issue[] = []
  const tables = blocksOf(doc)
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.type === 'table')

  tables.forEach(({ b, i }, ti) => {
    const rows = parseTableRows(b.html)
    if (!rows.length) {
      issues.push({
        code: 'TABLE_EMPTY',
        severity: 'warning',
        title: `第 ${ti + 1} 个表格没有可解析的行`,
        detail: '可能是嵌套表格或结构异常，编辑器里可能显示为空白',
        blockIndex: i,
        tableIndex: ti,
        fixable: false,
      })
      return
    }

    const widths = rows.map((r) => r.length)
    const max = Math.max(...widths)
    const odd = widths.map((w, idx) => ({ w, idx })).filter(({ w }) => w !== max)
    if (odd.length) {
      issues.push({
        code: 'TABLE_ROW_WIDTH',
        severity: 'error',
        title: `第 ${ti + 1} 个表格列数不一致`,
        detail: `最多 ${max} 列，但第 ${odd.map((o) => o.idx + 1).join('、')} 行只有 ${
          odd[0].w
        } 列。粘贴到 Word 里常表现为表格错位。`,
        blockIndex: i,
        tableIndex: ti,
        fixable: true,
        fixHint: '补齐缺失单元格为空列',
      })
    }

    const emptyCells: string[] = []
    rows.forEach((r, ri) => r.forEach((c, ci) => c.trim() === '' && emptyCells.push(`第${ri + 1}行第${ci + 1}列`)))
    if (emptyCells.length && emptyCells.length <= 20) {
      issues.push({
        code: 'TABLE_EMPTY_CELL',
        severity: 'info',
        title: `第 ${ti + 1} 个表格有 ${emptyCells.length} 个空单元格`,
        detail: emptyCells.slice(0, 10).join('、') + (emptyCells.length > 10 ? ' 等' : ''),
        blockIndex: i,
        tableIndex: ti,
        fixable: false,
      })
    }

    if (rows[0]?.some((c) => c.trim() !== '') && !/<th\b/i.test(b.html)) {
      issues.push({
        code: 'TABLE_NO_HEADER',
        severity: 'info',
        title: `第 ${ti + 1} 个表格没有表头`,
        detail: '首行看起来是表头，但没有使用表头标记；转成 markdown 时会变成普通行',
        blockIndex: i,
        tableIndex: ti,
        fixable: false,
      })
    }
  })

  return issues
}

/* ---------------- 标题检查 ---------------- */

export function checkHeadings(doc: DocLike): Issue[] {
  const outline = getOutline(doc)
  const issues: Issue[] = []

  if (!outline.length) {
    issues.push({
      code: 'HEADING_NONE',
      severity: 'warning',
      title: '文档没有任何标题',
      detail: '没有标题就无法生成大纲，也不利于导航与检索',
      fixable: false,
    })
    return issues
  }

  const h1 = outline.filter((o) => o.level === 1)
  if (!h1.length) {
    issues.push({
      code: 'HEADING_NO_H1',
      severity: 'warning',
      title: '缺少一级标题',
      detail: '建议至少有一个一级标题作为文档主题',
      fixable: false,
    })
  }
  if (h1.length > 1) {
    issues.push({
      code: 'HEADING_MULTI_H1',
      severity: 'warning',
      title: `有 ${h1.length} 个一级标题`,
      detail: `分别在第 ${h1.map((o) => o.blockIndex + 1).join('、')} 块。若它们是并列章节，建议降为二级标题`,
      fixable: false,
    })
  }

  for (let i = 1; i < outline.length; i++) {
    const prev = outline[i - 1]
    const cur = outline[i]
    if (cur.level - prev.level > 1) {
      issues.push({
        code: 'HEADING_SKIP',
        severity: 'warning',
        title: `标题跳级：h${prev.level} → h${cur.level}`,
        detail: `「${cur.text}」跳过了 h${prev.level + 1}，导航层级会断掉`,
        blockIndex: cur.blockIndex,
        fixable: true,
        fixHint: `改为 h${prev.level + 1}`,
      })
    }
  }
  return issues
}

/* ---------------- 重复段落 ---------------- */

const normalize = (s: string) => s.replace(/\s/g, '').toLowerCase()

export function checkDuplicates(doc: DocLike, minChars = 15): Issue[] {
  const seen = new Map<string, number>()
  const issues: Issue[] = []
  blocksOf(doc).forEach((b, i) => {
    if (b.type !== 'paragraph' && b.type !== 'p') return
    const text = (b.text ?? stripTags(b.html)).trim()
    if (text.length < minChars) return
    const key = normalize(text)
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, i)
    } else {
      issues.push({
        code: 'DUP_PARAGRAPH',
        severity: 'warning',
        title: `第 ${i + 1} 块与第 ${first + 1} 块内容重复`,
        detail: text.slice(0, 50) + (text.length > 50 ? '…' : ''),
        blockIndex: i,
        fixable: false,
      })
    }
  })
  return issues
}

/* ---------------- 汇总体检 ---------------- */

export interface DiagnoseResult {
  issues: Issue[]
  counts: { error: number; warning: number; info: number }
  stats: Stats
}

export function diagnoseReport(doc: DocLike): DiagnoseResult {
  const issues = [...checkTables(doc), ...checkHeadings(doc), ...checkDuplicates(doc)].sort((a, b) => {
    const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
    const d = order[a.severity] - order[b.severity]
    if (d !== 0) return d
    return (a.blockIndex ?? 1e9) - (b.blockIndex ?? 1e9)
  })
  return {
    issues,
    counts: {
      error: issues.filter((i) => i.severity === 'error').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
    stats: getStats(doc),
  }
}

/* ---------------- 表格导出 ---------------- */

const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export function tableToCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n')
}

export function tableToMarkdown(rows: string[][]): string {
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
  const head = pad(rows[0])
  const body = rows.slice(1).map(pad)
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(head), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join('\n')
}
