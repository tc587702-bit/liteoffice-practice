/**
 * ODF 读取器的内部类型。
 *
 * 单独成文件的理由：样式、正文、表格、演示四条解析路径都要引用这些形状，
 * 写在一个大文件里会因为循环 import 变得难以维护。
 */
import type { InlineImage, Limits } from '../../core/src/index.ts';
import type { LimitGuard } from '../../core/src/limits.ts';

/* ==================================================================== */
/* 样式属性                                                              */
/* ==================================================================== */

export interface OdRunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 前景色，#rrggbb */
  color?: string;
  /** 背景/底纹色（style:text-properties 的 fo:background-color） */
  highlight?: string;
  /** 字号，pt */
  sizePt?: number;
  font?: string;
  /** 东亚字体（style:font-name-asian，中文文档的正文常常只写这个） */
  fontAsian?: string;
  vertAlign?: 'baseline' | 'subscript' | 'superscript';
  /** 字间距，pt */
  letterSpacingPt?: number;
  caps?: 'none' | 'small' | 'all';
  hidden?: boolean;
}

export interface OdParaProps {
  align?: 'left' | 'center' | 'right' | 'justify' | 'start' | 'end';
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  /** 行距倍率（1.0 = 单倍） */
  lineHeight?: number;
  /** 行距精确值，pt */
  lineHeightExactPt?: number;
  indentStartPt?: number;
  indentEndPt?: number;
  indentFirstPt?: number;
  pageBreakBefore?: boolean;
  /** 段落底纹色 */
  shading?: string;
  outlineLevel?: number;
  /** 段落自带的默认字符格式（style:style family="paragraph" 里的 text-properties） */
  run?: OdRunProps;
}

/* ==================================================================== */
/* 列表                                                                  */
/* ==================================================================== */

export interface OdListLevel {
  /** 1 起 */
  level: number;
  kind: 'bullet' | 'number' | 'none';
  /** 项目符号字符（bullet） */
  bulletChar?: string;
  /** ODF 的 style:num-format，如 "1"、"a"、"I"、"一" */
  numFormat?: string;
  prefix?: string;
  suffix?: string;
  /** text:start-value */
  startValue?: number;
  /** 该级的段前间距与缩进（pt），来自 style:list-level-properties */
  spaceBeforePt?: number;
  indentPt?: number;
}

export interface OdListStyle {
  name: string;
  levels: Map<number, OdListLevel>;
}

/* ==================================================================== */
/* 单元格 / 页面 / 版式样式                                               */
/* ==================================================================== */

export interface OdCellProps {
  bg?: string;
  vAlign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  /** 字号，pt */
  sizePt?: number;
  font?: string;
  /** style:data-style-name 指向的数字格式名 */
  dataStyle?: string;
  /** 由 number:*-style 解析出的可读数字格式串 */
  numFmt?: string;
  /** 边框线宽，pt（ODF 的边框按边分别定义，模型里简化为统一边框） */
  borderWidthPt?: number;
  borderColor?: string;
  borderStyle?: 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
}

export interface OdPageLayout {
  widthPt?: number;
  heightPt?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  /** style:writing-mode: lr-tb / tb-rl … */
  writingMode?: string;
}

/* ==================================================================== */
/* 样式总表                                                              */
/* ==================================================================== */

export interface OdStyleDef {
  name: string;
  family: string;
  /** style:parent-style-name，ODF 的继承是单亲链 */
  parent?: string;
  /** style:default-style 的 style:family */
  isDefault?: boolean;
  displayName?: string;
  run?: OdRunProps;
  para?: OdParaProps;
  cell?: OdCellProps;
  /** style:family="table-column" 的列宽，pt */
  columnWidthPt?: number;
  /** style:family="table-row" 的行高，pt */
  rowHeightPt?: number;
  /** style:family="page-layout" */
  page?: OdPageLayout;
  /** style:family="graphic" 的填充/描边（draw:fill-color 等） */
  fill?: string;
  stroke?: string;
  strokeWidthPt?: number;
  opacity?: number;
}

export interface OdStyles {
  defs: Map<string, OdStyleDef>;
  /** style:default-style：family -> 默认属性 */
  defaults: Map<string, OdStyleDef>;
  /** text:list-style，name -> 定义 */
  lists: Map<string, OdListStyle>;
  /** number:*-style，name -> 可读数字格式串 */
  dataStyles: Map<string, string>;
  /**
   * style:master-page，name -> 关联的 page-layout 名与显示名。
   * draw:page 通过 draw:master-page-name 引用它，幻灯片尺寸最终来自这里。
   */
  masterPages: Map<string, { pageLayoutName?: string; displayName?: string }>;
}

export function emptyStyles(): OdStyles {
  return { defs: new Map(), defaults: new Map(), lists: new Map(), dataStyles: new Map(), masterPages: new Map() };
}

/* ==================================================================== */
/* 包与解析上下文                                                        */
/* ==================================================================== */

export interface OdManifest {
  entries: Map<string, string>;
  encrypted: boolean;
  /** 加密条目的路径，用于给出人话错误 */
  encryptedEntries: string[];
}

/** 解析正文时共享的状态。三个类别（text/sheet/slides）共用同一份。 */
export interface OdContext {
  limits: Limits;
  guard: LimitGuard;
  styles: OdStyles;
  /** 包内图片：绝对条目路径 -> InlineImage（字节由包层统一填充） */
  images: Map<string, InlineImage>;
  /** 正文里引用到的图片路径。两遍法：先收集路径，再统一按 limits 取字节。 */
  pendingImages: Set<string>;
  warnings: string[];
  truncated: string[];
  /** 已加载的图片数与字节数 */
  imageCount: number;
  imageBytes: number;
}

export function newContext(limits: Limits, guard: LimitGuard, styles: OdStyles): OdContext {
  return {
    limits,
    guard,
    styles,
    images: new Map(),
    pendingImages: new Set(),
    warnings: [],
    truncated: [],
    imageCount: 0,
    imageBytes: 0,
  };
}

/**
 * 登记一张引用了包内条目的图片。
 *
 * 为什么不在这里直接读字节：
 *   正文解析是**同步**的（拉取解析器的事件流），而取字节是异步的。
 *   混在一起要么把解析器改成 async 生成器（改动面大），要么在这里立即 await
 *   （做不到）。两遍法（先收集路径、后统一加载）既保持同步解析，
 *   又能在加载前统一做 limits 判定。
 */
export function registerImage(ctx: OdContext, image: InlineImage, path: string): void {
  ctx.pendingImages.add(path);
  ctx.images.set(path, image);
}

/** 只在需要时把警告同时写进 guard，保证 engine 收尾时也能看到。 */
export function warn(ctx: OdContext, message: string): void {
  if (ctx.warnings.length < 200) ctx.warnings.push(message);
  ctx.guard.warn(message);
}

export function markTruncated(ctx: OdContext, what: string, message: string): void {
  if (!ctx.truncated.includes(what)) ctx.truncated.push(what);
  if (!ctx.guard.truncated.includes(what)) ctx.guard.truncated.push(what);
  warn(ctx, message);
}
