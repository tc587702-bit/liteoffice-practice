import { escapeXml } from './xml'

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
  return null
}

/* ------------------------------------------------------------------ */
/* Markdown → HTML                                                      */
/* ------------------------------------------------------------------ */

function inline(src: string): string {
  let out = ''
  let i = 0
  const codes: string[] = []
  // 先把行内代码提取出来，避免其中的 * ` 被误解析
  const text = src.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `\u0000CODE${codes.length - 1}\u0000`
  })

  let escaped = escapeHtml(text)
  // 图片
  escaped = escaped.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, url, title) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'))
    if (!href) return escapeHtml(alt)
    const safeHref = escapeHtml(href)
    const t = title ? ` title="${escapeHtml(title)}"` : ''
    return `<img src="${safeHref}" alt="${alt}"${t} loading="lazy" />`
  })
  // 链接
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'))
    if (!href) return label
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })
  // 粗体 / 斜体 / 删除线
  escaped = escaped
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  // 硬换行
  escaped = escaped.replace(/ {2,}\n/g, '<br />')

  // 还原行内代码
  out = escaped.replace(/\u0000CODE(\d+)\u0000/g, (_, index: string) => codes[Number(index)] ?? '')
  while (i < 0) i++
  return out
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * 把 Markdown 转成安全 HTML。
 * 所有文本均经 escapeHtml；`script`、`onerror` 等原始标签不会被保留。
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let i = 0

  const flushList = (type: 'ul' | 'ol', items: string[]) => {
    if (!items.length) return
    html.push(`<${type}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${type}>`)
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块
    if (/^\s*(```|~~~)/.test(line)) {
      const fence = line.trim().slice(0, 3)
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        buf.push(lines[i])
        i++
      }
      i++
      html.push(
        `<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(buf.join('\n'))}</code></pre>`,
      )
      continue
    }

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length, 6)
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      html.push('<hr />')
      i++
      continue
    }

    // 引用
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      html.push(`<blockquote>${buf.map((l) => `<p>${inline(l)}</p>`).join('')}</blockquote>`)
      continue
    }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map((cell) => {
        const trimmed = cell.trim()
        if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center'
        if (trimmed.endsWith(':')) return 'right'
        if (trimmed.startsWith(':')) return 'left'
        return ''
      })
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      const alignStyle = (index: number) => (aligns[index] ? ` style="text-align:${aligns[index]}"` : '')
      html.push('<table><thead><tr>')
      header.forEach((cell, index) => {
        html.push(`<th${alignStyle(index)}>${inline(cell)}</th>`)
      })
      html.push('</tr></thead><tbody>')
      rows.forEach((row) => {
        html.push('<tr>')
        header.forEach((_, index) => {
          html.push(`<td${alignStyle(index)}>${inline(row[index] ?? '')}</td>`)
        })
        html.push('</tr>')
      })
      html.push('</tbody></table>')
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      flushList('ul', items)
      continue
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      flushList('ol', items)
      continue
    }

    // 段落（合并连续行）
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|```|~~~|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    if (para.length) {
      html.push(`<p>${inline(para.join('\n'))}</p>`)
    } else {
      // 兜底避免死循环
      html.push(`<p>${inline(lines[i])}</p>`)
      i++
    }
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
    const tag = el.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1])
      blocks.push(`${'#'.repeat(level)} ${runsFromHtml(el).map(inlineMd).join('').trim()}`)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      const items: string[] = []
      Array.from(el.children).forEach((li, index) => {
        if (li.tagName.toLowerCase() !== 'li') return
        const prefix = tag === 'ol' ? `${index + 1}. ` : '- '
        items.push(prefix + runsFromHtml(li).map(inlineMd).join('').trim())
      })
      blocks.push(items.join('\n'))
      return
    }
    if (tag === 'pre') {
      blocks.push(`\`\`\`\n${el.textContent ?? ''}\n\`\`\``)
      return
    }
    if (tag === 'blockquote') {
      blocks.push(
        (el.textContent ?? '')
          .trim()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      )
      return
    }
    if (tag === 'table') {
      const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.children).map((cell) => (cell.textContent ?? '').trim().replace(/\|/g, '\\|')),
      )
      if (rows.length) {
        const header = rows[0]
        const md = [
          `| ${header.join(' | ')} |`,
          `| ${header.map(() => '---').join(' | ')} |`,
          ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
        ]
        blocks.push(md.join('\n'))
      }
      return
    }
    if (tag === 'hr') {
      blocks.push('---')
      return
    }
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? ''
      if (src && !src.startsWith('data:')) blocks.push(`![${el.getAttribute('alt') ?? ''}](${src})`)
      return
    }
    const text = runsFromHtml(el).map(inlineMd).join('').trim()
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

export { escapeXml }
