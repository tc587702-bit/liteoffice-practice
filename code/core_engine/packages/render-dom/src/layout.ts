/**
 * @liteoffice/render-dom —— **纯布局数学**。
 *
 * 为什么把这一层单独拆出来（这是本包最重要的架构决定）：
 *   项目零依赖，没有 jsdom，Node 里根本不存在 document。
 *   如果虚拟化算法和 DOM 操作混在一起，那么「滚动到底时可见区间对不对」
 *   「回填高度后 indexAt 还准不准」这些最容易出错的逻辑就**无法测试**，
 *   只能靠肉眼看浏览器 —— 而虚拟化的 bug 恰恰表现为「偶发白屏」，肉眼很难稳定复现。
 *
 *   所以这里的所有函数：
 *     - 不 import 任何 DOM 全局，不读 window
 *     - 纯输入 -> 纯输出，可在 Node 里被 node:test 直接断言
 *   DOM 只出现在 reflow.ts / grid.ts / slides.ts / pdf.ts 里。
 *
 * 单位约定：本文件内部一律用 **pt**；只有「视口尺寸」和返回的「像素高度」
 * 用 px（因为 scrollTop / clientHeight 本身就是 px）。换算只通过 core 的
 * ptToPx()/pxToPt()，不自己写 1.3333。
 */
import { finite, ptToPx } from '../../core/src/units.ts';
import type { Block, MergeRange, Paragraph, PdfPage, PdfTextItem, Run } from '../../core/src/model.ts';

/* ==================================================================== */
/* 可见区间                                                              */
/* ==================================================================== */

export interface VisibleRangeOptions {
  /**
   * 上下各多渲染多少像素。
   * 必须大于 0：滚动事件是离散的，如果只渲染严格可见区域，
   * 快速滚动时新内容还来不及创建，用户会看到空白（虚拟列表最典型的闪烁）。
   */
  overscan?: number;
  /**
   * 列表中**最高**一项的高度（px）。给出它可以剪掉视口上方那些
   * 「肯定不可见」的项，让扫描范围只与窗口大小相关。
   * 取不到（或不给）时退化为从 0 开始扫，结果依然正确，只是慢一点。
   */
  maxItemHeight?: number;
}

export interface VisibleRange {
  start: number;
  /** 开区间上界 */
  end: number;
}

/**
 * 由「滚动位置 + 视口高度 + 每项的起止偏移」求可见索引区间。
 *
 * 用二分而不是线性扫描：滚动事件每秒可触发上百次，
 * 若每次 O(n) 扫描，10 万行表光算区间就要几十毫秒，虚拟化就白做了。
 *
 * @param starts 每项起点（升序，px）
 * @param ends   每项终点（升序，px）
 * @returns 含 overscan 的闭开区间；空数据返回 {start:0,end:0}
 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  starts: readonly number[],
  ends: readonly number[],
  options: VisibleRangeOptions = {},
): VisibleRange {
  const count = Math.min(starts.length, ends.length);
  if (count <= 0) return { start: 0, end: 0 };

  const over = Math.max(0, finite(options.overscan, 0));
  const top = Math.max(0, finite(scrollTop, 0) - over);
  const bottom = Math.max(top, finite(scrollTop, 0) + Math.max(0, finite(viewportHeight, 0)) + over);

  // ---- 求可见区间 ----
  //
  // 直接对「首个可见项」做二分是不可靠的：可见性判据 ends[i] > top 在
  // 大表窗口里**不单调**（一行可能高到覆盖整个视口，于是它前面的项
  // 全都 ends ≤ top，而它自己 ends > top），二分会落进窗口内部。
  //
  // 所以这里用 starts 的单调性分两步：
  //   1. lowerBound(starts, bottom) 求出「起点已越过视口下沿」的第一个位置 upper，
  //      于是可见项必然全部落在 [0, upper)
  //   2. 在 [0, upper) 里线性扫出第一个「终点越过视口上沿」的项作为 start
  // 复杂度 O(log n + k + w)，k 是可见项数（等于要渲染的节点数），
  // w 是视口上方那些「已滚过去、但可能因为超高而仍然可见」的项数。
  // 在等高的普通文档里 w 恒为 0，也就是纯 O(log n + k)。
  //
  // 边界语义（两端用同一套严格比较，不加任何 epsilon）：
  //   项 i 可见 ⟺ [starts[i], ends[i]) ∩ [top, bottom) ≠ ∅
  //             ⟺ ends[i] > top 且 starts[i] < bottom
  const upper = lowerBound(starts, count, bottom);

  const empty = (): VisibleRange => {
    if (count === 0) return { start: 0, end: 0 };
    // 无任何项与视口相交：把「最接近视口的那个位置」报回去。
    // 至少要给一项，否则调用方会渲染出整屏空白。
    const i = upper;
    return i >= count ? { start: count - 1, end: count } : { start: i, end: Math.min(count, i + 1) };
  };

  // 先按高度剪枝：只有「高到可能跨过视口上沿」的项才需要参与扫描。
  // 判据用**严格**不等：ends[i] = starts[i] + h ≤ top - maxHeight 时可证
  // ends[i] ≤ top，一定不可见。写成 lowerBound(top - maxHeight) 就够了，
  // 但若用 top - maxHeight - 1 会把「恰好卡在边界」的候选也剪掉，
  // 于是贴着视口上沿的那一项时隐时现（滚动时表现为内容一跳一跳）。
  // maxItemHeight 由调用方给出（OffsetTable 在重建时顺手维护，O(1)），
  // 因此这里不必再 O(n) 求一遍最大值 —— 否则每次滚动都会偷偷扫一遍全表。
  const maxHeight = Math.max(0, finite(options.maxItemHeight, 0));
  const lo = maxHeight > 0 ? lowerBound(starts, upper, top - maxHeight) : 0;

  let start = upper;
  for (let i = lo; i < upper; i++) {
    if (ends[i] > top) {
      start = i;
      break;
    }
  }
  if (start >= upper) return empty();

  // 滚过内容末尾（scrollTop > 总高）：此时窗口里一个项都没有，
  // 把窗口回退到**最后一项**。不这么做的话，在「橡皮筋」或程序性
  // 设置超限 scrollTop 时会短暂看到整屏空白。
  if (start >= count) return { start: count - 1, end: count };

  return { start, end: upper };
}

/**
 * 第一个满足 values[i] >= target 的下标（标准 lower_bound，O(log n)）。
 *
 * 这个方向极易写反：写反后返回值会一路增长到 count，于是
 * visibleRange 返回**整篇文档**（3000 段全部建 DOM），
 * 虚拟化彻底失效却没有任何报错 —— 是本文件历史上最贵的一个错误。
 */
