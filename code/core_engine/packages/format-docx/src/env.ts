/**
 * docx 读取器的共享环境与低层工具。
 *
 * 为什么要有这个「环境对象」而不是模块级变量：
 *   读取器可能被并发调用（同一进程里同时打开两份文档），模块级可变状态会互相污染。
 *   所有跨函数共享的东西都挂在 DocxEnv 上，由 reader.ts 每次读取时新建。
 *
 * 本文件只依赖 core / ooxml / xml，不依赖 body.ts / inline.ts，
 * 因此 `parseAlternateContent` 这类「需要回调」的通用逻辑可以放在这里被两边复用。
 */
import type { ContainerAccess } from '../../core/src/registry.ts';
import type { LimitGuard, Limits } from '../../core/src/limits.ts';
import type { Block, BorderLine, BorderStyle, DocMeta, ParaStyle, Run, RunStyle } from '../../core/src/model.ts';
import type { ContentTypes, Relationship } from '../../ooxml/src/package.ts';
import type { Numbering, ParaProps, RunProps, WordStyles } from '../../ooxml/src/styles.ts';
import type { Theme } from '../../ooxml/src/theme.ts';
import { eighthPtToPt, twipToPt } from '../../core/src/units.ts';
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import {
  applyParaProp,
  applyRunProp,
  attr,
  attrInt,
  attrNum,
  levelOf,
  mergeDefined,
  parseColor,
  parseRels,
  readPropChildren,
  renderListMarker,
  resolveParaProps,
  resolveRunProps,
} from '../../ooxml/src/index.ts';

/* ==================================================================== */
/* 环境                                                                  */
/* ==================================================================== */

export interface HeaderFooterRef {
  kind: 'header' | 'footer';
  /** default / first / even */
  type: string;
  /** 关系 id */
  id: string;
}

export interface PageSetup {
  widthPt?: number;
  heightPt?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
}

export interface DocxEnv {
  container: ContainerAccess;
  types: ContentTypes | undefined;
  /** 当前正在解析的部件的 rels（正文 / 页眉 / 页脚各有一份，解析时临时切换） */
  rels: Map<string, Relationship>;
  styles: WordStyles;
  numbering: Numbering;
  theme: Theme;
  limits: Limits;
  guard: LimitGuard;
  warnings: string[];
  /** 已经报过的警告键：同一条信息只报一次，避免 500 张图刷出 500 条警告 */
  warned: Set<string>;
  /** 不认识的元素名（只统计便于诊断，不进 warnings 以免淹没关键信息） */
  unknown: Set<string>;
  /** 编号计数器：numId -> 各层级当前计数值（undefined 表示该层还没出现过） */
  counters: Map<string, Array<number | undefined>>;
  /** 共享 RunStyle 实例缓存：真实文档里几万个 run 的样式其实只有几十种 */
  styleCache: Map<string, RunStyle>;
  /**
   * 已加载的图片部件：partPath -> 字节（null 表示试过但没加载成功）。
   * 同一张图被多个 run 引用时只解压一份，避免整份复制。
   */
  imageParts: Map<string, Uint8Array | null>;
  /**
   * 外部关系（TargetMode="External"）的**原始 Target**。
   *
   * 为什么需要：共用层的 parseRels 一律按「包内相对路径」解析 Target，
   * 于是 `Target="https://example.com"` 会被解析成 `word/https:/example.com`
   * （normalizePart 把 `//` 合并成了 `/`）—— 超链接就全废了。
   * 共享层是既定契约不能改，因此这里额外记一份原始值，按关系对象做键。
   */
  externalTargets: Map<Relationship, string>;
  imageCount: number;
  imageBytes: number;
  cellCount: number;
  tableCount: number;
  /**
   * 只取文本、不加载图片字节。
   * 用于页眉/页脚/脚注：这些部件解析完只保留文字，若顺手把图片字节也读进来
   * 就等于「读了一堆马上就要扔掉的内存」。
   */
  textOnly: boolean;
  /** 达到 maxBlocks 后置位，让所有解析循环尽快退出（而不是继续白跑） */
  stopped: boolean;
  page: PageSetup;
  /** 文档里出现的 w:sectPr 数量（>1 说明是多节文档，页面设置只能取最后一份） */
  sectionCount: number;
  /**
   * 用百分比声明宽度的表格（w:tblW type="pct"）。
   *
   * 为什么要延后：百分比宽度要乘以「页面内容宽度」，而 sectPr 在正文**末尾**，
   * 解析到表格时页面尺寸还不知道。与其为了这个再扫一遍 document.xml，
   * 不如先把引用记下来，等正文解析完（页面尺寸已知）再统一回填。
   */
  pctWidthTables: Array<{ table: { width?: number }; pct: number }>;
  meta: DocMeta;
}

