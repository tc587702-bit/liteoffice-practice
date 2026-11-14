import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { deleteDoc, loadAll, saveDoc, saveSession, type DocRecord } from '../lib/db'
import { decodeText, detectKind, formatSize, parsePptx, type FileKind } from '../lib/file'
import { parseDocx } from '../lib/docx'
import { escapeHtml, htmlToMarkdown } from '../lib/markdown'
import {
  inspectXlsxWorkbook,
  parseXlsxFallback,
  persistedFromSheet,
  setCell,
  sheetText,
  type PersistedSheet,
  type XlsxParseResult,
} from '../lib/xlsx'
import { extractPdfText } from '../lib/pdf'
import { forgetPdfDocument, rememberPdfDocument } from '../lib/pdfCache'
import { parseXlsxInWorker, renderMarkdownInWorker } from '../lib/parseClient'

export interface ToastMessage {
  id: number
  title: string
  description?: string
  tone: 'info' | 'success' | 'warning' | 'error'
}

/** 解析等待态：显示阶段、已耗时、已处理量；超过 5 秒给出可取消入口 */
export interface ImportJob {
  id: number
  fileName: string
  phase: string
  startedAt: number
  seconds: number
  canCancel: boolean
  done: number
  total: number
}

export interface ConfirmRequest {
  title: string
  description: string
  detail?: string[]
  confirmText: string
  cancelText: string
}

/** 内存/解析崩溃兜底：给原因 + 下载原始文件，绝不留白屏 */
export interface FatalState {
  fileName: string
  size: number
  message: string
  /** 直接用 File 作为 Blob 下载，避免为了下载再把上百 MB 读进内存 */
  blob: Blob | null
}

type Persistence = 'ok' | 'degraded' | 'init'

/** 分级提示阈值：只提示，不阻止 */
const WARN_BYTES = 16 * 1024 * 1024
/** 超过 2 MB 就先出内容、后台落库（首屏优先） */
const DEFER_PERSIST_BYTES = 2 * 1024 * 1024
const RISK_BYTES = 64 * 1024 * 1024
/** 超过该体积不再尝试整体读入内存，直接给「下载原始文件」的兜底提示 */
const HARD_BYTES = 128 * 1024 * 1024

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

/** 是否属于内存类异常（RangeError / 分配失败 / Worker 崩溃） */
function isMemoryError(error: unknown): boolean {
  const err = error as { name?: string; message?: string } | null
  const text = `${err?.name ?? ''} ${err?.message ?? ''}`
  return (
    err?.name === 'RangeError' ||
    /out of memory|allocation failed|array buffer allocation|invalid string length|内存不足/i.test(text)
  )
}

function memoryHint(size: number, fileName: string) {
  return `文件 ${formatSize(size)}（${fileName}）超出本机浏览器可用内存，已停止解析。本地功能未受影响，可下载原文件用桌面软件打开。`
}

type PhaseReporter = (phase: string, done?: number, total?: number) => void

