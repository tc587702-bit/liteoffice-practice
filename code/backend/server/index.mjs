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
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { dirname } from 'node:path'
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
  DB_PATH,
} from './db.mjs'
import { makeShare, checkShare, revoke, sharesOf, reasonText, noteFailure, isBlocked } from './share.mjs'
import { sanitizeHtml } from './sanitize.mjs'

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
    if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE')
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
  } catch {
    throw new Error('BAD_JSON')
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
  } catch {
    return false
  }
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.socket.remoteAddress ?? '').trim()

/* ---------------- 路由 ---------------- */

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'docs', id?, ...]
  const method = req.method ?? 'GET'

  // POST /api/docs
  if (parts[0] === 'api' && parts[1] === 'docs' && parts.length === 2 && method === 'POST') {
    const body = await readJson(req)
    const title = String(body.title ?? '未命名文档').slice(0, 200)
    const kind = String(body.kind ?? 'docx')
    const html = sanitizeHtml(String(body.html ?? '')) // 防存储型 XSS
    const content = body.contentBase64 ? Buffer.from(body.contentBase64, 'base64') : null
    const id = createDocument({ title, kind, html, content })
    return json(res, 201, { id, title, kind, size: content?.length ?? 0 })
  }

  // GET /api/docs
  if (parts[0] === 'api' && parts[1] === 'docs' && parts.length === 2 && method === 'GET') {
    return json(res, 200, { docs: listDocuments() })
  }

  // /api/docs/:id
  if (parts[0] === 'api' && parts[1] === 'docs' && parts[2]) {
    const doc = getDocument(parts[2])
    if (!doc && parts.length === 3) return json(res, 404, { error: '文档不存在' })

    // GET /api/docs/:id/shares
    if (parts[3] === 'shares' && method === 'GET') {
      return json(res, 200, { shares: sharesOf(doc.id) })
    }

    // POST /api/docs/:id/share
    if (parts[3] === 'share' && method === 'POST') {
      const body = await readJson(req)
      const role = body.role === 'edit' ? 'edit' : 'view'
      const expiresInHours = Number(body.expiresInHours ?? 0)
      const s = makeShare({ docId: doc.id, role, expiresInHours })
      const origin = `http://${req.headers.host ?? `localhost:${PORT}`}`
      return json(res, 201, { ...s, url: origin + s.url })
    }

    // POST /api/docs/:id/save  覆盖保存（协作场景下用于落 HTML）
    if (parts[3] === 'save' && method === 'POST') {
      const body = await readJson(req)
      updateDocumentHtml(doc.id, sanitizeHtml(String(body.html ?? '')))
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
    if (isBlocked(ip)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' })
    const r = checkShare(parts[2])
    if (!r.ok) {
      noteFailure(ip)
      return json(res, 410, { error: reasonText(r.reason), reason: r.reason })
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
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '链接不存在' })
  }

  return json(res, 404, { error: '接口不存在' })
}

/* ---------------- 静态文件 ---------------- */

async function handleStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname)

  // /d/:token → 只读分享页
  if (pathname.startsWith('/d/')) {
    if (await serveFile(res, join(PUBLIC_DIR, 'd.html'))) return
    return json(res, 500, { error: '分享页缺失' })
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
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

/* ---------------- WebSocket：在线状态 + Yjs ---------------- */

/** docId -> { doc: Y.Doc, conns: Set<ws>, awareness } */
const rooms = new Map()

function getRoom(docId) {
  let room = rooms.get(docId)
  if (room) return room

  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)

  // 从库中恢复：先快照，再重放增量
  const snap = latestSnapshot(docId)
  if (snap?.state_blob) {
    try {
      Y.applyUpdate(doc, new Uint8Array(snap.state_blob), 'db')
    } catch {
      /* 快照损坏则忽略，靠增量重建 */
    }
  }
  for (const row of listUpdates(docId, snap?.at_seq ?? 0)) {
    try {
      Y.applyUpdate(doc, new Uint8Array(row.update_blob), 'db')
    } catch {
      /* 跳过损坏增量 */
    }
  }

  room = { doc, conns: new Set(), awareness, dirty: 0 }

  // 本地产生的更新 → 落库 + 广播
  doc.on('update', (update, origin) => {
    if (origin === 'db') return
    appendUpdate(docId, Buffer.from(update))
    room.dirty += 1
    if (room.dirty >= 200) {
      room.dirty = 0
      try {
        const atSeq = latestSeq(docId)
        saveSnapshot(docId, atSeq, Buffer.from(Y.encodeStateAsUpdate(doc)))
        pruneUpdates(docId, atSeq)
      } catch {
        /* 快照失败不影响同步 */
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
  ws.docId = docId
  ws.role = role
  ws.token = token
  room.conns.add(ws)
  if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null }

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
        if (role !== 'edit') return // 只读连接静默忽略，防止越权改写
        const update = decoding.readVarUint8Array(decoder)
        Y.applyUpdate(room.doc, update, ws)
      }
    } catch {
      /* 忽略畸形帧 */
    }
  })

  ws.on('close', () => {
    room.conns.delete(ws)
    const p = JSON.stringify({ type: 'presence', online: room.conns.size })
    for (const c of room.conns) if (c.readyState === c.OPEN) c.send(p)

    if (room.conns.size === 0) {
      // 落快照并裁掉已覆盖的增量
      try {
        const atSeq = latestSeq(docId)
        saveSnapshot(docId, atSeq, Buffer.from(Y.encodeStateAsUpdate(room.doc)))
        pruneUpdates(docId, atSeq)
      } catch {
        /* 快照失败不影响同步 */
      }
      // 空闲 30 秒后回收房间，避免长跑内存泄漏（留出重连窗口）
      clearTimeout(room.cleanupTimer)
      room.cleanupTimer = setTimeout(() => {
        if (room.conns.size === 0) rooms.delete(docId)
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

  const headers = { ...req.headers, host: target.host }
  delete headers['content-length']

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
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )

  upstream.on('timeout', () => {
    upstream.destroy()
    json(res, 504, { error: 'Agent 服务响应超时' })
  })
  upstream.on('error', (err) => {
    console.error('[proxy] agent 不可达:', err.message)
    json(res, 503, { error: 'Agent 服务未启动（python -m uvicorn app.main:app --port 8100）' })
  })

  if (req.method === 'GET' || req.method === 'HEAD') upstream.end()
  else req.pipe(upstream)
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (url.pathname.startsWith(AGENT_PREFIX + '/')) return proxyToAgent(req, res, url)
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return await handleStatic(req, res, url)
  } catch (err) {
    const msg = err?.message === 'BODY_TOO_LARGE' ? '请求体过大（上限 30 MB）' : '服务器内部错误'
    if (err?.message !== 'BODY_TOO_LARGE') console.error('[error]', err)
    json(res, 500, { error: msg })
  }
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  const token = url.searchParams.get('token') ?? ''
  const r = checkShare(token)
  if (!r.ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) =>
    wss.emit('connection', ws, { docId: r.doc.id, role: r.share.role, token }),
  )
})

server.listen(PORT, () => {
  console.log(`LiteOffice backend  http://localhost:${PORT}`)
  console.log(`  DB      ${DB_PATH}`)
  console.log(`  前端产物 ${DIST_DIR}${require_exists_hint()}`)
  console.log(`  分享页   /d/<token>`)
})

function require_exists_hint() {
  return ''
}