function lowerBound(values: readonly number[], count: number, target: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ==================================================================== */
/* OffsetTable —— 变高列表的偏移表                                        */
/* ==================================================================== */

/**
 * 变高虚拟列表的偏移表。
 *
 * 存在理由：文字文档是**重流式（reflow）布局** —— 段落高度取决于可用宽度、
 * 字体度量、断行规则，在浏览器真正排版之前是**未知的**。而虚拟滚动要求
 * 「先知道第 9000 段在哪一像素」才能定位到它。两者天然矛盾。
 *
 * 解法（本类实现的就是它）：
 *   1. 打开文档时先按 estimateParaHeight() 的**估算值**建表 —— 立刻可滚动
 *   2. 每段真正渲染进 DOM 后，用 offsetHeight **实测回填** setHeight()
 *   3. 回填只让 [i, n) 的偏移失效，惰性重算；查询仍是 O(log n)
 * 于是估算误差**随着滚动被逐步纠正**，而不是一次性排版全部内容。
 *
 * 另外实现了均匀高度快速路径：1000 个等高的纯文本行不该建两个 1000 长度数组，
 * 更不该让 indexAt 变成二分 —— 直接除一下就是答案。
 */
export class OffsetTable {
  private count: number;
  /** 每项高度（px） */
  private readonly heights: number[];
  /** 每项起点（px），惰性维护 */
  private readonly starts: number[];
  /** 每项终点（px） */
  private readonly ends: number[];
  /** 从该下标起的偏移已失效；>= count 表示全部有效 */
  private dirtyFrom: number;
  /** 全部项高度是否都等于 defaultHeight（此时不需要前缀和数组） */
  private uniform: boolean;
  /** 诊断用：实际发生的前缀和重算次数。测试据此确认「不是每次查询都全量求和」 */
  rebuilds: number;
  /** 最大项高的缓存；等于 -1 表示需要在下次查询时算一次 */
  private maxHeightCache = -1;

  /** 最高一项的高度（px）。首次调用 O(n)，之后 O(1) —— 供 visibleRange 剪枝用 */
  get maxItemHeight(): number {
    if (this.maxHeightCache >= 0) return this.maxHeightCache;
    let m = 0;
    for (let i = 0; i < this.count; i++) if (this.heights[i] > m) m = this.heights[i];
    this.maxHeightCache = m;
    return m;
  }

  constructor(count: number, defaultHeight: number) {
    this.count = Math.max(0, Math.floor(finite(count, 0)));
    const h = Math.max(0, finite(defaultHeight, 0));
    this.heights = new Array<number>(this.count).fill(h);
    this.starts = new Array<number>(this.count).fill(0);
    this.ends = new Array<number>(this.count).fill(0);
    this.dirtyFrom = 0;
    this.uniform = true;
    this.rebuilds = 0;
  }

  get length(): number {
    return this.count;
  }

  /** 全部项高度是否一致（含「从未回填过」的初始状态） */
  get isUniform(): boolean {
    return this.uniform;
  }

  /** 最后一项的终点，即内容总高（px） */
  get totalHeight(): number {
    if (this.count === 0) return 0;
    // 必须先 ensure()：均匀高度时 ends 数组从未被填过，
    // 直接读 ends[count-1] 会返回 0，把内容总高压成 0（滚动条消失）。
    this.ensure();
    return this.ends[this.count - 1];
  }

  /** 取某项高度；越界返回 0 */
  heightOf(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    return this.heights[index];
  }

  /**
   * 回填实测高度（px）。
   * 只有高度真的变了才标脏 —— 每次滚动都会回填一大批相同值，
   * 不做这个判断会让每一帧都触发一次全量重算。
   */
  setHeight(index: number, height: number): void {
    if (!Number.isFinite(index) || index < 0) return;
    const i = Math.floor(index);
    // 允许增长（渲染器可能先于 setCount 发现更多内容）
    if (i >= this.count) {
      const h = Math.max(0, finite(this.defaultHeightGuess(), 0));
      while (this.count <= i) {
        this.heights.push(h);
        this.starts.push(0);
        this.ends.push(0);
        this.count++;
      }
      this.uniform = false;
      this.dirtyFrom = Math.min(this.dirtyFrom, i);
    }
    const h = Math.max(0, finite(height, 0));
    if (this.heights[i] === h) return;
    this.heights[i] = h;
    this.uniform = false;
    // 只有「变高了」才可能改变最大值；变矮只需等下一次重建时再算
    if (h > this.maxHeightCache) this.maxHeightCache = h;
    if (i < this.dirtyFrom) this.dirtyFrom = i;
  }

  /** 批量回填，语义同 setHeight，但只标一次脏 */
  setHeights(updates: readonly { index: number; height: number }[]): void {
    for (const u of updates) this.setHeight(u.index, u.height);
  }

  /** 整体重建（例如换了文档） */
  reset(count: number, defaultHeight: number): void {
    this.count = Math.max(0, Math.floor(finite(count, 0)));
    const h = Math.max(0, finite(defaultHeight, 0));
    this.heights.length = 0;
    this.starts.length = 0;
    this.ends.length = 0;
    for (let i = 0; i < this.count; i++) {
      this.heights.push(h);
      this.starts.push(0);
      this.ends.push(0);
    }
    this.uniform = true;
    this.dirtyFrom = 0;
    this.rebuilds = 0;
    this.maxHeightCache = -1;
  }

  /** 第 index 项的起点 y（px） */
  offsetOf(index: number): number {
    if (this.count === 0) return 0;
    if (index <= 0) return 0;
    if (index >= this.count) return this.totalHeight;
    this.ensure();
    return this.starts[index];
  }

  /** 内容总高等于 offsetOf(count) */
  get contentHeight(): number {
    return this.offsetOf(this.count);
  }

  /**
   * y 像素坐标落在哪一项。超出末尾返回 count（而不是 count-1）——
   * 调用方据此能区分「在最后一项内」和「在内容下方的空白处」。
   */
  indexAt(y: number): number {
    if (this.count === 0) return 0;
    const yy = finite(y, 0);
    if (yy <= 0) return 0;
    this.ensure();
    const total = this.totalHeight;
    if (yy >= total) return this.count;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= yy) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * 补齐失效的偏移。
   * 从 dirtyFrom 重算到末尾 —— 为什么不做更聪明的「只重算变化窗口」：
   * 变高列表里第 i 项变高会让其后**所有**偏移平移，区间和/树状数组的
   * 插入成本与收益在 n<=10^5 这个量级上并不划算，而滚动时每次回填的
   * 是一整屏连续下标，dirtyFrom 一次前移即可摊销掉整屏成本。
   */
  private ensure(): void {
    if (this.count === 0) {
      this.dirtyFrom = 0;
      return;
    }
    // 已是最新就直接返回 —— 这个判断必须放在均匀快速路径**之前**：
    // 否则等高的表每查询一次都会重跑一遍 O(n) 的填充循环，
    // 虚拟列表每次滚动要查几十次偏移，等于把 O(1) 的快速路径变成 O(n)。
    if (this.dirtyFrom >= this.count) return;
    if (this.uniform) {
      const h = this.heights[0];
      for (let i = 0; i < this.count; i++) {
        this.starts[i] = i * h;
        this.ends[i] = (i + 1) * h;
      }
      this.rebuilds++;
      this.dirtyFrom = this.count;
      return;
    }
    this.rebuilds++;
    let from = Math.max(0, this.dirtyFrom);
    let acc = from === 0 ? 0 : this.ends[from - 1];
    for (let i = from; i < this.count; i++) {
      this.starts[i] = acc;
      acc += this.heights[i];
      this.ends[i] = acc;
    }
    this.dirtyFrom = this.count;
  }

  private defaultHeightGuess(): number {
    for (let i = 0; i < this.count; i++) return this.heights[i];
    return 0;
  }

  /** 快照，便于渲染器一次性取用（返回内部数组的副本，避免外部误改） */
  snapshotStarts(): number[] {
    this.ensure();
    return this.starts.slice(0, this.count);
  }

  snapshotEnds(): number[] {
    this.ensure();
    return this.ends.slice(0, this.count);
  }
}

/* ==================================================================== */
/* 段落高度估算                                                          */
/* ==================================================================== */

/** 估算时可以给定的可用宽度（pt），用于调参 */
export interface EstimateOptions {
  /** 默认字号 pt，段落内 run 未指定 size 时使用 */
  defaultSizePt?: number;
  /** 默认行距倍率（未指定 lineHeight 时）。Office 单倍行距约等于字号的 1.2 倍 */
  defaultLineHeight?: number;
  /** 行距换算成 px 时的最小行高，避免字号极小时行高塌成 0 */
  minLineHeightPt?: number;
}

const CJK_RE = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;
/**
 * 西文近似字宽（em）。
 * 真实值是逐字度量（Times 的 'i' 远窄于 'm'），但模型里只有字体**名字**，
 * 没有字体文件（零依赖、不带 web font），拿不到真实 advance width。
 * 取 0.5em 是常见西文正文的平均值 —— 这必然带来误差，见 estimateParaHeight 的说明。
 */
const LATIN_EM = 0.5;
const CJK_EM = 1;
const SPACE_EM = 0.28;
/** 行距倍率换算 px 时的字号下限，防止除零 */
const MIN_SPACING_FONT_PT = 1;

/**
 * 估算一个段落的显示高度（**px**，因为要给 CSS 用）。
 *
 * 误差来源（必须写清楚，否则会被当成精确排版来用）：
 *   1. **没有字体度量**：西文按 0.5em、CJK 按 1em 近似，等宽/窄体字体会明显偏离
 *   2. **没有真正的断行算法**：不做连字符断词、不做 CJK 禁则（不把标点推到行首），
 *      只按「累计宽度超过可用宽度就换行」处理，因此长英文单词的换行位置会不同
 *   3. **没有字体回退链**：模型只给了字体名，浏览器实际用哪个字体未知
 *   4. **忽略表格内嵌、浮动图片的文字环绕**：只按行内图片占位估算
 *   5. 行距按 lineHeight 倍率乘字号近似，未考虑字体的 ascent/descent 差异
 *
 * 因此这个值只用于**首屏占位**；真实高度会在渲染后由
 * reflow.ts 用 offsetHeight 实测回填进 OffsetTable，误差会随滚动被纠正。
 * 换句话说：估算可以不准，但不能不稳定（同样输入必须同样输出，否则
 * 每次重算都跳来跳去，比不准更糟）。
 */
export function estimateParaHeight(para: Paragraph, availWidthPt: number, defaultSizePt = 12, options: EstimateOptions = {}): number {
  const baseSize = Math.max(MIN_SPACING_FONT_PT, finite(defaultSizePt, 12));
  const avail = Math.max(1, finite(availWidthPt, 400));
  const style = para.style;

  const indentStart = Math.max(0, finite(style?.indentStart, 0));
  const indentEnd = Math.max(0, finite(style?.indentEnd, 0));
  const indentFirst = finite(style?.indentFirst, 0);
  // 内容可用宽度 = 版心 - 左缩进 - 右缩进；首行缩进为负（悬挂）时首行更宽
  const contentWidth = Math.max(1, avail - indentStart - indentEnd);

  let maxSize = baseSize;
  let totalPt = 0;
  let lines = 1;
  let lineWidth = 0;
  let blankLine = true;

  const commitLine = (): void => {
    lineWidth = 0;
    lines++;
    blankLine = false;
  };

  const addRun = (run: Run): void => {
    // 行内图片：按自身高度单独成段内的一行，宽度不参与断行（近似）
    if (run.image) {
      blankLine = false;
      if (lineWidth > 0) commitLine();
      const ih = Math.max(baseSize, finite(run.image.height, baseSize));
      totalPt += ih;
      return;
    }
    if (run.breakBefore) {
      if (lineWidth > 0 || blankLine) commitLine();
      lineWidth = 0;
    }
    const size = Math.max(MIN_SPACING_FONT_PT, finite(run.style?.size, baseSize));
    if (size > maxSize) maxSize = size;
    const spacing = finite(run.style?.letterSpacing, 0);
    const text = run.text ?? '';
    if (text.length === 0) return;
    for (const ch of text) {
      if (ch === '\n') {
        commitLine();
        blankLine = false;
        continue;
      }
      blankLine = false;
      const em = CJK_RE.test(ch) ? CJK_EM : ch === '\t' || ch === ' ' ? SPACE_EM : LATIN_EM;
      const w = em * size + spacing;
      // 超过内容宽度就换行（首行可用宽度要减去首行缩进，这里统一用整行宽度近似）
      if (lineWidth + w > contentWidth && lineWidth > 0) commitLine();
      lineWidth += w;
    }
  };

  const runs = para.runs ?? [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    // 首行缩进只影响第一行的实际宽度，误差很小，这里不单独建模（见注释 5）
    addRun(r);
  }
  void indentFirst;

  // 行距：exact 优先（Word 的「固定值」），否则 倍率 × 字号
  const exact = finite(style?.lineHeightExact, 0);
  const ratio = Math.max(0.5, finite(style?.lineHeight, finite(options.defaultLineHeight, 1.2)));
  const lineSpacing = exact > 0 ? exact : maxSize * ratio;
  const minLine = Math.max(1, finite(options.minLineHeightPt, 1));

  const textHeight = Math.max(1, lines) * Math.max(minLine, lineSpacing) + totalPt;
  const spaceBefore = Math.max(0, finite(style?.spaceBefore, 0));
  const spaceAfter = Math.max(0, finite(style?.spaceAfter, 0));

  return round2px(ptToPx(textHeight + spaceBefore + spaceAfter));
}

/** 估算任意块的高度（px）。非段落块给一个保守的默认值。 */
export function estimateBlockHeight(block: Block, availWidthPt: number, defaultSizePt = 12): number {
  switch (block.kind) {
    case 'para':
      return estimateParaHeight(block, availWidthPt, defaultSizePt);
    case 'table': {
      // 表格高度 = 各行高之和；行高缺省按行内文本估算
      let h = 0;
      const widths = block.widths;
      const colCount = Math.max(
        1,
        widths?.length ?? Math.max(...block.rows.map((r) => r.cells.length), 1),
      );
      const cellWidth = Math.max(12, availWidthPt / colCount);
      for (const row of block.rows) {
        let rowH = finite(row.height, 0) > 0 ? ptToPx(row.height!) : 0;
        for (const cell of row.cells) {
          let ch = 0;
          for (const cb of cell.blocks) ch += estimateBlockHeight(cb, cellWidth / Math.max(1, cell.colSpan ?? 1), defaultSizePt);
          const pad = ptToPx(2 * finite(cell.padding, 2));
          if (ch + pad > rowH) rowH = ch + pad;
        }
        h += Math.max(ptToPx(14), rowH);
      }
      return round2px(h);
    }
    case 'image':
      return round2px(ptToPx(Math.max(1, finite(block.image.height, 12))));
    case 'pagebreak':
      return round2px(ptToPx(24));
    case 'rule':
      return round2px(ptToPx(8));
    case 'raw':
      return estimateParaHeight({ kind: 'para', runs: [{ text: block.text }] }, availWidthPt, defaultSizePt);
    default:
      return round2px(ptToPx(16));
  }
}

function round2px(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ==================================================================== */
/* 表格：行列双向虚拟化                                                   */
/* ==================================================================== */

/**
 * 行的可见区间与垂直偏移。
 * 行高是**稀疏指定**的（Sheet.rowHeights 只存被显式设过的行），
 * 所以这里接受一个「取值函数」而不是数组 —— 百万行时不能为了取高而建数组。
 */
export function gridVisibleRows(
  scrollTop: number,
  viewportHeight: number,
  rowHeights: Map<number, number> | undefined,
  defaultRowHeight: number,
  count: number,
  overscan = 2,
): { start: number; end: number; top: number; bottom: number } {
  const n = Math.max(0, Math.floor(finite(count, 0)));
  if (n === 0) return { start: 0, end: 0, top: 0, bottom: 0 };
  const def = Math.max(0, finite(defaultRowHeight, 0));

  // 快路径：没有任何自定义行高时，偏移就是乘法，不必建前缀和数组。
  // 上界刻意用 ceil((scrollTop + vh + over) / def)：这里要的是「最后一个
  // 起点仍在视口下沿之上的行 + 1」，而 ceil 恰好会多带一行（下沿正好落在
  // 行边界时那一行的起点等于下沿、本该排除）。所以下面再夹一次 end--。
  if (!rowHeights || rowHeights.size === 0) {
    if (def <= 0) return { start: 0, end: 0, top: 0, bottom: 0 };
    const vh = Math.max(0, finite(viewportHeight, 0));
    const y = Math.max(0, finite(scrollTop, 0));
    // 滚过内容末尾时把 first 夹回最后一行，避免返回空区间（整屏空白）
    const first = Math.min(n - 1, Math.max(0, Math.floor(y / def)));
    let start = Math.max(0, first - overscan);
    let end = Math.ceil((y + vh + overscan) / def);
    end = Math.min(n, Math.max(end, first + 1));
    if (end > start && (end - 1) * def >= y + vh + overscan) end--;
    if (end <= start) end = Math.min(n, start + 1);
    return { start, end, top: start * def, bottom: end * def };
  }

  const heights = new Array<number>(n);
  for (let i = 0; i < n; i++) heights[i] = rowHeights.get(i) ?? def;
  const { starts, ends } = prefixSums(heights);
  const range = visibleRange(scrollTop, viewportHeight, starts, ends, { overscan });
  let start = range.start;
  // 与上面的乘法快路径对齐：overscan 至少向前多带 overscan 行。
  // 只靠 visibleRange 的话，上沿正好落在行边界时会少带一行 ——
  // 两条路径给出不同的窗口，滚动中会看到内容“跳一格”。
  const first = Math.min(n - 1, Math.max(0, Math.floor(Math.max(0, finite(scrollTop, 0)) / def)));
  start = Math.max(0, Math.min(start, first - overscan));
  const end = Math.max(range.end, start + 1);
  return {
    start,
    end,
    top: start === 0 ? 0 : starts[start],
    bottom: end === 0 ? 0 : ends[end - 1],
  };
}

/**
 * 列的可见区间与水平偏移。
 * 列数远小于行数（Excel 上限 16384），所以可以放心展开成数组。
 */
export function gridVisibleCols(
  scrollLeft: number,
  viewportWidth: number,
  colWidths: readonly number[] | undefined,
  defaultColWidth: number,
  count: number,
  overscan = 1,
): { start: number; end: number; left: number; right: number } {
  const n = Math.max(0, Math.floor(finite(count, 0)));
  if (n === 0) return { start: 0, end: 0, left: 0, right: 0 };
  const def = Math.max(1, finite(defaultColWidth, 48));
  const heights = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const w = colWidths?.[i];
    heights[i] = finite(w, 0) > 0 ? w! : def;
  }
  const { starts, ends } = prefixSums(heights);
  const range = visibleRange(scrollLeft, viewportWidth, starts, ends, { overscan });
  return {
    start: range.start,
    end: range.end,
    left: range.start === 0 ? 0 : starts[range.start],
    right: range.end === 0 ? 0 : ends[range.end - 1],
  };
}

/** 计算列宽的归一化数组（缺省补默认宽度），供偏移计算复用 */
export function resolveColWidths(colWidths: readonly number[] | undefined, defaultColWidth: number, count: number): number[] {
  const n = Math.max(0, Math.floor(finite(count, 0)));
  const def = Math.max(1, finite(defaultColWidth, 48));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const w = colWidths?.[i];
    out[i] = finite(w, 0) > 0 ? w! : def;
  }
  return out;
}

