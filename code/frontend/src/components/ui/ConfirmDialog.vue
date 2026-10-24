<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../../stores/workspace'
import AppButton from './AppButton.vue'
import AppIcon from './AppIcon.vue'

/** 大文件前置确认（自绘弹层，不引入任何 UI 组件库） */
const store = useWorkspaceStore()
const { confirmRequest } = storeToRefs(store)
</script>

<template>
  <div v-if="confirmRequest" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="lo-confirm-title"
      class="lo-card w-full max-w-[460px] p-6 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
    >
      <div class="flex items-start gap-3">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FF9F0A]/15">
          <AppIcon name="alert-triangle" class="h-4 w-4 text-[#FFB340]" />
        </span>
        <div class="min-w-0">
          <h2 id="lo-confirm-title" class="text-[15px] font-semibold leading-snug text-[#F5F5F7]">
            {{ confirmRequest.title }}
          </h2>
          <p class="mt-1.5 text-[12.5px] leading-relaxed text-[#A1A1A6]">{{ confirmRequest.description }}</p>
        </div>
      </div>

      <ul v-if="confirmRequest.detail?.length" class="mt-4 flex flex-col gap-1.5 rounded-[16px] bg-black/30 p-3">
        <li
          v-for="line in confirmRequest.detail"
          :key="line"
          class="flex items-start gap-1.5 text-[12px] leading-relaxed text-[#98989D]"
        >
          <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#636366]" />
          <span class="min-w-0 break-words">{{ line }}</span>
        </li>
      </ul>

      <div class="mt-5 flex items-center justify-end gap-2">
        <AppButton variant="secondary" size="md" @click="store.resolveConfirm(false)">
          {{ confirmRequest.cancelText }}
        </AppButton>
        <AppButton variant="primary" size="md" @click="store.resolveConfirm(true)">
          {{ confirmRequest.confirmText }}
        </AppButton>
      </div>
    </section>
  </div>
</template>
