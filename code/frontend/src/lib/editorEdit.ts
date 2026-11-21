/**
 * 在编辑器里替换当前选区
 *
 * 走原生选区 + input 事件，让 Editor.vue 的 onInput 接管：
 * 这样替换会进撤销栈、会触发保存，跟用户手打完全一样。
 */

// md 源码模式切回预览后重试一次定位，避免连点两次没反应
let previewRetryPending = false

export interface ReplaceResult {
  /** 已经有改后内容（同一次修正顺带改掉了） */
  already?: boolean
  ok: boolean
  message: string
}

function editorHost(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null
  return (el?.closest('.lo-editor') as HTMLElement | null) ?? null
}

/** 用 text 替换编辑器内的当前选区；返回是否成功 */
export function replaceSelection(text: string): ReplaceResult {
  if (typeof window === 'undefined') return { ok: false, message: '当前环境不支持' }

  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) {
    return { ok: false, message: '正文里没有选中内容' }
  }
  const host = editorHost(sel.anchorNode)
  if (!host) return { ok: false, message: '选区不在文档正文内' }

  const range = sel.getRangeAt(0).cloneRange()
  range.deleteContents()

  const node = document.createTextNode(text)
  range.insertNode(node)

  // 光标放到替换内容之后
  const after = document.createRange()
  after.setStartAfter(node)
  after.collapse(true)
  sel.removeAllRanges()
  sel.addRange(after)

  // 触发 Editor 的 @input：进撤销栈 + 保存
  host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  return { ok: true, message: '已替换，可 Ctrl+Z 撤销' }
}

/** 当前选区是否在正文内（用于按钮可用性判断） */
export function hasEditorSelection(): boolean {
  if (typeof window === 'undefined') return false
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  return Boolean(editorHost(sel.anchorNode))
}


/**
 * 把光标放到第 index 个块的段首，并让它进入可视区。
 *
 * 用于「检查报告里点一条建议」和「点答案里的第 N 段」：
 * 不只是滚动过去，而是真的把插入点放进去，用户可以直接开始改。
 */
export function focusBlock(index: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false
  const host = document.querySelector('.lo-editor') as HTMLElement | null
  if (!host) {
    // md 源码模式没有富文本 DOM：请编辑器切回预览后再定位，避免「点了没反应」
    if (previewRetryPending) return false
    if (!requestPreviewView()) return false
    previewRetryPending = true
    requestAnimationFrame(() => {
      previewRetryPending = false
      focusBlock(index)
    })
    return true
  }
  const blocks = Array.from(host.children) as HTMLElement[]
  const el = blocks[index]
  if (!el) return false

  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  host.focus({ preventScroll: true })

  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(true) // 折叠到段首 = 光标落在这里
  const sel = window.getSelection()
  if (!sel) return false
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

/**
 * 保存当前选区（生成改写时调用）。
 *
 * 用户很可能在等结果时点了别处，所以替换时必须用「生成时的那段范围」，
 * 而不是点按钮那一刻的选区。
 */
export function captureRange(): Range | null {
  if (typeof window === 'undefined') return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return null
  if (!editorHost(sel.anchorNode)) return null
  return sel.getRangeAt(0).cloneRange()
}

/** 保存的 Range 是否还能用（DOM 重渲染、删块之后会失效） */
export function rangeAlive(range: Range | null): boolean {
  if (!range) return false
  const start = range.startContainer
  const end = range.endContainer
  return Boolean(start?.isConnected && end?.isConnected)
}

/**
 * 用 text 替换「保存下来的那段范围」，并把光标放到替换内容之后。
 *
 * 与 replaceSelection 的区别：不依赖当前选区，防用户中途点击。
 */
export function replaceRange(range: Range, text: string): ReplaceResult {
  if (!rangeAlive(range)) return { ok: false, message: '原文位置已变化，请重新选中后再试' }
  const host = editorHost(range.startContainer)
  if (!host) return { ok: false, message: '选区不在文档正文内' }

  const target = range.cloneRange()
  target.deleteContents()

  const node = document.createTextNode(text)
  target.insertNode(node)

  const after = document.createRange()
  after.setStartAfter(node)
  after.collapse(true)
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(after)
  }

  host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  return { ok: true, message: '已替换，可 Ctrl+Z 撤销' }
}

/** 把保存的 Range 重新设为当前选区（可选：让用户看到高亮） */
export function restoreRange(range: Range | null): boolean {
  if (!rangeAlive(range) || !range) return false
  const sel = window.getSelection()
  if (!sel) return false
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}


/**
 * 把第 blockIndex 个段落里的 quote 换成 rewrite。
 *
 * 用于「深度分析」给出的具体改写：模型只给原文片段与改后文本，
 * 前端负责精确替换那一段文字，而不是整段覆盖（避免丢格式）。
 */
