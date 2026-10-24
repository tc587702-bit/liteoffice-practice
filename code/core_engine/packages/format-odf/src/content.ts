/**
 * ODF 文字处理（odt/ott/fodt）正文解析：`office:text` -> UDM `blocks`。
 *
 * 这一层承担 ODF 里最容易做错的两件事：
 *
 *   1) **列表的两级间接**：段落上的 `text:style-name` 指的是列表样式名，
 *      真正的符号 / 编号格式在 `text:list-style` -> `text:list-level-style-*` 里。
 *      而且编号是**有状态的**（第几个 item），必须在这里维护计数器。
 *      少做任何一步，列表就会显示成普通段落 —— 用户一眼看出是假的。
 *
 *   2) **`table:number-columns-repeated`**：ODF 用它压缩空白填充，
 *      LibreOffice 导出的表格里这个值常常是 1024 / 16384（甚至 0x40000000）。
 *      天真地按值展开会瞬间构造出上万个单元格对象并吃掉几十 MB。
 *      因此所有重复必须先 clamp 到「本表列数上限」与「剩余单元格预算」，
 *      并且**连续的空重复格共享同一个 TableCell 对象**（见 pushRepeated）。
 *
 * 为什么这里不用 LazyGrid/流式二次解析：
 *   文字处理文档的表格通常很小，而且 UDM 的 Block[] 本身就要物化。
 *   真正需要惰性的是 ods 的大表（见 sheets.ts），那里走 MaterializedGrid
 *   并在超限时截断记录。
 */
import type { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import type {
  Block,
  InlineImage,
  Paragraph,
  ParaStyle,
  Run,
  RunStyle,
  Table,
  TableCell,
  TableRow,
} from '../../core/src/index.ts';
import { cssLengthToPt } from '../../core/src/units.ts';
import { attr, attrInt, isExternalHref, mimeFromPath, parseColor, resolvePartPath } from './xmlUtil.ts';
import { columnWidthPt, renderListMarker, resolveCell, resolvePara, resolveRun, rowHeightPt } from './styles.ts';
import { markTruncated, registerImage, warn } from './types.ts';
import type { OdCellProps, OdContext, OdListLevel, OdListStyle } from './types.ts';

/* ==================================================================== */
/* 上下文                                                                */
/* ==================================================================== */

export interface TextParseTarget {
  blocks: Block[];
}

/** 列表处理状态：一级一个计数器（ODF 的编号是「同级自增」）。 */
interface ListState {
  style: OdListStyle | undefined;
  /** 1 起 */
  level: number;
  /** 已消费的 item 数 */
  counter: number;
}

/** 段落解析时可选的列表上下文。 */
interface ParaContext {
  list?: ListState;
}

/* ==================================================================== */
/* 入口                                                                  */
/* ==================================================================== */

/**
 * 解析 `office:body` 下的 `office:text`。
 *
 * 调用前提：解析器刚产出 `<office:text>` 的 start 事件，且非自闭合。
 * 本函数消费到它的 end 事件为止。
 */
export function parseTextBody(p: XmlPullParser, ctx: OdContext, out: TextParseTarget): void {
  let depth = 0;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') {
      if (depth === 0) return;
      depth--;
      continue;
    }
    if (e.type !== 'start') continue;
    if (!parseTextChild(p, e, ctx, out, {}) && !e.selfClosing) depth++;
  }
  // 走到这里说明还没遇到 </office:text> 文档就结束了 —— 典型的「XML 被截断」。
  // 拉取解析器在缓冲区耗尽时返回 null（**不抛错**），因此必须显式记账，
  // 否则截断的文档会看起来「打开成功但内容少了一半」。
  markTruncated(ctx, 'content', 'content.xml 在正文中途结束（文件被截断或损坏），已显示已解析的部分');
}

/**
 * 分派一个 `office:text` 的直接子元素。
 * @returns true 表示调用方不应再 skipElement（子树已被本函数消费完）
 */
function parseTextChild(
  p: XmlPullParser,
  e: XmlEvent,
  ctx: OdContext,
  out: TextParseTarget,
  listCtx: ParaContext,
): boolean {
  if (out.blocks.length >= ctx.limits.maxBlocks) {
    markTruncated(ctx, 'maxBlocks', `块数量达到上限 ${ctx.limits.maxBlocks}，其余内容已忽略`);
    return true;
  }
  switch (e.local) {
    case 'h':
    case 'p':
      parseParagraph(p, e, ctx, out.blocks, listCtx);
      return true;
    case 'list':
      parseList(p, e, ctx, out, listCtx);
      return true;
    case 'table':
      parseTable(p, e, ctx, out);
      return true;
    case 'soft-page-break':
      out.blocks.push({ kind: 'pagebreak' });
      return true;
    case 'section':
    case 'table-of-content':
    case 'table-of-content-source':
    case 'index-body':
    case 'list-item':
    case 'list-header':
      // 容器元素：返回 false 让调用方继续下钻，保证 section 里的段落不会丢
      return false;
    case 'frame': {
      const img = frameImage(p, e, ctx);
      if (img) out.blocks.push({ kind: 'image', image: img });
      return true;
    }
    default:
      return false;
  }
}

