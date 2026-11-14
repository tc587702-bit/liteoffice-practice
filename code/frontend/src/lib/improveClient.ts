/**
 * 文档检查（优化建议）接口封装
 *
 * POST {AGENT_BASE}/v1/doc/improve  { html }
 * → { ok, dims, issues, summary, docStats }
 */
import { AGENT_BASE } from './agentClient'

export type IssueLevel = 'error' | 'warning' | 'info'

export interface ImproveIssue {
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

export interface ImproveReport {
  ok: boolean
  dims: Record<string, ImproveDim>
  issues: ImproveIssue[]
  summary: string
  docStats: { sections: number; blocks: number; chars: number }
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

/** 定位到编辑区第 index 个块（0 起），高亮 1.6 秒 */
export function locateBlock(index: number | null): boolean {
  if (index === null || index < 0) return false
  const editor = document.querySelector('.lo-editor')
  if (!editor) return false
  const blocks = Array.from(editor.children) as HTMLElement[]
  const el = blocks[index]
  if (!el) return false
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('lo-locate-flash')
  window.setTimeout(() => el.classList.remove('lo-locate-flash'), 1600)
  return true
}
