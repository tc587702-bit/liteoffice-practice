<script setup lang="ts">
/**
 * 纯 vue-office 演示页 —— 与 LiteOffice 无关。
 *
 * 目的：只用 @vue-office/* 三个组件，验证「选一个文件 → 在网页里渲染出来」。
 * 没有 ONLYOFFICE、没有编辑器、没有文件列表，就是一个最小组件用法示例。
 *
 * 三种格式的用法完全一致：把文件（File / Blob / ArrayBuffer / URL）交给 `src`。
 */
import { ref, shallowRef, type Component } from 'vue';

type Kind = 'docx' | 'xlsx' | 'pptx' | 'pdf';

const comp = shallowRef<Component | null>(null);
const fileName = ref('');
const kind = ref<Kind | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const dragging = ref(false);
/** 交给组件的源：直接用 Blob，vue-office 内部会自己读 */
const src = ref<Blob | null>(null);

/**
 * 三个包都按需 import：打开 docx 不会去下载 excel 的 13 MB。
 * 这也是官方推荐用法之外唯一值得强调的点 —— 体积差很大。
 */
async function load(k: Kind): Promise<Component> {
  if (k === 'docx') {
    const [mod] = await Promise.all([
      import('@vue-office/docx'),
      import('@vue-office/docx/lib/index.css'),
    ]);
    return mod.default as Component;
  }
  if (k === 'xlsx') {
    const [mod] = await Promise.all([
      import('@vue-office/excel'),
      import('@vue-office/excel/lib/index.css'),
    ]);
    return mod.default as Component;
  }
  if (k === 'pptx') {
    const mod = await import('@vue-office/pptx');
    return mod.default as Component;
  }
  // pdf 包不带样式文件，只引 js
  const mod = await import('@vue-office/pdf');
  return mod.default as Component;
}

function pick(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.docx,.xlsx,.pptx,.pdf';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void render(f);
  };
  input.click();
}

async function render(file: File): Promise<void> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (ext !== 'docx' && ext !== 'xlsx' && ext !== 'pptx' && ext !== 'pdf') {
    error.value = `只支持 .docx / .xlsx / .pptx / .pdf，这个文件是 .${ext}`;
    return;
  }

  error.value = null;
  loading.value = true;
  comp.value = null;
  fileName.value = file.name;

  try {
    const c = await load(ext);
    kind.value = ext;
    src.value = file;
    comp.value = c;
  } catch (err) {
    error.value = `加载渲染器失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    loading.value = false;
  }
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  dragging.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) void render(f);
}
</script>

<template>
  <div
    class="page"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop="onDrop"
  >
    <header class="bar">
      <strong>vue-office 演示</strong>
      <span class="muted">只读渲染 · 纯前端 · 文件不上传</span>
      <button class="btn" type="button" @click="pick">选择文件</button>
      <span class="muted" v-if="fileName">{{ kind?.toUpperCase() }} · {{ fileName }}</span>
    </header>

    <main class="body">
      <div class="hint" v-if="!comp && !loading && !error">
        <p class="big">把一个 .docx / .xlsx / .pptx / .pdf 拖进来</p>
        <p>或者点右上角「选择文件」</p>
      </div>

      <div class="hint" v-if="loading">正在加载渲染器…</div>

      <div class="hint err" v-if="error">
        <p>{{ error }}</p>
      </div>

      <component :is="comp" v-if="comp && src" :src="src" class="render" />

      <div class="overlay" v-if="dragging">松手即可渲染</div>
    </main>
  </div>
</template>

<style>
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  background: #eef0f3;
  color: #1f2733;
}
</style>

<style scoped>
.page {
  height: 100vh;
  display: grid;
  grid-template-rows: 48px 1fr;
  position: relative;
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: #fff;
  border-bottom: 1px solid #e3e6ea;
  font-size: 14px;
}

.muted {
  color: #6b7280;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn {
  margin-left: auto;
  height: 30px;
  padding: 0 14px;
  border: 1px solid #2563eb;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.body {
  overflow: auto;
  position: relative;
  padding: 12px;
}

.hint {
  height: 100%;
  display: grid;
  place-content: center;
  text-align: center;
  gap: 6px;
  color: #6b7280;
}

.hint .big {
  font-size: 17px;
  color: #1f2733;
  margin: 0;
}

.hint.err {
  color: #dc2626;
}

.render {
  display: block;
  background: #fff;
  min-height: 200px;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(37, 99, 235, 0.08);
  border: 2px dashed #2563eb;
  color: #2563eb;
  font-size: 16px;
  pointer-events: none;
}
</style>
