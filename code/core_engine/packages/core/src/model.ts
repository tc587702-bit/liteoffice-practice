/**
 * UDM —— Unified Document Model，统一文档模型。
 *
 * 这是 LiteOffice 的中枢抽象：**所有格式先归一到这里，所有渲染器只读这里**。
 *
 * 为什么需要它（也是「支持多种格式」这个目标能成立的前提）：
 *   传统做法是「每种格式一个查看器」—— docx 一个组件、xlsx 一个、pdf 又一个，
 *   于是 M 种格式 × N 种视图 = M×N 份实现。
 *   UDM 把它压成 M + N：格式只需写「读成 UDM」，视图只需写「渲染 UDM」。
 *   新增一种格式（例如 .numbers）就自动获得全部视图能力。
 *
 * 单位约定：**模型内一切长度都是 pt**，px 只出现在 DOM 渲染的最后一步。
 * 详见 units.ts。
 *
 * 低内存约定：
 *   - 表格单元格共享样式表（Cell.s 是索引，不是对象引用），避免每格一个样式对象
 *   - 大表通过 Grid.readRows() 惰性取行窗口，不物化整表
 *   - 图片字节按需保留、可被 dispose() 释放
 */

/* ==================================================================== */
/* 文档类别与格式                                                        */
/* ==================================================================== */

export type DocKind = 'text' | 'sheet' | 'slides' | 'pdf' | 'raw';

export type FormatId =
  // OOXML（OOXML = Office Open XML，即 .docx 家族）
  | 'docx'
  | 'docm'
  | 'dotx'
  | 'xlsx'
  | 'xlsm'
  | 'xltx'
  | 'pptx'
  | 'pptm'
  | 'potx'
  // ODF（OpenDocument Format，即 .odt 家族）
  | 'odt'
  | 'ott'
  | 'ods'
  | 'ots'
  | 'odp'
  | 'otp'
  | 'odg'
  | 'fodt'
  | 'fods'
  | 'fodp'
  // 固定版式
  | 'pdf'
  // 纯文本家族
  | 'md'
  | 'txt'
  | 'csv'
  | 'tsv'
  | 'json'
  | 'html'
  | 'xml'
  | 'svg'
  | 'rtf'
  | 'log'
  // 结构化标记
  | 'epub'
  // 旧版二进制（明确不支持，但必须能被识别出来并给出人话提示）
  | 'ole2-doc'
  | 'ole2-xls'
  | 'ole2-ppt'
  | 'unknown';

/** 容器类型，决定用哪条读取路径 */
export type ContainerKind = 'zip' | 'pdf' | 'plain' | 'ole2' | 'epub';

export interface FormatSpec {
  id: FormatId;
  kind: DocKind;
  /** 面向用户的中文名 */
  label: string;
  /** 降级/分组用：决定由哪个读取器包处理 */
  family: 'ooxml' | 'odf' | 'pdf' | 'text' | 'markup' | 'legacy';
  container: ContainerKind;
  extensions: string[];
  mimes: string[];
  /**
   * zip 容器的特征部件路径。嗅探时命中即判定格式。
   * 顺序敏感：先匹配到的优先。
   */
  markers?: string[];
}

/* ==================================================================== */
/* 通用样式                                                              */
/* ==================================================================== */

export interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 前景色，CSS 颜色串（#rrggbb 或 rgb()） */
  color?: string;
  /** 高亮/底纹色 */
  highlight?: string;
  /** 字号，pt */
  size?: number;
  /** 字体名（首个可用字体） */
  font?: string;
  /** 东亚字体名（中文文档常见，与 font 分离） */
  fontEastAsia?: string;
  vertAlign?: 'baseline' | 'subscript' | 'superscript';
  /** 字间距，pt */
  letterSpacing?: number;
  caps?: 'none' | 'small' | 'all';
  /** 链接目标（渲染为可点击） */
  link?: string;
  /** 隐藏文本（不渲染，但保留在模型里） */
  hidden?: boolean;
}

