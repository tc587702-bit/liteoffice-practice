import { entryText, unzip } from './zip'
import { descendants, parseXmlFromZip } from './xml'
import type { PersistedSheet } from './xlsx'

export type FileKind = 'docx' | 'xlsx' | 'pptx' | 'md' | 'pdf' | 'unknown'

export const MAX_FILE_BYTES = 4 * 1024 * 1024

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
/* 文本解码：UTF-8 优先，严格失败回退 gb18030；单文件 4 MB 上限         */
/* ------------------------------------------------------------------ */

export interface DecodeResult {
  text: string
  encoding: 'utf-8' | 'gb18030'
  truncated: boolean
}

export function decodeText(buffer: ArrayBuffer): DecodeResult {
  let bytes = new Uint8Array(buffer)
  let truncated = false
  if (bytes.byteLength > MAX_FILE_BYTES) {
    bytes = bytes.subarray(0, MAX_FILE_BYTES)
    truncated = true
  }
  // 去掉 BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text, encoding: 'utf-8', truncated }
  } catch {
    try {
      const text = new TextDecoder('gb18030', { fatal: false }).decode(bytes)
      return { text, encoding: 'gb18030', truncated }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', truncated }
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
    } catch {
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

export { entryText, parseXmlFromZip }
