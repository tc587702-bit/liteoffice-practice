/** 知识库 QA / 专业改写客户端（T6） */
import { AGENT_BASE, AgentError } from './agentClient'

export interface KbCitation {
  n: number
  source?: 'doc' | 'kb'
  doc: string
  heading?: string
  ord?: number
  para?: number
  score?: number
  snippet: string
}

export interface KbQaResult {
  ok: boolean
  answer: string
  citations: KbCitation[]
  steps: { phase: string; detail: string }[]
  mock: boolean
}

export interface KbRewriteResult {
  ok: boolean
  candidate?: string
  genreLabel?: string
  changes?: { type: string; from: string; to: string; note?: string }[]
  checklist?: string[]
  reason?: string
  citations?: KbCitation[]
  evidence?: { terms?: { from: string; to: string }[]; chunks?: KbCitation[] }
  steps?: { phase: string; detail: string }[]
  mock?: boolean
}

const TIMEOUT_MS = 120_000

async function post<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${AGENT_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      let detail = ''
      try {
        const payload = (await response.json()) as { detail?: unknown }
        detail = String(payload.detail ?? '')
      } catch {
        detail = ''
      }
      throw new AgentError(response.status >= 500 ? 'http5xx' : 'http4xx', detail || `请求被拒绝（HTTP ${response.status}）`, {
        status: response.status,
        detail,
      })
    }
    return (await response.json()) as T
  } catch (error) {
    if (error instanceof AgentError) throw error
    if ((error as Error)?.name === 'AbortError') {
      throw new AgentError('timeout', '后端响应超时，可重试')
    }
    throw new AgentError('offline', 'AI 服务未启动，请先启动后端', { detail: (error as Error)?.message })
  } finally {
    clearTimeout(timer)
  }
}

/** 知识库问答（T5：带上当前文档做双源检索） */
export function askKb(question: string, html: string, kbId = 'lab'): Promise<KbQaResult> {
  return post<KbQaResult>(`/v1/kb/${kbId}/qa`, { question, topK: 5, html })
}

/** 专业改写（用当前选区 + 上下文） */
export function rewriteSelection(
  selection: string,
  options: { genre?: string; context?: string; kbId?: string } = {},
): Promise<KbRewriteResult> {
  const kbId = options.kbId ?? 'lab'
  return post<KbRewriteResult>(`/v1/kb/${kbId}/rewrite`, {
    selection,
    genre: options.genre,
    context: options.context,
  })
}
