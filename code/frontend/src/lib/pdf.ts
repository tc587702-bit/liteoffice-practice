/**
 * PDF 解析（pdfjs-dist）
 *
 * 设计要点：
 * 1. 彻底放弃自研解析器：真实 PDF 的交叉引用流、对象流、CID 字体它处理不了。
 * 2. worker 由 Vite 本地打包（同源资源），绝不指向 CDN 或任何远程地址。
 * 3. 先做文本提取（getTextContent），再按页把 PDFDocumentProxy 交给 <PdfPages> 渲染 canvas。
 * 4. 失败必须分类并给出人话提示；禁止静默返回空字符串。
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/**
 * pdf.js 只在真正打开 PDF 时才加载（动态 import），不进入首屏主包。
 * worker 由 Vite 本地打包成同源资源；这里只给本地 URL，绝不指向 CDN。
 */
let pdfjsLoader: Promise<typeof import('pdfjs-dist')> | null = null

function getPdfjs() {
  if (!pdfjsLoader) {
    pdfjsLoader = import('pdfjs-dist').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString()
      return mod
    })
  }
  return pdfjsLoader
}

export type PdfFailureCode = 'encrypted' | 'no-text-layer' | 'corrupt' | 'worker' | 'unknown'

export interface PdfPageInfo {
  index: number
  chars: number
  width: number
  height: number
}

export interface PdfExtractResult {
  ok: boolean
  /** 提取出的纯文本（失败时为空字符串，同时 code/message 必须存在） */
  text: string
  pages: PdfPageInfo[]
  pageCount: number
  charCount: number
  elapsedMs: number
  warnings: string[]
  method: 'pdfjs' | 'none'
  code?: PdfFailureCode
  message?: string
}

export const PDF_MESSAGES = {
  encrypted: 'PDF 已加密，请先解除密码保护后再打开',
  noTextLayer: '这是扫描件（没有文字层），暂不支持 OCR；可点「原始文件」下载后查看',
  corrupt: 'PDF 结构异常，无法解析',
  worker: 'PDF 解析器（worker）启动失败，请刷新页面后重试',
  unknown: 'PDF 解析失败',
} as const

/** 把 pdf.js 抛出的异常翻译成可读原因，避免“未知错误”敷衍过去 */
export function classifyPdfError(error: unknown): { code: PdfFailureCode; message: string } {
  const err = error as { name?: string; message?: string } | null
  const name = err?.name ?? ''
  const detail = String(err?.message ?? error ?? '')

  if (name === 'PasswordException' || /password/i.test(detail)) {
    return { code: 'encrypted', message: PDF_MESSAGES.encrypted }
  }
  if (name === 'InvalidPDFException' || /invalid pdf|invalidpdf|bad xref|missing pdf/i.test(detail)) {
    return { code: 'corrupt', message: `${PDF_MESSAGES.corrupt}（${detail || name}）` }
  }
  if (/worker|setting up fake worker/i.test(detail)) {
    return { code: 'worker', message: `${PDF_MESSAGES.worker}（${detail}）` }
  }
  return { code: 'unknown', message: `${PDF_MESSAGES.unknown}：${detail || name || '未知错误'}` }
}

/** pdf.js 的 TextItem 结构（这里只用到 str / hasEOL，避免依赖内部类型路径） */
interface TextItemLike {
  str?: string
  hasEOL?: boolean
}

function itemText(items: unknown[]): string {
  let out = ''
  for (const raw of items) {
    const item = raw as TextItemLike
    if (typeof item.str !== 'string') continue
    out += item.str
    if (item.hasEOL) out += '\n'
  }
  return out
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface PdfLoadOptions {
  signal?: AbortSignal
}

/** 载入文档（调用方负责 destroy；本模块的 extractPdfText 内部会自行处理） */
export async function loadPdfDocument(buffer: ArrayBuffer, options: PdfLoadOptions = {}): Promise<PDFDocumentProxy> {
  const pdfjsLib = await getPdfjs()
  // pdf.js 会把传入的 buffer 转移/分离，必须传副本，否则调用方的原始字节会被清空
  const data = new Uint8Array(buffer.slice(0))
  const task = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableAutoFetch: true,
  })
  const onAbort = () => task.destroy()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await task.promise
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** 把单页渲染到已有 canvas 上（按容器宽度自适应） */
export async function renderPdfPageToCanvas(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  targetWidth: number,
): Promise<void> {
  const page: PDFPageProxy = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const scale = Math.max((targetWidth / base.width) * ratio, 0.2)
  const viewport = page.getViewport({ scale })
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  canvas.style.width = '100%'
  canvas.style.height = 'auto'
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法获取 canvas 2D 上下文')
  await page.render({ canvasContext: context, viewport }).promise
  page.cleanup()
}

export interface PdfText {
  ok: boolean
  text: string
  method: 'pdfjs' | 'none'
  warnings: string[]
  pages: PdfPageInfo[]
  pageCount: number
  charCount: number
  elapsedMs: number
  code?: PdfFailureCode
  message?: string
  doc?: PDFDocumentProxy
}

export interface ExtractOptions {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

/**
 * 提取 PDF 文本。
 * - 成功：ok=true，text 为逐页拼接的纯文本，doc 可直接复用做 canvas 渲染
 * - 失败：ok=false，code/message 必填，text 为空但绝不静默
 */
export async function extractPdfText(buffer: ArrayBuffer, options: ExtractOptions = {}): Promise<PdfText> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const fail = (code: PdfFailureCode, message: string, pageCount = 0): PdfText => ({
    ok: false,
    text: '',
    method: 'none',
    warnings: [message],
    pages: [],
    pageCount,
    charCount: 0,
    elapsedMs: elapsed(),
    code,
    message,
  })

  let doc: PDFDocumentProxy
  try {
    doc = await loadPdfDocument(buffer, { signal: options.signal })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    const { code, message } = classifyPdfError(error)
    return fail(code, message)
  }

  try {
    if (!doc.numPages) {
      await doc.destroy()
      return fail('corrupt', PDF_MESSAGES.corrupt)
    }

    const pages: PdfPageInfo[] = []
    const chunks: string[] = []
    for (let index = 1; index <= doc.numPages; index++) {
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const page = await doc.getPage(index)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const raw = itemText(content.items as unknown[])
      chunks.push(raw)
      pages.push({
        index,
        chars: raw.replace(/\s/g, '').length,
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
      })
      page.cleanup()
      options.onProgress?.(index, doc.numPages)
    }

    const text = normalize(chunks.join('\n\n'))
    const charCount = text.replace(/\s/g, '').length
    if (!charCount) {
      const pageCount = doc.numPages
      await doc.destroy()
      return fail('no-text-layer', PDF_MESSAGES.noTextLayer, pageCount)
    }

    const warnings: string[] = []
    const emptyPages = pages.filter((page) => page.chars === 0)
    if (emptyPages.length) {
      warnings.push(`第 ${emptyPages.map((page) => page.index).join('、')} 页没有文字层（可能是图片页），已跳过`)
    }

    return {
      ok: true,
      text,
      method: 'pdfjs',
      warnings,
      pages,
      pageCount: doc.numPages,
      charCount,
      elapsedMs: elapsed(),
      doc,
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    const pageCount = doc.numPages
    await doc.destroy().catch(() => undefined)
    const { code, message } = classifyPdfError(error)
    return fail(code, message, pageCount)
  }
}
