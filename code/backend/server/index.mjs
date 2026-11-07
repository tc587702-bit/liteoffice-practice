/**
 * LiteOffice 协作后端
 *
 * 路由：
 *   GET  /                        健康检查 + 前端静态文件（若存在 dist）
 *   POST /api/docs                上传文档  { title, kind, html, contentBase64 }
 *   GET  /api/docs                最近文档列表
 *   GET  /api/docs/:id            取文档
 *   POST /api/docs/:id/share      生成分享链接 { role, expiresInHours }
 *   GET  /api/docs/:id/shares     列出该文档的链接
 *   POST /api/share/:token/revoke 撤销链接
 *   GET  /api/share/:token        用链接取内容（校验 存在/撤销/过期）
 *   GET  /d/:token                只读分享页
 *   WS   /ws?token=...            在线状态 + Yjs 增量转发
 *
 * 存储：Node 内置 node:sqlite，单文件 data/liteoffice.db
 * 依赖：ws（WebSocket）、yjs + y-protocols（CRDT 同步）
 */
import http from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import {
  createDocument,
  getDocument,
  listDocuments,
  updateDocumentHtml,
  appendUpdate,
  listUpdates,
  latestSnapshot,
  saveSnapshot,
  latestSeq,
  pruneUpdates,
  closeDb,
  DB_PATH,
} from './db.mjs'
import { makeShare, checkShare, revoke, sharesOf, reasonText, noteFailure, isBlocked } from './share.mjs'
import { sanitizeHtml } from './sanitize.mjs'
import { createLogger, newRequestId } from './logger.mjs'
import {
  GoneError,
  NotFoundError,
  PayloadTooLargeError,
  BadRequestError,
  RateLimitedError,
  toHttpError,
} from './errors.mjs'

const accessLog = createLogger('http')
const wsLog = createLogger('ws')
const staticLog = createLogger('static')
const proxyLog = createLogger('proxy')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const PUBLIC_DIR = join(ROOT, 'public')
const DIST_DIR = resolve(ROOT, '..', 'frontend', 'dist')
const PORT = Number(process.env.PORT ?? 3000)
const MAX_BODY = 30 * 1024 * 1024 // 30 MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const json = (res, code, body) => {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new PayloadTooLargeError('请求体过大（上限 30 MB）', { details: { size } })
    chunks.push(chunk)
  }
  if (!chunks.length) return null
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buf = await readBody(req)
  if (!buf) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch (err) {
    // 400 而不是 500：客户端问题，且不回显原文（可能很大 / 含敏感信息）
    throw new BadRequestError('请求体不是合法 JSON', { code: 'BAD_JSON', cause: err })
  }
}

async function serveFile(res, filePath) {
  try {
    const s = await stat(filePath)
    if (!s.isFile()) return false
    const data = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=60',
    })
    res.end(data)
    return true
  } catch (err) {
    // 文件不存在是正常分支（回退到下一个目录），只有真正的 IO 错误才是异常
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      staticLog.debug('静态文件不存在', { path: filePath })
    } else {
      staticLog.warn('读取静态文件失败', { path: filePath, err })
    }
    return false
  }
}

/** 日志里的 URL 不能带分享 token：32 位十六进制一律替换成 <token> */
const redactPath = (pathname) => String(pathname ?? '').replace(/\b[0-9a-f]{32}\b/gi, '<token>')

const clientIp = (req) =>
  (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.socket.remoteAddress ?? '').trim()

/* ---------------- 路由 ---------------- */