function prefixSums(values: readonly number[]): { starts: number[]; ends: number[] } {
  const n = values.length;
  const starts = new Array<number>(n);
  const ends = new Array<number>(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    starts[i] = acc;
    acc += values[i];
    ends[i] = acc;
  }
  return { starts, ends };
}

/* ==================================================================== */
/* 合并单元格                                                            */
/* ==================================================================== */

export interface ResolvedMerges {
  /** 锚点落在可视窗口内、需要按跨行列渲染的合并区域 */
  visible: MergeRange[];
  /** 窗口内需要**跳过**的单元格（被合并吃掉，渲染它们会盖住锚点） */
  skip: { r: number; c: number }[];
}

/**
 * 求窗口内要处理的合并区域。
 *
 * 关键规则：**锚点在窗口外就整块不渲染**。
 * 因为合并区域是绝对定位的一个大格子，当用户滚到它的下半部分时，
 * 锚点（左上角）已经在视口之上 —— 此时若只渲染「可见部分」，
 * 要么画出一个高度错误的半截格子，要么把它当作空格子从而内容凭空消失。
 * 两种都不如不渲染：滚动到锚点可见时它自然会出现。
 * （替代方案是给锚点做 sticky 定位，会把表格渲染器复杂度推高一个量级，
 *  而收益只是「滚动中合并格短暂不显示」，不值得。）
 */
