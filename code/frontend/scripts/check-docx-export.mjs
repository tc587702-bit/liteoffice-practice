#!/usr/bin/env node
/**
 * docx 导出图片自检（与 check-pdf.mjs 同风格，不参与构建）
 *
 *   node scripts/check-docx-export.mjs <输入.docx>
 *
 * 六件事：
 *   1. parseDocx 读输入，统计图片数 N
 *   2. buildDocx 导出字节
 *   3. 解包，统计 word/media/ 下文件数 M
 *   4. 断言 M === N，并打印 输入图片数 / 导出图片数 / 导出字节大小 / 是否含 r:embed
 *   5. 再 parseDocx 读一遍导出结果，确认图片数仍为 N
 *   6. 任一项不满足 → 退出码 1
 *
 * 说明：parseDocx / buildDocx 依赖浏览器 DOM（DOMParser / innerHTML），
 * 因此本脚本用项目自带的 vite 起一个临时 dev server，把模块交给本机
 * headless Chromium 执行（无新增依赖，也不需要安装 Puppeteer）。
 * 解包与断言在 Node 侧用 zlib 独立完成，不依赖被测代码。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const input = process.argv[2]
const outIndex = process.argv.indexOf('--out')
const outPath = outIndex > 0 ? process.argv[outIndex + 1] : null
if (!input) {
  console.error('用法: node scripts/check-docx-export.mjs <输入.docx>')
  process.exit(2)
}
if (!fs.existsSync(input)) {
  console.error(`找不到文件: ${input}`)
  process.exit(2)
}

/* ---------------- 极简 ZIP 读取（仅用于本脚本断言） ---------------- */
function readZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）')
  const total = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const entries = new Map()
  for (let i = 0; i < total; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(start, start + compressedSize)
    const data = method === 0 ? raw : zlib.inflateRawSync(raw)
    entries.set(name, data)
  }
  return entries
}

/* ---------------- 本机 Chromium 探测 ---------------- */
function findBrowser() {
  const candidates = [
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
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find((file) => fs.existsSync(file)) ?? null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function launchDevServer() {
  const { createServer } = await import('vite')
  const server = await createServer({
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
  })
  await server.listen()
  const urls = server.resolvedUrls?.local ?? []
  return { server, url: urls[0] ?? `http://127.0.0.1:${server.config.server.port}/` }
}

async function launchBrowser(profile) {
  const executable = findBrowser()
  if (!executable) throw new Error('未找到 Chrome / Edge，可设置 CHROME_PATH 指向可执行文件')
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  fs.mkdirSync(profile, { recursive: true })
  const port = 9333
  const child = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--allow-ancients',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )
  child.unref()
  const waitForCdp = async (attempts) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return { port, browser: (await res.json()).Browser, child }
    } catch {
      /* 继续等待 */
    }
    if (attempts <= 0) throw new Error('浏览器 CDP 未就绪')
    await sleep(200)
    return waitForCdp(attempts - 1)
  }
  return waitForCdp(120)
}

async function runInBrowser(port, url, base64Docx) {
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
      }, 180000)
    })

  await send('Runtime.enable')
  await sleep(1200)

  const expression = String.raw`(async () => {
    const docx = await import('/src/lib/docx.ts')
    const bin = atob(${JSON.stringify(base64Docx)})
    const input = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) input[i] = bin.codePointAt(i) ?? 0
    const parsed = await docx.parseDocx(input.buffer)
    const report = { imagesEmbedded: 0, imagesSkipped: [], extensions: [] }
    const exported = docx.buildDocx(parsed.html, 'export-check', report)
    const reParsed = await docx.parseDocx(exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength))
    let out = ''
    const chunk = 0x8000
    for (let i = 0; i < exported.length; i += chunk) {
      out += String.fromCodePoint.apply(null, Array.from(exported.subarray(i, i + chunk)))
    }
    const countingHtml = parsed.html.match(/<img\b/gi)?.length ?? 0
    return {
      inputImages: parsed.images.length,
      htmlImages: countingHtml,
      exportedBase64: btoa(out),
      exportedSize: exported.length,
      reparseImages: reParsed.images.length,
      report,
      firstParagraph: parsed.firstParagraph,
      mathMl: parsed.plainText.length,
    }
  })()`

  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  ws.close()
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