export function replaceTextInBlock(
  blockIndex: number,
  quote: string,
  rewrite: string,
  span?: { start: number; len: number } | null,
): ReplaceResult {
  const host = document.querySelector('.lo-editor') as HTMLElement | null
  if (!host) return { ok: false, message: '没有打开文档' }
  const block = (Array.from(host.children) as HTMLElement[])[blockIndex]
  if (!block) return { ok: false, message: '目标段落不在可视范围内，先定位一次' }

  const needle = (quote ?? '').trim()
  const text = block.textContent ?? ''
  if (!text) return { ok: false, message: '这一段没有文字' }
  if (!needle) return { ok: false, message: '缺少原文片段' }

  // ---- ① 确定替换位置：唯一坐标是纯文本下标 ----
  let at = -1
  const spanOk =
    !!span &&
    Number.isInteger(span.start) &&
    span.start >= 0 &&
    span.start + needle.length <= text.length &&
    text.slice(span.start, span.start + needle.length) === needle

  if (spanOk) {
    at = span!.start
  } else {
    const first = text.indexOf(needle)
    if (first === -1) {
      // 原文片段已经不在，但改后的内容已经在段里 —— 说明同一次规则修正
      // 把相邻问题一起修掉了（例如 的→地 与 脸旁→脸庞 出自同一句）。
      const rw = (rewrite ?? '').trim()
      const covered = rw && text.includes(rw.slice(0, Math.min(rw.length, 10)))
      if (covered) {
        return { ok: true, already: true, message: '已修正（与相邻问题一并修复）' }
      }
      return { ok: false, message: '这一段里找不到原文片段（可能已被改动）' }
    }
    const second = text.indexOf(needle, first + 1)
    if (second !== -1) {
      // 多处出现又拿不到精确位置时宁可不改，也不猜 —— 猜错就是"改出新问题"
      return { ok: false, message: `原文片段在这一段里出现 ${text.split(needle).length - 1} 次，无法确定改哪一处，请先点「定位」再改` }
    }
    at = first
  }

  // ---- ② 落地：整段按纯文本重写 ----
  const expected = text.slice(0, at) + rewrite + text.slice(at + needle.length)
  block.textContent = expected

  // ---- ③ 自校验：回读必须与预期一致，否则如实失败 ----
  const actual = block.textContent ?? ''
  if (actual !== expected) {
    block.textContent = text // 回滚，避免留下半成品
    return { ok: false, message: '写入后校验失败，已回滚（未改动原文）' }
  }

  // ---- ④ 光标放到改后的位置，保持可见 ----
  try {
    const target = at + rewrite.length
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let n = walker.nextNode() as Text | null
    while (n) {
      nodes.push(n)
      n = walker.nextNode() as Text | null
    }
    let acc = 0
    let placed = false
    for (const t of nodes) {
      const l = (t.nodeValue ?? '').length
      if (acc + l >= target) {
        const range = document.createRange()
        range.setStart(t, Math.min(l, target - acc))
        range.collapse(true)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        placed = true
        break
      }
      acc += l
    }
    if (!placed) {
      const range = document.createRange()
      range.selectNodeContents(block)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  } catch {
    // 光标恢复失败不影响文本已改好
  }

  host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: rewrite }))
  return { ok: true, message: '已替换，可 Ctrl+Z 撤销' }
}


/** 读取第 blockIndex 段的纯文本（用于「一键改写」把整句交给模型） */
export function getBlockText(blockIndex: number): string {
  const host = document.querySelector('.lo-editor') as HTMLElement | null
  if (!host) return ''
  const block = (Array.from(host.children) as HTMLElement[])[blockIndex]
  return (block?.innerText ?? '').trim()
}


/** 在正文末尾追加一段（续写用）。返回是否成功 */
export function appendText(text: string): ReplaceResult {
  const host = document.querySelector('.lo-editor') as HTMLElement | null
  if (!host) return { ok: false, message: '没有打开文档' }
  if (!text.trim()) return { ok: false, message: '内容为空' }

  const p = document.createElement('p')
  p.textContent = text.trim()
  host.appendChild(p)
  host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  p.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return { ok: true, message: '已追加到文末，可 Ctrl+Z 撤销' }
}

/** 在当前光标处插入文本（不替换选区内容） */
export function insertAtCursor(text: string): ReplaceResult {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return { ok: false, message: '请先把光标放到正文里' }
  const range = sel.getRangeAt(0)
  const host = (range.startContainer as Element | Text).parentElement?.closest('.lo-editor')
  if (!host) return { ok: false, message: '光标不在正文里' }
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  ;(host as HTMLElement).dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  return { ok: true, message: '已插入，可 Ctrl+Z 撤销' }
}


/**
 * 取光标之前的正文（最多 maxChars 字）。
 *
 * 用途：续写必须从"光标所在位置"往前接，用文末内容去生成、再插到光标处会接不上。
 * 返回 inEditor=false 表示光标不在正文里，调用方应退回过文末续写。
 */
