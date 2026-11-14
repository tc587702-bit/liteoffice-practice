<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../../stores/workspace'
import { aiPanelOpen, closeAiPanel } from '../../lib/aiPanelState'
import { AgentError, runAgent, type AgentRunResult } from '../../lib/agentClient'
import AppIcon from '../ui/AppIcon.vue'
import DocCheckReport from './DocCheckReport.vue'
import { checkDocument, type ImproveReport } from '../../lib/improveClient'
import {
  applyIssueMarks,
  clearAllMarks,
  currentSelection,
  markRefs,
  markRefParagraphs,
  type SelectionInfo,
} from '../../lib/issueMarks'
import { askKb, rewriteSelection, type KbCitation } from '../../lib/kbClient'
import { diffChars, summarizeDiff, type DiffSegment } from '../../lib/diff'
import { captureRange, rangeAlive, replaceRange, replaceSelection, restoreRange } from '../../lib/editorEdit'
import { mdSourceActive } from '../../lib/editorViewMode'

/**
 * AI 助手浮层（懒加载 chunk）。
 * 只读当前文档的 HTML 发给后端，绝不写文档 / 不压撤销栈。
 */

interface Turn {
  id: number
  question: string
  status: 'loading' | 'done' | 'error' | 'cancelled'
  result?: AgentRunResult
  error?: { message: string; retryable: boolean }
  seconds: number
  /** agent = ReAct；kb = 知识库问答（双源）；rewrite = 专业改写 */
  mode?: 'agent' | 'kb' | 'rewrite'
  kbAnswer?: string
  citations?: KbCitation[]
  candidate?: string
  /** 改写前的原文（用于 diff 对比） */
  source?: string
  /** 生成时保存的选区范围；用户中途点别处也不会替换错位置 */
  range?: Range | null
  changes?: { type: string; from: string; to: string; note?: string }[]
  hint?: string
}

const EXAMPLES = ['这份文档有多少字', '检查一下表格和标题有没有问题', '帮我看看有哪些重复段落']

const PHASE_LABEL: Record<string, string> = { think: '想', act: '做', final: '答' }

const store = useWorkspaceStore()
const { activeDoc } = storeToRefs(store)

const turns = ref<Turn[]>([])
const draft = ref('')
const notice = ref('')
const busy = ref(false)
const checking = ref(false)
const report = ref<ImproveReport | null>(null)
const checkError = ref('')
const selection = ref<SelectionInfo | null>(null)
/** 侧栏三档：问答 / 检查 / 改写 */
type PanelTab = 'chat' | 'check' | 'rewrite'
// 首次打开直接落在「检查」：这是最能让新用户立刻看到价值的入口
const tab = ref<PanelTab>('check')
const TABS: { id: PanelTab; label: string }[] = [
  { id: 'chat', label: '问答' },
  { id: 'check', label: '检查' },
  { id: 'rewrite', label: '改写' },
]
/** 改写用的文体（空=自动判定） */
const genre = ref('')
const GENRES = [
  { v: '', label: '自动判定' },
  { v: 'gongwen', label: '公文' },
  { v: 'lab', label: '实验报告' },
  { v: 'thesis', label: '论文' },
  { v: 'expository', label: '说明文' },
]
/** 正文里当前标了多少处 */
const marked = ref(0)
let noticeTimer: number | null = null
function flashNotice(text: string) {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 4000)
}

function clearMarks() {
  clearAllMarks()
  marked.value = 0
}
/** 会话 id：同一份文档同一 id，供后端做跨轮指代消解（T7） */
const sessionId = computed(() => (activeDoc.value ? `doc-${activeDoc.value.id ?? activeDoc.value.name}` : ''))

function refreshSelection() {
  selection.value = currentSelection()
}

