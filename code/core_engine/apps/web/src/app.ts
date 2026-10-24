/**
 * Web 壳的应用逻辑：多标签、打开文件、大纲/信息侧栏、搜索、缩放、内存 HUD。
 *
 * 设计上刻意把「DOM 壳」和「文档能力」分开：
 *   - 文档能力全在 packages/render-dom 的 Viewer 接口后面（壳不认识 docx/pdf）
 *   - 壳只负责标签管理、命令派发、状态展示
 * 这样新增文档类别（例如 .numbers）时，壳一行都不用改。
 */
import { FORMATS, formatSpec, memSnapshot, formatBytes, estimateBytes } from '../../../packages/core/src/index.ts';
import type { LiteDocument, OutlineItem, FormatId } from '../../../packages/core/src/index.ts';
import { openBlob } from '../../../packages/engine/src/index.ts';
import { createViewer } from '../../../packages/render-dom/src/index.ts';
import type { Viewer } from '../../../packages/render-dom/src/index.ts';
import { formatSupportGroups, formatSupportSummary, friendlyOpenError, readersStatusText, registerAllReaders } from './format-registry.ts';
import type { ReaderInstall } from './format-registry.ts';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const HUD_INTERVAL_MS = 1000;

interface TabState {
  id: number;
  name: string;
  doc: LiteDocument;
  viewer: Viewer;
  host: HTMLElement;
  zoom: number;
  /** 当前搜索词与命中位置（用于「第 n / 共 m 个」） */
  query: string;
  hitIndex: number;
  hitTotal: number;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少必需的 DOM 节点：#${id}`);
  return el;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class LiteOfficeApp {
  private readonly tabsBar: HTMLElement;
  private readonly views: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCount: HTMLElement;
  private readonly zoomRange: HTMLInputElement;
  private readonly zoomLabel: HTMLElement;
  private readonly statusMessage: HTMLElement;
  private readonly statusReaders: HTMLElement;
  private readonly hudSource: HTMLElement;
  private readonly hudModel: HTMLElement;
  private readonly hudRatio: HTMLElement;
  private readonly hudHeap: HTMLElement;
  private readonly hudNodes: HTMLElement;
  private readonly hudDocs: HTMLElement;
  private readonly panelOutline: HTMLElement;
  private readonly panelInfo: HTMLElement;
  private readonly panelTabOutline: HTMLElement;
  private readonly panelTabInfo: HTMLElement;
  private readonly formatsPanel: HTMLElement;
  private readonly formatsBody: HTMLElement;
  private readonly formatsSummary: HTMLElement;
  private readonly dropHint: HTMLElement;
  private readonly emptyFormats: HTMLElement;

  private readonly tabsList: TabState[] = [];
  private activeId = -1;
  private nextId = 1;
  private installs: ReaderInstall[] = [];
  private hudTimer: ReturnType<typeof setInterval> | null = null;
  private dragDepth = 0;

  constructor() {
    this.tabsBar = $('tabs');
    this.views = $('views');
    this.emptyState = $('empty-state');
    this.searchInput = $('search-input') as HTMLInputElement;
    this.searchCount = $('search-count');
    this.zoomRange = $('zoom-range') as HTMLInputElement;
    this.zoomLabel = $('zoom-reset');
    this.statusMessage = $('status-message');
    this.statusReaders = $('status-readers');
    this.hudSource = $('hud-source');
    this.hudModel = $('hud-model');
    this.hudRatio = $('hud-ratio');
    this.hudHeap = $('hud-heap');
    this.hudNodes = $('hud-nodes');
    this.hudDocs = $('hud-docs');
    this.panelOutline = $('panel-outline');
    this.panelInfo = $('panel-info');
    this.panelTabOutline = $('panel-tab-outline');
    this.panelTabInfo = $('panel-tab-info');
    this.formatsPanel = $('formats-panel');
    this.formatsBody = $('formats-body');
    this.formatsSummary = $('formats-summary');
    this.dropHint = $('drop-hint');
    this.emptyFormats = $('empty-formats');
  }

  /* ================================================================== */
  /* 启动                                                               */
  /* ================================================================== */

  async start(): Promise<void> {
    this.bindToolbar();
    this.bindDropZone();
    this.bindKeyboard();
    this.applyStoredTheme();

    this.setStatus('正在注册格式读取器…');
    this.installs = await registerAllReaders();
    const summary = formatSupportSummary(this.installs);
    this.statusReaders.textContent = readersStatusText(this.installs);
    this.statusReaders.title = this.installs
      .map((i) => `${i.ok ? '✔' : '✘'} ${i.pkg}${i.ok ? '' : `（未安装：${i.error ?? '未知原因'}）`}`)
      .join('\n');
    this.renderEmptyFormats();
    this.renderFormatsPanel();
    this.setStatus(
      summary.installedReaders === 0
        ? '已安装 0 个格式读取器（读取器包仍在开发中，当前无法解析任何文件）'
        : `已安装 ${summary.installedReaders} 个格式读取器，支持 ${summary.supported}/${summary.total} 种格式`,
    );

    this.startHud();
    this.renderTabs();
    this.renderPanels();
    this.updateHud();
  }

  /* ================================================================== */
  /* 打开文件                                                           */
  /* ================================================================== */

  private bindToolbar(): void {
    $('btn-open').addEventListener('click', () => void this.openViaPicker());
    $('btn-formats').addEventListener('click', () => this.toggleFormatsPanel(true));
    $('formats-close').addEventListener('click', () => this.toggleFormatsPanel(false));
    this.formatsPanel.addEventListener('click', (ev) => {
      if (ev.target === this.formatsPanel) this.toggleFormatsPanel(false);
    });
    $('btn-theme').addEventListener('click', () => this.toggleTheme());

    this.searchInput.addEventListener('input', () => {
      // 输入即定位第一个命中，符合办公软件的直觉
      this.runSearch(0);
    });
    this.searchInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.runSearch(this.activeTab()?.hitIndex !== undefined ? (this.activeTab() as TabState).hitIndex + 1 : 0);
      }
    });
    $('search-next').addEventListener('click', () => {
      const tab = this.activeTab();
      this.runSearch(tab ? tab.hitIndex + 1 : 0);
    });

    $('zoom-in').addEventListener('click', () => this.nudgeZoom(0.1));
    $('zoom-out').addEventListener('click', () => this.nudgeZoom(-0.1));
    this.zoomRange.addEventListener('input', () => this.setZoom(Number(this.zoomRange.value) / 100));
    $('zoom-reset').addEventListener('click', () => this.setZoom(1));

    this.panelTabOutline.addEventListener('click', () => this.selectPanel('outline'));
    this.panelTabInfo.addEventListener('click', () => this.selectPanel('info'));

    // Ctrl+滚轮缩放（浏览器把它当页面缩放，必须 preventDefault）
    this.views.addEventListener(
      'wheel',
      (ev) => {
        if (!ev.ctrlKey) return;
        ev.preventDefault();
        this.nudgeZoom(ev.deltaY < 0 ? 0.1 : -0.1);
      },
      { passive: false },
    );
  }

  private bindDropZone(): void {
    // 用计数器而不是布尔值：拖过子元素时 dragleave 会先于 dragenter 触发，
    // 用布尔值会出现提示层疯狂闪烁。
    const show = (): void => this.dropHint.classList.remove('is-hidden');
    const hide = (): void => {
      this.dragDepth = 0;
      this.dropHint.classList.add('is-hidden');
    };
    window.addEventListener('dragenter', (ev) => {
      if (!this.hasFiles(ev)) return;
      ev.preventDefault();
      this.dragDepth++;
      show();
    });
    window.addEventListener('dragover', (ev) => {
      if (!this.hasFiles(ev)) return;
      ev.preventDefault(); // 不阻止默认行为的话 drop 事件不会触发
    });
    window.addEventListener('dragleave', (ev) => {
      if (!this.hasFiles(ev)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) hide();
    });
    window.addEventListener('drop', (ev) => {
      if (!this.hasFiles(ev)) return;
      ev.preventDefault();
      hide();
      const files = Array.from(ev.dataTransfer?.files ?? []);
      void this.openFiles(files);
    });
  }

  private hasFiles(ev: DragEvent): boolean {
    const dt = ev.dataTransfer;
    if (!dt) return false;
    // types 在 dragenter 阶段就能拿到（items 常常还看不到）
    return Array.from(dt.types ?? []).includes('Files');
  }

  /**
   * 打开多个文件。
   *
   * 逐个 try/catch：一个文件失败不能影响其他文件（用户拖了 5 个，不该因为
   * 其中 1 个是旧版 .doc 就一个都不开）。
   */
  private async openFiles(files: readonly (Blob & { name?: string })[]): Promise<void> {
    if (files.length === 0) return;
    let ok = 0;
    const errors: string[] = [];
    for (const file of files) {
      try {
        this.setStatus(`正在解析 ${file.name ?? '未命名'}…`);
        const started = performance.now();
        const result = await openBlob(file as Blob & { name: string });
        const elapsed = Math.round(performance.now() - started);
        this.addTab(result.document, file.name ?? '未命名');
        ok++;
        this.setStatus(`已打开 ${file.name ?? '未命名'}（${elapsed} ms，${result.sniff.spec.label}）`);
      } catch (err) {
        const name = file.name ?? '未命名';
        const message = friendlyOpenError(err);
        errors.push(`${name}：${message}`);
        this.setStatus(`${name} 打开失败：${message}`, true);
      }
    }
    if (errors.length > 0 && ok === 0) {
      this.setStatus(errors[0], true);
    } else if (errors.length > 0) {
      this.setStatus(`成功打开 ${ok} 个，失败 ${errors.length} 个：${errors[0]}`, true);
    }
  }

  /**
   * 「打开」按钮。
   *
   * 优先 File System Access API：它能拿到真实文件名与句柄（可以后续「保存」），
   * 但它不是所有浏览器都有（Firefox/Safari 没有）。缺失时静默回退到
   * <input type="file">，绝不因为 API 不存在而报错。
   */
  private async openViaPicker(): Promise<void> {
    const picker = (globalThis as unknown as {
      showOpenFilePicker?: (opts: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
    }).showOpenFilePicker;

    if (typeof picker === 'function') {
      try {
        const handles = await picker({
          multiple: true,
          types: [{ description: '文档', accept: { 'application/octet-stream': buildAcceptExtensions() } }],
        });
        const files: File[] = [];
        for (const h of handles) files.push(await h.getFile());
        await this.openFiles(files);
        return;
      } catch (err) {
        // 用户取消（AbortError）不是错误，静默返回
        if ((err as { name?: string })?.name === 'AbortError') return;
        // 其他失败（例如权限/不支持的类型过滤）回退到 input
        this.setStatus('文件选择器不可用，改用系统文件对话框');
      }
    }
    this.openViaInput();
  }

  private openViaInput(): void {
    const input = el('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = buildAcceptAttribute();
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      void this.openFiles(files);
    });
    input.click();
  }

  /* ================================================================== */
  /* 标签页                                                             */
  /* ================================================================== */

  private addTab(doc: LiteDocument, name: string): TabState {
    const host = el('div', 'view-host');
    this.views.appendChild(host);
    const viewer = createViewer(doc);
    viewer.mount(host);
    const tab: TabState = { id: this.nextId++, name, doc, viewer, host, zoom: 1, query: '', hitIndex: 0, hitTotal: 0 };
    this.tabsList.push(tab);
    this.activate(tab.id);
    return tab;
  }

  private activeTab(): TabState | undefined {
    return this.tabsList.find((t) => t.id === this.activeId);
  }

  private activate(id: number): void {
    if (id === this.activeId) return;
    this.activeId = id;
    for (const tab of this.tabsList) {
      const on = tab.id === id;
      // 用 class 控制显隐而不是销毁重建：切回来的标签保持滚动位置与缩放
      tab.host.classList.toggle('is-hidden', !on);
      if (!on) tab.viewer.unmount?.();
    }
    const tab = this.activeTab();
    if (tab) {
      // Viewer 在 unmount 时会把根元素摘下来，切回时必须重新挂载
      if (!tab.host.contains(tab.viewer.element)) tab.viewer.mount(tab.host);
      tab.viewer.setZoom(tab.zoom);
      tab.viewer.setAvailableWidth(this.views.clientWidth);
      this.searchInput.value = tab.query;
      this.syncZoomUi(tab.zoom);
      this.searchCount.textContent = tab.hitTotal > 0 ? `第 ${tab.hitIndex + 1} / 共 ${tab.hitTotal} 个` : '';
    }
    this.emptyState.classList.toggle('is-hidden', this.tabsList.length > 0);
    this.renderTabs();
    this.renderPanels();
    this.updateHud();
  }

  private closeTab(id: number): void {
    const index = this.tabsList.findIndex((t) => t.id === id);
    if (index < 0) return;
    const tab = this.tabsList[index];
    tab.viewer.dispose();
    tab.host.remove();
    this.tabsList.splice(index, 1);
    // 关闭时必须释放模型里的图片字节等大块内存 —— 这是「低内存」主张的一部分，
    // 所以状态栏会把这个动作明确说出来。
    tab.doc.dispose();
    const freed = estimateBytes({ blocks: tab.doc.blocks?.length ?? 0, sheets: tab.doc.sheets?.length ?? 0, slides: tab.doc.slides?.length ?? 0, pages: tab.doc.pages?.length ?? 0 });
    this.setStatus(`已关闭 ${tab.name}，并已调用 doc.dispose() 释放模型持有的字节（图片等）`);

    if (this.activeId === id) {
      this.activeId = -1;
      const next = this.tabsList[Math.max(0, index - 1)];
      if (next) this.activate(next.id);
      else {
        this.emptyState.classList.remove('is-hidden');
        this.searchInput.value = '';
        this.searchCount.textContent = '';
        this.renderPanels();
      }
    }
    this.renderTabs();
    this.updateHud();
    void freed;
  }

  private renderTabs(): void {
    this.tabsBar.replaceChildren();
    for (const tab of this.tabsList) {
      const node = el('div', 'tab');
      node.setAttribute('role', 'tab');
      node.title = tab.name;
      if (tab.id === this.activeId) node.classList.add('is-active');

      const name = el('span', 'tab-name', tab.name);
      node.appendChild(name);
      const badge = el('span', 'tab-badge', tab.doc.formatLabel);
      node.appendChild(badge);

      const close = el('button', 'tab-close', '×');
      close.type = 'button';
      close.title = `关闭 ${tab.name}（释放内存）`;
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.closeTab(tab.id);
      });
      node.appendChild(close);

      node.addEventListener('click', () => this.activate(tab.id));
      this.tabsBar.appendChild(node);
    }
  }

  /* ================================================================== */
  /* 侧栏：大纲 / 文档信息                                              */
  /* ================================================================== */

  private selectPanel(which: 'outline' | 'info'): void {
    const outline = which === 'outline';
    this.panelTabOutline.classList.toggle('is-active', outline);
    this.panelTabInfo.classList.toggle('is-active', !outline);
    this.panelOutline.classList.toggle('is-hidden', !outline);
    this.panelInfo.classList.toggle('is-hidden', outline);
  }

  private renderPanels(): void {
    this.renderOutline();
    this.renderInfo();
  }

  private renderOutline(): void {
    this.panelOutline.replaceChildren();
    const tab = this.activeTab();
    if (!tab) {
      this.panelOutline.appendChild(el('p', 'muted', '尚未打开文档。'));
      return;
    }
    const outline = tab.doc.outline;
    if (outline.length === 0) {
      this.panelOutline.appendChild(el('p', 'muted', '该文档没有可用大纲。'));
      return;
    }
    const flat = flattenOutline(outline);
    for (const item of flat) {
      const btn = el('button', 'outline-item', item.text || '（无标题）');
      btn.type = 'button';
      // 缩进表示层级；大纲面板不做折叠树（办公软件的导航窗格也是平铺更常见）
      (btn as HTMLElement).style.paddingLeft = `${6 + (item.level - 1) * 12}px`;
      btn.title = item.text;
      if (item.target) {
        const target = item.target;
        btn.addEventListener('click', () => tab.viewer.scrollTo(target));
      } else {
        btn.disabled = true;
      }
      this.panelOutline.appendChild(btn);
    }
  }

  private renderInfo(): void {
    this.panelInfo.replaceChildren();
    const tab = this.activeTab();
    if (!tab) {
      this.panelInfo.appendChild(el('p', 'muted', '尚未打开文档。'));
      return;
    }
    const doc = tab.doc;
    const stats = doc.stats;

    // ---- 格式徽标 + 关键统计 ----
    const head = el('div', 'info-block');
    head.appendChild(el('span', 'badge', doc.formatLabel));
    const kv = (parent: HTMLElement, key: string, value: string): void => {
      const row = el('div', 'kv');
      row.appendChild(el('span', 'kv-key', key));
      const v = el('span', 'kv-val', value);
      row.appendChild(v);
      parent.appendChild(row);
    };

    kv(head, '文件名', doc.name);
    kv(head, '格式 id', doc.format);
    kv(head, '类别', String(doc.kind));
    this.panelInfo.appendChild(head);

    // ---- 内存/耗时：这是产品主张的核心数字，放在最显眼的位置 ----
    const mem = el('div', 'info-block');
    mem.appendChild(el('h3', undefined, '内存与耗时'));
    kv(mem, '解析耗时', `${stats.parseMs.toFixed(1)} ms`);
    kv(mem, '源文件大小', formatBytes(stats.sourceBytes));
    kv(mem, '模型大小（估算）', formatBytes(stats.modelBytes));
    // 比值 > 1 表示模型比源文件还大（文本类很常见：压缩后的源文件 vs 展开后的字符串）
    const ratio = stats.sourceBytes > 0 ? stats.modelBytes / stats.sourceBytes : 0;
    kv(mem, '模型 / 源文件', stats.sourceBytes > 0 ? `${ratio.toFixed(2)}×` : '—');
    if (stats.imageBytes > 0) kv(mem, '图片字节', formatBytes(stats.imageBytes));
    this.panelInfo.appendChild(mem);

    // ---- 内容规模 ----
    const counts = el('div', 'info-block');
    counts.appendChild(el('h3', undefined, '内容规模'));
    kv(counts, '块（段落/表格）', String(stats.blockCount));
    kv(counts, '单元格', String(stats.cellCount));
    kv(counts, '形状', String(stats.shapeCount));
    kv(counts, '图片', String(stats.imageCount));
    if (doc.sheets) kv(counts, '工作表', String(doc.sheets.length));
    if (doc.slides) kv(counts, '幻灯片', String(doc.slides.length));
    if (doc.pages) kv(counts, 'PDF 页', String(doc.pages.length));
    if (stats.phases) {
      const phases = Object.entries(stats.phases);
      if (phases.length > 0) {
        kv(counts, '阶段耗时', phases.map(([k, v]) => `${k} ${v.toFixed(0)}ms`).join(' · '));
      }
    }
    this.panelInfo.appendChild(counts);

    // ---- meta ----
    const metas = Object.entries(doc.meta).filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
    if (metas.length > 0) {
      const metaBlock = el('div', 'info-block');
      metaBlock.appendChild(el('h3', undefined, '文档属性'));
      for (const [key, value] of metas) {
        if (key === 'custom' || key === 'margin') continue;
        kv(metaBlock, key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      this.panelInfo.appendChild(metaBlock);
    }

    // ---- 截断与降级：绝不藏起来 ----
    if (stats.truncated.length > 0) {
      const notice = el('div', 'notice');
      notice.appendChild(el('strong', undefined, '⚠ 内容已被截断（你看到的不是全部）'));
      const ul = el('ul');
      for (const t of stats.truncated) ul.appendChild(el('li', undefined, labelTruncated(t)));
      notice.appendChild(ul);
      this.panelInfo.appendChild(notice);
    }
    if (stats.warnings.length > 0) {
      const warn = el('div', 'notice');
      warn.appendChild(el('strong', undefined, `降级处理提示（${stats.warnings.length} 条）`));
      const ul = el('ul');
      for (const w of stats.warnings.slice(0, 20)) ul.appendChild(el('li', undefined, w));
      if (stats.warnings.length > 20) ul.appendChild(el('li', undefined, `…还有 ${stats.warnings.length - 20} 条`));
      warn.appendChild(ul);
      this.panelInfo.appendChild(warn);
    }
  }

  /* ================================================================== */
  /* 搜索                                                              */
  /* ================================================================== */

  private runSearch(from: number): void {
    const tab = this.activeTab();
    if (!tab) return;
    const query = this.searchInput.value;
    tab.query = query;
    if (!query) {
      tab.hitTotal = 0;
      tab.hitIndex = 0;
      tab.viewer.search('');
      this.searchCount.textContent = '';
      return;
    }
    const result = tab.viewer.search(query, from);
    if (!result) {
      tab.hitTotal = 0;
      tab.hitIndex = 0;
      this.searchCount.textContent = '无命中';
      return;
    }
    tab.hitIndex = result.index;
    tab.hitTotal = result.total;
    this.searchCount.textContent = `第 ${result.index + 1} / 共 ${result.total} 个`;
    this.updateHud();
  }

  /* ================================================================== */
  /* 缩放                                                              */
  /* ================================================================== */

  private nudgeZoom(delta: number): void {
    const tab = this.activeTab();
    if (!tab) return;
    this.setZoom(tab.zoom + delta);
  }

  private setZoom(zoom: number): void {
    const tab = this.activeTab();
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
    if (!tab) {
      this.syncZoomUi(clamped);
      return;
    }
    // 夹到整数百分比，避免出现 133.20000000000002% 这种显示
    tab.zoom = Math.round(clamped * 100) / 100;
    tab.viewer.setZoom(tab.zoom);
    this.syncZoomUi(tab.zoom);
  }

  private syncZoomUi(zoom: number): void {
    this.zoomRange.value = String(Math.round(zoom * 100));
    this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  /* ================================================================== */
  /* 内存 HUD                                                          */
  /* ================================================================== */

  private startHud(): void {
    if (this.hudTimer !== null) return;
    this.hudTimer = setInterval(() => {
      // 页面不可见时暂停：后台标签页里每 100ms 算一次节点数纯属浪费电
      if (document.visibilityState === 'hidden') return;
      this.updateHud();
    }, HUD_INTERVAL_MS);
    // Node 下（测试）定时器会拖住事件循环，导致测试进程跑完不退出。
    // 浏览器返回 number，没有 unref，所以先判断再调用。
    const timer = this.hudTimer as unknown as { unref?: () => void };
    timer.unref?.();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.updateHud();
    });
  }

  private stopHud(): void {
    if (this.hudTimer !== null) clearInterval(this.hudTimer);
    this.hudTimer = null;
  }

  private updateHud(): void {
    const tab = this.activeTab();
    const stats = tab?.doc.stats;
    this.hudSource.textContent = stats && stats.sourceBytes > 0 ? formatBytes(stats.sourceBytes) : '—';
    this.hudModel.textContent = stats && stats.modelBytes > 0 ? formatBytes(stats.modelBytes) : '—';
    this.hudRatio.textContent = stats && stats.sourceBytes > 0 && stats.modelBytes > 0 ? `${(stats.modelBytes / stats.sourceBytes).toFixed(2)}×` : '—';

    // performance.memory 只在 Chromium 系可用；不可用时如实显示「不可用」，
    // 绝不显示 0 —— 那会让人以为「内存占用为 0」。
    const snap = memSnapshot();
    if (snap.source === 'unavailable') {
      this.hudHeap.textContent = '不可用';
      this.hudHeap.title = '当前浏览器不提供 performance.memory（仅 Chromium 系支持）';
    } else {
      this.hudHeap.textContent = formatBytes(snap.heapUsedBytes);
      this.hudHeap.title = snap.source === 'performance.memory' ? '来自 performance.memory（Chrome 会降低精度）' : '来自 process.memoryUsage()';
    }

    // 虚拟化的可见证据：当前实际存在的 DOM 节点数
    this.hudNodes.textContent = tab ? String(tab.viewer.renderedNodes) : '0';
    this.hudDocs.textContent = String(this.tabsList.length);
  }

  /* ================================================================== */
  /* 格式支持面板 / 空状态 / 主题                                        */
  /* ================================================================== */

  private toggleFormatsPanel(open: boolean): void {
    this.formatsPanel.classList.toggle('is-hidden', !open);
  }

  private renderFormatsPanel(): void {
    const summary = formatSupportSummary(this.installs);
    const installed = this.installs.filter((i) => i.ok).map((i) => i.pkg);
    this.formatsSummary.textContent =
      `${FORMATS.filter((f) => f.id !== 'unknown').length} 种格式声明 · 已安装 ${summary.installedReaders} 个读取器`
      + `（${installed.length > 0 ? installed.join('、') : '无'}）· 当前可打开 ${summary.supported} 种`;

    this.formatsBody.replaceChildren();
    for (const group of formatSupportGroups()) {
      if (group.rows.length === 0) continue;
      const box = el('div', 'format-group');
      box.appendChild(el('h3', undefined, group.title));
      for (const row of group.rows) {
        const line = el('div', 'format-row');
        line.appendChild(el('span', 'format-ext', row.spec.extensions.map((e) => `.${e}`).join(' ') || row.spec.id));
        line.appendChild(el('span', 'format-label', row.spec.label));
        const status = el('span', `format-status ${row.supported ? 'is-ok' : 'is-missing'}`, row.supported ? '已支持' : '未安装读取器');
        line.appendChild(status);
        box.appendChild(line);
      }
      this.formatsBody.appendChild(box);
    }
  }

  private renderEmptyFormats(): void {
    this.emptyFormats.replaceChildren();
    const summary = formatSupportSummary(this.installs);
    for (const spec of FORMATS) {
      if (spec.id === 'unknown') continue;
      const ext = spec.extensions[0];
      if (!ext) continue;
      const chip = el('span', 'empty-chip', summary.missing.includes(spec.id) ? `.${ext}（未安装读取器）` : `.${ext} ${spec.label}`);
      if (!summary.missing.includes(spec.id)) chip.classList.add('is-supported');
      this.emptyFormats.appendChild(chip);
    }
  }

  private applyStoredTheme(): void {
    let theme = 'light';
    try {
      theme = localStorage.getItem('liteoffice.theme') ?? 'light';
    } catch {
      /* 隐私模式下 localStorage 会抛错，忽略即可 */
    }
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  private toggleTheme(): void {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('liteoffice.theme', next);
    } catch {
      /* 忽略 */
    }
  }

  /* ================================================================== */
  /* 杂项                                                              */
  /* ================================================================== */

  private bindKeyboard(): void {
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        this.toggleFormatsPanel(false);
        return;
      }
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (ev.key === 'f' || ev.key === 'F') {
        ev.preventDefault();
        this.searchInput.focus();
        this.searchInput.select();
      } else if (ev.key === '0') {
        ev.preventDefault();
        this.setZoom(1);
      } else if (ev.key === '=' || ev.key === '+') {
        ev.preventDefault();
        this.nudgeZoom(0.1);
      } else if (ev.key === '-') {
        ev.preventDefault();
        this.nudgeZoom(-0.1);
      }
    });
    // 侧栏宽度变化（窗口缩放）要让渲染器重算版心，否则文字换行会不对
    window.addEventListener('resize', () => {
      const tab = this.activeTab();
      tab?.viewer.setAvailableWidth(this.views.clientWidth);
    });
  }

  /** 供测试与调试使用：当前打开文档数 */
  get openDocumentCount(): number {
    return this.tabsList.length;
  }

  /** 供测试使用：已注册的读取器安装结果 */
  get readerInstalls(): readonly ReaderInstall[] {
    return this.installs;
  }

  private setStatus(message: string, isError = false): void {
    this.statusMessage.textContent = message;
    this.statusMessage.classList.toggle('is-error', isError);
  }

  /** 停止定时器（测试与页面卸载时调用，避免句柄泄漏） */
  dispose(): void {
    this.stopHud();
  }
}

