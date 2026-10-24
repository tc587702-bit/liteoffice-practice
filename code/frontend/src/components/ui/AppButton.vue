<script setup lang="ts">
import { computed } from 'vue'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant
    size?: ButtonSize
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
  }>(),
  { variant: 'secondary', size: 'md', type: 'button', disabled: false },
)

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'lo-btn-primary',
  secondary: 'lo-btn-secondary',
  ghost: 'lo-btn-ghost',
  outline: 'lo-btn-outline',
  danger: 'lo-btn-danger',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'lo-btn-sm',
  md: 'lo-btn-md',
  lg: 'lo-btn-lg',
  icon: 'lo-btn-icon',
}

const classes = computed(() => ['lo-btn', 'lo-press', VARIANTS[props.variant], SIZES[props.size]])
</script>

<template>
  <button :type="type" :disabled="disabled" :class="classes">
    <slot />
  </button>
</template>