/** 问知识库：把当前文档一起送过去，做「本文 vs 规范」的双源对照（T5） */
async function askKnowledgeBase() {
  const question = draft.value.trim() || '本文的写法是否符合规范要求？'
  if (!activeDoc.value || busy.value || inFlight) return
  notice.value = ''
  busy.value = true
  inFlight = true
  const turn: Turn = { id: ++seed, question: `知识库：${question}`, status: 'loading', seconds: 0, mode: 'kb' }
  turns.value = [...turns.value, turn]
  draft.value = ''
  scrollToBottom()
  const local = new AbortController()
  controller = local
  ticker = window.setInterval(() => {
    turn.seconds += 1
  }, 1000)
  try {
    const res = await askKb(question, activeDoc.value.html ?? '')
    turn.kbAnswer = res.answer
    turn.citations = res.citations
    turn.hint = res.mock ? '后端未配置模型，本条由本地规则抽取（不代表模型观点）' : ''
    turn.status = 'done'
  } catch (error) {
    turn.status = 'error'
    turn.error = { message: (error as Error).message || '知识库请求失败', retryable: true }
  } finally {
    inFlight = false
    stopWaiting()
    busy.value = false
    scrollToBottom()
  }
}

/** 专业改写：用当前选区 + 前后文（T6） */
async function rewriteCurrentSelection() {
  const sel = selection.value ?? currentSelection()
  const savedRange = captureRange()
  if (!activeDoc.value || busy.value || inFlight) return
  if (!sel || sel.text.length < 10) {
    notice.value = '请先在正文里选中要改写的段落（至少 10 字）'
    return
  }
  notice.value = ''
  busy.value = true
  inFlight = true
  const turn: Turn = {
    id: ++seed,
    question: `改写选区：${sel.text.slice(0, 30)}…`,
    status: 'loading',
    seconds: 0,
    mode: 'rewrite',
    source: sel.text,
    range: savedRange,
  }
  turns.value = [...turns.value, turn]
  scrollToBottom()
  const local = new AbortController()
  controller = local
  ticker = window.setInterval(() => {
    turn.seconds += 1
  }, 1000)
  try {
    const res = await rewriteSelection(sel.text, { context: sel.context, genre: genre.value || undefined })
    if (!res.ok) {
      turn.status = 'error'
      turn.error = { message: res.reason || '改写被拒绝', retryable: false }
    } else {
      turn.candidate = res.candidate ?? ''
      turn.changes = res.changes ?? []
      turn.hint = [res.genreLabel ? `文体：${res.genreLabel}` : '', res.mock ? '离线模拟' : ''].filter(Boolean).join(' · ')
      turn.status = 'done'
    }
  } catch (error) {
    turn.status = 'error'
    turn.error = { message: (error as Error).message || '改写失败', retryable: true }
  } finally {
    inFlight = false
    stopWaiting()
    busy.value = false
    scrollToBottom()
  }
}

/** 当前选区的 diff 片段（原文 vs 改写） */
function diffOf(turn: Turn): DiffSegment[] {
  if (!turn.source || turn.candidate === undefined) return []
  return diffChars(turn.source, turn.candidate)
}

function diffStat(turn: Turn): { added: number; removed: number } {
  return summarizeDiff(diffOf(turn))
}

/** 一键替换：把改写结果写回正文当前选区（进撤销栈） */
function applyRewrite(turn: Turn) {
  if (turn.candidate === undefined) return

  // ① 优先用「生成时」的那段范围：用户中途点了别处也能替换对位置
  let res: { ok: boolean; message: string }
  if (rangeAlive(turn.range ?? null) && turn.range) {
    restoreRange(turn.range)
    res = replaceRange(turn.range, turn.candidate)
  } else {
    // ② 兜底：用当前选区（Range 已失效时）
    res = replaceSelection(turn.candidate)
    if (!res.ok) {
      res = { ok: false, message: '原文位置已变化，请重新选中要替换的段落后再改写' }
    }
  }

  flashNotice(res.message)
  if (res.ok) {
    marked.value = 0
    turn.range = null
    selection.value = currentSelection()
  }
}