async function handleApi(req, res, url) { // NOSONAR: 复杂度高，后续拆分
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'docs', id?, ...]
  const method = req.method ?? 'GET'
  const log = req.log ?? accessLog

  // POST /api/docs
  if (parts[0] === 'api' && parts[1] === 'docs' && parts.length === 2 && method === 'POST') {
    const body = await readJson(req)
    const title = String(body.title ?? '未命名文档').slice(0, 200)
    const kind = String(body.kind ?? 'docx')
    const html = sanitizeHtml(String(body.html ?? '')) // 防存储型 XSS
    const content = body.contentBase64 ? Buffer.from(body.contentBase64, 'base64') : null
    const id = createDocument({ title, kind, html, content })
    log.info('创建文档', { docId: id, kind, title, bytes: content?.length ?? 0 })
    return json(res, 201, { id, title, kind, size: content?.length ?? 0 })
  }

  // GET /api/docs
  if (parts[0] === 'api' && parts[1] === 'docs' && parts.length === 2 && method === 'GET') {
    return json(res, 200, { docs: listDocuments() })
  }

  // /api/docs/:id
  if (parts[0] === 'api' && parts[1] === 'docs' && parts[2]) {
    const doc = getDocument(parts[2])
    if (!doc && parts.length === 3) throw new NotFoundError('文档不存在', { details: { docId: parts[2] } })

    // GET /api/docs/:id/shares
    if (parts[3] === 'shares' && method === 'GET') {
      if (!doc) throw new NotFoundError('文档不存在', { details: { docId: parts[2] } })
      return json(res, 200, { shares: sharesOf(doc.id) })
    }

    // POST /api/docs/:id/share
    if (parts[3] === 'share' && method === 'POST') {
      if (!doc) throw new NotFoundError('文档不存在', { details: { docId: parts[2] } })
      const body = await readJson(req)
      const role = body.role === 'edit' ? 'edit' : 'view'
      const expiresInHours = Number(body.expiresInHours ?? 0)
      if (!Number.isFinite(expiresInHours) || expiresInHours < 0) {
        throw new BadRequestError('expiresInHours 必须是非负数字', { code: 'INVALID_EXPIRES' })
      }
      const s = makeShare({ docId: doc.id, role, expiresInHours })
      const host = req.headers.host ?? `localhost:${PORT}`
      const origin = `http://${host}`
      log.info('生成分享链接', { docId: doc.id, role, expiresInHours, expiresAt: s.expiresAt })
      return json(res, 201, { ...s, url: origin + s.url })
    }

    // POST /api/docs/:id/save  覆盖保存（协作场景下用于落 HTML）
    if (parts[3] === 'save' && method === 'POST') {
      if (!doc) throw new NotFoundError('文档不存在', { details: { docId: parts[2] } })
      const body = await readJson(req)
      updateDocumentHtml(doc.id, sanitizeHtml(String(body.html ?? '')))
      log.debug('覆盖保存文档', { docId: doc.id })
      return json(res, 200, { ok: true })
    }

    if (parts.length === 3 && method === 'GET') {
      return json(res, 200, {
        doc: {
          id: doc.id,
          title: doc.title,
          kind: doc.kind,
          html: doc.html,
          size: doc.content?.length ?? 0,
          contentBase64: doc.content ? Buffer.from(doc.content).toString('base64') : null,
          updatedAt: doc.updated_at,
        },
      })
    }
  }

  // GET /api/share/:token
  if (parts[0] === 'api' && parts[1] === 'share' && parts[2] && method === 'GET') {
    const ip = clientIp(req)
    if (isBlocked(ip)) {
      log.warn('分享链接访问被限流', { ip, token: parts[2].slice(0, 8) })
      throw new RateLimitedError('尝试过于频繁，请稍后再试')
    }
    const r = checkShare(parts[2])
    if (!r.ok) {
      noteFailure(ip)
      // 4xx 是预期内的用户错误：warn 级别 + 原因码，不打印堆栈
      log.warn('分享链接不可用', { ip, reason: r.reason, token: parts[2].slice(0, 8) })
      throw new GoneError(reasonText(r.reason), { code: r.reason, details: { ip } })
    }
    return json(res, 200, {
      role: r.share.role,
      doc: {
        id: r.doc.id,
        title: r.doc.title,
        kind: r.doc.kind,
        html: r.doc.html,
        size: r.doc.content?.length ?? 0,
        contentBase64: r.doc.content ? Buffer.from(r.doc.content).toString('base64') : null,
      },
    })
  }

  // POST /api/share/:token/revoke
  if (parts[0] === 'api' && parts[1] === 'share' && parts[2] && parts[3] === 'revoke' && method === 'POST') {
    const ok = revoke(parts[2])
    if (!ok) throw new NotFoundError('链接不存在', { details: { token: parts[2].slice(0, 8) } })
    log.info('撤销分享链接', { token: parts[2].slice(0, 8) })
    return json(res, 200, { ok: true })
  }

  throw new NotFoundError('接口不存在', { details: { path: url.pathname, method } })
}

