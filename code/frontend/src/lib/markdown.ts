import { createLogger } from './logger'

const log = createLogger('markdown')
/* ------------------------------------------------------------------ */
/* 通用：HTML 转义（所有文本渲染必须经过这里，禁止直出未转义内容）      */
/* ------------------------------------------------------------------ */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 只允许安全协议，避免 javascript: 链接 */
function safeUrl(url: string): string | null {
  const trimmed = url.trim()
  if (/^(https?:|mailto:|#|\.\/|\/)/i.test(trimmed)) return trimmed
  log.warn('已拦截不安全的链接协议', { url: trimmed.slice(0, 40) })
  return null
}

/* ------------------------------------------------------------------ */
/* 行内元素                                                             */
/* ------------------------------------------------------------------ */

/** 行内代码占位符（不用控制字符，避免编辑器告警） */
const CODE_TOKEN = (index: number) => `@@CODE${index}@@`
const CODE_TOKEN_RE = /@@CODE(\d+)@@/g

/**
 * 把 [label](url) 换成 <a>。
 *
 * 手动扫描而不是一条正则：`\[...\]\(...\)` 这种嵌套量词在长文本里
 * 会产生超线性回溯（Sonar S8786）。
 */
function replaceLinks(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('[', i)
    if (start === -1) {
      out += text.slice(i)
      break
    }
    const labelEnd = text.indexOf('](', start + 1)
    const urlEnd = labelEnd === -1 ? -1 : text.indexOf(')', labelEnd + 2)
    if (labelEnd === -1 || urlEnd === -1) {
      out += text.slice(i, start + 1)
      i = start + 1
      continue
    }
    const label = text.slice(start + 1, labelEnd)
    const href = safeUrl(text.slice(labelEnd + 2, urlEnd).replace(/&amp;/g, '&'))
    out += text.slice(i, start)
    out += href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label
    i = urlEnd + 1
  }
  return out
}

/** 行尾两个以上空格表示硬换行 */
function applyHardBreaks(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.endsWith('  ') ? `${line.trimEnd()}<br />` : line))
    .join('\n')
}

function inline(src: string): string {
  const codes: string[] = []
  // 先把行内代码提取出来，避免其中的 * ` 被误解析
  const text = src.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return CODE_TOKEN(codes.length - 1)
  })

  let escaped = escapeHtml(text)
  // 图片
  escaped = escaped.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, url, title) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'))
    if (!href) return escapeHtml(alt)
    const safeHref = escapeHtml(href)
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
    return `<img src="${safeHref}" alt="${alt}"${titleAttr} loading="lazy" />`
  })
  // 链接（手动扫描，见 replaceLinks 注释）
  escaped = replaceLinks(escaped)
  // 粗体 / 斜体 / 删除线
  escaped = escaped
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')

  return applyHardBreaks(escaped).replace(CODE_TOKEN_RE, (_, index: string) => codes[Number(index)] ?? '')
}

/* ------------------------------------------------------------------ */
/* 块级解析：每个函数只负责一种块，返回 null 表示"不是我"               */
/* ------------------------------------------------------------------ */

interface Block {
  html: string
  next: number
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const FENCE_RE = /^\s*(```|~~~)/
const QUOTE_RE = /^\s*>/
const UL_RE = /^\s*[-*+]\s+/
const OL_RE = /^\s*\d+[.)]\s+/
const TABLE_CELL_RE = /^\s*\|/
const PARAGRAPH_STOP_RE = /^\s*(#+\s|>|```|~~~|[-*+]\s|\d+[.)]\s|\|)/

/** 代码围栏 */
function takeFence(lines: string[], i: number): Block | null {
  const line = lines[i]
  if (!FENCE_RE.test(line)) return null
  const fence = line.trim().slice(0, 3)
  const lang = line.trim().slice(3).trim()
  const buf: string[] = []
  let j = i + 1
  while (j < lines.length && !lines[j].trim().startsWith(fence)) {
    buf.push(lines[j])
    j++
  }
  const html = `<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(buf.join('\n'))}</code></pre>`
  return { html, next: j + 1 }
}

