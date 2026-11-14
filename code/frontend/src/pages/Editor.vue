<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import TopBar from '../components/app/TopBar.vue'
import Sidebar from '../components/app/Sidebar.vue'
import Toolbar from '../components/editor/Toolbar.vue'
import SheetView from '../components/editor/SheetView.vue'
import PdfPages from '../components/editor/PdfPages.vue'
import AppButton from '../components/ui/AppButton.vue'
import AppIcon from '../components/ui/AppIcon.vue'
import { useFileDrop } from '../components/app/fileDropContext'
import { outlineFromHtml, useWorkspaceStore } from '../stores/workspace'
import { aiPanelOpen } from '../lib/aiPanelState'

/** 富文本编辑区的可访问性属性（contenteditable 只能是 div，用绑定避免静态 role 告警） */
const editorA11y = { role: 'textbox', 'aria-multiline': 'true' } as const

/** 取节点所在的元素：文本节点向上找 parentElement（抽出来避免嵌套三元） */
function elementOf(node: Node | null | undefined): HTMLElement | null {
  if (!node) return null
  return (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null
}

import { formatSize, KIND_EXT } from '../lib/file'
import { downloadOriginal, exportDocument, exportTextCopy } from '../lib/exporter'
import { escapeHtml, htmlToPlainText } from '../lib/markdown'

/* 大纲层级缩进：全部用静态类名，避免在模板里写内联 style 做布局 */
const OUTLINE_INDENT = ['pl-[8px]', 'pl-[20px]', 'pl-[32px]', 'pl-[44px]', 'pl-[56px]', 'pl-[68px]']

function wordCount(plain: string) {
  const text = plain.replace(/\s+/g, '')
  const latin = (plain.match(/[A-Za-z0-9]+/g) ?? []).length
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length
  return { words: latin + cjk, chars: text.length }
}

function unsafeHtml(html: string) {
  return /<script|onerror\s*=|onload\s*=|javascript:/i.test(html)
}

const store = useWorkspaceStore()
const { docs, activeId, loading } = storeToRefs(store)
const { openPicker, busy } = useFileDrop()

const doc = computed(() => docs.value.find((item) => item.id === activeId.value) ?? docs.value[0] ?? null)
const html = computed(() => doc.value?.html ?? '')

const editorRef = ref<HTMLDivElement | null>(null)
const editorScrollRef = ref<HTMLElement | null>(null)

/* ---------------- 虚拟滚动：DOM 只保留一个窗口，上下滚动时双向补块回收 ---------------- */
const BLOCK_CHUNK = 800
const MAX_DOM_BLOCKS = 2400
const INITIAL_WINDOW = 800
const totalBlocks = ref(0)
const windowStart = ref(0)
const windowEnd = ref(0)
let blockSlices: string[] = []
const renderedBlocks = computed(() => Math.max(0, windowEnd.value - windowStart.value))
const activeMarks = ref<Record<string, boolean>>({})
const undoDepth = ref(0)
const redoDepth = ref(0)
const reading = ref(false)
const saving = ref(false)
const outlineOpen = ref(true)

/** 纸面色调：白 / 米 / 暗。纯白长时间看刺眼，浅色指针也会"消失" */
type PaperTone = 'white' | 'soft' | 'dark'
const PAPER_TONES: { id: PaperTone; label: string }[] = [
  { id: 'white', label: '白' },
  { id: 'soft', label: '米' },
  { id: 'dark', label: '暗' },
]
const paperTone = ref<PaperTone>((localStorage.getItem('lo.paperTone') as PaperTone) || 'dark')
const paperClass = computed(() => {
  if (paperTone.value === 'soft') return 'lo-paper-surface lo-paper-soft'
  if (paperTone.value === 'dark') return 'lo-paper-surface lo-paper-dark'
  return 'lo-paper-surface'
})
function cyclePaperTone() {
  const order: PaperTone[] = ['dark', 'soft', 'white']
  const next = order[(order.indexOf(paperTone.value) + 1) % order.length]
  paperTone.value = next
  localStorage.setItem('lo.paperTone', next)
}
// AI 侧栏打开时自动收起大纲：两边各占 248 + 360，正文会被挤得太窄
watch(aiPanelOpen, (open) => {
  if (open) outlineOpen.value = false
})
const filter = ref('')
const unsafeBlocked = ref(false)

/* 撤销 / 重做栈与浏览器原生 execCommand 栈解耦，统一由本组件管理 */
const historyStack = { undo: [] as string[], redo: [] as string[] }
let skipHistory = false
let persistTimer: number | null = null

onMounted(() => {
  if (!docs.value.length && loading.value) void store.hydrate()
  document.addEventListener('selectionchange', refreshMarks)
  syncEditor()
})

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', refreshMarks)
  if (persistTimer) window.clearTimeout(persistTimer)
})