export function textBeforeCursor(maxChars = 600): { text: string; inEditor: boolean } {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return { text: '', inEditor: false }
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  const el = (node instanceof Element ? node : node.parentElement) ?? null
  const host = el?.closest('.lo-editor')
  if (!host) return { text: '', inEditor: false }

  // 收集光标之前的所有文本：先取完整 Range（块的起点 → 光标），再从中截尾部
  const before = document.createRange()
  before.setStart(host, 0)
  before.setEnd(range.startContainer, range.startOffset)
  const text = (before.toString() || '').replace(/\s+$/, '')
  return { text: text.slice(-maxChars), inEditor: true }
}


/**
 * 把光标落到 blockIndex 里第 start 个字处，返回该位置所在的元素。
 *
 * 用于「定位到问题」：光标停在出错处，且只闪那一小段，
 * 而不是把整段（可能上百字）都高亮一片。
 */
export function focusSpan(
  blockIndex: number,
  start: number,
  len = 0,
): { ok: boolean; element?: HTMLElement } {
  const host = document.querySelector('.lo-editor') as HTMLElement | null
  if (!host) return { ok: false }
  const blocks = Array.from(host.children) as HTMLElement[]
  const el = blocks[blockIndex]
  if (!el) return { ok: false }

  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  host.focus({ preventScroll: true })

  // 在块内按字符偏移找目标文本节点
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node: Text | null = null
  let offset = 0
  while (walker.nextNode()) {
    const t = walker.currentNode as Text
    const textLen = t.data.length
    if (acc + textLen >= start) {
      node = t
      offset = Math.max(0, Math.min(textLen, start - acc))
      break
    }
    acc += textLen
  }
  if (!node) {
    // 偏移超出块长度：退回到段尾
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    return { ok: true, element: el }
  }

  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true) // 光标落在出错处，不选中整段
  const sel = window.getSelection()
  if (!sel) return { ok: false }
  sel.removeAllRanges()
  sel.addRange(range)

  // 找到包含这个位置的元素：优先已包好的问题标记（只闪那几个字）
  const wrapper = (node.parentElement?.closest('.lo-issue-inline') as HTMLElement | null) ?? el
  void len
  return { ok: true, element: wrapper }
}


/**
 * 按引文定位：在块内找到 excerpt 文本，只闪那一小段。
 *
 * 用于没有精确 span 的问题（事实类等）——否则只能闪整段，
 * 一段两百字整体高亮，用户根本看不出错在哪。
 */
export function focusQuote(
  blockIndex: number,
  quote: string,
): { ok: boolean; element?: HTMLElement } {
  const host = document.querySelector('.lo-editor') as HTMLElement | null
  if (!host) return { ok: false }
  const el = Array.from(host.children)[blockIndex] as HTMLElement | undefined
  if (!el) return { ok: false }
  const key = (quote || '').trim().slice(0, 20)
  if (!key) return { ok: false }

  const full = el.textContent || ''
  const at = full.indexOf(key)
  if (at < 0) return { ok: false }

  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  host.focus({ preventScroll: true })
  return focusSpan(blockIndex, at, key.length)
}


/**
 * 只闪「某几个字」：把 [start, start+len) 临时包一层 span 做高亮动画。
 *
 * 为什么不直接给块加 class：块级标记（`.lo-issue-mark` 落在整段 <p> 上）时，
 * 一加就是两百字一起变色，看着像选中了整段。这里按字符范围精确到词。
 */
export function flashSpan(blockIndex: number, start: number, len: number): boolean {
  const host = document.querySelector('.lo-editor') as HTMLElement | null
  if (!host) return false
  const el = Array.from(host.children)[blockIndex] as HTMLElement | undefined
  if (!el) return false

  const pointAt = (target: number): { node: Text; offset: number } | null => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let acc = 0
    while (walker.nextNode()) {
      const t = walker.currentNode as Text
      const l = t.data.length
      if (acc + l >= target) return { node: t, offset: Math.max(0, Math.min(l, target - acc)) }
      acc += l
    }
    return null
  }

  const from = pointAt(start)
  if (!from) return false
  const to = pointAt(start + Math.max(1, len))

  const range = document.createRange()
  range.setStart(from.node, from.offset)
  if (to) range.setEnd(to.node, to.offset)
  else range.setEnd(from.node, from.node.data.length)

  const box = document.createElement('span')
  box.className = 'lo-locate-flash'
  try {
    // 不能 surroundContents：选区跨过已有内联标记时会抛异常（问题标记把文字包住了）
    const frag = range.extractContents()
    box.appendChild(frag)
    range.insertNode(box)
  } catch {
    return false
  }
  window.setTimeout(() => {
    const parent = box.parentNode
    if (!parent) return
    while (box.firstChild) parent.insertBefore(box.firstChild, box)
    parent.removeChild(box)
  }, 1700)
  return true
}
import { requestPreviewView } from './editorViewMode'
