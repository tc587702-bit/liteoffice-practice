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
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
const configured = String(process.env.LITEOFFICE_LOG_LEVEL ?? 'info').toLowerCase()
const MIN_LEVEL = LEVELS[configured] ?? LEVELS.info
const JSON_MODE = String(process.env.LITEOFFICE_LOG_FORMAT ?? 'json').toLowerCase() !== 'text'
const SERVICE = process.env.LITEOFFICE_SERVICE_NAME ?? 'liteoffice-backend'

/* ---------------- 落盘 ---------------- */

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 日志文件路径；LITEOFFICE_LOG_FILE=off 可关闭落盘（排查「日志写不进去」时用） */
const LOG_FILE_ENV = process.env.LITEOFFICE_LOG_FILE
const LOG_FILE_RAW =
  LOG_FILE_ENV === undefined ? resolve(__dirname, '..', 'logs', 'backend.log') : String(LOG_FILE_ENV).trim()
let FILE_ENABLED = !['', 'off', 'false', '0', 'none', 'disable', 'disabled'].includes(LOG_FILE_RAW.toLowerCase())
const LOG_FILE = FILE_ENABLED ? resolve(LOG_FILE_RAW) : ''
/** 单文件上限（默认 10 MB）与保留份数（默认 3 份，即 .1 .2 .3） */
const MAX_FILE_BYTES = Number(process.env.LITEOFFICE_LOG_MAX_BYTES ?? 10 * 1024 * 1024) || 10 * 1024 * 1024
const BACKUPS = Number(process.env.LITEOFFICE_LOG_BACKUPS ?? 3) || 0

let fileSize = 0
let fileErrorReported = false

if (FILE_ENABLED) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    fileSize = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0
  } catch (err) {
    FILE_ENABLED = false // 目录建不出来就退化为只打控制台，不能因为日志把服务搞挂
    process.stderr.write(`[logger] 无法初始化日志文件 ${LOG_FILE}: ${err?.message}\n`)
  }
}

/** 大小轮转：backend.log → backend.log.1 → .2 → .3，最旧的丢弃 */
function rotateIfNeeded(nextLength) {
  if (fileSize + nextLength <= MAX_FILE_BYTES) return
  try {
    if (BACKUPS > 0) {
      rmSync(`${LOG_FILE}.${BACKUPS}`, { force: true })
      for (let i = BACKUPS - 1; i >= 1; i -= 1) {
        if (existsSync(`${LOG_FILE}.${i}`)) renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`)
      }
      if (existsSync(LOG_FILE)) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } else {
      rmSync(LOG_FILE, { force: true })
    }
    fileSize = 0
  } catch (err) {
    if (!fileErrorReported) {
      fileErrorReported = true
      process.stderr.write(`[logger] 日志轮转失败 ${LOG_FILE}: ${err?.message}\n`)
    }
  }
}

/**
 * 写文件。用同步写是为了保证进程崩溃（uncaughtException）前最后几条日志真的落盘；
 * 本项目日志量很小，同步写带来的阻塞可以忽略。
 */
function writeFile(line) {
  if (!FILE_ENABLED) return
  try {
    const bytes = Buffer.byteLength(line) + 1
    rotateIfNeeded(bytes)
    appendFileSync(LOG_FILE, line + '\n')
    fileSize += bytes
  } catch (err) {
    // 只报一次，避免磁盘满时每次写日志都刷屏（递归风险）
    if (!fileErrorReported) {
      fileErrorReported = true
      process.stderr.write(`[logger] 写入日志文件失败 ${LOG_FILE}: ${err?.message}\n`)
    }
  }
}

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

    // 文件里永远是 JSON（便于 grep/jq），控制台按 LITEOFFICE_LOG_FORMAT 决定
    writeFile(JSON.stringify(payload))
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

export { LEVELS, MIN_LEVEL, JSON_MODE, LOG_FILE, FILE_ENABLED }
