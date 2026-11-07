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
import os from 'node:os'
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

/* ---------------- 运行地址（端口不写死，可用环境变量覆盖） ---------------- */
/** 测试服务绑定的主机地址，默认仅本机 */
const HOST = process.env.LITEOFFICE_TEST_HOST ?? '127.0.0.1'
/** CDP 调试端口：0 表示由浏览器自动分配（从 DevToolsActivePort 读取真实端口） */
const CDP_PORT = Number(process.env.CDP_PORT ?? 0) || 0

/** 从 vite 实际监听地址取端口，避免 port: 0 时拼出 :0 */
function resolveServerPort(server) {
  const address = server.httpServer?.address?.()
  if (address && typeof address === 'object' && address.port) return address.port
  const configured = Number(server.config?.server?.port)
  return Number.isFinite(configured) && configured > 0 ? configured : null
}

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
    server: { port: 0, strictPort: false, host: HOST },
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
  })
  await server.listen()
  const urls = server.resolvedUrls?.local ?? []
  const port = resolveServerPort(server)
  return { server, url: urls[0] ?? `http://${HOST}:${port ?? '<port>'}/` }
}

async function launchBrowser(profile) {
  const executable = findBrowser()
  if (!executable) throw new Error('未找到 Chrome / Edge，可设置 CHROME_PATH')
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  fs.mkdirSync(profile, { recursive: true })
  const port = CDP_PORT
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
  // port 为 0 时浏览器会自动选端口，并把真实端口写进 profile/DevToolsActivePort
  const readCdpPort = () => {
    if (port > 0) return port
    try {
      const [firstLine] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')
      const actual = Number(firstLine)
      return Number.isFinite(actual) && actual > 0 ? actual : 0
    } catch {
      return 0
    }
  }
  const waitForCdp = async (attempts) => {
    const actualPort = readCdpPort()
    if (actualPort) {
      try {
        const res = await fetch(`http://${HOST}:${actualPort}/json/version`)
        if (res.ok) return { port: actualPort, browser: (await res.json()).Browser, child }
      } catch {
        /* wait */
      }
    }
    if (attempts <= 0) throw new Error('浏览器 CDP 未就绪')
    await sleep(200)
    return waitForCdp(attempts - 1)
  }
  return waitForCdp(150)
}

async function openPage(port, url) {
  const target = await (
    await fetch(`http://${HOST}:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-large-check-'))
const results = []

/**
 * 本脚本通过自动分配的本地端口提供 large-*.ext 测试文件，
 * 页面从 dev server 所在源跨端口取文件，因此这里放行 CORS。
 * 端口由系统分配（listen(0)），也可用 FIXTURE_ORIGIN 直接指定外部地址。
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
    server.listen(0, HOST, resolve)
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  return { server, origin: `http://${HOST}:${port}` }
}

try {
  const fixture = await launchFixtureServer({
    'large-8mb.md': mdPath,
    'large-50k.xlsx': xlsxPath,
    'large-500p.pdf': pdfPath,
    'large-20mb.docx': docxPath,
  })
  fixtureServer = fixture.server
  const fixtureOrigin = process.env.FIXTURE_ORIGIN ?? fixture.origin
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

  /* ---------- 1) md ---------- */
  const mdResult = await runItem('md', `(async () => {
      const t0 = performance.now()
      const res = await fetch('${fixtureOrigin}/large-8mb.md')
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
    })()`)
  results.push(mdResult)

  /* ---------- 2) xlsx ---------- */
  const xlsxResult = await runItem('xlsx', `(async () => {
      const t0 = performance.now()
      const buf = await (await fetch('${fixtureOrigin}/large-50k.xlsx')).arrayBuffer()
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
    })()`)
  results.push(xlsxResult)

  /* ---------- 3) pdf ---------- */
  const pdfResult = await runItem('pdf', `(async () => {
      const t0 = performance.now()
      const buf = await (await fetch('${fixtureOrigin}/large-500p.pdf')).arrayBuffer()
      const mod = await import('/src/lib/pdf.ts')
      const res = await mod.extractPdfText(buf)
      const mem = performance.memory ? performance.memory.usedJSHeapSize : 0
      return { item: 'pdf', bytes: buf.byteLength, pages: res.pageCount, hasMark: (res.text || '').includes('LAST-PAGE-MARK-2D8E'),
        chars: res.charCount, ms: Math.round(performance.now() - t0), peakMB: Math.round((mem / 1048576) * 10) / 10,
        pass: res.pageCount === 500 && (res.text || '').includes('LAST-PAGE-MARK-2D8E') }
    })()`)
  results.push(pdfResult)

  /* ---------- 4) docx ---------- */
  const docxResult = await runItem('docx', `(async () => {
      const t0 = performance.now()
      const buf = await (await fetch('${fixtureOrigin}/large-20mb.docx')).arrayBuffer()
      const mod = await import('/src/lib/docx.ts')
      const parsed = await mod.parseDocx(buf)
      const mem = performance.memory ? performance.memory.usedJSHeapSize : 0
      return { item: 'docx', bytes: buf.byteLength, images: parsed.images.length, paragraphs: parsed.paragraphCount,
        hasMark: parsed.html.includes('END-OF-DOCX-MARK-6B2C'), ms: Math.round(performance.now() - t0),
        peakMB: Math.round((mem / 1048576) * 10) / 10,
        pass: parsed.images.length === 50 && parsed.paragraphCount >= 2000 && parsed.html.includes('END-OF-DOCX-MARK-6B2C') }
    })()`)
  results.push(docxResult)

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
  const detailOf = (row) => {
    if (row.error) return `ERROR: ${row.error}`
    if (row.item === 'md') return `blocks=${row.blocks} mark=${row.hasMark}`
    if (row.item === 'xlsx') return `rows=${row.rows} last="${row.lastCell}"`
    if (row.item === 'pdf') return `pages=${row.pages} chars=${row.chars} mark=${row.hasMark}`
    return `images=${row.images} paragraphs=${row.paragraphs} mark=${row.hasMark}`
  }
  for (const row of results) {
    const detail = detailOf(row)
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
