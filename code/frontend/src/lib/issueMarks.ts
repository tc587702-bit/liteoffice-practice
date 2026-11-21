/** 在编辑器里标注检查出来的问题位置 */

import type { ImproveReport, ImproveIssue } from './improveClient'
import { focusBlock } from './editorEdit'

const MARK_CLASS = 'lo-issue-mark'
const BADGE_ATTR = 'data-issue-badge'

/** 正文归一化：去空白，便于按 anchor 前缀匹配 */
function norm(text: string): string {
  return text.replace(/\s+/g, '')
}

function editorBlocks(): HTMLElement[] {
  const editor = document.querySelector('.lo-editor')
  if (!editor) return []
  return Array.from(editor.children) as HTMLElement[]
}

/**
 * 清掉上一次的标注。
 *
 * 片段标记是用 <span> 把文字包起来的 —— 只去 class 不清 DOM，
 * 文本节点仍是断开的，后续「按原文替换」就会找不到整段原文。
 * 所以这里先把 span 拆掉、把文本合并回去。
 */
export function clearIssueMarks(): void {
  document.querySelectorAll('.lo-issue-inline').forEach((el) => {
    const parent = el.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(el.textContent ?? ''), el)
    if (parent instanceof HTMLElement) parent.normalize()
  })
  document.querySelectorAll(`.${MARK_CLASS}`).forEach((el) => {
    el.classList.remove(MARK_CLASS, 'lo-issue-error', 'lo-issue-warning', 'lo-issue-info')
    el.removeAttribute(BADGE_ATTR)
  })
}

/**
 * 给报告里的问题在编辑区打标记：只高亮错的那几个字。
 *
 * 后端给了 span（段内 start/len）就用 span；没有 span 的（如"整段重复""长句"）
 * 才退回整段标记 —— 这类问题的"错处"本来就是整段，标整段是对的。
 */
export function markIssues(report: ImproveReport): number {
  clearIssueMarks()
  const blocks = editorBlocks()
  if (!blocks.length) return 0

  const textOf = blocks.map((el) => norm(el.textContent ?? ''))
  let marked = 0

  report.issues.forEach((issue: ImproveIssue, order: number) => {
    const badge = String(order + 1)
    const span = issue.span ?? null

    // ① 有精确位置：优先在 anchor 命中的段里按 span 包一层
    if (span && span.len > 0) {
      let target = -1
      if (issue.block !== null && issue.block !== undefined && blocks[issue.block]) {
        target = issue.block
      } else {
        const anchor = norm(issue.anchor || '')
        if (anchor.length >= 6) target = textOf.findIndex((t) => t.includes(anchor.slice(0, 20)))
      }
      if (target >= 0 && wrapSpan(blocks[target], span.start, span.len, issue.level, badge)) {
        marked += 1
        return
      }
    }

    // ② 没有 span：用 excerpt（原文片段）在段落里定位，只包那几个字。
    //    事实类问题（常识错误/前后矛盾）都没有 span，以前一律整段铺底色，
    //    一段两百字整体变黄，用户根本看不出错在哪。
    const quote = (issue.excerpt || issue.anchor || '').trim()
    if (quote.length >= 2) {
      let target = -1
      if (issue.block !== null && issue.block !== undefined && blocks[issue.block]) {
        target = issue.block
      } else {
        const key = norm(quote).slice(0, 20)
        target = textOf.findIndex((t) => t.includes(key))
      }
      if (target >= 0 && wrapText(blocks[target], quote.slice(0, 20), issue.level, badge)) {
        marked += 1
        return
      }
    }

    // ③ 兜底：整段只留「左侧竖条 + 角标」，不铺底色（见 CSS）
    const anchor = norm(issue.anchor || '')
    if (anchor.length < 6) return
    let target = textOf.findIndex((t) => t.includes(anchor.slice(0, 20)))
    if (target === -1) target = textOf.findIndex((t) => t.includes(anchor.slice(0, 10)))
    if (target === -1) return

    const el = blocks[target]
    el.classList.add(MARK_CLASS, 'lo-issue-block', `lo-issue-${issue.level}`)
    el.setAttribute(BADGE_ATTR, badge)
    marked += 1
  })

  return marked
}

