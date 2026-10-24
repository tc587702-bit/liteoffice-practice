<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { provideFileDrop } from './fileDropContext'
import AppIcon from '../ui/AppIcon.vue'

/** 整页拖拽 + 隐藏文件选择器，三条入口（按钮 / 整页 / 拖拽框）共用同一导入管道。 */
const store = useWorkspaceStore()
const inputRef = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const busy = ref(false)
let dragDepth = 0

async function open(files: File[]) {
  if (!files.length || busy.value) return
  busy.value = true
  try {
    await store.importFiles(files)
  } finally {
    busy.value = false
  }
}

function openPicker() {
  inputRef.value?.click()
}

provideFileDrop({ openPicker, open, busy })

function onChange(event: Event) {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files ?? [])
  target.value = ''
  void open(files)
}

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(event: DragEvent) {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth += 1
  dragging.value = true
}

function onDragOver(event: DragEvent) {
  if (!hasFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent) {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(event: DragEvent) {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  void open(Array.from(event.dataTransfer?.files ?? []))
}

onMounted(() => {
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <input
    ref="inputRef"
    type="file"
    multiple
    accept=".docx,.xlsx,.pptx,.md,.markdown,.pdf"
    class="hidden"
    @change="onChange"
  />
  <slot />
  <div
    :aria-hidden="!dragging"
    class="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-[2px] transition-opacity duration-200"
    :class="dragging ? 'opacity-100' : 'opacity-0'"
  >
    <div
      class="flex h-[62%] w-[62%] flex-col items-center justify-center gap-3 rounded-[24px] border-2 border-dashed border-[#0A84FF]/70 bg-[#0A84FF]/[0.06]"
    >
      <span
        class="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#0A84FF]/15"
        :class="dragging ? 'lo-eye-float' : ''"
      >
        <AppIcon name="file-up" class="h-7 w-7 text-[#0A84FF]" :stroke-width="1.6" />
      </span>
      <p class="text-[17px] font-medium text-[#F5F5F7]">松手即可在本地打开</p>
      <p class="text-[12.5px] text-[#A1A1A6]">docx · xlsx · pptx · md · pdf，文件不会离开这台设备</p>
    </div>
  </div>
</template>