export function resolveMerges(merges: readonly MergeRange[] | undefined, rowRange: VisibleRange, colRange: VisibleRange): ResolvedMerges {
  const visible: MergeRange[] = [];
  const skip: { r: number; c: number }[] = [];
  if (!merges || merges.length === 0) return { visible, skip };
  if (rowRange.end <= rowRange.start || colRange.end <= colRange.start) return { visible, skip };

  for (const m of merges) {
    // 与窗口无交集
    if (m.r2 < rowRange.start || m.r1 >= rowRange.end) continue;
    if (m.c2 < colRange.start || m.c1 >= colRange.end) continue;
    // 单格「合并」没有意义，跳过以免产生无用的 skip 项
    if (m.r1 === m.r2 && m.c1 === m.c2) continue;
    const anchorVisible = m.r1 >= rowRange.start && m.r1 < rowRange.end && m.c1 >= colRange.start && m.c1 < colRange.end;
    if (!anchorVisible) continue;
    visible.push(m);
    for (let r = Math.max(m.r1, rowRange.start); r <= Math.min(m.r2, rowRange.end - 1); r++) {
      for (let c = Math.max(m.c1, colRange.start); c <= Math.min(m.c2, colRange.end - 1); c++) {
        if (r === m.r1 && c === m.c1) continue;
        skip.push({ r, c });
      }
    }
  }
  return { visible, skip };
}

