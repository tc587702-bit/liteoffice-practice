<script setup lang="ts">
/**
 * 左侧文件列表：本次会话打开过的文件（不是服务器上的文件 —— 没有服务器）。
 * 关闭标签只是从会话里移除，磁盘上的原文件不受影响。
 */
import type { OpenDoc } from '../lib/types';
import { formatSize } from '../lib/openFile';

defineProps<{
  files: OpenDoc[];
  activeId: number | null;
}>();

const emit = defineEmits<{
  (e: 'select', id: number): void;
  (e: 'close', id: number): void;
}>();
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">本次会话 <span class="count">{{ files.length }}</span></div>

    <ul class="file-list" v-if="files.length">
      <li
        v-for="f in files"
        :key="f.id"
        class="file-item"
        :class="{ active: f.id === activeId }"
        @click="emit('select', f.id)"
      >
        <span class="fmt" :data-fmt="f.format">{{ f.format }}</span>
        <span class="fname" :title="f.name">{{ f.name }}</span>
        <span class="fsize">{{ formatSize(f.size) }}</span>
        <button class="close" type="button" title="从会话中移除" @click.stop="emit('close', f.id)">×</button>
      </li>
    </ul>

    <p class="empty" v-else>
      还没有文件。<br />
      点「打开文件」，或把 .docx / .xlsx / .pptx 拖进窗口。
    </p>
  </aside>
</template>
