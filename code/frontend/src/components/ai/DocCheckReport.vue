<script setup lang="ts">
/**
 * 文档检查报告（无分数版）
 *
 * 结构：概览一句 → 四个维度状态 → 问题清单（等级/位置/原因/改法）
 * 点击某条问题 → 定位到编辑区对应段落并闪一下
 */
import { computed } from 'vue'
import type { ImproveReport } from '../../lib/improveClient'
import { locateBlock } from '../../lib/improveClient'

const props = defineProps<{ report: ImproveReport }>()

const dims = computed(() => Object.values(props.report.dims))

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
        v-for="(it, i) in report.issues"
        :key="i"
        class="rounded-[10px] border border-white/[0.08] bg-[#252527] px-3 py-2"
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
            <p v-if="it.block !== null" class="mt-1 text-[10.5px] text-[#0A84FF]">点击定位到该段</p>
          </div>
        </div>
      </div>
    </div>
    <p v-else class="text-[12px] text-[#30D158]">没有发现需要修改的地方。</p>
  </div>
</template>
