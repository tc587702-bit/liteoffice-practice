/**
 * 表格类文档渲染器（grid）—— **行列双向虚拟化**。
 *
 * 这是「低内存」主张最硬的一块：5 万行 × 50 列的表，如果按行列全量铺 DOM
 * 就是 250 万个节点（任何浏览器都会当场卡死）。这里只渲染可视窗口内的
 * 「行 × 列」矩形，节点数与**窗口面积**同阶，与表大小无关。
 *
 * ## 异步读取的竞态
 * Grid.readRows() 是异步的（LazyGrid 会为取一个窗口重新流式解析源 XML，
 * 可能耗时几十毫秒）。这段时间里用户完全可能已经滚到别处。若不处理：
 *   - 结果回来时按旧窗口渲染 → 用户看到的是**别处**的数据（最恶劣的一类 bug：
 *     数据看起来是对的，但对应错误的行列，静默错位）
 * 所以每次发起读取时递增 version，回来时比对：不一致就整批丢弃。
 * 丢弃次数记在 discardedReads 里，是这套机制在起作用的证据。
 *
 * ## 为什么单元格不参与「合并格高度回填」
 * 行高只在单元格的 padding/换行下才会变，而表格视图**不自动换行**
 * （wrap 由 CellStyle.wrap 控制），所以行高由模型给定，不需要实测回填。
 * 这让偏移表可以保持均匀高度的快速路径，滚动性能稳定。
 */
import { clamp, ptToPx } from '../../core/src/units.ts';
import type { Cell, CellRow, LiteDocument, MergeRange, OutlineTarget, Sheet } from '../../core/src/model.ts';
import { findCell } from '../../core/src/grid.ts';
import { gridVisibleCols, gridVisibleRows, resolveColWidths, resolveMerges } from './layout.ts';
import type { Viewable } from './viewer-types.ts';
import { attachLinkHandler, div, doc, setStyle } from './domhelpers.ts';

/** 行/列方向各多渲染几行，避免快速滚动闪白 */
const ROW_OVERSCAN = 3;
const COL_OVERSCAN = 1;
/** 单元格默认字号（pt） */
const CELL_FONT_PT = 11;

export class GridViewer implements Viewable {
  readonly element: HTMLDivElement;
  private readonly tabs: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private doc: LiteDocument | null = null;
  private sheets: Sheet[] = [];
  private sheetIndex = 0;
  private zoom = 1;
  private colWidthsPt: number[] = [];
  /** 已物化在 DOM 里的单元格键（"r:c"），用于差量更新 */
  private readonly liveCells = new Map<string, HTMLElement>();
  private version = 0;
  private discardedReads = 0;
  private loading = false;
  private readonly schedule: () => void;
  private detachLinks: (() => void) | null = null;
  private disposed = false;
  /** scrollTo(cell) 指定的选中格，渲染时高亮 */
  private selected: { r: number; c: number } | null = null;

