import { entryBytes, entryText, unzip, type ZipArchive } from './zip'
import { descendants, parseXmlFromZip } from './xml'
import type { PersistedSheet } from './xlsx'

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
    try {
      const text = new TextDecoder('gb18030', { fatal: false }).decode(bytes)
      return { text, encoding: 'gb18030' }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' }
    }
  }
}

/* ------------------------------------------------------------------ */
/* pptx                                                                */
/* ------------------------------------------------------------------ */

/** 幻灯片里的一张图片：位置与尺寸都用百分比（相对页面），便于响应式缩放 */
export interface PptImage {
  /** data:image/...;base64,… —— 存进 IndexedDB 后刷新仍能显示，不用 blob URL */
  src: string
  /** 相对页面左上角的百分比，0–100 */
  left: number
  top: number
  width: number
  height: number
}

export interface PptSlide {
  index: number
  title: string
  lines: string[]
  images?: PptImage[]
}

/** 幻灯片页面尺寸（EMU），用于把图片坐标换算成百分比 */
export interface PptSize {
  cx: number
  cy: number
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


/** 读取 presentation.xml 里的页面尺寸（EMU），默认 16:9 的 10×5.625 英寸 */
function readSlideSize(archive: ZipArchive): PptSize {
  const xml = entryText(archive, 'ppt/presentation.xml')
  if (!xml) return { cx: 9144000, cy: 5143500 }
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const sz = doc.getElementsByTagName('p:sldSz')[0] ?? doc.getElementsByTagName('sldSz')[0]
  const cx = Number(sz?.getAttribute('cx') ?? 0)
  const cy = Number(sz?.getAttribute('cy') ?? 0)
  if (!cx || !cy) return { cx: 9144000, cy: 5143500 }
  return { cx, cy }
}

/** 从 slideN.xml.rels 取 rId → media 路径 */
function readSlideRels(archive: ZipArchive, slidePath: string): Map<string, string> {
  const relPath = slidePath.replace(/slides\/(slide\d+)\.xml$/i, 'slides/_rels/$1.xml.rels')
  const xml = entryText(archive, relPath)
  const map = new Map<string, string>()
  if (!xml) return map
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  Array.from(doc.getElementsByTagName('Relationship')).forEach((rel) => {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) map.set(id, target)
  })
  return map
}

/** Uint8Array → data URL（图片直接内联，刷新后仍能显示） */
function bytesToDataUrl(bytes: Uint8Array, path: string): string {
  const ext = (path.split('.').pop() ?? 'png').toLowerCase()
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'gif'
        ? 'image/gif'
        : ext === 'svg'
          ? 'image/svg+xml'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/png'
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[])
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/** 解析一页里的图片：位置/尺寸换算成百分比 */
function parseSlideImages(
  archive: ZipArchive,
  slideXml: string,
  slidePath: string,
  size: PptSize,
): PptImage[] {
  const doc = new DOMParser().parseFromString(slideXml, 'application/xml')
  const rels = readSlideRels(archive, slidePath)
  const images: PptImage[] = []
  const emu = (v: string | null) => Number(v ?? 0)

  Array.from(doc.getElementsByTagName('p:pic')).forEach((pic) => {
    const blip = pic.getElementsByTagName('a:blip')[0]
    const rid =
      blip?.getAttribute('r:embed') ??
      blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
    if (!rid) return
    const target = rels.get(rid)
    if (!target) return
    const mediaPath = target.startsWith('../') ? 'ppt/' + target.replace(/^\.\.\//, '') : 'ppt/slides/' + target
    const bytes = entryBytes(archive, mediaPath)
    if (!bytes || !bytes.length) return

    const off = pic.getElementsByTagName('a:off')[0]
    const ext = pic.getElementsByTagName('a:ext')[0]
    const x = emu(off?.getAttribute('x'))
    const y = emu(off?.getAttribute('y'))
    const cx = emu(ext?.getAttribute('cx'))
    const cy = emu(ext?.getAttribute('cy'))
    if (!cx || !cy) return

    images.push({
      src: bytesToDataUrl(bytes, mediaPath),
      left: (x / size.cx) * 100,
      top: (y / size.cy) * 100,
      width: (cx / size.cx) * 100,
      height: (cy / size.cy) * 100,
    })
  })
  return images
}

export async function parsePptx(buffer: ArrayBuffer): Promise<PptResult> {
  const warnings: string[] = []
  const archive = await unzip(buffer)
  const size = readSlideSize(archive)
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
      const images = parseSlideImages(archive, xml, name, size)
      slides.push({
        index: slides.length + 1,
        title: lines[0] ?? `第 ${slides.length + 1} 页`,
        lines: lines.slice(1),
        images,
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
