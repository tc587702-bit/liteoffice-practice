<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../../stores/workspace'
import AppIcon from '../ui/AppIcon.vue'
import type { IconName } from '../ui/iconRegistry'

const store = useWorkspaceStore()
const { toasts } = storeToRefs(store)

const ICONS: Record<string, IconName> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  error: 'x-circle',
}

const TONES: Record<string, string> = {
  info: 'text-[#6FB6FF]',
  success: 'text-[#5CE07E]',
  warning: 'text-[#FFB340]',
  error: 'text-[#FF6961]',
}
</script>

<template>
  <div
    class="pointer-events-none fixed bottom-6 right-6 z-50 flex w-[min(380px,calc(100vw-48px))] flex-col gap-2"
  >
    <div
      v-for="toast in toasts"
      :key="toast.id"
      role="status"
      class="lo-rise pointer-events-auto flex items-start gap-3 rounded-[18px] border border-white/[0.08] bg-[#2C2C2E]/95 p-3.5 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.8)] backdrop-blur-xl"
    >
      <AppIcon :name="ICONS[toast.tone]" class="mt-0.5 h-4 w-4 shrink-0" :class="TONES[toast.tone]" :stroke-width="2" />
      <div class="min-w-0 flex-1">
        <p class="text-[13px] font-medium leading-snug text-[#F5F5F7]">{{ toast.title }}</p>
        <p v-if="toast.description" class="mt-0.5 break-words text-[12px] leading-relaxed text-[#A1A1A6]">
          {{ toast.description }}
        </p>
      </div>
      <button
        type="button"
        aria-label="关闭提示"
        class="rounded-md p-0.5 text-[#636366] transition-colors hover:text-white"
        @click="store.dismissToast(toast.id)"
      >
        <AppIcon name="x" class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