/** 把整篇 HTML 拆成顶层块，供分块渲染与「编辑时只回写已渲染前缀」使用 */
function splitBlocks(html: string): string[] {
  if (!html) return []
  const parsed = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = parsed.getElementById('root')
  if (!root) return []
  const blocks: string[] = []
  root.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      if (text.trim()) blocks.push(`<p>${escapeHtml(text)}</p>`)
      return
    }
    if (node.nodeType !== 1) return
    blocks.push((node as HTMLElement).outerHTML)
  })
  return blocks
}

/** 图片懒解码：进入可视区前不解码，降低大文档首屏成本 */
function markLazyImages(root: HTMLElement) {
  root.querySelectorAll('img').forEach((img) => {
    img.setAttribute('loading', 'lazy')
    img.setAttribute('decoding', 'async')
  })
}

/** 用 blockSlices 的 [windowStart, windowEnd) 重绘 DOM */
function renderWindow() {
  const node = editorRef.value
  if (!node) return
  node.innerHTML = blockSlices.slice(windowStart.value, windowEnd.value).join('')
  markLazyImages(node)
}

/** 底部追加：往下滚时把后面的块补进 DOM，并把顶部超出的块回收 */
function appendNextChunk() {
  const node = editorRef.value
  if (!node || windowEnd.value >= blockSlices.length) return
  const nextEnd = Math.min(blockSlices.length, windowEnd.value + BLOCK_CHUNK)
  node.insertAdjacentHTML('beforeend', blockSlices.slice(windowEnd.value, nextEnd).join(''))
  windowEnd.value = nextEnd
  markLazyImages(node)
  recycleTop()
}

/** 顶部回填：往上滚时把前面的块补回来，并把底部超出的块回收 */
function prependPrevChunk() {
  const node = editorRef.value
  const scroller = editorScrollRef.value
  if (!node || !scroller || windowStart.value <= 0) return
  const prevStart = Math.max(0, windowStart.value - BLOCK_CHUNK)
  const before = node.offsetHeight
  node.insertAdjacentHTML('afterbegin', blockSlices.slice(prevStart, windowStart.value).join(''))
  windowStart.value = prevStart
  markLazyImages(node)
  // 保持视口位置不跳：把新增高度补到 scrollTop 上
  scroller.scrollTop += node.offsetHeight - before
  recycleBottom()
}

/** 回收顶部：整批移除并把高度差补回 scrollTop，只触发一次布局 */
function recycleTop() {
  const node = editorRef.value
  const scroller = editorScrollRef.value
  if (!node || !scroller) return
  const overflow = windowEnd.value - windowStart.value - MAX_DOM_BLOCKS
  if (overflow <= 0) return
  const before = scroller.scrollHeight
  const nodes = Array.from(node.children).slice(0, overflow)
  for (const child of nodes) child.remove()
  windowStart.value += overflow
  scroller.scrollTop -= before - scroller.scrollHeight
}

/** 回收底部：同样整批移除 */
function recycleBottom() {
  const node = editorRef.value
  if (!node) return
  const overflow = windowEnd.value - windowStart.value - MAX_DOM_BLOCKS
  if (overflow <= 0) return
  const nodes = Array.from(node.children).slice(-overflow)
  for (const child of nodes) child.remove()
  windowEnd.value -= overflow
}

/** 切换文档时装载窗口头部 */
function syncEditor() {
  const node = editorRef.value
  unsafeBlocked.value = false
  historyStack.undo = []
  historyStack.redo = []
  undoDepth.value = 0
  redoDepth.value = 0
  if (!node) return
  const next = doc.value?.html ?? ''
  blockSlices = splitBlocks(next)
  totalBlocks.value = blockSlices.length
  windowStart.value = 0
  windowEnd.value = Math.min(blockSlices.length, INITIAL_WINDOW)
  renderWindow()
  if (editorScrollRef.value) editorScrollRef.value.scrollTop = 0
}

