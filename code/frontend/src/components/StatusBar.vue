<script setup lang="ts">
/** 底部状态栏：一行字，告诉用户刚才发生了什么。 */
import type { StatusMessage } from '../lib/types';

defineProps<{
  message: StatusMessage | null;
  fileCount: number;
}>();
</script>

<template>
  <footer class="statusbar">
    <span class="dot" :data-level="message?.level ?? 'info'"></span>
    <span class="text">{{ message?.text ?? '就绪' }}</span>
    <span class="right">会话内 {{ fileCount }} 个文件 · 不上传任何数据</span>
  </footer>
</template>