/* ==================================================================== */
/* PDF 坐标变换                                                          */
/* ==================================================================== */

export interface CssBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 把 PDF 坐标（**原点在左下**，y 向上）转成 CSS 坐标（**原点在左上**，y 向下）。
 *
 * 这是 PDF 渲染最容易出错的一步：忘了翻转 y 的典型症状是「整页文字上下镜像」，
 * 而页数多的时候不容易一眼看出。所以把它做成纯函数并单独测试。
 *
 * 轮换（/Rotate）说明：按 PDF 规范 MediaBox 是**未旋转**的尺寸，显示时先按
 * rotate 转 90° 的倍数（顺时针）再映射到 CSS。这里把 rotate 与 y 翻转一起算进
 * 坐标，因此 pdf.ts 渲染旋转页时**不需要**再加 `transform: rotate()` ——
 * 加了两者会互相抵消。
 */
export function pdfPageToCss(items: readonly PdfItem[], page: PdfPage, scale: number, zoom = 1): CssBox[] {
  const s = Math.max(0.0001, finite(scale, 1) * finite(zoom, 1));
  const pw = Math.max(1, finite(page.width, 612));
  const ph = Math.max(1, finite(page.height, 792));
  const rot = normalizeRotate(page.rotate);
  const out: CssBox[] = [];

  for (const it of items) {
    if (it.kind === 'text') {
      const h = Math.max(1, finite(it.size, 12));
      const w = finite(it.width, 0) > 0 ? it.width! : estimateTextWidth(it);
      const box = mapPdfRect(it.x, it.y, w, h, pw, ph, rot);
      out.push({ left: box[0] * s, top: box[1] * s, width: box[2] * s, height: box[3] * s });
    } else if (it.kind === 'rect') {
      const box = mapPdfRect(it.x, it.y, Math.max(0, it.w), Math.max(0, it.h), pw, ph, rot);
      out.push({ left: box[0] * s, top: box[1] * s, width: box[2] * s, height: box[3] * s });
    } else if (it.kind === 'line') {
      // 线段转成「外接盒 + 端点」，渲染器用 border 画水平/垂直线
      const x0 = Math.min(it.x1, it.x2);
      const x1 = Math.max(it.x1, it.x2);
      const y0 = Math.min(it.y1, it.y2);
      const y1 = Math.max(it.y1, it.y2);
      const box = mapPdfRect(x0, y0, Math.max(0.2, x1 - x0), Math.max(0.2, y1 - y0), pw, ph, rot);
      out.push({ left: box[0] * s, top: box[1] * s, width: box[2] * s, height: box[3] * s });
    } else {
      const box = mapPdfRect(it.x, it.y, Math.max(0, it.w), Math.max(0, it.h), pw, ph, rot);
      out.push({ left: box[0] * s, top: box[1] * s, width: box[2] * s, height: box[3] * s });
    }
  }
  return out;
}

