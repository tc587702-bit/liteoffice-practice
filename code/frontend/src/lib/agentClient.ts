/**
 * AI 助手接口客户端（只调后端，不在前端做任何 agent 推理）
 *
 * POST {AGENT_BASE}/v1/agent/run  { html, query }
 * → { ok, answer, steps[], observations[], toolsUsed[], mock }
 *
 * AGENT_BASE 默认 http://127.0.0.1:8101，可用 VITE_AGENT_BASE 覆盖。
 */

export const AGENT_BASE = (
  (import.meta.env.VITE_AGENT_BASE as string | undefined) ?? 'http://127.0.0.1:8101'
).replace(/\/+$/, '')

export const AGENT_PORT = (() => {
  try {
    return new URL(AGENT_BASE).port || '80'
  } catch {
    return '8101'
  }
})()

export type AgentPhase = 'think' | 'act' | 'final' | string

export interface AgentStep {
  phase: AgentPhase
  detail: string
}

export interface AgentObservation {
  tool: string
  ok: boolean
  summary: string
}

export interface AgentRef {
  para: number
  snippet: string
  from: string
}

export interface AgentRunResult {
  ok: boolean
  answer: string
  steps: AgentStep[]
  observations: AgentObservation[]
  toolsUsed: string[]
  mock: boolean
  /** 答案引用的段落号（T7）；点击可跳到正文对应位置 */
  refs: AgentRef[]
  /** 实际用于检索的问题（被指代消解改写时与用户原句不同） */
  queryUsed: string
}

export type AgentErrorKind = 'offline' | 'http4xx' | 'http5xx' | 'timeout' | 'network'

export class AgentError extends Error {
  kind: AgentErrorKind
  status?: number
  detail?: string

  constructor(kind: AgentErrorKind, message: string, extra: { status?: number; detail?: string } = {}) {
    super(message)
    this.name = 'AgentError'
    this.kind = kind
    this.status = extra.status
    this.detail = extra.detail
  }
}

export const AGENT_TIMEOUT_MS = 90_000

interface RunOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** 当前选区文本（T6）；为空表示没选中 */
  selection?: string
  /** 选区起始块号，供后端定位（可选） */
  selectionAnchor?: number | null
  /** 会话 id，用于跨轮指代消解（T7） */
  sessionId?: string
}

/** 调一次 agent；超时/断网/HTTP 状态都翻译成人话，由面板直接展示 */
export async function runAgent(html: string, query: string, options: RunOptions = {}): Promise<AgentRunResult> {
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS
  const controller = new AbortController()
  let timeoutHit = false
  const timer = setTimeout(() => {
    timeoutHit = true
    controller.abort()
  }, timeoutMs)
  const onExternalAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    const response = await fetch(`${AGENT_BASE}/v1/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html,
        query,
        selection: options.selection ?? '',
        selectionAnchor: options.selectionAnchor ?? null,
        sessionId: options.sessionId ?? '',
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      let detail = ''
      try {
        const payload = (await response.json()) as { detail?: unknown; message?: unknown }
        detail = String(payload.detail ?? payload.message ?? '')
      } catch {
        try {
          detail = (await response.text()).slice(0, 200)
        } catch {
          detail = ''
        }
      }
      if (response.status >= 500) {
        throw new AgentError('http5xx', '服务内部错误，可重试', { status: response.status, detail })
      }
      throw new AgentError('http4xx', detail || `请求被拒绝（HTTP ${response.status}）`, {
        status: response.status,
        detail,
      })
    }

    const payload = (await response.json()) as Partial<AgentRunResult>
    return {
      ok: payload.ok !== false,
      answer: typeof payload.answer === 'string' ? payload.answer : '',
      steps: Array.isArray(payload.steps) ? payload.steps : [],
      observations: Array.isArray(payload.observations) ? payload.observations : [],
      toolsUsed: Array.isArray(payload.toolsUsed) ? payload.toolsUsed : [],
      mock: payload.mock === true,
      refs: Array.isArray(payload.refs) ? payload.refs : [],
      queryUsed: typeof payload.queryUsed === 'string' ? payload.queryUsed : query,
    }
  } catch (error) {
    if (error instanceof AgentError) throw error
    if (timeoutHit) {
      throw new AgentError('timeout', '后端响应超时，可重试')
    }
    if ((error as Error)?.name === 'AbortError') {
      throw error
    }
    // fetch 连不上（后端没启动 / 端口不通）都会落到这里
    throw new AgentError('offline', `AI 服务未启动（端口 ${AGENT_PORT}），请先启动后端`, {
      detail: (error as Error)?.message,
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}