/* ==================================================================== */
/* 段落                                                                  */
/* ==================================================================== */

function parseParagraph(
  p: XmlPullParser,
  e: XmlEvent,
  ctx: OdContext,
  out: Block[],
  listCtx: ParaContext,
): void {
  const styleName = attr(e, 'style-name');
  const outlineAttr = attrInt(e, 'outline-level', 0);
  const direct: ParaStyle = {};
  if (outlineAttr > 0) direct.outlineLevel = outlineAttr - 1;

  const resolved = resolvePara(ctx.styles, styleName, direct);
  const runs: Run[] = [];
  if (!e.selfClosing) parseInline(p, ctx, runs, toRunStyle(resolved.run ?? {}));

  const style: ParaStyle = {};
  if (styleName) style.styleName = styleName;
  if (resolved.align) style.align = resolved.align;
  if (resolved.spaceBeforePt !== undefined) style.spaceBefore = resolved.spaceBeforePt;
  if (resolved.spaceAfterPt !== undefined) style.spaceAfter = resolved.spaceAfterPt;
  if (resolved.lineHeight !== undefined) style.lineHeight = resolved.lineHeight;
  if (resolved.lineHeightExactPt !== undefined) style.lineHeightExact = resolved.lineHeightExactPt;
  if (resolved.indentStartPt !== undefined) style.indentStart = resolved.indentStartPt;
  if (resolved.indentEndPt !== undefined) style.indentEnd = resolved.indentEndPt;
  if (resolved.indentFirstPt !== undefined) style.indentFirst = resolved.indentFirstPt;
  if (resolved.outlineLevel !== undefined) style.outlineLevel = resolved.outlineLevel;
  if (resolved.pageBreakBefore) style.pageBreakBefore = true;
  if (resolved.shading) style.shading = resolved.shading;

  applyListStyle(style, listCtx.list);

  out.push({ kind: 'para', runs: runs.length ? runs : [{ text: '' }], style });
}

function applyListStyle(style: ParaStyle, list: ListState | undefined): void {
  if (!list) return;
  const level = levelOf(list.style, list.level);
  const rendered = renderListMarker(level, currentListItemNumber(list));
  style.listLevel = Math.max(0, list.level - 1);
  style.listOrdered = rendered.ordered;
  if (rendered.marker) style.listMarker = rendered.marker;
  // 列表级别自带的缩进：没有它所有级别的项目符号都会挤在左边界叠在一起
  if (level?.indentPt !== undefined && style.indentStart === undefined) style.indentStart = level.indentPt;
  if (level?.spaceBeforePt !== undefined && style.spaceBefore === undefined) style.spaceBefore = level.spaceBeforePt;
}

function levelOf(style: OdListStyle | undefined, level: number): OdListLevel | undefined {
  if (!style) return undefined;
  return style.levels.get(level) ?? style.levels.get(1) ?? [...style.levels.values()][0];
}

/** 当前 item 的编号值：text:start-value 起算，第 n 个 item 就是 start + n - 1。 */
function currentListItemNumber(state: ListState): number {
  const level = levelOf(state.style, state.level);
  const start = level?.startValue ?? 1;
  return start + Math.max(0, state.counter - 1);
}

/* ==================================================================== */
/* 列表                                                                  */
/* ==================================================================== */

function parseList(p: XmlPullParser, e: XmlEvent, ctx: OdContext, out: TextParseTarget, parent: ParaContext): void {
  const styleName = attr(e, 'style-name');
  const inherited = parent.list;
  // ODF 的嵌套列表通过 text:list 的嵌套表达，没有显式 level 属性，
  // 因此层级只能靠**嵌套深度**推导。
  const level = inherited ? inherited.level + 1 : 1;
  const style = resolveListStyle(ctx, styleName) ?? inherited?.style;
  if (!style) warn(ctx, `列表样式 ${styleName ?? '(未命名)'} 未找到定义，已按普通段落降级显示`);
  const state: ListState = { style, level, counter: 0 };
  const childCtx: ParaContext = { list: state };

  if (e.selfClosing) return;
  let c: XmlEvent | null;
  while ((c = p.next()) !== null) {
    if (c.type === 'end') return;
    if (c.type !== 'start') continue;
    if (c.local === 'list-item') {
      // 一个 list-item 计一次数；嵌套列表在自己的 parseList 里另开计数器
      state.counter++;
      if (!c.selfClosing) {
        let ie: XmlEvent | null;
        while ((ie = p.next()) !== null) {
          if (ie.type === 'end') break;
          if (ie.type !== 'start') continue;
          if (!parseTextChild(p, ie, ctx, out, childCtx) && !ie.selfClosing) p.skipElement();
        }
      }
      continue;
    }
    // text:list-header 与直接挂在 text:list 下的段落（少数生成器如此）
    if (!parseTextChild(p, c, ctx, out, childCtx) && !c.selfClosing) p.skipElement();
  }
}

