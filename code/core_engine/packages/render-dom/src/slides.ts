/**
 * 幻灯片渲染器（slides）—— 按 pt 绝对定位形状 + 只渲染可见幻灯片。
 *
 * ## 虚拟化方式与文字/表格不同
 * 幻灯片不是「等高行」，而是一屏一屏的固定尺寸画布，天然适合用
 * IntersectionObserver：每张幻灯片先放一个**空的定尺寸 div**（占位，
 * 保证滚动条与总高从一开始就正确），进入视口时才把形状真正建出来，
 * 离开视口就把形状全部回收。
 *
 * 为什么用 IntersectionObserver 而不是自己算可见区间：
 *   幻灯片容器有内边距、可能有缩放、将来还可能加动画，
 *   「可见」这件事浏览器算得比我们准。而且它不依赖 scroll 事件频率。
 *   但 Node 测试环境没有该 API，所以保留一条基于几何的兜底路径
 *   （slidesFallback）—— 两条路径共用同一套 renderSlideShapes，避免行为分叉。
 *
 * ## 形状按 pt 定位
 * Shape.x/y/w/h 全是 pt（原点在幻灯片左上角），渲染时只经 ptToPx() * zoom。
 */
import { clamp, ptToPx } from '../../core/src/units.ts';
                                                                                                                        
import { OffsetTable } from './layout.ts';
                                                  
import { attachLinkHandler, createAnchor, div, doc, imagePlaceholder, MediaUrls, setStyle } from './domhelpers.ts';

/** 幻灯片之间的间隔（px，未缩放），也是背景留白 */
const SLIDE_GAP_PX = 18;
const SLIDE_PADDING_PX = 14;

export class SlidesViewer                     {
           element                ;
                   scroller                ;
                   content                ;
          doc                      = null;
          zoom = 1;
  /** 每张幻灯片的顶部偏移（px，已含 zoom） */
          offsets = new OffsetTable(0, 0);
  /** 幻灯片占位元素（一直存在，保证总高正确） */
                   frames = new Map                     ();
  /** 真正渲染了形状的幻灯片下标 */
                   populated = new Set        ();
                   media = new MediaUrls();
          observer                              = null;
                   schedule            ;
          detachLinks                      = null;
          disposed = false;
  /** 搜索结果定位到的形状，渲染时高亮 */
          hits             = [];
          lastQuery = '';
          activeHit = -1;

  constructor() {
    this.element = div('lo-viewer lo-slides');
    this.scroller = div('lo-scroller');
    setStyle(this.scroller, { overflow: 'auto', position: 'relative', width: '100%', height: '100%' });
    this.content = div('lo-slides-content');
    setStyle(this.content, { position: 'relative', width: '100%' });
    this.element.appendChild(this.scroller);
    this.scroller.appendChild(this.content);
    this.schedule = throttle(() => this.syncFallbackVisibility());
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  mount(container             )       {
    container.appendChild(this.element);
    this.scroller.addEventListener('scroll', this.schedule);
    this.detachLinks = attachLinkHandler(this.element);
    this.setupObserver();
    this.rebuild();
  }

  unmount()       {
    this.scroller.removeEventListener('scroll', this.schedule);
    this.observer?.disconnect();
    this.observer = null;
    this.detachLinks?.();
    this.detachLinks = null;
  }

  setDocument(document0              )       {
    this.doc = document0;
    this.hits = [];
    this.lastQuery = '';
    this.activeHit = -1;
    this.rebuild();
  }

  setZoom(zoom        )       {
    const z = clamp(zoom, 0.2, 8);
    if (z === this.zoom) return;
    this.zoom = z;
    this.rebuild();
  }

  scrollTo(target               )       {
    // 幻灯片视图里 block / slide / page 三种 target 的 index 都表示幻灯片序号
    this.scroller.scrollTop = Math.max(0, this.offsets.offsetOf(target.index));
    // IntersectionObserver 的回调是异步的；兜底路径下需要主动同步一次，
    // 否则「点了大纲却什么都没出现」要等下一次滚动才恢复
    this.refreshVisible();
  }

  search(query        , from = 0)                                          {
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
      this.hits = collectSlideHits(this.slides(), q);
    }
    if (this.hits.length === 0) {
      this.activeHit = -1;
      this.refreshVisible();
      return null;
    }
    const i = ((from % this.hits.length) + this.hits.length) % this.hits.length;
    this.activeHit = i;
    const hit = this.hits[i];
    this.scroller.scrollTop = Math.max(0, this.offsets.offsetOf(hit.slide));
    this.refreshVisible();
    return { index: i, total: this.hits.length };
  }

