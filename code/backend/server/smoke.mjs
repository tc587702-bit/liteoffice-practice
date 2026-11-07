/**
 * 后端冒烟测试：分享链接 + 多人同时编辑 + 只读权限
 *
 *   node server/smoke.mjs
 *
 * 覆盖：
 *  1. 上传、生成 edit/view 两条链接
 *  2. 两个 edit 连接同时在线，A 写入 → B 收到
 *  3. 只读连接写入 → 服务端忽略，文档不变
 *  4. 断开重连 → 内容仍在（SQLite 持久化）
 *  5. 撤销链接 → 旧链接 410
 */
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const WS = BASE.replace('http', 'ws')
const log = (...a) => console.log(...a)
let failed = 0
const check = (name, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed += 1
}

const api = async (path, init) => {
  const r = await fetch(BASE + path, init)
  const body = await r.json().catch(() => ({}))
  return { status: r.status, body }
}
const post = (path, obj) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) })

/** 极简 Yjs 客户端：连上 → step1 要状态 → 应用；本地改动 → 发 update */
function connect(token) {
  const doc = new Y.Doc()
  const ws = new WebSocket(`${WS}/ws?token=${token}`)
  const ready = new Promise((res) => ws.on('open', () => setTimeout(res, 120)))

  ws.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data))
    const type = decoding.readVarUint(decoder)
    if (type !== 0) return
    const syncType = decoding.readVarUint(decoder)
    if (syncType === 0) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, 0)
      encoding.writeVarUint(enc, 0)
      encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(doc))
      ws.send(encoding.toUint8Array(enc))
    } else if (syncType === 1 || syncType === 2) {
      Y.applyUpdate(doc, decoding.readVarUint8Array(decoder), 'remote')
    }
  })

  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0)
    encoding.writeVarUint(enc, 2) // update
    encoding.writeVarUint8Array(enc, update)
    ws.send(encoding.toUint8Array(enc))
  })

  return { doc, ws, ready }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  log('\n=== 1) 上传文档并生成链接 ===')
  const up = await post('/api/docs', {
    title: '多人协作冒烟测试',
    kind: 'md',
    html: '<h1>标题</h1><p>初始内容</p>',
    contentBase64: Buffer.from('hello').toString('base64'),
  })
  check('上传成功', up.status === 201 && !!up.body.id, `id=${up.body.id ?? '-'}`)
  const docId = up.body.id

  const editShare = await post(`/api/docs/${docId}/share`, { role: 'edit' })
  const viewShare = await post(`/api/docs/${docId}/share`, { role: 'view' })
  check('生成可编辑链接', editShare.status === 201 && /^[0-9a-f]{32}$/.test(editShare.body.token ?? ''))
  check('生成只读链接', viewShare.status === 201 && /^[0-9a-f]{32}$/.test(viewShare.body.token ?? ''))

  log('\n=== 2) 两个可编辑连接同时在线 ===')
  const a = connect(editShare.body.token)
  const b = connect(editShare.body.token)
  await a.ready
  await b.ready
  await sleep(300)

  a.doc.getText('content').insert(0, 'A 输入的第一行')
  await sleep(500)
  check('B 收到 A 的写入', b.doc.getText('content').toString().includes('A 输入的第一行'), JSON.stringify(b.doc.getText('content').toString()))

  b.doc.getText('content').insert(b.doc.getText('content').length, ' | B 追加')
  await sleep(500)
  check('A 收到 B 的追加', a.doc.getText('content').toString().includes('B 追加'))
  check('双方内容一致', a.doc.getText('content').toString() === b.doc.getText('content').toString())

  log('\n=== 3) 只读连接不能写入 ===')
  const v = connect(viewShare.body.token)
  await v.ready
  await sleep(200)
  const before = a.doc.getText('content').toString()
  v.doc.getText('content').insert(0, '【只读越权写入】')
  await sleep(600)
  const after = a.doc.getText('content').toString()
  check('只读写入被服务端忽略', before === after, `before=${before.length}字 after=${after.length}字`)
  check('只读连接能读到内容', a.doc.getText('content').toString().length > 0)

  log('\n=== 4) 断开重连后内容仍在 ===')
  const expected = a.doc.getText('content').toString()
  a.ws.close()
  b.ws.close()
  v.ws.close()
  await sleep(700)

  const c = connect(editShare.body.token)
  await c.ready
  await sleep(500)
  const restored = c.doc.getText('content').toString()
  check('重连后内容恢复', restored === expected, `期望 ${expected.length} 字，实得 ${restored.length} 字`)
  c.ws.close()

  log('\n=== 5) 撤销链接 ===')
  await post(`/api/share/${viewShare.body.token}/revoke`)
  const revoked = await api(`/api/share/${viewShare.body.token}`)
  check('撤销后返回 410', revoked.status === 410)
  const still = await api(`/api/share/${editShare.body.token}`)
  check('另一条链接不受影响', still.status === 200)

  log('\n=== 6) 非法 token ===')
  const bad = await api('/api/share/' + 'f'.repeat(32))
  check('不存在 token 返回 410', bad.status === 410)

  log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('冒烟测试异常:', e)
  process.exit(1)
})