export interface Run {
  text: string;
  style?: RunStyle;
  /** 该 run 之前强制换行 */
  breakBefore?: boolean;
  /** 该 run 是图片（此时 text 为空，image 有值） */
  image?: InlineImage;
  /** 该 run 是脚注/尾注引用 */
  noteRef?: { kind: 'footnote' | 'endnote'; id: string };
  /** 域代码结果（如页码），渲染时按原文显示 */
  field?: boolean;
}

export interface InlineImage {
  /** 图片字节。可能为 undefined —— 表示「已知有图但按上限未加载」 */
  data?: Uint8Array;
  mime: string;
  /** 显示尺寸，pt */
  width: number;
  height: number;
  alt?: string;
  /** zip 内的部件路径，用于按需再取 */
  partPath?: string;
}

export interface ParaStyle {
  align?: 'left' | 'center' | 'right' | 'justify' | 'start' | 'end';
  /** 段前/段后间距，pt */
  spaceBefore?: number;
  spaceAfter?: number;
  /** 行距倍率（1.0 = 单倍） */
  lineHeight?: number;
  /** 行距精确值，pt（优先于 lineHeight） */
  lineHeightExact?: number;
  /** 左缩进/右缩进，pt */
  indentStart?: number;
  indentEnd?: number;
  /** 首行缩进，pt（负数表示悬挂缩进） */
  indentFirst?: number;
  /** 项目符号/编号层级，0 起 */
  listLevel?: number;
  /** 项目符号字符或编号文本，如 "•"、"1." */
  listMarker?: string;
  /** 是否有序列表 */
  listOrdered?: boolean;
  /** 样式名，如 "Heading 1" —— 也用于大纲提取 */
  styleName?: string;
  /** 大纲级别：0 起，越小越靠前。仅标题有值 */
  outlineLevel?: number;
  /** 段落前分页 */
  pageBreakBefore?: boolean;
  /** 段落底纹色 */
  shading?: string;
  /** 段落边框（简化描述） */
  border?: BorderStyle;
  /** 制表位位置，pt */
  tabs?: number[];
  /** 段落语言，用于断行 */
  language?: string;
}

export interface BorderStyle {
  top?: BorderLine;
  bottom?: BorderLine;
  left?: BorderLine;
  right?: BorderLine;
  insideH?: BorderLine;
  insideV?: BorderLine;
}

export interface BorderLine {
  /** 线宽，pt */
  width: number;
  color?: string;
  /** 简化线型：solid / dashed / dotted / double / none */
  style?: 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
}

/* ==================================================================== */
/* 文本类文档的块模型                                                     */
/* ==================================================================== */

export interface Paragraph {
  kind: 'para';
  runs: Run[];
  style?: ParaStyle;
  /** 稳定标识，供大纲跳转与搜索定位 */
  id?: string;
}

export interface TableCell {
  blocks: Block[];
  /** 跨列数，默认 1 */
  colSpan?: number;
  /** 跨行数，默认 1 */
  rowSpan?: number;
  vAlign?: 'top' | 'middle' | 'bottom';
  shading?: string;
  /** 单元格内边距，pt */
  padding?: number;
  border?: BorderStyle;
  /** 该格是被纵向合并吃掉的延续格（渲染时跳过） */
  merged?: boolean;
}

export interface TableRow {
  cells: TableCell[];
  /** 表头行 —— 渲染时冻结/加粗 */
  header?: boolean;
  /** 行高，pt */
  height?: number;
}

export interface Table {
  kind: 'table';
  rows: TableRow[];
  /** 各列宽度，pt。长度可能小于实际列数，缺省用均分 */
  widths?: number[];
  border?: BorderStyle;
  /** 表格整体宽度，pt */
  width?: number;
  id?: string;
}

export interface ImageBlock {
  kind: 'image';
  image: InlineImage;
  /** 水平对齐 */
  align?: 'left' | 'center' | 'right';
  id?: string;
}

export interface PageBreakBlock {
  kind: 'pagebreak';
}

export interface RuleBlock {
  kind: 'rule';
  color?: string;
  thickness?: number;
}

