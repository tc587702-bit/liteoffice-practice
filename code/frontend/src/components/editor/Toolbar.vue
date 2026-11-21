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

// 字体：Word 常见中文字体 + 常用西文。值直接进 execCommand('fontName')。
const FONTS = [
  { v: '宋体', label: '宋体' },
  { v: '黑体', label: '黑体' },
  { v: '楷体', label: '楷体' },
  { v: '仿宋', label: '仿宋' },
  { v: '微软雅黑', label: '微软雅黑' },
  { v: '等线', label: '等线' },
  { v: 'Times New Roman', label: 'Times New Roman' },
  { v: 'Arial', label: 'Arial' },
  { v: 'Calibri', label: 'Calibri' },
  { v: 'Courier New', label: 'Courier New' },
]

// 字号：磅值统一用字符串，附中文字号对照。Editor 的 applyFontSize 写精确 pt。
const SIZES = [
  { v: '9', label: '小五 9pt' },
  { v: '10.5', label: '五号 10.5pt' },
  { v: '12', label: '小四 12pt' },
  { v: '14', label: '四号 14pt' },
  { v: '15', label: '小三 15pt' },
  { v: '18', label: '三号 18pt' },
  { v: '22', label: '小二 22pt' },
  { v: '24', label: '二号 24pt' },
  { v: '30', label: '小一 30pt' },
  { v: '36', label: '一号 36pt' },
]

// 文字色常用值（Word 标准色）
const TEXT_COLORS = ['#000000', '#c00000', '#0070c0', '#00b050', '#ff8c00', '#7030a0', '#808080']
// 文本底色常用值（对应 Word「文本突出显示颜色」）
const HL_COLORS = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#0000ff', '#ff0000', '#a9a9a9']

const TOOLS: Tool[] = [
  { key: 'bold', label: '加粗', icon: 'bold' },
  { key: 'italic', label: '斜体', text: 'I' },
  { key: 'underline', label: '下划线', text: 'U' },
  { key: 'strike', label: '删除线', text: 'S' },
  DIVIDER,
  { key: 'sup', label: '上标', text: 'x²' },
  { key: 'sub', label: '下标', text: 'x₂' },
  DIVIDER,
  { key: 'h1', label: '一级标题', text: 'H1' },
  { key: 'h2', label: '二级标题', text: 'H2' },
  { key: 'p', label: '正文', text: '正文' },
  DIVIDER,
  { key: 'align:left', label: '左对齐', icon: 'align-left' },
  { key: 'align:center', label: '居中', icon: 'align-center' },
  { key: 'align:right', label: '右对齐', icon: 'align-right' },
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

// 下拉/取色选完后复位：否则再次选同一个值不触发 change，功能看起来"失灵"
function resetSelect(event: Event) {
  const el = event.target
  // 用 instanceof 而不是 tagName 判断：后者 TS 无法收窄联合类型
  if (el instanceof HTMLSelectElement) el.selectedIndex = 0
  else if (el instanceof HTMLInputElement) el.value = '#000000'
}

function onMouseDown(event: MouseEvent) {
  // 保持编辑器选区不被工具栏抢走
  event.preventDefault()
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1 border-b border-white/[0.06] bg-[#242426] px-3 py-2">
    <!-- 字体 -->
    <select
      :disabled="disabled"
      title="字体"
      class="h-8 w-[118px] rounded-lg border border-white/[0.08] bg-[#1F1F21] px-2 text-[12px] text-[#F5F5F7] outline-none disabled:opacity-30"
      @change="emit('command', 'font:' + ($event.target as HTMLSelectElement).value); resetSelect($event)"
    >
      <option value="" disabled selected>字体</option>
      <option v-for="f in FONTS" :key="f.v" :value="f.v">{{ f.label }}</option>
    </select>

    <!-- 字号 -->
    <select
      :disabled="disabled"
      title="字号"
      class="h-8 w-[104px] rounded-lg border border-white/[0.08] bg-[#1F1F21] px-2 text-[12px] text-[#F5F5F7] outline-none disabled:opacity-30"
      @change="emit('command', 'size:' + ($event.target as HTMLSelectElement).value); resetSelect($event)"
    >
      <option value="" disabled selected>字号</option>
      <option v-for="s in SIZES" :key="s.v" :value="s.v">{{ s.label }}</option>
    </select>

    <span class="lo-divider mx-1 h-5 w-px" />

    <!-- 文字色：色板 + 自定义取色器 -->
    <div class="flex h-8 items-center gap-1 rounded-lg bg-[#1F1F21] px-1.5" title="文字颜色">
      <span class="text-[13px] font-semibold text-[#C7C7CC]">A</span>
      <button
        v-for="c in TEXT_COLORS"
        :key="c"
        type="button"
        :disabled="disabled"
        class="h-5 w-5 rounded border border-white/20 hover:scale-110"
        :style="{ background: c }"
        :title="`文字色 ${c}`"
        @mousedown="onMouseDown"
        @click="emit('command', 'color:' + c)"
      />
      <label class="relative flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-white/20 text-[11px] text-[#98989D] hover:text-white" title="自定义文字颜色">
        ＋
        <input
          type="color"
          class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          :disabled="disabled"
          @change="emit('command', 'color:' + ($event.target as HTMLInputElement).value); resetSelect($event)"
        />
      </label>
    </div>

    <!-- 文本底色 -->
    <div class="flex h-8 items-center gap-1 rounded-lg bg-[#1F1F21] px-1.5" title="文本底色">
      <span class="h-3.5 w-3.5 rounded-sm border border-white/20 bg-[#ffff00]" />
      <button
        v-for="c in HL_COLORS"
        :key="c"
        type="button"
        :disabled="disabled"
        class="h-5 w-5 rounded border border-white/20 hover:scale-110"
        :style="{ background: c }"
        :title="`底色 ${c}`"
        @mousedown="onMouseDown"
        @click="emit('command', 'hl:' + c)"
      />
    </div>

    <span class="lo-divider mx-1 h-5 w-px" />

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
        <span v-else-if="tool.key === 'strike'" class="text-[13px] line-through">S</span>
        <span v-else :class="tool.key === 'h1' || tool.key === 'h2' ? 'text-[13px] font-semibold' : 'text-[13px]'">
          {{ tool.text }}
        </span>
      </button>
    </template>
  </div>
</template>