export function createEnv(input: {
  container: ContainerAccess;
  types: ContentTypes | undefined;
  styles: WordStyles;
  numbering: Numbering;
  theme: Theme;
  limits: Limits;
  guard: LimitGuard;
}): DocxEnv {
  return {
    container: input.container,
    types: input.types,
    rels: new Map(),
    styles: input.styles,
    numbering: input.numbering,
    theme: input.theme,
    limits: input.limits,
    guard: input.guard,
    warnings: [],
    warned: new Set(),
    unknown: new Set(),
    counters: new Map(),
    styleCache: new Map(),
    imageParts: new Map(),
    externalTargets: new Map(),
    imageCount: 0,
    imageBytes: 0,
    cellCount: 0,
    tableCount: 0,
    textOnly: false,
    stopped: false,
    page: {},
    sectionCount: 0,
    pctWidthTables: [],
    headerFooterRefs: [],
    meta: {},
  };
}

/** 记录一条降级/跳过说明。绝不因为某个子特性不支持而抛错。 */
export function warn(env: DocxEnv, msg: string): void {
  if (env.warnings.length < 200 && !env.warnings.includes(msg)) env.warnings.push(msg);
}

/** 同一键只报一次。 */
export function warnOnce(env: DocxEnv, key: string, msg: string): void {
  if (env.warned.has(key)) return;
  env.warned.add(key);
  if (msg) warn(env, msg);
}

export function noteUnknown(env: DocxEnv, tag: string): void {
  if (env.unknown.size < 200) env.unknown.add(tag);
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ==================================================================== */
/* 部件读取                                                              */
/* ==================================================================== */

/**
 * 读一个部件为字符串。
 *
 * 关键分支：解压后大小超过 limits.maxPartBytes 时走 streamText()。
 * 为什么：`read()` 会先把整个部件解压成 Uint8Array，再交给 TextDecoder 变成
 * string —— 瞬时同时存在「字节 + 字符串」两份。streamText() 边解压边解码，
 * 峰值只需一份字符串。
 *
 * 诚实的降级说明：XmlPullParser 目前只接受「整串」或「整块字节」，没有
 * 增量喂料接口，所以这里最终仍会把字符串拼起来；但相比 read() 少了一份字节副本。
 */
export async function partText(env: DocxEnv, part: string): Promise<string | null> {
  if (!part || !env.container.has(part)) return null;
  const size = env.container.entrySize(part);
  if (size > env.limits.maxPartBytes) {
    warn(
      env,
      `部件 ${part} 解压后 ${size} 字节超过 maxPartBytes=${env.limits.maxPartBytes}，改用 streamText() 流式扫描（不再整体 read()）`,
    );
    return await streamPartText(env, part);
  }
  try {
    return await env.container.text(part);
  } catch (err) {
    // 声明的大小与实际不符等异常：退到流式路径再试一次，能读多少读多少
    warn(env, `部件 ${part} 读取失败（${errText(err)}），改用 streamText() 流式读取`);
    return await streamPartText(env, part);
  }
}

async function streamPartText(env: DocxEnv, part: string): Promise<string | null> {
  const chunks: string[] = [];
  try {
    for await (const chunk of env.container.streamText(part)) chunks.push(chunk);
  } catch (err) {
    warn(env, `部件 ${part} 流式读取失败：${errText(err)}`);
    return null;
  }
  if (!chunks.length) return '';
  return chunks.length === 1 ? chunks[0] : chunks.join('');
}

/** 解析某个部件的 .rels；不存在时返回空表（缺关系不是错误，是常见现实）。 */
export async function relsOf(env: DocxEnv, part: string, relsPath: string): Promise<Map<string, Relationship>> {
  const xml = await partText(env, relsPath);
  if (!xml) return new Map();
  try {
    const rels = parseRels(xml, part);
    // 补记外部关系的原始 Target（见 DocxEnv.externalTargets 的说明）
    for (const [id, raw] of readExternalTargets(xml)) {
      const rel = rels.get(id);
      if (rel) env.externalTargets.set(rel, raw);
    }
    return rels;
  } catch (err) {
    warn(env, `${relsPath} 解析失败：${errText(err)}`);
    return new Map();
  }
}

/** 关系目标的正确取值：外部关系用原始 Target，包内关系用解析后的部件路径。 */
export function relTarget(env: DocxEnv, rel: Relationship): string {
  return rel.mode === 'External' ? (env.externalTargets.get(rel) ?? rel.target) : rel.target;
}

function readExternalTargets(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start' || e.local !== 'Relationship') continue;
    if ((attr(e, 'TargetMode') ?? '').toLowerCase() !== 'external') continue;
    const id = attr(e, 'Id');
    const target = attr(e, 'Target');
    if (id && target) out.set(id, target);
  }
  return out;
}