export interface RawBlock {
  kind: 'raw';
  /** 无法结构化时的原文（例如未知元素），保留以便复制 */
  text: string;
  /** 原始标记名，便于诊断 */
  tag?: string;
}

export type Block = Paragraph | Table | ImageBlock | PageBreakBlock | RuleBlock | RawBlock;

/* ==================================================================== */
/* 表格类文档（工作表）                                                   */
/* ==================================================================== */

export type CellType = 'n' | 's' | 'b' | 'e' | 'd' | 'str';

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  color?: string;
  bg?: string;
  size?: number;
  font?: string;
  /** 数字格式串（已尽量转成可读形式，如 "0.00%"） */
  numFmt?: string;
  border?: BorderStyle;
}

export interface Cell {
  /** 行号，0 起 */
  r: number;
  /** 列号，0 起 */
  c: number;
  /** 显示值（已按 numFmt 之外的原样保存；数字也存字符串以省内存并保精度） */
  v: string;
  /** 单元格类型 */
  t?: CellType;
  /** 公式（不含前导 '='） */
  f?: string;
  /** 指向 Sheet.styles 的索引 —— 用索引而非对象引用，避免每格一个对象 */
  s?: number;
  /** 内含富文本（此时 v 为纯文本拼接结果） */
  rich?: Run[];
}

export interface CellRow {
  r: number;
  /** 稀疏存储：只放非空格 */
  cells: Cell[];
}

export interface MergeRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/**
 * Grid —— 惰性行访问接口。
 *
 * 这是低内存浏览大表的关键：视图只需要可视窗口内的行，
 * 实现可以在每次 readRows() 时重新流式解析源 XML，从而**从不物化整表**。
 * 小表则由 MaterializedGrid 直接返回内存数组。
 */
export interface Grid {
  readonly rowCount: number;
  readonly colCount: number;
  /** 读取 [start, end) 行。end 会被 clamp 到 rowCount。 */
  readRows(start: number, end: number): Promise<CellRow[]>;
  /**
   * **当前实际驻留在内存中**的表格数据估算字节数，供内存记账使用。
   *
   * 为什么必须由 Grid 自己报告：表格数据不在 `Sheet` 对象上，而在 Grid 实现内部
   * （物化实现把行放在私有数组里）。任何从外部 deep-walk 文档对象的估算都会
   * **完全看不到表格数据**，把模型体积报成接近 0 —— 实测一个 2 万行 × 8 列的 CSV
   * 被报成 278 字节，而真实堆增量是 60 MiB。这会让「模型/源文件」这个核心指标失去意义。
   *
   * 语义是「驻留量」而不是「逻辑表大小」：惰性实现只需报告其缓存占用的字节，
   * 这正是我们要展示的性质（大表不物化）。
   */
  estimateBytes?(): number;
}

export interface Sheet extends Grid {
  name: string;
  hidden?: boolean;
  /** 共享样式表；Cell.s 是索引 */
  styles: CellStyle[];
  /** 列宽，pt。0 或缺省表示默认宽度 */
  colWidths?: number[];
  /** 行高，pt。稀疏（用 Map）以避免百万行时的大数组 */
  rowHeights?: Map<number, number>;
  defaultColWidth: number;
  defaultRowHeight: number;
  merges?: MergeRange[];
  /** 冻结窗格 */
  freeze?: { rows: number; cols: number };
  /** 自动筛选范围 */
  autoFilter?: MergeRange;
  /** 该表是否因为超限被截断 */
  truncated?: boolean;
}

/* ==================================================================== */
/* 演示类文档（幻灯片）                                                   */
/* ==================================================================== */

export type ShapeKind = 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'group' | 'path' | 'placeholder';