async function copyCandidate(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notice.value = '已复制到剪贴板，可手动粘贴替换（助手不会直接改正文）'
  } catch {
    notice.value = '复制失败，请手动选择文本复制'
  }
}

/** 检查当前文档：不调模型，纯规则分析，秒回 */
async function checkDoc() {
  if (!activeDoc.value || checking.value) return
  checking.value = true
  checkError.value = ''
  try {
    report.value = await checkDocument(activeDoc.value.html ?? '')
    marked.value = applyIssueMarks(report.value)
  } catch (e) {
    checkError.value = (e as Error).message || '检查失败'
    report.value = null
  } finally {
    checking.value = false
  }
}
const offline = ref(typeof navigator !== 'undefined' ? !navigator.onLine : false)
const listRef = ref<HTMLElement | null>(null)

let seed = 0
let controller: AbortController | null = null
let ticker: number | null = null

/**
 * 模块级在途锁（非响应式）：不依赖渲染时机，双击 / 连点 / 重复挂载 / 组件重建
 * 都只会跑出一次 POST /v1/agent/run。
 */
let inFlight = false
let lastSentKey = ''
let lastSentAt = 0
const DEDUPE_MS = 1500

function requestKey(htmlLength: number, question: string) {
  return question + '::' + String(htmlLength)
}

const canSend = computed(() => draft.value.trim().length > 0 && !busy.value)

function scrollToBottom() {
  void nextTick(() => {
    const el = listRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function updateOnline() {
  offline.value = !navigator.onLine
}

onMounted(() => {
  window.addEventListener('online', updateOnline)
  window.addEventListener('offline', updateOnline)
  document.addEventListener('selectionchange', refreshSelection)
})

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', refreshSelection)
})

onBeforeUnmount(() => {
  window.removeEventListener('online', updateOnline)
  window.removeEventListener('offline', updateOnline)
  stopWaiting()
})

function stopWaiting() {
  if (ticker) {
    window.clearInterval(ticker)
    ticker = null
  }
  if (controller) {
    controller.abort()
    controller = null
  }
}

async function send(text: string, options: { retry?: boolean } = {}) {
  const question = text.trim()
  if (!question) return
  // 双保险：模块级锁 + 响应式 busy，任一在途都直接丢弃这次点击
  if (inFlight || busy.value) return
  if (!activeDoc.value) {
    notice.value = '请先打开一份文档'
    return
  }
  const html = activeDoc.value.html ?? ''
  const key = requestKey(html.length, question)
  const now = Date.now()
  // 同文档同问题 1.5 秒内只发一次（双击、Enter+点击、重试抖动都拦在这里）
  if (!options.retry && key === lastSentKey && now - lastSentAt < DEDUPE_MS) return
  notice.value = ''
  inFlight = true
  lastSentKey = key
  lastSentAt = now

  const turn: Turn = { id: ++seed, question, status: 'loading', seconds: 0, mode: 'agent' }
  turns.value = [...turns.value, turn]
  draft.value = ''
  busy.value = true
  scrollToBottom()

  const local = new AbortController()
  controller = local
  ticker = window.setInterval(() => {
    turn.seconds += 1
  }, 1000)

  try {
    const sel = currentSelection()
    selection.value = sel
    const result = await runAgent(html, question, {
      signal: local.signal,
      selection: sel?.text ?? '',
      selectionAnchor: sel?.block ?? null,
      sessionId: sessionId.value,
    })
    turn.result = result
    turn.status = 'done'
    if (result.refs.length) {
      marked.value = markRefParagraphs(result.refs.map((r) => r.para))
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError' && !(error instanceof AgentError)) {
      turn.status = 'cancelled'
    } else {
      const err = error as AgentError
      turn.status = 'error'
      turn.error = {
        message: err?.message || '请求失败',
        retryable: err?.kind === 'timeout' || err?.kind === 'http5xx' || err?.kind === 'offline',
      }
    }
  } finally {
    inFlight = false
    if (ticker) {
      window.clearInterval(ticker)
      ticker = null
    }
    controller = null
    busy.value = false
    scrollToBottom()
  }
}

function cancel() {
  const current = turns.value[turns.value.length - 1]
  if (!busy.value) return
  controller?.abort()
  controller = null
  if (ticker) {
    window.clearInterval(ticker)
    ticker = null
  }
  if (current) current.status = 'cancelled'
  busy.value = false
}

function retry(turn: Turn) {
  // 重试是显式意图，允许绕过 1.5 秒去重（但仍在途锁保护下）
  void send(turn.question, { retry: true })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    if (canSend.value) void send(draft.value)
  }
}

