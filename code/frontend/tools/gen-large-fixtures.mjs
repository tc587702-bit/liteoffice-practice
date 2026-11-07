/**
 * 生成大文件测试素材（供 scripts/check-large-file.mjs 使用）
 *
 *   node tools/gen-large-fixtures.mjs <输出目录>
 *
 * 产出（文件名必须与检查脚本里的固定 URL 一致）：
 *   large-8mb.md       ≥ 120000 个段落，末尾带 END-OF-FILE-MARK-9F3A
 *   large-50k.xlsx     50000 行，最后一行首列 LAST-ROW-MARK-7C1B
 *   large-500p.pdf     500 页，末页含 LAST-PAGE-MARK-2D8E
 *   large-20mb.docx    50 张图片 + 2000 段，末尾含 END-OF-DOCX-MARK-6B2C
 *
 * pdf / docx 两项调用同目录下的 gen_large_pdf_docx.py（需要 reportlab 与 python-docx）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const outDir = path.resolve(process.argv[2] ?? 'C:/deepseekharness/_fixtures')
fs.mkdirSync(outDir, { recursive: true })
const log = (...a) => console.log(...a)

/* ---------- 1) 8 MB markdown：12 万段 ---------- */
{
  const target = path.join(outDir, 'large-8mb.md')
  // 断言要求渲染后块数 ≥ 120000，所以段落数固定 12 万；长度让总体积约 8 MB
  const COUNT = 120000
  const parts = new Array(COUNT)
  for (let i = 1; i <= COUNT; i++) {
    parts[i - 1] = `第 ${i} 段：这是用于测试的正文内容，共二十个汉字左右。`
  }
  parts.push('END-OF-FILE-MARK-9F3A')
  fs.writeFileSync(target, parts.join('\n\n'), 'utf8')
  log(`md    ${(fs.statSync(target).size / 1048576).toFixed(2)} MB  段落 ${COUNT} + 1 标记`)
}

/* ---------- 2) 50000 行 xlsx ---------- */
{
  const require = createRequire(import.meta.url)
  const XLSX = require('xlsx')

  const rows = 50000
  const cols = 20
  const aoa = new Array(rows)
  aoa[0] = ['编号', ...Array.from({ length: cols - 1 }, (_, i) => `列${i + 2}`)]
  for (let r = 1; r < rows - 1; r++) {
    const row = new Array(cols)
    row[0] = `R${r}`
    // 其余列留空，只为验证行数不被截断
    aoa[r] = row
  }
  const last = new Array(cols)
  last[0] = 'LAST-ROW-MARK-7C1B'
  aoa[rows - 1] = last

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.book_append_sheet(wb, ws, '大数据集')
  const target = path.join(outDir, 'large-50k.xlsx')
  XLSX.writeFile(wb, target, { compression: true })
  log(`xlsx  ${(fs.statSync(target).size / 1048576).toFixed(2)} MB  行数 ${rows} × ${cols} 列`)
}

/* ---------- 3) + 4) pdf 与 docx 交给 Python ---------- */
{
  const py = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'gen_large_pdf_docx.py')
  log('\n调用 Python 生成 pdf / docx …')
  const out = execFileSync('python', [py, outDir], { encoding: 'utf8' })
  process.stdout.write(out)
}

/* ---------- 汇总 ---------- */
log('\n=== 产出清单 ===')
for (const name of ['large-8mb.md', 'large-50k.xlsx', 'large-500p.pdf', 'large-20mb.docx']) {
  const p = path.join(outDir, name)
  if (fs.existsSync(p)) log(`  ${name.padEnd(20)} ${(fs.statSync(p).size / 1048576).toFixed(2)} MB`)
  else log(`  ${name.padEnd(20)} 缺失`)
}
