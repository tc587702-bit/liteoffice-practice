<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 老虎机数字：加载时从 9 滚到真实值。
 * 动画完全由类名切换驱动（组件状态 → className），不直接操作 DOM；
 * prefers-reduced-motion 下直接渲染真实值。
 */
const props = withDefaults(defineProps<{ value: number | string; animate?: boolean }>(), { animate: true })

const armed = ref(false)
const reduceMotion = ref(false)
const target = computed(() => String(props.value))
const plain = computed(() => !props.animate || reduceMotion.value)
const digits = computed(() => target.value.split('').map((char, index) => ({ char, index })))

let timer: number | null = null
let query: MediaQueryList | null = null

function onMotionChange(event: MediaQueryListEvent) {
  reduceMotion.value = event.matches
  if (event.matches && timer) window.clearTimeout(timer)
}

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    query = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduceMotion.value = query.matches
    query.addEventListener('change', onMotionChange)
  }
  if (!props.animate || reduceMotion.value) return
  timer = window.setTimeout(() => {
    armed.value = true
  }, 160)
})

onBeforeUnmount(() => {
  if (timer) window.clearTimeout(timer)
  query?.removeEventListener('change', onMotionChange)
})

function reelClass(index: number) {
  return [
    'lo-reel',
    armed.value ? 'lo-reel-armed' : 'lo-reel-start',
    `lo-reel-delay-${Math.min(index, 2)}`,
  ]
}
</script>

<template>
  <span v-if="plain" class="tabular-nums">{{ target }}</span>
  <span v-else class="inline-flex items-baseline tabular-nums" :aria-label="target">
    <template v-for="item in digits" :key="item.index">
      <span v-if="!/\d/.test(item.char)" class="inline-block">{{ item.char }}</span>
      <span v-else :class="reelClass(item.index)" aria-hidden="true">
        <span class="lo-reel-col">
          <span class="lo-reel-track">
            <span v-for="n in 10" :key="n" class="lo-reel-digit">{{ n - 1 }}</span>
            <span class="lo-reel-digit">{{ item.char }}</span>
          </span>
        </span>
      </span>
    </template>
  </span>
</template>
