<script setup lang="ts">
import { computed } from 'vue'

export type BadgeVariant = 'reserved' | 'solid' | 'soft' | 'outline' | 'warn' | 'ok'

const props = withDefaults(defineProps<{ variant?: BadgeVariant }>(), { variant: 'reserved' })

const VARIANTS: Record<BadgeVariant, string> = {
  reserved: 'bg-white/[0.06] text-[#636366]',
  solid: 'bg-[#0A84FF] text-white',
  soft: 'bg-[#0A84FF]/15 text-[#6FB6FF]',
  outline: 'border border-white/10 text-[#A1A1A6]',
  warn: 'bg-[#FF9F0A]/15 text-[#FFB340]',
  ok: 'bg-[#30D158]/15 text-[#5CE07E]',
}

const classes = computed(() => ['lo-badge', VARIANTS[props.variant]])
</script>

<template>
  <span :class="classes">
    <slot />
  </span>
</template>