watch(
  () => doc.value?.id,
  () => syncEditor(),
  { flush: 'post' },
)

/** 滚到接近底部/顶部时继续加载，保证任意位置都能滚到（内容 100% 可访问） */
function onEditorScroll() {
  const scroller = editorScrollRef.value
  if (!scroller) return
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 800) appendNextChunk()
  else if (scroller.scrollTop < 400) prependPrevChunk()
}

/** 只把已渲染的窗口写回 blockSlices，窗口外的内容原样保留 */
function syncRenderedPrefix() {
  const node = editorRef.value
  if (!node) return
  const serialized = Array.from(node.children).map((child) => (child as HTMLElement).outerHTML)
  const end = windowStart.value + serialized.length
  blockSlices = [...blockSlices.slice(0, windowStart.value), ...serialized, ...blockSlices.slice(end)]
  windowEnd.value = end
}

function refreshMarks() {
  if (typeof document === 'undefined') return
  const select = document.getSelection()
  const node = editorRef.value
  let inEditor = false
  if (select && select.anchorNode && node) inEditor = node.contains(select.anchorNode)
  if (!inEditor) {
    activeMarks.value = {}
    return
  }
  const block = (format: string) => {
    try {
      return document.queryCommandState(format)
    } catch {
      return false
    }
  }
  const anchorEl = select?.anchorNode && node ? elementOf(select.anchorNode) : null
  const blockName = anchorEl?.closest('h1, h2, p, pre, blockquote, li')?.tagName.toLowerCase() ?? ''
  activeMarks.value = {
    bold: block('bold'),
    italic: block('italic'),
    underline: block('underline'),
    ul: block('insertUnorderedList'),
    ol: block('insertOrderedList'),
    h1: blockName === 'h1',
    h2: blockName === 'h2',
    p: blockName === 'p',
    pre: blockName === 'pre',
    quote: blockName === 'blockquote',
  }
}

function persistNow(nextHtml: string, dirty = true) {
  if (!doc.value) return
  store.updateDoc(doc.value.id, { html: nextHtml, dirty })
}

function onInput() {
  const node = editorRef.value
  if (!node || !doc.value) return
  syncRenderedPrefix()
  const nextHtml = blockSlices.join('')
  if (!skipHistory) {
    historyStack.undo.push(doc.value.html)
    if (historyStack.undo.length > 80) historyStack.undo.shift()
    historyStack.redo = []
    undoDepth.value = historyStack.undo.length
    redoDepth.value = 0
  }
  skipHistory = false
  persistNow(nextHtml, nextHtml !== doc.value.originalHtml)
  if (persistTimer) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => refreshMarks(), 120)
}

/** 无选区时把光标放入编辑区，保证工具栏命令可用 */
function ensureSelection() {
  const node = editorRef.value
  if (!node) return
  const select = document.getSelection()
  if (select && select.anchorNode && node.contains(select.anchorNode)) return
  node.focus()
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(false)
  select?.removeAllRanges()
  select?.addRange(range)
}

function applyHtml(nextHtml: string) {
  const node = editorRef.value
  if (!node) return
  blockSlices = splitBlocks(nextHtml)
  totalBlocks.value = blockSlices.length
  windowStart.value = 0
  windowEnd.value = Math.min(blockSlices.length, MAX_DOM_BLOCKS)
  renderWindow()
  persistNow(nextHtml, nextHtml !== (doc.value?.originalHtml ?? ''))
}

/**
 * 编辑器键盘快捷键：Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z（或 Ctrl+Y）重做。
 * 走自家的 historyStack，而不是浏览器原生撤销——否则 AI 一键替换这类
 * 程序化改动，原生撤销栈和我们的快照会对不上。
 */
function onEditorKeydown(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey
  if (!mod) return
  const key = event.key.toLowerCase()
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    onCommand('undo')
  } else if ((key === 'z' && event.shiftKey) || key === 'y') {
    event.preventDefault()
    onCommand('redo')
  }
}

/**
 * 点正文里的问题标记 → 通知右侧面板高亮对应建议（双向跳转）。
 * 标记上带 data-issue-badge，值就是建议序号。
 */
function onEditorClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const mark = target?.closest('.lo-issue-mark') as HTMLElement | null
  if (!mark) return
  const badge = mark.getAttribute('data-issue-badge')
  if (!badge) return
  window.dispatchEvent(new CustomEvent('lo:issue-focus', { detail: { badge: Number(badge) } }))
}

