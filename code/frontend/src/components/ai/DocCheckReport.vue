<script setup lang="ts">
/**
 * 文档检查报告（无分数版）
 *
 * 结构：概览一句 → 四个维度状态 → 问题清单（等级/位置/原因/改法）
 * 点击某条问题 → 定位到编辑区对应段落并闪一下
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ImproveIssue, ImproveReport } from '../../lib/improveClient'
import { locateBlock, sendIssueFeedback } from '../../lib/improveClient'
import { getBlockText, replaceTextInBlock } from '../../lib/editorEdit'
import { clearAllMarks, clearIssueMarks, markIssues } from '../../lib/issueMarks'
import { rewriteSelection } from '../../lib/kbClient'

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
  if (ok) {
    hidden.value = new Set(hidden.value).add(index)
    clearIssueMarks()
    window.getSelection()?.removeAllRanges()
    window.dispatchEvent(new CustomEvent('lo:issue-dismissed'))
  }
}

/**
 * 一键修改：把规则层给出的改后文本replace进正文。
 *
 * 只对「一定能改对」的问题提供（的/得/地、错别字、赘余），
 * 常识类问题没有 fix 字段，按钮不出现。
 */
function applyFix(it: ImproveIssue) {
  if (!it.fix || it.block === null || it.block === undefined) return
  // 片段标记会把文本节点切开，先清标记才能按原文精确替换（替换后会重新检查、重新标注）
  clearIssueMarks()
  const res = replaceTextInBlock(it.block, it.fixFrom ?? '', it.fix, it.span)
  if (!res.ok) {
    window.dispatchEvent(new CustomEvent('lo:fix-failed', { detail: { message: res.message } }))
    return
  }
  // 「的→得」这种只改一个字，用户在正文里几乎看不出来 —— 必须让它可见：
  // ① 卡片上直接写「已改为 …」 ② 正文里闪一下 ③ 滚到那一处
  const before = it.fixFrom ?? ''
  const changedChars = Math.max(1, Math.abs((it.fix ?? '').length - before.length) + 1)
  const idx = props.report.issues.indexOf(it)
  setStatus(
    idx,
    true,
    changedChars <= 2 ? '已修改（改动 1–2 个字，请注意正文闪动处）' : '已修改',
  )
  flashBlock(it.block)
  clearAfterAction(idx)
  window.dispatchEvent(new CustomEvent('lo:issue-fixed'))
}

/** 让改过的那一段闪一下并滚进视野 */
function flashBlock(block: number) {
  const host = document.querySelector('.lo-editor')
  const el = (Array.from(host?.children ?? []) as HTMLElement[])[block]
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('lo-fix-flash')
  window.setTimeout(() => el.classList.remove('lo-fix-flash'), 1800)
}

/**
 * 改完或标记「不用改」之后：清掉正文标记 + 收起光标/选区。
 *
 * 为什么：标记是"待处理"的视觉提示，处理完还挂着会一直干扰阅读；
 * 光标/选区留着也容易让人误以为还能继续操作那一处。
 * 处理过的内容会在下次「检查」时按记忆过滤，并在报告顶部提示。
 */
function clearAfterAction(keepIndex?: number) {
  // 只收光标；标记按「已处理的那条」移除，其余继续保持高亮
  window.getSelection()?.removeAllRanges()
  if (keepIndex === undefined) {
    clearAllMarks()
    return
  }
  const rest = props.report.issues.filter(
    (_, i) =>
      i !== keepIndex &&
      !hidden.value.has(i) &&
      !(rewriteStatus.value.get(i)?.ok ?? false),
  )
  if (!rest.length) {
    clearAllMarks()
    return
  }
  // 重画一次：剩下的问题继续标出来，刚处理掉的那条不再标
  markIssues({ ...props.report, issues: rest })
}

function isHidden(index: number) {
  return hidden.value.has(index)
}

/** 正在「一键改写」的条目（避免重复点击） */
const rewriting = ref<Set<number>>(new Set())
/** 每条改写的结果：成功给"已改写"，失败给原因（就地显示，不依赖顶部提示） */
const rewriteStatus = ref<Map<number, { ok: boolean; message: string }>>(new Map())

function setStatus(index: number, ok: boolean, message: string) {
  const next = new Map(rewriteStatus.value)
  next.set(index, { ok, message })
  rewriteStatus.value = next
}

function statusOf(index: number) {
  return rewriteStatus.value.get(index)
}

/**
 * 一键改写：规则层给不出 fix 的问题（长句、口语化、常识错），
 * 把该段交给模型润色一遍，通过护栏后直接替换回正文。
 *
 * 与「一键修改」的分工：
 *   一键修改 = 确定性修正（的得地/错别字），0.05 秒，离线可跑
 *   一键改写 = 让模型重写这一句，3–8 秒，走润色护栏（允许加意象，不许编事实）
 */
