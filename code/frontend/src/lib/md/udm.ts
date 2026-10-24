/**
 * md 渲染所需的最小 UDM 类型子集。
 *
 * 为什么单独抄一份而不是直接引用内核的 model.ts：
 *   liteoffice-vue 是独立仓库/SFC 工程，不能跨仓库 import 带 .ts 后缀的相对路径；
 *   而 model.ts 有 796 行，其中工作表、幻灯片、PDF、统计等类型与 md 无关。
 *   这里只保留 Markdown 解析器真正会产出/消费的 6 类块与行内类型。
 *
 * 字段定义**逐字抄自** liteoffice/packages/core/src/model.ts（2026-10-17 版本）。
 * 改动时请对照上游，否则渲染器会与解析器对不上。
 */

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

export interface BorderLine {
  /** 线宽，pt */
  width: number;
  color?: string;
  /** 简化线型：solid / dashed / dotted / double / none */
  style?: 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
}

export interface BorderStyle {
  top?: BorderLine;
  bottom?: BorderLine;
  left?: BorderLine;
  right?: BorderLine;
  insideH?: BorderLine;
  insideV?: BorderLine;
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