function onCommand(command: string) {
  if (!doc.value) return
  if (command === 'undo') {
    const prev = historyStack.undo.pop()
    if (prev === undefined) return
    historyStack.redo.push(doc.value.html)
    undoDepth.value = historyStack.undo.length
    redoDepth.value = historyStack.redo.length
    skipHistory = true
    applyHtml(prev)
    return
  }
  if (command === 'redo') {
    const next = historyStack.redo.pop()
    if (next === undefined) return
    historyStack.undo.push(doc.value.html)
    undoDepth.value = historyStack.undo.length
    redoDepth.value = historyStack.redo.length
    skipHistory = true
    applyHtml(next)
    return
  }
  ensureSelection()
  const before = doc.value.html
  try {
    switch (command) {
      case 'bold':
        document.execCommand('bold')
        break
      case 'italic':
        document.execCommand('italic')
        break
      case 'underline':
        document.execCommand('underline')
        break
      case 'ul':
        document.execCommand('insertUnorderedList')
        break
      case 'ol':
        document.execCommand('insertOrderedList')
        break
      case 'h1':
        document.execCommand('formatBlock', false, 'h1')
        break
      case 'h2':
        document.execCommand('formatBlock', false, 'h2')
        break
      case 'p':
        document.execCommand('formatBlock', false, 'p')
        break
      case 'quote':
        document.execCommand('formatBlock', false, 'blockquote')
        break
      case 'pre':
        document.execCommand('formatBlock', false, 'pre')
        break
      case 'hr':
        document.execCommand('insertHorizontalRule')
        break
      default:
        return
    }
  } catch {
    store.addToast({ title: '该操作在当前选区不可用', tone: 'warning' })
    return
  }
  const node = editorRef.value
  if (!node) return
  const nextHtml = node.innerHTML
  historyStack.undo.push(before)
  if (historyStack.undo.length > 80) historyStack.undo.shift()
  historyStack.redo = []
  undoDepth.value = historyStack.undo.length
  redoDepth.value = 0
  persistNow(nextHtml, nextHtml !== doc.value.originalHtml)
  refreshMarks()
}

function onPaste(event: ClipboardEvent) {
  const htmlData = event.clipboardData?.getData('text/html') ?? ''
  if (htmlData && unsafeHtml(htmlData)) {
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    document.execCommand('insertText', false, text)
    unsafeBlocked.value = true
    store.addToast({ title: '已拦截不可信 HTML 粘贴', description: '已改为只插入纯文本，确保脚本不会执行', tone: 'warning' })
  }
}

async function handleSave() {
  if (!doc.value) {
    store.addToast({ title: '还没有打开文件', description: '请先在首页打开一个文档', tone: 'info' })
    return
  }
  saving.value = true
  try {
    const result = await exportDocument(doc.value)
    store.addToast({
      title: result.ok ? '已准备下载' : '保存提示',
      description: result.message,
      tone: result.ok ? 'success' : 'warning',
    })
    if (result.ok && result.details?.length) {
      store.addToast({ title: '导出自检通过', description: result.details.join(' · '), tone: 'info' })
    }
    if (result.ok && doc.value) store.updateDoc(doc.value.id, { dirty: false })
  } finally {
    saving.value = false
  }
}

function handleOriginal() {
  if (!doc.value) return
  const result = downloadOriginal(doc.value)
  store.addToast({
    title: result.ok ? '已下载原始文件' : '无法下载',
    description: result.message,
    tone: result.ok ? 'success' : 'warning',
  })
}

function handleRemove(id: string) {
  void store.removeDoc(id)
  store.addToast({ title: '已从会话中移除', description: '原始文件未上传到任何服务器', tone: 'info' })
}

function handleReserved(target: string) {
  store.addToast({
    title: target === '云端工作区' ? '云端工作区正在开发中，目前请使用本地安全模式' : `${target}正在开发中`,
    description: '本地文档仍保持选中',
    tone: 'info',
  })
}

function handleTextCopy() {
  if (!doc.value) return
  const result = exportTextCopy(doc.value, 'txt')
  store.addToast({
    title: result.ok ? '已导出文本副本' : '导出失败',
    description: result.message,
    tone: result.ok ? 'success' : 'warning',
  })
}

