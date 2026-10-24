import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { deleteDoc, loadAll, saveDoc, saveSession, type DocRecord } from '../lib/db'
import { MAX_FILE_BYTES, decodeText, detectKind, formatSize, parsePptx, type FileKind } from '../lib/file'
import { parseDocx } from '../lib/docx'
import { escapeHtml, renderMarkdown } from '../lib/markdown'
import {
  FALLBACK_MAX_CELLS,
  FALLBACK_MAX_ROWS,
  LARGE_XLSX_BYTES,
  inspectXlsxWorkbook,
  parseXlsx,
  parseXlsxFallback,
  persistedFromSheet,
  setCell,
  sheetText,
  type PersistedSheet,
} from '../lib/xlsx'
import { extractPdfText } from '../lib/pdf'
import { forgetPdfDocument, rememberPdfDocument } from '../lib/pdfCache'

export interface ToastMessage {
  id: number
  title: string
  description?: string
  tone: 'info' | 'success' | 'warning' | 'error'
}

/** 解析等待态：超过 5 秒给出可取消入口 */
export interface ImportJob {
  id: number
  fileName: string
  phase: string
  startedAt: number
  seconds: number
  canCancel: boolean
}

/** 大文件前置确认 */
export interface ConfirmRequest {
  title: string
  description: string
  detail?: string[]
  confirmText: string
  cancelText: string
}

type Persistence = 'ok' | 'degraded' | 'init'

let toastSeed = 1
let jobSeed = 1

