<script setup lang="ts">
import AppIcon from '../ui/AppIcon.vue'
import type { IconName } from '../ui/iconRegistry'

const props = defineProps<{
  disabled: boolean
  active: Record<string, boolean>
  canUndo: boolean
  canRedo: boolean
}>()

const emit = defineEmits<{ command: [command: string] }>()

interface Tool {
  key: string
  label: string
  icon?: IconName
  text?: string
  divider?: boolean
}

const DIVIDER: Tool = { key: 'divider', label: '', divider: true }

const TOOLS: Tool[] = [
  { key: 'bold', label: '加粗', icon: 'bold' },
  { key: 'italic', label: '斜体', text: 'I' },
  { key: 'underline', label: '下划线', text: 'U' },
  DIVIDER,
  { key: 'h1', label: '一级标题', text: 'H1' },
  { key: 'h2', label: '二级标题', text: 'H2' },
  { key: 'p', label: '正文', text: '正文' },
  DIVIDER,
  { key: 'ul', label: '无序列表', icon: 'list' },
  { key: 'ol', label: '有序列表', icon: 'list-ordered' },
  { key: 'quote', label: '引用', icon: 'quote' },
  { key: 'pre', label: '代码块', icon: 'code-2' },
  { key: 'hr', label: '分割线', icon: 'minus' },
  DIVIDER,
  { key: 'undo', label: '撤销', icon: 'undo-2' },
  { key: 'redo', label: '重做', icon: 'redo-2' },
]

function toolDisabled(key: string) {
  if (props.disabled) return true
  if (key === 'undo') return !props.canUndo
  if (key === 'redo') return !props.canRedo
  return false
}

function onMouseDown(event: MouseEvent) {
  // 保持编辑器选区不被工具栏抢走
  event.preventDefault()
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-0.5 border-b border-white/[0.06] bg-[#242426] px-3 py-2">
    <template v-for="(tool, index) in TOOLS" :key="index">
      <span v-if="tool.divider" class="lo-divider mx-1 h-5 w-px" />
      <button
        v-else
        type="button"
        :title="tool.label"
        :aria-label="tool.label"
        :aria-pressed="props.active[tool.key] ? 'true' : 'false'"
        :disabled="toolDisabled(tool.key)"
        class="flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60 disabled:cursor-not-allowed disabled:opacity-30"
        :class="
          props.active[tool.key]
            ? 'bg-[#0A84FF]/20 text-[#6FB6FF]'
            : 'text-[#C7C7CC] hover:bg-white/[0.08] hover:text-white'
        "
        @mousedown="onMouseDown"
        @click="emit('command', tool.key)"
      >
        <AppIcon v-if="tool.icon" :name="tool.icon" class="h-4 w-4" :stroke-width="1.9" />
        <em v-else-if="tool.key === 'italic'" class="font-serif text-[14px] leading-none">I</em>
        <span v-else-if="tool.key === 'underline'" class="text-[13px] underline underline-offset-2">U</span>
        <span v-else :class="tool.key === 'h1' || tool.key === 'h2' ? 'text-[13px] font-semibold' : 'text-[13px]'">
          {{ tool.text }}
        </span>
      </button>
    </template>
  </div>
</template>
