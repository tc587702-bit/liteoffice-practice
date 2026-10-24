/**
 * PDF 渲染器（pdf）—— 每页一个定尺寸容器，文本项绝对定位成 <span>。
 *
 * ## 为什么要按页虚拟化
 * PDF 是固定版式，一页里可能有几千个文本片段（每个词组一段 Tj 很常见）。
 * 100 页的文档全量铺 DOM 就是几十万节点。所以：
 *   - 页容器（.lo-pdf-page）**始终存在**：它决定了滚动条总高，
 *     用绝对定位 + 已知页高，成本是每页 1 个节点
 *   - 页内的文本/图形项**只在该页可见时创建**，离开视口立刻回收
 *
 * ## 坐标
 * PDF 原点在左下、y 向上；CSS 原点在左上、y 向下。
 * 翻转与 /Rotate 都由 layout.pdfPageToCss() 这个纯函数负责（已单独测试），
 * 这里只把算出来的 left/top/width/height 写进 style。
 */
import { clamp, ptToPx } from '../../core/src/units.ts';
import type { LiteDocument, OutlineTarget, PdfItem, PdfPage } from '../../core/src/model.ts';
import { OffsetTable, pdfPageToCss } from './layout.ts';
import type { Viewable } from './viewer-types.ts';
import { attachLinkHandler, div, doc, MediaUrls, setStyle } from './domhelpers.ts';

const PAGE_GAP_PX = 14;
const PAGE_PADDING_PX = 12;

export class PdfViewer implements Viewable {
  readonly element: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private doc: LiteDocument | null = null;
  private zoom = 1;
  /** 每页的顶部偏移（px） */
  private offsets = new OffsetTable(0, 0);
  private readonly frames = new Map<number, HTMLElement>();
  private readonly populated = new Set<number>();
  /** 图片 Blob URL 的回收账本：PDF 图片不回收会一直占内存 */
  private readonly media = new MediaUrls();
  private observer: IntersectionObserver | null = null;
  private readonly schedule: () => void;
  private detachLinks: (() => void) | null = null;
  private disposed = false;
  private hits: PdfHit[] = [];
  private lastQuery = '';
  private activeHit = -1;

  constructor() {
    this.element = div('lo-viewer lo-pdf');
    this.scroller = div('lo-scroller');
    setStyle(this.scroller, { overflow: 'auto', position: 'relative', width: '100%', height: '100%' });
    this.content = div('lo-pdf-content');
    setStyle(this.content, { position: 'relative', width: '100%' });
    this.element.appendChild(this.scroller);
    this.scroller.appendChild(this.content);
    this.schedule = throttle(() => this.syncFallbackVisibility());
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  mount(container: HTMLElement): void {
    container.appendChild(this.element);
    this.scroller.addEventListener('scroll', this.schedule);
    this.detachLinks = attachLinkHandler(this.element);
    this.setupObserver();
    this.rebuild();
  }

  unmount(): void {
    this.scroller.removeEventListener('scroll', this.schedule);
    this.observer?.disconnect();
    this.observer = null;
    this.detachLinks?.();
    this.detachLinks = null;
  }

  setDocument(document0: LiteDocument): void {
    this.doc = document0;
    this.hits = [];
    this.lastQuery = '';
    this.activeHit = -1;
    this.rebuild();
  }

  setZoom(zoom: number): void {
    const z = clamp(zoom, 0.2, 8);
    if (z === this.zoom) return;
    this.zoom = z;
    this.rebuild();
  }

  scrollTo(target: OutlineTarget): void {
    this.scroller.scrollTop = Math.max(0, this.offsets.offsetOf(target.index));
    this.refreshVisible();
  }

  search(query: string, from = 0): { index: number; total: number } | null {
    const q = query;
    if (!q) {
      this.hits = [];
      this.lastQuery = '';
      this.activeHit = -1;
      this.refreshVisible();
      return null;
    }
    if (q !== this.lastQuery) {
      this.lastQuery = q;
      this.hits = collectPdfHits(this.pages(), q);
    }
    if (this.hits.length === 0) {
      this.activeHit = -1;
      this.refreshVisible();
      return null;
    }
    const i = ((from % this.hits.length) + this.hits.length) % this.hits.length;
    this.activeHit = i;
    const hit = this.hits[i];
    this.scroller.scrollTop = Math.max(0, this.offsets.offsetOf(hit.page));
    this.refreshVisible();
    return { index: i, total: this.hits.length };
  }

  get renderedNodes(): number {
    return this.element.querySelectorAll('*').length;
  }

  /** 已渲染内容的页数（虚拟化证据：应远小于总页数） */
  get populatedPages(): number {
    return this.populated.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unmount();
    this.media.dispose();
    this.frames.clear();
    this.populated.clear();
    this.hits = [];
    this.doc = null;
    this.content.replaceChildren();
    this.scroller.replaceChildren();
    this.element.replaceChildren();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private pages(): PdfPage[] {
    return this.doc?.pages ?? [];
  }

  private setupObserver(): void {
    const Ctor = (globalThis as unknown as { IntersectionObserver?: new (cb: (entries: IntersectionObserverEntry[]) => void, opts?: { root?: Element | null; rootMargin?: string }) => IntersectionObserver }).IntersectionObserver;
    if (typeof Ctor !== 'function') {
      this.observer = null;
      return;
    }
    this.observer = new Ctor(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const index = Number(el.getAttribute('data-page-index') ?? '-1');
          if (index < 0) continue;
          if (e.isIntersecting) this.populate(index);
          else this.depopulate(index);
        }
      },
      { root: this.scroller, rootMargin: '300px 0px' },
    );
  }