/**
 * 找列表样式定义。顺序：
 *   显式名字 -> ODF 规范默认名 "Default"（LibreOffice 未显式指定时用）
 *   -> 任何已解析出的列表样式（尽力而为，总好过退化成普通段落）。
 */
function resolveListStyle(ctx: OdContext, name: string | undefined): OdListStyle | undefined {
  if (name) {
    const hit = ctx.styles.lists.get(name);
    if (hit) return hit;
  }
  const byDefault = ctx.styles.lists.get('Default') ?? ctx.styles.lists.get('List');
  if (byDefault) return byDefault;
  for (const v of ctx.styles.lists.values()) return v;
  return undefined;
}

/* ==================================================================== */
/* 行内内容                                                              */
/* ==================================================================== */

/**
 * 解析一行的行内内容，产出 run 序列。
 * @param base 段落级字符格式（来自段落样式），作为 span 继承的基底
 */
export function parseInline(p: XmlPullParser, ctx: OdContext, runs: Run[], base: RunStyle | undefined): void {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type === 'text' || e.type === 'cdata') {
      // 解析器默认丢弃「全空白」的文本节点，这对 ODF 是正确的：
      // ODF 要求用 text:s 显式表达连续空格，源文件里的缩进空白不具语义。
      if (e.text) runs.push(withStyle(e.text, base));
      continue;
    }
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'span':
        pushSpan(p, e, ctx, runs, base);
        continue;
      case 'a':
        pushHyperlink(p, e, ctx, runs, base);
        continue;
      case 's': {
        // text:s 是连续空格的压缩写法：text:c 是重复次数（缺省 1）。
        // 不处理它，词间多空格会消失，排版看起来「黏在一起」。
        const count = Math.max(1, Math.min(attrInt(e, 'c', 1), 4096));
        runs.push(withStyle(' '.repeat(count), base));
        continue;
      }
      case 'tab':
        runs.push(withStyle('\t', base));
        continue;
      case 'line-break':
        runs.push({ text: '\n', style: base });
        continue;
      case 'soft-page-break':
        // 模型里段落内没有分页语义，用换行近似并记录一次降级
        runs.push({ text: '\n', style: base });
        warn(ctx, '段落内的 text:soft-page-break 已降级为换行（UDM 无段内分页）');
        continue;
      case 'frame': {
        const img = frameImage(p, e, ctx);
        if (img) runs.push({ text: '', image: img });
        continue;
      }
      case 'note': {
        // 脚注/尾注：UDM 有 noteRef 但注文本身在同一树里，
        // 这里只登记引用，注文不展开（避免与正文混淆）。
        const id = attr(e, 'id') ?? attr(e, 'note-id') ?? '';
        const kind = attr(e, 'note-class') === 'endnote' ? 'endnote' : 'footnote';
        runs.push({ text: '', noteRef: { kind, id } });
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      case 'bookmark-start':
      case 'bookmark-end':
      case 'bookmark-ref':
      case 'reference-mark':
      case 'reference-mark-start':
      case 'reference-mark-end':
      case 'meta':
      case 'meta-field':
        if (!e.selfClosing) p.skipElement();
        continue;
      default:
        // 未知子元素：继续下钻而不是跳过 —— 里面很可能还有承载文本的 span。
        // 「宁可多走一层」比「丢掉一段正文」代价小得多。
        continue;
    }
  }
}

function withStyle(text: string, base: RunStyle | undefined): Run {
  return base ? { text, style: base } : { text };
}

function pushSpan(p: XmlPullParser, e: XmlEvent, ctx: OdContext, runs: Run[], base: RunStyle | undefined): void {
  const name = attr(e, 'style-name');
  // ODF 的 text:style-name 是**绝对引用**（不是相对外层 span 的父样式），
  // 所以解析基底只取段落级格式，不把外层 span 当 parent。
  const resolved = resolveRun(ctx.styles, 'text', name, undefined, toRunProps(base));
  const style = mergeRunStyle(base, toRunStyle(resolved));
  if (e.selfClosing) return;
  parseInline(p, ctx, runs, style);
}

function pushHyperlink(p: XmlPullParser, e: XmlEvent, ctx: OdContext, runs: Run[], base: RunStyle | undefined): void {
  const href = attr(e, 'href');
  const name = attr(e, 'style-name');
  const resolved = resolveRun(ctx.styles, 'text', name, undefined, toRunProps(base));
  const style = mergeRunStyle(base, toRunStyle(resolved));
  if (href) style.link = href;
  else warn(ctx, 'text:a 缺少 xlink:href，已按普通文本降级');

  const before = runs.length;
  if (!e.selfClosing) parseInline(p, ctx, runs, style);
  // 只有属性没有内容的链接：补一个 run，否则链接会整个消失
  if (runs.length === before && href) runs.push({ text: href, style });
}