watch(aiPanelOpen, (open) => {
  if (open) {
    notice.value = ''
    scrollToBottom()
  }
})
</script>

<template>
  <div>
    <!-- 面板（入口在左侧导航「AI 助手」，这里不再放悬浮按钮） -->
    <section
      v-if="aiPanelOpen"
      aria-label="AI 助手"
      class="lo-glass z-30 flex h-full w-[360px] shrink-0 flex-col overflow-hidden border-l border-white/[0.06]"
    >
      <header class="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span class="flex h-7 w-7 items-center justify-center rounded-[9px] bg-[#0A84FF]/15">
          <AppIcon name="sparkles" class="h-4 w-4 text-[#0A84FF]" :stroke-width="1.8" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] font-semibold text-[#F5F5F7]">AI 助手</p>
          <p class="truncate text-[11px] text-[#636366]">
            {{ activeDoc ? `当前文档：${activeDoc.name}` : '还没有打开文档' }}
          </p>
        </div>
        <button
          type="button"
          class="rounded-full border border-white/[0.08] px-2 py-1 text-[11px] text-[#A1A1A6] transition-colors hover:bg-white/[0.06] hover:text-[#F5F5F7] disabled:opacity-40"
          :disabled="!activeDoc || checking"
          @click="checkDoc()"
        >
          {{ checking ? '检查中…' : '检查' }}
        </button>
        <button
          v-if="marked > 0"
          type="button"
          class="rounded-full border border-white/[0.08] px-2 py-1 text-[11px] text-[#98989D] transition-colors hover:bg-white/[0.06] hover:text-[#F5F5F7]"
          :title="`正文里已标 ${marked} 处，点击清除`"
          @click="clearMarks()"
        >
          清除标记
        </button>
        <button
          type="button"
          aria-label="关闭 AI 助手"
          class="rounded-md p-1 text-[#636366] transition-colors hover:text-[#F5F5F7]"
          @click="closeAiPanel()"
        >
          <AppIcon name="x" class="h-4 w-4" />
        </button>
      </header>

      <p
        v-if="offline"
        class="shrink-0 border-b border-[#FF9F0A]/20 bg-[#FF9F0A]/[0.08] px-4 py-2 text-[11px] leading-relaxed text-[#FFB340]"
      >
        当前离线，AI 需联网；本地功能不受影响
      </p>

      <!-- 三档工具栏 -->
      <nav class="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-3 py-1.5">
        <button
          v-for="t in TABS"
          :key="t.id"
          type="button"
          class="rounded-full px-2.5 py-1 text-[11.5px] transition-colors"
          :class="tab === t.id ? 'bg-[#0A84FF]/20 text-[#6FB6FF]' : 'text-[#98989D] hover:bg-white/[0.06] hover:text-[#F5F5F7]'"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
        <span v-if="marked > 0" class="ml-auto text-[10.5px] text-[#30D158]">正文已标 {{ marked }} 处</span>
      </nav>

      <div ref="listRef" class="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <!-- ===== 检查档 ===== -->
        <div v-if="tab === 'check'" class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="lo-press rounded-full bg-[#0A84FF] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
              :disabled="!activeDoc || checking"
              @click="checkDoc()"
            >
              {{ checking ? '检查中…' : report ? '重新检查' : '检查这份文档' }}
            </button>
            <button
              v-if="marked > 0"
              type="button"
              class="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11px] text-[#98989D] hover:text-[#F5F5F7]"
              @click="clearMarks()"
            >
              清除正文标记
            </button>
          </div>
          <p v-if="!report && !checkError" class="text-[12px] leading-relaxed text-[#98989D]">
            检查结构、数据、表达、体例四类问题，结果会直接标在正文里（左侧色条 + 编号）。
          </p>
          <div v-if="checkError" class="rounded-[12px] border border-[#FF453A]/40 bg-[#FF453A]/10 px-3 py-2">
            <p class="text-[12px] text-[#FF8A84]">{{ checkError }}</p>
            <button class="mt-1 text-[11.5px] text-[#0A84FF]" type="button" @click="checkDoc()">重试</button>
          </div>
          <DocCheckReport v-else-if="report" :report="report" />
        </div>

        <!-- ===== 改写档 ===== -->
        <div v-else-if="tab === 'rewrite'" class="flex flex-col gap-3">
          <p v-if="mdSourceActive" class="rounded-[12px] border border-[#FF9F0A]/30 bg-[#FF9F0A]/[0.06] px-3 py-2 text-[12px] leading-relaxed text-[#FFB340]">
            当前是 Markdown 源码模式。源码里没有可划选的正文，切到「预览」后即可选区改写。
          </p>
          <div v-if="selection" class="rounded-[12px] border border-[#30D158]/30 bg-[#30D158]/[0.06] p-3">
            <p class="mb-1 text-[11px] text-[#30D158]">选中的正文（{{ selection.text.length }} 字）</p>
            <p class="max-h-24 overflow-y-auto text-[12px] leading-relaxed text-[#D9D9DE]">{{ selection.text }}</p>
          </div>
          <p v-else class="rounded-[12px] bg-[#1F1F21] px-3 py-2 text-[12px] leading-relaxed text-[#98989D]">
            还没选中正文。到左边文档里划选一段（至少 10 字），这里就会出现内容。
          </p>

          <div class="flex items-center gap-2">
            <span class="text-[11.5px] text-[#636366]">文体</span>
            <select
              v-model="genre"
              class="rounded-[8px] border border-white/[0.08] bg-[#1F1F21] px-2 py-1 text-[11.5px] text-[#F5F5F7] outline-none"
            >
              <option v-for="g in GENRES" :key="g.v" :value="g.v">{{ g.label }}</option>
            </select>
          </div>

          <button
            type="button"
            class="lo-press rounded-full bg-[#0A84FF] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
            :disabled="!selection || busy || mdSourceActive"
            @click="rewriteCurrentSelection()"
          >
            {{ busy ? '生成中…' : '按规范改写这段' }}
          </button>

          <template v-for="turn in turns.filter((t) => t.mode === 'rewrite').slice(-1)" :key="turn.id">
            <div v-if="turn.status === 'loading'" class="text-[12px] text-[#98989D]">正在改写… {{ turn.seconds }} 秒</div>
            <div v-else-if="turn.candidate !== undefined" class="flex flex-col gap-2">
              <!-- diff 对比：红=删，绿=增 -->
              <div class="rounded-[12px] bg-[#1F1F21] p-3">
                <div class="mb-1.5 flex items-center justify-between">
                  <span class="text-[11px] text-[#636366]">改写对比</span>
                  <span class="text-[10.5px] text-[#636366]">
                    删 {{ diffStat(turn).removed }} 字 / 增 {{ diffStat(turn).added }} 字
                  </span>
                </div>
                <p class="whitespace-pre-wrap text-[13px] leading-relaxed text-[#F5F5F7]">
                  <span
                    v-for="(seg, i) in diffOf(turn)"
                    :key="i"
                    :class="
                      seg.type === 'del'
                        ? 'bg-[#FF453A]/20 text-[#FF8A84] line-through'
                        : seg.type === 'ins'
                          ? 'bg-[#30D158]/20 text-[#7BE495]'
                          : ''
                    "
                    >{{ seg.text }}</span
                  >
                </p>
              </div>

              <div v-if="turn.changes?.length" class="flex flex-col gap-1">
                <p class="text-[11px] text-[#636366]">术语/格式改动（{{ turn.changes.length }} 处）</p>
                <p v-for="(c, i) in turn.changes" :key="i" class="text-[11.5px] text-[#98989D]">
                  · {{ c.type }}：{{ c.from }} → {{ c.to }}<span v-if="c.note">（{{ c.note }}）</span>
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="lo-press rounded-full bg-[#0A84FF] px-3 py-1 text-[11.5px] font-medium text-white"
                  @click="applyRewrite(turn)"
                >
                  替换选中
                </button>
                <button
                  type="button"
                  class="rounded-full bg-[#3A3A3C] px-2.5 py-1 text-[11px] text-[#F5F5F7] hover:bg-[#48484A]"
                  @click="copyCandidate(turn.candidate ?? '')"
                >
                  复制
                </button>
                <span class="text-[11px] text-[#636366]">{{ turn.hint }}</span>
              </div>
              <p class="text-[11px] text-[#636366]">替换后可 Ctrl+Z 撤销，不会动其它段落</p>
            </div>
            <p v-else-if="turn.error" class="text-[12px] text-[#FF8A84]">{{ turn.error.message }}</p>
          </template>
        </div>

        <!-- ===== 问答档 ===== -->
        <template v-else>
        <!-- 空状态：3 条示例 -->
        <div v-if="!turns.filter((t) => t.mode !== 'rewrite').length && !report" class="flex flex-col gap-2">
          <p class="text-[12px] leading-relaxed text-[#98989D]">
            想快点看到效果？直接在「检查」档点一下按钮，问题会标在正文左侧，点建议能跳到对应段落。
          </p>
          <button
            v-for="example in EXAMPLES"
            :key="example"
            type="button"
            class="rounded-[12px] bg-[#2C2C2E] px-3 py-2.5 text-left text-[12.5px] text-[#F5F5F7] transition-colors hover:bg-[#3A3A3C] disabled:pointer-events-none disabled:opacity-40"
            :disabled="busy"
            @click="send(example)"
          >
            {{ example }}
          </button>
        </div>

        <!-- 对话 -->
        <div v-for="turn in turns" :key="turn.id" class="mb-3 last:mb-0">
          <p class="mb-2 text-right">
            <span class="inline-block max-w-full rounded-[12px] bg-[#0A84FF]/15 px-3 py-2 text-[12.5px] leading-relaxed text-[#F5F5F7]">
              {{ turn.question }}
            </span>
          </p>

          <!-- 等待态 -->
          <div
            v-if="turn.status === 'loading'"
            class="flex items-center gap-2 rounded-[12px] bg-[#1F1F21] px-3 py-2.5 text-[12px] text-[#98989D]"
          >
            <AppIcon name="loader" class="lo-spin h-3.5 w-3.5 text-[#0A84FF]" :stroke-width="2" />
            <span class="tabular-nums">正在执行… 已等待 {{ turn.seconds }} 秒</span>
            <button
              type="button"
              class="ml-auto rounded-full border border-white/[0.08] px-2 py-0.5 text-[11px] text-[#F5F5F7] hover:bg-white/[0.06]"
              @click="cancel()"
            >
              取消
            </button>
          </div>

          <!-- 已取消 -->
          <p
            v-else-if="turn.status === 'cancelled'"
            class="rounded-[12px] bg-[#1F1F21] px-3 py-2 text-[11.5px] text-[#636366]"
          >
            已取消，本次没有改动文档
          </p>

          <!-- 错误 -->
          <div
            v-else-if="turn.status === 'error'"
            class="rounded-[12px] border border-[#FF453A]/40 bg-[#FF453A]/10 px-3 py-2.5"
          >
            <p class="text-[12px] leading-relaxed text-[#FF6961]">{{ turn.error?.message }}</p>
            <div class="mt-1.5 flex items-center gap-2">
              <button
                v-if="turn.error?.retryable"
                type="button"
                class="rounded-full bg-[#3A3A3C] px-2.5 py-1 text-[11px] text-[#F5F5F7] hover:bg-[#48484A]"
                @click="retry(turn)"
              >
                重试
              </button>
              <span class="text-[11px] text-[#636366]">本地文档未受影响</span>
            </div>
          </div>

          <!-- 知识库问答结果 -->
          <div v-else-if="turn.mode === 'kb' && turn.kbAnswer" class="flex flex-col gap-2">
            <p class="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[#F5F5F7]">{{ turn.kbAnswer }}</p>
            <div v-if="turn.citations?.length" class="flex flex-col gap-1 rounded-[12px] bg-[#1F1F21] p-2.5">
              <p class="text-[11px] text-[#636366]">依据（{{ turn.citations.length }} 条）</p>
              <div v-for="c in turn.citations" :key="c.n" class="flex items-start gap-1.5">
                <span class="shrink-0 rounded-[6px] px-[5px] py-[1px] text-[10.5px] leading-[1.5]"
                  :class="c.source === 'doc' ? 'bg-[#30D158]/15 text-[#30D158]' : 'bg-[#0A84FF]/15 text-[#6FB6FF]'">
                  {{ c.source === 'doc' ? '本文·' + ((c.para ?? 0) + 1) : 'kb·' + c.n }}
                </span>
                <span class="min-w-0 break-words text-[11.5px] leading-relaxed text-[#98989D]">
                  {{ c.source === 'doc' ? '' : '《' + c.doc + '》' }}{{ c.heading || '' }} {{ c.snippet }}
                </span>
              </div>
            </div>
            <p v-if="turn.hint" class="text-[11px] text-[#FFB340]">{{ turn.hint }}</p>
          </div>

          <!-- 改写结果 -->
          <div v-else-if="turn.mode === 'rewrite' && turn.candidate !== undefined" class="flex flex-col gap-2">
            <p class="whitespace-pre-wrap rounded-[12px] bg-[#1F1F21] p-3 text-[13px] leading-relaxed text-[#F5F5F7]">
              {{ turn.candidate }}
            </p>
            <div v-if="turn.changes?.length" class="flex flex-col gap-1">
              <p class="text-[11px] text-[#636366]">改动（{{ turn.changes.length }} 处）</p>
              <p v-for="(c, i) in turn.changes" :key="i" class="text-[11.5px] text-[#98989D]">
                · {{ c.type }}：{{ c.from }} → {{ c.to }}<span v-if="c.note">（{{ c.note }}）</span>
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded-full bg-[#3A3A3C] px-2.5 py-1 text-[11px] text-[#F5F5F7] hover:bg-[#48484A]"
                @click="copyCandidate(turn.candidate ?? '')"
              >
                复制改写结果
              </button>
              <span class="text-[11px] text-[#636366]">{{ turn.hint }}</span>
            </div>
            <p class="text-[11px] text-[#636366]">助手不会改动正文，请确认后手动替换</p>
          </div>

          <!-- Agent 结果 -->
          <div v-else-if="turn.result" class="flex flex-col gap-2">
            <p class="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[#F5F5F7]">{{ turn.result.answer }}</p>

            <div v-if="turn.result.steps.length" class="flex flex-col gap-1 rounded-[12px] bg-[#1F1F21] p-2.5">
              <p class="mb-0.5 text-[11px] text-[#636366]">执行过程（{{ turn.result.steps.length }} 步）</p>
              <div v-for="(step, index) in turn.result.steps" :key="index" class="flex items-start gap-1.5">
                <span
                  class="mt-[1px] shrink-0 rounded-[6px] bg-[#3A3A3C] px-[5px] py-[1px] text-[10.5px] leading-[1.5] text-[#98989D]"
                >
                  {{ PHASE_LABEL[step.phase] ?? step.phase }}
                </span>
                <span class="min-w-0 break-words text-[12px] leading-relaxed text-[#98989D]">{{ step.detail }}</span>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-1.5">
              <span
                v-for="tool in turn.result.toolsUsed"
                :key="tool"
                class="rounded-full bg-[#0A84FF]/15 px-2 py-0.5 text-[11px] text-[#6FB6FF]"
              >
                {{ tool }}
              </span>
              <span
                v-if="turn.result.mock"
                class="rounded-full border border-white/[0.08] px-2 py-0.5 text-[11px] text-[#98989D]"
                title="后端没有配置模型凭据，本次回答由本地规则生成"
              >
                离线模拟
              </span>
            </div>

            <!-- 引用定位：点一下跳到正文对应段落 -->
            <div v-if="turn.result.refs.length" class="flex flex-wrap items-center gap-1.5">
              <span class="text-[11px] text-[#636366]">引用</span>
              <button
                v-for="r in turn.result.refs"
                :key="r.para"
                type="button"
                class="rounded-full bg-[#30D158]/15 px-2 py-0.5 text-[11px] text-[#30D158] hover:bg-[#30D158]/25"
                :title="r.snippet"
                @click="markRefs(r.para)"
              >
                第 {{ r.para + 1 }} 段
              </button>
            </div>
            <p v-else class="text-[11px] leading-relaxed text-[#FFB340]">
              这条回答没有引用到具体段落，请核对原文后再采用。
            </p>
          </div>
        </div>

        </template>

        <!-- 全局提示：三档共用（替换成功、复制失败等） -->
        <p
          v-if="notice"
          class="mt-2 rounded-[12px] border border-[#30D158]/30 bg-[#30D158]/[0.08] px-3 py-2 text-[12px] text-[#7BE495]"
        >
          {{ notice }}
        </p>
      </div>

      <footer v-if="tab === 'chat'" class="shrink-0 border-t border-white/[0.06] p-3">
        <div class="flex items-end gap-2">
          <input
            v-model="draft"
            type="text"
            placeholder="问点关于这份文档的问题…"
            class="h-9 min-w-0 flex-1 rounded-[10px] border border-white/[0.08] bg-[#1F1F21] px-3 text-[12.5px] text-[#F5F5F7] outline-none placeholder:text-[#636366] focus:border-[#0A84FF]/60"
            :disabled="busy"
            @keydown="onKeydown"
          />
          <button
            type="button"
            class="lo-press flex h-9 shrink-0 items-center gap-1 rounded-full bg-[#0A84FF] px-3 text-[12px] font-medium text-white"
            :style="{ opacity: canSend ? 1 : 0.4 }"
            :disabled="!canSend"
            @click="send(draft)"
          >
            发送
          </button>
        </div>
        <p v-if="selection" class="mt-1.5 flex items-center gap-1.5 text-[11px] text-[#30D158]">
          <span class="truncate">已选中 {{ selection.text.length }} 字：{{ selection.text.slice(0, 20) }}…</span>
          <button type="button" class="shrink-0 text-[#636366] hover:text-[#F5F5F7]" @click="selection = null">清除</button>
        </p>
        <div class="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            class="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11px] text-[#A1A1A6] hover:bg-white/[0.06] hover:text-[#F5F5F7] disabled:opacity-40"
            :disabled="busy || !activeDoc"
            @click="askKnowledgeBase()"
          >
            问知识库
          </button>
          <button
            type="button"
            class="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11px] text-[#A1A1A6] hover:bg-white/[0.06] hover:text-[#F5F5F7] disabled:opacity-40"
            :disabled="busy || !selection"
            @click="rewriteCurrentSelection()"
          >
            改写选区
          </button>
        </div>

        <p class="mt-1.5 flex items-center gap-1 text-[11px] text-[#636366]">
          <AppIcon name="lock" class="h-3 w-3 text-[#30D158]" :stroke-width="2" />
          只读取当前文档做分析，不会修改正文
        </p>
      </footer>
    </section>
  </div>
</template>