/** 临时切换「当前部件的 rels / 文本模式」，解析完恢复（含异常路径）。 */
export async function withPart<T>(
  env: DocxEnv,
  rels: Map<string, Relationship>,
  textOnly: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const savedRels = env.rels;
  const savedTextOnly = env.textOnly;
  env.rels = rels;
  env.textOnly = savedTextOnly || textOnly;
  try {
    return await fn();
  } finally {
    env.rels = savedRels;
    env.textOnly = savedTextOnly;
  }
}

/* ==================================================================== */
/* 属性读取（在共用层的基础上补 docx 读取器真正需要的两件事）              */
/* ==================================================================== */

/** ooxml/styles.ts 的 readRunProps 会忽略 w:rStyle（它当时用不上），读取器需要它。 */
export interface RunPrExt extends RunProps {
  /** w:rStyle 引用的字符样式 id */
  styleId?: string;
}

export function readRunPropsExt(p: XmlPullParser, out: RunPrExt = {}): RunPrExt {
  readPropChildren(p, (e) => {
    if (e.local === 'rStyle') out.styleId = attr(e, 'val');
    else applyRunProp(out, e);
  });
  return out;
}

/** ooxml/styles.ts 的 readParaProps 会忽略 w:pStyle（它当时用不上），读取器需要它。 */
export interface ParaPrExt extends ParaProps {
  /** w:pStyle 引用的段落样式 id */
  styleId?: string;
}

/**
 * 读 `w:pPr` 子树。调用前提：p 刚产出 `w:pPr` 的 start 事件（非自闭合）。
 *
 * 为什么不直接用 ooxml 的 readParaProps：它把 w:pStyle 丢掉了，而「段落引用了哪个
 * 样式」正是保真度的关键（字号/缩进/大纲级别全在样式链里）。
 * 因此这里复用它对单个子元素的处理（applyParaProp / readRunPropsExt），
 * 自己补 numPr / tabs / pBdr / pStyle 四个需要下钻或专用字段的子树。
 */
export function readParaPropsExt(p: XmlPullParser, out: ParaPrExt = {}, env?: DocxEnv): ParaPrExt {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'pStyle':
        out.styleId = attr(e, 'val');
        break;
      case 'rPr':
        if (!e.selfClosing) out.runDefaults = mergeDefined(out.runDefaults, readRunPropsExt(p, {}));
        continue; // readRunPropsExt 已消费到 </w:rPr>
      case 'numPr': {
        if (e.selfClosing) break;
        let ne: XmlEvent | null;
        while ((ne = p.next()) !== null) {
          if (ne.type === 'end') break;
          if (ne.type !== 'start') continue;
          if (ne.local === 'numId') out.numId = attr(ne, 'val');
          else if (ne.local === 'ilvl') out.ilvl = attrInt(ne, 'val', 0);
        }
        continue;
      }
      case 'tabs': {
        if (e.selfClosing) break;
        const tabs: number[] = [];
        let te: XmlEvent | null;
        while ((te = p.next()) !== null) {
          if (te.type === 'end') break;
          if (te.type !== 'start') continue;
          // val="clear" 表示「取消该位置的自定义制表位」，不是制表位本身
          if (te.local === 'tab' && (attr(te, 'val') ?? 'left') !== 'clear') {
            const pos = attrNum(te, 'pos', NaN);
            if (Number.isFinite(pos)) tabs.push(twipToPt(pos));
          }
        }
        if (tabs.length) out.tabsPt = tabs;
        continue;
      }
      case 'pBdr': {
        if (e.selfClosing) break;
        out.borders = readParaBorders(p);
        continue;
      }
      case 'sectPr':
        // 段落级 sectPr = 分节符。UDM 只有一份全局页面设置，无法表达「每节不同」，
        // 因此这里跳过；正文末尾那一份 sectPr 才是最终生效的（见 readSectPr）。
        if (env) warnOnce(env, 'sectPr-paragraph', '文档含分节符（段落级 sectPr），页面设置取最后一节的几何参数');
        if (!e.selfClosing) p.skipElement();
        continue;
      default:
        applyParaProp(out, e);
        break;
    }
    if (!e.selfClosing) p.skipElement();
  }
  return out;
}

