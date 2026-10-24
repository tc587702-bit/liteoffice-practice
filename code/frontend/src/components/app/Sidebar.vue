<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../../stores/workspace'
import { formatSize, KIND_EXT } from '../../lib/file'
import AppBadge from '../ui/AppBadge.vue'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  activeId: string | null
  variant: 'home' | 'editor'
}>()

const emit = defineEmits<{
  select: [id: string]
  remove: [id: string]
  reserved: [target: string]
}>()

const store = useWorkspaceStore()
const { docs } = storeToRefs(store)

const kindTone: Record<string, string> = {
  docx: 'bg-[#0A84FF]/15 text-[#6FB6FF]',
  xlsx: 'bg-[#30D158]/15 text-[#5CE07E]',
  pptx: 'bg-[#FF9F0A]/15 text-[#FFB340]',
  md: 'bg-white/[0.08] text-[#C7C7CC]',
  pdf: 'bg-[#FF453A]/15 text-[#FF6961]',
  unknown: 'bg-white/[0.08] text-[#98989D]',
}

const countLabel = computed(() => String(docs.value.length).padStart(2, '0'))
</script>

<template>
  <aside
    class="lo-glass flex w-[264px] shrink-0 flex-col border-r border-white/[0.06] px-4 pb-6 pt-6"
  >
    <nav class="flex flex-col justify-center gap-1">
      <RouterLink
        to="/"
        class="flex items-center gap-3 rounded-xl bg-white/[0.08] px-3 py-2.5 text-[14px] font-medium text-[#F5F5F7] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
        aria-current="page"
      >
        <AppIcon name="file-text" class="h-[18px] w-[18px] text-[#0A84FF]" :stroke-width="1.6" />
        本地文档
      </RouterLink>
      <button
        type="button"
        class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] text-[#A1A1A6] outline-none transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
        @click="emit('reserved', 'AI 助手')"
      >
        <AppIcon name="sparkles" class="h-[18px] w-[18px]" :stroke-width="1.6" />
        <span class="flex-1">AI 助手</span>
        <AppBadge variant="reserved">预留</AppBadge>
      </button>
      <button
        type="button"
        class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] text-[#A1A1A6] outline-none transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
        @click="emit('reserved', '云端工作区')"
      >
        <AppIcon name="cloud" class="h-[18px] w-[18px]" :stroke-width="1.6" />
        <span class="flex-1">云端工作区</span>
        <AppBadge variant="reserved">预留</AppBadge>
      </button>
    </nav>

    <div class="lo-divider my-4 h-px w-full" />

    <p class="px-3 text-[12px] text-[#636366]">
      当前会话：{{ docs.length ? `${docs.length} 个文件` : '暂无文件' }}
    </p>

    <div class="mt-4 flex min-h-0 flex-1 flex-col">
      <div class="flex items-center justify-between px-3 pb-2">
        <span class="text-[11px] font-medium uppercase tracking-[0.12em] text-[#636366]">会话文件</span>
        <span class="text-[11px] tabular-nums text-[#636366]">{{ countLabel }}</span>
      </div>
      <div class="thin-scroll -mx-1 flex-1 overflow-y-auto px-1">
        <div
          v-if="docs.length === 0"
          class="mx-1 rounded-xl border border-dashed border-white/10 px-3 py-4 text-[12px] leading-relaxed text-[#636366]"
        >
          还没有打开文件。
          <br />
          拖入窗口或点顶部按钮开始。
        </div>
        <ul v-else class="flex flex-col gap-1">
          <li v-for="doc in docs" :key="doc.id" class="group/item relative">
            <button
              type="button"
              class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
              :class="doc.id === props.activeId ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'"
              :aria-current="doc.id === props.activeId ? 'true' : undefined"
              @click="emit('select', doc.id)"
            >
              <span
                class="flex h-7 w-9 shrink-0 items-center justify-center rounded-md text-[9px] font-bold tracking-wide"
                :class="kindTone[doc.kind]"
              >
                {{ KIND_EXT[doc.kind] }}
              </span>
              <span class="min-w-0 flex-1">
                <span
                  class="block truncate text-[12.5px] leading-tight"
                  :class="doc.id === props.activeId ? 'font-medium text-[#F5F5F7]' : 'text-[#C7C7CC]'"
                  :title="doc.name"
                >
                  {{ doc.name }}
                </span>
                <span class="mt-0.5 block text-[10.5px] tabular-nums text-[#636366]">
                  {{ formatSize(doc.size) }}
                  <span v-if="doc.dirty" class="ml-1 text-[#FF9F0A]">未保存</span>
                </span>
              </span>
            </button>
            <button
              type="button"
              class="absolute right-1.5 top-1.5 hidden rounded-md bg-[#2C2C2E] px-1.5 py-0.5 text-[10px] text-[#A1A1A6] hover:text-[#FF6961] group-hover/item:block"
              :aria-label="`移除 ${doc.name}`"
              @click.stop="emit('remove', doc.id)"
            >
              移除
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div class="mt-3 border-t border-white/[0.06] pt-3">
      <div class="flex items-center gap-2 px-3 text-[12px] text-[#98989D]">
        <AppIcon name="lock" class="h-3.5 w-3.5 text-[#30D158]" />
        仅在本地处理
      </div>
      <RouterLink
        v-if="variant === 'home'"
        to="/editor"
        class="mt-1 inline-flex items-center gap-1 px-3 text-[12.5px] text-[#0A84FF] outline-none hover:text-[#339BFF] focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
      >
        <AppIcon name="square-pen" class="h-3.5 w-3.5" />
        预览编辑器界面
      </RouterLink>
      <div v-else class="mt-1 flex items-center gap-1 px-3 text-[12.5px] text-[#636366]">
        <AppIcon name="shield-check" class="h-3.5 w-3.5" />
        安全模式已启用
      </div>
    </div>
  </aside>
</template>