  private rebuild(): void {
    if (this.disposed) return;
    for (const el of this.frames.values()) el.remove();
    this.frames.clear();
    this.populated.clear();
    this.content.replaceChildren();

    const pages = this.pages();
    this.offsets = new OffsetTable(pages.length, 0);
    let y = 0;
    for (let i = 0; i < pages.length; i++) {
      const h = this.pageOuterHeight(pages[i]);
      this.offsets.setHeight(i, h);
      const frame = div('lo-pdf-page');
      frame.setAttribute('data-page-index', String(i));
      setStyle(frame, {
        position: 'absolute',
        left: '50%',
        top: '0',
        width: `${ptToPx(Math.max(1, pages[i].width)) * this.zoom}px`,
        height: `${ptToPx(Math.max(1, pages[i].height)) * this.zoom}px`,
        // 水平居中：不同页宽（横向页混排）时都居中，视觉上更稳
        marginLeft: `${(-ptToPx(Math.max(1, pages[i].width)) * this.zoom) / 2}px`,
        transform: `translateY(${y}px)`,
      });
      this.content.appendChild(frame);
      this.frames.set(i, frame);
      this.observer?.observe(frame);
      y += h;
    }
    setStyle(this.content, { height: `${Math.max(1, this.offsets.totalHeight)}px` });
    this.refreshVisible();
  }

  private pageOuterHeight(page: PdfPage): number {
    return ptToPx(Math.max(1, page.height)) * this.zoom + PAGE_GAP_PX + PAGE_PADDING_PX * 2;
  }

  private isVisible(index: number): boolean {
    const top = this.offsets.offsetOf(index);
    const h = this.offsets.heightOf(index);
    const viewTop = this.scroller.scrollTop || 0;
    const viewBottom = viewTop + this.viewportHeight();
    return top < viewBottom + 500 && top + h > viewTop - 500;
  }

  private refreshVisible(): void {
    const pages = this.pages();
    if (this.viewportMeasured()) {
      for (let i = 0; i < pages.length; i++) if (this.isVisible(i)) this.populate(i);
    }
    this.syncFallbackVisibility();
  }

  /** 视口尺寸是否已知（height>0）。未知时任何可见性判断都不可信 */
  private viewportMeasured(): boolean {
    return this.viewportHeight() > 0;
  }

  /** 视口高度（px）；逐级回退到宿主容器（见 slides.ts 同名方法的说明） */
  private viewportHeight(): number {
    const parent = this.element.parentElement;
    return this.scroller.clientHeight || this.element.clientHeight || (parent ? parent.clientHeight : 0) || 0;
  }

  private syncFallbackVisibility(): void {
    if (this.observer) return;
    // 视口未知时直接返回：否则 isVisible 会把所有页判成可见，
    // 200 页 PDF 的文本项会被一次性全部建出来（虚拟化等于没有）。
    if (!this.viewportMeasured()) return;
    const pages = this.pages();
    for (let i = 0; i < pages.length; i++) {
      if (this.isVisible(i)) this.populate(i);
      else this.depopulate(i);
    }
  }

  private populate(index: number): void {
    if (this.populated.has(index) || this.disposed) return;
    const frame = this.frames.get(index);
    const page = this.pages()[index];
    if (!frame || !page) return;
    this.populated.add(index);
    frame.classList.add('lo-pdf-live');

    // 用纯函数一次性算出所有项的 CSS 盒子：坐标数学只有一处实现
    const boxes = pdfPageToCss(page.items, page, 1, this.zoom);
    const hitIndex = this.activeHit >= 0 && this.hits[this.activeHit]?.page === index ? this.hits[this.activeHit].itemIndex : -1;
    for (let i = 0; i < page.items.length; i++) {
      const item = page.items[i];
      const box = boxes[i];
      if (!box) continue;
      const el = this.renderItem(item, box, i === hitIndex);
      if (el) frame.appendChild(el);
    }
  }