/**
 * 把段落里 offset..offset+len 这段文字包成 <span class="lo-issue-mark lo-issue-inline">。
 *
 * 只在单个文本节点内切分（跨节点的情形极少，失败就退回整段标记），
 * 这样不会破坏公式、加粗等既有结构。
 */
function wrapSpan(block: HTMLElement, start: number, len: number, level: string, badge: string): boolean {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let pos = 0
  let node = walker.nextNode() as Text | null
  while (node) {
    const value = node.nodeValue ?? ''
    const from = pos
    const to = pos + value.length
    if (from <= start && start + len <= to) {
      const offset = start - from
      const target = node.splitText(offset)
      target.splitText(len)
      const span = document.createElement('span')
      span.className = `${MARK_CLASS} lo-issue-${level} lo-issue-inline`
      span.setAttribute(BADGE_ATTR, badge)
      span.textContent = target.nodeValue
      target.parentNode?.replaceChild(span, target)
      return true
    }
    pos = to
    node = walker.nextNode() as Text | null
  }
  return false
}


/** 引用定位高亮（与问题标区分颜色） */
export function markRefs(para: number): boolean {
  if (!Number.isInteger(para) || para < 0) return false
  const ok = focusBlock(para) // 点引用 = 光标跳到那一段
  if (!ok) return false
  const blocks = editorBlocks()
  const el = blocks[para]
  if (el) {
    el.classList.add('lo-ref-flash')
    window.setTimeout(() => el.classList.remove('lo-ref-flash'), 1600)
  }
  return true
}

export interface SelectionInfo {
  text: string
  block: number | null
  /** 选区所在段落的前后文（各约 200 字），供改写时理解上下文 */
  context: string
}

/** 读取编辑器里的当前选区（不在编辑区内返回 null） */
export function currentSelection(): SelectionInfo | null {
  if (typeof window === 'undefined') return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const text = sel.toString().trim()
  if (!text) return null

  const anchor = sel.anchorNode
  const el = anchor instanceof Element ? anchor : anchor?.parentElement ?? null
  const host = el?.closest('.lo-editor')
  if (!host) return null

  const blocks = editorBlocks()
  const blockEl = el?.closest('.lo-editor > *') as HTMLElement | null
  const block = blockEl ? blocks.indexOf(blockEl) : null
  const full = (blockEl?.textContent ?? '').replace(/\s+/g, '')
  const idx = full.indexOf(text.replace(/\s+/g, ''))
  const context =
    idx >= 0 ? full.slice(Math.max(0, idx - 200), Math.min(full.length, idx + text.length + 200)) : full.slice(0, 400)

  return { text, block: block === null || block < 0 ? null : block, context }
}

// ---------------- 持久标记（可开关、可在重渲染后重放） ----------------

const MARK_KINDS = ['lo-issue-error', 'lo-issue-warning', 'lo-issue-info', 'lo-ref-mark', 'lo-issue-mark']
let lastIssueReport: ImproveReport | null = null
let lastRefParas: number[] = []
let observer: MutationObserver | null = null
let replayTimer: number | null = null

function clearAll() {
  document.querySelectorAll(`.${MARK_CLASS}, .lo-ref-mark`).forEach((el) => {
    el.classList.remove(...MARK_KINDS)
    el.removeAttribute(BADGE_ATTR)
    el.removeAttribute('title')
  })
}

