#!/usr/bin/env node
/**
 * 大文件「不截断」自检（不参与构建）
 *
 *   node scripts/check-large-file.mjs <big.md> <big.xlsx> <big.pdf> <big.docx>
 *
 * 四项断言：
 *   1) md   ：渲染块数 ≥ 120000，且含 END-OF-FILE-MARK-9F3A
 *   2) xlsx ：行数 = 50000，最后一行首列 = LAST-ROW-MARK-7C1B，无「截断」字样
 *   3) pdf  ：页数 = 500，文本含 LAST-PAGE-MARK-2D8E
 *   4) docx ：图片数 = 50，段落数 ≥ 2000，含 END-OF-DOCX-MARK-6B2C
 * 每项打印 耗时 / 峰值堆内存 / 通过与否；任一项失败 → 退出码 1。
 *
 * 运行环境说明：docx / xlsx 解析依赖浏览器 DOM（DOMParser），因此本脚本用项目自带的
 * vite 起临时 dev server，把模块交给本机 headless Chromium 执行（无新增依赖）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const [, , mdPath, xlsxPath, pdfPath, docxPath] = process.argv
if (!mdPath || !xlsxPath || !pdfPath || !docxPath) {
  console.error('用法: node scripts/check-large-file.mjs <big.md> <big.xlsx> <big.pdf> <big.docx>')
  process.exit(2)
}
for (const file of [mdPath, xlsxPath, pdfPath, docxPath]) {
  if (!fs.existsSync(file)) {
    console.error(`找不到文件: ${file}`)
    process.exit(2)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findBrowser() {
  return [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find((p) => fs.existsSync(p))
}

async function launchDevServer() {
  const { createServer } = await import('vite')
  const server = await createServer({
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
  })
  await server.listen()
  return { server, url: server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5173/' }
}

async function launchBrowser(profile) {
  const executable = findBrowser()
  if (!executable) throw new Error('未找到 Chrome / Edge，可设置 CHROME_PATH')
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  fs.mkdirSync(profile, { recursive: true })
  const port = 9341
  const child = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--js-flags=--expose-gc',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )
  child.unref()
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return { port, browser: (await res.json()).Browser, child }
    } catch {
      /* wait */
    }
    await sleep(200)
  }
  throw new Error('浏览器 CDP 未就绪')
}

async function openPage(port, url) {
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let seed = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seed
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`${method} timeout`))
        }
      }, 600000)
    })
  await send('Runtime.enable')
  await sleep(1200)
  return { send, close: () => ws.close() }
}

const started = Date.now()
let dev
let browser
let fixtureServer
const profile = path.join(process.env.TMPDIR || process.cwd(), 'lo-large-check-profile')
const results = []

/**
 * 本脚本通过 http://127.0.0.1:8103/large-*.ext 取测试文件，
 * 但原版没有启动这个服务，导致必然 404。这里补上。
 */
async function launchFixtureServer(map) {
  const httpMod = await import('node:http')
  const server = httpMod.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0].replace(/^\//, ''))
    const file = map[name]
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found: ' + name)
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': fs.statSync(file).size,
      'cache-control': 'no-store',
      // 页面跑在 vite dev server 的源上，跨端口取文件必须放行 CORS
      'access-control-allow-origin': '*',
    })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(8103, '127.0.0.1', resolve)
  })
  return server
}

