import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * PDFDocumentProxy 不可结构化克隆，绝对不能放进 DocRecord（那会写 IndexedDB 失败）。
 * 这里用模块级缓存按文档 id 持有句柄：导入时解析出来的 doc 直接给 <PdfPages> 复用，
 * 避免为了渲染再解析一遍整个文件。
 */
const cache = new Map<string, PDFDocumentProxy>()

export function rememberPdfDocument(id: string, doc: PDFDocumentProxy) {
  const previous = cache.get(id)
  if (previous && previous !== doc) void previous.destroy().catch(() => undefined)
  cache.set(id, doc)
}

export function getPdfDocument(id: string): PDFDocumentProxy | null {
  return cache.get(id) ?? null
}

export function forgetPdfDocument(id: string) {
  const doc = cache.get(id)
  if (!doc) return
  cache.delete(id)
  void doc.destroy().catch(() => undefined)
}