export interface Shape {
  id?: string;
  kind: ShapeKind;
  /** 位置与尺寸，pt。原点在幻灯片左上角 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 旋转角，度 */
  rot?: number;
  /** 翻转 */
  flipH?: boolean;
  flipV?: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** 文本内容（text / placeholder 形状） */
  blocks?: Block[];
  anchor?: 'top' | 'middle' | 'bottom';
  /** 图片（image 形状） */
  image?: InlineImage;
  /** 组合形状的子形状 */
  shapes?: Shape[];
  /** 形状名（来自 pptx 的 name 属性） */
  name?: string;
  /** 形状轮廓样式，简化圆角半径（pt） */
  radius?: number;
  /** 透明度 0..1 */
  opacity?: number;
  /** 是否作为占位符且未填充内容 */
  empty?: boolean;
}

export interface Slide {
  index: number;
  /** 幻灯片尺寸，pt */
  width: number;
  height: number;
  shapes: Shape[];
  /** 背景色 */
  background?: string;
  /** 备注页文本 */
  notes?: string;
  /** 版式名 */
  layout?: string;
}

/* ==================================================================== */
/* PDF                                                                  */
/* ==================================================================== */

export interface PdfTextItem {
  kind: 'text';
  /** 基线左端 x，pt（原点左下，PDF 惯例） */
  x: number;
  y: number;
  size: number;
  font: string;
  text: string;
  color?: string;
  /** 估算宽度，pt */
  width?: number;
  /** 字间距 */
  charSpacing?: number;
}

export interface PdfRectItem {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  lw?: number;
}

export interface PdfLineItem {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke?: string;
  lw?: number;
}

export interface PdfImageItem {
  kind: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  data?: Uint8Array;
  mime?: string;
}

export type PdfItem = PdfTextItem | PdfRectItem | PdfLineItem | PdfImageItem;

export interface PdfPage {
  index: number;
  /** 原始 MediaBox 尺寸，pt */
  width: number;
  height: number;
  /** 旋转角 0/90/180/270 */
  rotate?: number;
  items: PdfItem[];
}

/* ==================================================================== */
/* 元数据、大纲、统计                                                     */
/* ==================================================================== */

export interface DocMeta {
  title?: string;
  subject?: string;
  author?: string;
  lastModifiedBy?: string;
  company?: string;
  manager?: string;
  /** ISO 8601 字符串 */
  created?: string;
  modified?: string;
  application?: string;
  appVersion?: string;
  keywords?: string;
  description?: string;
  category?: string;
  language?: string;
  pageCount?: number;
  wordCount?: number;
  charCount?: number;
  paragraphCount?: number;
  slideCount?: number;
  sheetCount?: number;
  /** 页面/幻灯片/画布尺寸，pt */
  pageWidth?: number;
  pageHeight?: number;
  /** 页面边距，pt */
  margin?: { top: number; right: number; bottom: number; left: number };
  /** 其他未归类的属性 */
  custom?: Record<string, string>;
}

export interface OutlineTarget {
  kind: 'block' | 'page' | 'slide' | 'sheet' | 'cell';
  index: number;
  row?: number;
  col?: number;
}

export interface OutlineItem {
  /** 标题级别，1 起 */
  level: number;
  text: string;
  target?: OutlineTarget;
  children?: OutlineItem[];
}

