<script setup lang="ts">
/**
 * 编辑区宿主。两种模式：
 *   preview —— 用 @vue-office 只读预览（秒开，体积小）
 *   edit    —— 用 ONLYOFFICE 挂载编辑器（能改、能导出，但要加载 WASM）
 *
 * 职责边界：它只负责「给渲染内核一块 DOM」和「转发生命周期」，
 * 不知道具体用的是哪个内核 —— 那是 preview.ts 和 editorAdapter.ts 的事。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { OpenDoc, SaveResult } from '../lib/types';
import { createEditorAdapter, type EditorAdapter } from '../lib/editorAdapter';
import PreviewPane from './PreviewPane.vue';

const props = defineProps<{
  doc: OpenDoc | null;
  mode: 'preview' | 'edit';
}>();

const emit = defineEmits<{
  (e: 'error', message: string): void;
  (e: 'hint', message: string): void;
}>();

const hostEl = ref<HTMLElement | null>(null);
let adapter: EditorAdapter | null = null;
let generation = 0;

/**
 * 编辑器加载状态。
 *
 * 为什么要显示这个：编辑模式首次要下载约 199 MB（sdkjs + web-apps + 56 MB 的
 * x2t.wasm）。在局域网/同学电脑上，这段时间界面只是一块"点了没反应"的空区域，
 * 用户会以为坏了。把「正在加载 + 已用秒数 + 数据量说明」显示出来，
 * 才能区分「还在下载」和「真的失败」。
 */
const loadingEdit = ref(false);
const loadingSeconds = ref(0);
let loadingTimer: number | null = null;

function startLoading(): void {
  loadingEdit.value = true;
  loadingSeconds.value = 0;
  stopLoadingTimer();
  loadingTimer = window.setInterval(() => {
    loadingSeconds.value += 1;
  }, 1000);
}

function stopLoading(): void {
  loadingEdit.value = false;
  stopLoadingTimer();
}

function stopLoadingTimer(): void {
  if (loadingTimer !== null) {
    window.clearInterval(loadingTimer);
    loadingTimer = null;
  }
}

async function teardown(): Promise<void> {
  generation++;
  adapter?.dispose();
  adapter = null;
  hostEl.value?.replaceChildren();
  stopLoading();
}

/**
 * 装载。`generation` 防竞态：适配层的 open() 是异步的（要等 WASM 初始化），
 * 用户快速切换文件时，先发起的那次回来不能覆盖新文档。
 */
async function load(doc: OpenDoc | null, mode: 'preview' | 'edit'): Promise<void> {
  await teardown();

  if (!doc || mode !== 'edit') return;

  /*
   * md 没有编辑通道：ONLYOFFICE 内核只认 OOXML/ODF，
   * 把 md 的字节塞进 x2t 转换必然失败（表现为「异步任务出错」这种看不懂的报错）。
   * 所以在这里明确拦住并给出人话，而不是让它失败一次。
   */
  if (doc.format === 'md') {
    emit('hint', 'Markdown 暂不支持编辑：编辑内核只认 Office 格式，请用「预览」查看');
    return;
  }

  /*
   * 等布局稳定再挂载，这一步不能省。
   *
   * ONLYOFFICE 只在**初始化那一刻**测量容器尺寸，之后只有 window resize 才会重算。
   * 而 v-show 切过来时，浏览器还没完成布局，容器高度可能还是 0 ——
   * 编辑器就会按 0 尺寸初始化：工具栏出来了（它是流式布局），
   * 页面画布却永远画不出来，之后再怎么改 CSS 都不会恢复。
   * 所以这里等一个 tick + 两帧，确保拿到真实尺寸。
   */
  await nextTick();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  const host = hostEl.value;
  if (!host) return;

  const my = ++generation;
  const next = createEditorAdapter();
  adapter = next;
  startLoading();

  try {
    await next.open(doc, host);
    if (my !== generation) {
      next.dispose();
      return;
    }
    const hint = next.hint?.();
    if (hint) emit('hint', hint);
  } catch (err) {
    if (my === generation) {
      const msg = err instanceof Error ? err.message : String(err);
      emit('error', `编辑器装载失败：${msg}`);
    }
  } finally {
    if (my === generation) stopLoading();
  }
}

watch([() => props.doc, () => props.mode], ([doc, mode]) => void load(doc, mode), { immediate: true });

onBeforeUnmount(() => void teardown());

/** 供父组件调用：把编辑后的内容取回来 */
async function save(): Promise<SaveResult> {
  if (props.mode !== 'edit') {
    return { ok: false, message: '当前是预览模式，切到「编辑」后才能保存修改' };
  }
  if (!adapter) return { ok: false, message: '编辑器还没准备好' };
  return adapter.save();
}

defineExpose({ save });
</script>

<template>
  <section class="editor-host">
    <!-- 预览模式 -->
    <PreviewPane
      v-if="doc && mode === 'preview'"
      :doc="doc"
      @error="(m) => emit('error', m)"
    />

    <!-- 编辑模式的挂载点：用 v-show 保证元素始终存在，适配层才能拿到它 -->
    <div class="editor-mount" v-show="doc && mode === 'edit'" ref="hostEl"></div>

    <!-- 加载遮罩：首次要下 199 MB，不说明白用户只会觉得"点了没反应" -->
    <div class="editor-loading" v-if="loadingEdit">
      <div class="spin"></div>
      <p class="loading-title">正在加载编辑器…</p>
      <p class="loading-time">已等待 {{ loadingSeconds }} 秒</p>
      <p class="loading-note">
        首次使用需下载约 199 MB（编辑内核 + WASM），
        局域网或较慢的网络可能需要 1～3 分钟；之后会被浏览器缓存。
      </p>
      <p class="loading-note warn" v-if="loadingSeconds >= 60">
        超过 60 秒仍未完成。如果同学这台电脑内存较小或浏览器较旧，
        可能无法加载编辑内核 —— 可先用「预览」模式查看文档。
      </p>
    </div>

    <div class="editor-empty" v-if="!doc">
      <div class="empty-mark" aria-hidden="true">
        <span class="mark-dot"></span>
        <span class="mark-line"></span>
      </div>
      <h2 class="empty-title">打开一个文档</h2>
      <p class="empty-sub">拖进窗口，或点顶部「打开文件」</p>
      <p class="empty-note">docx&nbsp;&nbsp;·&nbsp;&nbsp;xlsx&nbsp;&nbsp;·&nbsp;&nbsp;pptx&nbsp;&nbsp;·&nbsp;&nbsp;md&nbsp;&nbsp;·&nbsp;&nbsp;pdf&nbsp;&nbsp;&nbsp;&nbsp;/&nbsp;&nbsp;&nbsp;&nbsp;文件不离开你的电脑</p>
    </div>
  </section>
</template>

<style scoped>
.editor-mount {
  height: 100%;
  width: 100%;
}
</style>
