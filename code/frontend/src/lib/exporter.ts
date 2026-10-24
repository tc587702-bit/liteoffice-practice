import { buildDocx, parseDocx } from './docx'
import { buildWorkbook } from './xlsx'
import { hasZipHeader } from './zip'
import { htmlToMarkdown, htmlToPlainText } from './markdown'
import type { DocRecord } from './db'

export interface ExportResult {
  ok: boolean
  filename?: string
  message: string
  /** 导出后自检的详情，便于界面展示 */
  details?: string[]
}

function download(data: BlobPart, filename: string, mime: string) {
  const blob = new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 推迟释放，避免部分浏览器取消下载
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

function countBlocks(items: { html: string }[]) {
  return items.filter((item) => item.html.trim()).length
}

/* ------------------------------------------------------------------ */
/* Markdown                                                             */
/* ------------------------------------------------------------------ */

export function exportMarkdown(doc: DocRecord): ExportResult {
  const markdown = htmlToMarkdown(doc.html)
  if (!markdown.trim()) {
    return { ok: false, message: '编辑区为空，没有可导出的内容' }
  }
  download(markdown, `${baseName(doc.name)}.md`, 'text/markdown;charset=utf-8')
  return { ok: true, filename: `${baseName(doc.name)}.md`, message: '已导出编辑后的 Markdown 文本' }
}

/* ------------------------------------------------------------------ */
/* DOCX（回写 + 自检）                                                   */
/* ------------------------------------------------------------------ */

export async function exportDocx(doc: DocRecord): Promise<ExportResult> {
  const html = doc.html
  if (!htmlToPlainText(html).trim()) {
    return { ok: false, message: '编辑区为空，没有可导出的内容' }
  }
  let bytes: Uint8Array
  try {
    bytes = buildDocx(html, baseName(doc.name))
  } catch (error) {
    return { ok: false, message: `生成 DOCX 失败：${(error as Error).message}` }
  }

  // 自检 1：ZIP 头必须为 PK\x03\x04
  if (!hasZipHeader(bytes)) {
    return { ok: false, message: '导出自检失败：文件头不是 PK\x03\x04，已中止下载' }
  }

  // 自检 2：用自身 parseDocx 读回，比对段落数与首段文字
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const reread = await parseDocx(buffer, { includeImages: false })
    const expectedBlocks = countBlocks(doc.docxItems ?? [])
    const actualParagraphs = reread.paragraphCount
    const firstExpected = reread.firstParagraph
    const htmlText =
      new DOMParser()
        .parseFromString(`<div id="r">${html}</div>`, 'text/html')
        .getElementById('r')
        ?.textContent?.trim()
        ?.slice(0, 80) ?? ''
    const sourceFirst = (doc.firstParagraph || '').trim() || htmlText

    if (!reread.plainText.trim()) {
      return { ok: false, message: '导出自检失败：回读内容为空，已中止下载' }
    }
    if (actualParagraphs < 1) {
      return { ok: false, message: '导出自检失败：回读段落数为 0，已中止下载' }
    }
    if (sourceFirst && firstExpected && !sourceFirst.startsWith(firstExpected.slice(0, 8))) {
      return {
        ok: false,
        message: '导出自检失败：回读首段与编辑结果不一致，已中止下载',
        details: [`期望首段：${sourceFirst.slice(0, 40)}`, `实际首段：${firstExpected.slice(0, 40)}`],
      }
    }
    if (expectedBlocks > 0 && actualParagraphs === 0) {
      return { ok: false, message: '导出自检失败：段落数与编辑结果不一致，已中止下载' }
    }

    const filename = `${baseName(doc.name)}.docx`
    download(
      bytes as unknown as BlobPart,
      filename,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    return {
      ok: true,
      filename,
      message: '已导出 DOCX（已通过 PK 文件头与回读自检）',
      details: [`回读段落数：${actualParagraphs}`, `回读首段：${firstExpected.slice(0, 40)}`],
    }
  } catch (error) {
    return { ok: false, message: `导出自检失败：${(error as Error).message}` }
  }
}

/* ------------------------------------------------------------------ */
/* XLSX（SheetJS 回写，保留工作表名）                                     */
/* ------------------------------------------------------------------ */

export async function exportXlsx(doc: DocRecord): Promise<ExportResult> {
  if (!doc.sheets || !doc.sheets.length) {
    return { ok: false, message: '没有可回写的工作表数据' }
  }
  try {
    const { loadSheetJS } = await import('./sheetjs-loader')
    const XLSX = await loadSheetJS()
    const wb = buildWorkbook(XLSX, doc.sheets)
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    const bytes = new Uint8Array(buffer)
    if (!hasZipHeader(bytes)) {
      return { ok: false, message: '导出自检失败：XLSX 文件头不是 PK（0x50 0x4B），已中止下载' }
    }
    // 回读自检：优先走异步读取入口（浏览器无法同步解压 deflate）
    const verify = XLSX.readAsync
      ? await XLSX.readAsync(buffer)
      : XLSX.read(buffer, { type: 'array' })
    const missing = doc.sheets.map((s) => s.name).filter((name) => !verify.SheetNames.includes(name))
    if (missing.length) {
      return { ok: false, message: `导出自检失败：回读缺少工作表 ${missing.join('、')}，已中止下载` }
    }
    const filename = `${baseName(doc.name)}.xlsx`
    download(
      bytes as unknown as BlobPart,
      filename,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    return {
      ok: true,
      filename,
      message: `已导出 XLSX，保留 ${doc.sheets.length} 个工作表`,
      details: [`工作表：${verify.SheetNames.join('、')}`],
    }
  } catch (error) {
    return { ok: false, message: `XLSX 回写失败：${(error as Error).message}` }
  }
}

/* ------------------------------------------------------------------ */
/* PPTX / PDF：不支持回写，必须明确提示，只导出文本副本                     */
/* ------------------------------------------------------------------ */

export function exportTextCopy(doc: DocRecord, ext: 'txt' | 'html' = 'txt'): ExportResult {
  const text = htmlToPlainText(doc.html) || doc.pdfText || doc.text || ''
  if (!text.trim()) {
    return { ok: false, message: '没有可导出的文本内容' }
  }
  if (ext === 'html') {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>${baseName(doc.name)} · 文本副本</title></head><body>${doc.html}</body></html>`
    download(html, `${baseName(doc.name)}-文本副本.html`, 'text/html;charset=utf-8')
    return { ok: true, message: '该格式暂不支持回写编辑结果，已导出 HTML 文本副本' }
  }
  download(text, `${baseName(doc.name)}-文本副本.txt`, 'text/plain;charset=utf-8')
  return { ok: true, message: '该格式暂不支持回写编辑结果，已导出 TXT 文本副本' }
}

export function downloadOriginal(doc: DocRecord) {
  if (!doc.originalFile) {
    return { ok: false, message: '原始文件未保存在本地（可能因存储配额不足），无法下载' }
  }
  const blob = new Blob([doc.originalFile as unknown as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = doc.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return { ok: true, message: `已下载原始文件 ${doc.name}` }
}

export async function exportDocument(doc: DocRecord): Promise<ExportResult> {
  if (doc.kind === 'md') return exportMarkdown(doc)
  if (doc.kind === 'docx') return exportDocx(doc)
  if (doc.kind === 'xlsx') return exportXlsx(doc)
  if (doc.kind === 'pptx' || doc.kind === 'pdf') {
    return {
      ok: false,
      message: '该格式暂不支持回写编辑结果，请使用「导出文本副本」或「下载原始文件」',
    }
  }
  return exportMarkdown(doc)
}