/* ---------------- 静态文件 ---------------- */

async function handleStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname)

  // /d/:token → 只读分享页
  if (pathname.startsWith('/d/')) {
    if (await serveFile(res, join(PUBLIC_DIR, 'd.html'))) return
    throw new NotFoundError('分享页缺失', { code: 'SHARE_PAGE_MISSING', details: { pathname } })
  }

  // 其余优先 public/，再退到 frontend/dist
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const rel = safe === '/' ? '/index.html' : safe
  if (await serveFile(res, join(PUBLIC_DIR, rel))) return
  if (await serveFile(res, join(DIST_DIR, rel))) return

  // 单页应用回退
  if (!extname(pathname)) {
    if (await serveFile(res, join(DIST_DIR, 'index.html'))) return
    if (await serveFile(res, join(PUBLIC_DIR, 'index.html'))) return
  }
  staticLog.debug('静态资源未命中', { path: pathname })
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

/* ---------------- WebSocket：在线状态 + Yjs ---------------- */

/** docId -> { doc: Y.Doc, conns: Set<ws>, awareness } */
const rooms = new Map()

function getRoom(docId) {
  let room = rooms.get(docId)
  if (room) return room

  const log = wsLog.child({ docId })
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)

  // 从库中恢复：先快照，再重放增量
  const snap = latestSnapshot(docId)
  if (snap?.state_blob) {
    try {
      Y.applyUpdate(doc, new Uint8Array(snap.state_blob), 'db')
    } catch (err) {
      // 快照损坏则忽略，靠增量重建——但必须留下痕迹，否则数据悄悄变少
      log.warn('快照损坏，改用增量重建', { atSeq: snap.at_seq, err })
    }
  }
  let replayed = 0
  let skipped = 0
  for (const row of listUpdates(docId, snap?.at_seq ?? 0)) {
    try {
      Y.applyUpdate(doc, new Uint8Array(row.update_blob), 'db')
      replayed += 1
    } catch (err) {
      skipped += 1
      log.warn('增量损坏，已跳过', { seq: row.seq, err })
    }
  }
  if (replayed || skipped) {
    log.info('房间状态恢复完成', { replayed, skipped, fromSnapshot: Boolean(snap) })
  }

  room = { doc, conns: new Set(), awareness, dirty: 0 }

  // 本地产生的更新 → 落库 + 广播
  doc.on('update', (update, origin) => {
    if (origin === 'db') return
    try {
      appendUpdate(docId, Buffer.from(update))
    } catch (err) {
      // 落库失败不阻断实时同步（内存里仍有完整状态），但必须告警，否则重连会丢内容
      log.error('写入协作增量失败，实时同步继续但持久化已降级', { err })
    }
    room.dirty += 1
    if (room.dirty >= 200) {
      room.dirty = 0
      try {
        const atSeq = latestSeq(docId)
        saveSnapshot(docId, atSeq, Buffer.from(Y.encodeStateAsUpdate(doc)))
        pruneUpdates(docId, atSeq)
        log.debug('折叠快照', { atSeq })
      } catch (err) {
        // 快照失败不影响同步：增量仍在，下次重试
        log.warn('写入快照失败（不影响本次同步）', { err })
      }
    }
    broadcast(room, update, origin)
  })

  rooms.set(docId, room)
  return room
}

