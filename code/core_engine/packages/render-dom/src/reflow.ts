/**
 * 文字类文档渲染器（reflow）—— 虚拟滚动 + 重流式布局。
 *
 * ## 虚拟化策略
 * 内容容器高度 = OffsetTable 的总高；**只给可视窗口内的块创建 DOM**，
 * 滚出去就 removeChild。2000 段的文档实际只有几十个节点存活。
 *
 * ## 「先渲染后实测」的两阶段高度
 * 段落高度在浏览器排版前不可知（见 layout.ts 的误差说明）。所以：
 *   1. 建表时用 estimateParaHeight() 的估算值 → 立刻可滚动、可 scrollTo
 *   2. 每块真正挂进 DOM 后读 offsetHeight 回填 OffsetTable（实测优先于估算）
 *   3. 回填只影响 [i, n) 的偏移，惰性重算
 * 未实测过的块用估算值，实测过的用真值 —— 误差随滚动被逐个纠正。
 *
 * ## 为什么用 transform 定位而不是 top
 * top 改动会触发布局（layout），transform 只触发合成（composite）。
 * 虚拟列表每帧都在改一批块的纵向位置，用 transform 能显著降低滚动抖动。
 * 但**测量**时读的是 offsetHeight（与定位方式无关），所以回填不受影响。
 */
import { clamp, ptToPx, pxToPt } from '../../core/src/units.ts';
import type { Block, InlineImage, LiteDocument, OutlineTarget, Paragraph, Run, Table } from '../../core/src/model.ts';
import { estimateBlockHeight, OffsetTable, visibleRange } from './layout.ts';
import type { VisibleRange } from './layout.ts';
import type { Viewable } from './viewer-types.ts';
import { attachLinkHandler, createAnchor, div, doc, imagePlaceholder, MediaUrls, rafThrottle, setStyle, span } from './domhelpers.ts';

/** 版心默认宽度（pt）—— 无页面尺寸信息时按 A4 正文区近似 */
const DEFAULT_CONTENT_WIDTH_PT = 560;
const DEFAULT_FONT_SIZE_PT = 11;
const MIN_FONT_SIZE_PT = 1;
/** 滚动方向提前渲染的块数（滚动事件离散，0 会在快速滚动时闪白） */
const OVERSCAN = 2;

interface SearchHit {
  /** 块下标 */
  block: number;
  /** 命中在**段落全文**中的字符偏移 */
  offset: number;
  length: number;
}

export class ReflowViewer implements Viewable {
  readonly element: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private doc: LiteDocument | null = null;
  private zoom = 1;
  private baseWidthPt = DEFAULT_CONTENT_WIDTH_PT;
  private defaultFontPt = DEFAULT_FONT_SIZE_PT;
  private offsets = new OffsetTable(0, 16);
  private readonly live = new Map<number, HTMLElement>();
  private readonly measured = new Map<number, number>();
  private readonly media = new MediaUrls();
  private hits: SearchHit[] = [];
  private lastQuery = '';
  private detachLinks: (() => void) | null = null;
  private disposed = false;
  private readonly schedule: () => void;
  /** 命中按块分组的惰性缓存，避免每块渲染都全量过滤一遍命中表 */
  private readonly hitsByBlock = new Map<number, SearchHit[]>();

