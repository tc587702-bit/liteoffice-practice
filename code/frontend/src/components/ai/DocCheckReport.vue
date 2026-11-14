<script setup lang="ts">
/**
 * 文档检查报告（无分数版）
 *
 * 结构：概览一句 → 四个维度状态 → 问题清单（等级/位置/原因/改法）
 * 点击某条问题 → 定位到编辑区对应段落并闪一下
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ImproveReport, ImproveIssue } from '../../lib/improveClient'
import { locateBlock, sendIssueFeedback } from '../../lib/improveClient'

const props = defineProps<{ report: ImproveReport }>()

const dims = computed(() => Object.values(props.report.dims))

/** 只有「可选」的才折叠：必须改/建议改始终展示，避免首屏被噪音淹没 */
const showOptional = ref(false)
const mainIssues = computed(() =>
  props.report.issues
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => it.level !== 'info'),
)
const optionalIssues = computed(() =>
  props.report.issues
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => it.level === 'info'),
)

/** 已判为「不用改」的条目：本地立刻隐藏，同时写入反馈库 */
const hidden = ref<Set<number>>(new Set())

async function dismissIssue(it: ImproveIssue, index: number) {
  const ok = await sendIssueFeedback({
    fingerprint: props.report.fingerprint ?? '',
    rule: it.rule ?? it.problem,
    snippet: it.excerpt || it.problem,
    action: 'dismiss',
    genre: props.report.genre ?? '',
  })
  if (ok) hidden.value = new Set(hidden.value).add(index)
}

function isHidden(index: number) {
  return hidden.value.has(index)
}

const STATUS_TONE: Record<string, string> = {
  没问题: 'text-[#30D158]',
  小问题: 'text-[#A1A1A6]',
  建议改进: 'text-[#FFB340]',
  需返工: 'text-[#FF6961]',
}

const LEVEL_TONE: Record<string, string> = {
  error: 'bg-[#FF453A]/15 text-[#FF8A84] border-[#FF453A]/40',
  warning: 'bg-[#FFB340]/15 text-[#FFC86B] border-[#FFB340]/40',
  info: 'bg-white/[0.06] text-[#A1A1A6] border-white/10',
}

function tone(status: string) {
  return STATUS_TONE[status] ?? 'text-[#A1A1A6]'
}

function levelTone(level: string) {
  return LEVEL_TONE[level] ?? LEVEL_TONE.info
}

function onLocate(block: number | null) {
  if (block === null) return
  locateBlock(block)
}

/** 正文里点了某个标记 → 把对应建议卡片滚到视野内并闪一下 */
function onIssueFocus(event: Event) {
  const badge = Number((event as CustomEvent<{ badge: number }>).detail?.badge)
  if (!Number.isFinite(badge)) return
  const card = document.querySelector(`.issue-card[data-badge="${badge}"]`) as HTMLElement | null
  if (!card) return
  card.scrollIntoView({ block: 'center', behavior: 'smooth' })
  card.classList.add('lo-card-flash')
  window.setTimeout(() => card.classList.remove('lo-card-flash'), 1500)
}

onMounted(() => window.addEventListener('lo:issue-focus', onIssueFocus as EventListener))
onBeforeUnmount(() => window.removeEventListener('lo:issue-focus', onIssueFocus as EventListener))
</script>

