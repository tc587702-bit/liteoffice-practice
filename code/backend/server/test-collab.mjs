/**
 * 局域网多人编辑：真实双客户端同步测试
 *
 * 目的：验证现有协作后端能否让两个客户端互相看到对方的编辑。
 * 做法：用 yjs + ws 模拟两个真实浏览器客户端，各自持 Y.Doc，
 *      走 /ws 协议，A 改动后检查 B 是否收到。
 *
 * 只读被测服务之外的东西；会在服务里创建一份测试文档（可撤销）。
 */
import * as Y from 'yjs'
import WebSocket from 'ws'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000'
const WS_BASE = BASE.replace(/^http/, 'ws')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, body) {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json()
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status} ${JSON.stringify(data)}`)
  return data
}

/** 一个模拟客户端：持 Y.Doc，按服务端协议收发 */
function makeClient(name, token, doc) {
  const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`)
  const state = { name, ws, online: null, gotBinary: 0, gotSync: 0, open: false, errors: [] }

  ws.on('open', () => { state.open = true })
  ws.on('error', (e) => state.errors.push(String(e.message)))
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'presence') state.online = msg.online
      } catch { /* ignore */ }
      return
    }
    state.gotBinary++
    try {
      const dec = decoding.createDecoder(new Uint8Array(data))
      const messageType = decoding.readVarUint(dec)
      if (messageType !== 0) return
      const syncType = decoding.readVarUint(dec)
      if (syncType === 0) {
        // step1：服务端要我们的状态 → 回 step2
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, 0)
        encoding.writeVarUint(enc, 1)
        encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(doc))
        ws.send(encoding.toUint8Array(enc))
      } else if (syncType === 1 || syncType === 2) {
        const update = decoding.readVarUint8Array(dec)
        Y.applyUpdate(doc, update, 'remote')
        state.gotSync++
      }
    } catch (e) { state.errors.push('parse: ' + e.message) }
  })

  // 本地改动 → 发给服务端
  doc.on('update', (update, origin) => {
    if (origin === 'remote') return
    if (ws.readyState !== WebSocket.OPEN) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0)
    encoding.writeVarUint(enc, 2) // update
    encoding.writeVarUint8Array(enc, update)
    ws.send(encoding.toUint8Array(enc))
  })

  return state
}

let fails = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails++
}

async function main() {
  console.log('=== 0) 服务可达性 ===')
  const health = await fetch(BASE + '/').then((r) => r.status)
  check('HTTP 服务响应', health === 200 || health === 404, `status=${health}`)

  console.log('\n=== 1) 建测试文档 + 两个可编辑链接 ===')
  const created = await api('/api/docs', {
    title: '局域网协作测试',
    kind: 'docx',
    html: '<p>初始内容</p>',
  })
  check('文档已创建', !!created.id, created.id)
  const shareA = await api(`/api/docs/${created.id}/share`, { role: 'edit' })
  const shareB = await api(`/api/docs/${created.id}/share`, { role: 'edit' })
  check('两个 edit 链接已生成', shareA.role === 'edit' && shareB.role === 'edit')
  console.log(`     A: ${shareA.url}`)
  console.log(`     B: ${shareB.url}`)

  console.log('\n=== 2) 两个客户端连接 ===')
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const textA = docA.getText('body')
  const textB = docB.getText('body')
  const A = makeClient('A', shareA.token, docA)
  const B = makeClient('B', shareB.token, docB)
  await sleep(1200)
  check('A 已连接', A.open, A.errors.join(';'))
  check('B 已连接', B.open, B.errors.join(';'))
  check('在线人数广播为 2', A.online === 2 && B.online === 2, `A看到${A.online} B看到${B.online}`)

  console.log('\n=== 3) A 写入 → B 是否收到（核心） ===')
  textA.insert(0, 'A写的内容')
  await sleep(1500)
  const bText = textB.toString()
  check('B 收到 A 的改动', bText.includes('A写的内容'), `B当前="${bText}"`)
  console.log(`     A二进制帧=${A.gotBinary} 同步帧=${A.gotSync} | B二进制帧=${B.gotBinary} 同步帧=${B.gotSync}`)

  console.log('\n=== 4) B 写入 → A 是否收到（反向） ===')
  textB.insert(textB.length, 'B写的内容')
  await sleep(1500)
  const aText = textA.toString()
  check('A 收到 B 的改动', aText.includes('B写的内容'), `A当前="${aText}"`)

  console.log('\n=== 5) 并发编辑是否收敛 ===')
  textA.insert(0, '[甲]')
  textB.insert(textB.length, '[乙]')
  await sleep(1800)
  check('两端最终内容一致', textA.toString() === textB.toString(),
    `A="${textA.toString()}" B="${textB.toString()}"`)

  console.log('\n=== 6) 只读连接不能写入 ===')
  const shareV = await api(`/api/docs/${created.id}/share`, { role: 'view' })
  const docV = new Y.Doc()
  const V = makeClient('V', shareV.token, docV)
  await sleep(900)
  const before = textA.toString()
  docV.getText('body').insert(0, '越权写入')
  await sleep(1200)
  check('只读客户端的写入被丢弃', !textA.toString().includes('越权写入'),
    `A="${textA.toString()}"`)

  console.log('\n=== 7) 持久化：新连接能否拿到历史 ===')
  const docC = new Y.Doc()
  const C = makeClient('C', shareA.token, docC)
  await sleep(1500)
  check('新连接同步到已有内容', docC.getText('body').toString().length > 0,
    `C="${docC.getText('body').toString()}"`)

  for (const c of [A, B, V, C]) c.ws.close()
  await sleep(400)

  console.log(`\n结果：${fails === 0 ? '全部通过' : `失败 ${fails} 项`}`)
  console.log(`\n测试文档 id=${created.id}（保留以便浏览器复测，可用 /api/share/<token>/revoke 撤销）`)
  console.log(`浏览器打开：${BASE}${shareA.url}`)
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(2) })