export interface DocStats {
  /** 解析总耗时，ms */
  parseMs: number;
  /**
   * 文档模型**当前驻留**字节数的估算。
   *
   * 契约（由 `engine` 统一计算并写入，读取器不应自行决定）：
   *   - **包含**表格数据（通过 `Grid.estimateBytes()` 获取）
   *   - **不包含**图片/嵌入对象的原始字节 —— 那些只记在 `imageBytes`，避免重复计入
   *
   * 为什么要统一计算而不是让读取器各报各的：实测两个读取器朝相反方向错
   * （CSV 少报 2000 倍、PDF 把图片字节算进去多报），同一指标在不同格式间不可比。
   */
  modelBytes: number;
  /** 源文件字节数 */
  sourceBytes: number;
  /** 压缩率 = sourceBytes / modelBytes，用于展示「我们比原文件还小」 */
  blockCount: number;
  cellCount: number;
  shapeCount: number;
  imageCount: number;
  /**
   * 图片字节数。
   *
   * ⚠ **语义尚未统一，读这个字段前请先确认来源读取器的约定**：
   *   - docx 读取器报的是「**已加载进内存**的图片字节」
   *   - pptx 读取器报的是「文档中图片的**总大小**」（字节可能按需再取，并未驻留）
   * 实测证据：一个 11.3 MiB 的 pptx 报 `imageBytes` 11.5 MiB，而解析的堆增量只有 3.1 MiB。
   * 两者都不能算错，但外部无法从数值区分，UI 也不能据此说「已占用 X 内存」。
   *
   * 待统一为「已驻留字节」，并在需要时另加一个「文档中图片总大小」字段。见 docs/MEASUREMENTS.md 的已知问题清单。
   */
  imageBytes: number;
  /** 降级处理与跳过的功能。绝不因单个特性失败而整篇打不开 */
  warnings: string[];
  /** 被上限截断的资源类别 */
  truncated: string[];
  /** 解析阶段耗时明细 */
  phases?: Record<string, number>;
}

/* ==================================================================== */
/* 文档对象                                                              */
/* ==================================================================== */

export interface LiteDocument {
  readonly kind: DocKind;
  readonly format: FormatId;
  /** 面向用户的格式名 */
  readonly formatLabel: string;
  readonly name: string;
  readonly meta: DocMeta;
  readonly outline: OutlineItem[];
  readonly stats: DocStats;

  /** 文本类文档的块序列 */
  readonly blocks?: Block[];
  /** 表格类文档的工作表 */
  readonly sheets?: Sheet[];
  /** 演示类文档的幻灯片 */
  readonly slides?: Slide[];
  /** PDF 页面 */
  readonly pages?: PdfPage[];
  /** 无结构化模型时的纯文本兜底 */
  readonly text?: string;

  /** 释放可回收的大块内存（图片字节等）。调用后文档对象不应再被使用。 */
  dispose(): void;
  /** 该文档是否发生了内容截断 */
  readonly truncated: boolean;
}

/* ==================================================================== */
/* 构造辅助                                                              */
/* ==================================================================== */

export interface CreateDocInput {
  kind: DocKind;
  format: FormatId;
  formatLabel: string;
  name: string;
  meta?: DocMeta;
  outline?: OutlineItem[];
  stats?: Partial<DocStats>;
  blocks?: Block[];
  sheets?: Sheet[];
  slides?: Slide[];
  pages?: PdfPage[];
  text?: string;
}

export function createDocument(input: CreateDocInput): LiteDocument {
  let disposed = false;
  const doc: LiteDocument = {
    kind: input.kind,
    format: input.format,
    formatLabel: input.formatLabel,
    name: input.name,
    meta: input.meta ?? {},
    outline: input.outline ?? [],
    stats: {
      parseMs: 0,
      modelBytes: 0,
      sourceBytes: 0,
      blockCount: 0,
      cellCount: 0,
      shapeCount: 0,
      imageCount: 0,
      imageBytes: 0,
      warnings: [],
      truncated: [],
      ...input.stats,
    },
    blocks: input.blocks,
    sheets: input.sheets,
    slides: input.slides,
    pages: input.pages,
    text: input.text,
    get truncated() {
      return doc.stats.truncated.length > 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeBlocks(doc.blocks);
      if (doc.sheets) for (const s of doc.sheets) s.merges = undefined;
      if (doc.slides) {
        for (const sl of doc.slides) for (const sh of sl.shapes) disposeShape(sh);
      }
      if (doc.pages) {
        for (const pg of doc.pages) {
          for (const it of pg.items) if (it.kind === 'image') it.data = undefined;
        }
      }
      if (doc.blocks) doc.blocks.length = 0;
    },
  };
  if (doc.stats.blockCount === 0 && input.blocks) doc.stats.blockCount = input.blocks.length;
  return doc;
}

function disposeShape(sh: Shape): void {
  if (sh.image) sh.image.data = undefined;
  disposeBlocks(sh.blocks);
  if (sh.shapes) for (const c of sh.shapes) disposeShape(c);
}