  constructor() {
    this.element = div('lo-viewer lo-reflow');
    this.scroller = div('lo-scroller');
    setStyle(this.scroller, { overflow: 'auto', position: 'relative', width: '100%', height: '100%' });
    this.content = div('lo-content');
    setStyle(this.content, { position: 'relative', width: '100%' });
    this.spacer = div('lo-spacer');
    setStyle(this.spacer, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    this.schedule = rafThrottle(() => this.render());
    this.element.appendChild(this.scroller);
    this.scroller.appendChild(this.content);
    this.content.appendChild(this.spacer);
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  mount(container: HTMLElement): void {
    container.appendChild(this.element);
    this.scroller.addEventListener('scroll', this.schedule);
    this.detachLinks = attachLinkHandler(this.element);
    this.rebuild(true);
  }

  unmount(): void {
    this.scroller.removeEventListener('scroll', this.schedule);
    this.detachLinks?.();
    this.detachLinks = null;
  }

  setDocument(document0: LiteDocument): void {
    this.doc = document0;
    // 版心宽度：优先用文档自报的页面宽度减去左右边距。
    // 注意 meta.pageWidth 是 pt，而容器宽度是 px，这里统一换算成 pt 再比较。
    const pageW = document0.meta.pageWidth;
    const margin = document0.meta.margin;
    if (pageW && pageW > 0) {
      const inner = pageW - ((margin?.left ?? 0) + (margin?.right ?? 0));
      this.baseWidthPt = Math.max(120, inner);
    } else {
      const cw = this.scroller.clientWidth || this.element.clientWidth;
      // 容器量不到宽度（Node 测试桩 / 尚未挂载）时用默认版心，而不是 0
      this.baseWidthPt = cw > 0 ? Math.max(120, pxToPt(cw) - 24) : DEFAULT_CONTENT_WIDTH_PT;
    }
    this.defaultFontPt = defaultFontSizeOf(document0);
    this.measured.clear();
    this.hits = [];
    this.hitsByBlock.clear();
    this.lastQuery = '';
    this.rebuild(true);
  }

  setZoom(zoom: number): void {
    const z = clamp(zoom, 0.2, 8);
    const prev = this.zoom;
    if (z === prev) return;
    this.zoom = z;
    // 缩放不改变版心宽度（内容按 CSS px 等比放大），所以换行数不变、
    // 已实测高度只需按 zoom 比例放缩即可 —— 这比重新估算更稳（不会跳一大下）。
    if (this.measured.size > 0 && prev > 0) {
      const ratio = z / prev;
      for (const [i, h] of this.measured) this.measured.set(i, h * ratio);
    }
    // reset=false：块元素本身仍然有效，只需刷新宽度与偏移。
    // 若在这里整棵重建，缩放后滚动位置附近会闪一下。
    this.rebuild(false);
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  /**
   * 可用宽度变化（侧栏开合、窗口 resize）。
   * 只有当文档**没有**自带页面尺寸时才需要跟随容器 —— 有固定版心的文档
   * （Word 的 A4）不该因为侧栏变窄而重新排版，那会让文字位置跳来跳去。
   */
  setAvailableWidth(widthPx: number): void {
    if (this.doc?.meta.pageWidth) return;
    const next = widthPx > 0 ? Math.max(120, pxToPt(widthPx) - 24) : DEFAULT_CONTENT_WIDTH_PT;
    if (Math.abs(next - this.baseWidthPt) < 1) return;
    this.baseWidthPt = next;
    // 宽度变了换行就变了，已实测高度全部失效，必须丢掉重新估算
    this.measured.clear();
    this.rebuild(true);
  }

  scrollTo(target: OutlineTarget): void {
    if (!this.doc) return;
    const index = target.kind === 'block' || target.kind === 'page' || target.kind === 'slide' ? target.index : 0;
    if (target.kind === 'cell') return; // 文字视图不处理单元格定位
    const y = this.offsets.offsetOf(index);
    this.scroller.scrollTop = Math.max(0, y);
    this.render();
  }

  search(query: string, from = 0): { index: number; total: number } | null {
    const q = query;
    if (!q) {
      this.hits = [];
      this.lastQuery = '';
      this.rerenderLive();
      return null;
    }
    if (q !== this.lastQuery) {
      this.lastQuery = q;
      this.hits = this.collectHits(q);
    }
    if (this.hits.length === 0) {
      this.rerenderLive();
      return null;
    }
    const i = ((from % this.hits.length) + this.hits.length) % this.hits.length;
    const hit = this.hits[i];
    // 把命中段滚进视野（居中），并重绘以显示高亮
    const y = this.offsets.offsetOf(hit.block);
    const view = this.scroller.clientHeight || 0;
    this.scroller.scrollTop = Math.max(0, y - view / 3);
    this.render();
    return { index: i, total: this.hits.length };
  }

  get renderedNodes(): number {
    return this.element.querySelectorAll('*').length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unmount();
    this.media.dispose();
    this.live.clear();
    this.measured.clear();
    this.hits = [];
    this.hitsByBlock.clear();
    this.doc = null;
    // 真正把 DOM 交还给 GC：只清空自己的子树，不动宿主页面
    this.content.replaceChildren();
    this.scroller.replaceChildren();
    this.element.replaceChildren();
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 取当前文档的块序列；无 blocks 时用 text 兜底成段落（raw 文档也能看） */
  private blocks(): Block[] {
    const d = this.doc;
    if (!d) return [];
    if (d.blocks && d.blocks.length > 0) return d.blocks;
    const text = d.text ?? '';
    if (!text) return [];
    // 纯文本兜底：每行一个段落。不在这里做 Markdown/HTML 解析 ——
    // 那是读取器的职责，渲染器只认 UDM。
    return text.split('\n').map((line): Paragraph => ({ kind: 'para', runs: [{ text: line }] }));
  }

  /**
   * 重建偏移表并重绘。
   *
   * 为什么这里总是清空 live 重建：块的**字号**也依赖 zoom（12pt 在 200% 下是
   * 32px），所以缩放后保留旧元素会留下错的 font-size；而 fontSize 是继承属性，
   * 不重建就得逐个改每个 run 的内联样式，反而更容易漏。重建的成本只是
   * 当前窗口那几十个节点，代价可接受。
   */
  private rebuild(reset = false): void {
    if (this.disposed) return;
    const blocks = this.blocks();
    this.live.clear();
    for (const child of [...this.content.children]) child.remove();
    this.content.appendChild(this.spacer);
    void reset;
    const widthPx = this.contentWidthPx();
    // 默认高度取本次估算的均值：OffsetTable 的均匀快速路径只在真正均匀时生效，
    // 这里给一个合理初值，避免首屏所有块高度为 0。
    let sum = 0;
    const heights = new Array<number>(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      const h = this.measured.get(i) ?? this.estimatedHeight(blocks[i], widthPx);
      heights[i] = h;
      sum += h;
    }
    this.offsets = new OffsetTable(blocks.length, blocks.length ? sum / blocks.length : 16);
    for (let i = 0; i < blocks.length; i++) this.offsets.setHeight(i, heights[i]);
    this.render();
    // 兜底：文档变短时把越界的实测记录清掉，避免下次换了更长的文档时用到脏数据
    for (const key of [...this.measured.keys()]) if (key >= blocks.length) this.measured.delete(key);
  }

  /** 版心宽度（px，已乘 zoom）——内容容器与估算都用它 */
  private contentWidthPx(): number {
    const availPt = Math.max(120, this.baseWidthPt / this.zoom);
    return ptToPx(availPt) * this.zoom;
  }

  /**
   * 视口高度（px）。
   *
   * 为什么要逐级回退：真实浏览器里 scroller 有 `height:100%`，但如果宿主容器
   * 还没被布局（display:none 的标签页、刚 append 还没排版的那一帧），
   * 或者测试桩里没有 CSS 级联，scroller.clientHeight 会是 0。
   * 依次退回根元素、宿主容器，能拿到与浏览器一致的可用高度 ——
   * 否则会悄悄退化成「只渲染开头几块」的兜底路径，把虚拟化的真实行为掩盖掉。
   */
  private viewportHeight(): number {
    const parent = this.element.parentElement;
    return this.scroller.clientHeight || this.element.clientHeight || (parent ? parent.clientHeight : 0) || 0;
  }

  private estimatedHeight(block: Block, widthPx: number): number {
    // 估算函数吃 pt；widthPx 含 zoom，所以换算回「未缩放的 pt」再估，最后乘 zoom
    const availPt = Math.max(60, pxToPt(widthPx / this.zoom));
    return estimateBlockHeight(block, availPt, this.defaultFontPt) * this.zoom;
  }

  private render(): void {
    if (this.disposed) return;
    const blocks = this.blocks();
    const count = blocks.length;
    const viewport = this.viewportHeight();
    const scrollTop = this.scroller.scrollTop || 0;

    setStyle(this.spacer, { height: `${Math.max(0, this.offsets.totalHeight)}px` });

    if (count === 0) {
      for (const [i, el] of [...this.live]) {
        el.remove();
        this.live.delete(i);
      }
      return;
    }

    const starts = this.offsets.snapshotStarts();
    const ends = this.offsets.snapshotEnds();
    // 视口高度量不到时（未挂载 / 显示为 display:none 的标签页 / 无 CSS 级联的测试桩），
    // 用一个**固定的**合理像素值兜底。
    //
    // 早期版本这里用了 `ends[3]`（第 4 项的**终点偏移**）当高度 —— 那是个位置而不是高度，
    // 会随滚动/内容长度变大到几千像素，于是 visibleRange 认为「有一项盖住了整个视口」，
    // 只渲染 1 个块（实测 scrollTop=50000 时只剩 5 个节点）。虚拟化在数值上"生效"了，
    // 但用户看到的是几乎空白的页面 —— 这类 bug 只看节点数很不容易发现，
    // 所以这里改成固定 720px（常见笔记本视口高度），并用测试钉住「滚动后仍有合理数量的块」。
    const vh = viewport > 0 ? viewport : 720;
    // 传入最高项高用于剪枝：否则每次滚动都会从第 0 项开始扫到窗口，
    // 文档滚到 20 万段时这就是每秒上百次的 O(n) 扫描。
    const range: VisibleRange = visibleRange(scrollTop, vh, starts, ends, { overscan: OVERSCAN, maxItemHeight: this.offsets.maxItemHeight });

    // 回收：离开窗口的块直接摘掉。用 remove() 而不是 display:none ——
    // 隐藏的节点仍然占着内存与样式计算，等于没虚拟化。
    for (const [i, el] of [...this.live]) {
      if (i < range.start || i >= range.end) {
        el.remove();
        this.live.delete(i);
      }
    }

    // 创建：窗口内的块
    for (let i = range.start; i < range.end; i++) {
      if (this.live.has(i)) continue;
      const el = this.renderBlock(i, blocks[i]);
      if (!el) continue;
      this.live.set(i, el);
      this.content.appendChild(el);
    }

    this.flushMeasurements();
  }

  /**
   * 实测回填。
   * 只在「测到了合理值」时回填：Node 测试桩与隐藏容器（display:none）里
   * offsetHeight 恒为 0，如果照单全收会把总高压成 0，滚动条消失、页面塌陷。
   * 这是从「虚拟列表变空白」这类 bug 里得出的教训，所以显式挡掉 0。
   */
  private flushMeasurements(): void {
    let changed = false;
    for (const [i, el] of this.live) {
      const h = el.offsetHeight;
      if (!Number.isFinite(h) || h <= 0) continue;
      if (this.measured.get(i) === h) continue;
      this.measured.set(i, h);
      this.offsets.setHeight(i, h);
      changed = true;
    }
    if (changed) {
      setStyle(this.spacer, { height: `${Math.max(0, this.offsets.totalHeight)}px` });
      // 高度变了会让后续块的位置平移，需要再跑一轮可见区间
      // （不递归调用 render()，避免「测量->重排->测量」死循环：这里只补一次）
      this.relayoutLive();
    }
  }

  /** 回填后把已渲染块的 transform 更新到新偏移（不动节点集合） */
  private relayoutLive(): void {
    for (const [i, el] of this.live) {
      const y = this.offsets.offsetOf(i);
      setStyle(el, { transform: `translateY(${y}px)` });
    }
  }

  private renderBlock(index: number, block: Block): HTMLElement | null {
    const y = this.offsets.offsetOf(index);
    const wrap = div('lo-block');
    wrap.setAttribute('data-block-index', String(index));
    setStyle(wrap, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: `${this.contentWidthPx()}px`,
      transform: `translateY(${y}px)`,
      willChange: 'transform',
    });

    switch (block.kind) {
      case 'para':
        this.renderPara(wrap, block, index);
        break;
      case 'table':
        wrap.classList.add('lo-block-table');
        renderTable(wrap, block, this.zoom);
        break;
      case 'image':
        wrap.classList.add('lo-block-image');
        renderImageBlock(wrap, block.image, this.media, index, this.zoom);
        break;
      case 'pagebreak':
        wrap.classList.add('lo-pagebreak');
        setStyle(wrap, { borderTop: '1px dashed var(--lo-border)' });
        break;
      case 'rule':
        wrap.classList.add('lo-rule');
        setStyle(wrap, {
          borderTop: `${Math.max(1, ptToPx(block.thickness ?? 1))}px solid ${block.color ?? 'var(--lo-border)'}`,
        });
        break;
      case 'raw':
        wrap.classList.add('lo-raw');
        wrap.appendChild(create('pre', 'lo-raw-text', block.text));
        break;
      default:
        return null;
    }
    return wrap;
  }

  private renderPara(wrap: HTMLElement, para: Paragraph, index: number): void {
    // 整段行高/字号放在容器上，让换行后的每一行间距一致
    const size = Math.max(MIN_FONT_SIZE_PT, firstRunSize(para, this.defaultFontPt));
    const style = para.style;
    const lineHeight = style?.lineHeightExact
      ? `${ptToPx(style.lineHeightExact) * this.zoom}px`
      : `${(style?.lineHeight ?? 1.2) * size * (ptToPx(1) * this.zoom)}px`;
    setStyle(wrap, {
      font: `${ptToPx(size) * this.zoom}px/1 var(--lo-font)`,
      lineHeight,
      fontSize: `${ptToPx(size) * this.zoom}px`,
      paddingTop: style?.spaceBefore ? `${ptToPx(style.spaceBefore) * this.zoom}px` : undefined,
      paddingBottom: style?.spaceAfter ? `${ptToPx(style.spaceAfter) * this.zoom}px` : undefined,
      paddingLeft: style?.indentStart ? `${ptToPx(style.indentStart) * this.zoom}px` : undefined,
      paddingRight: style?.indentEnd ? `${ptToPx(style.indentEnd) * this.zoom}px` : undefined,
      textIndent: style?.indentFirst ? `${ptToPx(style.indentFirst) * this.zoom}px` : undefined,
      textAlign: normalizeAlign(style?.align),
      background: style?.shading,
    });
    if (style?.border) applyParaBorder(wrap, style.border, this.zoom);

    const hits = this.hitsFor(index);
    if (para.style?.listMarker || (para.style?.listLevel !== undefined && para.style?.listOrdered)) {
      // 项目符号单独成一个 span，避免与正文混在同一个文本节点里导致复制出多余字符
      const marker = span('lo-list-marker');
      marker.textContent = `${style?.listMarker ?? '•'} `;
      setStyle(marker, { paddingRight: '0.3em', opacity: '0.85' });
      wrap.appendChild(marker);
    }

    if (para.runs.length === 0) {
      // 空段落要占一行高，否则文档里的空行会消失
      wrap.appendChild(create('br'));
      return;
    }

    let textOffset = 0;
    for (const run of para.runs) {
      if (run.image) {
        renderInlineImage(wrap, run.image, this.media, index, this.zoom);
        textOffset += 0; // 图片不参与文本偏移（与 collectHits 的拼接规则保持一致）
        continue;
      }
      const text = run.text ?? '';
      if (text.length === 0) continue;
      const runSpan = this.buildRunSpan(run, text, hits, textOffset);
      wrap.appendChild(runSpan);
      textOffset += text.length;
    }
  }

  /**
   * 构造一个 run 的元素，必要时把命中片段切成 <mark>。
   *
   * 为什么不用 innerHTML 包 <mark>：用户内容可能含 <>&，拼接后既会破坏
   * 文本又会引入注入点。这里全程 createElement + textContent。
   *
   * 带链接的 run 用 <a data-link> 而不是写 href（见 domhelpers.createAnchor）：
   * 文档里的 URL 来自不可信文件，直接写 href 会留下 javascript: 这条注入路径。
   */
  private buildRunSpan(run: Run, text: string, hits: SearchHit[], runStart: number): HTMLElement {
    const st = run.style;
    const el: HTMLElement = st?.link ? createAnchor(st.link, text, 'lo-run lo-link') : span('lo-run');
    if (st) {
      setStyle(el, {
        fontWeight: st.bold ? 'bold' : undefined,
        fontStyle: st.italic ? 'italic' : undefined,
        textDecoration: [st.underline ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
        color: st.color,
        background: st.highlight,
        letterSpacing: st.letterSpacing ? `${ptToPx(st.letterSpacing) * this.zoom}px` : undefined,
        verticalAlign: st.vertAlign === 'superscript' ? 'super' : st.vertAlign === 'subscript' ? 'sub' : undefined,
        textTransform: st.caps === 'all' ? 'uppercase' : undefined,
        fontVariant: st.caps === 'small' ? 'small-caps' : undefined,
        fontSize: st.size ? `${ptToPx(st.size) * this.zoom}px` : undefined,
        fontFamily: st.font ? `"${st.font}", var(--lo-font)` : st.fontEastAsia ? `"${st.fontEastAsia}", var(--lo-font)` : undefined,
      });
      if (st.hidden) setStyle(el, { display: 'none' });
    }

    if (run.noteRef) {
      // 脚注/尾注引用：模型里没有脚注正文，如实标注而不是假装有内容
      const sup = span('lo-noteref');
      sup.textContent = `[${run.noteRef.kind === 'footnote' ? '脚注' : '尾注'} ${run.noteRef.id}]`;
      el.appendChild(sup);
      return el;
    }

    const runEnd = runStart + text.length;
    const overlaps = hits.filter((h) => h.offset < runEnd && h.offset + h.length > runStart);
    if (overlaps.length === 0) {
      // 链接的文本已在 createAnchor 里写好；其余情况这里补
      if (!st?.link) el.textContent = text;
      return el;
    }

    // 有命中：清掉已有文本，按命中切分重排（链接元素同样适用）
    for (const child of [...el.childNodes]) el.removeChild(child);
    let cursor = runStart;
    for (const h of overlaps) {
      const s = Math.max(h.offset, runStart);
      const e = Math.min(h.offset + h.length, runEnd);
      if (s > cursor) el.appendChild(doc().createTextNode(text.slice(cursor - runStart, s - runStart)));
      const mark = create('mark', 'lo-hit');
      mark.textContent = text.slice(s - runStart, e - runStart);
      el.appendChild(mark);
      cursor = e;
    }
    if (cursor < runEnd) el.appendChild(doc().createTextNode(text.slice(cursor - runStart)));
    return el;
  }

  /** 命中列表按块分组缓存（每块渲染时避免全量过滤） */
  private hitsFor(blockIndex: number): SearchHit[] {
    if (this.hits.length === 0) return EMPTY_HITS;
    const cached = this.hitsByBlock.get(blockIndex);
    if (cached) return cached;
    const list = this.hits.filter((h) => h.block === blockIndex);
    this.hitsByBlock.set(blockIndex, list);
    return list;
  }

  /** 全文档扫描一遍建立命中表（2000 段一次约几毫秒，可接受） */
  private collectHits(query: string): SearchHit[] {
    const out: SearchHit[] = [];
    this.hitsByBlock.clear();
    const blocks = this.blocks();
    const lowerQ = query.toLowerCase();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind !== 'para') continue;
      const text = paraSearchText(b.runs);
      const hay = text.toLowerCase();
      let at = hay.indexOf(lowerQ);
      while (at >= 0) {
        out.push({ block: i, offset: at, length: query.length });
        at = hay.indexOf(lowerQ, at + Math.max(1, query.length));
      }
    }
    return out;
  }

  /** 搜索条件变化后重绘当前窗口里的块，让高亮立刻可见 */
  private rerenderLive(): void {
    this.hitsByBlock.clear();
    const blocks = this.blocks();
    for (const [i, el] of [...this.live]) {
      const block = blocks[i];
      el.remove();
      this.live.delete(i);
      if (!block) continue;
      const fresh = this.renderBlock(i, block);
      if (!fresh) continue;
      this.live.set(i, fresh);
      this.content.appendChild(fresh);
    }
  }
}

const EMPTY_HITS: SearchHit[] = [];

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = doc().createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/* ==================================================================== */
/* 共享的块渲染（幻灯片里的形状也用）                                      */
/* ==================================================================== */

/** 段落全文（搜索偏移与渲染偏移必须用同一套拼接规则，否则高亮会串位） */
export function paraSearchText(runs: readonly Run[]): string {
  let out = '';
  for (const r of runs) if (!r.image) out += r.text ?? '';
  return out;
}

function firstRunSize(para: Paragraph, fallback: number): number {
  for (const r of para.runs) {
    if (r.image) continue;
    const s = r.style?.size;
    if (typeof s === 'number' && s > 0) return s;
  }
  return fallback;
}

function defaultFontSizeOf(doc: LiteDocument): number {
  // 模型没有「文档默认字号」字段，取正文里出现最多的字号作为近似；
  // 取不到就用 11pt（Word 中文默认「五号」约 10.5pt，取 11 更接近通用正文）
  const counts = new Map<number, number>();
  for (const b of doc.blocks ?? []) {
    if (b.kind !== 'para') continue;
    for (const r of b.runs) {
      const s = r.style?.size;
      if (typeof s === 'number' && s > 0) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  let best = DEFAULT_FONT_SIZE_PT;
  let bestN = 0;
  for (const [size, n] of counts) {
    if (n > bestN) {
      best = size;
      bestN = n;
    }
  }
  return best;
}

function normalizeAlign(align: string | undefined): string | undefined {
  if (align === 'start') return 'left';
  if (align === 'end') return 'right';
  return align;
}

function applyParaBorder(wrap: HTMLElement, border: NonNullable<Paragraph['style']>['border'], zoom: number): void {
  if (!border) return;
  const side = (line: typeof border.top): string | undefined => {
    if (!line || line.style === 'none' || line.width <= 0) return undefined;
    const w = Math.max(1, ptToPx(line.width) * zoom);
    const style = line.style === 'double' ? 'double' : line.style ?? 'solid';
    return `${w}px ${style} ${line.color ?? 'currentColor'}`;
  };
  setStyle(wrap, {
    borderTop: side(border.top),
    borderBottom: side(border.bottom),
    borderLeft: side(border.left),
    borderRight: side(border.right),
  });
}

/** 段落里嵌的图片：作为行内块，高度参与段落高度（估算函数也是这么假设的） */
function renderInlineImage(wrap: HTMLElement, image: InlineImage, media: MediaUrls, index: number, zoom: number): void {
  const src = media.srcFor(image, `inline:${index}`);
  if (!src) {
    const ph = span('lo-img-placeholder');
    ph.textContent = imagePlaceholder(image);
    wrap.appendChild(ph);
    return;
  }
  const img = create('img', 'lo-img');
  img.setAttribute('src', src);
  img.setAttribute('alt', image.alt ?? '');
  setStyle(img, {
    width: `${ptToPx(image.width) * zoom}px`,
    height: `${ptToPx(image.height) * zoom}px`,
    verticalAlign: 'bottom',
  });
  wrap.appendChild(img);
}

function renderImageBlock(wrap: HTMLElement, image: InlineImage, media: MediaUrls, index: number, zoom: number): void {
  setStyle(wrap, {
    textAlign: 'center',
    width: `${ptToPx(image.width) * zoom}px`,
    height: `${ptToPx(image.height) * zoom}px`,
  });
  const src = media.srcFor(image, `block:${index}`);
  if (!src) {
    wrap.appendChild(create('div', 'lo-img-placeholder', imagePlaceholder(image)));
    return;
  }
  const img = create('img', 'lo-img');
  img.setAttribute('src', src);
  img.setAttribute('alt', image.alt ?? '');
  setStyle(img, { width: '100%', height: '100%' });
  wrap.appendChild(img);
}

/**
 * 简单表格（文档内嵌表格）。
 * 表格里再嵌虚拟滚动会引入「内层滚动条 + 外层滚动」的双滚动交互，
 * 用户很难用；文档内表格通常不大，这里一次性渲染整表。
 * 大表请用「表格类文档」（grid.ts），那里才是行列双向虚拟化。
 */
export function renderTable(wrap: HTMLElement, table: Table, zoom: number): void {
  const el = doc().createElement('table');
  el.className = 'lo-table';
  setStyle(el, {
    borderCollapse: 'collapse',
    // 有明确总宽时用 fixed 布局，列宽才不会被内容撑开（Word 表格的直觉行为）
    tableLayout: table.width ? 'fixed' : undefined,
    width: table.width ? `${ptToPx(table.width) * zoom}px` : '100%',
  });
  const tbody = doc().createElement('tbody');
  for (const row of table.rows) {
    const tr = doc().createElement('tr');
    if (row.height) setStyle(tr, { height: `${ptToPx(row.height) * zoom}px` });
    for (const cell of row.cells) {
      if (cell.merged) continue;
      const td = doc().createElement('td');
      td.className = 'lo-tc';
      if (cell.colSpan && cell.colSpan > 1) td.setAttribute('colspan', String(cell.colSpan));
      if (cell.rowSpan && cell.rowSpan > 1) td.setAttribute('rowspan', String(cell.rowSpan));
      setStyle(td, {
        border: '1px solid var(--lo-border)',
        padding: `${ptToPx(cell.padding ?? 2) * zoom}px`,
        background: cell.shading,
        verticalAlign: cell.vAlign ?? 'top',
      });
      for (const b of cell.blocks) {
        const inner = div('lo-block lo-in-cell');
        if (b.kind === 'para') {
          const size = firstRunSize(b, 11);
          setStyle(inner, { fontSize: `${ptToPx(size) * zoom}px`, lineHeight: '1.35' });
          for (const run of b.runs) {
            if (run.image) {
              inner.appendChild(create('span', 'lo-img-placeholder', imagePlaceholder(run.image)));
              continue;
            }
            const s = span('lo-run');
            if (run.style) {
              setStyle(s, {
                fontWeight: run.style.bold ? 'bold' : undefined,
                fontStyle: run.style.italic ? 'italic' : undefined,
                textDecoration: run.style.underline ? 'underline' : undefined,
                color: run.style.color,
              });
            }
            s.textContent = run.text ?? '';
            inner.appendChild(s);
          }
          if (b.runs.length === 0) inner.appendChild(create('br'));
        } else if (b.kind === 'table') {
          renderTable(inner, b, zoom);
        } else if (b.kind === 'raw') {
          const pre = create('pre', 'lo-raw-text', b.text);
          inner.appendChild(pre);
        }
        td.appendChild(inner);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  el.appendChild(tbody);
  wrap.appendChild(el);
}
