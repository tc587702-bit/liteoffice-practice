<script setup lang="ts">
/**
 * Markdown 源码编辑器（最小可用版）。
 *
 * 千问的 1041dcf 提交里 Editor.vue 引用了本组件，但文件没提交上来，
 * 合并后会编译失败。这里按调用方用到的 props/emit 补一个简单实现：
 *   props: value(源码) / docName
 *   emit : input(源码) / save
 * 完整版（行号、折叠、快捷键、滚动同步）可以由他那边覆盖本文件。
 */
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{ value: string; docName?: string }>()
const emit = defineEmits<{ (e: 'input', value: string): void; (e: 'save'): void }>()

const area = ref<HTMLTextAreaElement | null>(null)
const text = ref(props.value ?? '')
const dirty = computed(() => text.value !== (props.value ?? ''))

watch(
  () => props.value,
  (v) => {
    // 外部（如切换文档、重置）改了源码时才覆盖，避免打断输入
    if ((v ?? '') !== text.value) text.value = v ?? ''
  },
)

const lines = computed(() => text.value.split('\n').length)
const chars = computed(() => text.value.length)

function onInput(e: Event) {
  text.value = (e.target as HTMLTextAreaElement).value
  emit('input', text.value)
}

/** Tab 缩进两个空格：源码编辑里比切换焦点更符合预期 */
function insertText(value: string) {
  const el = area.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  text.value = text.value.slice(0, start) + value + text.value.slice(end)
  emit('input', text.value)
  void nextTick(() => {
    el.selectionStart = el.selectionEnd = start + value.length
  })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    insertText('  ')
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    emit('save')
  }
}
</script>

<template>
  <div class="flex h-full min-h-[320px] flex-col overflow-hidden rounded-[10px] bg-[#141416]">
    <div class="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
      <span class="text-[11px] text-[#98989D]">Markdown 源码{{ docName ? ` · ${docName}` : '' }}</span>
      <span class="text-[10.5px] text-[#636366]">
        {{ lines }} 行 · {{ chars }} 字符<template v-if="dirty"> · 未同步</template>
      </span>
    </div>
    <textarea
      ref="area"
      class="lo-md-source thin-scroll flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-[1.75] text-[#F5F5F7] outline-none"
      spellcheck="false"
      :value="text"
      @input="onInput"
      @keydown="onKeydown"
    />
  </div>
</template>

<style scoped>
.lo-md-source {
  tab-size: 2;
}
</style>