/** 标题：手写扫描 # 的个数，避免嵌套量词正则 */
function takeHeading(lines: string[], i: number): Block | null {
  const line = lines[i]
  let level = 0
  while (level < 6 && line[level] === '#') level++
  if (!level || line[level] !== ' ') return null
  const text = line.slice(level + 1).trim()
  return { html: `<h${level}>${inline(text)}</h${level}>`, next: i + 1 }
}

/** 分割线 */
/** 分割线：--- / *** / ___ （至少 3 个相同符号，允许两侧空白） */
function isHr(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length < 3) return false
  const first = trimmed[0]
  if (first !== '-' && first !== '*' && first !== '_') return false
  return trimmed.split('').every((ch) => ch === first)
}

function takeHr(lines: string[], i: number): Block | null {
  if (!isHr(lines[i])) return null
  return { html: '<hr />', next: i + 1 }
}

/** 引用块 */
function takeQuote(lines: string[], i: number): Block | null {
  if (!QUOTE_RE.test(lines[i])) return null
  const buf: string[] = []
  let j = i
  while (j < lines.length && QUOTE_RE.test(lines[j])) {
    buf.push(lines[j].replace(/^\s*>\s?/, ''))
    j++
  }
  const inner = buf.map((line) => `<p>${inline(line)}</p>`).join('')
  return { html: `<blockquote>${inner}</blockquote>`, next: j }
}