  private depopulate(index: number): void {
    if (!this.populated.has(index)) return;
    const frame = this.frames.get(index);
    if (!frame) return;
    this.populated.delete(index);
    frame.classList.remove('lo-pdf-live');
    frame.replaceChildren();
  }

  private renderItem(item: PdfItem, box: { left: number; top: number; width: number; height: number }, highlighted: boolean): HTMLElement | null {
    if (item.kind === 'text') {
      const el = doc().createElement('span');
      el.className = 'lo-pdf-text';
      el.textContent = item.text;
      setStyle(el, {
        position: 'absolute',
        left: `${box.left}px`,
        // 盒子是「基线之上 h」的矩形，span 里文字默认基线对齐，
        // 所以直接用 top 会略微偏上；这里按 lineHeight=1 处理，误差 < 2px
        top: `${box.top}px`,
        fontSize: `${ptToPx(item.size) * this.zoom}px`,
        lineHeight: '1',
        fontFamily: item.font ? `"${item.font}", var(--lo-font-pdf)` : 'var(--lo-font-pdf)',
        color: item.color ?? 'var(--lo-text)',
        whiteSpace: 'pre',
        letterSpacing: item.charSpacing ? `${ptToPx(item.charSpacing) * this.zoom}px` : undefined,
      });
      if (item.width) setStyle(el, { minWidth: `${ptToPx(item.width) * this.zoom}px` });
      if (highlighted) el.classList.add('lo-hit');
      return el;
    }
    const el = div(item.kind === 'line' ? 'lo-pdf-line' : item.kind === 'rect' ? 'lo-pdf-rect' : 'lo-pdf-image');
    setStyle(el, {
      position: 'absolute',
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${Math.max(0, box.width)}px`,
      height: `${Math.max(0, box.height)}px`,
    });
    if (item.kind === 'rect') {
      setStyle(el, {
        background: item.fill,
        border: item.stroke ? `${Math.max(1, ptToPx(item.lw ?? 1) * this.zoom)}px solid ${item.stroke}` : undefined,
      });
      return el;
    }
    if (item.kind === 'line') {
      // 线宽按 lw 给边框；水平/垂直两种最常见情形都能画对
      const thickness = Math.max(1, ptToPx(item.lw ?? 1) * this.zoom);
      const horizontal = box.width >= box.height;
      setStyle(el, {
        borderTop: horizontal ? `${thickness}px solid ${item.stroke ?? 'var(--lo-border)'}` : undefined,
        borderLeft: horizontal ? undefined : `${thickness}px solid ${item.stroke ?? 'var(--lo-border)'}`,
      });
      return el;
    }
    // 图片：reader 未提供字节时如实显示占位（PDF 图片常见为 JBIG2/JPX，暂不支持解码）
    const mime = item.mime ?? 'image/png';
    const src = this.media.srcFor(item.data ? { data: item.data, mime, width: 0, height: 0 } : undefined, `pdf:${pageKey(item)}`);
    if (src) {
      const img = doc().createElement('img');
      img.className = 'lo-img';
      img.setAttribute('src', src);
      img.setAttribute('alt', '');
      setStyle(img, { width: '100%', height: '100%', objectFit: 'contain' });
      el.appendChild(img);
      return el;
    }
    el.classList.add('lo-img-placeholder');
    el.textContent = '［图片］';
    return el;
  }
}

/** 给同一张图一个稳定的缓存键（同一页同一位置视为同一图） */
function pageKey(item: { x: number; y: number; w: number; h: number }): string {
  return `${item.x}:${item.y}:${item.w}:${item.h}`;
}

/* ==================================================================== */
/* 搜索                                                                */
/* ==================================================================== */

interface PdfHit {
  page: number;
  /** 页内 items 下标 */
  itemIndex: number;
}

function collectPdfHits(pages: PdfPage[], query: string): PdfHit[] {
  const out: PdfHit[] = [];
  const q = query.toLowerCase();
  for (let p = 0; p < pages.length; p++) {
    const items = pages[p].items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== 'text') continue;
      if ((it.text ?? '').toLowerCase().includes(q)) out.push({ page: p, itemIndex: i });
    }
  }
  return out;
}

function throttle(fn: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    const raf = (globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    const run = (): void => {
      pending = false;
      fn();
    };
    if (typeof raf === 'function') raf(run);
    else run();
  };
}
