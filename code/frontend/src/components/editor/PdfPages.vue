<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { loadPdfDocument, renderPdfPageToCanvas } from '../../lib/pdf'
import { getPdfDocument } from '../../lib/pdfCache'
import type { DocRecord } from '../../lib/db'
import type { PdfPageInfo } from '../../lib/pdf'
import { createLogger } from '../../lib/logger'

const log = createLogger('pdf-pages')

const props = defineProps<{ doc: DocRecord }>()

const pages = ref<PdfPageInfo[]>(props.doc.pdfPages ?? [])
const states = ref<Record<number, 'idle' | 'rendering' | 'done' | 'error'>>({})
const errors = ref<Record<number, string>>({})
const rootRef = ref<HTMLElement | null>(null)

const PRELOAD_PAGES = 2

let pdfDoc: PDFDocumentProxy | null = null
let owned = false
let scroller: HTMLElement | Window | null = null
let frame = 0
const queue: number[] = []
let rendering = false

function pageHost(index: number): HTMLElement | null {
  return rootRef.value?.querySelector<HTMLElement>(`[data-page="${index}"]`) ?? null
}

async function ensureDoc(): Promise<PDFDocumentProxy> {
  if (pdfDoc) return pdfDoc
  const cached = getPdfDocument(props.doc.id)
  if (cached) {
    pdfDoc = cached
    return cached
  }
  if (!props.doc.originalFile) throw new Error('原始文件字节缺失，无法渲染页面')
  pdfDoc = await loadPdfDocument(props.doc.originalFile)
  owned = true
  return pdfDoc
}

/** 顺序渲染队列：同一时刻只画一页，避免多页并发把主线程压满 */
async function drainQueue() {
  if (rendering) return
  rendering = true
  try {
    while (queue.length) {
      const index = queue.shift() as number
      if (states.value[index] === 'done' || states.value[index] === 'rendering') continue
      const host = pageHost(index)
      if (!host) continue
      states.value = { ...states.value, [index]: 'rendering' }
      try {
        const doc = await ensureDoc()
        const canvas = document.createElement('canvas')
        canvas.className = 'block h-auto w-full bg-white'
        host.replaceChildren(canvas)
        await renderPdfPageToCanvas(doc, index, canvas, host.clientWidth || 640)
        states.value = { ...states.value, [index]: 'done' }
      } catch (error) {
        // 单页渲染失败只影响该页，记录页号便于判断是「文件问题」还是「渲染问题」
        log.error('PDF 页面渲染失败', error, { page: index + 1 })
        states.value = { ...states.value, [index]: 'error' }
        errors.value = { ...errors.value, [index]: (error as Error).message }
      }
    }
  } finally {
    rendering = false
  }
}

function enqueue(index: number) {
  if (states.value[index] === 'done' || states.value[index] === 'rendering') return
  if (queue.includes(index)) return
  queue.push(index)
  void drainQueue()
}

/** 只渲染可视页 ±2 页；其余保持占位，翻页/滚动时再渲染 */
function scan() {
  frame = 0
  if (!rootRef.value) return
  const viewportTop = 0
  const viewportBottom = window.innerHeight
  let firstVisible = -1
  let lastVisible = -1
  for (const page of pages.value) {
    const host = pageHost(page.index)
    if (!host) continue
    const rect = host.getBoundingClientRect()
    if (rect.bottom > viewportTop && rect.top < viewportBottom) {
      if (firstVisible < 0) firstVisible = page.index
      lastVisible = page.index
    }
    if (firstVisible >= 0 && rect.top > viewportBottom) break
  }
  if (firstVisible < 0) return
  const from = Math.max(1, firstVisible - PRELOAD_PAGES)
  const to = Math.min(pages.value.length, lastVisible + PRELOAD_PAGES)
  for (let index = from; index <= to; index++) enqueue(index)
}

function schedule() {
  if (frame) return
  frame = window.requestAnimationFrame(scan)
}

function onScroll() {
  schedule()
}

function attachScroller() {
  const parent = rootRef.value?.closest('.thin-scroll') as HTMLElement | null
  scroller = parent ?? window
  scroller.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
}

function detachScroller() {
  scroller?.removeEventListener('scroll', onScroll as EventListener)
  window.removeEventListener('resize', onScroll as EventListener)
  if (frame) window.cancelAnimationFrame(frame)
  frame = 0
}

function aspectOf(page: PdfPageInfo) {
  if (!page.width || !page.height) return '1 / 1.414'
  return `${page.width} / ${page.height}`
}

onMounted(async () => {
  if (!pages.value.length) return
  attachScroller()
  try {
    await ensureDoc()
  } catch (error) {
    // 文档都加载不了：整块 PDF 预览不可用，属于 error
    log.error('PDF 文档加载失败，预览不可用', error)
    errors.value = { ...errors.value, 1: (error as Error).message }
  }
  scan()
})

onBeforeUnmount(() => {
  detachScroller()
  queue.length = 0
  if (owned && pdfDoc) void pdfDoc.destroy().catch(() => undefined)
})
</script>

<template>
  <section v-if="pages.length" ref="rootRef" class="mx-auto mb-5 w-full max-w-[860px]">
    <div class="mb-2 flex items-center justify-between gap-3 text-[11.5px] text-[#636366]">
      <span>PDF 页面 · 只渲染可视页 ±2 页（其余为占位）</span>
      <span class="tabular-nums">共 {{ pages.length }} 页</span>
    </div>
    <div class="flex flex-col gap-4">
      <div v-for="page in pages" :key="page.index" class="relative">
        <div
          class="relative overflow-hidden rounded-[8px] bg-[#E9E9EC] shadow-[0_18px_40px_-24px_rgba(0,0,0,0.9)]"
          :style="{ aspectRatio: aspectOf(page) }"
        >
          <div :data-page="page.index" class="absolute inset-0" />
          <div
            v-if="states[page.index] !== 'done'"
            class="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-[12px] text-[#636366]"
          >
            <span v-if="states[page.index] === 'error'" class="text-[#B3261E]">{{ errors[page.index] }}</span>
            <span v-else-if="states[page.index] === 'rendering'">第 {{ page.index }} 页渲染中…</span>
            <span v-else>第 {{ page.index }} 页</span>
          </div>
        </div>
        <span class="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white/85">
          {{ page.index }} / {{ pages.length }}
        </span>
      </div>
    </div>
  </section>
</template>
