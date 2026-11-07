import { entryText, unzip } from './zip'
import { descendants } from './xml'
import type { PersistedSheet } from './xlsx'
import { createLogger } from './logger'

const log = createLogger('file')

export type FileKind = 'docx' | 'xlsx' | 'pptx' | 'md' | 'pdf' | 'unknown'

export const KIND_LABEL: Record<FileKind, string> = {
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  md: 'Markdown',
  pdf: 'PDF',
  unknown: '未知',
}

export const KIND_EXT: Record<FileKind, string> = {
  docx: 'DOCX',
  xlsx: 'XLSX',
  pptx: 'PPTX',
  md: 'MD',
  pdf: 'PDF',
  unknown: 'FILE',
}

export function detectKind(name: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx'
  if (ext === 'pptx') return 'pptx'
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (ext === 'pdf') return 'pdf'
  return 'unknown'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* ------------------------------------------------------------------ */
/* 文本解码：UTF-8 优先，严格失败回退 gb18030；不做任何字节截断        */
/* ------------------------------------------------------------------ */

export interface DecodeResult {
  text: string
  encoding: 'utf-8' | 'gb18030'
}

export function decodeText(buffer: ArrayBuffer): DecodeResult {
  let bytes = new Uint8Array(buffer)
  // 去掉 BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text, encoding: 'utf-8' }
  } catch {
    // UTF-8 严格解码失败：中文环境大概率是 GBK 系编码，属于预期分支，用 debug
    log.debug('UTF-8 解码失败，尝试 GB18030', { bytes: bytes.length })
    try {
      const text = new TextDecoder('gb18030', { fatal: false }).decode(bytes)
      return { text, encoding: 'gb18030' }
    } catch (error) {
      // 连 gb18030 都不支持：只能非严格 UTF-8 兜底，会有乱码但不会丢文件
      log.warn('GB18030 解码也失败，改用非严格 UTF-8', {
        bytes: bytes.length,
        error: error instanceof Error ? error.message : String(error),
      })
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' }
    }
  }
}

/* ------------------------------------------------------------------ */
/* pptx                                                                */
/* ------------------------------------------------------------------ */

export interface PptSlide {
  index: number
  title: string
  lines: string[]
}

export interface PptResult {
  slides: PptSlide[]
  warnings: string[]
}

const PPT_NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/** 从单个 slide XML 中按段落抽取文本。 */
export function parsePptxText(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) return []
  const lines: string[] = []
  descendants(doc.documentElement, 'p').forEach((p) => {
    const texts: string[] = []
    Array.from(p.getElementsByTagNameNS(PPT_NS_A, 't')).forEach((t) => texts.push(t.textContent ?? ''))
    if (!texts.length) Array.from(p.getElementsByTagName('a:t')).forEach((t) => texts.push(t.textContent ?? ''))
    const line = texts.join('')
    if (line.trim()) lines.push(line.trim())
  })
  return lines
}

export async function parsePptx(buffer: ArrayBuffer): Promise<PptResult> {
  const warnings: string[] = []
  const archive = await unzip(buffer)
  const files = archive.names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/slide(\d+)/.exec(a)?.[1] ?? 0) - Number(/slide(\d+)/.exec(b)?.[1] ?? 0))
  if (!files.length) warnings.push('未在演示文稿中找到幻灯片')
  const slides: PptSlide[] = []
  for (const name of files) {
    try {
      const xml = entryText(archive, name)
      if (!xml) continue
      const lines = parsePptxText(xml)
      slides.push({
        index: slides.length + 1,
        title: lines[0] ?? `第 ${slides.length + 1} 页`,
        lines: lines.slice(1),
      })
    } catch (error) {
      // 单页失败不影响整份演示文稿：降级展示 + 记录具体是哪一页的哪个文件
      log.warn('PPT 单页解析失败，已降级', {
        slide: slides.length + 1,
        entry: name,
        error: error instanceof Error ? error.message : String(error),
      })
      warnings.push(`第 ${slides.length + 1} 页部分内容无法解析，已展示可读部分`)
    }
  }
  return { slides, warnings }
}

export type { PersistedSheet }

export interface PreviewData {
  kind: FileKind
  sheets?: PersistedSheet[]
  slides?: PptSlide[]
  pdfText?: string
  encoding?: string
  warnings: string[]
  plainText?: string
}

export { entryText }
export { parseXmlFromZip } from './xml'