function readParaBorders(p: XmlPullParser): NonNullable<ParaProps['borders']> {
  const out: NonNullable<ParaProps['borders']> = {};
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    const sz = attrNum(e, 'sz', 4);
    const line = {
      widthPt: eighthPtToPt(Number.isFinite(sz) && sz > 0 ? sz : 4),
      color: parseColor(attr(e, 'color')),
      style: attr(e, 'val'),
    };
    if (e.local === 'top') out.top = line;
    else if (e.local === 'bottom') out.bottom = line;
    else if (e.local === 'left' || e.local === 'start') out.left = line;
    else if (e.local === 'right' || e.local === 'end') out.right = line;
  }
  return out;
}

/* ==================================================================== */
/* 边框                                                                  */
/* ==================================================================== */

const BORDER_STYLE: Record<string, BorderLine['style']> = {
  single: 'solid',
  thick: 'solid',
  double: 'double',
  dashed: 'dashed',
  dashSmallGap: 'dashed',
  dotDash: 'dashed',
  dotDotDash: 'dashed',
  dotted: 'dotted',
  wave: 'dotted',
  doubleWave: 'dotted',
  threeDEmboss: 'solid',
  threeDEngrave: 'solid',
  outset: 'solid',
  inset: 'solid',
  none: 'none',
  nil: 'none',
};

/** 读一个 OOXML 边框元素（top/left/…）为 UDM 的 BorderLine。 */
export function borderLineOf(e: XmlEvent): BorderLine {
  const val = (attr(e, 'val') ?? 'single').toLowerCase();
  const style = BORDER_STYLE[val] ?? 'solid';
  const sz = attrNum(e, 'sz', 4);
  return {
    // 边框宽度在 OOXML 里是 1/8 pt
    width: style === 'none' ? 0 : eighthPtToPt(Number.isFinite(sz) && sz > 0 ? sz : 4),
    color: parseColor(attr(e, 'color')),
    style,
  };
}

/** 读 `w:tblBorders` / `w:tcBorders` 容器为 UDM BorderStyle。 */
export function readBorders(p: XmlPullParser): BorderStyle | undefined {
  const out: BorderStyle = {};
  let any = false;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    const line = borderLineOf(e);
    switch (e.local) {
      case 'top':
        out.top = line;
        break;
      case 'bottom':
        out.bottom = line;
        break;
      case 'left':
      case 'start':
        out.left = line;
        break;
      case 'right':
      case 'end':
        out.right = line;
        break;
      case 'insideH':
        out.insideH = line;
        break;
      case 'insideV':
        out.insideV = line;
        break;
      default:
        continue; // 如 w:bar / w:between：UDM 无对应槽位，忽略
    }
    any = true;
  }
  return any ? out : undefined;
}

/** 段落边框：ParaProps.borders（只有四条边）-> UDM BorderStyle。 */
export function paraBordersToStyle(b: NonNullable<ParaProps['borders']> | undefined): BorderStyle | undefined {
  if (!b) return undefined;
  const out: BorderStyle = {};
  const toLine = (v: { widthPt: number; color?: string; style?: string } | undefined): BorderLine | undefined => {
    if (!v) return undefined;
    const style = BORDER_STYLE[(v.style ?? 'single').toLowerCase()] ?? 'solid';
    return { width: style === 'none' ? 0 : v.widthPt, color: v.color, style };
  };
  const top = toLine(b.top);
  const bottom = toLine(b.bottom);
  const left = toLine(b.left);
  const right = toLine(b.right);
  if (top) out.top = top;
  if (bottom) out.bottom = bottom;
  if (left) out.left = left;
  if (right) out.right = right;
  return Object.keys(out).length ? out : undefined;
}

