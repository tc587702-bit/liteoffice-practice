import { entryBytes, listByPrefix, unzip, type ZipArchive } from './zip'
import { attr, childElements, descendants, escapeXml, firstChild, firstDescendant, parseXml, parseXmlFromZip } from './xml'

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
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
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

export function formatCounter(value: number, numFmt: string): string {
  switch (numFmt) {
    case 'lowerLetter':
      return String.fromCharCode(97 + ((value - 1) % 26))
    case 'upperLetter':
      return String.fromCharCode(65 + ((value - 1) % 26))
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
      // 内嵌图片：w:drawing → a:blip@r:embed
      const blip = firstDescendant(child, 'blip')
      const embed = attr(blip, 'embed') ?? attr(blip, 'link')
      const extent = firstDescendant(child, 'extent')
      const cx = toNumber(attr(extent, 'cx'))
      const cy = toNumber(attr(extent, 'cy'))
      const docPr = firstDescendant(child, 'docPr')
      const alt = attr(docPr, 'descr') ?? attr(docPr, 'name') ?? '内嵌图片'
      if (!embed || !resolveImage) {
        html += imagePlaceholder(alt, '无法读取引用')
        return
      }
      const resolved = resolveImage(rels, embed)
      if (!resolved.src) {
        html += imagePlaceholder(alt, resolved.reason ?? '格式暂不支持预览')
        return
      }
      const safeSrc = sanitizeUrl(resolved.src)
      if (!safeSrc) {
        html += imagePlaceholder(alt, '图片来源未通过安全校验')
        return
      }
      const width = cx ? Math.round(cx / EMU_PER_PX) : undefined
      const height = cy ? Math.round(cy / EMU_PER_PX) : undefined
      const size = width ? ` width="${width}"` : ''
      const hsize = height ? ` height="${height}"` : ''
      html += `<img src="${safeSrc}" alt="${escapeXml(alt)}"${size}${hsize} loading="lazy" />`
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

    if (numId && numId !== '0' && numbering.numToAbstract.has(numId)) {
      const ilvl = ilvlRaw ? Number(ilvlRaw) : 0
      const abstractId = numbering.numToAbstract.get(numId)!
      const formats = numbering.levels.get(abstractId) ?? new Map<number, LevelFormat>()
      const format = formats.get(ilvl)
      if (!listState.counters.length) listState.counters = [0, 0, 0, 0, 0, 0, 0, 0]
      // 换编号实例时重置更深层级
      listState.counters[ilvl] = (listState.counters[ilvl] ?? 0) + 1
      for (let i = ilvl + 1; i < listState.counters.length; i++) listState.counters[i] = 0
      if (!format || format.lvlText === '') {
        // 无格式信息时用显式数字向上查找
        const fallback = formats.get(0)
        const marker = fallback ? renderLvlText(fallback.lvlText || '%1.', listState.counters, formats) : `${listState.counters[ilvl]}.`
        items.push({
          type: 'paragraph',
          html: content.html,
          text: content.text,
          listMarker: marker.trim(),
          listType: 'ol',
        })
        return
      }
      const isBullet = format.numFmt === 'bullet' || format.numFmt === 'none'
      if (isBullet) {
        items.push({ type: 'paragraph', html: content.html, text: content.text, listType: 'ul' })
        return
      }
      const marker = renderLvlText(format.lvlText || `%${ilvl + 1}.`, listState.counters, formats)
      items.push({
        type: 'paragraph',
        html: content.html,
        text: content.text,
        listMarker: marker.trim(),
        listType: 'ol',
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
      if (!listBuffer || listBuffer.type !== item.listType) {
        flush()
        listBuffer = { type: item.listType, items: [] }
      }
      const marker = item.listType === 'ol' && item.listMarker ? `<span class="lo-marker">${escapeXml(item.listMarker)}</span> ` : ''
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

function runsFromRunHtml(html: string): string {
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
        out.push(
          `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`,
        )
        return
      }
      if (child.nodeType !== 1) return
      const el = child as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (tag === 'br') {
        out.push('<w:r><w:br/></w:r>')
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

/** 把编辑后的 HTML 转成 docx 二进制（保留标题层级、列表、表格）。 */
export function buildDocx(html: string, title = '文档'): Uint8Array {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  const bodyXml: string[] = []
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
          `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>${runsFromRunHtml(el.innerHTML)}</w:p>`,
        )
        return
      }
      if (tag === 'ul' || tag === 'ol') {
        const numId = tag === 'ol' ? 2 : 1
        Array.from(el.querySelectorAll('li')).forEach((li) => {
          bodyXml.push(
            `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runsFromRunHtml(li.innerHTML)}</w:p>`,
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
                  `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${runsFromRunHtml(cell.innerHTML) || '<w:r><w:t></w:t></w:r>'}</w:p></w:tc>`,
              )
              .join('')
            return `<w:tr>${tds}</w:tr>`
          })
          .join('')
        bodyXml.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9D9DE"/><w:left w:val="single" w:sz="4" w:color="D9D9DE"/><w:bottom w:val="single" w:sz="4" w:color="D9D9DE"/><w:right w:val="single" w:sz="4" w:color="D9D9DE"/><w:insideH w:val="single" w:sz="4" w:color="D9D9DE"/><w:insideV w:val="single" w:sz="4" w:color="D9D9DE"/></w:tblBorders></w:tblPr>${cells}</w:tbl>`)
        bodyXml.push('<w:p/>')
        return
      }
      if (tag === 'pre') {
        bodyXml.push(
          `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">${escapeXml(el.textContent ?? '')}</w:t></w:r></w:p>`,
        )
        return
      }
      if (tag === 'img') {
        // 图片无法在回写中可靠保留，写入占位段落
        bodyXml.push(`<w:p><w:r><w:t xml:space="preserve">[图片：${escapeXml(el.getAttribute('alt') ?? '未命名')}]</w:t></w:r></w:p>`)
        return
      }
      const runs = runsFromRunHtml(el.innerHTML)
      if (runs) bodyXml.push(`<w:p>${runs}</w:p>`)
    })
  }
  if (!bodyXml.length) bodyXml.push(`<w:p><w:r><w:t>${escapeXml(title)}</w:t></w:r></w:p>`)

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyXml.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

  return zip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: STYLES_XML },
    { name: 'word/numbering.xml', content: numberingDefinitions() },
    { name: 'word/_rels/document.xml.rels', content: DOC_RELS },
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

export { parseXml }
