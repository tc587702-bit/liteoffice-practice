<script setup lang="ts">
/**
 * 顶部工具栏：打开 / 保存 / 当前格式提示。
 * 只发事件，不碰业务逻辑 —— 这样它可以在任何页面复用。
 */
defineProps<{
  activeName?: string;
  activeFormat?: string;
  canSave: boolean;
  /** 当前渲染模式 */
  mode: 'preview' | 'edit';
}>();

const emit = defineEmits<{
  (e: 'open'): void;
  (e: 'save'): void;
  (e: 'update:mode', mode: 'preview' | 'edit'): void;
}>();
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo">LO</span>
      <span class="title">LiteOffice</span>
      <span class="subtitle">文件不上传 · 浏览器内编辑</span>
    </div>

    <div class="actions">
      <button class="btn primary" type="button" @click="emit('open')">打开文件</button>
      <button class="btn" type="button" :disabled="!canSave" @click="emit('save')">保存下载</button>
    </div>

    <!-- 预览 / 编辑 切换 -->
    <div class="mode-switch" v-if="activeName" role="group" aria-label="渲染模式">
      <button
        class="seg"
        type="button"
        :class="{ on: mode === 'preview' }"
        title="轻量预览，秒开，不能修改"
        @click="emit('update:mode', 'preview')"
      >
        预览
      </button>
      <button
        class="seg"
        type="button"
        :class="{ on: mode === 'edit' }"
        :disabled="activeFormat === 'md'"
        :title="
          activeFormat === 'md'
            ? 'Markdown 暂不支持编辑：编辑内核只认 Office 格式'
            : '加载完整编辑器，可以修改并导出（首次较慢）'
        "
        @click="emit('update:mode', 'edit')"
      >
        编辑
      </button>
    </div>

    <div class="current" v-if="activeName">
      <span class="badge" v-if="activeFormat">{{ activeFormat.toUpperCase() }}</span>
      <span class="name" :title="activeName">{{ activeName }}</span>
    </div>
    <div class="current muted" v-else>还没有打开文件</div>
  </header>
</template>
