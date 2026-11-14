import { entryBytes, listByPrefix, unzip, type ZipArchive } from './zip'
import { attr, childElements, descendants, escapeXml, firstChild, firstDescendant, parseXmlFromZip } from './xml'

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

export interface ImageAsset {
  src: string
  width?: number
  height?: number
  name: string
}

export interface DocxRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export interface DocxItem {
  type: 'paragraph' | 'table' | 'image'
  html: string
  text: string
  level?: number
  listMarker?: string
  listType?: 'ul' | 'ol'
  rows?: string[][]
}

export interface DocxParseResult {
  items: DocxItem[]
  html: string
  plainText: string
  images: ImageAsset[]
  warnings: string[]
  paragraphCount: number
  firstParagraph: string
}

export interface ParseOptions {
  includeImages?: boolean
}

const EMU_PER_PX = 9525

type ImageExt = 'png' | 'jpeg' | 'gif'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

const UNSUPPORTED = new Set(['emf', 'wmf'])

export const LIST_FORMATS: Record<string, 'decimal' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman'> = {
  decimal: 'decimal',
  decimalZero: 'decimal',
  lowerLetter: 'lowerLetter',
  upperLetter: 'upperLetter',
  lowerRoman: 'lowerRoman',
  upperRoman: 'upperRoman',
  ordinal: 'decimal',
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

function toNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim()
  if (/^(https?:|data:image\/)/i.test(trimmed)) return trimmed
  return null
}

/* ------------------------------------------------------------------ */
/* 编号（word/numbering.xml）                                          */
/* ------------------------------------------------------------------ */

interface LevelFormat {
  numFmt: string
  lvlText: string
  start: number
  suffix: string
}

interface NumberingMap {
  /** numId → abstractNumId */
  numToAbstract: Map<string, string>
  /** abstractNumId → ilvl → 格式 */
  levels: Map<string, Map<number, LevelFormat>>
}