function uid() {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 纯文本按段落包装为编辑器 HTML（全部转义，禁止直出未转义内容）。 */
function textToHtml(text: string) {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.split('\n').map((line) => escapeHtml(line)).join('<br />')}</p>`)
  return blocks.join('\n')
}

type PhaseReporter = (phase: string) => void

async function buildRecord(
  file: File,
  signal: AbortSignal,
  onPhase: PhaseReporter,
  mode: 'auto' | 'fast' = 'auto',
): Promise<{ record: DocRecord; notices: string[] }> {
  const kind: FileKind = detectKind(file.name)
  const notices: string[] = []
  const buffer = await file.arrayBuffer()
  const now = Date.now()
  const record: DocRecord = {
    id: uid(),
    name: file.name,
    size: file.size,
    kind,
    addedAt: now,
    updatedAt: now,
    html: '',
    originalHtml: '',
    warnings: [],
    dirty: false,
  }

  try {
    // 只有按文本解码的格式（md / 未知）受 4 MB 截断影响，二进制格式不截断
    if (buffer.byteLength > MAX_FILE_BYTES && (kind === 'md' || kind === 'unknown')) {
      notices.push('文件超过 4 MB，已截断至 4 MB 以内处理')
    }
    switch (kind) {
      case 'docx': {
        onPhase('正在解析段落与图片')
        const parsed = await parseDocx(buffer)
        record.html = parsed.html
        record.originalHtml = parsed.html
        record.warnings = parsed.warnings
        record.paragraphCount = parsed.paragraphCount
        record.firstParagraph = parsed.firstParagraph
        record.docxItems = parsed.items
        record.text = parsed.plainText
        break
      }
      case 'md': {
        const decoded = decodeText(buffer.slice(0, MAX_FILE_BYTES))
        record.markdown = decoded.text
        record.text = decoded.text
        record.html = renderMarkdown(decoded.text)
        record.originalHtml = record.html
        record.encoding = decoded.encoding
        if (decoded.encoding === 'gb18030') notices.push('检测到 GBK/GB18030 编码，已按兼容编码解码')
        if (decoded.truncated) notices.push('文件超过 4 MB，已截断并仅保留前 4 MB 内容')
        break
      }
      case 'xlsx': {
        onPhase(mode === 'fast' ? '正在快速读取工作簿（最多 20000 行）' : '正在读取工作簿')
        const parseOptions = {
          maxRows: FALLBACK_MAX_ROWS,
          maxCells: FALLBACK_MAX_CELLS,
          signal,
          onProgress: (progress: { done: number; total: number; sheet: string }) => {
            onPhase(`正在解析工作表 ${progress.done}/${progress.total}（${progress.sheet}）`)
          },
        }
        // 用户在「大文件」确认里选择继续时，走可截断、可中止、几十毫秒到几秒的内置解析器；
        // 其余情况依旧是 SheetJS 主路径（未改动）。快速模式失败再回退到 SheetJS 兜底。
        let parsed
        if (mode === 'fast') {
          try {
            parsed = await parseXlsxFallback(buffer, [], parseOptions)
          } catch (fastError) {
            if ((fastError as Error)?.name === 'AbortError') throw fastError
            notices.push('快速模式失败，已尝试用 SheetJS 重新读取')
            parsed = await parseXlsx(buffer, parseOptions)
          }
        } else {
          parsed = await parseXlsx(buffer, parseOptions)
        }
        const sheets: PersistedSheet[] = parsed.sheets.map((sheet) => {
          const persisted = persistedFromSheet(sheet)
          // 主路径（SheetJS）同样按行数截断，这里统一补上显式标注，避免只留一句 warning
          if (persisted.truncated && !persisted.truncatedNote) {
            persisted.truncatedNote = `已截断，仅显示前 ${persisted.rows.length} 行（共 ${persisted.totalRows} 行）`
          }
          return persisted
        })
        record.sheets = sheets
        const truncated = sheets.filter((sheet) => sheet.truncated)
        const extraNotes = truncated
          .map((sheet) => (sheet.truncatedNote ? `「${sheet.name}」${sheet.truncatedNote}` : ''))
          .filter((note) => note && !parsed.warnings.some((warning) => warning.includes(sheetNoteTail(note))))
        record.warnings = [...parsed.warnings, ...extraNotes].filter(
          (warning, index, all) => all.indexOf(warning) === index,
        )
        record.text = sheetText(sheets)
        break
      }
      case 'pptx': {
        onPhase('正在读取幻灯片')
        const parsed = await parsePptx(buffer)
        record.slides = parsed.slides
        record.warnings = parsed.warnings
        const text = parsed.slides.map((slide) => `${slide.title}\n${slide.lines.join('\n')}`).join('\n\n')
        record.html = textToHtml(text)
        record.originalHtml = record.html
        record.text = text
        break
      }
      case 'pdf': {
        onPhase('正在启动 PDF 解析器')
        const parsed = await extractPdfText(buffer, {
          signal,
          onProgress: (done, total) => onPhase(`正在提取第 ${done}/${total} 页文字`),
        })
        record.pdfPageCount = parsed.pageCount
        record.pdfPages = parsed.pages
        record.pdfElapsedMs = parsed.elapsedMs
        record.pdfText = parsed.text
        if (parsed.ok) {
          record.warnings = parsed.warnings
          record.html = textToHtml(parsed.text)
          record.originalHtml = record.html
          record.text = parsed.text
          if (parsed.doc) rememberPdfDocument(record.id, parsed.doc)
        } else {
          // 失败必须落原因，界面按原因提示，绝不静默返回空文本
          record.pdfErrorCode = parsed.code ?? 'unknown'
          record.pdfError = parsed.message ?? 'PDF 解析失败'
          record.warnings = [record.pdfError]
          record.html = `<p>${escapeHtml(record.pdfError)}</p><p>文件仍完整保留在本机，可点顶部「原始文件」下载后查看。</p>`
          record.originalHtml = record.html
          notices.push(record.pdfError)
        }
        break
      }
      default: {
        const decoded = decodeText(buffer.slice(0, MAX_FILE_BYTES))
        record.kind = 'md'
        record.markdown = decoded.text
        record.text = decoded.text
        record.html = textToHtml(decoded.text)
        record.originalHtml = record.html
        record.warnings = ['未识别的文件格式，已按纯文本尝试读取']
      }
    }
    if (!record.html && !record.sheets?.length && !record.pdfText && !record.text) {
      record.warnings = [...record.warnings, '未读取到可展示内容，可尝试下载原始文件查看']
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    const message = (error as Error)?.message ?? '未知错误'
    record.warnings = [`无法解析该文件：${message}`]
    record.html = `<p>该文件暂时无法解析，已保留会话记录以便下载原始文件。</p><p>文件名：${escapeHtml(file.name)}</p><p>可尝试「导出文本副本」或「下载原始文件」。</p>`
    try {
      const decoded = decodeText(buffer.slice(0, MAX_FILE_BYTES))
      if (decoded.text.trim()) {
        record.text = decoded.text
        record.warnings = [...record.warnings, '已按纯文本降级读取可读部分']
      }
    } catch {
      /* 纯文本兜底同样失败时只保留提示，不抛错、不白屏 */
    }
    record.originalHtml = record.html
    notices.push('文件解析失败，已按可读部分降级展示')
  }

  record.originalFile = buffer
  return { record, notices }
}

/** 取「已截断，仅显示前 N 行（共 M 行）」这段主体，用于与已有 warning 去重比对 */
function sheetNoteTail(note: string): string {
  const at = note.indexOf('已截断')
  return at >= 0 ? note.slice(at) : note
}

/** 取出编辑区 HTML 中首个块级元素的文字（供导出自检比对「首段」）。 */
export function firstParagraphFromHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return ''
  const block = root.querySelector('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table')
  return (block?.textContent ?? root.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 从 HTML 中提取文档大纲（只读解析，不插入 DOM）。 */
export function outlineFromHtml(html: string) {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return []
  return Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el, index) => ({
    id: `outline-${index}`,
    level: Number(el.tagName.slice(1)),
    text: (el.textContent ?? '').trim() || '未命名标题',
    index,
  }))
}

export const useWorkspaceStore = defineStore('workspace', () => {
  /** 文档对象内含 ArrayBuffer 等二进制数据，用 shallowRef 避免深度代理与结构化克隆问题 */
  const docs = shallowRef<DocRecord[]>([])
  const activeId = ref<string | null>(null)
  const loading = ref(true)
  const hydrated = ref(false)
  const persistence = ref<Persistence>('init')
  const toasts = ref<ToastMessage[]>([])
  const job = ref<ImportJob | null>(null)
  const confirmRequest = ref<(ConfirmRequest & { resolve: (value: boolean) => void }) | null>(null)

  const activeDoc = computed(() => docs.value.find((doc) => doc.id === activeId.value) ?? docs.value[0] ?? null)
  const sessionCount = computed(() => docs.value.length)

  let jobTimer: number | null = null
  let abortController: AbortController | null = null

  function addToast(toast: Omit<ToastMessage, 'id'>) {
    const id = toastSeed++
    toasts.value = [...toasts.value, { ...toast, id }].slice(-4)
    setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id)
    }, 5200)
  }

  function dismissToast(id: number) {
    toasts.value = toasts.value.filter((item) => item.id !== id)
  }

  /* ---------------- 解析等待态（进度 + 5 秒后可取消） ---------------- */

  function startJob(fileName: string, phase: string) {
    endJob()
    abortController = new AbortController()
    const startedAt = Date.now()
    job.value = { id: jobSeed++, fileName, phase, startedAt, seconds: 0, canCancel: false }
    jobTimer = window.setInterval(() => {
      if (!job.value) return
      const seconds = Math.floor((Date.now() - job.value.startedAt) / 1000)
      job.value = { ...job.value, seconds, canCancel: seconds >= 5 }
    }, 250)
  }

  function updateJobPhase(phase: string) {
    if (job.value) job.value = { ...job.value, phase }
  }

  function endJob() {
    if (jobTimer) {
      window.clearInterval(jobTimer)
      jobTimer = null
    }
    job.value = null
    abortController = null
  }

  function cancelJob() {
    if (!job.value) return
    updateJobPhase('正在取消…')
    abortController?.abort()
  }

  /* ---------------- 大文件确认 ---------------- */

  function askConfirm(request: ConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => {
      confirmRequest.value = { ...request, resolve }
    })
  }

  function resolveConfirm(value: boolean) {
    const pending = confirmRequest.value
    confirmRequest.value = null
    pending?.resolve(value)
  }

  /**
   * 大工作簿前置保护：文件 > 2 MB 或估算行数 > 20000 时必须先确认。
   * 返回解析模式：行数超限 → fast（只加载前 20000 行，与提示文案一致）；否则 normal。
   */
  async function gateLargeWorkbook(file: File): Promise<{ proceed: boolean; mode: 'auto' | 'fast' }> {
    const largeBySize = file.size > LARGE_XLSX_BYTES
    let estimatedRows = 0
    let largestSheet = ''
    let inspectError = ''
    try {
      const info = await inspectXlsxWorkbook(await file.arrayBuffer())
      estimatedRows = info.estimatedRows
      largestSheet = info.largestSheet
    } catch (error) {
      inspectError = (error as Error)?.message ?? '无法预读'
    }
    const rowsTooMany = estimatedRows > FALLBACK_MAX_ROWS
    if (!largeBySize && !rowsTooMany) return { proceed: true, mode: 'auto' }

    const proceed = await askConfirm({
      title: `文件较大：${file.name}`,
      description: rowsTooMany
        ? `将只加载前 ${FALLBACK_MAX_ROWS.toLocaleString('en-US')} 行，超出的内容不会装进内存；解析完成后表格会显式标注「已截断」。`
        : `解析可能需要数秒，期间会显示进度；超过 5 秒可以取消。`,
      detail: [
        `文件大小：${formatSize(file.size)}`,
        estimatedRows
          ? `估算行数：${estimatedRows.toLocaleString('en-US')} 行（工作表「${largestSheet}」）`
          : `估算行数：无法预读${inspectError ? `（${inspectError}）` : ''}`,
        rowsTooMany
          ? `装载上限：${FALLBACK_MAX_ROWS.toLocaleString('en-US')} 行 / ${FALLBACK_MAX_CELLS.toLocaleString('en-US')} 单元格`
          : '完整读取：行数在工作簿上限以内，不需要截断',
        '解析过程中可以随时取消，取消不会留下半个文件。',
      ],
      confirmText: rowsTooMany ? '继续解析（只读前 20000 行）' : '继续解析',
      cancelText: '取消',
    })
    return { proceed, mode: rowsTooMany ? 'fast' : 'auto' }
  }

  async function persistRecord(record: DocRecord) {
    const result = await saveDoc(record)
    if (!result.ok) {
      addToast({ title: '本地保存降级', description: result.reason ?? '无法写入 IndexedDB', tone: 'warning' })
      persistence.value = 'degraded'
    }
    return result
  }

  async function hydrate() {
    if (hydrated.value) return
    hydrated.value = true
    const result = await loadAll()
    if (!result.ok) {
      loading.value = false
      persistence.value = 'degraded'
      return
    }
    const sorted = result.docs.slice().sort((a, b) => a.addedAt - b.addedAt)
    const sessionIds = result.session?.ids ?? []
    const sessionActive = result.session?.activeId ?? null
    const ordered = sessionIds.length
      ? [
          ...sessionIds.map((id) => sorted.find((doc) => doc.id === id)).filter((doc): doc is DocRecord => !!doc),
          ...sorted.filter((doc) => !sessionIds.includes(doc.id)),
        ]
      : sorted
    // 恢复时把「首段」缓存对齐到当前 HTML（历史记录可能由旧版本写入），
    // 保证导出自检比对的是编辑区真实内容，而不是解析初稿。
    const normalized = ordered.map((doc) => {
      if (doc.kind !== 'docx' || !doc.html) return doc
      const firstParagraph = firstParagraphFromHtml(doc.html)
      return firstParagraph === doc.firstParagraph ? doc : { ...doc, firstParagraph }
    })
    docs.value = normalized
    activeId.value =
      sessionActive && normalized.some((doc) => doc.id === sessionActive) ? sessionActive : (normalized[0]?.id ?? null)
    loading.value = false
    persistence.value = 'ok'
  }

  async function importFiles(files: File[]) {
    if (!files.length) return
    const accepted: File[] = []
    files.forEach((file) => {
      const kind = detectKind(file.name)
      if (kind === 'unknown') {
        addToast({
          title: `暂不支持 ${file.name}`,
          description: '支持的格式：docx / xlsx / pptx / md / pdf',
          tone: 'warning',
        })
        return
      }
      accepted.push(file)
    })
    if (!accepted.length) return
    addToast({
      title: `正在本地解析 ${accepted.length} 个文件`,
      description: '全程不上传，解析在浏览器内完成',
      tone: 'info',
    })

    const created: DocRecord[] = []
    for (const file of accepted) {
      try {
        let mode: 'auto' | 'fast' = 'auto'
        if (detectKind(file.name) === 'xlsx') {
          const gate = await gateLargeWorkbook(file)
          if (!gate.proceed) {
            addToast({ title: `已跳过 ${file.name}`, description: '大文件解析需要确认后再进行', tone: 'info' })
            continue
          }
          mode = gate.mode
        }

        startJob(file.name, '正在准备读取')
        // 让等待态先绘制出来，再进入可能阻塞主线程的解析
        await new Promise((resolve) => window.setTimeout(resolve, 16))
        const signal = abortController?.signal ?? new AbortController().signal
        const { record, notices } = await buildRecord(file, signal, updateJobPhase, mode)
        created.push(record)
        const result = await persistRecord(record)
        if (result.ok) {
          notices.forEach((notice) => addToast({ title: file.name, description: notice, tone: 'info' }))
        }
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          addToast({ title: `已取消解析 ${file.name}`, description: '没有写入任何内容', tone: 'info' })
        } else {
          addToast({ title: `${file.name} 导入失败`, description: (error as Error).message, tone: 'error' })
        }
      } finally {
        endJob()
      }
    }
    if (!created.length) return

    const nextDocs = [...docs.value, ...created]
    docs.value = nextDocs
    activeId.value = created[created.length - 1].id
    void saveSession({ activeId: activeId.value, ids: nextDocs.map((doc) => doc.id), updatedAt: Date.now() })

    const first = created[0]
    addToast({
      title: `已导入 ${first.name}`,
      description: `${formatSize(first.size)}${created.length > 1 ? ` · 共 ${created.length} 个文件` : ''}，内容已在本地就绪`,
      tone: 'success',
    })
  }

  async function removeDoc(id: string) {
    const index = docs.value.findIndex((doc) => doc.id === id)
    const nextDocs = docs.value.filter((doc) => doc.id !== id)
    docs.value = nextDocs
    forgetPdfDocument(id)
    if (activeId.value === id) {
      activeId.value = nextDocs[Math.max(0, index - 1)]?.id ?? nextDocs[0]?.id ?? null
    }
    await deleteDoc(id)
    await saveSession({ activeId: activeId.value, ids: nextDocs.map((doc) => doc.id), updatedAt: Date.now() })
  }

  function setActive(id: string) {
    activeId.value = id
    void saveSession({ activeId: id, ids: docs.value.map((doc) => doc.id), updatedAt: Date.now() })
  }

  function updateDoc(id: string, patch: Partial<DocRecord>, persist = true) {
    let updated: DocRecord | null = null
    docs.value = docs.value.map((doc) => {
      if (doc.id !== id) return doc
      const next = { ...doc, ...patch, updatedAt: Date.now() }
      // 编辑后同步「首段」缓存，否则导出自检会拿解析初稿与回读结果比对而误报不一致
      if (typeof patch.html === 'string' && patch.html !== doc.html) {
        next.firstParagraph = firstParagraphFromHtml(patch.html)
      }
      updated = next
      return next
    })
    if (persist && updated) void persistRecord(updated)
  }

  function updateCell(id: string, sheetIndex: number, row: number, col: number, value: string) {
    const doc = docs.value.find((item) => item.id === id)
    if (!doc || !doc.sheets) return
    const sheets = setCell(doc.sheets, sheetIndex, row, col, value)
    updateDoc(id, { sheets, dirty: true })
  }

  function resetDoc(id: string) {
    const doc = docs.value.find((item) => item.id === id)
    if (!doc) return
    updateDoc(id, { html: doc.originalHtml, dirty: false })
  }

  return {
    docs,
    activeId,
    loading,
    hydrated,
    persistence,
    toasts,
    job,
    confirmRequest,
    activeDoc,
    sessionCount,
    addToast,
    dismissToast,
    hydrate,
    importFiles,
    removeDoc,
    setActive,
    updateDoc,
    updateCell,
    resetDoc,
    cancelJob,
    resolveConfirm,
    askConfirm,
  }
})
