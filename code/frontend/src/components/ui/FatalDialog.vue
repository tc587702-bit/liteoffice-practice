<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../../stores/workspace'
import AppButton from './AppButton.vue'
import AppIcon from './AppIcon.vue'

/** 内存不足 / 解析崩溃兜底：给原因 + 下载原始文件，绝不留白屏或无限转圈 */
const store = useWorkspaceStore()
const { fatal } = storeToRefs(store)
</script>

<template>
  <div v-if="fatal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm">
    <section
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="lo-fatal-title"
      class="lo-card w-full max-w-[500px] p-6 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
    >
      <div class="flex items-start gap-3">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FF453A]/15">
          <AppIcon name="alert-triangle" class="h-4 w-4 text-[#FF6961]" />
        </span>
        <div class="min-w-0">
          <h2 id="lo-fatal-title" class="text-[15px] font-semibold leading-snug text-[#F5F5F7]">
            无法继续解析：{{ fatal.fileName }}
          </h2>
          <p class="mt-1.5 text-[12.5px] leading-relaxed text-[#A1A1A6]">{{ fatal.message }}</p>
        </div>
      </div>

      <div class="mt-5 flex flex-wrap items-center justify-end gap-2">
        <AppButton variant="secondary" size="md" @click="store.dismissFatal()">关闭</AppButton>
        <AppButton variant="primary" size="md" @click="store.downloadFatal()">下载原始文件</AppButton>
      </div>
    </section>
  </div>
</template>