  get renderedNodes()         {
    return this.element.querySelectorAll('*').length;
  }

  /** 当前已渲染形状的幻灯片数（虚拟化的证据：应远小于总页数） */
  get populatedSlides()         {
    return this.populated.size;
  }

  dispose()       {
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

          slides()          {
    return this.doc?.slides ?? [];
  }

          setupObserver()       {
    const Ctor = (globalThis                                                                                                                                                                                 ).IntersectionObserver;
    if (typeof Ctor !== 'function') {
      // Node/老浏览器：走几何兜底。不抛错，功能不降级，只是可见性判断由我们自己算。
      this.observer = null;
      return;
    }
    this.observer = new Ctor(
      (entries) => {
        for (const e of entries) {
          const el = e.target               ;
          const index = Number(el.getAttribute('data-slide-index') ?? '-1');
          if (index < 0) continue;
          if (e.isIntersecting) this.populate(index);
          else this.depopulate(index);
        }
      },
      { root: this.scroller, rootMargin: '200px 0px' },
    );
  }

          rebuild()       {
    if (this.disposed) return;
    for (const el of this.frames.values()) el.remove();
    this.frames.clear();
    this.populated.clear();
    this.content.replaceChildren();

    const slides = this.slides();
    const width = this.slideWidthPx(slides);
    this.offsets = new OffsetTable(slides.length, this.slideHeightPx(slides) + SLIDE_GAP_PX + SLIDE_PADDING_PX * 2);

    let y = 0;
    for (let i = 0; i < slides.length; i++) {
      const h = this.heightOf(slides, i);
      this.offsets.setHeight(i, h);
      const frame = div('lo-slide');
      frame.setAttribute('data-slide-index', String(i));
      setStyle(frame, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: `${width}px`,
        height: `${Math.max(20, h - SLIDE_GAP_PX)}px`,
        marginBottom: `${SLIDE_GAP_PX}px`,
        transform: `translateY(${y}px)`,
      });
      this.content.appendChild(frame);
      this.frames.set(i, frame);
      this.observer?.observe(frame);
      y += h;
    }
    setStyle(this.content, { height: `${Math.max(1, this.offsets.totalHeight)}px` });
    this.syncFallbackVisibility();
    // 已经滚到某处时（例如 search 之后 rebuild）补齐可见的幻灯片。
    //
    // 但**视口尺寸未知时（clientHeight=0）必须在第 0 张就停下**：
    // 此时 isVisible 会把每一张都判成可见，于是把全部 300 张幻灯片的形状
    // 都建出来 —— 正好是虚拟化要避免的事。真实浏览器里挂载后 clientHeight
    // 立刻可用，所以这个分支只影响「尚未挂载/无布局环境」。
    if (!this.viewportMeasured()) {
      this.populate(0);
      return;
    }
    for (const i of this.visibleIndices()) this.populate(i);
  }

          viewportMeasured()          {
    return this.viewportHeight() > 0;
  }

  /**
   * 视口高度（px）。
   * scroller 有 `height:100%`，但宿主容器尚未布局（隐藏标签页、刚 append
   * 的那一帧）或测试桩无 CSS 级联时为 0，此时退回根元素。
   */
          viewportHeight()         {
    return this.scroller.clientHeight || this.element.clientHeight || 0;
  }

  /**
   * 幻灯片显示宽度（px）：按容器可用宽度自适应，pt -> px -> zoom。
   * 这是**唯一**的尺寸口径 —— 占位 div 与形状缩放都用它，
   * 两处各算一次必然会出现「形状溢出边框」或「内容缩在角落里」。
   */
          slideWidthPx(slides         )         {
    return this.fitWidthPt(slides) * this.zoom;
  }

