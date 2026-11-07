/**
 * 结构化日志
 *
 * 目标：日志能被「人看」也能被「机器查」。
 *   - 默认输出 JSON Lines（一行一条），便于 grep / jq / 采集到日志平台
 *   - 设置 LITEOFFICE_LOG_FORMAT=text 可切回人类可读格式（本地调试用）
 *   - LITEOFFICE_LOG_LEVEL=debug|info|warn|error|silent 控制级别，默认 info
 *
 * 约定：
 *   1. 一律用 logger.xxx('事件名', { 关键字段 })，不要拼接字符串
 *   2. 异常统一走 logger.error('...', { err }) —— 会自动序列化 name/message/stack/code
 *   3. token / Authorization / 密码等敏感字段在序列化时自动脱敏
 *   4. 每个请求用 child({ requestId }) 派生子 logger，日志可按请求聚合
 */
import { randomUUID } from 'node:crypto'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
const configured = String(process.env.LITEOFFICE_LOG_LEVEL ?? 'info').toLowerCase()
const MIN_LEVEL = LEVELS[configured] ?? LEVELS.info
const JSON_MODE = String(process.env.LITEOFFICE_LOG_FORMAT ?? 'json').toLowerCase() !== 'text'
const SERVICE = process.env.LITEOFFICE_SERVICE_NAME ?? 'liteoffice-backend'

/** 命中这些键名的值不回显（只保留长度），避免 token 泄漏到日志 */
const SENSITIVE_KEY = /^(token|authorization|cookie|password|secret|api[-_]?key|contentBase64)$/i
const MAX_STRING = 500
const MAX_DEPTH = 4
const MAX_ARRAY = 20

export class Logger {
  constructor(bindings = {}) {
    this.bindings = bindings
  }

  /** 派生带额外字段的 logger（例如每个请求一个 requestId） */
  child(bindings = {}) {
    return new Logger({ ...this.bindings, ...bindings })
  }

  debug(msg, data) {
    this.#write('debug', msg, data)
  }

  info(msg, data) {
    this.#write('info', msg, data)
  }

  warn(msg, data) {
    this.#write('warn', msg, data)
  }

  error(msg, data) {
    this.#write('error', msg, data)
  }

  /**
   * 计时器：const end = logger.time(); ... end('完成', { rows: n })
   * 返回的函数把耗时（ms）写入日志字段 durationMs。
   */
  time() {
    const started = process.hrtime.bigint()
    return (msg, data = {}) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      this.#write('info', msg, { ...data, durationMs: Math.round(ms * 10) / 10 })
      return ms
    }
  }

  #write(level, msg, data) {
    const value = LEVELS[level] ?? LEVELS.info
    if (value < MIN_LEVEL) return

    const payload = {
      ts: new Date().toISOString(),
      level,
      service: SERVICE,
      msg: String(msg),
      ...this.bindings,
      ...normalize(data),
    }

    emit(level, JSON_MODE ? JSON.stringify(payload) : formatText(payload))
  }
}

function emit(level, line) {
  // warn / error 走 stderr，便于运维按流分流；其余走 stdout
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

function formatText(payload) {
  const { ts, level, service, msg, ...rest } = payload
  const head = `${ts} ${level.toUpperCase().padEnd(5)} [${service}] ${msg}`
  const tail = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : safeStringify(v)}`)
    .join(' ')
  return tail ? `${head} ${tail}` : head
}

/**
 * 把任意值整理成可安全序列化的对象：
 *   - Error → { name, message, stack, code }
 *   - 敏感键 → '<redacted:N>'
 *   - 超长字符串 / 过深结构 / 过长数组 → 截断
 */
export function normalize(value, depth = 0) {
  if (value == null) return value

  if (value instanceof Error) return serializeError(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[depth-limit]'

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => normalize(item, depth + 1))
    if (value.length > MAX_ARRAY) items.push(`…(+${value.length - MAX_ARRAY})`)
    return items
  }

  if (value instanceof Uint8Array) return `<bytes:${value.length}>`

  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      const len = typeof item === 'string' ? item.length : 0
      out[key] = `<redacted:${len}>`
    } else if (typeof item === 'string') {
      out[key] = item.length > MAX_STRING ? `${item.slice(0, MAX_STRING)}…(+${item.length})` : item
    } else {
      out[key] = normalize(item, depth + 1)
    }
  }
  return out
}

/** 异常 → 可读对象；保留 cause 链，便于定位「是谁包了一层」 */
export function serializeError(err, depth = 0) {
  if (!(err instanceof Error)) return { name: 'NonError', message: String(err) }
  const out = {
    name: err.name,
    message: err.message,
    code: err.code,
    // 只保留前 8 帧，避免日志被超长栈淹没
    stack: typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 8).join('\n') : undefined,
  }
  if (err.cause && depth < 3) out.cause = serializeError(err.cause, depth + 1)
  if (err.details !== undefined) out.details = normalize(err.details)
  return out
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

/** 全局根 logger：没有请求上下文时使用 */
export const logger = new Logger({})

export function createLogger(scope, bindings = {}) {
  return new Logger({ scope, ...bindings })
}

/** 请求 ID：优先复用上游传入，便于跨服务串联 */
export function newRequestId() {
  return randomUUID()
}

export { LEVELS, MIN_LEVEL, JSON_MODE }