function broadcast(room, update, except) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0) // messageSync
  syncProtocol.writeUpdate(enc, update)
  const msg = encoding.toUint8Array(enc)
  for (const ws of room.conns) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(msg)
  }
}

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (ws, { docId, role, token }) => {
  const room = getRoom(docId)
  const log = wsLog.child({ docId, role, connId: ws._socket?.remotePort ?? '-' })
  ws.docId = docId
  ws.role = role
  ws.token = token
  room.conns.add(ws)
  if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null }
  log.info('连接加入房间', { online: room.conns.size })

  // 初次同步：把当前状态发给新连接
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0)
  syncProtocol.writeSyncStep1(enc, room.doc)
  ws.send(encoding.toUint8Array(enc))

  // 广播在线人数
  const presence = JSON.stringify({ type: 'presence', online: room.conns.size })
  for (const c of room.conns) if (c.readyState === c.OPEN) c.send(presence)

  ws.on('message', (data) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data))
      const messageType = decoding.readVarUint(decoder)
      if (messageType !== 0) return // 暂只处理 doc 同步；awareness 由 presence 帧代替

      const syncType = decoding.readVarUint(decoder)

      // 0 = step1：对方要状态 → 回 step2（只读连接也允许读）
      if (syncType === 0) {
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, 0)
        encoding.writeVarUint(enc, 1) // step2
        encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(room.doc))
        ws.send(encoding.toUint8Array(enc))
        return
      }

      // 1 = step2 / 2 = update：只有可编辑连接才允许写入文档
      if (syncType === 1 || syncType === 2) {
        if (role !== 'edit') {
          log.warn('只读连接尝试写入，已忽略', { syncType, bytes: data.length })
          return // 只读连接静默忽略，防止越权改写
        }
        const update = decoding.readVarUint8Array(decoder)
        try {
          Y.applyUpdate(room.doc, update, ws)
        } catch (err) {
          log.warn('应用远端增量失败，已丢弃该帧', { syncType, bytes: data.length, err })
        }
      }
    } catch (err) {
      // 畸形帧：记 debug 而不是 error，避免恶意客户端刷日志
      log.debug('忽略畸形 WebSocket 帧', { bytes: data?.length ?? 0, err })
    }
  })

  ws.on('error', (err) => {
    log.warn('WebSocket 连接异常', { err })
  })

  ws.on('close', (code, reason) => {
    room.conns.delete(ws)
    log.info('连接离开房间', { online: room.conns.size, code, reason: String(reason ?? '') })
    const p = JSON.stringify({ type: 'presence', online: room.conns.size })
    for (const c of room.conns) if (c.readyState === c.OPEN) c.send(p)

    if (room.conns.size === 0) {
      // 落快照并裁掉已覆盖的增量
      try {
        const atSeq = latestSeq(docId)
        saveSnapshot(docId, atSeq, Buffer.from(Y.encodeStateAsUpdate(room.doc)))
        pruneUpdates(docId, atSeq)
        log.debug('离开时落快照', { atSeq })
      } catch (err) {
        log.warn('离开时落快照失败，增量仍在，重连后可恢复', { err })
      }
      // 空闲 30 秒后回收房间，避免长跑内存泄漏（留出重连窗口）
      clearTimeout(room.cleanupTimer)
      room.cleanupTimer = setTimeout(() => {
        if (room.conns.size === 0) {
          rooms.delete(docId)
          log.debug('回收空闲房间')
        }
      }, 30_000)
      room.cleanupTimer.unref?.()
    }
  })
})

/* ---------------- 反向代理：/agent/* → FastAPI :8100 ---------------- */

const AGENT_ORIGIN = process.env.AGENT_ORIGIN ?? 'http://127.0.0.1:8100'
const AGENT_PREFIX = '/agent'