  /** 未缩放的适配宽度（px，zoom=1） */
          fitWidthPt(slides         )         {
    const natural = ptToPx(this.baseWidthPt(slides));
    const avail = (this.scroller.clientWidth || this.element.clientWidth || 900) - SLIDE_PADDING_PX * 2;
    return Math.min(natural, Math.max(120, avail));
  }

          baseWidthPt(slides         )         {
    const w = slides[0]?.width;
    return w && w > 0 ? w : 960;
  }

          slideHeightPx(slides         )         {
    const s = slides[0];
    if (!s) return 0;
    const ratio = s.height > 0 && s.width > 0 ? s.height / s.width : 9 / 16;
    return this.fitWidthPt(slides) * ratio;
  }

          heightOf(slides         , index        )         {
    const s = slides[index];
    if (!s) return 0;
    const ratio = s.width > 0 && s.height > 0 ? s.height / s.width : 9 / 16;
    const frameH = this.slideWidthPx(slides) * ratio;
    return frameH + SLIDE_GAP_PX + SLIDE_PADDING_PX * 2;
  }

  /** 无 IntersectionObserver 时的几何兜底 */
          syncFallbackVisibility()       {
    if (this.observer) return;
    // 视口尺寸未知（未挂载 / 无布局环境）时不能遍历判断：
    // isVisible 会把每一张都判成可见，等于把整篇演示文稿都渲染出来。
    if (!this.viewportMeasured()) return;
    const slides = this.slides();
    for (let i = 0; i < slides.length; i++) {
      if (this.isVisible(i, slides)) this.populate(i);
      else this.depopulate(i);
    }
  }

          visibleIndices()           {
    const out           = [];
    if (!this.viewportMeasured()) return out;
    const slides = this.slides();
    for (let i = 0; i < slides.length; i++) if (this.isVisible(i, slides)) out.push(i);
    return out;
  }

          isVisible(index        , slides         )          {
    const top = this.offsets.offsetOf(index);
    const h = this.offsets.heightOf(index) || this.heightOf(slides, index);
    const viewTop = this.scroller.scrollTop || 0;
    const viewBottom = viewTop + this.viewportHeight();
    // 前后各留一屏做预渲染，效果与 IntersectionObserver 的 200px rootMargin 对齐
    return top < viewBottom + 400 && top + h > viewTop - 400;
  }

          refreshVisible()       {
    const slides = this.slides();
    if (this.viewportMeasured()) {
      for (let i = 0; i < slides.length; i++) if (this.isVisible(i, slides)) this.populate(i);
    }
    this.syncFallbackVisibility();
  }

  /** 把某张幻灯片的形状建出来（幂等） */
          populate(index        )       {
    if (this.populated.has(index) || this.disposed) return;
    const frame = this.frames.get(index);
    const slide = this.slides()[index];
    if (!frame || !slide) return;
    this.populated.add(index);
    frame.classList.add('lo-slide-live');
    if (slide.background) setStyle(frame, { background: slide.background });
    const hitShape = this.activeHit >= 0 && this.hits[this.activeHit]?.slide === index ? this.hits[this.activeHit].shape : -1;
    // 形状坐标是「幻灯片自身 pt 空间」，缩放系数 = 显示宽 / 幻灯片固有宽
    const baseW = slide.width > 0 ? slide.width : this.baseWidthPt(this.slides());
    const scale = baseW > 0 ? (this.slideWidthPx(this.slides()) / baseW) : this.zoom;
    for (let i = 0; i < slide.shapes.length; i++) {
      frame.appendChild(this.renderShape(slide.shapes[i], i, scale, hitShape));
    }
    if (slide.shapes.length === 0) {
      const empty = div('lo-slide-empty');
      empty.textContent = slide.empty ? '（空白版式）' : '（本页没有可渲染的形状）';
      frame.appendChild(empty);
    }
  }

