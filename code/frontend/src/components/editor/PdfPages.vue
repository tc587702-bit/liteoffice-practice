<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { loadPdfDocument, renderPdfPageToCanvas } from '../../lib/pdf'
import { getPdfDocument } from '../../lib/pdfCache'
import type { DocRecord } from '../../lib/db'
import type { PdfPageInfo } from '../../lib/pdf'

const props = defineProps<{ doc: DocRecord }>()

const pages = ref<PdfPageInfo[]>(props.doc.pdfPages ?? [])
const states = ref<Record<number, 'idle' | 'rendering' | 'done' | 'error'>>({})
const errors = ref<Record<number, string>>({})

const hosts = new Map<number, HTMLElement>()
let pdfDoc: PDFDocumentProxy | null = null
let owned = false
let observer: IntersectionObserver | null = null

function setHost(index: number, el: Element | null) {
  if (el instanceof HTMLElement) hosts.set(index, el)
  else hosts.delete(index)
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

async function renderPage(index: number) {
  if (states.value[index] === 'rendering' || states.value[index] === 'done') return
  const host = hosts.get(index)
  if (!host) return
  states.value = { ...states.value, [index]: 'rendering' }
  try {
    const doc = await ensureDoc()
    const canvas = document.createElement('canvas')
    canvas.className = 'block h-auto w-full bg-white'
    host.replaceChildren(canvas)
    await renderPdfPageToCanvas(doc, index, canvas, host.clientWidth || 640)
    states.value = { ...states.value, [index]: 'done' }
  } catch (error) {
    states.value = { ...states.value, [index]: 'error' }
    errors.value = { ...errors.value, [index]: (error as Error).message }
  }
}

function aspectOf(page: PdfPageInfo) {
  if (!page.width || !page.height) return '1 / 1.414'
  return `${page.width} / ${page.height}`
}

onMounted(async () => {
  if (!pages.value.length) return
  try {
    await ensureDoc()
  } catch (error) {
    errors.value = { ...errors.value, 1: (error as Error).message }
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const index = Number((entry.target as HTMLElement).dataset.page)
        if (index) void renderPage(index)
      }
    },
    { rootMargin: '320px 0px' },
  )
  hosts.forEach((host) => observer?.observe(host))
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  hosts.clear()
  if (owned && pdfDoc) void pdfDoc.destroy().catch(() => undefined)
})
</script>

<template>
  <section v-if="pages.length" class="mx-auto mb-5 w-full max-w-[860px]">
    <div class="mb-2 flex items-center justify-between gap-3 text-[11.5px] text-[#636366]">
      <span>PDF 页面 · 按需渲染（仅渲染可见页）</span>
      <span class="tabular-nums">共 {{ pages.length }} 页</span>
    </div>
    <div class="flex flex-col gap-4">
      <div v-for="page in pages" :key="page.index" class="relative">
        <div
          class="relative overflow-hidden rounded-[8px] bg-[#E9E9EC] shadow-[0_18px_40px_-24px_rgba(0,0,0,0.9)]"
          :style="{ aspectRatio: aspectOf(page) }"
        >
          <div :ref="(el) => setHost(page.index, el as Element | null)" :data-page="page.index" class="absolute inset-0" />
          <div
            v-if="states[page.index] !== 'done'"
            class="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-[12px] text-[#636366]"
          >
            <span v-if="states[page.index] === 'error'" class="text-[#B3261E]">{{ errors[page.index] }}</span>
            <span v-else>第 {{ page.index }} 页渲染中…</span>
          </div>
        </div>
        <span
          class="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white/85"
        >
          {{ page.index }} / {{ pages.length }}
        </span>
      </div>
    </div>
  </section>
</template>