/**
 * 单个点的 PDF -> CSS 变换（供需要点而非盒的调用方使用，例如下划线、链接热区）。
 */
export function pdfPointToCss(x: number, y: number, page: PdfPage, zoom = 1): { left: number; top: number } {
  const pw = Math.max(1, finite(page.width, 612));
  const ph = Math.max(1, finite(page.height, 792));
  const box = mapPdfRect(x, y, 0, 0, pw, ph, normalizeRotate(page.rotate));
  return { left: box[0] * zoom, top: box[1] * zoom };
}

/** 文字项宽度估算（PDF 里宽度常缺失，用字号 × 字宽近似，与段落估算同一套系数） */
function estimateTextWidth(it: PdfTextItem): number {
  const size = Math.max(1, finite(it.size, 12));
  let em = 0;
  for (const ch of it.text ?? '') em += CJK_RE.test(ch) ? CJK_EM : ch === ' ' ? SPACE_EM : LATIN_EM;
  return em * size + Math.max(0, finite(it.charSpacing, 0)) * (it.text?.length ?? 0);
}

function normalizeRotate(rot: number | undefined): 0 | 90 | 180 | 270 {
  const r = Math.round(finite(rot, 0) / 90) * 90;
  const m = ((r % 360) + 360) % 360;
  return m === 90 ? 90 : m === 180 ? 180 : m === 270 ? 270 : 0;
}

