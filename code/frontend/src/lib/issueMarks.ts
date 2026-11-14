/** 在编辑器里标注检查出来的问题位置 */

import type { ImproveReport, ImproveIssue } from './improveClient'

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

/** 清掉上一次的标注 */
export function clearIssueMarks(): void {
  document.querySelectorAll(`.${MARK_CLASS}`).forEach((el) => {
    el.classList.remove(MARK_CLASS, 'lo-issue-error', 'lo-issue-warning', 'lo-issue-info')
    el.removeAttribute(BADGE_ATTR)
  })
}

/**
 * 给报告里的问题在编辑区打标记。
 * 返回打上标记的条数（用于界面提示"X 处已标注"）。
 */
export function markIssues(report: ImproveReport): number {
  clearIssueMarks()
  const blocks = editorBlocks()
  if (!blocks.length) return 0

  const textOf = blocks.map((el) => norm(el.textContent ?? ''))
  let marked = 0

  report.issues.forEach((issue: ImproveIssue, order: number) => {
    const anchor = norm(issue.anchor || '')
    if (anchor.length < 6) return

    // 优先用 anchor 前 20 字匹配；找不到就退到前 10 字
    let target = textOf.findIndex((t) => t.includes(anchor.slice(0, 20)))
    if (target === -1) target = textOf.findIndex((t) => t.includes(anchor.slice(0, 10)))
    if (target === -1) return

    const el = blocks[target]
    el.classList.add(MARK_CLASS, `lo-issue-${issue.level}`)
    el.setAttribute(BADGE_ATTR, String(order + 1))
    marked += 1
  })

  return marked
}


/** 引用定位高亮（与问题标区分颜色） */
export function markRefs(para: number): boolean {
  if (!Number.isInteger(para) || para < 0) return false
  const blocks = editorBlocks()
  const el = blocks[para]
  if (!el) return false
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('lo-ref-flash')
  window.setTimeout(() => el.classList.remove('lo-ref-flash'), 1600)
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
