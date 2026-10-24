<script setup lang="ts">
/**
 * Markdown 预览：解码 → 解析 → 渲染。
 *
 * 与 docx/xlsx/pptx 的预览组件接口保持一致（props 只有一个 `src: Blob`），
 * 这样 PreviewPane 不需要为 md 加任何分支 —— 它当作「又一个格式」用即可。
 *
 * 排版不追求 GitHub 全量：任务列表、脚注、Setext 标题、内嵌 HTML 块都不支持，
 * 解析器遇到会降级成纯文本。这一点要在界面上说清楚（见下方 note），
 * 不能让用户以为「支持 Markdown」就等于「和 GitHub 一样」。
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { Block } from '../lib/md/udm';
import { parseMarkdown } from '../lib/md/mdparse';
import { decodeTextFile } from '../lib/md/decodeText';
import { MdBody } from '../lib/md/MdBody';

const props = defineProps<{
  /** 由 PreviewPane 传入的原始文件内容 */
  src: Blob;
}>();

const emit = defineEmits<{
  (e: 'error', message: string): void;
  (e: 'ready'): void;
}>();

/** 块数上限：超长 md（例如误拖了日志）到此为止，避免一次渲染几十万个节点 */
const MAX_BLOCKS = 20000;

const blocks = shallowRef<Block[]>([]);
const loading = ref(false);
const failed = ref<string | null>(null);
/** 非致命的说明（编码、截断、解析告警），显示在正文顶部而非错误态 */
const notes = ref<string[]>([]);

/** 防竞态：连续切换文件时，先发起的那次回来不能覆盖新的 */
let generation = 0;

async function load(blob: Blob): Promise<void> {
  const my = ++generation;
  blocks.value = [];
  notes.value = [];
  failed.value = null;
  loading.value = true;

  try {
    const decoded = await decodeTextFile(blob);
    if (my !== generation) return;

    const parsed = parseMarkdown(decoded.text, { maxBlocks: MAX_BLOCKS });
    if (my !== generation) return;

    blocks.value = parsed.blocks;

    const localNotes: string[] = [];
    if (decoded.encoding !== 'utf-8') {
      localNotes.push(`按 ${decoded.encoding.toUpperCase()} 解码（未检测到 UTF-8 BOM，含非 UTF-8 字节）`);
    }
    if (decoded.truncated) {
      localNotes.push('文件超过 4 MB，只渲染了开头部分');
    }
    if (parsed.truncated) {
      localNotes.push(`文档超过 ${MAX_BLOCKS} 个块，只渲染了前面部分`);
    }
    for (const w of parsed.warnings.slice(0, 3)) localNotes.push(w);
    notes.value = localNotes;

    emit('ready');
  } catch (err) {
    if (my !== generation) return;
    const msg = err instanceof Error ? err.message : String(err);
    failed.value = `Markdown 解析失败：${msg}`;
    emit('error', failed.value);
  } finally {
    if (my === generation) loading.value = false;
  }
}

watch(() => props.src, (blob) => void load(blob), { immediate: true });

onBeforeUnmount(() => {
  generation++;
});
</script>

<template>
  <div class="md-pane">
    <div class="md-note" v-if="loading">正在解析 Markdown…</div>

    <div class="md-note error" v-else-if="failed">{{ failed }}</div>

    <template v-else>
      <div class="md-note" v-for="note in notes" :key="note">{{ note }}</div>
      <article class="md-view">
        <MdBody :blocks="blocks" />
      </article>
    </template>
  </div>
</template>

<style scoped>
.md-pane {
  height: 100%;
  overflow: auto;
  background: #fff;
}

.md-note {
  margin: 0;
  padding: 8px 32px;
  font-size: 12px;
  color: #92400e;
  background: #fffbeb;
  border-bottom: 1px solid #fde68a;
}

.md-note.error {
  color: #991b1b;
  background: #fef2f2;
  border-bottom-color: #fecaca;
}

.md-view {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 40px 64px;
  font-size: 15px;
  line-height: 1.75;
  color: #1f2328;
  word-wrap: break-word;
}

/* 标题 */
.md-view :deep(h1),
.md-view :deep(h2),
.md-view :deep(h3),
.md-view :deep(h4),
.md-view :deep(h5),
.md-view :deep(h6) {
  margin: 1.6em 0 0.6em;
  line-height: 1.3;
  font-weight: 600;
}

.md-view :deep(h1) {
  font-size: 1.9em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #e5e7eb;
}

.md-view :deep(h2) {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #eef0f3;
}

.md-view :deep(h3) {
  font-size: 1.25em;
}
.md-view :deep(h4) {
  font-size: 1.1em;
}
.md-view :deep(h5) {
  font-size: 1em;
}
.md-view :deep(h6) {
  font-size: 0.95em;
  color: #57606a;
}

.md-view :deep(p) {
  margin: 0.8em 0;
}

/* 列表：解析器输出扁平段落，这里用缩进 + marker 还原视觉层级 */
.md-view :deep(.md-li) {
  margin: 0.25em 0;
  display: flex;
  align-items: baseline;
  gap: 0.5em;
}

.md-view :deep(.md-marker) {
  flex: 0 0 auto;
  min-width: 1.4em;
  color: #57606a;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 代码 */
.md-view :deep(code) {
  font-family: Consolas, 'SFMono-Regular', Menlo, monospace;
  font-size: 0.88em;
  background: #f3f4f6;
  border-radius: 4px;
  padding: 0.15em 0.4em;
}

.md-view :deep(pre) {
  margin: 1em 0;
  padding: 14px 16px;
  overflow: auto;
  background: #f6f8fa;
  border: 1px solid #eaeef2;
  border-radius: 8px;
  line-height: 1.55;
  position: relative;
}

/* 有语言标注时在右上角显示，提醒"这不是段落，是代码" */
.md-view :deep(pre[data-lang])::before {
  content: attr(data-lang);
  position: absolute;
  top: 6px;
  right: 10px;
  font-size: 11px;
  color: #8b949e;
  text-transform: lowercase;
  pointer-events: none;
}

.md-view :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.86em;
  white-space: pre;
}

/* 引用 */
.md-view :deep(blockquote) {
  margin: 1em 0;
  color: #57606a;
}

.md-view :deep(blockquote p) {
  margin: 0.3em 0;
}

/* 表格 */
.md-view :deep(.md-table) {
  border-collapse: collapse;
  margin: 1em 0;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}

.md-view :deep(.md-table th),
.md-view :deep(.md-table td) {
  border: 1px solid #d0d7de;
  padding: 6px 12px;
  text-align: left;
  vertical-align: top;
}

.md-view :deep(.md-table thead th) {
  background: #f6f8fa;
  font-weight: 600;
}

.md-view :deep(.md-table p) {
  margin: 0;
}

/* 其它 */
.md-view :deep(.md-rule) {
  border: 0;
  border-top: 1px solid #d8dee4;
  margin: 1.6em 0;
}

.md-view :deep(.md-pagebreak) {
  border: 0;
  border-top: 2px dashed #d8dee4;
  margin: 2em 0;
}

.md-view :deep(.md-img),
.md-view :deep(.md-img-block) {
  color: #57606a;
  background: #f6f8fa;
  border: 1px dashed #d0d7de;
  border-radius: 6px;
  padding: 0.1em 0.5em;
  font-size: 0.9em;
}

.md-view :deep(a) {
  color: #0969da;
  text-decoration: none;
}

.md-view :deep(a:hover) {
  text-decoration: underline;
}

.md-view :deep(s) {
  color: #6b7280;
}

.md-view :deep(u) {
  text-decoration: underline;
}
</style>