  /** 回收形状节点，但保留占位 div */
          depopulate(index        )       {
    if (!this.populated.has(index)) return;
    const frame = this.frames.get(index);
    if (!frame) return;
    this.populated.delete(index);
    frame.classList.remove('lo-slide-live');
    frame.replaceChildren();
  }

          renderShape(shape       , index        , scale        , hitShape        )              {
    const el = div(`lo-shape lo-shape-${shape.kind}`);
    setStyle(el, {
      position: 'absolute',
      left: `${shape.x * scale}px`,
      top: `${shape.y * scale}px`,
      width: `${Math.max(0, shape.w) * scale}px`,
      height: `${Math.max(0, shape.h) * scale}px`,
      background: shape.fill,
      border: shape.stroke ? `${Math.max(1, (shape.strokeWidth ?? 1) * scale)}px solid ${shape.stroke}` : undefined,
      borderRadius: shape.kind === 'ellipse' ? '50%' : shape.radius ? `${shape.radius * scale}px` : undefined,
      opacity: shape.opacity !== undefined && shape.opacity < 1 ? String(shape.opacity) : undefined,
      transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
      overflow: 'hidden',
    });
    if (shape.kind === 'line') {
      // 形状模型里的线用外框表示；不画背景就等于看不见，所以给一条边
      setStyle(el, { background: shape.stroke ?? shape.fill ?? 'var(--lo-border)', minHeight: '1px' });
    }

    if (index === hitShape) el.classList.add('lo-search-hit');

    if (shape.kind === 'image') {
      this.renderImage(el, shape.image, index);
      return el;
    }

    if (shape.shapes && shape.shapes.length > 0) {
      // 组合形状：子形状坐标按模型约定已是相对坐标，这里直接透传
      for (let i = 0; i < shape.shapes.length; i++) {
        el.appendChild(this.renderShape(shape.shapes[i], i, scale, -1));
      }
      return el;
    }

    if (shape.blocks && shape.blocks.length > 0) {
      setStyle(el, {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: shape.anchor === 'middle' ? 'center' : shape.anchor === 'bottom' ? 'flex-end' : 'flex-start',
        padding: `${4 * scale}px`,
        boxSizing: 'border-box',
      });
      for (const b of shape.blocks) {
        el.appendChild(this.renderShapeBlock(b, scale, index === hitShape));
      }
      return el;
    }

    if (shape.empty || shape.kind === 'placeholder') el.classList.add('lo-shape-empty');
    return el;
  }

  /** 形状里的文本块：段落 + run，全部 createElement/textContent */
          renderShapeBlock(block       , scale        , highlight         )              {
    if (block.kind === 'para') return this.renderShapePara(block, scale, highlight);
    if (block.kind === 'image') {
      const holder = div('lo-shape-imgblock');
      this.renderImage(holder, block.image, 0);
      return holder;
    }
    if (block.kind === 'raw') {
      const pre = doc().createElement('pre');
      pre.className = 'lo-raw-text';
      pre.textContent = block.text;
      return pre;
    }
    if (block.kind === 'rule') {
      const hr = div('lo-rule');
      setStyle(hr, { borderTop: `1px solid ${block.color ?? 'var(--lo-border)'}` });
      return hr;
    }
    if (block.kind === 'pagebreak') return div('lo-pagebreak');
    // table 在形状里不常见；用纯文本兜底而不是不显示内容
    const fallback = div('lo-shape-table-fallback');
    fallback.textContent = '[表格]';
    return fallback;
  }

