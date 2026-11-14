/**
 * 统一错误模型与全局兜底
 *
 * 分工：
 *   - logger.ts 负责「记下来」：结构化分级日志 + 环形缓冲
 *   - 本文件负责「翻译 + 上报」：把任意异常变成带 code / 用户文案的 AppError，
 *     并挂上全局兜底（Vue 渲染错误、window.onerror、未处理的 Promise、路由错误）
 *
 * 用法：
 *   throw new AppError('无法解析该文件', { code: 'PARSE_FAILED', cause: err })
 *   catch (err) { reportError(err, { scope: 'import' }); toast(userMessageOf(err)) }
 */
import type { App } from 'vue'
import type { Router } from 'vue-router'
import { createLogger, dumpLogs, logger } from './logger'

const log = createLogger('errors')

export interface AppErrorOptions {
  /** 机器可读错误码，便于统计与埋点 */
  code?: string
  /** 直接给用户看的文案；缺省用 message */
  userMessage?: string
  /** 附加上下文（只进日志，不展示给用户） */
  context?: Record<string, unknown>
  /** 是否可重试/可恢复，用于决定 UI 是「重试」还是「下载原始文件」 */
  recoverable?: boolean
  cause?: unknown
}

export class AppError extends Error {
  readonly code: string
  readonly userMessage: string
  readonly context?: Record<string, unknown>
  readonly recoverable: boolean

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message)
    this.name = 'AppError'
    this.code = options.code ?? 'APP_ERROR'
    this.userMessage = options.userMessage ?? message
    this.context = options.context
    this.recoverable = options.recoverable ?? false
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** 任意异常 → AppError（幂等，已是 AppError 则原样返回） */
export function toAppError(error: unknown, fallbackMessage = '出现未知错误'): AppError {
  if (error instanceof AppError) return error
  if (error instanceof Error) {
    return new AppError(error.message || fallbackMessage, {
      code: error.name === 'AbortError' ? 'ABORTED' : 'UNEXPECTED',
      userMessage: fallbackMessage,
      cause: error,
      recoverable: error.name === 'AbortError',
    })
  }
  return new AppError(String(error) || fallbackMessage, { code: 'UNEXPECTED', cause: error })
}

/** 取给用户看的文案：AppError 用 userMessage，普通异常允许直接展示（本地工具，信息不敏感） */
export function userMessageOf(error: unknown, fallback = '出现未知错误'): string {
  if (error instanceof AppError) return error.userMessage
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** 取消/中止不是错误：调用方应静默忽略，不要弹 toast，也不要上报 */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

/** 内存不足类错误：需要引导用户换小文件，而不是简单重试 */
export function isMemoryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'WorkerError' || /out of memory|allocation failed|memory/i.test(error.message)
}

/* ------------------------------------------------------------------ */
/* 上报：日志 + 通知 UI                                                 */
/* ------------------------------------------------------------------ */

type ErrorReporter = (error: AppError) => void
const reporters = new Set<ErrorReporter>()

/** 注册 UI 侧处理（例如弹 toast）；返回取消注册函数 */
export function onReportedError(reporter: ErrorReporter): () => void {
  reporters.add(reporter)
  return () => reporters.delete(reporter)
}

/**
 * 记录并上报一个异常。
 * 注意：这里绝不重新抛出，避免「处理错误」本身又变成新的错误。
 */
export function reportError(error: unknown, context: Record<string, unknown> = {}): AppError {
  const appError = toAppError(error)
  try {
    log.error(appError.message, appError.cause ?? appError, {
      code: appError.code,
      recoverable: appError.recoverable,
      ...context,
      ...appError.context,
    })
    for (const reporter of reporters) {
      try {
        reporter(appError)
      } catch (reporterError) {
        log.warn('错误上报回调自身出错', { reporterError: String(reporterError) })
      }
    }
  } catch {
    /* 兜底：日志系统故障不能影响主流程 */
  }
  return appError
}

/* ------------------------------------------------------------------ */
/* 全局兜底                                                            */
/* ------------------------------------------------------------------ */

let installed = false

/**
 * 安装全局错误兜底。必须在 mount 之前调用。
 * 覆盖四类「否则会静默失败」的场景：
 *   1. Vue 组件渲染/生命周期异常
 *   2. 未捕获的 window 错误（第三方库抛错、图片解码等）
 *   3. 未处理的 Promise 拒绝（最常见的「点了没反应」来源）
 *   4. 路由懒加载/导航守卫异常
 */
export function installGlobalErrorHandlers(app: App, router: Router): void {
  if (installed) return
  installed = true

  app.config.errorHandler = (error, instance, info) => {
    reportError(error, {
      source: 'vue',
      info,
      component: (instance?.$options?.name as string | undefined) ?? 'anonymous',
    })
  }

  if (import.meta.env.DEV) {
    // 仅在开发环境提示 Vue 警告，生产环境不打扰用户
    app.config.warnHandler = (message, _instance, trace) => {
      log.warn('Vue 警告', { message, trace: trace?.slice(0, 300) })
    }
  }

  window.addEventListener('error', (event) => {
    // 资源加载失败（img/script）只有 target 没有 error，单独处理，避免误报成 JS 异常
    const target = event.target as HTMLElement | null
    if (target && target !== (window as unknown as HTMLElement) && 'src' in target) {
      log.warn('资源加载失败', { tag: target.tagName, src: (target as HTMLImageElement).src })
      return
    }
    reportError(event.error ?? event.message, { source: 'window', filename: event.filename, lineno: event.lineno })
  })

  window.addEventListener('unhandledrejection', (event) => {
    // 取消类拒绝是预期内的，不上报也不打 error
    if (isAbortError(event.reason)) {
      event.preventDefault()
      return
    }
    reportError(event.reason, { source: 'promise' })
  })

  router.onError((error, to) => {
    reportError(error, { source: 'router', to: to?.fullPath })
  })

  logger.info('全局错误兜底已安装', { env: import.meta.env.MODE })
}

/* ------------------------------------------------------------------ */
/* 诊断信息                                                            */
/* ------------------------------------------------------------------ */

/**
 * 收集一份可直接贴进 issue 的诊断信息（不含文档内容，只有元数据 + 日志）。
 */
export function collectDiagnostics(): string {
  const viewport =
    typeof window !== 'undefined'
      ? `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`
      : 'n/a'
  const lines = [
    `时间：${new Date().toISOString()}`,
    `地址：${typeof location !== 'undefined' ? location.href : 'n/a'}`,
    `UA：${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}`,
    `视口：${viewport}`,
    `语言：${typeof navigator !== 'undefined' ? navigator.language : 'n/a'}`,
    `--- 最近日志 ---`,
    dumpLogs(),
  ]
  return lines.join('\n')
}
