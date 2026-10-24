<script setup lang="ts">
/**
 * 预览面板：用 @vue-office/* 只读渲染文档。
 *
 * 和编辑器（ONLYOFFICE）的区别：
 *   - 预览：秒开、体积小，**不能改**
 *   - 编辑：要加载 199 MB 的 WASM，但能改、能导出
 * 所以默认走预览，需要改的时候再切到编辑。
 */
import { ref, shallowRef, watch, type Component } from 'vue';
import type { OpenDoc } from '../lib/types';
import { canPreview, getPreviewComponent } from '../lib/preview';

const props = defineProps<{
  doc: OpenDoc | null;
}>();

const emit = defineEmits<{
  (e: 'error', message: string): void;
  (e: 'ready'): void;
}>();

const comp = shallowRef<Component | null>(null);
const loading = ref(false);
const failed = ref<string | null>(null);
/** 防竞态：快速切换文件时，先发起的那次加载回来不能覆盖新的 */
let generation = 0;

watch(
  () => props.doc,
  async (doc) => {
    const my = ++generation;
    comp.value = null;
    failed.value = null;

    if (!doc) return;

    if (!canPreview(doc.format)) {
      failed.value = `暂不支持预览 ${doc.format.toUpperCase()} 格式`;
      return;
    }

    loading.value = true;
    try {
      const c = await getPreviewComponent(doc.format);
      if (my !== generation) return;
      if (!c) {
        failed.value = `没有找到 ${doc.format.toUpperCase()} 的预览组件`;
        return;
      }
      comp.value = c;
      emit('ready');
    } catch (err) {
      if (my !== generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      failed.value = `预览组件加载失败：${msg}`;
      emit('error', failed.value);
    } finally {
      if (my === generation) loading.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="preview-pane">
    <div class="preview-loading" v-if="loading">正在加载预览组件…</div>

    <div class="preview-error" v-else-if="failed">
      <p>{{ failed }}</p>
      <p class="hint">可以切换到「编辑」模式再试，两者用的是不同的渲染内核。</p>
    </div>

    <component
      v-else-if="comp && doc"
      :is="comp"
      :src="doc.blob"
      class="preview-body"
    />
  </div>
</template>

<style scoped>
.preview-pane {
  height: 100%;
  overflow: auto;
  background: #f0f2f5;
}

.preview-body {
  display: block;
}

.preview-loading,
.preview-error {
  height: 100%;
  display: grid;
  place-content: center;
  text-align: center;
  gap: 8px;
  color: #6b7280;
  font-size: 14px;
  padding: 24px;
}

.preview-error p {
  margin: 0;
}

.preview-error .hint {
  font-size: 12px;
  color: #9aa3af;
}
</style>