/**
 * 判断是不是「事实/概念」类问题。
 *
 * 这类问题用 polish 模式改不出来：润色护栏的第一条就是「不得改事实」，
 * 而这类问题恰恰要改事实。所以单独走 mode=correct（允许改事实，只改这一句）。
 */
function isFactIssue(it: ImproveIssue): boolean {
  const text = `${it.rule || ''}${it.problem || ''}${it.how || ''}`
  return /常识错误|概念混淆|前后矛盾|对照事实|与事实不符|常识|概念/.test(text)
}

async function applyRewrite(it: ImproveIssue, index: number) {
  if (it.block === null || it.block === undefined) return
  if (rewriting.value.has(index)) return

  // 只改「出问题的那一句」，不整段重写：
  // 整段交给模型时，润色护栏几乎必然因「新增非修饰内容」拦下（段落越长越容易多写词）。
  const blockText = getBlockText(it.block).trim()
  const sentences = blockText.split(/(?<=[。！？；])/).map((s) => s.trim()).filter(Boolean)
  const anchor = (it.excerpt || '').trim().slice(0, 10)
  const target = (anchor && sentences.find((s) => s.includes(anchor))) || sentences[0] || ''
  const source = target.length >= 10 ? target : blockText
  if (source.length < 10) {
    window.dispatchEvent(new CustomEvent('lo:fix-failed', { detail: { message: '这段太短，无法改写' } }))
    return
  }

  rewriting.value = new Set(rewriting.value).add(index)
  try {
    const fact = isFactIssue(it)
    const res = await rewriteSelection(source, {
      genre: props.report.genre,
      mode: fact ? 'correct' : 'polish',
      allowModelPolish: true,
      // 事实类问题把「错在哪」交给模型，否则它不知道要改什么
      problem: fact ? `${it.problem || ''}。${it.why || ''}`.trim() : '',
    })
    if (!res.ok || res.noChange || !res.candidate) {
      const why = res.reason || '模型没有给出改写'
      setStatus(index, false, why)
      window.dispatchEvent(new CustomEvent('lo:fix-failed', { detail: { message: why } }))
      return
    }
    const applied = replaceTextInBlock(it.block, source, res.candidate)
    if (!applied.ok) {
      setStatus(index, false, applied.message)
      window.dispatchEvent(new CustomEvent('lo:fix-failed', { detail: { message: applied.message } }))
      return
    }
    setStatus(index, true, '已改写')
    clearAfterAction(index)
    window.dispatchEvent(new CustomEvent('lo:issue-fixed'))
  } catch (e) {
    window.dispatchEvent(
      new CustomEvent('lo:fix-failed', { detail: { message: (e as Error).message || '改写失败' } }),
    )
  } finally {
    const next = new Set(rewriting.value)
    next.delete(index)
    rewriting.value = next
  }
}

function isRewriting(index: number) {
  return rewriting.value.has(index)
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

function onLocate(
  block: number | null,
  span?: { start: number; len: number } | null,
  quote?: string | null,
) {
  if (block === null) return
  // 三级定位：span（精确）→ 引文（小范围）→ 整段（兜底）
  locateBlock(block, span ?? null, quote ?? null)
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
        @click="onLocate(it.block, it.span, it.excerpt)"
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
                v-if="it.fix && it.block !== null"
                type="button"
                class="rounded-full bg-[#0A84FF] px-2 py-0.5 text-[10.5px] font-medium text-white"
                title="按建议直接改掉这一处"
                @click.stop="applyFix(it)"
              >
                一键修改
              </button>
              <button
                v-if="!it.fix && it.block !== null"
                type="button"
                class="rounded-full border border-[#0A84FF]/50 px-2 py-0.5 text-[10.5px] text-[#6FB6FF] hover:bg-[#0A84FF]/15 disabled:opacity-50"
                :disabled="isRewriting(i)"
                title="交给模型重写这一句（过润色护栏，不会编造事实）"
                @click.stop="applyRewrite(it, i)"
              >
                {{ isRewriting(i) ? '改写中…' : '一键改写' }}
              </button>
              <button
                type="button"
                class="rounded-full border border-white/[0.08] px-2 py-0.5 text-[10.5px] text-[#98989D] hover:text-[#F5F5F7]"
                title="这条不是问题，以后不再提示"
                @click.stop="dismissIssue(it, i)"
              >
                不用改
              </button>
            </div>
            <p
              v-if="statusOf(i)"
              class="mt-1 text-[10.5px] leading-relaxed"
              :class="statusOf(i)!.ok ? 'text-[#7BE495]' : 'text-[#FFB340]'"
            >
              {{ statusOf(i)!.message }}
            </p>
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
          @click="onLocate(it.block, it.span, it.excerpt)"
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
                v-if="it.fix && it.block !== null"
                type="button"
                class="mt-1 mr-1 rounded-full bg-[#0A84FF] px-2 py-0.5 text-[10.5px] font-medium text-white"
                @click.stop="applyFix(it)"
              >
                一键修改
              </button>
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