/** 表格分隔行：|---|:--:| 这类 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  return /^[|\s:-]+$/.test(trimmed)
}

function alignOf(cell: string): string {
  const trimmed = cell.trim()
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center'
  if (trimmed.endsWith(':')) return 'right'
  if (trimmed.startsWith(':')) return 'left'
  return ''
}

/** 表格 */
function takeTable(lines: string[], i: number): Block | null {
  if (!TABLE_CELL_RE.test(lines[i])) return null
  if (i + 1 >= lines.length || !isTableSeparator(lines[i + 1])) return null

  const header = splitRow(lines[i])
  const aligns = splitRow(lines[i + 1]).map(alignOf)
  let j = i + 2
  const rows: string[][] = []
  while (j < lines.length && TABLE_CELL_RE.test(lines[j])) {
    rows.push(splitRow(lines[j]))
    j++
  }

  const styleOf = (index: number) => (aligns[index] ? ` style="text-align:${aligns[index]}"` : '')
  const head = header.map((cell, index) => `<th${styleOf(index)}>${inline(cell)}</th>`).join('')
  const body = rows
    .map((row) => {
      const cells = header.map((_, index) => `<td${styleOf(index)}>${inline(row[index] ?? '')}</td>`).join('')
      return `<tr>${cells}</tr>`
    })
    .join('')

  return { html: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`, next: j }
}

/** 列表（有序 / 无序） */
function takeList(lines: string[], i: number): Block | null {
  const ordered = OL_RE.test(lines[i])
  const pattern = ordered ? OL_RE : UL_RE
  if (!pattern.test(lines[i])) return null

  const items: string[] = []
  let j = i
  while (j < lines.length && pattern.test(lines[j])) {
    items.push(lines[j].replace(pattern, ''))
    j++
  }
  const type = ordered ? 'ol' : 'ul'
  const rendered = items.map((item) => `<li>${inline(item)}</li>`).join('')
  return { html: `<${type}>${rendered}</${type}>`, next: j }
}

/** 段落：合并连续行，遇到其它块就停 */
function takeParagraph(lines: string[], i: number): Block {
  const buf: string[] = []
  let j = i
  while (j < lines.length && lines[j].trim() && !PARAGRAPH_STOP_RE.test(lines[j])) {
    buf.push(lines[j])
    j++
  }
  if (!buf.length) {
    // 兜底：不认识的单行也当段落，避免死循环
    return { html: `<p>${inline(lines[i])}</p>`, next: i + 1 }
  }
  return { html: `<p>${inline(buf.join('\n'))}</p>`, next: j }
}

const BLOCK_TAKERS = [takeFence, takeHeading, takeHr, takeQuote, takeTable, takeList]

/**
 * 把 Markdown 转成安全 HTML。
 * 所有文本均经 escapeHtml；`script`、`onerror` 等原始标签不会被保留。
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    let handled: Block | null = null
    for (const take of BLOCK_TAKERS) {
      handled = take(lines, i)
      if (handled) break
    }
    const block = handled ?? takeParagraph(lines, i)
    html.push(block.html)
    i = block.next
  }

  return html.join('\n')
}

/* ------------------------------------------------------------------ */
/* HTML ⇄ 文本（用于编辑后写回 md / docx）                              */
/* ------------------------------------------------------------------ */

type InlineRun = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; code?: boolean }

function runsFromHtml(node: Node): InlineRun[] {
  const out: InlineRun[] = []
  const walk = (current: Node, style: Omit<InlineRun, 'text'>) => {
    current.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const text = child.textContent ?? ''
        if (text) out.push({ text, ...style })
        return
      }
      if (child.nodeType !== 1) return
      const el = child as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (tag === 'br') {
        out.push({ text: '\n', ...style })
        return
      }
      const next = { ...style }
      if (tag === 'strong' || tag === 'b') next.bold = true
      if (tag === 'em' || tag === 'i') next.italic = true
      if (tag === 'u') next.underline = true
      if (tag === 'code') next.code = true
      walk(el, next)
    })
  }
  walk(node, {})
  return out
}

const inlineMd = (run: InlineRun) => {
  let text = run.text.replace(/\n/g, '  \n')
  if (!text.trim()) return text
  if (run.code) text = `\`${text}\``
  if (run.bold) text = `**${text}**`
  if (run.italic) text = `*${text}*`
  if (run.underline) text = `<u>${text}</u>`
  return text
}

const inlineOf = (el: HTMLElement) => runsFromHtml(el).map(inlineMd).join('').trim()

/** 表格行里的单元格：转义竖线（String.raw 避免双重转义） */
const cellText = (cell: Element) =>
  (cell.textContent ?? '').trim().replace(/\|/g, String.raw`\|`)

function tableToMarkdown(el: HTMLElement): string {
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children).map(cellText),
  )
  if (!rows.length) return ''
  const header = rows[0]
  const sep = header.map(() => '---')
  return [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function listToMarkdown(el: HTMLElement, ordered: boolean): string {
  const items: string[] = []
  Array.from(el.children).forEach((li, index) => {
    if (li.tagName.toLowerCase() !== 'li') return
    items.push((ordered ? `${index + 1}. ` : '- ') + inlineOf(li as HTMLElement))
  })
  return items.join('\n')
}

/** 单个块元素 → Markdown；返回 null 表示"按普通段落处理" */
function blockToMarkdown(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inlineOf(el)}`
  if (tag === 'ul' || tag === 'ol') return listToMarkdown(el, tag === 'ol')
  if (tag === 'pre') return `\`\`\`\n${el.textContent ?? ''}\n\`\`\``
  if (tag === 'blockquote') {
    return (el.textContent ?? '')
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
  }
  if (tag === 'table') return tableToMarkdown(el)
  if (tag === 'hr') return '---'
  if (tag === 'img') {
    const src = el.getAttribute('src') ?? ''
    return src && !src.startsWith('data:') ? `![${el.getAttribute('alt') ?? ''}](${src})` : null
  }
  return null
}

/** 把可编辑区域的 HTML 结构还原为 Markdown 文本。 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return ''
  const blocks: string[] = []

  root.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      const text = node.textContent?.trim()
      if (text) blocks.push(text)
      return
    }
    if (node.nodeType !== 1) return
    const el = node as HTMLElement
    const converted = blockToMarkdown(el)
    if (converted !== null) {
      if (converted) blocks.push(converted)
      return
    }
    const text = inlineOf(el)
    if (text) blocks.push(text)
  })

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** 可编辑区域 HTML → 纯文本（用于 pptx / pdf 文本副本）。 */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return ''
  const parts: string[] = []
  root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,tr').forEach((el) => {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) parts.push(text)
  })
  return parts.join('\n')
}

export { escapeXml } from './xml'
