<script setup lang="ts">
/**
 * 工作台：三栏布局 + 文件流 + 状态提示。
 *
 * 这是唯一持有「会话状态」的地方（打开了哪些文件、当前是哪个、状态栏说什么）。
 * 子组件都是无状态的展示层，通过 props 拿数据、通过 emit 发意图 ——
 * 这样任何一个子组件都能单独拿出来测试或替换。
 */
import { computed, ref } from 'vue';
import TopBar from './components/TopBar.vue';
import FileSidebar from './components/FileSidebar.vue';
import EditorHost from './components/EditorHost.vue';
import StatusBar from './components/StatusBar.vue';
import AgentPanel from './components/AgentPanel.vue';
import { features } from './lib/features';
import { clearFatal, lastError } from './lib/errors';

/** 把错误信息复制到剪贴板，方便贴给开发者（比截图靠得住） */
async function copyError(): Promise<void> {
  const text = lastError.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    say('ok', '错误信息已复制到剪贴板');
  } catch {
    say('warn', '复制失败，请手动选中横幅里的文字');
  }
}
import { filesFromDrop, pickFiles, toOpenDoc } from './lib/openFile';
import { saveAs } from './lib/saveFile';
import type { OpenDoc, StatusLevel, StatusMessage } from './lib/types';

const files = ref<OpenDoc[]>([]);
const activeId = ref<number | null>(null);
const status = ref<StatusMessage | null>(null);
const editorRef = ref<InstanceType<typeof EditorHost> | null>(null);
const dragging = ref(false);
/**
 * 渲染模式。默认「预览」：用 @vue-office 秒开，不加载 199 MB 的编辑器。
 * 需要修改时再切「编辑」，那时才付出加载 ONLYOFFICE 的代价。
 */
const mode = ref<'preview' | 'edit'>('preview');

const activeDoc = computed(() => files.value.find((f) => f.id === activeId.value) ?? null);
const canSave = computed(() => activeDoc.value !== null);

function say(level: StatusLevel, text: string): void {
  status.value = { level, text, at: Date.now() };
}

/** 打开一批文件：逐个校验，能开的加进会话，不能开的把原因说清楚 */
async function openFiles(list: File[]): Promise<void> {
  if (!list.length) return;

  let added = 0;
  for (const file of list) {
    const outcome = await toOpenDoc(file);
    if (outcome.error) {
      say('error', outcome.error);
      continue;
    }
    if (outcome.doc) {
      files.value.push(outcome.doc);
      activeId.value = outcome.doc.id;
      added++;
      if (outcome.warning) say('warn', outcome.warning);
    }
  }

  if (added > 0) {
    say('ok', `已打开 ${added} 个文件（内容只在本地内存中，未上传）`);
  }
}

async function onOpen(): Promise<void> {
  const picked = await pickFiles();
  await openFiles(picked);
}

async function onSave(): Promise<void> {
  const doc = activeDoc.value;
  if (!doc) return;

  // 预览模式不产生新内容，「保存」等于「另存为原文件」——语义诚实，不假装编辑过
  if (mode.value === 'preview') {
    const name = saveAs(doc, doc.blob);
    say('ok', `已下载原文件：${name}（预览模式不会修改内容）`);
    return;
  }

  const result = await editorRef.value?.save();
  if (!result) {
    say('error', '编辑器未就绪，无法保存');
    return;
  }
  if (!result.ok || !result.blob) {
    say('error', result.message ?? '保存失败');
    return;
  }

  const name = saveAs(doc, result.blob);
  const changed = result.blob !== doc.blob;
  say('ok', changed ? `已保存并下载：${name}` : `已下载原文件：${name}（编辑器未改动内容）`);
}

function onSelect(id: number): void {
  activeId.value = id;
}

function onClose(id: number): void {
  const idx = files.value.findIndex((f) => f.id === id);
  if (idx < 0) return;
  files.value.splice(idx, 1);
  if (activeId.value === id) {
    activeId.value = files.value[Math.max(0, idx - 1)]?.id ?? null;
  }
}

/* ---- 拖放 ---- */
function onDragOver(e: DragEvent): void {
  e.preventDefault();
  dragging.value = true;
}
function onDragLeave(e: DragEvent): void {
  // 只有真正离开窗口才取消高亮，否则掠过子元素会闪
  if (e.relatedTarget === null) dragging.value = false;
}
async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  dragging.value = false;
  await openFiles(filesFromDrop(e));
}
</script>

<template>
  <div
    class="workbench"
    :class="{ dragging }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <TopBar
      :active-name="activeDoc?.name"
      :active-format="activeDoc?.format"
      :can-save="canSave"
      :mode="mode"
      @open="onOpen"
      @save="onSave"
      @update:mode="(m) => (mode = m)"
    />

    <div class="main" :data-cols="features.agentEnabled ? 'sidebar editor agent' : 'sidebar editor'">
      <FileSidebar :files="files" :active-id="activeId" @select="onSelect" @close="onClose" />
      <EditorHost
        ref="editorRef"
        :doc="activeDoc"
        :mode="mode"
        @error="(m) => say('error', m)"
        @hint="(m) => say('warn', m)"
      />
      <AgentPanel v-if="features.agentEnabled" :doc-name="activeDoc?.name" />
    </div>

    <StatusBar :message="status" :file-count="files.length" />

    <!-- 致命错误横幅：白屏是最差的失败方式，这里至少把原因完整说出来 -->
    <div class="fatal-banner" v-if="lastError">
      <span class="fatal-dot"></span>
      <span class="fatal-text">{{ lastError }}</span>
      <button class="fatal-copy" type="button" @click="copyError">复制</button>
      <button class="fatal-close" type="button" @click="clearFatal()">×</button>
    </div>

    <div class="drop-overlay" v-if="dragging">
      <p>松手即可打开</p>
    </div>
  </div>
</template>