/* 大纲与字数基于 DOM 解析，10 MB 文档要几百毫秒：延后计算，先把正文画出来 */
const statsHtml = ref('')
let statsTimer: number | null = null
watch(
  html,
  (value) => {
    if (statsTimer) window.clearTimeout(statsTimer)
    statsTimer = window.setTimeout(() => {
      statsHtml.value = value
    }, 250)
  },
  { immediate: true },
)
const outline = computed(() => outlineFromHtml(statsHtml.value))
const plain = computed(() => htmlToPlainText(statsHtml.value))
const stats = computed(() => wordCount(plain.value))
const filteredOutline = computed(() =>
  outline.value.filter((item) => !filter.value.trim() || item.text.includes(filter.value.trim())),
)

function jumpToHeading(index: number) {
  const node = editorRef.value
  if (!node) return
  const heading = node.querySelectorAll('h1,h2,h3,h4,h5,h6')[index]
  if (heading) heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const isMarkdown = computed(() => doc.value?.kind === 'md')
const isSheet = computed(() => doc.value?.kind === 'xlsx')
const isBinaryText = computed(() => doc.value?.kind === 'pptx' || doc.value?.kind === 'pdf')
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden text-[#F5F5F7]">
    <TopBar :saving="saving" @save="handleSave" />

    <div class="flex min-h-0 flex-1">
      <Sidebar
        :active-id="doc?.id ?? null"
        variant="editor"
        @select="store.setActive($event)"
        @remove="handleRemove"
        @reserved="handleReserved"
      />

      <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div v-if="!doc" class="flex flex-1 items-center justify-center p-8">
          <div class="lo-card max-w-md p-8 text-center">
            <span class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0A84FF]/15">
              <AppIcon name="file-text" class="h-6 w-6 text-[#0A84FF]" :stroke-width="1.7" />
            </span>
            <h1 class="mt-4 text-[18px] font-semibold text-[#F5F5F7]">编辑器还没有内容</h1>
            <p class="mt-2 text-[13px] leading-relaxed text-[#A1A1A6]">
              先打开一个本机文件，左侧会话列表会显示真实文件名与大小，切换文件时内容不会互相串。
            </p>
            <div class="mt-5 flex items-center justify-center gap-2">
              <AppButton variant="primary" size="md" :disabled="busy" @click="openPicker">打开文件</AppButton>
              <RouterLink to="/" class="lo-btn lo-btn-secondary lo-btn-md lo-press">返回首页</RouterLink>
            </div>
          </div>
        </div>

        <template v-else>
          <!-- 文档头 -->
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
            <div class="flex min-w-0 items-center gap-2.5">
              <span
                class="flex h-7 w-9 shrink-0 items-center justify-center rounded-md bg-white/[0.08] text-[9px] font-bold text-[#C7C7CC]"
              >
                {{ KIND_EXT[doc.kind] }}
              </span>
              <span class="min-w-0">
                <span class="flex items-center gap-2">
                  <span class="truncate text-[13.5px] font-medium text-[#F5F5F7]" :title="doc.name">{{ doc.name }}</span>
                  <span
                    class="shrink-0 rounded px-1.5 py-0.5 text-[10.5px]"
                    :class="doc.dirty ? 'bg-[#FF9F0A]/15 text-[#FFB340]' : 'bg-[#30D158]/15 text-[#5CE07E]'"
                  >
                    {{ doc.dirty ? '未保存' : '已同步' }}
                  </span>
                </span>
                <span class="block text-[11px] tabular-nums text-[#636366]">
                  {{ formatSize(doc.size) }}
                  <template v-if="doc.paragraphCount"> · {{ doc.paragraphCount }} 段</template>
                  <template v-if="doc.encoding"> · {{ doc.encoding.toUpperCase() }}</template>
                  <template v-if="doc.sheets"> · {{ doc.sheets.length }} 个工作表</template>
                  <template v-if="doc.pdfPageCount"> · {{ doc.pdfPageCount }} 页</template>
                </span>
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <AppButton
                size="sm"
                :variant="reading ? 'primary' : 'secondary'"
                @click="reading = !reading"
              >
                <AppIcon name="eye" class="h-3.5 w-3.5" />
                {{ reading ? '退出阅读' : '阅读模式' }}
              </AppButton>
              <AppButton size="sm" variant="secondary" @click="outlineOpen = !outlineOpen">
                <AppIcon name="columns-3" class="h-3.5 w-3.5" />
                大纲
              </AppButton>
              <AppButton
                size="sm"
                variant="secondary"
                :title="`纸面色调：${PAPER_TONES.find((t) => t.id === paperTone)?.label}（点击切换 白/米/暗）`"
                @click="cyclePaperTone()"
              >
                <AppIcon name="file-text" class="h-3.5 w-3.5" />
                {{ PAPER_TONES.find((t) => t.id === paperTone)?.label }}
              </AppButton>
              <AppButton size="sm" variant="secondary" :disabled="saving" @click="handleSave">
                <AppIcon name="save" class="h-3.5 w-3.5" />
                保存下载
              </AppButton>
              <template v-if="isBinaryText">
                <AppButton size="sm" variant="secondary" @click="handleTextCopy">
                  <AppIcon name="file-down" class="h-3.5 w-3.5" />
                  文本副本
                </AppButton>
                <AppButton size="sm" variant="secondary" @click="handleOriginal">
                  <AppIcon name="download" class="h-3.5 w-3.5" />
                  原始文件
                </AppButton>
              </template>
              <AppButton size="sm" variant="secondary" @click="store.resetDoc(doc.id)">
                <AppIcon name="undo-2" class="h-3.5 w-3.5" />
                重置编辑
              </AppButton>
            </div>
          </div>

          <div
            v-if="doc.warnings.length > 0"
            class="flex flex-wrap items-center gap-2 border-b border-[#FF9F0A]/15 bg-[#FF9F0A]/[0.06] px-4 py-2 text-[12px] text-[#FFB340]"
          >
            <AppIcon name="alert-triangle" class="h-3.5 w-3.5 shrink-0" />
            <span>{{ doc.warnings.join('；') }}</span>
          </div>

          <div
            v-if="isBinaryText || doc.kind === 'unknown'"
            class="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-white/[0.03] px-4 py-2 text-[12px] text-[#A1A1A6]"
          >
            <AppIcon name="shield-alert" class="h-3.5 w-3.5 shrink-0 text-[#FF9F0A]" />
            该格式暂不支持回写编辑结果，可导出文本副本或下载原始文件。
          </div>

          <div
            v-if="doc.pdfError"
            class="flex flex-wrap items-center gap-2 border-b border-[#FF453A]/20 bg-[#FF453A]/[0.07] px-4 py-2 text-[12px] text-[#FF6961]"
          >
            <AppIcon name="shield-alert" class="h-3.5 w-3.5 shrink-0" />
            <span>{{ doc.pdfError }}</span>
            <span class="text-[#A1A1A6]">· 文本未提取，页面仍可查看；可下载原始文件</span>
          </div>

          <div
            v-if="unsafeBlocked"
            class="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-white/[0.03] px-4 py-2 text-[12px] text-[#A1A1A6]"
          >
            <AppIcon name="file-warning" class="h-3.5 w-3.5 shrink-0 text-[#FF9F0A]" />
            部分粘贴内容包含不可信 HTML，已降级为纯文本插入。
          </div>

          <div class="flex min-h-0 flex-1">
            <div v-if="isSheet" class="flex min-w-0 flex-1 flex-col">
              <div class="flex items-center gap-2 border-b border-white/[0.06] bg-[#242426] px-4 py-2 text-[12px] text-[#A1A1A6]">
                <AppIcon name="table-2" class="h-3.5 w-3.5 text-[#30D158]" />
                单元格可直接编辑，保存下载会用 SheetJS 回写并保留工作表名
              </div>
              <SheetView :doc="doc" />
            </div>

            <div v-else class="flex min-w-0 flex-1 flex-col">
              <Toolbar
                v-if="!reading"
                :disabled="false"
                :active="activeMarks"
                :can-undo="undoDepth > 0"
                :can-redo="redoDepth > 0"
                @command="onCommand"
              />
              <div
                ref="editorScrollRef"
                class="thin-scroll min-h-0 flex-1 overflow-y-auto bg-[#0B0B0C] px-4 py-5"
                @scroll.passive="onEditorScroll"
              >
                <PdfPages v-if="doc.kind === 'pdf'" :key="doc.id" :doc="doc" />
                <div class="mx-auto max-w-[860px]">
                  <div class="rounded-[20px] shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]" :class="paperClass">
                    <div
                      class="flex items-center justify-between gap-3 border-b border-[#EDEDF0] px-8 py-3 text-[11px] text-[#98989D]"
                    >
                      <span class="truncate">{{ doc.name }}</span>
                      <span class="tabular-nums">
                        {{ stats.words }} 词 · {{ stats.chars }} 字
                        <template v-if="totalBlocks > renderedBlocks">
                          · 第 {{ (windowStart + 1).toLocaleString('en-US') }}–{{ windowEnd.toLocaleString('en-US') }} 块 / 共
                          {{ totalBlocks.toLocaleString('en-US') }} 块（滚动继续加载）
                        </template>
                      </span>
                    </div>
                    <div
                      ref="editorRef"
                      v-bind="editorA11y"
                      aria-label="文档编辑区"
                      :contenteditable="!reading"
                      spellcheck="false"
                      data-placeholder="在这里开始输入内容…"
                      class="lo-editor lo-word-wrap min-h-[520px] px-8 py-7 outline-none"
                      :class="reading ? 'cursor-default select-text' : ''"
                      @input="onInput"
                      @keydown="onEditorKeydown"
                      @click="onEditorClick"
                      @paste="onPaste"
                      @keyup="refreshMarks"
                      @mouseup="refreshMarks"
                      @focus="refreshMarks"
                    />
                    <div
                      class="flex flex-wrap items-center justify-between gap-2 border-t border-[#EDEDF0] px-8 py-2.5 text-[11px] text-[#98989D]"
                    >
                      <span>
                        {{
                          isMarkdown
                            ? 'Markdown 已渲染为安全 HTML，脚本与事件属性不会执行'
                            : '内容已在本地解析，导出后会自动回读自检'
                        }}
                      </span>
                      <span class="tabular-nums">
                        <template v-if="doc.paragraphCount">{{ doc.paragraphCount }} 段 · </template>
                        {{ doc.dirty ? '有未保存改动' : '与本地存档一致' }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <aside
              v-if="outlineOpen"
              class="lo-glass hidden w-[248px] shrink-0 flex-col border-l border-white/[0.06] lg:flex"
            >
              <div class="border-b border-white/[0.06] px-4 py-3">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] font-medium text-[#F5F5F7]">文档大纲</span>
                  <div class="flex items-center gap-1.5">
                    <span class="text-[11px] tabular-nums text-[#636366]">{{ outline.length }}</span>
                    <button
                      type="button"
                      aria-label="收起大纲"
                      class="rounded-md p-0.5 text-[#636366] transition-colors hover:text-[#F5F5F7]"
                      @click="outlineOpen = false"
                    >
                      <AppIcon name="x" class="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <label for="outline-filter" class="sr-only">筛选标题</label>
                <input
                  id="outline-filter"
                  v-model="filter"
                  placeholder="筛选标题"
                  class="lo-input mt-2 h-7 w-full px-2 text-[11.5px]"
                />
              </div>
              <div class="thin-scroll min-h-0 flex-1 overflow-y-auto p-2">
                <p v-if="outline.length === 0" class="px-2 py-3 text-[12px] leading-relaxed text-[#636366]">
                  当前文档没有标题层级。选中文本后点工具栏 H1 / H2 即可生成大纲。
                </p>
                <ul v-else class="flex flex-col gap-0.5">
                  <li v-for="item in filteredOutline" :key="item.id">
                    <button
                      type="button"
                      class="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[12px] text-[#C7C7CC] outline-none transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
                      :class="OUTLINE_INDENT[Math.min(item.level, 6) - 1]"
                      @click="jumpToHeading(item.index)"
                    >
                      <AppIcon name="chevron-right" class="h-3 w-3 shrink-0 text-[#636366]" />
                      <span class="truncate">{{ item.text }}</span>
                    </button>
                  </li>
                </ul>
              </div>
              <div class="border-t border-white/[0.06] px-4 py-3 text-[11.5px] leading-relaxed text-[#636366]">
                <p class="flex justify-between">
                  <span>字数</span>
                  <span class="tabular-nums text-[#A1A1A6]">{{ stats.words }}</span>
                </p>
                <p class="mt-1 flex justify-between">
                  <span>字符</span>
                  <span class="tabular-nums text-[#A1A1A6]">{{ stats.chars }}</span>
                </p>
                <p class="mt-1 flex justify-between">
                  <span>撤销栈</span>
                  <span class="tabular-nums text-[#A1A1A6]">{{ undoDepth }}</span>
                </p>
              </div>
            </aside>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>
