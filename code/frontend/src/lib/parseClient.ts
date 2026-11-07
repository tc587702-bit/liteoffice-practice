import type { XlsxParseResult } from './xlsx'
import { createLogger } from './logger'

const log = createLogger('worker')

/**
 * 解析 Worker 客户端。
 *
 * 约束：`lib/docx.ts` 与 `lib/xlsx.ts` 的回退解析器依赖 DOMParser，
 * 而 Web Worker 里没有 DOMParser，因此：
 *   - md：renderMarkdown 是纯字符串处理 → 放 Worker（完整）
 *   - xlsx：SheetJS 主路径不碰 DOM → 放 Worker（完整）；回退解析器留在主线程
 *   - docx / pdf：解析依赖 DOMParser（docx）或自带 worker（pdf.js）→ 主线程/pdf 自带 worker
 */

export interface WorkerProgress {
  done: number
  total: number
  label?: string
}

export interface WorkerRunOptions {
  signal?: AbortSignal
  onProgress?: (progress: WorkerProgress) => void
}

interface WorkerReply<T> {
  id: number
  ok: boolean
  result?: T
  message?: string
  name?: string
  progress?: WorkerProgress
}

let seed = 0

function runWorker<T>(
  name: string,
  factory: () => Worker,
  payload: Record<string, unknown>,
  options: WorkerRunOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const started = performance.now()
    let worker: Worker
    try {
      worker = factory()
    } catch (error) {
      // Worker 构造失败（如浏览器禁用 worker / CSP 拦截）：把原始原因带出来
      log.error('创建 Worker 失败', error, { worker: name })
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const id = ++seed
    let settled = false
    log.debug('Worker 启动', { worker: name, id })

    const cleanup = () => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const fail = (error: Error) => {
      const elapsed = Math.round(performance.now() - started)
      if (error.name === 'AbortError') log.debug('Worker 已取消', { worker: name, id, elapsedMs: elapsed })
      else log.warn('Worker 执行失败', { worker: name, id, elapsedMs: elapsed, errorName: error.name, message: error.message, payloadKeys: Object.keys(payload) })
      cleanup()
      reject(error)
    }
    const onAbort = () => fail(new DOMException('aborted', 'AbortError'))

    if (options.signal?.aborted) {
      worker.terminate()
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    worker.onmessage = (event: MessageEvent<WorkerReply<T>>) => {
      const data = event.data
      if (data?.id !== id) return
      if (data.progress) {
        options.onProgress?.(data.progress)
        return
      }
      if (!data.ok) {
        const error = new Error(data.message ?? 'Worker 执行失败')
        if (data.name) error.name = data.name
        fail(error)
        return
      }
      log.debug('Worker 完成', { worker: name, id, elapsedMs: Math.round(performance.now() - started) })
      cleanup()
      resolve(data.result as T)
    }
    worker.onerror = (event) => {
      // Worker 内部未捕获异常（多半是内存不足或 OOM 被浏览器杀掉）
      const error = new Error(event.message || 'Worker 崩溃（可能是内存不足）')
      error.name = 'WorkerError'
      log.error('Worker 崩溃', error, { worker: name, filename: event.filename, lineno: event.lineno })
      fail(error)
    }
    worker.postMessage({ id, ...payload })
  })
}

/** Markdown → 安全 HTML（Worker） */
export function renderMarkdownInWorker(text: string, options: WorkerRunOptions = {}): Promise<string> {
  return runWorker<string>(
    'markdown',
    () => new Worker(new URL('./workers/md.worker.ts', import.meta.url), { type: 'module' }),
    { text },
    options,
  )
}

/** xlsx SheetJS 主路径解析（Worker）；失败时由调用方在主线程走回退解析器 */
export function parseXlsxInWorker(
  buffer: ArrayBuffer,
  options: WorkerRunOptions = {},
): Promise<XlsxParseResult> {
  return runWorker<XlsxParseResult>(
    'xlsx',
    () => new Worker(new URL('./workers/xlsx.worker.ts', import.meta.url), { type: 'module' }),
    { buffer },
    options,
  )
}
