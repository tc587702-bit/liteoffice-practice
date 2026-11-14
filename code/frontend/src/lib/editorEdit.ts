/**
 * 在编辑器里替换当前选区
 *
 * 走原生选区 + input 事件，让 Editor.vue 的 onInput 接管：
 * 这样替换会进撤销栈、会触发保存，跟用户手打完全一样。
 */

export interface ReplaceResult {
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
  if (!host) return false
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
export function replaceTextInBlock(blockIndex: number, quote: string, rewrite: string): ReplaceResult {
  const host = document.querySelector('.lo-editor') as HTMLElement | null
  if (!host) return { ok: false, message: '没有打开文档' }
  const block = (Array.from(host.children) as HTMLElement[])[blockIndex]
  if (!block) return { ok: false, message: '目标段落不在可视范围内，先定位一次' }

  const needle = quote.trim()
  if (!needle) return { ok: false, message: '缺少原文片段' }

  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Text | null
  while (node) {
    const text = node.nodeValue ?? ''
    const at = text.indexOf(needle)
    if (at !== -1) {
      node.nodeValue = text.slice(0, at) + rewrite + text.slice(at + needle.length)
      host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: rewrite }))
      return { ok: true, message: '已替换，可 Ctrl+Z 撤销' }
    }
    node = walker.nextNode() as Text | null
  }
  return { ok: false, message: '没找到原文片段（可能已被改动）' }
}
