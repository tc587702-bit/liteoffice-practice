<script setup lang="ts">
import { computed } from 'vue'
import { ICONS, type IconName } from './iconRegistry'

const props = withDefaults(defineProps<{ name: IconName; strokeWidth?: number }>(), { strokeWidth: 1.8 })

const markup = computed(() => ICONS[props.name] ?? '')
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="markup"
  />
</template>