async function buildRecord(
  file: File,
  signal: AbortSignal,
  onPhase: PhaseReporter,
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
    switch (kind) {
      case 'docx': {
        onPhase('正在解析段落与图片（主线程 · 依赖 DOM 解析器）')
        await new Promise((resolve) => setTimeout(resolve, 0))
        signal.throwIfAborted()
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
        const decoded = decodeText(buffer)
        record.markdown = decoded.text
        record.originalMarkdown = decoded.text
        record.text = decoded.text
        record.encoding = decoded.encoding
        if (decoded.encoding === 'gb18030') notices.push('检测到 GBK/GB18030 编码，已按兼容编码解码')
        onPhase('正在渲染 Markdown（Worker）', 0, decoded.text.length)
        const html = await renderMarkdownInWorker(decoded.text, {
          signal,
          onProgress: (progress) => onPhase('正在渲染 Markdown（Worker）', progress.done, progress.total),
        })
        record.html = html
        record.originalHtml = html
        break
      }
      case 'xlsx': {
        onPhase('正在读取工作簿（Worker）')
        let parsed: XlsxParseResult
        try {
          parsed = await parseXlsxInWorker(buffer, {
            signal,
            onProgress: (progress) =>
              onPhase(`正在解析工作表 ${progress.done}/${progress.total}（${progress.label ?? ''}）`, progress.done, progress.total),
          })
        } catch (workerError) {
          if ((workerError as Error)?.name === 'AbortError') throw workerError
          if (isMemoryError(workerError)) throw workerError
          // SheetJS 主路径失败（或 worker 不可用）→ 主线程回退解析器，可中止、可进度
          onPhase('SheetJS 不可用，改用内置解析器（主线程）')
          await new Promise((resolve) => setTimeout(resolve, 0))
          parsed = await parseXlsxFallback(buffer, ['已切换内置解析器读取工作簿'], {
            signal,
            onProgress: (progress) =>
              onPhase(`正在解析工作表 ${progress.done}/${progress.total}（${progress.sheet}）`, progress.done, progress.total),
          })
        }
        const sheets: PersistedSheet[] = parsed.sheets.map((sheet) => persistedFromSheet(sheet))
        record.sheets = sheets
        record.warnings = parsed.warnings
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
          onProgress: (done, total) => onPhase(`正在提取第 ${done}/${total} 页文字`, done, total),
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
        const decoded = decodeText(buffer)
        record.kind = 'md'
        record.markdown = decoded.text
        record.originalMarkdown = decoded.text
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
    if (isMemoryError(error)) throw error
    const message = (error as Error)?.message ?? '未知错误'
    record.warnings = [`无法解析该文件：${message}`]
    record.html = `<p>该文件暂时无法解析，已保留会话记录以便下载原始文件。</p><p>文件名：${escapeHtml(file.name)}</p><p>可尝试「导出文本副本」或「下载原始文件」。</p>`
    try {
      const decoded = decodeText(buffer)
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

/** 取出编辑区 HTML 中首个块级元素的原始文字（供导出自检比对「首段」，不做空白归一化）。 */
export function firstParagraphFromHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return ''
  const block = root.querySelector('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table')
  return (block?.textContent ?? root.textContent ?? '').trim()
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
  const fatal = ref<FatalState | null>(null)

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
    job.value = { id: jobSeed++, fileName, phase, startedAt, seconds: 0, canCancel: true, done: 0, total: 0 }
    jobTimer = window.setInterval(() => {
      if (!job.value) return
      const seconds = Math.floor((Date.now() - job.value.startedAt) / 1000)
      job.value = { ...job.value, seconds, canCancel: true }
    }, 250)
  }

  function updateJobPhase(phase: string, done = 0, total = 0) {
    if (!job.value) return
    job.value = { ...job.value, phase, done, total }
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

  /* ---------------- 确认 / 兜底 ---------------- */

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

  function dismissFatal() {
    fatal.value = null
  }

  /** 兜底对话框里的「下载原始文件」 */
  function downloadFatal() {
    const state = fatal.value
    if (!state?.blob) {
      addToast({ title: '原始文件不可用', description: '文件字节未能保留，无法下载', tone: 'warning' })
      return
    }
    const url = URL.createObjectURL(state.blob)
    const link = document.createElement('a')
    link.href = url
    link.download = state.fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  /** 分级提示：< 16 MB 静默；16–64 MB 提示耗时；> 64 MB 提示内存风险（仍继续打开） */
  function notifySizeTier(file: File) {
    if (file.size >= RISK_BYTES) {
      addToast({
        title: `文件很大（${formatSize(file.size)}）`,
        description: '可能超出浏览器内存，建议下载后用桌面软件打开；这里仍会继续尝试打开全部内容',
        tone: 'warning',
      })
      return
    }
    if (file.size >= WARN_BYTES) {
      addToast({
        title: `文件较大（${formatSize(file.size)}）`,
        description: '打开可能需要数十秒，期间可以取消；不会截断任何内容',
        tone: 'info',
      })
    }
  }

  /** > 64 MB 的超大文件确认：仍然允许继续尝试，绝不直接拒绝 */
  async function confirmExtremeFile(file: File): Promise<boolean> {
    return askConfirm({
      title: `超大文件：${file.name}`,
      description: `文件 ${formatSize(file.size)}，可能超出浏览器内存。仍可以继续尝试打开全部内容；如果中断，会给出「下载原始文件」的出口。`,
      detail: [
        `文件大小：${formatSize(file.size)}`,
        '解析在 Worker / 分块渲染下进行，界面保持可响应，可随时取消。',
        '若提示内存不足，本地功能不受影响，可下载原文件用桌面软件打开。',
      ],
      confirmText: '继续尝试打开',
      cancelText: '取消',
    })
  }

  /** 大工作簿确认（只提示规模，按钮是「继续打开全部」，不设装载上限） */
  async function confirmLargeWorkbook(file: File): Promise<boolean> {
    if (file.size < WARN_BYTES) return true
    let estimatedRows = 0
    let largestSheet = ''
    try {
      const info = await inspectXlsxWorkbook(await file.arrayBuffer())
      estimatedRows = info.estimatedRows
      largestSheet = info.largestSheet
    } catch {
      /* 预读失败不影响继续 */
    }
    return askConfirm({
      title: `大工作簿：${file.name}`,
      description: '将打开全部工作表与全部行，不做任何截断；解析在 Worker 内进行，期间可以取消。',
      detail: [
        `文件大小：${formatSize(file.size)}`,
        estimatedRows
          ? `估算行数：${estimatedRows.toLocaleString('en-US')} 行（工作表「${largestSheet}」）`
          : '估算行数：无法预读',
        '内存不足时会给出明确提示并提供「下载原始文件」。',
      ],
      confirmText: '继续打开全部',
      cancelText: '取消',
    })
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
    // 恢复时把「首段」缓存对齐到当前 HTML，保证导出自检比对的是编辑区真实内容
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
        notifySizeTier(file)
        if (file.size >= HARD_BYTES) {
          fatal.value = {
            fileName: file.name,
            size: file.size,
            message: memoryHint(file.size, file.name),
            blob: file,
          }
          addToast({ title: '文件超出本机可用内存，未开始解析', description: file.name, tone: 'error' })
          break
        }
        if (file.size >= RISK_BYTES) {
          const proceed = await confirmExtremeFile(file)
          if (!proceed) {
            addToast({ title: `已跳过 ${file.name}`, description: '需要确认后再打开超大文件', tone: 'info' })
            continue
          }
        }
        if (detectKind(file.name) === 'xlsx') {
          const proceed = await confirmLargeWorkbook(file)
          if (!proceed) {
            addToast({ title: `已跳过 ${file.name}`, description: '需要确认后再打开大工作簿', tone: 'info' })
            continue
          }
        }

        startJob(file.name, '正在准备读取')
        // 让等待态先绘制出来，再进入解析
        await new Promise((resolve) => window.setTimeout(resolve, 16))
        const signal = abortController?.signal ?? new AbortController().signal
        const { record, notices } = await buildRecord(file, signal, updateJobPhase)
        created.push(record)
        // 大文件先出内容，再在后台写进 IndexedDB，避免几十 MB 的落库成本压在首屏上
        if (file.size >= DEFER_PERSIST_BYTES) {
          updateJobPhase('正在写入本地存储（可继续操作）')
          void persistRecord(record)
        } else {
          const result = await persistRecord(record)
          if (!result.ok) notices.push(result.reason ?? '本地保存降级')
        }
        notices.forEach((notice) => addToast({ title: file.name, description: notice, tone: 'info' }))
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          addToast({ title: `已取消解析 ${file.name}`, description: '没有写入任何内容', tone: 'info' })
        } else if (isMemoryError(error)) {
          fatal.value = {
            fileName: file.name,
            size: file.size,
            message: memoryHint(file.size, file.name),
            blob: file,
          }
          addToast({ title: '内存不足，已停止解析', description: file.name, tone: 'error' })
          break
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
      description: `${formatSize(first.size)}${created.length > 1 ? ` · 共 ${created.length} 个文件` : ''}，全部内容已就绪`,
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
    const patch: Partial<DocRecord> = { html: doc.originalHtml, dirty: false }
    // md 的源码是唯一真相，重置时一并还原；老记录没有 originalMarkdown 时用初稿 html 反推
    if (doc.kind === 'md') {
      patch.markdown = doc.originalMarkdown ?? htmlToMarkdown(doc.originalHtml)
    }
    updateDoc(id, patch)
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
    fatal,
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
    dismissFatal,
    downloadFatal,
  }
})