/* ==================================================================== */
/* 辅助函数                                                            */
/* ==================================================================== */

/** 把嵌套大纲展平（带 level），便于平铺显示 */
function flattenOutline(items: readonly OutlineItem[], out: OutlineItem[] = []): OutlineItem[] {
  for (const item of items) {
    out.push(item);
    if (item.children && item.children.length > 0) flattenOutline(item.children, out);
  }
  return out;
}

/** 从 FORMATS 生成 accept 属性（扩展名 + MIME） */
function buildAcceptAttribute(): string {
  const parts = new Set<string>();
  for (const spec of FORMATS) {
    if (spec.id === 'unknown') continue;
    for (const ext of spec.extensions) parts.add(`.${ext}`);
  }
  return [...parts].join(',');
}

/** File System Access API 的 accept 需要 { mime: [ext...] } 结构 */
function buildAcceptExtensions(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const spec of FORMATS) {
    if (spec.id === 'unknown') continue;
    for (const mime of spec.mimes) {
      const exts = spec.extensions.map((e) => `.${e}`);
      out[mime] = [...(out[mime] ?? []), ...exts];
    }
  }
  return out;
}

/** 截断类别的中文说明（把内部键名翻译成人话） */
function labelTruncated(key: string): string {
  const map: Record<string, string> = {
    maxCells: '单元格数量已达上限',
    maxRows: '行数已达上限',
    maxCols: '列数已达上限',
    maxBlocks: '块（段落/表格）数量已达上限',
    maxShapes: '形状数量已达上限',
    maxSlides: '幻灯片数量已达上限',
    maxImages: '图片数量已达上限',
    maxImageBytes: '图片总字节数已达上限',
    maxPages: '页数已达上限',
    maxStringBytes: '共享字符串总字节数已达上限',
    maxPartBytes: '单个部件体积已达上限',
  };
  return `${map[key] ?? key}（${key}）`;
}

export { formatSpec, type FormatId };
