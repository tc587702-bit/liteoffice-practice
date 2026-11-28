<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../../stores/workspace'
import AppIcon from '../ui/AppIcon.vue'

/** 解析等待态：显示阶段与已耗时，超过 5 秒给可取消入口（界面不再假死无反馈） */
const store = useWorkspaceStore()
const { job } = storeToRefs(store)
</script>

<template>
  <div
    v-if="job"
    role="status"
    aria-live="polite"
    class="lo-rise fixed bottom-6 left-6 z-50 w-[min(340px,calc(100vw-48px))] rounded-[18px] border border-lo-border bg-lo-elevated p-3.5 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.8)] backdrop-blur-xl"
  >
    <div class="flex items-center gap-2">
      <AppIcon name="loader" class="lo-spin h-4 w-4 shrink-0 text-[#0A84FF]" :stroke-width="2" />
      <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium text-lo-text-1" :title="job.fileName">
        {{ job.fileName }}
      </span>
      <span class="shrink-0 text-[11px] tabular-nums text-lo-text-3">{{ job.seconds }}s</span>
    </div>
    <p class="mt-1 truncate text-[11.5px] text-lo-text-2" :title="job.phase">{{ job.phase }}</p>
    <p v-if="job.total > 0" class="mt-0.5 text-[10.5px] tabular-nums text-lo-text-3">
      已加载 {{ job.done.toLocaleString('en-US') }} / 共 {{ job.total.toLocaleString('en-US') }}
    </p>
    <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-lo-fill-3">
      <div class="lo-indeterminate h-full w-1/3 rounded-full bg-[#0A84FF]" />
    </div>
    <div class="mt-2 flex items-center justify-between gap-2">
      <span class="text-[10.5px] text-lo-text-4">全程在本地解析，文件不上传</span>
      <button
        v-if="job.canCancel"
        type="button"
        class="rounded-full border border-lo-border bg-lo-surface-4 px-2.5 py-1 text-[11px] text-lo-text-1 transition-colors hover:bg-lo-surface-hover"
        @click="store.cancelJob()"
      >
        取消解析
      </button>
      <span v-else class="text-[10.5px] text-lo-text-4">可随时取消</span>
    </div>
  </div>
</template>