export function disposeBlocks(blocks: Block[] | undefined): void {
  if (!blocks) return;
  for (const b of blocks) {
    if (b.kind === 'image') b.image.data = undefined;
    else if (b.kind === 'table') {
      for (const row of b.rows) for (const cell of row.cells) disposeBlocks(cell.blocks);
    } else if (b.kind === 'para') {
      for (const r of b.runs) if (r.image) r.image.data = undefined;
    }
  }
}

/* ==================================================================== */
/* 便利读取器                                                            */
/* ==================================================================== */

/** 行内 run 拼接为纯文本 */
export function runsToText(runs: readonly Run[]): string {
  let out = '';
  for (const r of runs) out += r.image ? (r.image.alt ? `[${r.image.alt}]` : '[图片]') : r.text;
  return out;
}

/** 段落纯文本 */
export function paraText(p: Paragraph): string {
  return runsToText(p.runs);
}

/** 递归取出块序列的全部纯文本 */
export function blocksToText(blocks: readonly Block[], sep = '\n'): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'para') parts.push(paraText(b));
    else if (b.kind === 'table') {
      for (const row of b.rows) {
        parts.push(row.cells.map((c) => blocksToText(c.blocks, ' ')).join('\t'));
      }
    } else if (b.kind === 'image') parts.push(b.image.alt ? `[${b.image.alt}]` : '[图片]');
    else if (b.kind === 'raw') parts.push(b.text);
  }
  return parts.join(sep);
}

/** 统计块序列里的字数（按 CJK 逐字 + 西文按词，与 Office 口径近似） */
export function countWords(blocks: readonly Block[]): { words: number; chars: number } {
  let words = 0;
  let chars = 0;
  const walk = (bs: readonly Block[]): void => {
    for (const b of bs) {
      if (b.kind === 'para') {
        const t = paraText(b);
        chars += t.length;
        words += countTextWords(t);
      } else if (b.kind === 'table') {
        for (const row of b.rows) for (const c of row.cells) walk(c.blocks);
      } else if (b.kind === 'raw') {
        chars += b.text.length;
        words += countTextWords(b.text);
      }
    }
  };
  walk(blocks);
  return { words, chars };
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

function countTextWords(t: string): number {
  const cjk = t.match(CJK_RE)?.length ?? 0;
  const latin = t.replace(CJK_RE, ' ').trim();
  const latinWords = latin ? latin.split(/\s+/).length : 0;
  return cjk + latinWords;
}

/** 从块序列提取大纲（按 outlineLevel / 标题样式名） */
export function outlineFromBlocks(blocks: readonly Block[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== 'para') continue;
    const lvl = b.style?.outlineLevel ?? outlineLevelFromStyleName(b.style?.styleName);
    if (lvl === undefined) continue;
    const text = paraText(b).trim();
    if (!text) continue;
    items.push({ level: lvl + 1, text: text.slice(0, 200), target: { kind: 'block', index: i } });
  }
  return items;
}

/** Word 的标题样式名。注意真实文件里最常见的形式是带空格的 "Heading 1"，
 *  而 styleId 形式是 "Heading1"。两种都必须匹配，否则所有 Word 标题都进不了大纲。
 *  中文 Word 会本地化成 "标题 1"，同理需要容忍空格。 */
const HEADING_RE = /^(?:heading|标题|h)\s*(\d)$/i;

export function outlineLevelFromStyleName(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const m = HEADING_RE.exec(name.trim());
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 && n <= 9 ? n - 1 : undefined;
}

/** 把扁平的大纲项按 level 组织成树。 */
export function nestOutline(items: readonly OutlineItem[]): OutlineItem[] {
  const root: OutlineItem[] = [];
  const stack: OutlineItem[] = [];
  for (const raw of items) {
    const it: OutlineItem = { ...raw, children: [] };
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
    if (stack.length === 0) root.push(it);
    else (stack[stack.length - 1].children ??= []).push(it);
    stack.push(it);
  }
  return root;
}