<template>
  <div class="space-y-3">
    <p class="text-[12.5px] leading-relaxed text-[#D9D9DE]">{{ report.summary }}</p>

    <!-- 四个维度 -->
    <div class="grid grid-cols-2 gap-1.5">
      <div
        v-for="d in dims"
        :key="d.label"
        class="rounded-[10px] border border-white/[0.08] bg-[#252527] px-2.5 py-1.5"
      >
        <div class="flex items-center justify-between">
          <span class="text-[11.5px] text-[#98989D]">{{ d.label }}</span>
          <span class="text-[11.5px] font-medium" :class="tone(d.status)">{{ d.status }}</span>
        </div>
        <p v-if="d.count === 0" class="mt-0.5 text-[10.5px] text-[#636366]">没有发现问题</p>
        <p v-else class="mt-0.5 truncate text-[10.5px] text-[#636366]">{{ d.problems[0] }}</p>
      </div>
    </div>

    <!-- 问题清单 -->
    <div v-if="report.issues.length" class="space-y-2">
      <p class="text-[11px] uppercase tracking-wide text-[#636366]">改进建议（{{ report.issues.length }} 条）</p>
      <div
        v-for="{ it, index: i } in mainIssues.filter(({ index }) => !isHidden(index))"
        :key="i"
        :data-badge="i + 1"
        class="issue-card rounded-[10px] border border-white/[0.08] bg-[#252527] px-3 py-2"
        :class="it.block !== null ? 'cursor-pointer hover:border-white/20' : ''"
        @click="onLocate(it.block)"
      >
        <div class="flex items-start gap-2">
          <span class="mt-0.5 shrink-0 rounded border px-1.5 text-[10px] leading-[16px]" :class="levelTone(it.level)">
            {{ it.levelLabel }}
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-[12.5px] font-medium text-[#F5F5F7]">{{ it.problem }}</p>
            <p class="mt-0.5 text-[11px] text-[#636366]">{{ it.where }}</p>
            <p class="mt-1 text-[11.5px] leading-relaxed text-[#A1A1A6]">{{ it.why }}</p>
            <p class="mt-1 text-[11.5px] leading-relaxed text-[#6FB6FF]">改法：{{ it.how }}</p>
            <div class="mt-1 flex items-center gap-2">
              <span v-if="it.block !== null" class="text-[10.5px] text-[#0A84FF]">点击定位到该段</span>
              <button
                type="button"
                class="rounded-full border border-white/[0.08] px-2 py-0.5 text-[10.5px] text-[#98989D] hover:text-[#F5F5F7]"
                title="这条不是问题，以后不再提示"
                @click.stop="dismissIssue(it, i)"
              >
                不用改
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p v-else class="text-[12px] text-[#30D158]">没有发现需要修改的地方。</p>

    <!-- 可选建议：默认折叠，避免首屏噪音 -->
    <div v-if="optionalIssues.length" class="mt-1">
      <button
        type="button"
        class="flex w-full items-center justify-between rounded-[10px] border border-white/[0.08] px-3 py-2 text-[11.5px] text-[#98989D] hover:text-[#F5F5F7]"
        @click="showOptional = !showOptional"
      >
        <span>另有 {{ optionalIssues.length }} 条可选建议（不影响可用性）</span>
        <span>{{ showOptional ? '收起' : '展开' }}</span>
      </button>
      <div v-if="showOptional" class="mt-2 flex flex-col gap-2">
        <div
          v-for="{ it, index: i } in optionalIssues.filter(({ index }) => !isHidden(index))"
          :key="i"
          :data-badge="i + 1"
          class="issue-card rounded-[10px] border border-white/[0.08] px-3 py-2"
          :class="it.block !== null ? 'cursor-pointer hover:border-white/20' : ''"
          @click="onLocate(it.block)"
        >
          <div class="flex items-start gap-2">
            <span class="mt-0.5 shrink-0 rounded border px-1.5 text-[10px] leading-[16px]" :class="levelTone(it.level)">
              {{ it.levelLabel }}
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-[12.5px] font-medium text-[#F5F5F7]">{{ it.problem }}</p>
              <p class="mt-0.5 text-[11px] text-[#636366]">{{ it.where }}</p>
              <p class="mt-1 text-[11.5px] leading-relaxed text-[#A1A1A6]">{{ it.why }}</p>
              <p class="mt-1 text-[11.5px] leading-relaxed text-[#6FB6FF]">改法：{{ it.how }}</p>
              <button
                type="button"
                class="mt-1 rounded-full border border-white/[0.08] px-2 py-0.5 text-[10.5px] text-[#98989D] hover:text-[#F5F5F7]"
                @click.stop="dismissIssue(it, i)"
              >
                不用改
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
