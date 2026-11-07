/**
 * 单元自检：快照序号单调性（P0-1）与 HTML 消毒（P0-2）
 *
 *   node server/test-db-seq.mjs
 *
 * 用临时数据库，不影响 data/liteoffice.db。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LITEOFFICE_DB = join(mkdtempSync(join(tmpdir(), 'lo-seq-')), 'test.db')

const db = await import('./db.mjs')
const { sanitizeHtml } = await import('./sanitize.mjs')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

console.log('\n=== P0-1 快照序号单调 ===')
const docId = db.createDocument({ title: 't', kind: 'md', html: '<p>x</p>' })

const s1 = db.appendUpdate(docId, Buffer.from('u1'))
const s2 = db.appendUpdate(docId, Buffer.from('u2'))
const s3 = db.appendUpdate(docId, Buffer.from('u3'))
check('首次追加从 1 开始', s1 === 1 && s2 === 2 && s3 === 3, `${s1},${s2},${s3}`)

// 模拟「写快照 + 裁剪」
db.saveSnapshot(docId, db.latestSeq(docId), Buffer.from('snap'))
const pruned = db.pruneUpdates(docId, db.latestSeq(docId))
check('裁剪掉已覆盖的增量', pruned === 3, `删除 ${pruned} 条`)
check('增量表已清空', db.listUpdates(docId, 0).length === 0)

// 关键：裁剪后继续追加，seq 必须 > 快照的 at_seq
const s4 = db.appendUpdate(docId, Buffer.from('u4'))
const snap = db.latestSnapshot(docId)
check('新增量的 seq 大于快照 at_seq', s4 > snap.at_seq, `seq=${s4} at_seq=${snap.at_seq}`)
check('重启后能 replay 到它', db.listUpdates(docId, snap.at_seq).length === 1)

const snap2 = db.latestSnapshot(docId)
const replay = db.listUpdates(docId, 0)
check('最新快照仍是刚才那条', snap2.at_seq === snap.at_seq)

console.log('\n=== P0-2 HTML 消毒 ===')
const dirty = [
  '<p>正常段落</p>',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">点我</a>',
  '<img src="data:image/png;base64,iVBORw0KGgo=" alt="图">',
  '<div onclick="steal()">带事件</div>',
  '<iframe src="https://evil"></iframe>',
  '<style>body{display:none}</style>',
  '<p class="ok" data-x="1">保留 class</p>',
].join('')

const clean = sanitizeHtml(dirty)
check('移除 <script>', !/<script/i.test(clean))
check('移除 onerror', !/onerror/i.test(clean))
check('移除 javascript: 链接', !/javascript:/i.test(clean))
check('移除 onclick', !/onclick/i.test(clean))
check('移除 <iframe>', !/<iframe/i.test(clean))
check('移除 <style>', !/<style/i.test(clean))
check('保留正常段落', clean.includes('<p>正常段落</p>'))
check('保留 data:image 图片', /<img[^>]+src="data:image\/png;base64,/i.test(clean))
check('保留白名单属性 class', /class="ok"/.test(clean))
check('丢弃非白名单属性 data-x', !/data-x/.test(clean))
check('移除脚本协议但不破坏文本', sanitizeHtml('<a href="javascript:1">文字</a>').includes('文字'))

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
