/**
 * 文档检查（优化建议）接口封装
 *
 * POST {AGENT_BASE}/v1/doc/improve  { html }
 * → { ok, dims, issues, summary, docStats }
 */
import { AGENT_BASE } from './agentClient'
import { focusBlock } from './editorEdit'

export type IssueLevel = 'error' | 'warning' | 'info'

export interface ImproveIssue {
  /** 规则名（反馈记忆用它做键） */
  rule?: string
  ruleId?: string
  level: IssueLevel
  levelLabel: string
  where: string
  problem: string
  why: string
  how: string
  excerpt: string
  block: number | null
  /** 该段前 40 字，用于在编辑器里定位 */
  anchor?: string
}

export interface ImproveDim {
  label: string
  status: string
  count: number
  problems: string[]
}

export interface FeedbackPayload {
  fingerprint: string
  rule: string
  snippet: string
  action?: 'dismiss' | 'accept'
  genre?: string
}

export interface ImproveReport {
  ok: boolean
  dims: Record<string, ImproveDim>
  issues: ImproveIssue[]
  summary: string
  docStats: { sections: number; blocks: number; chars: number }
  /** 文档指纹，反馈时回传，用于「同一处不再报」 */
  fingerprint?: string
  /** 本次因历史反馈被忽略的条数 */
  dismissedCount?: number
  genreLabel?: string
  genre?: string
}

export async function checkDocument(html: string, signal?: AbortSignal): Promise<ImproveReport> {
  const res = await fetch(`${AGENT_BASE}/v1/doc/improve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
    signal,
  })
  if (!res.ok) {
    throw new Error(`检查失败（HTTP ${res.status}）`)
  }
  return (await res.json()) as ImproveReport
}

/**
 * 定位到编辑区第 index 个块（0 起）：
 * 滚动到视野中央 + 把光标放进段首 + 高亮 1.6 秒。
 */
export function locateBlock(index: number | null): boolean {
  if (index === null || index < 0) return false
  const ok = focusBlock(index)
  if (!ok) return false
  const editor = document.querySelector('.lo-editor')
  const el = editor ? (Array.from(editor.children)[index] as HTMLElement | undefined) : undefined
  if (el) {
    el.classList.add('lo-locate-flash')
    window.setTimeout(() => el.classList.remove('lo-locate-flash'), 1600)
  }
  return true
}


/** 记录「这条不用改」：下次检查同一处不再报 */
export async function sendIssueFeedback(payload: FeedbackPayload): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_BASE}/v1/doc/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { ok?: boolean }
    return data.ok === true
  } catch {
    return false
  }
}


export interface ReviewIssue {
  level: 'error' | 'warning' | 'info'
  levelLabel: string
  where: string
  problem: string
  why: string
  how: string
  excerpt: string
  block: number | null
  source?: string
}

export interface ReviewResult {
  ok: boolean
  reason?: string
  issues: ReviewIssue[]
  summary: string
  seconds?: number
  model?: string
  offline?: boolean
  sections?: number
}

/** 离线深度分析：本机 1.5B 模型，不发出任何网络请求到云端 */
export async function reviewLocal(html: string, maxSections = 3, signal?: AbortSignal): Promise<ReviewResult> {
  const res = await fetch(`${AGENT_BASE}/v1/doc/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, mode: 'local', maxSections }),
    signal,
  })
  const data = (await res.json()) as ReviewResult
  if (!res.ok) throw new Error(data.reason || `分析失败（HTTP ${res.status}）`)
  return data
}

/** 本地模型是否就绪 */
export async function reviewStatus(): Promise<{ localAvailable: boolean; model: string }> {
  try {
    const res = await fetch(`${AGENT_BASE}/v1/doc/review/status`)
    if (!res.ok) return { localAvailable: false, model: '' }
    return (await res.json()) as { localAvailable: boolean; model: string }
  } catch {
    return { localAvailable: false, model: '' }
  }
}
