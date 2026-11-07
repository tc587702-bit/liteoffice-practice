/**
 * 错误模型
 *
 * 原则：
 *   1. 业务错误用 AppError 子类携带「状态码 + 机器可读 code + 用户可见文案」，
 *      路由里直接 throw，由统一出口转成 HTTP 响应；不要在路由里手写 json(res, 500, ...)
 *   2. expose=false 的错误（默认 500）对外只回通用文案，细节只进日志，
 *      避免把 SQL / 路径 / 堆栈泄漏给客户端
 *   3. 响应体保持既有约定 { error: '人话' }，额外加 code / requestId 便于排查
 */

export class AppError extends Error {
  /**
   * @param {string} message 内部/对外文案
   * @param {object} [options]
   * @param {string} [options.code] 机器可读错误码，默认取类名
   * @param {number} [options.status] HTTP 状态码
   * @param {boolean} [options.expose] 是否把 message 原样回给客户端
   * @param {unknown} [options.details] 附加信息（只进日志，默认不返回）
   * @param {unknown} [options.cause] 原始异常
   */
  constructor(message, { code, status = 500, expose = false, details, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = new.target.name
    this.code = code ?? (new.target.name.replace(/Error$/, '').toUpperCase() || 'INTERNAL')
    this.status = status
    this.expose = expose
    this.details = details
  }
}

export class BadRequestError extends AppError {
  constructor(message = '请求参数不合法', options = {}) {
    super(message, { status: 400, expose: true, code: 'BAD_REQUEST', ...options })
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '未授权', options = {}) {
    super(message, { status: 401, expose: true, code: 'UNAUTHORIZED', ...options })
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在', options = {}) {
    super(message, { status: 404, expose: true, code: 'NOT_FOUND', ...options })
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = '请求体过大', options = {}) {
    super(message, { status: 413, expose: true, code: 'PAYLOAD_TOO_LARGE', ...options })
  }
}

export class RateLimitedError extends AppError {
  constructor(message = '请求过于频繁，请稍后再试', options = {}) {
    super(message, { status: 429, expose: true, code: 'RATE_LIMITED', ...options })
  }
}

export class GoneError extends AppError {
  constructor(message = '资源已失效', options = {}) {
    super(message, { status: 410, expose: true, code: 'GONE', ...options })
  }
}

export class UpstreamError extends AppError {
  constructor(message = '上游服务不可用', options = {}) {
    super(message, { status: 503, expose: true, code: 'UPSTREAM_UNAVAILABLE', ...options })
  }
}

/** 判断是否已是业务错误（避免重复包装） */
export function isAppError(err) {
  return err instanceof AppError
}

/**
 * 任意异常 → { status, body, logLevel }
 * body 只包含可安全外发的内容；requestId 便于用户报障时对上日志。
 */
export function toHttpError(err, requestId = '') {
  if (isAppError(err)) {
    return {
      status: err.status,
      body: {
        error: err.expose ? err.message : '服务器内部错误',
        code: err.code,
        ...(requestId ? { requestId } : {}),
      },
      logLevel: err.status >= 500 ? 'error' : 'warn',
    }
  }

  // 旧代码里仍在抛裸 Error('BODY_TOO_LARGE')，这里兜底映射，避免逐个改
  if (err instanceof Error && err.message === 'BODY_TOO_LARGE') {
    return {
      status: 413,
      body: { error: '请求体过大（上限 30 MB）', code: 'PAYLOAD_TOO_LARGE', ...(requestId ? { requestId } : {}) },
      logLevel: 'warn',
    }
  }
  if (err instanceof Error && err.message === 'BAD_JSON') {
    return {
      status: 400,
      body: { error: '请求体不是合法 JSON', code: 'BAD_JSON', ...(requestId ? { requestId } : {}) },
      logLevel: 'warn',
    }
  }

  return {
    status: 500,
    body: { error: '服务器内部错误', code: 'INTERNAL', ...(requestId ? { requestId } : {}) },
    logLevel: 'error',
  }
}