          renderShapePara(para           , scale        , highlight         )              {
    const p = div('lo-shape-para');
    const size = firstRunSize(para, 18);
    setStyle(p, {
      fontSize: `${ptToPx(size) * scale}px`,
      lineHeight: String(para.style?.lineHeight ?? 1.2),
      textAlign: para.style?.align === 'start' ? 'left' : para.style?.align === 'end' ? 'right' : para.style?.align,
      fontWeight: para.style?.outlineLevel !== undefined ? 'bold' : undefined,
      margin: '0',
      whiteSpace: 'pre-wrap',
    });
    if (para.runs.length === 0) {
      p.appendChild(doc().createElement('br'));
      return p;
    }
    for (const run of para.runs) {
      if (run.image) {
        const holder = div('lo-shape-imgblock');
        this.renderImage(holder, run.image, 0);
        p.appendChild(holder);
        continue;
      }
      const s = doc().createElement('span');
      const st = run.style;
      if (st) {
        setStyle(s, {
          fontWeight: st.bold ? 'bold' : undefined,
          fontStyle: st.italic ? 'italic' : undefined,
          textDecoration: st.underline ? 'underline' : undefined,
          color: st.color,
          fontSize: st.size ? `${ptToPx(st.size) * scale}px` : undefined,
        });
      }
      const text = run.text ?? '';
      if (run.style?.link) s.appendChild(createAnchor(run.style.link, text, 'lo-link'));
      else s.textContent = text;
      p.appendChild(s);
    }
    if (highlight && this.lastQuery) markText(p, this.lastQuery);
    return p;
  }

          renderImage(parent             , image                         , index        )       {
    if (!image) return;
    const src = this.media.srcFor(image, `slide:${index}`);
    if (!src) {
      const ph = div('lo-img-placeholder');
      ph.textContent = imagePlaceholder(image);
      parent.appendChild(ph);
      return;
    }
    const img = doc().createElement('img');
    img.className = 'lo-img';
    img.setAttribute('src', src);
    img.setAttribute('alt', image.alt ?? '');
    setStyle(img, { width: '100%', height: '100%', objectFit: 'contain' });
    parent.appendChild(img);
  }
}

/* ==================================================================== */
/* 搜索                                                                */
/* ==================================================================== */

                    
                
                          
                
                             
                 
 

function collectSlideHits(slides         , query        )             {
  const out             = [];
  const q = query.toLowerCase();
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    for (let si = 0; si < slide.shapes.length; si++) {
      const text = shapeText(slide.shapes[si]);
      if (text.toLowerCase().includes(q)) out.push({ slide: i, shape: si, notes: false });
    }
    if (slide.notes && slide.notes.toLowerCase().includes(q)) out.push({ slide: i, shape: -1, notes: true });
  }
  return out;
}

function shapeText(shape       )         {
  let out = '';
  const walk = (blocks                     )       => {
    for (const b of blocks ?? []) {
      if (b.kind === 'para') for (const r of b.runs) if (!r.image) out += r.text ?? '';
      else if (b.kind === 'raw') out += b.text;
      else if (b.kind === 'table') for (const row of b.rows) for (const c of row.cells) walk(c.blocks);
    }
  };
  walk(shape.blocks);
  for (const child of shape.shapes ?? []) out += shapeText(child);
  return out;
}

/**
 * 在已渲染的段落里把命中词包成 <mark>。
 * 只处理**文本节点**：这里手写递归而不是用 TreeWalker，
 * 因为渲染器只依赖最基础的 DOM 子集（测试桩也只需实现这部分）。
 *
 * @returns 插入的 <mark> 个数（0 表示没找到；调用方据此把命中提示降级为「在备注里」）
 */
function markText(root: HTMLElement, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  let marks = 0;
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const text = child.textContent ?? '';
        const at = text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        const parent = child.parentNode;
        if (!parent) continue;
        const before = doc().createTextNode(text.slice(0, at));
        const mark = doc().createElement('mark');
        mark.className = 'lo-hit';
        mark.textContent = text.slice(at, at + query.length);
        const after = doc().createTextNode(text.slice(at + query.length));
        parent.insertBefore(before, child);
        parent.insertBefore(mark, child);
        parent.insertBefore(after, child);
        parent.removeChild(child);
        marks++;
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(root);
  return marks;
}

function firstRunSize(para           , fallback        )         {
  for (const r of para.runs) {
    const s = r.style?.size;
    if (typeof s === 'number' && s > 0) return s;
  }
  return fallback;
}

function throttle(fn            )             {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    const raf = (globalThis                                                                     ).requestAnimationFrame;
    const run = ()       => {
      pending = false;
      fn();
    };
    if (typeof raf === 'function') raf(run);
    else run();
  };
}
