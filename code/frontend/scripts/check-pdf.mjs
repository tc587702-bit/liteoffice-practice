#!/usr/bin/env node
/**
 * PDF 文本提取自检脚本（Node 侧，与应用同一套 pdfjs-dist 版本）。
 *
 *   node scripts/check-pdf.mjs chk.pdf margin_test.pdf re2.pdf re_tmp.pdf
 *
 * 输出每个文件的：页数 / 提取字符数 / 首行文本 / 耗时(ms) / 失败原因。
 * 仅用于验证 lib/pdf.ts 的提取能力，不参与构建。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法: node scripts/check-pdf.mjs <a.pdf> [b.pdf ...]')
  process.exit(1)
}

// Node 环境不需要 worker：pdf.js 会自动退回 fake worker

const rows = []
for (const file of files) {
  const started = Date.now()
  const row = { file: path.basename(file), pages: 0, chars: 0, first: '', ms: 0, code: '', message: '' }
  try {
    const data = new Uint8Array(fs.readFileSync(file))
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
    row.pages = doc.numPages
    const chunks = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      chunks.push(text)
      page.cleanup()
    }
    const text = chunks.join('\n\n').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    row.chars = text.replace(/\s/g, '').length
    row.first = (text.split('\n').find((line) => line.trim()) ?? '').slice(0, 60)
    if (!row.chars) {
      row.code = 'no-text-layer'
      row.message = '没有文字层（扫描件），暂不支持 OCR'
    }
    await doc.destroy()
  } catch (error) {
    const name = error?.name ?? ''
    const detail = String(error?.message ?? error)
    if (name === 'PasswordException' || /password/i.test(detail)) {
      row.code = 'encrypted'
      row.message = 'PDF 已加密，请先解除密码保护'
    } else if (name === 'InvalidPDFException' || /invalid pdf/i.test(detail)) {
      row.code = 'corrupt'
      row.message = 'PDF 结构异常，无法解析'
    } else {
      row.code = 'unknown'
      row.message = detail.slice(0, 120)
    }
  }
  row.ms = Date.now() - started
  rows.push(row)
}

for (const row of rows) {
  const status = row.code ? `FAIL(${row.code}) ${row.message}` : 'OK'
  console.log(
    `${row.file.padEnd(24)} pages=${String(row.pages).padStart(4)}  chars=${String(row.chars).padStart(7)}  ` +
      `ms=${String(row.ms).padStart(6)}  ${status}`,
  )
  if (row.first) console.log(`${' '.repeat(24)}first="${row.first}"`)
}