/* ==================================================================== */
/* 段落样式映射                                                          */
/* ==================================================================== */

/**
 * 把「直接 pPr」经样式继承链解析并映射成 UDM 的 ParaStyle。
 * 同时把解析出的**字符属性基线**写回 st.baseRun —— run 的样式要以它为底。
 *
 * 记忆化很重要：applyListStyle 会推进编号计数器，重复调用会让 1.2.3. 变成 2.4.6.
 */
export function ensureParaStyle(st: RunState, env: DocxEnv): ParaStyle | undefined {
  if (st.styleResolved) return st.style;
  st.styleResolved = true;
  const ext = st.ext;
  const resolved = resolveParaProps(env.styles, ext.styleId, ext);
  st.baseRun = resolveRunProps(env.styles, ext.styleId, ext.runDefaults);

  const ps: ParaStyle = {};
  if (resolved.align) ps.align = resolved.align;
  if (resolved.spaceBeforePt !== undefined) ps.spaceBefore = resolved.spaceBeforePt;
  if (resolved.spaceAfterPt !== undefined) ps.spaceAfter = resolved.spaceAfterPt;
  if (resolved.lineHeightExactPt !== undefined) ps.lineHeightExact = resolved.lineHeightExactPt;
  else if (resolved.lineHeight !== undefined) ps.lineHeight = resolved.lineHeight;
  if (resolved.indentStartPt !== undefined) ps.indentStart = resolved.indentStartPt;
  if (resolved.indentEndPt !== undefined) ps.indentEnd = resolved.indentEndPt;
  if (resolved.indentFirstPt !== undefined) ps.indentFirst = resolved.indentFirstPt;
  if (resolved.outlineLevel !== undefined) ps.outlineLevel = resolved.outlineLevel;
  if (resolved.pageBreakBefore) ps.pageBreakBefore = true;
  if (resolved.shading) ps.shading = resolved.shading;
  if (resolved.tabsPt?.length) ps.tabs = resolved.tabsPt;
  const border = paraBordersToStyle(resolved.borders);
  if (border) ps.border = border;

  // 样式名：优先用 styles.xml 里的显示名（可能是 "heading 1" / "标题 1"），
  // 它同时也是 outlineFromBlocks() 提取大纲的兜底依据。
  const def = ext.styleId ? env.styles.styles.get(ext.styleId) : undefined;
  const styleName = def?.name ?? ext.styleId;
  if (styleName) ps.styleName = styleName;

  applyListStyle(ps, resolved, env);
  st.style = Object.keys(ps).length ? ps : undefined;
  return st.style;
}

/**
 * 把 w:numPr 变成 UDM 的列表字段，并维护**每层计数器**。
 *
 * 为什么必须有计数器：Word 的编号文字不在正文里，而是由 numbering.xml 的
 * lvlText 模板（如 "%1."）加运行时计数渲染出来的。只取 start 值的话，
 * 有序列表会永远是 "1. 1. 1."，用户一眼就看出是假的。
 */
export function applyListStyle(ps: ParaStyle, resolved: ParaProps, env: DocxEnv): void {
  const numId = resolved.numId;
  if (!numId || numId === '0') return; // numId=0 是「取消编号」的约定写法
  const ilvl = resolved.ilvl ?? 0;
  ps.listLevel = ilvl;

  const level = levelOf(env.numbering, numId, ilvl);
  if (!level) {
    warnOnce(env, `num:${numId}`, `编号定义 numId=${numId} 在 numbering.xml 中不存在，列表标记已省略`);
    return;
  }
  const ordered = level.numFmt !== 'bullet' && level.numFmt !== 'none';
  ps.listOrdered = ordered;

  let counters = env.counters.get(numId);
  if (!counters) {
    counters = [];
    env.counters.set(numId, counters);
  }
  if (ordered) {
    const start = level.start > 0 ? level.start : 1;
    counters[ilvl] = (counters[ilvl] ?? start - 1) + 1;
    // 更深层级归零：从上层再往下走时，子层应重新从 start 开始
    for (let i = ilvl + 1; i < counters.length; i++) counters[i] = undefined;
  }
  // renderListMarker 对未定义的层号回落到该层的 start 值，所以这里可以放心传稀疏数组
  ps.listMarker = renderListMarker(level, counters as readonly number[]);

  // Word 通常把列表缩进写在 numbering 的 lvl/pPr 里而不是段落上
  if (ps.indentStart === undefined && level.indentStartTwip !== undefined) ps.indentStart = twipToPt(level.indentStartTwip);
  if (ps.indentFirst === undefined && level.hangingTwip !== undefined) ps.indentFirst = -twipToPt(level.hangingTwip);
}