/* ---------------- 主流程 ---------------- */
const startedAt = Date.now()
let dev
let browser
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-docx-check-'))
try {
  const fileBuffer = fs.readFileSync(input)
  console.log(`输入文件: ${input} (${fileBuffer.length.toLocaleString('en-US')} 字节)`)

  dev = await launchDevServer()
  browser = await launchBrowser(profile)
  const outcome = await runInBrowser(browser.port, dev.url, fileBuffer.toString('base64'))

  const exported = Buffer.from(outcome.exportedBase64, 'base64')
  if (outPath) {
    fs.writeFileSync(outPath, exported)
    console.log(`已保存导出结果: ${outPath}`)
  }
  const entries = readZip(exported)
  const mediaEntries = [...entries.keys()].filter((name) => /^word\/media\/[^/]+$/.test(name))
  const rels = entries.get('word/_rels/document.xml.rels')?.toString('utf8') ?? ''
  const documentXml = entries.get('word/document.xml')?.toString('utf8') ?? ''
  const contentTypes = entries.get('[Content_Types].xml')?.toString('utf8') ?? ''
  const imageRels = [...rels.matchAll(/Type="[^"]*\/image"[^>]*Target="([^"]+)"/g)].map((m) => m[1])
  const embeds = [...documentXml.matchAll(/r:embed="(rId\d+)"/g)].map((m) => m[1])
  const relIds = new Set([...rels.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]))
  const danglingEmbeds = embeds.filter((id) => !relIds.has(id))
  const missingTargets = imageRels.filter((target) => !entries.has(`word/media/${path.basename(target)}`))
  const hasPngContentType = /Extension="png"[^>]*ContentType="image\/png"/.test(contentTypes)

  const checks = [
    ['输入图片数', outcome.inputImages, outcome.inputImages],
    ['导出图片数（word/media/）', mediaEntries.length, outcome.inputImages],
    ['重新解析后图片数', outcome.reparseImages, outcome.inputImages],
    ['r:embed 数量', embeds.length, outcome.inputImages],
  ]

  console.log(`输入图片数 = ${outcome.inputImages}`)
  console.log(`导出图片数 = ${mediaEntries.length}`)
  console.log(`导出字节大小 = ${exported.length.toLocaleString('en-US')}`)
  console.log(`含 r:embed = ${embeds.length > 0}`)
  console.log(`重新解析后图片数 = ${outcome.reparseImages}`)
  console.log('--- 明细 ---')
  console.log(`HTML 中的 <img> 数量       = ${outcome.htmlImages}`)
  console.log(`导出媒体文件               = ${mediaEntries.join(', ') || '(无)'}`)
  console.log(`document.xml.rels 图片关系 = ${imageRels.length}`)
  console.log(`图片关系 Id 示例           = ${embeds.slice(0, 3).join(', ') || '(无)'}`)
  console.log(`[Content_Types] png 声明   = ${hasPngContentType}`)
  console.log(`悬空 r:embed               = ${danglingEmbeds.length}`)
  console.log(`关系目标缺失               = ${missingTargets.length}`)
  if (outcome.report?.imagesSkipped?.length) {
    for (const skipped of outcome.report.imagesSkipped) {
      console.log(`跳过图片: ${skipped.reason} (${skipped.src})`)
    }
  }
  console.log(`浏览器                     = ${browser.browser}`)
  console.log(`耗时                       = ${Date.now() - startedAt} ms`)

  const failures = []
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) failures.push(`${label}: 实际 ${actual}，期望 ${expected}`)
  }
  if (!embeds.length) failures.push('document.xml 中没有 r:embed')
  if (!hasPngContentType && mediaEntries.some((name) => name.endsWith('.png')))
    failures.push('[Content_Types].xml 缺少 png 声明')
  if (danglingEmbeds.length) failures.push(`存在悬空 r:embed: ${danglingEmbeds.join(', ')}`)
  if (missingTargets.length) failures.push(`关系目标在包内不存在: ${missingTargets.join(', ')}`)

  if (failures.length) {
    console.error('--- 失败 ---')
    for (const failure of failures) console.error(`✗ ${failure}`)
    process.exitCode = 1
  } else {
    console.log('--- 通过 ---')
    process.exitCode = 0
  }
} catch (error) {
  console.error(`检查失败: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  try {
    if (browser?.child?.pid) process.kill(browser.child.pid)
  } catch {
    /* 忽略 */
  }
  await dev?.server?.close?.()
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
