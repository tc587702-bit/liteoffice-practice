/**
 * HTML 白名单消毒（防存储型 XSS）
 *
 * 场景：POST /api/docs 接受任意 html，分享页用 innerHTML 注入。
 * 若不消毒，上传一份带 <script> 或 <img onerror> 的文档即可在分享域名下执行脚本，
 * 读同源 IndexedDB、调用 /api/*。
 *
 * 策略：标签白名单 + 属性白名单；<script>/<style>/<iframe> 整段丢弃；
 *      图片只允许 data:image/*；链接只允许 http(s)/mailto/# 协议。
 */

const ALLOWED_TAGS = new Set([
  'p', 'div', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'small',
  'blockquote', 'pre', 'code', 'span', 'a', 'img',
])

const ALLOWED_ATTRS = new Set([
  'class', 'title', 'colspan', 'rowspan', 'align', 'valign',
  'width', 'height', 'alt', 'src', 'href', 'start', 'type',
])

/** 这些标签整段（含内容）丢弃 */
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math']

const SAFE_HREF = /^(https?:|mailto:|tel:|#|\/)/i
const SAFE_IMG_SRC = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i

function safeAttrs(raw, tag) {
  const out = []
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+))/g
  let m
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase()
    const value = (m[3] ?? m[4] ?? m[5] ?? '').trim()

    if (!ALLOWED_ATTRS.has(name)) continue
    if (name.startsWith('on')) continue
    if (name === 'src') {
      if (tag !== 'img' || !SAFE_IMG_SRC.test(value)) continue
    }
    if (name === 'href') {
      if (tag !== 'a' || !SAFE_HREF.test(value)) continue
    }
    // 属性值里不允许出现脚本协议
    if (/javascript:|vbscript:|data:text\/html/i.test(value)) continue

    const escaped = value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    out.push(`${name}="${escaped}"`)
  }
  return out.length ? ' ' + out.join(' ') : ''
}

export function sanitizeHtml(html) {
  if (!html) return ''

  let out = String(html)

  // 1) 整段丢弃危险标签（含内容），大小写不敏感、允许嵌套
  for (const tag of DROP_WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi')
    let prev = ''
    while (prev !== out) {
      prev = out
      out = out.replace(re, '')
    }
    // 自闭合或未闭合的
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '')
  }

  // 2) 注释一律去掉（常用于藏脚本）
  out = out.replace(/<!--[\s\S]*?-->/g, '')

  // 3) 逐个开始标签做白名单过滤
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g, (full, rawTag, rawAttrs, selfClose) => {
    const tag = String(rawTag).toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''
    return `<${tag}${safeAttrs(rawAttrs, tag)}${selfClose ? ' /' : ''}>`
  })

  // 4) 结束标签也过滤（防止 </div onclick=...> 这类变体）
  out = out.replace(/<\/([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g, (full, rawTag) => {
    const tag = String(rawTag).toLowerCase()
    return ALLOWED_TAGS.has(tag) ? `</${tag}>` : ''
  })

  return out
}

/** 只保留纯文本（用于确认预览等场景） */
export function toPlainText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
