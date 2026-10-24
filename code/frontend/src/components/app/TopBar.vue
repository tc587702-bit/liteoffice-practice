<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../../stores/workspace'
import { useFileDrop } from './fileDropContext'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    saving?: boolean
    statusText?: string
  }>(),
  { saving: false, statusText: undefined },
)

const emit = defineEmits<{ save: [] }>()

const store = useWorkspaceStore()
const { docs, activeDoc } = storeToRefs(store)
const { openPicker, busy } = useFileDrop()

const status = computed(() => props.statusText ?? (activeDoc.value ? `当前：${activeDoc.value.name}` : '还没有打开文件'))
const sessionCount = computed(() => docs.value.length)
</script>

<template>
  <header
    class="lo-glass flex h-16 shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] px-6 lg:px-10"
  >
    <RouterLink
      to="/"
      class="flex items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
    >
      <span class="relative flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#3A3A3C] ring-1 ring-white/10">
        <span class="text-[13px] font-bold tracking-tight text-white">LO</span>
        <span class="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-[#0A84FF] ring-2 ring-[#1C1C1E]" />
      </span>
      <span class="flex flex-col leading-tight">
        <span class="flex items-baseline gap-2">
          <span class="text-[16px] font-semibold tracking-tight text-[#F5F5F7]">LiteOffice</span>
          <span
            v-if="sessionCount > 0"
            class="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[#A1A1A6]"
          >
            {{ sessionCount }} 个文件
          </span>
        </span>
        <span class="text-[12px] text-[#98989D]">文件不上传 · 浏览器内编辑</span>
      </span>
    </RouterLink>

    <div class="flex items-center gap-2 md:gap-3">
      <span class="hidden max-w-[220px] truncate text-[12px] text-[#636366] lg:block" :title="status">{{ status }}</span>
      <AppButton
        variant="secondary"
        size="md"
        class="hidden sm:inline-flex"
        :disabled="!activeDoc || saving"
        :title="activeDoc ? '把编辑结果保存并下载到本机' : '还没有打开文件'"
        @click="emit('save')"
      >
        <AppIcon :name="saving ? 'loader' : 'download'" class="h-4 w-4" :class="saving ? 'lo-spin' : ''" />
        保存下载
      </AppButton>
      <AppButton variant="primary" size="md" :disabled="busy" @click="openPicker">
        <AppIcon :name="busy ? 'loader' : 'folder-open'" class="h-4 w-4" :class="busy ? 'lo-spin' : ''" />
        打开文件
      </AppButton>
    </div>
  </header>
</template>