/** 给一批段落打「引用」标记（下划线，不闪） */
export function markRefParagraphs(paras: number[]): number {
  clearRefs()
  lastRefParas = paras.filter((x) => Number.isInteger(x) && x >= 0)
  const blocks = editorBlocks()
  let n = 0
  for (const para of lastRefParas) {
    const el = blocks[para]
    if (!el) continue
    el.classList.add('lo-ref-mark')
    n += 1
  }
  if (n > 0 && lastRefParas.length) {
    blocks[lastRefParas[0]]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  return n
}

function clearRefs() {
  document.querySelectorAll('.lo-ref-mark').forEach((el) => el.classList.remove('lo-ref-mark'))
}

/** 标记当前检查报告里的问题（持久，直到清除） */
export function applyIssueMarks(report: ImproveReport): number {
  lastIssueReport = report
  clearAll()
  const n = markIssues(report)
  attachObserver()
  return n
}

/** 清除所有标记 */
export function clearAllMarks(): void {
  lastIssueReport = null
  lastRefParas = []
  clearAll()
}

/** 编辑器重渲染（滚动窗口/撤销）后把标记重放上去 */
function replay() {
  if (!lastIssueReport && !lastRefParas.length) return
  const report = lastIssueReport
  const refs = lastRefParas
  clearAll()
  if (report) markIssues(report)
  if (refs.length) {
    const blocks = editorBlocks()
    for (const para of refs) blocks[para]?.classList.add('lo-ref-mark')
  }
}

function attachObserver() {
  const editor = document.querySelector('.lo-editor')
  if (!editor || observer) return
  observer = new MutationObserver(() => {
    if (replayTimer) window.clearTimeout(replayTimer)
    replayTimer = window.setTimeout(replay, 60)
  })
  observer.observe(editor, { childList: true })
}

/** 面板用：当前是否有标记 */
export function hasMarks(): boolean {
  return document.querySelectorAll(`.${MARK_CLASS}, .lo-ref-mark`).length > 0
}


/**
 * 按文本内容定位并包一层标记。
 *
 * 与 wrapSpan 的区别：这个不需要后端算好的 offset，
 * 直接在段落文本里找 excerpt，找到就包那几个字。
 */
function wrapText(block: HTMLElement, needle: string, level: string, badge: string): boolean {
  const key = (needle || '').trim()
  if (key.length < 2) return false

  // 收集文本节点与各自的原始字符区间（不做任何归一化，避免坐标错位）
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let flat = ''
  let node = walker.nextNode() as Text | null
  while (node) {
    nodes.push(node)
    flat += node.nodeValue ?? ''
    node = walker.nextNode() as Text | null
  }
  if (!flat) return false

  // 逐级缩短重试：完整引文 → 前 12 字 → 前 8 字 → 前 6 字
  const candidates = [key.slice(0, 20), key.slice(0, 12), key.slice(0, 8), key.slice(0, 6)].filter(
    (s, i, arr) => s.length >= 2 && arr.indexOf(s) === i,
  )
  let at = -1
  let len = 0
  for (const cand of candidates) {
    const idx = flat.indexOf(cand)
    if (idx >= 0) {
      at = idx
      len = cand.length
      break
    }
  }
  if (at < 0) return false

  const locate = (index: number): { node: Text; offset: number } | null => {
    let acc = 0
    for (const n of nodes) {
      const l = (n.nodeValue ?? '').length
      if (acc + l > index) return { node: n, offset: index - acc }
      acc += l
    }
    return null
  }
  const from = locate(at)
  const to = locate(at + len)
  if (!from) return false

  const range = document.createRange()
  range.setStart(from.node, from.offset)
  if (to) range.setEnd(to.node, to.offset)
  else range.setEnd(from.node, from.node.data.length)

  const span = document.createElement('span')
  span.className = `${MARK_CLASS} lo-issue-${level} lo-issue-inline`
  span.setAttribute(BADGE_ATTR, badge)
  try {
    const frag = range.extractContents()
    span.appendChild(frag)
    range.insertNode(span)
    return true
  } catch {
    return false
  }
}