function proxyToAgent(req, res, url) {
  // /agent/v1/tools → :8100/v1/tools
  const targetPath = url.pathname.slice(AGENT_PREFIX.length) || '/'
  const target = new URL(targetPath + url.search, AGENT_ORIGIN)
  const log = proxyLog.child({ path: redactPath(url.pathname), method: req.method, requestId: req.id })
  const started = Date.now()

  const headers = { ...req.headers, host: target.host }
  delete headers['content-length']
  // 透传请求 ID：Agent 侧日志与本服务日志可用同一个 ID 串联
  headers['x-request-id'] = req.id ?? headers['x-request-id']

  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
      timeout: 60_000,
    },
    (up) => {
      log.info('转发到 Agent', { status: up.statusCode, durationMs: Date.now() - started })
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )

  upstream.on('timeout', () => {
    upstream.destroy()
    log.warn('Agent 响应超时', { durationMs: Date.now() - started, timeoutMs: 60_000 })
    json(res, 504, { error: 'Agent 服务响应超时', code: 'AGENT_TIMEOUT' })
  })
  upstream.on('error', (err) => {
    log.error('Agent 不可达', { origin: AGENT_ORIGIN, err })
    json(res, 503, {
      error: 'Agent 服务未启动（python -m uvicorn app.main:app --port 8100）',
      code: 'AGENT_UNREACHABLE',
    })
  })

  if (req.method === 'GET' || req.method === 'HEAD') upstream.end()
  else req.pipe(upstream)
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const requestId = String(req.headers['x-request-id'] ?? '').slice(0, 64) || newRequestId()
  const started = process.hrtime.bigint()
  req.id = requestId
  req.log = accessLog.child({ requestId })
  res.setHeader('X-Request-Id', requestId)

  let url
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch (err) {
    // 非法 URL（例如畸形请求行）：直接 400，不必进业务分支
    req.log.warn('请求 URL 非法', { rawUrl: req.url, err })
    json(res, 400, { error: '请求地址不合法', code: 'INVALID_URL', requestId })
    return
  }

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    req.log.info('请求完成', {
      method: req.method,
      path: redactPath(url.pathname),
      status: res.statusCode,
      durationMs: Math.round(ms * 10) / 10,
      ip: clientIp(req),
    })
  })

  try {
    if (url.pathname.startsWith(AGENT_PREFIX + '/')) return proxyToAgent(req, res, url)
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return await handleStatic(req, res, url)
  } catch (err) {
    const { status, body, logLevel } = toHttpError(err, requestId)
    // 4xx 用 warn（预期内的用户错误，不打堆栈），5xx 用 error（带堆栈）
    if (logLevel === 'error') req.log.error('请求处理失败', { method: req.method, path: redactPath(url.pathname), err })
    else req.log.warn('请求被拒绝', { method: req.method, path: redactPath(url.pathname), code: body.code, message: err?.message })

    if (res.headersSent) {
      // 响应已开始写出：无法再改状态码，只能断开，避免客户端拿到半截数据
      req.log.error('响应已发送后出错，强制断开连接', { path: redactPath(url.pathname) })
      res.destroy(err)
      return
    }
    json(res, status, body)
  }
})

/* ---------------- WebSocket 升级鉴权 ---------------- */

server.on('upgrade', (req, socket, head) => {
  let url
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch (err) {
    wsLog.warn('WebSocket 升级请求 URL 非法', { rawUrl: req.url, err })
    socket.destroy()
    return
  }
  if (url.pathname !== '/ws') {
    wsLog.debug('非 /ws 的升级请求，已拒绝', { path: url.pathname })
    socket.destroy()
    return
  }
  const token = url.searchParams.get('token') ?? ''
  const r = checkShare(token)
  if (!r.ok) {
    wsLog.warn('WebSocket 鉴权失败，已拒绝升级', { reason: r.reason, ip: clientIp(req) })
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) =>
    wss.emit('connection', ws, { docId: r.doc.id, role: r.share.role, token }),
  )
})

/* ---------------- 进程级兜底 ---------------- */

const shutdownLog = createLogger('lifecycle')

process.on('unhandledRejection', (reason) => {
  shutdownLog.error('未处理的 Promise 拒绝（请修复，勿依赖此兜底）', { err: reason })
})

process.on('uncaughtException', (err) => {
  // 未捕获异常说明进程状态已不可信：记录后退出，交给进程管理器重启
  shutdownLog.error('未捕获异常，进程即将退出', { err })
  shutdown(1)
})

let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  shutdownLog.info('收到退出信号，开始优雅关闭', { code })
  const force = setTimeout(() => {
    shutdownLog.warn('优雅关闭超时，强制退出')
    process.exit(code || 1)
  }, 5000)
  force.unref()

  server.close(() => {
    shutdownLog.info('HTTP 服务已停止')
  })
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'server shutting down')
    } catch (err) {
      shutdownLog.debug('关闭 WebSocket 连接时出错', { err })
    }
  }
  wss.close()
  closeDb()
  // 给 WebSocket 与在途请求一点时间收尾，再退出
  setTimeout(() => {
    shutdownLog.info('进程退出', { code })
    process.exit(code)
  }, 300).unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdownLog.info('收到信号', { signal })
    shutdown(0)
  })
}

server.listen(PORT, () => {
  const log = createLogger('startup')
  log.info('LiteOffice 后端已启动', {
    port: PORT,
    db: DB_PATH,
    dist: DIST_DIR,
    distExists: existsSync(DIST_DIR),
    agentOrigin: AGENT_ORIGIN,
    node: process.version,
    pid: process.pid,
  })
  log.info('可用入口', { health: `http://localhost:${PORT}/`, share: '/d/<token>', ws: '/ws?token=...' })
})