/**
 * @returns [left, top, width, height]（CSS px，未乘 scale）
 * 输入 x/y 是 PDF 坐标（原点左下），x/y 指矩形的**左下角**。
 *
 * 变换 = 先按 /Rotate 顺时针旋转（90 的倍数），再合并「y 轴翻转」这一步。
 * 两种映射合成一个仿射变换后再作用于四个角，最后取包围盒 ——
 * 这样只需要维护 4 个分支，且旋转与翻转的顺序不会搞反。
 *
 * 为什么用「四角映射 + 包围盒」而不是逐个分支手推宽高：
 * 手推时最典型的 bug 是 90° 忘了交换页面宽高，表现是整页文字挤在一条竖线上；
 * 取包围盒则天然得到正确的 alt-swap 结果。
 */
function mapPdfRect(x: number, y: number, w: number, h: number, pw: number, ph: number, rot: 0 | 90 | 180 | 270): [number, number, number, number] {
  /**
   * 合成变换 T(px, py)：
   *   rot=0   : (px, py)
   *   rot=90  : (py, pw - px)
   *   rot=180 : (pw - px, ph - py)
   *   rot=270 : (ph - py, px)
   * 然后再做 y 翻转：top = 视觉高度 - ty。
   * 视觉高度：0/180 为 ph，90/270 为 pw（宽高对调）。
   */
  const visualHeight = rot === 90 || rot === 270 ? pw : ph;
  const rotate = (px: number, py: number): [number, number] => {
    let tx = px;
    let ty = py;
    if (rot === 90) {
      tx = py;
      ty = pw - px;
    } else if (rot === 180) {
      tx = pw - px;
      ty = ph - py;
    } else if (rot === 270) {
      tx = ph - py;
      ty = px;
    }
    return [tx, visualHeight - ty];
  };
  const corners: Array<[number, number]> = [
    rotate(x, y),
    rotate(x + w, y),
    rotate(x, y + h),
    rotate(x + w, y + h),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of corners) {
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

/* ==================================================================== */
/* 小工具                                                                */
/* ==================================================================== */

/** 页码/幻灯片序号 -> 容器垂直偏移（页高固定的场景） */
export function pageOffset(pageIndex: number, pageHeightPx: number, gapPx = 0): number {
  const h = Math.max(0, finite(pageHeightPx, 0));
  const g = Math.max(0, finite(gapPx, 0));
  return Math.max(0, Math.floor(finite(pageIndex, 0))) * (h + g);
}
