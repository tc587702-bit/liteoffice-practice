/** 核实「新连接拿不到历史」的根因：服务端首帧发的是 step1 还是 step2。只读探测。 */
import * as Y from 'yjs'
import WebSocket from 'ws'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const BASE = 'http://127.0.0.1:3000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, body) {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return r.json()
}

const created = await api('/api/docs', { title: '首帧探测', kind: 'docx', html: '<p>x</p>' })
const share = await api(`/api/docs/${created.id}/share`, { role: 'edit' })

// 第一个客户端写入内容
const d1 = new Y.Doc()
const ws1 = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${share.token}`)
ws1.on('message', (data, isBinary) => {
  if (!isBinary) return
  const dec = decoding.createDecoder(new Uint8Array(data))
  if (decoding.readVarUint(dec) !== 0) return
  const st = decoding.readVarUint(dec)
  if (st === 0) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0); encoding.writeVarUint(enc, 1)
    encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(d1))
    ws1.send(encoding.toUint8Array(enc))
  } else if (st === 1 || st === 2) {
    Y.applyUpdate(d1, decoding.readVarUint8Array(dec), 'remote')
  }
})
d1.on('update', (u, o) => {
  if (o === 'remote' || ws1.readyState !== WebSocket.OPEN) return
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0); encoding.writeVarUint(enc, 2)
  encoding.writeVarUint8Array(enc, u)
  ws1.send(encoding.toUint8Array(enc))
})
await sleep(900)
d1.getText('body').insert(0, '历史内容ABC')
await sleep(1200)
console.log('客户端1 内容:', JSON.stringify(d1.getText('body').toString()))

// 第二个客户端：只被动记录首帧类型，不主动回 step2
const d2 = new Y.Doc()
const ws2 = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${share.token}`)
const frames = []
ws2.on('message', (data, isBinary) => {
  if (!isBinary) { frames.push('text:' + data.toString().slice(0, 40)); return }
  const dec = decoding.createDecoder(new Uint8Array(data))
  const mt = decoding.readVarUint(dec)
  const st = mt === 0 ? decoding.readVarUint(dec) : -1
  frames.push(`binary mt=${mt} syncType=${st}`)
  if (mt === 0 && (st === 1 || st === 2)) {
    Y.applyUpdate(d2, decoding.readVarUint8Array(dec), 'remote')
  }
})
await sleep(1500)
console.log('客户端2 收到的帧:', frames)
console.log('客户端2 内容:', JSON.stringify(d2.getText('body').toString()))
console.log()
console.log('判读：syncType=0 是 step1（服务端向我要状态），=1 是 step2（服务端给我状态）')
console.log('若首帧只有 syncType=0，新客户端不回包就永远拿不到历史 → 这就是根因')

// 再验证：客户端2 主动发 step1 索要，能否拿到
const enc = encoding.createEncoder()
encoding.writeVarUint(enc, 0); encoding.writeVarUint(enc, 0)
ws2.send(encoding.toUint8Array(enc))
await sleep(1200)
console.log()
console.log('客户端2 主动索要后内容:', JSON.stringify(d2.getText('body').toString()))
console.log('→ 若能拿到，说明服务端逻辑本身没坏，只是首帧方向反了')

ws1.close(); ws2.close()
await sleep(300)
process.exit(0)