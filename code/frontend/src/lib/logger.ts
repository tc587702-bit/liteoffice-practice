/**
 * 前端日志
 *
 * 目标：出问题时用户能自助导出「有上下文」的日志，而不是只看到一句白屏报错。
 *
 * 设计：
 *   1. 分级：debug / info / warn / error，默认开发环境 debug、生产环境 warn
 *   2. 内存环形缓冲（最近 300 条）：即使控制台被关掉也能事后导出
 *   3. 生产环境只把 error 打到控制台，避免噪音；开发环境全量输出
 *   4. 可选远程上报：设置 VITE_LOG_ENDPOINT 后，error 级日志用 sendBeacon 上报
 *   5. 日志本身绝不允许抛错（catch 包住），不能因为写日志把主流程搞挂
 *
 * 用法：
 *   const log = createLogger('parse')
 *   log.debug('开始解析', { name, size })
 *   const done = log.time('解析 docx'); ... ; done({ paragraphs })
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogErrorInfo {
  name: string
  message: string
  stack?: string
  code?: string
}

export interface LogRecord {
  time: string
  level: LogLevel
  scope: string
  message: string
  data?: Record<string, unknown>
  error?: LogErrorInfo
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_RECORDS = 300
const MAX_STRING = 300
const MAX_ARRAY = 20

/** 开发环境：全量；生产：只留 warn 及以上（error 才进 console） */
let minLevel: LogLevel = import.meta.env.DEV ? 'debug' : 'warn'
let consoleLevel: LogLevel = import.meta.env.DEV ? 'debug' : 'error'

const records: LogRecord[] = []
const listeners = new Set<(record: LogRecord) => void>()

/** 远程上报地址（可选）：POST { records: [...] } */
const endpoint: string | undefined = import.meta.env.VITE_LOG_ENDPOINT as string | undefined

export function setLogLevel(level: LogLevel, consoleAt: LogLevel = level) {
  minLevel = level
  consoleLevel = consoleAt
}

export function getLogLevel(): LogLevel {
  return minLevel
}

/** 读取最近的日志（供「导出诊断信息」按钮使用） */
export function getLogRecords(): readonly LogRecord[] {
  return records
}

/** 导出为可直接贴进 issue 的纯文本 */
export function dumpLogs(): string {
  return records
    .map((r) => {
      const base = `${r.time} ${r.level.toUpperCase().padEnd(5)} [${r.scope}] ${r.message}`
      const extra = r.data && Object.keys(r.data).length ? ` ${safeStringify(r.data)}` : ''
      let err = ''
      if (r.error) {
        let stack = ''
        if (r.error.stack) stack = `\n${r.error.stack.split('\n').slice(0, 5).join('\n')}`
        err = `\n    ${r.error.name}: ${r.error.message}${stack}`
      }
      return base + extra + err
    })
    .join('\n')
}

export function clearLogs() {
  records.length = 0
}

/** 订阅新日志（可用于调试面板）；返回取消订阅函数 */
export function onLog(listener: (record: LogRecord) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 把任意值整理成可安全序列化的结构，避免循环引用 / 超长字符串撑爆内存 */
function normalize(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (value instanceof Error) return serializeError(value)
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length})` : value
  }
  if (typeof value !== 'object') return value
  if (depth >= 3) return '[depth-limit]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => normalize(item, depth + 1))
    if (value.length > MAX_ARRAY) items.push(`…(+${value.length - MAX_ARRAY})`)
    return items
  }
  if (value instanceof ArrayBuffer) return `<ArrayBuffer:${value.byteLength}>`
  if (value instanceof Blob) return `<Blob:${value.size}>`
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = normalize(item, depth + 1)
  }
  return out
}

function serializeError(error: unknown): LogErrorInfo {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 8).join('\n'),
      code: (error as Error & { code?: string }).code,
    }
  }
  return { name: 'NonError', message: String(error) }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

function write(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>, error?: unknown) { // NOSONAR: 复杂度高，后续拆分
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return

  const record: LogRecord = {
    time: new Date().toISOString(),
    level,
    scope,
    message,
  }
  if (data && Object.keys(data).length) record.data = normalize(data) as Record<string, unknown>
  if (error !== undefined) record.error = serializeError(error)

  // 环形缓冲：超长时丢最旧的，保证内存可控
  records.push(record)
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)

  for (const listener of listeners) {
    try {
      listener(record)
    } catch {
      /* 订阅者自己出错不影响日志系统 */
    }
  }

  if (LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[consoleLevel] && typeof console !== 'undefined') {
    const prefix = `[${scope}] ${message}`
    // eslint-disable-next-line no-console
    let sink = console.log
    if (level === 'error') sink = console.error
    else if (level === 'warn') sink = console.warn
    try {
      if (record.error) sink(prefix, record.data ?? {}, record.error)
      else if (record.data) sink(prefix, record.data)
      else sink(prefix)
    } catch {
      /* 某些环境 console 可能被禁用 */
    }
  }

  if (level === 'error' && endpoint) sendRemote(record)
}

/** 远程上报：用 sendBeacon 尽量不阻塞页面关闭；失败静默（不做重试，避免雪崩） */
function sendRemote(record: LogRecord) {
  try {
    const payload = JSON.stringify({ records: [record] })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(endpoint as string, new Blob([payload], { type: 'application/json' }))
      return
    }
    void fetch(endpoint as string, { method: 'POST', body: payload, keepalive: true, headers: { 'content-type': 'application/json' } })
  } catch {
    /* 上报失败不影响业务 */
  }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, error?: unknown, data?: Record<string, unknown>): void
  /** 派生同前缀的子 logger，例如 parse:docx */
  child(scope: string): Logger
  /** 计时：调用返回的函数会打印耗时 */
  time(message: string): (data?: Record<string, unknown>) => number
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, data) => write('debug', scope, message, data),
    info: (message, data) => write('info', scope, message, data),
    warn: (message, data) => write('warn', scope, message, data),
    error: (message, error, data) => write('error', scope, message, data, error),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
    time: (message) => {
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
      return (data) => {
        const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started
        write('debug', scope, message, { ...data, durationMs: Math.round(elapsed) })
        return elapsed
      }
    },
  }
}

/** 全局默认 logger（应用级事件） */
export const logger = createLogger('app')