/** 把解析出的 RunProps 映射成 UDM RunStyle；全空则返回 undefined（省内存）。 */
export function toRunStyle(merged: RunProps, link: string | undefined, env: DocxEnv): RunStyle | undefined {
  const out: RunStyle = {};
  if (merged.bold) out.bold = true;
  if (merged.italic) out.italic = true;
  if (merged.underline) out.underline = true;
  if (merged.strike) out.strike = true;
  if (merged.color) out.color = merged.color;
  if (merged.highlight) out.highlight = merged.highlight;
  if (merged.sizePt !== undefined) out.size = merged.sizePt;
  if (merged.font) out.font = merged.font;
  if (merged.fontEastAsia) out.fontEastAsia = merged.fontEastAsia;
  if (merged.vertAlign && merged.vertAlign !== 'baseline') out.vertAlign = merged.vertAlign;
  if (merged.letterSpacingPt) out.letterSpacing = merged.letterSpacingPt;
  if (merged.caps && merged.caps !== 'none') out.caps = merged.caps;
  if (merged.hidden) out.hidden = true;
  if (link) out.link = link;
  if (!Object.keys(out).length) return undefined;

  // 共享同一个 RunStyle 实例：真实文档里几万个 run 的样式其实只有几十种，
  // 逐个建对象会让 modelBytes 明显膨胀。模型按只读使用，共享是安全的。
  const key = JSON.stringify(out);
  const hit = env.styleCache.get(key);
  if (hit) return hit;
  env.styleCache.set(key, out);
  return out;
}

/* ==================================================================== */
/* Run / 段落状态                                                        */
/* ==================================================================== */

export interface FieldFrame {
  instr: string;
  /** 域结果在 st.runs 中的起始下标 */
  resultStart: number;
  inResult: boolean;
}

export interface RunState {
  /** 当前段落的 run 序列 */
  runs: Run[];
  /** 文本框等被展平的附加块（追加在所属段落之后） */
  extraBlocks: Block[];
  /** 当前超链接目标（w:hyperlink 或 HYPERLINK 域） */
  link?: string;
  /** 下一个 run 需要先换行（w:br / w:cr） */
  pendingBreak: boolean;
  fieldStack: FieldFrame[];
  /** 分页符回调，由 parseParagraph 注入 —— 在事件发生的那一刻切段，保证顺序正确 */
  onPageBreak: (() => void) | null;
  /** 当前段落的直接 pPr */
  ext: ParaPrExt;
  /** 已解析的段落样式（惰性 + 记忆化） */
  style?: ParaStyle;
  styleResolved: boolean;
  /** 字符属性基线：docDefaults + 段落样式 + pPr/rPr */
  baseRun?: RunProps;
  /**
   * 块级解析器（由 body.ts 注入）。
   * 文本框内容本质上是「一段块序列」，但块解析在 body.ts 而文本框在 inline.ts，
   * 直接互相 import 会形成循环，因此用注入的方式打破依赖方向。
   */
  blockParser: ((p: XmlPullParser, out: Block[]) => Promise<void>) | null;
}

export function createRunState(): RunState {
  return {
    runs: [],
    extraBlocks: [],
    pendingBreak: false,
    fieldStack: [],
    onPageBreak: null,
    ext: {},
    styleResolved: false,
    blockParser: null,
  };
}

/* ==================================================================== */
/* mc:AlternateContent                                                   */
/* ==================================================================== */

export type SubtreeParser = (p: XmlPullParser) => Promise<void>;