try {
  fixtureServer = await launchFixtureServer({
    'large-8mb.md': mdPath,
    'large-50k.xlsx': xlsxPath,
    'large-500p.pdf': pdfPath,
    'large-20mb.docx': docxPath,
  })
  dev = await launchDevServer()
  browser = await launchBrowser(profile)
  const page = await openPage(browser.port, dev.url)

  const runItem = async (item, expression) => {
    try {
      return await evaluate(expression)
    } catch (error) {
      return { item, pass: false, error: error?.message ?? String(error), ms: 0, peakMB: 0 }
    }
  }

  const evaluate = async (expression) => {
    const out = await page.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text)
    return out.result.value
  }

  const base = JSON.stringify(dev.url)

  /* ---------- 1) md ---------- */
  results.push(
    await runItem('md', `(async () => {
      const t0 = performance.now()
      const res = await fetch('http://127.0.0.1:8103/large-8mb.md')
      const buf = await res.arrayBuffer()
      const text = new TextDecoder('utf-8').decode(buf)
      const mod = await import('/src/lib/markdown.ts')
      const html = mod.renderMarkdown(text)
      const dom = new DOMParser().parseFromString('<div id="root">' + html + '</div>', 'text/html')
      const blocks = dom.getElementById('root').children.length
      const hasMark = html.includes('END-OF-FILE-MARK-9F3A')
      const mem = performance.memory ? performance.memory.usedJSHeapSize : 0
      return { item: 'md', bytes: buf.byteLength, blocks, hasMark, ms: Math.round(performance.now() - t0), peakMB: Math.round((mem / 1048576) * 10) / 10,
        pass: blocks >= 120000 && hasMark }
    })()`),
  )

  /* ---------- 2) xlsx ---------- */
  results.push(
    await runItem('xlsx', `(async () => {
      const t0 = performance.now()
      const buf = await (await fetch('http://127.0.0.1:8103/large-50k.xlsx')).arrayBuffer()
      const mod = await import('/src/lib/xlsx.ts')
      const parsed = await mod.parseXlsxWithSheetJS(buf)
      const sheet = parsed.sheets[0]
      const lastRow = sheet.rows[sheet.rows.length - 1]
      const lastCell = lastRow ? lastRow[0] : ''
      const warningText = [].concat(parsed.warnings || []).join(' ')
      const mem = performance.memory ? performance.memory.usedJSHeapSize : 0
      return { item: 'xlsx', bytes: buf.byteLength, rows: sheet.rows.length, lastCell, warnings: warningText,
        ms: Math.round(performance.now() - t0), peakMB: Math.round((mem / 1048576) * 10) / 10,
        pass: sheet.rows.length === 50000 && lastCell === 'LAST-ROW-MARK-7C1B' && !warningText.includes('截断') }
    })()`),
  )

  /* ---------- 3) pdf ---------- */
  results.push(
    await runItem('pdf', `(async () => {
      const t0 = performance.now()
      const buf = await (await fetch('http://127.0.0.1:8103/large-500p.pdf')).arrayBuffer()
      const mod = await import('/src/lib/pdf.ts')
      const res = await mod.extractPdfText(buf)
      const mem = performance.memory ? performance.memory.usedJSHeapSize : 0
      return { item: 'pdf', bytes: buf.byteLength, pages: res.pageCount, hasMark: (res.text || '').includes('LAST-PAGE-MARK-2D8E'),
        chars: res.charCount, ms: Math.round(performance.now() - t0), peakMB: Math.round((mem / 1048576) * 10) / 10,
        pass: res.pageCount === 500 && (res.text || '').includes('LAST-PAGE-MARK-2D8E') }
    })()`),
  )

  /* ---------- 4) docx ---------- */
  results.push(
    await runItem('docx', `(async () => {
      const t0 = performance.now()
      const buf = await (await fetch('http://127.0.0.1:8103/large-20mb.docx')).arrayBuffer()
      const mod = await import('/src/lib/docx.ts')
      const parsed = await mod.parseDocx(buf)
      const mem = performance.memory ? performance.memory.usedJSHeapSize : 0
      return { item: 'docx', bytes: buf.byteLength, images: parsed.images.length, paragraphs: parsed.paragraphCount,
        hasMark: parsed.html.includes('END-OF-DOCX-MARK-6B2C'), ms: Math.round(performance.now() - t0),
        peakMB: Math.round((mem / 1048576) * 10) / 10,
        pass: parsed.images.length === 50 && parsed.paragraphCount >= 2000 && parsed.html.includes('END-OF-DOCX-MARK-6B2C') }
    })()`),
  )

  page.close()
} catch (error) {
  console.error(`检查失败: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  try {
    if (browser?.child?.pid) process.kill(browser.child.pid)
  } catch {
    /* ignore */
  }
  try { fixtureServer?.close?.() } catch { /* ignore */ }
  await dev?.server?.close?.()
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

if (results.length) {
  console.log(`运行环境: ${browser?.browser ?? 'unknown'}（无截断自检）`)
  console.log('')
  const label = { md: 'md   8 MB / 12 万段', xlsx: 'xlsx 5 万行 × 20 列', pdf: 'pdf  500 页', docx: 'docx 20 MB / 50 图' }
  for (const row of results) {
    const detail = row.error ? `ERROR: ${row.error}` :
      row.item === 'md'
        ? `blocks=${row.blocks} mark=${row.hasMark}`
        : row.item === 'xlsx'
          ? `rows=${row.rows} last="${row.lastCell}"`
          : row.item === 'pdf'
            ? `pages=${row.pages} chars=${row.chars} mark=${row.hasMark}`
            : `images=${row.images} paragraphs=${row.paragraphs} mark=${row.hasMark}`
    console.log(
      `${label[row.item].padEnd(22)} 耗时=${String(row.ms).padStart(6)}ms  峰值堆≈${String(row.peakMB).padStart(7)}MB  ${detail}  ${row.pass ? 'PASS' : 'FAIL'}`,
    )
  }
  const failed = results.filter((row) => !row.pass)
  console.log('')
  console.log(`总耗时 ${Date.now() - started}ms`)
  if (failed.length) {
    console.error(`✗ ${failed.length} 项未通过: ${failed.map((row) => row.item).join(', ')}`)
    process.exitCode = 1
  } else {
    console.log('✓ 全部通过：内容均未被截断，末尾标记可见')
    process.exitCode = 0
  }
} else if (!process.exitCode) {
  process.exitCode = 1
}