/* ==================================================================== */
/* RunStyle <-> OdRunProps 互转                                          */
/* ==================================================================== */

export function toRunStyle(r: {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  sizePt?: number;
  font?: string;
  fontAsian?: string;
  vertAlign?: 'baseline' | 'subscript' | 'superscript';
  letterSpacingPt?: number;
  caps?: 'none' | 'small' | 'all';
  hidden?: boolean;
}): RunStyle {
  const s: RunStyle = {};
  if (r.bold !== undefined) s.bold = r.bold;
  if (r.italic !== undefined) s.italic = r.italic;
  if (r.underline !== undefined) s.underline = r.underline;
  if (r.strike !== undefined) s.strike = r.strike;
  if (r.color) s.color = r.color;
  if (r.highlight) s.highlight = r.highlight;
  if (r.sizePt !== undefined) s.size = r.sizePt;
  if (r.font) s.font = r.font;
  if (r.fontAsian) s.fontEastAsia = r.fontAsian;
  if (r.vertAlign && r.vertAlign !== 'baseline') s.vertAlign = r.vertAlign;
  if (r.letterSpacingPt !== undefined) s.letterSpacing = r.letterSpacingPt;
  if (r.caps && r.caps !== 'none') s.caps = r.caps;
  if (r.hidden) s.hidden = true;
  return s;
}

export function toRunProps(s: RunStyle | undefined): {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  sizePt?: number;
  font?: string;
  fontAsian?: string;
  vertAlign?: 'baseline' | 'subscript' | 'superscript';
  letterSpacingPt?: number;
  caps?: 'none' | 'small' | 'all';
} {
  if (!s) return {};
  return {
    bold: s.bold,
    italic: s.italic,
    underline: s.underline,
    strike: s.strike,
    color: s.color,
    highlight: s.highlight,
    sizePt: s.size,
    font: s.font,
    fontAsian: s.fontEastAsia,
    vertAlign: s.vertAlign,
    letterSpacingPt: s.letterSpacing,
    caps: s.caps,
  };
}