/**
 * 处理 `mc:AlternateContent`：Choice 是新一代标记（DrawingML），Fallback 是旧标记（VML）。
 *
 * 为什么必须去重：真实文件里这两份描述的是**同一个对象**（同一张图/同一个文本框）。
 * 两份都解析会让图片数量翻倍、文本框文字重复出现 —— 交叉验证真实 Word 文件时
 * 立刻会暴露（夹具 testA~testG 每个都有 2 个 AlternateContent）。
 * 规则：Choice 产出了任何内容就忽略 Fallback；Choice 什么都没产出才回落。
 */
export async function parseAlternateContent(
  p: XmlPullParser,
  producedBefore: number,
  produced: () => number,
  parseSub: SubtreeParser,
): Promise<void> {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    if (e.local === 'Choice' || e.local === 'Fallback') {
      if (e.selfClosing) continue;
      if (e.local === 'Fallback' && produced() > producedBefore) {
        p.skipElement();
        continue;
      }
      await parseSub(p);
      continue;
    }
    if (!e.selfClosing) p.skipElement();
  }
}

/* ==================================================================== */
/* sectPr（页面设置）                                                     */
/* ==================================================================== */

export function readSectPr(p: XmlPullParser, env: DocxEnv): void {
  env.sectionCount++;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'pgSz': {
        const w = attrNum(e, 'w', NaN);
        const h = attrNum(e, 'h', NaN);
        // landscape 时 Word 已经把 w/h 交换过，这里不再反转，否则会二次旋转
        if (Number.isFinite(w)) env.page.widthPt = twipToPt(w);
        if (Number.isFinite(h)) env.page.heightPt = twipToPt(h);
        break;
      }
      case 'pgMar': {
        const margin = { top: 0, right: 0, bottom: 0, left: 0 };
        let any = false;
        for (const k of ['top', 'right', 'bottom', 'left'] as const) {
          const v = attrNum(e, k, NaN);
          if (Number.isFinite(v)) {
            margin[k] = twipToPt(v);
            any = true;
          }
        }
        if (any) env.page.margin = margin;
        break;
      }
      case 'cols': {
        // 分栏是页面级版式，UDM 只有单一栏宽模型 —— 明确记警告而不是静默丢弃
        const num = attrNum(e, 'num', 1);
        if (Number.isFinite(num) && num > 1) warnOnce(env, 'cols', `文档含分栏版式（w:cols num=${num}），分栏未还原（按单栏排版）`);
        break;
      }
      case 'headerReference':
      case 'footerReference': {
        const id = attr(e, 'id');
        if (id) {
          env.headerFooterRefs.push({
            kind: e.local === 'headerReference' ? 'header' : 'footer',
            type: attr(e, 'type') ?? 'default',
            id,
          });
        }
        break;
      }
      default:
        break;
    }
    if (!e.selfClosing) p.skipElement();
  }
}

/* ==================================================================== */
/* 图片内禀尺寸（无 wp:extent / VML style 时的兜底）                       */
/* ==================================================================== */

/** 从图片字节里读出像素尺寸；识别不了返回 undefined。 */
export function imageSizePx(bytes: Uint8Array): { w: number; h: number } | undefined {
  const len = bytes.length;
  // PNG：IHDR 固定在偏移 16
  if (len > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const w = be32(bytes, 16);
    const h = be32(bytes, 20);
    if (w > 0 && h > 0) return { w, h };
  }
  // GIF
  if (len > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    if (w > 0 && h > 0) return { w, h };
  }
  // BMP
  if (len > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const w = le32(bytes, 18);
    const h = Math.abs(le32(bytes, 22));
    if (w > 0 && h > 0) return { w, h };
  }
  // JPEG：扫段找 SOF
  if (len > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < len) {
      if (bytes[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = bytes[o + 1];
      if (marker === 0xff) {
        o++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const segLen = (bytes[o + 2] << 8) | bytes[o + 3];
      if (segLen < 2) break;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const h = (bytes[o + 5] << 8) | bytes[o + 6];
        const w = (bytes[o + 7] << 8) | bytes[o + 8];
        if (w > 0 && h > 0) return { w, h };
        break;
      }
      o += 2 + segLen;
    }
  }
  return undefined;
}

/** 按魔数判断 MIME —— 第三方工具把图片部件改名（.bin/.dat）时靠它救回来。 */
export function mimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  return undefined;
}

function be32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function le32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
}
