<script setup lang="ts">
import { computed } from 'vue'

export type BadgeVariant = 'reserved' | 'solid' | 'soft' | 'outline' | 'warn' | 'ok'

const props = withDefaults(defineProps<{ variant?: BadgeVariant }>(), { variant: 'reserved' })

const VARIANTS: Record<BadgeVariant, string> = {
  reserved: 'bg-lo-fill-2 text-lo-text-4',
  solid: 'bg-[#0A84FF] text-white',
  soft: 'bg-[#0A84FF]/15 text-lo-accent-text',
  outline: 'border border-lo-border text-lo-text-3',
  warn: 'bg-[#FF9F0A]/15 text-lo-warning-text',
  ok: 'bg-[#30D158]/15 text-lo-success-text',
}

const classes = computed(() => ['lo-badge', VARIANTS[props.variant]])
</script>

<template>
  <span :class="classes">
    <slot />
  </span>
</template>