  constructor() {
    this.element = div('lo-viewer lo-grid');
    this.tabs = div('lo-sheet-tabs');
    this.scroller = div('lo-scroller');
    setStyle(this.scroller, { overflow: 'auto', position: 'relative', flex: '1 1 auto' });
    this.content = div('lo-grid-content');
    setStyle(this.content, { position: 'relative' });
    this.element.appendChild(this.tabs);
    this.element.appendChild(this.scroller);
    this.scroller.appendChild(this.content);
    this.schedule = makeSchedule(() => void this.render());
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  mount(container: HTMLElement): void {
    container.appendChild(this.element);
    this.scroller.addEventListener('scroll', this.schedule);
    this.detachLinks = attachLinkHandler(this.element);
    void this.render();
  }

  unmount(): void {
    this.scroller.removeEventListener('scroll', this.schedule);
    this.detachLinks?.();
    this.detachLinks = null;
  }

  setDocument(document0: LiteDocument): void {
    this.doc = document0;
    this.sheets = document0.sheets ?? [];
    this.sheetIndex = 0;
    this.selected = null;
    this.version++;
    this.liveCells.clear();
    this.content.replaceChildren();
    this.renderTabs();
    void this.render();
  }

  setZoom(zoom: number): void {
    const z = clamp(zoom, 0.2, 8);
    if (z === this.zoom) return;
    this.zoom = z;
    // 表格不重排，所以缩放只是改尺寸：重建窗口即可
    this.clearCells();
    void this.render();
  }

  scrollTo(target: OutlineTarget): void {
    const sheetIdx = target.kind === 'sheet' ? target.index : this.sheetIndex;
    if (sheetIdx !== this.sheetIndex && sheetIdx >= 0 && sheetIdx < this.sheets.length) {
      this.selectSheet(sheetIdx);
    }
    const sheet = this.sheets[this.sheetIndex];
    if (!sheet) return;
    const row = Math.max(0, target.row ?? (target.kind === 'cell' ? target.index : 0));
    const col = Math.max(0, target.col ?? 0);
    this.selected = { r: row, c: col };
    const y = this.rowOffsetOf(sheet, row);
    this.scroller.scrollTop = Math.max(0, y - (this.scroller.clientHeight || 0) / 4);
    const colW = this.colWidthPt(sheet, col);
    this.scroller.scrollLeft = Math.max(0, this.colOffsetOf(sheet, col) - colW);
    void this.render().then(() => this.highlightSelected());
  }

  search(query: string, from = 0): { index: number; total: number } | null {
    // 说明：表格搜索需要把行数据都取出来，与「不物化整表」直接冲突。
    // 因此这里只搜**当前已物化在 DOM 里的窗口**，并把这一限制写在返回值语义里
    // （UI 会提示「仅在当前可见区域搜索」）。这是刻意的降级，不是遗漏。
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hits: Array<{ r: number; c: number }> = [];
    for (const el of this.liveCells.values()) {
      const text = (el.textContent ?? '').toLowerCase();
      if (text.includes(q)) {
        const r = Number(el.getAttribute('data-r') ?? '0');
        const c = Number(el.getAttribute('data-c') ?? '0');
        hits.push({ r, c });
      }
    }
    hits.sort((a, b) => a.r - b.r || a.c - b.c);
    if (hits.length === 0) return null;
    const i = ((from % hits.length) + hits.length) % hits.length;
    this.scrollTo({ kind: 'cell', index: hits[i].r, row: hits[i].r, col: hits[i].c });
    return { index: i, total: hits.length };
  }

  get renderedNodes(): number {
    return this.element.querySelectorAll('*').length;
  }

  /** 诊断用：因竞态被丢弃的读取次数；>0 说明保护真的生效过 */
  get discarded(): number {
    return this.discardedReads;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unmount();
    this.version++;
    this.liveCells.clear();
    this.sheets = [];
    this.doc = null;
    this.content.replaceChildren();
    this.scroller.replaceChildren();
    this.tabs.replaceChildren();
    this.element.replaceChildren();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private currentSheet(): Sheet | undefined {
    return this.sheets[this.sheetIndex];
  }

  /**
   * 视口高度/宽度（px）。
   * scroller 有 `height:100%`，但宿主容器尚未布局（隐藏标签页、刚 append
   * 的那一帧）或测试桩无 CSS 级联时为 0，此时逐级退回根元素与宿主容器。
   */
  private viewportHeight(): number {
    const parent = this.element.parentElement;
    return this.scroller.clientHeight || this.element.clientHeight || (parent ? parent.clientHeight : 0) || 0;
  }

  private viewportWidth(): number {
    const parent = this.element.parentElement;
    return this.scroller.clientWidth || this.element.clientWidth || (parent ? parent.clientWidth : 0) || 0;
  }

  private renderTabs(): void {
    this.tabs.replaceChildren();
    if (this.sheets.length <= 1) {
      // 单表不显示标签条（省一行高度，也少一次误点）
      if (this.sheets.length === 1) {
        const label = div('lo-grid-sheetname');
        label.textContent = this.sheets[0].name || 'Sheet1';
        this.tabs.appendChild(label);
      }
      return;
    }
    for (let i = 0; i < this.sheets.length; i++) {
      const tab = doc().createElement('button');
      tab.className = 'lo-sheet-tab';
      tab.type = 'button';
      tab.textContent = this.sheets[i].name || `Sheet${i + 1}`;
      if (i === this.sheetIndex) tab.classList.add('lo-active');
      if (this.sheets[i].hidden) tab.classList.add('lo-hidden-sheet');
      tab.addEventListener('click', () => this.selectSheet(i));
      this.tabs.appendChild(tab);
    }
  }

  private selectSheet(index: number): void {
    if (index === this.sheetIndex) return;
    this.sheetIndex = index;
    this.selected = null;
    this.version++;
    this.clearCells();
    this.content.replaceChildren();
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.renderTabs();
    void this.render();
  }

  private clearCells(): void {
    for (const el of this.liveCells.values()) el.remove();
    this.liveCells.clear();
  }

  private colWidthPt(sheet: Sheet, c: number): number {
    const w = this.colWidthsPt[c];
    return w && w > 0 ? w : sheet.defaultColWidth || 48;
  }

  /**
   * 第 c 列左边界（px）。
   *
   * 注意必须 `ptToPx` 换算：`colWidthPt` 返回的是 **pt**，而这里的结果直接写进 CSS 的
   * `${left}px`。行方向（`rowTopPx`）用的是 px，若这里漏掉 4/3 换算，
   * 行列就处在不同单位里 —— 表现为横向滚动时单元格与滚动位置逐渐错开。
   */
  private colOffsetOf(sheet: Sheet, c: number): number {
    let acc = 0;
    for (let i = 0; i < c; i++) acc += ptToPx(this.colWidthPt(sheet, i));
    return acc * this.zoom;
  }

  /**
   * 第 r 行的像素偏移（**已乘 zoom**）。
   * 凡是参与滚动定位的偏移都必须是像素且含缩放，否则放大后 scrollTo 会滚过头。
   */
  private rowOffsetOf(sheet: Sheet, r: number): number {
    const def = sheet.defaultRowHeight || 18;
    if (!sheet.rowHeights || sheet.rowHeights.size === 0) return r * ptToPx(def) * this.zoom;
    let acc = 0;
    for (let i = 0; i < r; i++) acc += sheet.rowHeights.get(i) ?? def;
    return ptToPx(acc) * this.zoom;
  }

  /**
   * 渲染当前窗口。
   *
   * 竞态保护的关键：`version` 是**失效计数器**，只在「换了表 / 滚到新位置」时
   * 自增；每次渲染开始时把当前值快照成 token，异步读取返回后比对 token 是否
   * 仍等于 version。早期版本在渲染开始时也 `++version`，于是后发起的那次读取
   * 返回时会发现 version 已被自己改动过，把自己判成过期并丢弃 ——
   * 表现为「滚到新位置后表格长时间空白，只有再滚一次才出内容」。
   */
  private async render(): Promise<void> {
    const sheet = this.currentSheet();
    if (!sheet || this.disposed) return;
    const token = ++this.version;

    const zoom = this.zoom;
    const defRowH = ptToPx(sheet.defaultRowHeight || 18) * zoom;
    const defColW = ptToPx(sheet.defaultColWidth || 48) * zoom;
    const rowCount = Math.max(0, sheet.rowCount);
    const colCount = Math.max(0, sheet.colCount);
    if (this.colWidthsPt.length !== colCount) {
      this.colWidthsPt = resolveColWidths(sheet.colWidths, sheet.defaultColWidth || 48, colCount);
    }

    const viewportH = this.viewportHeight();
    const viewportW = this.viewportWidth();
    const scrollTop = this.scroller.scrollTop || 0;
    const scrollLeft = this.scroller.scrollLeft || 0;

    // 行高表：把模型的 pt 行高换算成 px 并按 zoom 缩放
    const rowHeights = new Map<number, number>();
    if (sheet.rowHeights) {
      for (const [r, h] of sheet.rowHeights) rowHeights.set(r, ptToPx(h) * zoom);
    }

    const rows = gridVisibleRows(scrollTop, viewportH, rowHeights, defRowH, rowCount, ROW_OVERSCAN);
    const cols = gridVisibleCols(scrollLeft, viewportW, this.colWidthsPt.map((w) => ptToPx(w) * zoom), defColW, colCount, COL_OVERSCAN);

    const totalW = this.colOffsetOf(sheet, colCount) || 0;
    const totalH = rowMergeHeight(sheet, rowCount, defRowH);
    setStyle(this.content, {
      width: `${Math.max(viewportW, totalW * zoom)}px`,
      height: `${Math.max(viewportH, totalH)}px`,
    });

    if (rows.end <= rows.start || cols.end <= cols.start) return;

    let cellRows: CellRow[];
    try {
      this.loading = true;
      cellRows = await sheet.readRows(rows.start, rows.end);
    } catch {
      // 读取失败不能让整个视图崩掉：留空并提示（由状态栏/控制台承担）
      if (token === this.version) this.showError('该区域数据读取失败');
      return;
    } finally {
      this.loading = false;
    }

    // ---- 竞态保护：这次结果已经过期就整批丢弃 ----
    if (token !== this.version || this.disposed) {
      this.discardedReads++;
      return;
    }
    const sheetNow = this.currentSheet();
    if (!sheetNow || sheetNow !== sheet) {
      this.discardedReads++;
      return;
    }

    this.paint(sheet, cellRows, rows, cols, defRowH, defColW, zoom);
  }

  private showError(message: string): void {
    if (this.content.querySelector('.lo-grid-error')) return;
    const el = div('lo-grid-error');
    el.textContent = message;
    setStyle(el, { position: 'absolute', top: '8px', left: '8px', padding: '4px 8px' });
    this.content.appendChild(el);
  }

  /**
   * 差量绘制：只增删窗口变化的那部分单元格。
   * 每次滚动都全量 replaceChildren 会丢掉焦点/选中态，并让滚动明显发抖。
   */
  private paint(
    sheet: Sheet,
    cellRows: CellRow[],
    rows: { start: number; end: number },
    cols: { start: number; end: number },
    defRowH: number,
    defColW: number,
    zoom: number,
  ): void {
    const byRow = new Map<number, CellRow>();
    for (const cr of cellRows) byRow.set(cr.r, cr);

    // 合并区域：锚点在窗口外的整块不渲染（见 layout.resolveMerges 的说明）
    const merges = resolveMerges(sheet.merges, rows, cols);
    const skip = new Set<string>();
    for (const s of merges.skip) skip.add(`${s.r}:${s.c}`);
    const anchorAt = new Map<string, MergeRange>();
    for (const m of merges.visible) anchorAt.set(`${m.r1}:${m.c1}`, m);

    const wanted = new Set<string>();
    const toAdd: Array<{ key: string; r: number; c: number; el: HTMLElement }> = [];
    const colLeft = (c: number): number => this.colOffsetOf(sheet, c) * zoom;

    /*
     * 每行「有内容的列」升序表。用于实现 Excel 的溢出显示规则：
     *
     *   单元格内容比列宽长时，文字继续向右画在**空格子**上，
     *   直到遇到下一个有内容的列才截断。
     *
     * 早期一律 `overflow:hidden` + 省略号，于是稍长一点的标题/备注/长数字全变成「…」——
     * 用户的原话是「大的数据我只能看到省略号」。
     *
     * 只记「最后一个非空列」是不够的：最常见的情形恰恰是
     * 「第 1 列放标题、中间几列空着、后面某列有数据」，
     * 这种在 Excel 里会横跨空格显示，而「只看最后非空列」会把它判成需要截断。
     */
    const filledCols = new Map<number, number[]>();
    for (const cr of cellRows) {
      const cols: number[] = [];
      for (const cell of cr.cells) {
        if (cell.v !== undefined && cell.v !== null && cell.v !== '') cols.push(cell.c);
      }
      cols.sort((a, b) => a - b);
      filledCols.set(cr.r, cols);
    }

    /** c 右侧**第一个**有内容的列；没有则返回 Infinity（可以一路溢出到行尾） */
    const nextFilledAfter = (r: number, c: number): number => {
      const cols = filledCols.get(r);
      if (!cols) return Infinity;
      for (const col of cols) if (col > c) return col;
      return Infinity;
    };

    for (let r = rows.start; r < rows.end; r++) {
      const row = byRow.get(r);
      for (let c = cols.start; c < cols.end; c++) {
        const key = `${r}:${c}`;
        const merged = anchorAt.get(key);
        if (!merged && skip.has(key)) continue;
        wanted.add(key);
        if (this.liveCells.has(key)) continue;
        const cell = findCell(row, c);
        const el = this.buildCell(
          sheet,
          cell,
          r,
          c,
          merged,
          defRowH,
          defColW,
          zoom,
          colLeft,
          nextFilledAfter(r, c),
        );
        toAdd.push({ key, r, c, el });
      }
    }

    // 回收窗口外的单元格
    for (const [key, el] of [...this.liveCells]) {
      if (wanted.has(key)) continue;
      el.remove();
      this.liveCells.delete(key);
    }
    for (const a of toAdd) {
      this.liveCells.set(a.key, a.el);
      this.content.appendChild(a.el);
    }
  }

  private buildCell(
    sheet: Sheet,
    cell: Cell | undefined,
    r: number,
    c: number,
    merged: MergeRange | undefined,
    defRowH: number,
    defColW: number,
    zoom: number,
    colLeft: (c: number) => number,
    nextFilledCol: number,
  ): HTMLElement {
    const el = div('lo-cell');
    el.setAttribute('data-r', String(r));
    el.setAttribute('data-c', String(c));
    const style = cell?.s !== undefined ? sheet.styles[cell.s] : undefined;

    /*
     * 能否把文字溢出到右边的空格子上（Excel 的行为）。
     *
     * 四个条件缺一不可：
     *   1. 有内容（空格子不该被扩宽，否则会盖掉相邻格的网格线）
     *   2. 不是合并格（合并格宽度已经够了）
     *   3. 没有开启自动换行（wrap 的语义是换行，不是溢出）
     *   4. 右边至少还有一个空格子，且**估算**文字确实超出本列宽度
     *
     * 第 4 条的估算（中文按 1 个字宽、ASCII 按 0.55）是刻意保守的：
     * 估不出超宽就不扩宽，让文字留在本格内。宁可少溢出，也不要为了短文本
     * 把盒子拉宽 700px 去盖住一整行的网格线。
     *
     * 溢出的**边界**是右边第一个有内容的列 —— 到那里必须截断，
     * 否则两个单元格的文字会叠在一起。
     */
    const spillBoundary = Math.min(nextFilledCol, sheet.colCount);
    const text = cell?.v === undefined || cell.v === null ? '' : String(cell.v);
    const sizePt = style?.size ?? CELL_FONT_PT;
    const colPt = this.colWidthPt(sheet, c);
    let needPt = 0;
    for (const ch of text) needPt += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? sizePt : sizePt * 0.55;
    const overWide = needPt > colPt;
    const canSpill = text.length > 0 && !merged && !style?.wrap && c + 1 < spillBoundary && overWide;

    /*
     * 单元格宽度必须取**本列的真实宽度**。
     * 早期这里写成 `let w = defColW`（默认列宽），只有合并单元格才去累加真实列宽，
     * 于是所有普通列都被画成同一个宽度：一列「学号（按顺序排序）」挤在 68px 里被裁掉，
     * 而列的**位置**却按真实宽度算 —— 位置与宽度对不上，表格看起来就是错位的。
     * 电子表格里列宽是最重要的排版信息之一，不能退化成一个全局常数。
     */
    let w = ptToPx(this.colWidthPt(sheet, c)) * zoom;
    let h = this.rowHeightPx(sheet, r, defRowH);
    if (merged) {
      w = 0;
      for (let i = merged.c1; i <= merged.c2; i++) w += ptToPx(this.colWidthPt(sheet, i)) * zoom;
      h = 0;
      for (let i = merged.r1; i <= merged.r2; i++) h += this.rowHeightPx(sheet, i, defRowH);
      el.classList.add('lo-merged');
    } else if (canSpill) {
      /*
       * 把盒子的宽度**扩展到溢出边界**（下一个有内容的列），让文字用上这段横向空间，
       * 并在边界处由 overflow:hidden 截断。
       *
       * 为什么不用 `overflow: visible` 让文字自己流出去：右侧的空格子自带背景色，
       * 且在 DOM 顺序上晚于本格，会把溢出的文字盖住；抬 z-index 又会盖掉那些格子的
       * 边框（网格线）。扩展自身宽度 + 透明背景是唯一既能让文字显示、
       * 又不破坏网格线的做法。
       */
      let span = 0;
      for (let i = c; i < spillBoundary; i++) span += ptToPx(this.colWidthPt(sheet, i)) * zoom;
      if (span > w) {
        w = span;
        el.classList.add('lo-cell-spill');
      }
    }

    setStyle(el, {
      position: 'absolute',
      left: `${colLeft(c)}px`,
      top: `${this.rowTopPx(sheet, r, defRowH)}px`,
      width: `${w}px`,
      height: `${h}px`,
      /*
       * 溢出格：宽度已扩到边界，靠 hidden 在边界截断；背景透明以保住右侧空格的网格线。
       * 普通格：hidden + 省略号（省略号在告诉用户「这里还有内容」）。
       */
      overflow: 'hidden',
      whiteSpace: style?.wrap ? 'normal' : 'nowrap',
      textOverflow: canSpill ? undefined : 'ellipsis',
      fontWeight: style?.bold ? 'bold' : undefined,
      fontStyle: style?.italic ? 'italic' : undefined,
      textDecoration: style?.underline ? 'underline' : undefined,
      color: style?.color,
      background: style?.bg,
      textAlign: style?.align,
      fontSize: `${ptToPx(style?.size ?? CELL_FONT_PT) * zoom}px`,
      fontFamily: style?.font ? `"${style.font}", var(--lo-font)` : undefined,
    });
    if (style?.border) el.classList.add('lo-cell-bordered');

    /*
     * 内容超出列宽时给一个原生 tooltip（`title`），鼠标悬停可看到**完整值**。
     *
     * 这是对「只能看到省略号」最直接的补救：无论如何排版，用户都能读到原文。
     * 只给确实超宽的格子加，避免满屏 tooltip 干扰。
     */
    if (overWide && text.length > 0) el.setAttribute('title', text);

    // 数字右对齐是表格的通用约定，模型没给 align 时按类型补默认值
    if (!style?.align && cell && (cell.t === 'n' || cell.t === 'd')) setStyle(el, { textAlign: 'right' });
    if (r === 0 || this.rowIsHeader(sheet, r)) el.classList.add('lo-row-header');

    if (this.selected && this.selected.r === r && this.selected.c === c) el.classList.add('lo-selected');

    // 文本渲染：rich 用 run 拼，否则直接用 v。/ 不用 innerHTML，全部 textContent。
    if (cell?.rich && cell.rich.length > 0) {
      for (const run of cell.rich) {
        const s = doc().createElement('span');
        if (run.style?.bold) s.style.fontWeight = 'bold';
        if (run.style?.italic) s.style.fontStyle = 'italic';
        if (run.style?.color) s.style.color = run.style.color;
        s.textContent = run.text ?? '';
        el.appendChild(s);
      }
    } else if (cell?.v) {
      el.textContent = cell.v;
    }
    // 公式：以 title 暴露，悬浮可见；不画在格子里（与 Excel 的「显示公式」不同）
    if (cell?.f) el.setAttribute('title', `=${cell.f}`);
    return el;
  }

  private rowIsHeader(_sheet: Sheet, _r: number): boolean {
    // 冻结行之后的行不该再加表头样式；这里只把第 0 行当表头
    return false;
  }

  private rowTopPx(sheet: Sheet, r: number, defRowH: number): number {
    if (!sheet.rowHeights || sheet.rowHeights.size === 0) return r * defRowH;
    return this.rowOffsetOf(sheet, r);
  }

  private rowHeightPx(sheet: Sheet, r: number, defRowH: number): number {
    const h = sheet.rowHeights?.get(r);
    return h ? ptToPx(h) * this.zoom : defRowH;
  }

  private highlightSelected(): void {
    if (!this.selected) return;
    for (const [key, el] of this.liveCells) {
      const on = key === `${this.selected.r}:${this.selected.c}`;
      el.classList.toggle('lo-selected', on);
    }
  }
}

/** 行方向的总高（有自定义行高时必须逐行累加） */
function rowMergeHeight(sheet: Sheet, rowCount: number, defRowH: number): number {
  if (!sheet.rowHeights || sheet.rowHeights.size === 0) return rowCount * defRowH;
  const zoom = defRowH / ptToPx(sheet.defaultRowHeight || 18);
  let acc = 0;
  for (let r = 0; r < rowCount; r++) {
    const h = sheet.rowHeights.get(r);
    acc += h ? ptToPx(h) * zoom : defRowH;
  }
  return acc;
}

/** 与 domhelpers.rafThrottle 等价，但允许返回 promise 的调用方忽略返回值 */
function makeSchedule(fn: () => void): () => void {
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