function buildNumbering(doc: Document | null): NumberingMap {
  const numToAbstract = new Map<string, string>()
  const levels = new Map<string, Map<number, LevelFormat>>()
  if (!doc) return { numToAbstract, levels }

  descendants(doc, 'num').forEach((num) => {
    const numId = attr(num, 'numId')
    const abstract = firstChild(num, 'abstractNumId')
    const abstractId = attr(abstract, 'val')
    if (numId && abstractId) numToAbstract.set(numId, abstractId)
  })

  descendants(doc, 'abstractNum').forEach((abstract) => {
    const id = attr(abstract, 'abstractNumId')
    if (!id) return
    const map = new Map<number, LevelFormat>()
    childElements(abstract, 'lvl').forEach((lvl) => {
      const ilvl = Number(attr(lvl, 'ilvl') ?? '0')
      const numFmt = attr(firstChild(lvl, 'numFmt'), 'val') ?? 'bullet'
      const lvlText = attr(firstChild(lvl, 'lvlText'), 'val') ?? ''
      const start = Number(attr(firstChild(lvl, 'start'), 'val') ?? '1')
      const suffix = attr(firstChild(lvl, 'suff'), 'val') ?? 'space'
      map.set(Number.isFinite(ilvl) ? ilvl : 0, {
        numFmt,
        lvlText,
        start: Number.isFinite(start) && start > 0 ? start : 1,
        suffix,
      })
    })
    levels.set(id, map)
  })

  return { numToAbstract, levels }
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

/**
 * 字母编号：1→a、26→z、27→aa（Word 的行为，不是绕回 a）
 * base 是 'a' 或 'A' 的码点。
 */
function letters(value: number, base: number): string {
  let n = Math.max(1, Math.floor(value)) - 1
  let out = ''
  do {
    out = String.fromCodePoint(base + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

export function formatCounter(value: number, numFmt: string): string {
  switch (numFmt) {
    case 'lowerLetter':
      return letters(value, 97)
    case 'upperLetter':
      return letters(value, 65)
    case 'lowerRoman':
    case 'upperRoman': {
      let n = value
      let out = ''
      for (const [unit, glyph] of ROMAN) {
        while (n >= unit) {
          out += glyph
          n -= unit
        }
      }
      return numFmt === 'upperRoman' ? out.toUpperCase() : out
    }
    case 'decimalZero':
      return value < 10 ? `0${value}` : String(value)
    default:
      return String(value)
  }
}

/**
 * 把 lvlText（如 "%1.%2"）中的占位符替换为各级计数器。
 * 未出现的层级按 counter 数组回填。
 */
function renderLvlText(lvlText: string, counters: number[], formats: Map<number, LevelFormat>) {
  if (!lvlText) return ''
  return lvlText.replace(/%([1-9])/g, (_, d: string) => {
    const idx = Number(d) - 1
    const value = counters[idx] ?? 1
    const fmt = formats.get(idx)?.numFmt ?? 'decimal'
    return formatCounter(value, fmt)
  })
}

interface ListState {
  counters: number[]
  lastNumId: string | null
}

/* ------------------------------------------------------------------ */
/* 关系（图片）                                                          */
/* ------------------------------------------------------------------ */

function loadRelations(archive: ZipArchive | null): Map<string, string> {
  const map = new Map<string, string>()
  const doc = parseXmlFromZip(archive, 'word/_rels/document.xml.rels')
  if (!doc) return map
  descendants(doc, 'Relationship').forEach((rel) => {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (id && target) map.set(id, target)
  })
  return map
}

function resolveMediaPath(target: string): string {
  const clean = target.replace(/^\.\//, '')
  if (clean.startsWith('word/')) return clean
  if (clean.startsWith('/')) return clean.slice(1)
  return `word/${clean}`
}

function findMediaEntry(archive: ZipArchive | null, path: string): { bytes: Uint8Array; ext: string } | null {
  if (!archive) return null
  const wanted = path.toLowerCase()
  const exact = entryBytes(archive, wanted)
  if (exact) return { bytes: exact, ext: wanted.split('.').pop() ?? '' }
  const base = wanted.split('/').pop() ?? ''
  const match = listByPrefix(archive, 'word/media/').find((name) => name.toLowerCase().endsWith('/' + base))
  if (match) {
    const bytes = entryBytes(archive, match)
    if (bytes) return { bytes, ext: match.split('.').pop()?.toLowerCase() ?? '' }
  }
  return null
}

function imagePlaceholder(alt: string, reason: string) {
  return `<span class="lo-img-placeholder" data-placeholder="1">🖼 ${escapeXml(alt)} · ${escapeXml(reason)}</span>`
}

type ImageResolver = (rels: Map<string, string>, embed: string) => { src: string; reason?: string; name: string }

/* ------------------------------------------------------------------ */
/* 段落内容                                                            */
/* ------------------------------------------------------------------ */

/** 把 w:drawing 转成 <img>（或占位），从 extractRunHtml 里抽出来降复杂度 */
function drawingToHtml(
  child: Element,
  resolveImage: ImageResolver | null,
  rels: Map<string, string>,
): string {
  const blip = firstDescendant(child, 'blip')
  const embed = attr(blip, 'embed') ?? attr(blip, 'link')
  const extent = firstDescendant(child, 'extent')
  const docPr = firstDescendant(child, 'docPr')
  const alt = attr(docPr, 'descr') ?? attr(docPr, 'name') ?? '内嵌图片'
  if (!embed || !resolveImage) return imagePlaceholder(alt, '无法读取引用')

  const resolved = resolveImage(rels, embed)
  if (!resolved.src) return imagePlaceholder(alt, resolved.reason ?? '格式暂不支持预览')
  const safeSrc = sanitizeUrl(resolved.src)
  if (!safeSrc) return imagePlaceholder(alt, '图片来源未通过安全校验')

  const cx = toNumber(attr(extent, 'cx'))
  const cy = toNumber(attr(extent, 'cy'))
  const width = cx ? Math.round(cx / EMU_PER_PX) : undefined
  const height = cy ? Math.round(cy / EMU_PER_PX) : undefined
  const size = width ? ` width="${width}"` : ''
  const hsize = height ? ` height="${height}"` : ''
  return `<img src="${safeSrc}" alt="${escapeXml(alt)}"${size}${hsize} loading="lazy" />`
}

function extractRunHtml(run: Element, resolveImage: ImageResolver | null, rels: Map<string, string>): string {
  let html = ''
  childElements(run).forEach((child) => {
    const tag = child.localName
    if (tag === 't') {
      html += escapeXml(child.textContent ?? '')
    } else if (tag === 'tab') {
      html += '<span class="lo-tab">&emsp;</span>'
    } else if (tag === 'br') {
      html += '<br />'
    } else if (tag === 'drawing') {
      html += drawingToHtml(child, resolveImage, rels)
    }
  })
  return html
}

function paragraphRuns(paragraph: Element, resolveImage: ImageResolver | null, rels: Map<string, string>) {
  const runs: DocxRun[] = []
  let html = ''
  let hasImage = false
  // 只处理直接子 run，避免把嵌套段落（如文本框）里的 run 重复渲染
  const runNodes: Element[] = []
  const collectRuns = (node: Element) => {
    childElements(node).forEach((child) => {
      if (child.localName === 'r') runNodes.push(child)
      else if (child.localName !== 'p' && child.localName !== 'pPr' && child.localName !== 'tbl') collectRuns(child)
    })
  }
  collectRuns(paragraph)
  runNodes.forEach((run) => {
    const props = firstChild(run, 'rPr')
    const bold = !!props && (firstChild(props, 'b') !== null) && attr(firstChild(props, 'b'), 'val') !== '0'
    const italic = !!props && (firstChild(props, 'i') !== null) && attr(firstChild(props, 'i'), 'val') !== '0'
    const underlineEl = props ? firstChild(props, 'u') : null
    const underline = !!underlineEl && attr(underlineEl, 'val') !== 'none'
    let text = ''
    childElements(run).forEach((child) => {
      if (child.localName === 't') text += child.textContent ?? ''
      else if (child.localName === 'tab') text += '\t'
      else if (child.localName === 'br') text += '\n'
    })
    if (descendants(run, 'drawing').length > 0) hasImage = true
    if (text.trim()) runs.push({ text, bold, italic, underline })

    const inner = extractRunHtml(run, resolveImage, rels)
    let wrapped = inner
    if (underline) wrapped = `<u>${wrapped}</u>`
    if (italic) wrapped = `<em>${wrapped}</em>`
    if (bold) wrapped = `<strong>${wrapped}</strong>`
    html += wrapped
  })
  return { html: html.trim(), text: runs.map((r) => r.text).join(' ').trim(), hasImage }
}

function headingLevel(paragraph: Element): number | undefined {
  const props = firstChild(paragraph, 'pPr')
  if (!props) return undefined
  const style = attr(firstChild(props, 'pStyle'), 'val')
  if (style) {
    const match = /^(?:heading|Heading|\u6807\u9898)\s*(\d)$/.exec(style) ?? /^Heading(\d)$/.exec(style)
    if (match) return Math.min(Number(match[1]), 6)
    if (/^Title$/i.test(style)) return 1
  }
  const outline = attr(firstChild(props, 'outlineLvl'), 'val')
  if (outline !== null && outline !== undefined) {
    const n = Number(outline)
    if (Number.isFinite(n) && n >= 0 && n < 6) return n + 1
  }
  return undefined
}

function tableToHtml(table: Element, resolveImage: ImageResolver | null, rels: Map<string, string>) {
  const rows = childElements(table, 'tr')
  const htmlRows: string[] = []
  const dataRows: string[][] = []
  rows.forEach((row) => {
    const cells = childElements(row, 'tc')
    const cellHtml: string[] = []
    const cellText: string[] = []
    cells.forEach((cell) => {
      const spans = childElements(cell, 'tcPr')
        .map((pr) => attr(firstChild(pr, 'gridSpan'), 'val'))
        .find(Boolean)
      const span = spans ? Number(spans) : 1
      const spanAttr = span > 1 ? ` colspan="${span}"` : ''
      const paragraphs = childElements(cell, 'p')
      const inner = paragraphs
        .map((p) => paragraphRuns(p, resolveImage, rels).html || '&nbsp;')
        .join('<br />')
      cellHtml.push(`<td${spanAttr}>${inner}</td>`)
      cellText.push(paragraphs.map((p) => paragraphRuns(p, null, rels).text).join(' '))
    })
    dataRows.push(cellText)
    htmlRows.push(`<tr>${cellHtml.join('')}</tr>`)
  })
  return { html: `<table><tbody>${htmlRows.join('')}</tbody></table>`, rows: dataRows }
}

function itemToHtml(item: DocxItem): string {
  if (item.type === 'table' || item.type === 'image') return item.html
  if (item.level) return `<h${item.level}>${item.html}</h${item.level}>`
  if (item.listType === 'ol') return `<div class="lo-li" data-list="ol">${item.html}</div>`
  if (item.listType === 'ul') return `<div class="lo-li" data-list="ul">${item.html}</div>`
  return item.html ? `<p>${item.html}</p>` : ''
}

interface ListMarker {
  listMarker?: string
  listType: 'ol' | 'ul' | null
}

/**
 * 根据 numId / ilvl 算出这一段的列表标记，并把计数器推进一格。
 * 从 handleParagraph 里抽出来：那段的分支太多，认知复杂度 22。
 */
function listMarkerFor(
  numId: string | null,
  ilvlRaw: string | null,
  numbering: NumberingMap,
  state: ListState,
): ListMarker {
  if (!numId || numId === '0') return { listType: null }
  const abstractId = numbering.numToAbstract.get(numId)
  if (!abstractId) return { listType: null }

  const ilvl = ilvlRaw ? Number(ilvlRaw) : 0
  const formats = numbering.levels.get(abstractId) ?? new Map<number, LevelFormat>()
  const format = formats.get(ilvl)

  if (!state.counters.length) state.counters = [0, 0, 0, 0, 0, 0, 0, 0]
  state.counters[ilvl] = (state.counters[ilvl] ?? 0) + 1
  // 回到浅层时清空更深层级，否则 2.1 之后会变成 2.2 而不是 1.1
  for (let i = ilvl + 1; i < state.counters.length; i++) state.counters[i] = 0

  if (!format || format.lvlText === '') {
    const fallback = formats.get(0)
    const marker = fallback
      ? renderLvlText(fallback.lvlText || '%1.', state.counters, formats)
      : `${state.counters[ilvl]}.`
    return { listMarker: marker.trim(), listType: 'ol' }
  }
  if (format.numFmt === 'bullet' || format.numFmt === 'none') return { listType: 'ul' }

  const marker = renderLvlText(format.lvlText || `%${ilvl + 1}.`, state.counters, formats)
  return { listMarker: marker.trim(), listType: 'ol' }
}

/* ------------------------------------------------------------------ */
/* 主解析                                                              */
/* ------------------------------------------------------------------ */

export async function parseDocx(input: ArrayBuffer, options: ParseOptions = {}): Promise<DocxParseResult> {
  const includeImages = options.includeImages !== false
  const warnings: string[] = []
  const archive = await unzip(input)
  const docXml = parseXmlFromZip(archive, 'word/document.xml')
  if (!docXml) throw new Error('无法读取 word/document.xml，文档可能已损坏')
  const numberingXml = parseXmlFromZip(archive, 'word/numbering.xml')
  const numbering = buildNumbering(numberingXml)
  const rels = loadRelations(archive)

  const imageCache = new Map<string, { src: string; reason?: string; name: string }>()
  const resolveImage: ImageResolver = (relationMap, embed) => {
    if (!includeImages) return { src: '', reason: '图片预览已关闭', name: '' }
    const cached = imageCache.get(embed)
    if (cached) return cached
    const target = relationMap.get(embed)
    if (!target) {
      const missing = { src: '', reason: '找不到图片引用', name: '' }
      imageCache.set(embed, missing)
      return missing
    }
    const media = findMediaEntry(archive, resolveMediaPath(target))
    const ext = (media?.ext ?? target.split('.').pop() ?? '').toLowerCase()
    let resolved: { src: string; reason?: string; name: string }
    if (!media) {
      resolved = { src: '', reason: '图片数据缺失', name: ext }
    } else if (UNSUPPORTED.has(ext)) {
      resolved = { src: '', reason: `${ext.toUpperCase()} 格式暂不支持预览`, name: ext }
    } else {
      const mime = MIME_BY_EXT[ext] ?? 'image/png'
      resolved = {
        src: `data:${mime};base64,${bytesToBase64(media.bytes)}`,
        name: ext,
      }
    }
    imageCache.set(embed, resolved)
    return resolved
  }

  const body = firstDescendant(docXml, 'body')
  if (!body) throw new Error('文档正文为空')

  const items: DocxItem[] = []
  const images: ImageAsset[] = []
  const listState: ListState = { counters: [], lastNumId: null }
  let paragraphCount = 0
  let firstParagraph = ''

  const handleParagraph = (paragraph: Element) => {
    paragraphCount++
    const props = firstChild(paragraph, 'pPr')
    const numPr = props ? firstChild(props, 'numPr') : null
    const numId = numPr ? attr(firstChild(numPr, 'numId'), 'val') : null
    const ilvlRaw = numPr ? attr(firstChild(numPr, 'ilvl'), 'val') : null
    const level = headingLevel(paragraph)
    const content = paragraphRuns(paragraph, resolveImage, rels)
    if (!firstParagraph && content.text) firstParagraph = content.text

    // 收集本段图片
    descendants(paragraph, 'blip').forEach((blip) => {
      const embed = attr(blip, 'embed')
      if (!embed) return
      const resolved = imageCache.get(embed)
      if (resolved?.src) images.push({ src: resolved.src, name: resolved.name })
    })

    const marker = listMarkerFor(numId, ilvlRaw, numbering, listState)
    if (marker.listType) {
      items.push({
        type: 'paragraph',
        html: content.html,
        text: content.text,
        listMarker: marker.listMarker,
        listType: marker.listType,
      })
      return
    }

    if (content.hasImage && !content.text) {
      items.push({ type: 'image', html: content.html, text: '[图片]' })
      return
    }

    items.push({ type: 'paragraph', html: content.html, text: content.text, level })
  }

  childElements(body).forEach((node) => {
    try {
      if (node.localName === 'p') handleParagraph(node)
      else if (node.localName === 'tbl') {
        const table = tableToHtml(node, resolveImage, rels)
        items.push({ type: 'table', html: table.html, text: table.rows.map((r) => r.join(' ')).join('\n'), rows: table.rows })
      } else if (node.localName === 'sdt') {
        // 结构化内容控件：把内部段落扁平处理
        descendants(node, 'p').forEach((p) => handleParagraph(p))
      }
    } catch {
      // 单节点失败只跳过
      paragraphCount++
    }
  })

  const hasReadable = items.some((item) => item.html.trim() || item.text.trim())
  if (!hasReadable) {
    warnings.push('部分内容无法解析，已展示可读部分')
  }

  // 有序 / 无序列表需要合并成连续块
  const html = renderItems(items)
  const plainText = items
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n')
  return {
    items,
    html,
    plainText,
    images,
    warnings,
    paragraphCount,
    firstParagraph: firstParagraph || (items.find((i) => i.text)?.text ?? ''),
  }
}

/** 把 item 列表渲染为连续合法的 HTML（ul/ol 包裹）。 */
export function renderItems(items: DocxItem[]): string {
  const out: string[] = []
  let listBuffer: { type: 'ul' | 'ol'; items: string[] } | null = null

  const flush = () => {
    if (!listBuffer) return
    out.push(`<${listBuffer.type}>${listBuffer.items.join('')}</${listBuffer.type}>`)
    listBuffer = null
  }

  items.forEach((item) => {
    if (item.type === 'paragraph' && item.listType) {
      if (listBuffer?.type !== item.listType) {
        flush()
        listBuffer = { type: item.listType, items: [] }
      }
      const markerText = item.listMarker ? escapeXml(item.listMarker) : ''
      const marker = item.listType === 'ol' && markerText ? `<span class="lo-marker">${markerText}</span> ` : ''
      listBuffer.items.push(`<li>${marker}${item.html || '&nbsp;'}</li>`)
      return
    }
    flush()
    out.push(itemToHtml(item))
  })
  flush()
  return out.filter(Boolean).join('\n')
}

/* ------------------------------------------------------------------ */
/* 导出回写（docx）                                                     */
/* ------------------------------------------------------------------ */

export interface DocxBlock {
  type: 'heading' | 'paragraph' | 'list' | 'table' | 'code'
  level?: number
  ordered?: boolean
  text?: string
  runHtml?: string
  rows?: string[][]
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function runsFromRunHtml(html: string, ctx?: BuildContext): string {
  // 极简解析 <strong>/<em>/<u> 包装，以 w:rPr 表达格式
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html')
  const root = doc.getElementById('r')
  if (!root) return ''
  const out: string[] = []
  const walk = (node: Node, style: { b?: boolean; i?: boolean; u?: boolean }) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const text = child.textContent ?? ''
        if (!text) return
        const props = [style.b ? '<w:b/>' : '', style.i ? '<w:i/>' : '', style.u ? '<w:u w:val="single"/>' : ''].join('')
        const rPr = props ? `<w:rPr>${props}</w:rPr>` : ''
        out.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`)
        return
      }
      if (child.nodeType !== 1) return
      const el = child as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (tag === 'br') {
        out.push('<w:r><w:br/></w:r>')
        return
      }
      if (tag === 'img' && ctx) {
        out.push(imageRunXml(el, ctx))
        return
      }
      walk(el, {
        b: style.b || tag === 'strong' || tag === 'b',
        i: style.i || tag === 'em' || tag === 'i',
        u: style.u || tag === 'u',
      })
    })
  }
  walk(root, {})
  return out.join('')
}

function numberingDefinitions() {
  const bulletLevels = Array.from({ length: 9 })
    .map(
      (_, i) =>
        `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl>`,
    )
    .join('')
  const decimalLevels = Array.from({ length: 9 })
    .map(
      (_, i) =>
        `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/></w:lvl>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}">
<w:abstractNum w:abstractNumId="1">${bulletLevels}</w:abstractNum>
<w:abstractNum w:abstractNumId="2">${decimalLevels}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`
}

/* ---------------- 图片写回（buildDocx 专用） ---------------- */

const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
const EMU_PER_PX_EMBED = 9525
const DEFAULT_IMAGE_WIDTH_PX = 600

/** 导出报告：让调用方（自检脚本 / 界面提示）拿到被跳过的图片，不静默丢弃 */
export interface DocxExportReport {
  imagesEmbedded: number
  imagesSkipped: { src: string; reason: string }[]
  extensions: string[]
}

interface MediaEntry {
  fileName: string
  bytes: Uint8Array
  ext: ImageExt
}

interface BuildContext {
  media: MediaEntry[]
  rels: { id: string; target: string }[]
  nextRelId: number
  nextDrawingId: number
  report: DocxExportReport
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

function emptyReport(): DocxExportReport {
  return { imagesEmbedded: 0, imagesSkipped: [], extensions: [] }
}

/** data URL → 真实二进制；非 base64 / 非支持的 MIME 返回原因 */
type DecodedImage = { bytes: Uint8Array; ext: ImageExt }
type DecodeFailure = { reason: string }

function pickImageExt(mime: string): ImageExt | '' {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg'
  if (mime === 'image/gif') return 'gif'
  return ''
}

function decodeDataUrl(src: string): DecodedImage | DecodeFailure {
  const trimmed = src.trim()
  if (!/^data:/i.test(trimmed)) return { reason: '不是 data URL（外链图片不会写进 docx）' }
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(trimmed)
  if (!match) return { reason: '不是 base64 编码的 data URL' }
  const mime = match[1].toLowerCase()
  const ext = pickImageExt(mime)
  if (!ext) return { reason: `${mime} 暂不支持写回（仅支持 png / jpeg / gif）` }
  try {
    const binary = atob(match[2].replace(/\s/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0
    if (!bytes.length) return { reason: '图片二进制为空' }
    return { bytes, ext: ext as ImageExt }
  } catch {
    return { reason: 'base64 解码失败' }
  }
}

interface ImageSize {
  width: number
  height: number
}

function sizeFromPng(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 24) return null
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function sizeFromGif(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 10) return null
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  return width > 0 && height > 0 ? { width, height } : null
}

/** JPEG：扫描 SOFn 段（逐段跳过，遇到 SOF 就取宽高） */
function sizeFromJpeg(bytes: Uint8Array, view: DataView): ImageSize | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]
    const skip = marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)
    if (skip) {
      offset += 2
      continue
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = view.getUint16(offset + 5)
      const width = view.getUint16(offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    const length = view.getUint16(offset + 2)
    if (length < 2) return null
    offset += 2 + length
  }
  return null
}

/** 从文件头读像素尺寸，读不到返回 null */
function readImageSize(bytes: Uint8Array, ext: ImageExt): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (ext === 'png') return sizeFromPng(bytes, view)
    if (ext === 'gif') return sizeFromGif(bytes, view)
    return sizeFromJpeg(bytes, view)
  } catch {
    return null
  }
}

/** 像素 → EMU，保证不出现 0 或负值 */
function emuFromPx(px: number): number {
  return Math.max(EMU_PER_PX_EMBED, Math.round(Math.max(1, px) * EMU_PER_PX_EMBED))
}

/** 计算落盘尺寸：优先 width/height 属性，缺失按 600px 宽等比 */
function imageDisplaySize(el: HTMLElement, bytes: Uint8Array, ext: ImageExt) {
  const natural = readImageSize(bytes, ext)
  const attrWidth = Number(el.getAttribute('width'))
  const attrHeight = Number(el.getAttribute('height'))
  let width = Number.isFinite(attrWidth) && attrWidth > 0 ? attrWidth : 0
  let height = Number.isFinite(attrHeight) && attrHeight > 0 ? attrHeight : 0
  const ratio = natural ? natural.height / natural.width : 0.75
  if (!width && !height) {
    width = DEFAULT_IMAGE_WIDTH_PX
    height = Math.round(DEFAULT_IMAGE_WIDTH_PX * ratio)
  } else if (!width) {
    width = Math.round(height / ratio)
  } else if (!height) {
    height = Math.round(width * ratio)
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
}

/** 生成 <w:r><w:drawing><wp:inline>…<a:blip r:embed="rIdN"/></w:drawing></w:r> */
function imageRunXml(el: HTMLElement, ctx: BuildContext): string {
  const src = el.getAttribute('src') ?? ''
  const alt = el.getAttribute('alt') ?? ''
  const decoded = decodeDataUrl(src)
  if ('reason' in decoded) {
    ctx.report.imagesSkipped.push({ src: src.slice(0, 64), reason: decoded.reason })
    return `<w:r><w:t xml:space="preserve">[图片未导出：${escapeXml(decoded.reason)}]</w:t></w:r>`
  }

  const altAttr = alt ? ` descr="${escapeXml(alt)}"` : ''
  const index = ctx.media.length + 1
  const fileName = `image${index}.${decoded.ext}`
  const relId = `rId${ctx.nextRelId++}`
  const drawingId = ctx.nextDrawingId++
  const { width, height } = imageDisplaySize(el, decoded.bytes, decoded.ext)
  const cx = emuFromPx(width)
  const cy = emuFromPx(height)

  ctx.media.push({ fileName, bytes: decoded.bytes, ext: decoded.ext })
  ctx.rels.push({ id: relId, target: `media/${fileName}` })
  ctx.report.imagesEmbedded += 1
  if (!ctx.report.extensions.includes(decoded.ext)) ctx.report.extensions.push(decoded.ext)

  return [
    '<w:r><w:drawing>',
    '<wp:inline distT="0" distB="0" distL="0" distR="0">',
    `<wp:extent cx="${cx}" cy="${cy}"/>`,
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
    `<wp:docPr id="${drawingId}" name="Picture ${drawingId}"${altAttr}/>`,
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>',
    `<a:graphic><a:graphicData uri="${PIC_NS}">`,
    '<pic:pic>',
    `<pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${fileName}"/><pic:cNvPicPr/></pic:nvPicPr>`,
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>',
    '</pic:pic></a:graphicData></a:graphic>',
    '</wp:inline></w:drawing></w:r>',
  ].join('')
}

/** 统计已有 document.xml.rels 里的 rId，避免新 Id 冲突 */
function nextRelationshipId(xml: string): number {
  let max = 0
  const re = /Id="rId(\d+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) max = Math.max(max, Number(match[1]))
  return max + 1
}

/** 把编辑后的 HTML 转成 docx 二进制（保留标题层级、列表、表格、内嵌图片）。 */
export function buildDocx(html: string, title = '文档', report?: DocxExportReport): Uint8Array {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  const bodyXml: string[] = []
  const ctx: BuildContext = {
    media: [],
    rels: [],
    nextRelId: nextRelationshipId(DOC_RELS),
    nextDrawingId: 1,
    report: report ?? emptyReport(),
  }
  if (report) {
    report.imagesEmbedded = 0
    report.imagesSkipped = []
    report.extensions = []
  }
  if (root) {
    Array.from(root.childNodes).forEach((node) => {
      if (node.nodeType === 3) {
        const text = node.textContent?.trim()
        if (text) bodyXml.push(`<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
        return
      }
      if (node.nodeType !== 1) return
      const el = node as HTMLElement
      const tag = el.tagName.toLowerCase()
      const heading = /^h([1-6])$/.exec(tag)
      if (heading) {
        const level = Number(heading[1])
        bodyXml.push(
          `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>${runsFromRunHtml(el.innerHTML, ctx)}</w:p>`,
        )
        return
      }
      if (tag === 'ul' || tag === 'ol') {
        const numId = tag === 'ol' ? 2 : 1
        Array.from(el.querySelectorAll('li')).forEach((li) => {
          bodyXml.push(
            `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runsFromRunHtml(li.innerHTML, ctx)}</w:p>`,
          )
        })
        return
      }
      if (tag === 'table') {
        const rows = Array.from(el.querySelectorAll('tr'))
        const cells = rows
          .map((row) => {
            const tds = Array.from(row.children)
              .map(
                (cell) =>
                  `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${runsFromRunHtml(cell.innerHTML, ctx) || '<w:r><w:t></w:t></w:r>'}</w:p></w:tc>`,
              )
              .join('')
            return `<w:tr>${tds}</w:tr>`
          })
          .join('')
        const tableXml = (`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9D9DE"/><w:left w:val="single" w:sz="4" w:color="D9D9DE"/><w:bottom w:val="single" w:sz="4" w:color="D9D9DE"/><w:right w:val="single" w:sz="4" w:color="D9D9DE"/><w:insideH w:val="single" w:sz="4" w:color="D9D9DE"/><w:insideV w:val="single" w:sz="4" w:color="D9D9DE"/></w:tblBorders></w:tblPr>${cells}</w:tbl>`)
        bodyXml.push(tableXml, '<w:p/>')
        return
      }
      if (tag === 'pre') {
        bodyXml.push(
          `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">${escapeXml(el.textContent ?? '')}</w:t></w:r></w:p>`,
        )
        return
      }
      if (tag === 'img') {
        // 图片写成真实 media + 关系 + w:drawing（不再用占位文字）
        const run = imageRunXml(el, ctx)
        bodyXml.push(run ? `<w:p>${run}</w:p>` : '')
        return
      }
      const runs = runsFromRunHtml(el.innerHTML, ctx)
      if (runs) bodyXml.push(`<w:p>${runs}</w:p>`)
    })
  }
  if (!bodyXml.length) bodyXml.push(`<w:p><w:r><w:t>${escapeXml(title)}</w:t></w:r></w:p>`)

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}"><w:body>${bodyXml.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

  const contentTypeDefaults = ctx.report.extensions
    .map((ext) => `<Default Extension="${ext}" ContentType="${IMAGE_MIME_BY_EXT[ext]}"/>`)
    .join('')
  const contentTypes = contentTypeDefaults
    ? CONTENT_TYPES.replace('</Types>', `${contentTypeDefaults}</Types>`)
    : CONTENT_TYPES

  const imageRelationships = ctx.rels
    .map(
      (rel) =>
        `<Relationship Id="${rel.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${rel.target}"/>`,
    )
    .join('')
  const docRels = imageRelationships ? DOC_RELS.replace('</Relationships>', `${imageRelationships}</Relationships>`) : DOC_RELS

  return zip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: STYLES_XML },
    { name: 'word/numbering.xml', content: numberingDefinitions() },
    { name: 'word/_rels/document.xml.rels', content: docRels },
    ...ctx.media.map((entry) => ({ name: `word/media/${entry.fileName}`, content: entry.bytes })),
    { name: 'docProps/core.xml', content: CORE_XML },
    { name: 'docProps/app.xml', content: APP_XML },
  ])
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="PingFang SC"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`

const CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>LiteOffice</dc:creator><cp:lastModifiedBy>LiteOffice</cp:lastModifiedBy><dc:title>LiteOffice 导出文档</dc:title></cp:coreProperties>`

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>LiteOffice</Application></Properties>`

// zip 在文件末尾导入，避免循环引用阅读困难
import { zip } from './zip'

export { parseXml } from './xml'