/** 合并两个 RunStyle（后者覆盖前者），用于 span / 链接的嵌套。 */
export function mergeRunStyle(a: RunStyle | undefined, b: RunStyle): RunStyle {
  if (!a) return b;
  const out: RunStyle = { ...a };
  for (const k of Object.keys(b) as Array<keyof RunStyle>) {
    const v = b[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/* ==================================================================== */
/* 表格                                                                  */
/* ==================================================================== */

/** 单表单元格硬上限：即使 limits.maxCells 很大，也不能让一个畸形表吃光内存。 */
const MAX_CELLS_PER_TABLE = 200_000;
/**
 * 列声明的**安全上界**。
 *
 * 为什么还需要一个上界：`table:table-column` 自己也可能带一个天文数字的
 * `number-columns-repeated`。列声明本身只是一串数字，代价极小，但上界仍然要有，
 * 否则一个畸形文件能让我们为「列宽数组」分配上亿个元素。
 */
const HARD_MAX_COLS = 16_384;

/**
 * 计算一张表的**有效列上限**：表的列声明与 `limits.maxCols` 取小。
 *
 * 两道闸门缺一不可：
 *   - 只用固定常数（早期实现是 1024）会把 4 列的表裁到 1024 列，
 *     每行仍物化上千个空对象 —— 问题被缩小而不是消掉；
 *   - 只看列声明则会让「声明了 16384 列」这种畸形文件突破 limits.maxCols。
 */
function effectiveColLimit(declaredCols: number, maxCols: number): number {
  const declared = declaredCols > 0 ? declaredCols : HARD_MAX_COLS;
  return Math.max(1, Math.min(declared, Math.max(1, maxCols), HARD_MAX_COLS));
}

/** 单元格 / 列 / 行重复的裁剪预算，贯穿整张表的解析过程。 */
interface TableBudget {
  /** 本行的列数上界（列声明数 与 安全上界 取小，含 COL_HEADROOM 余量） */
  colLimit: number;
  /**
   * **表声明的列数**（不含余量）。
   * 这是 `number-columns-repeated` 的裁剪依据 —— 余量只用于「别误删真实数据」，
   * 不能拿来放宽空填充的裁剪，否则 4 列的表每行还是会多出 8 个空对象。
   */
  declaredLimit: number;
  /** 本表还能构造多少个单元格对象 */
  cellsLeft: number;
  truncatedCols: boolean;
  truncatedCells: boolean;
  /** `number-rows-repeated` 被安全上限裁剪过 */
  truncatedRows: boolean;
}

/**
 * 单表**物化行数**的硬上限。
 *
 * 为什么不能只靠 `limits.maxCells`：`number-rows-repeated` 常被用来表达
 * 「这张表下面还有几万行空白」。虽然空行的 cells 数组是共享的，但**行对象**
 * 本身仍会一个个建出来（每种渲染器都要按下标访问行）。
 * 只受 maxCells 约束时，一行 4 格 × 99999 行会先建出 10 万行对象才触发
 * 单元格预算 —— 峰值内存已经很可观了。因此这里再加一道行数闸门。
 */
const MAX_MATERIALIZED_ROWS = 4096;

/**
 * 列声明的余量。
 *
 * 裁剪上限取自表的列声明，但少数生成器会在**未声明**的列上放真实单元格
 * （声明 4 列却写了 6 个有内容的格子）。按声明数硬切会把它们当「溢出」丢掉，
 * 于是内容静默消失。留一格很小的余量即可兼顾：既不让 16380 那样的空白填充
 * 物化，又不会误删真实数据。
 */
const COL_HEADROOM = 8;

export function parseTable(p: XmlPullParser, e: XmlEvent, ctx: OdContext, out: TextParseTarget): void {
  const table: Table = { kind: 'table', rows: [] };
  const widths: number[] = [];
  if (e.selfClosing) return;

  const budget: TableBudget = {
    colLimit: HARD_MAX_COLS,
    declaredLimit: HARD_MAX_COLS,
    cellsLeft: Math.max(1, Math.min(ctx.limits.maxCells, MAX_CELLS_PER_TABLE)),
    truncatedCols: false,
    truncatedCells: false,
    truncatedRows: false,
  };
  /** 列声明累加出的逻辑列数（`table:table-column` 的 number-columns-repeated 之和） */
  let declaredCols = 0;
  /** 观测到的最大行跨度：包含「占列不建对象」的空白重复格 */
  let maxSeenCols = 0;

  let inHeader = false;
  let c: XmlEvent | null;
  while ((c = p.next()) !== null) {
    if (c.type === 'end') break;
    if (c.type !== 'start') continue;

    if (c.local === 'table-header-rows') {
      inHeader = true;
      continue;
    }
    if (c.local === 'table-rows') {
      inHeader = false;
      continue;
    }

    if (c.local === 'table-column') {
      // table:table-column 同时决定「逻辑列数」与列宽，规范允许整组重复。
      // 它必须出现在所有 table-row 之前（ODF 的 schema 如此规定），
      // 因此这里累加出的 declaredCols 在整个行解析期间都是完整的 ——
      // 不需要（也不可能）做前瞻扫描：拉取解析器只能向前。
      const raw = attrInt(c, 'number-columns-repeated', 1);
      const repeat = clampRepeat(raw, Math.max(0, HARD_MAX_COLS - declaredCols), () => {
        budget.truncatedCols = true;
        markTruncated(
          ctx,
          'number-columns-repeated',
          `table:table-column 的 number-columns-repeated=${raw} 过大，已裁剪到列数安全上界 ${HARD_MAX_COLS}`,
        );
      });
      const pt = columnWidthPt(ctx.styles, attr(c, 'style-name'));
      for (let i = 0; i < repeat; i++) widths.push(pt ?? 0);
      declaredCols += repeat;
      // 行解析期间的列数上界随列声明收紧（列声明先于行）。
      // declaredLimit 用**声明的列数本身**（与 limits.maxCols 取小），
      // colLimit 额外留一点余量：少数生成器会在未声明的列上放真实单元格，
      // 按声明数硬切会把它们当「溢出」丢掉。
      budget.declaredLimit = effectiveColLimit(declaredCols, ctx.limits.maxCols);
      budget.colLimit = Math.min(budget.declaredLimit + COL_HEADROOM, HARD_MAX_COLS);
      if (!c.selfClosing) p.skipElement();
      continue;
    }

    if (c.local === 'table-row') {
      const rowCap = Math.min(ctx.limits.maxRows, MAX_MATERIALIZED_ROWS);
      if (table.rows.length >= rowCap) {
        markTruncated(
          ctx,
          'maxRows',
          `表格行数达到上限 ${rowCap}（limits.maxRows=${ctx.limits.maxRows}，本读取器物化行数硬上限 ${MAX_MATERIALIZED_ROWS}），后续行已忽略`,
        );
        if (!c.selfClosing) p.skipElement();
        continue;
      }
      const rawRepeat = attrInt(c, 'number-rows-repeated', 1);
      const repeat = clampRepeat(rawRepeat, rowCap - table.rows.length, () => {
        budget.truncatedRows = true;
      });
      const height = rowHeightPt(ctx.styles, attr(c, 'style-name'));
      const cells: TableCell[] = [];
      let rowSpanCols = 0;
      if (!c.selfClosing) rowSpanCols = parseRowCells(p, ctx, cells, budget);
      if (rowSpanCols > maxSeenCols) maxSeenCols = rowSpanCols;
      const isEmpty = cells.length === 0 || cells.every(isEmptyCell);
      for (let i = 0; i < repeat; i++) {
        if (table.rows.length >= ctx.limits.maxRows) break;
        if (i > 0) {
          if (budget.cellsLeft <= 0) {
            budget.truncatedCells = true;
            break;
          }
          budget.cellsLeft -= cells.length;
        }
        // 空的重复行共享同一份 cells 数组引用 —— 这是 ODF 特有的内存陷阱：
        // number-rows-repeated 常被用来表达「这张表有一万行空白」。
        // 渲染器只读这些行，共享是安全的（disposeBlocks 的清理是幂等的）。
        table.rows.push({ cells: repeat > 1 && !isEmpty ? cells.map(cloneCell) : cells, height, header: inHeader || undefined });
      }
      continue;
    }

    // 表格里混入的段落（少数生成器会放在 table:table 直接子级）
    if (c.local === 'p' || c.local === 'h') {
      const tmp: TextParseTarget = { blocks: [] };
      parseParagraph(p, c, ctx, tmp.blocks, {});
      if (tmp.blocks.length) table.rows.push({ cells: [{ blocks: tmp.blocks }] });
      continue;
    }
    if (!c.selfClosing) p.skipElement();
  }

  if (table.rows.length === 0) {
    // 空表不产出空表格块，避免打开文档时凭空出现一排空白框
    return;
  }

  // 最终列数：**以表声明的列结构为准**，没有声明时才用真实行跨度兜底。
  // 「以声明为准」是关键 —— 否则 number-columns-repeated=16380 会把一张
  // 4 列的表撑成上万列的模型（早期实现按固定常数 1024 裁剪，
  // 每行仍然物化 1020 个空单元格，只是把问题缩小了 16 倍）。
  // 注意用 declaredCols 而不是 budget.colLimit：后者含 COL_HEADROOM 余量，
  // 拿它当列数会让 4 列的表被补齐成 12 列。
  const logicalCols = Math.max(
    Math.min(declaredCols, ctx.limits.maxCols, HARD_MAX_COLS),
    Math.min(maxSeenCols, ctx.limits.maxCols, HARD_MAX_COLS),
  );
  const colCount = Math.max(1, Math.min(logicalCols, HARD_MAX_COLS));
  if (maxSeenCols > colCount) budget.truncatedCols = true;
  // 每行按列数补齐：渲染器需要稳定的列位置。
  // **完全空的行跳过补齐**：它已经被列数信息表达了，为它塞满空对象毫无意义，
  // 而且一旦补齐就会破坏「重复行共享同一份 cells 数组」这个内存保证
  // （早期版本正是在这里给每一行补格，于是 4096 行重复空白各拿一份新数组）。
  for (const row of table.rows) {
    if (row.cells.length === 0) continue;
    while (row.cells.length < colCount) row.cells.push({ blocks: [] });
    if (row.cells.length > colCount) row.cells.length = colCount;
  }
  // 列宽：补齐到 colCount。ODF 可以只声明部分列（或声明数与实际列数不一致），
  // 缺的用已声明宽度的均值兜底 —— 早退成 undefined 会让渲染器走「均分」分支，
  // 于是 1in/1in/1in 这种整表等宽的表格看起来比例没错，但不等宽的表格就全乱了。
  if (widths.some((w) => w > 0)) {
    const known = widths.filter((w) => w > 0);
    const fill = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
    const outWidths: number[] = [];
    for (let i = 0; i < colCount; i++) outWidths.push(widths[i] > 0 ? widths[i] : fill);
    if (outWidths.every((w) => w > 0)) table.widths = outWidths;
  }
  if (budget.truncatedCols) {
    markTruncated(ctx, 'maxCols', `表格列数超过上限（声明 ${declaredCols} / 实际 ${maxSeenCols}），多余列已裁剪`);
  }
  if (budget.truncatedRows) {
    markTruncated(
      ctx,
      'number-rows-repeated',
      `table:number-rows-repeated 过大，已按物化行数上限 ${MAX_MATERIALIZED_ROWS} 裁剪（避免为纯空白行建出十万个行对象）`,
    );
  }
  if (budget.truncatedCells) {
    markTruncated(ctx, 'maxCells', '表格单元格数超过上限，多余单元格已裁剪');
  }
  out.blocks.push(table);
}
/**
 * 「空填充格」判定 —— 决定它能否整段跳过不建对象（内存有界的关键）。
 *
 * 判据是「没有任何有意义的子内容」：
 *   - blocks 为空（完全没有段落），或
 *   - 所有 block 都是**空段落**（`<text:p/>` 这类占位）
 * 一旦格子里有任何文字、图片或表格，就不是填充格。
 *
 * 注意不能简单用 `blocks.length === 0`：buildCell 对「有 office:value-type」
 * 的格子会补一个展示用段落，而不带 value-type 的 `<table:table-cell/>` 也会
 * 被补成空段落 —— 两者都不该被当成填充格之外的**内容**。
 */
function isEmptyCell(cell: TableCell): boolean {
  if (cell.colSpan !== undefined && cell.colSpan > 1) return false;
  if (cell.rowSpan !== undefined && cell.rowSpan > 1) return false;
  if (cell.merged) return false;
  if (cell.shading || cell.border) return false;
  if (cell.blocks.length === 0) return true;
  return cell.blocks.every((b) => b.kind === 'para' && b.runs.every((r) => !r.text && !r.image));
}

function cloneCell(c: TableCell): TableCell {
  return { ...c, blocks: [...c.blocks] };
}

/**
 * 解析一行的单元格。
 * @returns 本行的**列跨度**（包含「占列不建对象」的空白重复格），
 *          与 `cells.length` 不同 —— 后者只统计真正建了对象的格子。
 */
function parseRowCells(p: XmlPullParser, ctx: OdContext, cells: TableCell[], budget: TableBudget): number {
  /** 本行的列游标：**唯一权威**的列位置。不能用 cells.length，空白重复格不建对象 */
  let col = 0;
  while (true) {
    const e = p.next();
    if (e === null) break;
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local !== 'table-cell' && e.local !== 'covered-table-cell') {
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    const covered = e.local === 'covered-table-cell';
    const colSpan = covered ? 1 : Math.max(1, attrInt(e, 'number-columns-spanned', 1));
    const rowSpan = covered ? 1 : Math.max(1, attrInt(e, 'number-rows-spanned', 1));
    const rawRepeat = attrInt(e, 'number-columns-repeated', 1);

    // 每份重复占用 colSpan 列，因此剩余列数要按 span 折算成「还能放几份」。
    // allowance 由**本表声明的列数**（declaredLimit，不含余量）与剩余单元格
    // 预算共同决定，两者取小。这一步是防「16380 列空填充把内存吃光」的核心：
    // 用含余量的 colLimit 会把「只声明 4 列」的表裁到 12 列，每行仍然多出
    // 8 个空对象；必须用声明的列数本身作为重复段的上界。
    const colsLeft = Math.max(0, budget.declaredLimit - col);
    const byCols = Math.floor(colsLeft / colSpan);
    const byCells = Math.max(1, Math.floor(budget.cellsLeft));
    const allowance = Math.max(0, Math.min(byCols, byCells));
    const repeat = rawRepeat <= 1 ? 1 : clampRepeat(rawRepeat, allowance, () => {
      markTruncated(
        ctx,
        'number-columns-repeated',
        `table:number-columns-repeated=${rawRepeat} 过大，已裁剪到本表声明的列数 ${budget.declaredLimit}`,
      );
      budget.truncatedCols = true;
    });

    if (repeat <= 0) {
      // 该格已被裁剪掉：仍然必须消费掉子树，否则后续解析会错位
      col += colSpan;
      if (!e.selfClosing) p.skipElement();
      continue;
    }

    // 只解析一次子树：重复格直接复用同一个 TableCell 对象。
    const cell = buildCell(p, e, ctx, rowSpan, colSpan, covered);
    const blank = covered || isEmptyCell(cell);
    const want = Math.min(repeat, Math.max(0, Math.floor((budget.declaredLimit + COL_HEADROOM - col) / colSpan)));
    for (let i = 0; i < want; i++) {
      if (budget.cellsLeft <= 0) {
        budget.truncatedCells = true;
        break;
      }
      // **空白格不建对象**（无论第几份）。这是「16380 个空白重复格不会变成
      // 16380 个对象」的落点：ODF 用 number-columns-repeated 表达「后面还有 N 个
      // 空格子」，把它们物化成对象纯属浪费 —— 渲染器按列位置取值，缺格自然为空。
      // 列跨度由返回值如实上报，因此最终列数不会被裁错。
      //
      // 不建对象还带来一个必要性质：**没有内容也没有样式的行，cells 长度为 0**，
      // 于是上层能识别出「纯空白行」并让所有重复行共享同一份（空）cells 数组。
      if (!blank) {
        cells.push(i === 0 ? cell : cloneCell(cell));
        budget.cellsLeft--;
      }
      col += colSpan;
    }
  }
  return col;
}

function buildCell(
  p: XmlPullParser,
  e: XmlEvent,
  ctx: OdContext,
  rowSpan: number,
  colSpan: number,
  covered: boolean,
): TableCell {
  const cell: TableCell = { blocks: [] };
  if (colSpan > 1) cell.colSpan = colSpan;
  if (rowSpan > 1) cell.rowSpan = rowSpan;
  if (covered) cell.merged = true;

  const styleName = attr(e, 'style-name');
  if (styleName) applyCellStyleToCell(cell, resolveCell(ctx.styles, styleName));

  const target: TextParseTarget = { blocks: [] };
  if (!e.selfClosing) {
    let c: XmlEvent | null;
    while ((c = p.next()) !== null) {
      if (c.type === 'end') break;
      if (c.type !== 'start') continue;
      if (!parseTextChild(p, c, ctx, target, {}) && !c.selfClosing) p.skipElement();
    }
  }
  if (target.blocks.length === 0) {
    // 没有任何段落子元素：给一个只读展示段落，否则渲染器会以为这一格不存在。
    // 内容取自 office:value/string-value 之类的属性（有值时才有文字）。
    const text = cellValueText(e, ctx);
    target.blocks.push({ kind: 'para', runs: [{ text }] });
  }
  cell.blocks = target.blocks;
  return cell;
}

/** ODF 的单元格值可能有多种表达，取第一个可用的作为纯文本兜底。 */
function cellValueText(e: XmlEvent, ctx: OdContext): string {
  const vType = attr(e, 'value-type');
  if (!vType) return '';
  const direct =
    attr(e, 'string-value') ?? attr(e, 'value') ?? attr(e, 'boolean-value') ?? attr(e, 'date-value') ?? attr(e, 'time-value');
  if (direct === undefined) return '';
  if (vType === 'percentage' && direct !== '') {
    const n = Number.parseFloat(direct);
    if (Number.isFinite(n)) return `${(n * 100).toFixed(0)}%`;
  }
  void ctx;
  return direct;
}

function applyCellStyleToCell(cell: TableCell, resolved: OdCellProps): void {
  if (resolved.bg) cell.shading = resolved.bg;
  if (resolved.vAlign) cell.vAlign = resolved.vAlign;
  if (resolved.borderWidthPt && resolved.borderWidthPt > 0) {
    const line = { width: resolved.borderWidthPt, color: resolved.borderColor, style: resolved.borderStyle ?? 'solid' } as const;
    cell.border = { top: { ...line }, bottom: { ...line }, left: { ...line }, right: { ...line } };
  }
}

/**
 * 把「可能超大的重复次数」裁到剩余额度。
 *
 * 这是 ODF 读取器**最关键的一道防线**：实测 LibreOffice 导出的文件里
 * 空白填充的 number-columns-repeated 常年是 1024，而被删空的区域
 * 会写成更大的值。不裁剪的话，一个 20 KB 的表格能构造出上百万个对象。
 */
export function clampRepeat(raw: number, allowance: number, onClamp: () => void): number {
  const n = Number.isFinite(raw) ? Math.floor(raw) : 1;
  if (n <= 1) return 1;
  if (n > allowance) {
    onClamp();
    return Math.max(0, allowance);
  }
  return n;
}

/* ==================================================================== */
/* 图形（文字处理里的内嵌图片）                                           */
/* ==================================================================== */

/**
 * `draw:frame` -> 图片。
 *
 * 图片字节落在包内的独立条目（`Pictures/xxx.png`），content.xml 里只有路径引用。
 * 解析器必须按**相对 content.xml 的路径**归一化后再去容器取 ——
 * href 的常见写法有 `./Pictures/x.png`、`Pictures/x.png`、`../Pictures/x.png`。
 * 早期实现直接拿 href 原文去查条目，于是所有带 `./` 的图片都取不到。
 *
 * @returns 图片尺寸/路径信息（data 由包层按需填充）
 */
export function frameImage(p: XmlPullParser, frame: XmlEvent, ctx: OdContext): InlineImage | undefined {
  if (frame.selfClosing) return undefined;
  const w = cssLengthToPt(attr(frame, 'width') ?? '', NaN);
  const h = cssLengthToPt(attr(frame, 'height') ?? '', NaN);
  let out: InlineImage | undefined;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local === 'image') {
      const href = attr(e, 'href');
      if (href && !isExternalHref(href)) {
        const part = resolvePartPath(href);
        out = {
          mime: mimeFromPath(part),
          width: Number.isFinite(w) ? w : 0,
          height: Number.isFinite(h) ? h : 0,
          partPath: part,
        };
        // 两遍法：这里只登记路径，字节由 reader 统一按 limits 加载
        registerImage(ctx, out, part);
      } else if (href) {
        // 外部 URL：只保留提示，绝不联网加载（离线优先 + 不在解析期发起网络请求）
        out = { mime: 'image/*', width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0, alt: href };
        warn(ctx, `图片为外部链接（${href}），已跳过加载`);
      }
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    if (e.local === 'text-box') {
      // UDM 的 InlineImage 只能承载图片，draw:frame 里没有 blocks 字段，
      // 因此文本框文字无法无损落进模型 —— 降级并明确告知，而不是静默丢弃。
      warn(ctx, '文字处理文档中的 draw:text-box 文本未纳入模型（图片仍保留）');
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    if (!e.selfClosing) p.skipElement();
  }
  return out;
}

/** 颜色属性读取（draw:fill-color 等） */
export function frameFill(e: XmlEvent): string | undefined {
  return parseColor(attr(e, 'fill-color'));
}

export function frameStroke(e: XmlEvent): string | undefined {
  const stroke = attr(e, 'stroke');
  if (stroke === 'none') return 'none';
  return parseColor(attr(e, 'stroke-color'));
}
