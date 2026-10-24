import type { DocxItem } from './docx'
import type { PersistedSheet } from './xlsx'
import type { FileKind, PptSlide } from './file'

const DB_NAME = 'liteoffice'
const DB_VERSION = 1
const STORE = 'documents'

export interface DocRecord {
  id: string
  name: string
  size: number
  kind: FileKind
  addedAt: number
  updatedAt: number
  /** 编辑区 HTML（docx / md / 富文本） */
  html: string
  /** 原始文本（md / pdf / pptx 文本） */
  text?: string
  markdown?: string
  warnings: string[]
  encoding?: string
  paragraphCount?: number
  firstParagraph?: string
  /** 解析初稿，供「重置编辑」与表格还原 */
  originalHtml: string
  /** docx 结构化内容，用于精确读取段落数 */
  docxItems?: DocxItem[]
  sheets?: PersistedSheet[]
  slides?: PptSlide[]
  pdfText?: string
  /** PDF 页数与逐页字符数（pdfjs-dist 提取后写入，仅元数据，可安全入库） */
  pdfPageCount?: number
  pdfPages?: { index: number; chars: number; width: number; height: number }[]
  /** PDF 解析失败原因（人话），失败时界面按此提示而不是空白 */
  pdfError?: string
  pdfErrorCode?: string
  /** PDF 文本提取耗时（毫秒） */
  pdfElapsedMs?: number
  dirty?: boolean
  /** 原始文件字节，用于「下载原始文件」 */
  originalFile?: ArrayBuffer
}

export interface SessionState {
  activeId: string | null
  ids: string[]
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let degraded = false

export function isDegraded() {
  return degraded
}

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      degraded = true
      resolve(null)
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      degraded = true
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      degraded = true
      resolve(null)
    }
    request.onblocked = () => {
      degraded = true
      resolve(null)
    }
  })
  return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'))
  })
}

export async function loadAll(): Promise<{ docs: DocRecord[]; session: SessionState | null; ok: boolean }> {
  const db = await openDB()
  if (!db) return { docs: [], session: null, ok: false }
  try {
    const tx = db.transaction([STORE, 'meta'], 'readonly')
    const docsReq = tx.objectStore(STORE).getAll()
    const sessionReq = tx.objectStore('meta').get('session')
    const docs = await new Promise<DocRecord[]>((resolve) => {
      docsReq.onsuccess = () => resolve((docsReq.result as DocRecord[]) ?? [])
      docsReq.onerror = () => resolve([])
    })
    const session = await new Promise<SessionState | null>((resolve) => {
      sessionReq.onsuccess = () => {
        const value = sessionReq.result as { key: string; value: SessionState } | undefined
        resolve(value?.value ?? null)
      }
      sessionReq.onerror = () => resolve(null)
    })
    return { docs, session, ok: true }
  } catch {
    degraded = true
    return { docs: [], session: null, ok: false }
  }
}

export async function saveDoc(doc: DocRecord): Promise<{ ok: boolean; reason?: string }> {
  const db = await openDB()
  if (!db) return { ok: false, reason: '当前浏览器不可用 IndexedDB' }
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(doc)
    await done(tx)
    return { ok: true }
  } catch (error) {
    degraded = true
    const name = (error as { name?: string })?.name ?? ''
    if (name === 'QuotaExceededError') {
      return { ok: false, reason: '本地存储空间不足，本次内容未能写入 IndexedDB（页面内仍可继续编辑）' }
    }
    return { ok: false, reason: '内容未能写入 IndexedDB，已降级为仅本页内保存' }
  }
}

export async function deleteDoc(id: string): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    await done(tx)
  } catch {
    degraded = true
  }
}

export async function saveSession(session: SessionState): Promise<boolean> {
  const db = await openDB()
  if (!db) return false
  try {
    const tx = db.transaction('meta', 'readwrite')
    tx.objectStore('meta').put({ key: 'session', value: session })
    await done(tx)
    return true
  } catch {
    degraded = true
    return false
  }
}

export async function clearAll(): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    const tx = db.transaction([STORE, 'meta'], 'readwrite')
    tx.objectStore(STORE).clear()
    tx.objectStore('meta').clear()
    await done(tx)
  } catch {
    degraded = true
  }
}

