/**
 * 形状解析：`p:sp` / `p:pic` / `p:graphicFrame` / `p:grpSp` / `p:cxnSp`。
 *
 * 贯穿全文件的约定（细节见 scan.ts 顶部）：
 *   1. 每个 `readXxx` 都消费掉该元素的**整棵子树**，返回时解析器停在该元素的
 *      结束标签上。于是调用方可以继续遍历兄弟节点而不错位 ——
 *      `p:spTree` 里几十个并列 `p:sp` 全靠这条约定才不会被跳过。
 *   2. **不自己调 `skipElement()`**：一律用 `eachChild`，用返回值表达
 *      「我要不要深入」。这样永远不会踩到「跳过根元素导致遍历提前结束」的坑。
 *   3. 需要延后解析的子树（`p:txBody`、`a:graphicData`、`mc:Fallback`）在收集
 *      阶段就用 `defer()` 换成「可重放的解析器工厂」，绝不持有已经流过去的
 *      `XmlEvent` —— 那会导致文字全丢或串到别的形状上。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { attr, attrInt } from '../../ooxml/src/xmlUtil.ts';
import type { Relationship } from '../../ooxml/src/package.ts';
import type { Theme } from '../../ooxml/src/theme.ts';
import type { InlineImage, Shape, ShapeKind, Table, TableCell, TableRow } from '../../core/src/model.ts';
import { emuToPt } from '../../core/src/units.ts';
import { readColorElement } from './color.ts';
import type { ResolvedColor } from './color.ts';
import {
  combineMaps,
  groupMap,
  kindFromPreset,
  radiusFromPreset,
  transformShapeXfrm,
  xfrmFrom,
} from './geometry.ts';
import type { GroupMap, Xfrm } from './geometry.ts';
import { defer, eachChild, skipDeep } from './scan.ts';
import { pptxDbg } from './diag.ts';
import type { ParserFactory } from './scan.ts';
import { makeTextContext, mergeTextStyle, readBodyDefaults, readTextBody, resolveShapeFonts } from './text.ts';
import type { TextStyle } from './text.ts';
import type { ThemeFonts } from './fonts.ts';

/* ==================================================================== */
/* 上下文                                                                */
/* ==================================================================== */

/** 占位符的几何与样式（来自 slideLayout / slideMaster 的对应 `p:ph`）。 */
export interface Holder {
  xfrm: Xfrm;
  hasFill: boolean;
  fill?: string;
  hasStroke: boolean;
  stroke?: string;
  strokeWidth?: number;
  /** 占位符形状自身给出的文字默认样式 */
  text: TextStyle;
  /** 版式 `p:txStyles` 给的该类占位符默认（第 1 级 `a:defRPr`） */
  levelText?: TextStyle;
}

/** 图片预算：张数与字节数的双重上限（真实大课件必须靠它避免 OOM）。 */
export interface ImageBudget {
  count: number;
  bytes: number;
  /** 达到上限后只保留尺寸与 MIME，不再读取字节 */
  exhausted: boolean;
}

/** 图片字节来源（由 reader 注入；shapes.ts 不依赖容器接口）。 */
export interface ImageSource {
  has(part: string): boolean;
  mime(part: string): string;
  /** 部件解压后的声明大小（只读中央目录，不解压） */
  size(part: string): number;
  load(part: string): Promise<Uint8Array | undefined>;
}

/** 一次幻灯片解析共享的状态。 */
export interface ShapeCtx {
  p: XmlPullParser;
  theme: Theme;
  /** 主题字体表（把 +mj-lt / +mn-ea 换成真实字体名） */
  fonts?: ThemeFonts;
  /** slide 的 `.rels`：解析 `r:embed` / `r:id` */
  rels: Map<string, Relationship>;
  /** 按 type/idx 索引的占位符表（layout 覆盖 master 之后的结果） */
  holders: Map<string, Holder>;
  /** 当前组合链的坐标映射 */
  map: GroupMap;
  /** 当前组合链的字号缩放（组合按比例缩放时文字也跟着缩放） */
  fontScale: number;
  budget: ImageBudget;
  source: ImageSource;
  /** 待加载字节的图片（含未加载的），由 reader 在解析完成后统一处理 */
  pendingImages: Array<{ shape: Shape; part: string; width: number; height: number }>;
  /** 输出目标（layout/master 解析时传一个丢弃用的数组） */
  shapes: Shape[];
  /** 全局统计槽位：maxShapes 是整篇上限，必须跨页共享 */
  statsSlot: { shapes: number };
  /** 形状总数上限（limits.maxShapes） */
  maxShapes: number;
  warn: (key: string, message: string) => void;
}

/** 构造一个 ShapeCtx，只覆盖需要变化的字段（组合递归时用）。 */
function deriveCtx(ctx: ShapeCtx, over: Partial<ShapeCtx>): ShapeCtx {
  return {
    p: over.p ?? ctx.p,
    theme: over.theme ?? ctx.theme,
    fonts: over.fonts ?? ctx.fonts,
    rels: over.rels ?? ctx.rels,
    holders: over.holders ?? ctx.holders,
    map: over.map ?? ctx.map,
    fontScale: over.fontScale ?? ctx.fontScale,
    budget: over.budget ?? ctx.budget,
    source: over.source ?? ctx.source,
    pendingImages: over.pendingImages ?? ctx.pendingImages,
    shapes: over.shapes ?? ctx.shapes,
    statsSlot: over.statsSlot ?? ctx.statsSlot,
    maxShapes: over.maxShapes ?? ctx.maxShapes,
    warn: over.warn ?? ctx.warn,
  };
}

/* ==================================================================== */
/* 形状树遍历                                                            */
/* ==================================================================== */

/**
 * 遍历 `p:spTree`（或 `p:grpSp`）的全部形状，追加到 ctx.shapes。
 * 调用前提：p 刚产出容器元素的 start 事件。
 */
export function readShapeTree(p: XmlPullParser, tree: XmlEvent, ctx: ShapeCtx): void {
  eachChild(p, tree, (child) => dispatchShape(p, child, ctx));
}

/**
 * 分派一个形状子元素。
 * 返回 true 表示「已经把这棵子树消费掉」（walker 不必再跳过）。
 *
 * 这一层刻意做成「按 local 名分派 + 返回是否消费」的纯函数，
 * 于是 spTree、组合、`mc:Fallback` 片段三处可以共用同一套逻辑。
 */
function dispatchShape(p: XmlPullParser, e: XmlEvent, ctx: ShapeCtx): boolean {
  switch (e.local) {
    case 'sp':
      if (!e.selfClosing) readSp(p, e, ctx);
      return true;
    case 'pic':
      if (!e.selfClosing) readPic(p, e, ctx);
      return true;
    case 'graphicFrame':
      if (!e.selfClosing) readGraphicFrame(p, e, ctx);
      return true;
    case 'grpSp':
      if (!e.selfClosing) readGroup(p, e, ctx);
      return true;
    case 'cxnSp':
      if (!e.selfClosing) readCxnSp(p, e, ctx);
      return true;
    case 'AlternateContent':
      if (!e.selfClosing) readAlternateContent(p, e, ctx);
      return true;
    case 'contentPart':
      // `p:contentPart` 引用包内另一个部件作为形状内容，内容不在本部件里，
      // 不实现额外部件解析就无法还原。
      ctx.warn('content-part', 'p:contentPart（外部内容引用）不支持，已忽略该形状');
      return false;
    case 'nvGrpSpPr':
    case 'grpSpPr':
      // 形状树自身的属性/统计容器，不是形状
      return false;
    default:
      return false;
  }
}

/**
 * `mc:AlternateContent`：**取 `mc:Fallback`，不取 `mc:Choice`。**
 *
 * 理由：`mc:Choice` 的内容依赖 `Requires` 声明的命名空间（通常是 `a14`/`a15`/`p14`
 * 这类只有某个 Office 版本支持的扩展），旧版 Office 与多数第三方渲染器都会走
 * `mc:Fallback`。Fallback 分支是作者为兼容性准备的等价内容，对「能打开、位置对、
 * 文字在」这个目标而言是正解。
 */
function readAlternateContent(p: XmlPullParser, e: XmlEvent, ctx: ShapeCtx): void {
  let fallback: ParserFactory | undefined;
  eachChild(p, e, (child) => {
    if (child.local === 'Fallback') {
      if (child.selfClosing) return false;
      fallback = defer(p, child);
      return true;
    }
    // Choice 分支整棵丢弃
    return false;
  });
  if (!fallback) {
    ctx.warn('mc-no-fallback', 'mc:AlternateContent 没有 mc:Fallback 分支，已忽略该形状');
    return;
  }
  // Fallback 里是形状元素的片段，用一个独立解析器处理。
  // 注意 `defer` 保留的是 **mc:Fallback 这个根元素本身**，
  // 因此必须先进入它、再遍历它的直接子元素 —— 早期版本的 while 循环从根开始
  // 逐事件 dispatch，遇到 `mc:Fallback` 这个「不是形状」的根就直接跳过整棵子树，
  // 于是 Fallback 分支永远读不出任何形状（页面少一块内容，且不报任何错）。
  const make = fallback;
  const sub = make();
  let root: XmlEvent | null;
  while ((root = sub.next()) !== null) {
    if (root.type === 'start') break;
  }
  if (!root || root.selfClosing) {
    ctx.warn('mc-fallback-empty', 'mc:Fallback 分支为空，已忽略该形状');
    return;
  }
  eachChild(sub, root, (child) => dispatchShape(sub, child, ctx));
}

/* ==================================================================== */
/* 属性收集                                                              */
/* ==================================================================== */

interface XfrmParts {
  off?: XmlEvent;
  ext?: XmlEvent;
  chOff?: XmlEvent;
  chExt?: XmlEvent;
}

interface FillParts {
  /** 解析后的颜色（**就地解析**，不保留 XmlEvent 引用，见 readSpPr 的说明） */
  color?: string;
  alpha?: number;
  noFill?: boolean;
  gradFill?: boolean;
  pattFill?: boolean;
  blipFill?: boolean;
  /** 颜色上带了不支持的变换 */
  unsupported?: boolean;
}

export interface SpParts {
  name?: string;
  id?: string;
  phType?: string;
  phIdx?: number;
  /** 该形状是否带 `p:ph`（是占位符）。备注页靠它区分「备注正文」与页码/日期占位符 */
  phPresent?: boolean;
  xfrmEl?: XmlEvent;
  xfrm?: XfrmParts;
  prst?: string;
  custGeom?: boolean;
  fill?: FillParts;
  lnW?: number;
  lnColor?: string;
  lnNoFill?: boolean;
  lnDash?: string;
  /** 文字容器：**必须**用可重放工厂，不能留下 XmlEvent 引用 */
  txBody?: ParserFactory;
  /** `p:style` 的主题引用（直接格式缺失时的兜底） */
  fillRef?: XmlEvent;
  lnRef?: XmlEvent;
  fontRef?: XmlEvent;
  /** `p:pic` 的 `a:blip`（含 r:embed） */
  blip?: XmlEvent;
  /** `p:graphicFrame` 的 `a:graphicData`（含 uri），表格/图表/SmartArt 分流用 */
  graphicData?: ParserFactory;
  graphicDataUri?: string;
}

/**
 * 收集各形状的共同子树。各形状的非可视属性容器本地名不同
 * （nvSpPr/nvCxnSpPr/nvPicPr/nvGrpSpPr/nvGraphicFramePr），但内部结构一致。
 */
export function collectParts(p: XmlPullParser, e: XmlEvent, theme: Theme): SpParts {
  const out: SpParts = {};
  eachChild(p, e, (child) => {
    switch (child.local) {
      case 'nvSpPr':
      case 'nvCxnSpPr':
      case 'nvPicPr':
      case 'nvGrpSpPr':
      case 'nvGraphicFramePr':
        if (!child.selfClosing) readNv(p, child, out);
        return true;
      case 'spPr':
      case 'grpSpPr':
        if (!child.selfClosing) readSpPr(p, child, out, theme);
        return true;
      case 'txBody':
        // 文字要延后解析（需要继承样式），所以立刻换成可重放工厂
        if (!child.selfClosing) out.txBody = defer(p, child);
        return true;
      case 'style':
        if (!child.selfClosing) readStyleRefs(p, child, out);
        return true;
      case 'blipFill':
        if (!child.selfClosing) readBlipFill(p, child, out);
        return true;
      case 'graphic':
        if (!child.selfClosing) readGraphic(p, child, out);
        return true;
      case 'xfrm':
        // `p:graphicFrame` 的 xfrm 直接在 p:graphicFrame 下（不在 p:spPr 里）
        out.xfrmEl = child;
        if (!child.selfClosing) readXfrmParts(p, child, out);
        return true;
      default:
        return false;
    }
  });
  return out;
}

/** `p:cNvPr`（name/id）+ `p:nvPr/p:ph`（占位符）。 */
function readNv(p: XmlPullParser, nv: XmlEvent, out: SpParts): void {
  eachChild(p, nv, (child) => {
    if (child.local === 'cNvPr') {
      const name = attr(child, 'name');
      if (name) out.name = name;
      const id = attr(child, 'id');
      if (id !== undefined) out.id = id;
      return false;
    }
    if (child.local === 'nvPr') {
      if (child.selfClosing) return true;
      readNvPr(p, child, out);
      return true;
    }
    return false;
  });
}

function readNvPr(p: XmlPullParser, nvPr: XmlEvent, out: SpParts): void {
  eachChild(p, nvPr, (gc) => {
    if (gc.local === 'ph') {
      out.phPresent = true;
      out.phType = attr(gc, 'type') ?? 'body';
      const idx = attrInt(gc, 'idx', -1);
      if (idx >= 0) out.phIdx = idx;
      return false;
    }
    // nvPr 里还有 a:extLst / a14:... 等扩展，跳过
    return false;
  });
}

/**
 * `p:spPr` / `p:grpSpPr`：xfrm + prstGeom + 填充 + 描边。
 *
 * 颜色**就地解析**成字符串，绝不把 `XmlEvent` 存起来以后再读。
 * 原因（这是一类很难定位的 bug 的根源）：`XmlEvent` 只是一个值对象，
 * 本身不会失效，但**解析器已经离开那个位置**。任何「先存 start 事件、
 * 稍后再用它去遍历子元素」的写法都会读到完全不相干的内容 ——
 * 本读取器早期版本在填充/描边上这么写过，现象是
 * 「第一个形状的属性读到第二个形状身上」。
 * 规则很简单：拿到了就立刻读完。
 */
function readSpPr(p: XmlPullParser, spPr: XmlEvent, out: SpParts, theme: Theme): void {
  eachChild(p, spPr, (child) => {
    switch (child.local) {
      case 'xfrm':
        out.xfrmEl = child;
        if (!child.selfClosing) readXfrmParts(p, child, out);
        return true;
      case 'prstGeom':
        out.prst = attr(child, 'prst');
        return false;
      case 'custGeom':
        out.custGeom = true;
        return false;
      case 'solidFill': {
        const fill: FillParts = out.fill ?? {};
        if (child.selfClosing) return false;
        const c = parseContainerColor(p, child, theme);
        if (!fill.color) {
          fill.color = c?.color;
          fill.alpha = c?.alpha;
          fill.unsupported = c?.unsupported;
        }
        out.fill = fill;
        return true;
      }
      case 'noFill': {
        const fill: FillParts = out.fill ?? {};
        // 显式 noFill：必须记下来，否则会去继承版式的填充
        fill.noFill = true;
        out.fill = fill;
        return false;
      }
      case 'gradFill': {
        const fill: FillParts = out.fill ?? {};
        fill.gradFill = true;
        // 渐变取首个色标近似（真实感足够，且不引入渐变方向/色标的复杂度）
        if (!child.selfClosing) {
          const c = firstGradientStopColor(p, child, theme);
          if (c && !fill.color) {
            fill.color = c.color;
            fill.alpha = c.alpha;
          }
        }
        out.fill = fill;
        return true;
      }
      case 'pattFill': {
        const fill: FillParts = out.fill ?? {};
        fill.pattFill = true;
        fill.unsupported = true;
        out.fill = fill;
        return false;
      }
      case 'blipFill': {
        const fill: FillParts = out.fill ?? {};
        fill.blipFill = true;
        out.fill = fill;
        return false;
      }
      case 'ln':
        if (!child.selfClosing) readLn(p, child, out, theme);
        return true;
      default:
        // a:effectLst / a:scene3d / a:sp3d / a:extLst 等：忽略
        return false;
    }
  });
}

/**
 * `a:solidFill` 之类容器里的颜色。消费容器子树。
 * 调用前提：p 刚产出容器元素的 start 事件（非自闭合）。
 */
function parseContainerColor(p: XmlPullParser, container: XmlEvent, theme: Theme): ResolvedColor | undefined {
  return firstColorIn(p, container, theme);
}

/** 在容器元素的直接子元素里找第一个颜色元素。消费容器子树。 */
function firstColorIn(p: XmlPullParser, container: XmlEvent, theme: Theme): ResolvedColor | undefined {
  let out: ResolvedColor | undefined;
  eachChild(p, container, (child) => {
    if (!out) {
      // 必须传 child：它已经拿到了 start 事件，不能再用「自己 next()」的变体
      out = readColorElement(p, child, theme);
      return true;
    }
    return false;
  });
  return out;
}

/** 渐变填充：取第一个色标的颜色作为近似。消费容器子树。 */
function firstGradientStopColor(p: XmlPullParser, container: XmlEvent, theme: Theme): ResolvedColor | undefined {
  if (container.selfClosing) return undefined;
  let out: ResolvedColor | undefined;
  eachChild(p, container, (child) => {
    if (child.local === 'gsLst' && !child.selfClosing) {
      eachChild(p, child, (gs) => {
        if (gs.local === 'gs' && !out) {
          if (gs.selfClosing) return false;
          out = firstColorIn(p, gs, theme);
          return true;
        }
        return false;
      });
      return true;
    }
    return false;
  });
  return out;
}

function readXfrmParts(p: XmlPullParser, xfrm: XmlEvent, out: SpParts): void {
  const parts: XfrmParts = out.xfrm ?? {};
  eachChild(p, xfrm, (child) => {
    switch (child.local) {
      case 'off':
        parts.off = child;
        return false;
      case 'ext':
        parts.ext = child;
        return false;
      case 'chOff':
        parts.chOff = child;
        return false;
      case 'chExt':
        parts.chExt = child;
        return false;
      default:
        return false;
    }
  });
  out.xfrm = parts;
}

/** `a:ln`：线宽（EMU）+ 线色；虚线样式只记录不用（对缩略图影响极小）。 */
function readLn(p: XmlPullParser, ln: XmlEvent, out: SpParts, theme: Theme): void {
  const w = attr(ln, 'w');
  if (w !== undefined) {
    const n = Number.parseFloat(w);
    if (Number.isFinite(n)) out.lnW = emuToPt(n);
  }
  eachChild(p, ln, (child) => {
    switch (child.local) {
      case 'solidFill':
        if (!child.selfClosing) out.lnColor = parseContainerColor(p, child, theme)?.color;
        return true;
      case 'gradFill':
        if (!child.selfClosing) out.lnColor = firstGradientStopColor(p, child, theme)?.color;
        return true;
      case 'noFill':
        out.lnNoFill = true;
        return false;
      case 'prstDash':
        out.lnDash = attr(child, 'val');
        return false;
      default:
        return false;
    }
  });
}

/** `p:style`：主题引用（fillRef/lnRef/fontRef），作为直接格式缺失时的兜底。 */
function readStyleRefs(p: XmlPullParser, style: XmlEvent, out: SpParts): void {
  eachChild(p, style, (child) => {
    if (child.local === 'fillRef') out.fillRef = child;
    else if (child.local === 'lnRef') out.lnRef = child;
    else if (child.local === 'fontRef') out.fontRef = child;
    return false;
  });
}

function readBlipFill(p: XmlPullParser, blipFill: XmlEvent, out: SpParts): void {
  eachChild(p, blipFill, (child) => {
    if (child.local === 'blip') {
      // 只留 r:embed 字符串：XmlEvent 一旦离开当前解析位置就不能再拿来遍历
      out.blipEmbed = attr(child, 'embed');
      return false;
    }
    return false;
  });
}

/** `a:graphic` -> `a:graphicData`（含 uri），供表格/图表/SmartArt 分流。 */
function readGraphic(p: XmlPullParser, graphic: XmlEvent, out: SpParts): void {
  eachChild(p, graphic, (child) => {
    if (child.local === 'graphicData') {
      out.graphicDataUri = attr(child, 'uri');
      if (!child.selfClosing) out.graphicData = defer(p, child);
      return true;
    }
    return false;
  });
}

/* ==================================================================== */
/* 各类形状                                                              */
/* ==================================================================== */

function makeShape(kind: ShapeKind, xf: Xfrm): Shape {
  const sh: Shape = { kind, x: xf.x, y: xf.y, w: xf.w, h: xf.h };
  if (xf.rot !== undefined) sh.rot = xf.rot;
  if (xf.flipH) sh.flipH = true;
  if (xf.flipV) sh.flipV = true;
  return sh;
}

/** 添加形状的统一出口：维护 maxShapes 截断与计数。 */
function pushShape(ctx: ShapeCtx, sh: Shape): void {
  if (ctx.statsSlot.shapes >= ctx.maxShapes) {
    ctx.warn('max-shapes', `形状数达到 limits.maxShapes=${ctx.maxShapes}，其余形状已忽略`);
    return;
  }
  ctx.statsSlot.shapes++;
  ctx.shapes.push(sh);
}

function readSp(p: XmlPullParser, e: XmlEvent, ctx: ShapeCtx): void {
  const parts = collectParts(p, e, ctx.theme);
  const direct = xfrmFrom(parts.xfrmEl, parts.xfrm);
  const holder = pickHolder(ctx.holders, holderKeys(parts.phType, parts.phIdx));
  const xf = resolveXfrm(ctx, direct, holder);
  if (!xf) {
    ctx.warn(
      'sp-no-xfrm',
      `形状 "${parts.name ?? '未命名'}" 既没有 a:xfrm 也找不到占位符几何` +
        `（ph=${parts.phType ?? '-'}#${parts.phIdx ?? '-'}，holder=${holder ? 'found' : 'missing'}` +
        `，lookup=${holderKeys(parts.phType, parts.phIdx).join('/') || '-'}），已跳过`,
    );
    return;
  }
  const fill = resolveFill(ctx, parts, holder);
  const stroke = resolveStroke(ctx, parts, holder);
  const base = resolveTextBase(holder);

  const paras = parts.txBody
    ? readTextBody(parts.txBody, makeTextContext(ctx.theme, (m) => ctx.warn('text', m), base, ctx.fontScale, ctx.fonts))
    : [];

  let kind: ShapeKind;
  if (parts.custGeom) kind = 'path';
  else if (parts.prst === 'textBox' || parts.prst === 'txBox') kind = 'text';
  else if (parts.prst !== undefined) kind = kindFromPreset(parts.prst) ?? 'rect';
  else kind = 'placeholder';

  const sh = makeShape(kind, xf);
  applyCommon(sh, parts, fill, stroke);
  if (paras.length) {
    sh.blocks = paras;
    const empty = paras.every((pp) => pp.runs.every((r) => !r.text));
    if (empty && kind === 'placeholder') sh.empty = true;
  } else if (kind === 'placeholder') {
    sh.empty = true;
  }
  pushShape(ctx, sh);
  // 主题字体引用与超链接都要在形状建好后统一解析一次
  resolveShapeFonts(sh, ctx.fonts);
  resolveRunLinks(ctx, sh);
}

function readCxnSp(p: XmlPullParser, e: XmlEvent, ctx: ShapeCtx): void {
  const parts = collectParts(p, e, ctx.theme);
  const direct = xfrmFrom(parts.xfrmEl, parts.xfrm);
  const xf = resolveXfrm(ctx, direct, pickHolder(ctx.holders, holderKeys(parts.phType, parts.phIdx)));
  if (!xf) {
    ctx.warn('cxn-no-xfrm', 'p:cxnSp 没有几何信息，已跳过');
    return;
  }
  const sh = makeShape('line', xf);
  applyCommon(sh, parts, resolveFill(ctx, parts, undefined), resolveStroke(ctx, parts, undefined));
  pushShape(ctx, sh);
}

function readPic(p: XmlPullParser, e: XmlEvent, ctx: ShapeCtx): void {
  const parts = collectParts(p, e, ctx.theme);
  const direct = xfrmFrom(parts.xfrmEl, parts.xfrm);
  const holder = pickHolder(ctx.holders, holderKeys(parts.phType, parts.phIdx));
  const xf = resolveXfrm(ctx, direct, holder);
  if (!xf) {
    ctx.warn('pic-no-xfrm', `图片 "${parts.name ?? '未命名'}" 没有几何信息（a:xfrm 与占位符都缺），已跳过`);
    return;
  }
  const sh = makeShape('image', xf);
  applyCommon(sh, parts, undefined, resolveStroke(ctx, parts, holder));

  const embed = parts.blipEmbed;
  const rel = embed ? ctx.rels.get(embed) : undefined;
  if (!rel || rel.mode === 'External' || !ctx.source.has(rel.target)) {
    // r:embed 指向不存在的部件：真实文件里确实会出现（图片被工具裁掉）。
    // 保留形状与尺寸，渲染器仍能画出占位框，只是没有字节。
    ctx.warn(
      'pic-no-target',
      `图片形状 "${parts.name ?? '未命名'}" 的 r:embed=${embed ?? '缺失'} 无法解析到包内部件，已保留占位框`,
    );
    sh.image = { mime: 'application/octet-stream', width: xf.w, height: xf.h };
    pushShape(ctx, sh);
    return;
  }
  const img: InlineImage = {
    mime: ctx.source.mime(rel.target),
    width: xf.w,
    height: xf.h,
    partPath: rel.target,
  };
  if (parts.name) img.alt = parts.name;
  sh.image = img;
  ctx.pendingImages.push({ shape: sh, part: rel.target, width: xf.w, height: xf.h });
  pushShape(ctx, sh);
}

/** 把 run 上暂存的 `r:id` 超链接换成真实目标（UDM 的 RunStyle.link）。 */
function resolveRunLinks(ctx: ShapeCtx, sh: Shape): void {
  if (!sh.blocks) return;
  for (const b of sh.blocks) {
    if (b.kind !== 'para') continue;
    for (const r of b.runs) {
      const link = r.style?.link;
      if (!link) continue;
      const rel = ctx.rels.get(link);
      if (rel) r.style!.link = rel.target;
      else {
        delete r.style!.link;
        ctx.warn('hlink-unresolved', `超链接关系 ${link} 无法解析，已忽略该链接`);
      }
    }
  }
}

/* ==================================================================== */
/* 图片字节加载                                                          */
/* ==================================================================== */

/**
 * 把待加载图片的字节挂到形状上，并执行上限降级。
 *
 * 这是真实大课件（十几 MB、几十张插图）能否打开的关键路径：
 *   - 张数达到 `limits.maxImages` 或累计字节达到 `limits.maxImageBytes` 后
 *     **不再读取字节**，只保留 `mime` 与 `width/height`。于是内存占用与图片
 *     总量解耦，渲染器仍能显示占位框与正确尺寸，而不是整页打不开。
 *   - 单张图片读取失败（部件损坏 / 超过 maxEntryBytes）同样降级为「有 MIME 无字节」。
 *
 * **`stats.imageCount` / `stats.imageBytes` 的语义（与 docx 保持一致）：
 * 只统计「真的把字节挂进了模型」的图片**（即 `InlineImage.data !== undefined`）。
 * 被上限跳过的图片仍有形状、有尺寸、有 MIME，但**不计入**这两个字段 ——
 * 否则会出现「报了 11 MiB 图片字节、堆却只涨了 3 MiB」这种自相矛盾的报告。
 * 被跳过的部分通过 warning 里的「按需加载」说明呈现，用户仍知道文档里有多少图。
 *
 * 注意图片字节是 `Uint8Array`，在 Node 里计入 `process.memoryUsage().external`，
 * 不计入 `heapUsed`。因此拿 `heapUsed` 增量去核对 `imageBytes` 一定会对不上 ——
 * 基准测量应当用 `externalBytes + heapUsedBytes`（或 rss）。
 */
export async function loadPendingImages(ctx: ShapeCtx, maxImages: number, maxImageBytes: number): Promise<void> {
  let skipped = 0;
  let skippedBytes = 0;
  for (const item of ctx.pendingImages) {
    if (ctx.budget.exhausted) {
      skipped++;
      skippedBytes += ctx.source.size(item.part);
      continue;
    }
    if (ctx.budget.count >= maxImages || ctx.budget.bytes >= maxImageBytes) {
      ctx.budget.exhausted = true;
      ctx.warn(
        'image-budget',
        `图片数量或累计字节达到上限（maxImages=${maxImages} / maxImageBytes=${maxImageBytes}）`,
      );
      skipped++;
      skippedBytes += ctx.source.size(item.part);
      continue;
    }
    const data = await ctx.source.load(item.part);
    if (!data) {
      ctx.warn('image-load-fail', `图片部件 ${item.part} 读取失败，已保留尺寸与 MIME`);
      skipped++;
      continue;
    }
    // 加上这一张会突破硬上限：不加载（否则上限形同虚设），但仍保留尺寸信息
    if (ctx.budget.bytes + data.length > maxImageBytes) {
      ctx.budget.exhausted = true;
      ctx.warn('image-budget', '图片累计字节达到 maxImageBytes，其余图片只保留尺寸与 MIME 信息');
      skipped++;
      skippedBytes += data.length;
      continue;
    }
    const img = item.shape.image;
    if (img) img.data = data;
    ctx.budget.count++;
    ctx.budget.bytes += data.length;
  }
  if (skipped > 0) {
    ctx.warn(
      'images-lazy',
      `另有 ${skipped} 张图片（约 ${(skippedBytes / 1024).toFixed(0)} KiB）未读入内存，` +
        '只保留尺寸与 MIME，渲染时按 InlineImage.partPath 按需再取',
    );
  }
  ctx.pendingImages.length = 0;
}

/* ==================================================================== */
/* 表格                                                                  */
/* ==================================================================== */

function readGraphicFrame(p: XmlPullParser, e: XmlEvent, ctx: ShapeCtx): void {
  const parts = collectParts(p, e, ctx.theme);
  const direct = xfrmFrom(parts.xfrmEl, parts.xfrm);
  const xf = resolveXfrm(ctx, direct, pickHolder(ctx.holders, holderKeys(parts.phType, parts.phIdx)));
  if (!xf) {
    ctx.warn('gf-no-xfrm', 'p:graphicFrame 没有 a:xfrm，已跳过');
    return;
  }
  const uri = parts.graphicDataUri ?? '';
  const sh = makeShape('rect', xf);
  applyCommon(sh, parts, undefined, resolveStroke(ctx, parts, undefined));

  if (uri.includes('/table')) {
    const tbl = parts.graphicData ? findTableElement(ctx, parts.graphicData) : undefined;
    if (tbl) sh.blocks = [readTable(ctx, tbl)];
    else ctx.warn('table-empty', 'p:graphicFrame 声明是表格但找不到 a:tbl，已保留占位框');
  } else if (uri.includes('/chart')) {
    // 图表内容在独立的 chartN.xml 部件里，需要解析 drawing 的 r:id + chart XML。
    // 保留占位框并明确记 warning，而不是假装渲染了图表。
    sh.empty = true;
    ctx.warn('chart-placeholder', `图表（p:graphicFrame）只保留占位框，未渲染图表内容（uri=${uri}）`);
  } else if (uri.includes('/diagram')) {
    sh.empty = true;
    ctx.warn('smartart-placeholder', 'SmartArt（diagram）只保留占位框，未渲染布局');
  } else if (uri.includes('/ole')) {
    sh.empty = true;
    ctx.warn('ole-placeholder', 'OLE 嵌入对象只保留占位框');
  } else {
    sh.empty = true;
    ctx.warn('gf-unknown', `p:graphicFrame 的图形类型 ${uri || '未知'} 不支持，已保留占位框`);
  }
  pushShape(ctx, sh);
}

/** 在 `a:graphicData` 里取 `a:tbl`。消费整个 graphicData 子树。 */
function findTableElement(ctx: ShapeCtx, factory: ParserFactory): ParserFactory | undefined {
  const { p, e } = beginAt(factory);
  let tbl: ParserFactory | undefined;
  eachChild(p, e, (child) => {
    if (child.local === 'tbl') {
      if (!child.selfClosing) tbl = defer(p, child);
      return true;
    }
    return false;
  });
  return tbl;
}

/**
 * `a:tbl` -> UDM Table。消费整个 a:tbl 子树。
 *
 * 注意坐标系：`a:tbl` **没有自己的 xfrm**，位置与总尺寸由
 * `p:graphicFrame/p:xfrm` 给出，所以表格只解析行列/列宽/内容。
 * 列宽来自 `a:tblGrid/a:gridCol w`（EMU）。
 */
function readTable(ctx: ShapeCtx, factory: ParserFactory): Table {
  const { p, e } = beginAt(factory);
  const table: Table = { kind: 'table', rows: [] };
  const widths: number[] = [];
  eachChild(p, e, (child) => {
    switch (child.local) {
      case 'tblPr':
        if (child.selfClosing) return false;
        eachChild(p, child, (pc) => {
          if (pc.local === 'tableStyleId') {
            ctx.warn('table-style', '表格样式（a:tableStyleId）未实现，单元格填充/边框只按直接格式解析');
          }
          return false;
        });
        return true;
      case 'tblGrid':
        if (child.selfClosing) return false;
        eachChild(p, child, (gc) => {
          if (gc.local === 'gridCol') {
            const w = Number.parseFloat(attr(gc, 'w') ?? '');
            if (Number.isFinite(w)) widths.push(emuToPt(w));
          }
          return false;
        });
        return true;
      case 'tr':
        if (!child.selfClosing) table.rows.push(readTableRow(p, child, ctx));
        return true;
      default:
        return false;
    }
  });
  if (widths.length) table.widths = widths;
  return table;
}

function readTableRow(p: XmlPullParser, tr: XmlEvent, ctx: ShapeCtx): TableRow {
  const row: TableRow = { cells: [] };
  const h = Number.parseFloat(attr(tr, 'h') ?? '');
  if (Number.isFinite(h) && h > 0) row.height = emuToPt(h);
  eachChild(p, tr, (child) => {
    if (child.local === 'tc') {
      if (!child.selfClosing) row.cells.push(readTableCell(p, child, ctx));
      return true;
    }
    return false;
  });
  return row;
}

function readTableCell(p: XmlPullParser, tc: XmlEvent, ctx: ShapeCtx): TableCell {
  const cell: TableCell = { blocks: [] };
  eachChild(p, tc, (child) => {
    switch (child.local) {
      case 'txBody':
        if (child.selfClosing) return false;
        cell.blocks = readTextBody(
          defer(p, child),
          makeTextContext(ctx.theme, (m) => ctx.warn('table-text', m), {}, ctx.fontScale, ctx.fonts),
        );
        return true;
      case 'tcPr':
        if (!child.selfClosing) readTcPr(p, child, cell, ctx);
        return true;
      default:
        return false;
    }
  });
  return cell;
}

function readTcPr(p: XmlPullParser, tcPr: XmlEvent, cell: TableCell, ctx: ShapeCtx): void {
  const span = attrInt(tcPr, 'gridSpan', 1);
  if (span > 1) cell.colSpan = span;
  const rowSpan = attrInt(tcPr, 'rowSpan', 1);
  if (rowSpan > 1) cell.rowSpan = rowSpan;
  // hMerge/vMerge 为真表示「本格是合并的延续格」，渲染时应跳过
  if (isTrue(attr(tcPr, 'hMerge')) || isTrue(attr(tcPr, 'vMerge'))) cell.merged = true;
  // `anchor`（垂直对齐）是 **a:tcPr 的属性**，不是子元素 —— 一开始按子元素找，
  // 结果表格单元格的垂直居中永远丢失。
  const anchor = attr(tcPr, 'anchor');
  if (anchor !== undefined) cell.vAlign = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
  eachChild(p, tcPr, (child) => {
    switch (child.local) {
      case 'solidFill': {
        if (child.selfClosing) return false;
        let c: ResolvedColor | undefined;
        eachChild(p, child, (colorEl) => {
          if (!c) {
            c = readColorElement(p, colorEl, ctx.theme);
            return true;
          }
          return false;
        });
        if (c) cell.shading = c.color;
        return true;
      }
      case 'anchor': {
        // 少数生成器写成子元素形式，一并支持
        const v = attr(child, 'val');
        if (v !== undefined) cell.vAlign = v === 'ctr' ? 'middle' : v === 'b' ? 'bottom' : 'top';
        return false;
      }
      default:
        return false;
    }
  });
}

function isTrue(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'on';
}

/* ==================================================================== */
/* 组合形状                                                              */
/* ==================================================================== */

/**
 * `p:grpSp`。
 *
 * 坐标变换（DrawingML 规则）：
 *     parent = (child - chOff) * (ext / chExt) + off
 * 即「子坐标系 chOff/chExt」被拉伸到「组合自身 off/ext」。见 geometry.groupMap。
 *
 * 限制（诚实说明）：
 *   - 假设 sx == sy（各向异性缩放会连带影响组内文字与线宽，需要完整变换矩阵，
 *     而 UDM 的 Shape 没有矩阵字段，故取平均缩放）
 *   - 组合自身的**旋转被忽略**（只记 warning）：UDM 无法表达「绕组合中心旋转」，
 *     硬算会把子形状坐标算错，比不旋转更糟。
 *   - chOff/chExt 缺失时退化为纯平移。
 */
function readGroup(p: XmlPullParser, e: XmlEvent, ctx: ShapeCtx): void {
  let gxfEl: XmlEvent | undefined;
  let gxfParts: XfrmParts = {};
  let gName: string | undefined;
  let gId: string | undefined;
  const inner: Shape[] = [];
  let map: GroupMap | undefined;

  eachChild(p, e, (child) => {
    switch (child.local) {
      case 'nvGrpSpPr': {
        // 组合的名字/id 就在这里（p:nvGrpSpPr/p:cNvPr），早期版本整块跳过，
        // 于是所有组合形状都没有名字，按名字定位组合的调用方全部落空。
        if (child.selfClosing) return false;
        const parts: SpParts = {};
        readNv(p, child, parts);
        gName = parts.name;
        gId = parts.id;
        return true;
      }
      case 'grpSpPr': {
        if (child.selfClosing) return false;
        eachChild(p, child, (gc) => {
          if (gc.local === 'xfrm') {
            gxfEl = gc;
            if (!gc.selfClosing) {
              const parts: SpParts = {};
              readXfrmParts(p, gc, parts);
              gxfParts = parts.xfrm ?? {};
            }
            return true;
          }
          return false;
        });
        // 组合自身的位置要先映射到上层坐标系，再由 groupMap 建立子坐标映射。
        // XML 里 grpSpPr 总是排在子形状之前，因此单遍遍历即可满足这个顺序前提。
        const gxf = transformShapeXfrm(xfrmFrom(gxfEl, gxfParts), ctx.map);
        if (gxf.rot !== undefined) {
          ctx.warn('group-rot', '组合形状的旋转未实现（UDM 的 Shape 没有变换矩阵），已忽略该旋转角');
        }
        map = groupMap(gxfParts, gxf, (m) => ctx.warn('group', m));
        return true;
      }
      default: {
        // 子形状在组合局部坐标系里递归（嵌套组合会自然累积变换）。
        // grpSpPr 缺失时 map 仍未定义，此时退化为「不缩放」而不是抛错。
        const sub = map
          ? deriveCtx(ctx, { map: combineMaps(ctx.map, map), fontScale: ctx.fontScale * map.scale, shapes: [] })
          : deriveCtx(ctx, { shapes: [] });
        const consumed = dispatchShape(p, child, sub);
        for (const s of sub.shapes) inner.push(s);
        return consumed;
      }
    }
  });

  const finalXf = transformShapeXfrm(xfrmFrom(gxfEl, gxfParts), ctx.map);
  const gsh = makeShape('group', finalXf);
  // 组合自身的旋转无法用 UDM 表达（子形状坐标已按未旋转的映射算出），
  // 与其给出错误位置，不如不写 rot。
  delete gsh.rot;
  // 组合的名字/id 与普通形状一样在 p:nvGrpSpPr/p:cNvPr 上
  if (gName) gsh.name = gName;
  if (gId !== undefined) gsh.id = gId;
  gsh.shapes = inner;
  pushShape(ctx, gsh);
}

/* ==================================================================== */
/* 通用属性解析                                                          */
/* ==================================================================== */

function holderKeys(phType: string | undefined, phIdx: number | undefined): string[] {
  const keys: string[] = [];
  if (phType && phIdx !== undefined) keys.push(`${phType}#${phIdx}`);
  if (phType) keys.push(phType);
  if (phIdx !== undefined) keys.push(`#${phIdx}`);
  return keys;
}

function pickHolder(holders: Map<string, Holder>, keys: readonly string[]): Holder | undefined {
  for (const k of keys) {
    const h = holders.get(k);
    if (h) return h;
  }
  return undefined;
}

/**
 * 形状几何：优先用自己的 `a:xfrm`；缺失时从 layout/master 的对应 `p:ph` 继承
 * （PowerPoint 里占位符的位置默认由版式决定，slide 上常常完全不写 xfrm）。
 * 两者都没有时返回 undefined，由调用方跳过并记 warning。
 */
function resolveXfrm(ctx: ShapeCtx, direct: Xfrm, holder: Holder | undefined): Xfrm | undefined {
  let base: Xfrm | undefined;
  if (direct.present) base = direct;
  else if (holder && holder.xfrm.present) base = holder.xfrm;
  if (!base) return undefined;
  return transformShapeXfrm(base, ctx.map);
}

interface FillResult {
  color?: string;
  opacity?: number;
}

function resolveFill(ctx: ShapeCtx, parts: SpParts, holder: Holder | undefined): FillResult | undefined {
  if (parts.fill) {
    const direct = fillFromParts(ctx, parts.fill);
    // 显式 noFill 表示「真的不填充」，不能再去继承版式的填充
    if (direct || parts.fill.noFill) return direct;
  }
  if (holder?.hasFill) return holder.fill ? { color: holder.fill } : undefined;
  return undefined;
}

function resolveStroke(ctx: ShapeCtx, parts: SpParts, holder: Holder | undefined): { color?: string; width?: number } | undefined {
  if (parts.lnNoFill) return undefined;
  const color = parts.lnColor;
  const width = parts.lnW;
  if (color || width !== undefined) return { color, width };
  if (holder?.hasStroke) return { color: holder.stroke, width: holder.strokeWidth };
  return undefined;
}

function fillFromParts(ctx: ShapeCtx, fill: FillParts): FillResult | undefined {
  if (fill.noFill) return undefined;
  if (fill.unsupported) {
    if (fill.pattFill) ctx.warn('patt-fill', '图案填充（a:pattFill）未实现，已忽略该图案');
    if (fill.unsupported) ctx.warn('color-unsupported', '颜色/填充带有不支持的变换（hueMod/comp/inv 等），已按基色近似');
  }
  if (fill.gradFill) ctx.warn('grad-fill', '渐变填充只取首个色标近似，未还原渐变方向与色标分布');
  if (fill.blipFill) {
    ctx.warn('shape-blipfill', '形状的图片填充（a:blipFill）未实现，已忽略该填充');
    return undefined;
  }
  if (fill.color) return { color: fill.color, opacity: fill.alpha };
  return undefined;
}


/**
 * 形状的默认文字样式。顺序上「占位符形状自己的 txBody 默认」优先于
 * 「txStyles 的通用默认」—— 前者更具体，后者只是该类占位符的兜底。
 */
function resolveTextBase(holder: Holder | undefined): TextStyle {
  if (!holder) return {};
  return mergeTextStyle(holder.levelText ?? {}, holder.text);
}

function applyCommon(
  sh: Shape,
  parts: SpParts,
  fill: FillResult | undefined,
  stroke: { color?: string; width?: number } | undefined,
): void {
  if (parts.name) sh.name = parts.name;
  if (parts.id !== undefined) sh.id = parts.id;
  if (fill?.color) sh.fill = fill.color;
  if (fill?.opacity !== undefined && fill.opacity < 1) sh.opacity = fill.opacity;
  if (stroke?.color) sh.stroke = stroke.color;
  if (stroke?.width !== undefined && stroke.width > 0) sh.strokeWidth = stroke.width;
  if (parts.prst) {
    const r = radiusFromPreset(parts.prst, sh.w, sh.h);
    if (r !== undefined && r > 0) sh.radius = r;
  }
}

/* ------------------------------------------------------------------ */
/* layout / master 的占位符收集                                        */
/* ------------------------------------------------------------------ */

/**
 * 解析 layout / master 的 `p:spTree`，把其中的 `p:sp` 当作**占位符定义**收进 holders。
 *
 * 这些形状不进文档模型（缩略图渲染不到母版形状），但仍要走完整的属性收集，
 * 才能拿到占位符几何、填充与默认字号。
 *
 * **关键：版式只覆盖它真的写了的字段。**
 * 真实文件里版式的占位符常常只有 `p:nvPr/p:ph` 和空的 `p:spPr`（几何留白继承母版），
 * 早期版本直接 `holders.set(key, holder)` 整体替换，于是母版里拿到的
 * 「标题在 (66,28.75) 828×104pt」被一片 0×0 覆盖，slide 上不写 xfrm 的标题
 * 会被判成「找不到占位符几何」而整块丢掉 —— 页面看起来就是「标题不见了」。
 */
export function collectHolders(
  p: XmlPullParser,
  tree: XmlEvent,
  ctx: ShapeCtx,
  holders: Map<string, Holder>,
  txStyleFor: (phType: string | undefined) => TextStyle | undefined,
): void {
  eachChild(p, tree, (child) => {
    if (child.local !== 'sp') return false;
    if (child.selfClosing) return false;
    const parts = collectParts(p, child, ctx.theme);
    if (parts.phType === undefined && parts.phIdx === undefined && parts.xfrmEl === undefined) return true;
    const holder = buildHolder(parts, ctx, txStyleFor(parts.phType));
    if (!holder) return true;
    const keys: string[] = [];
    if (parts.phType) keys.push(parts.phType);
    if (parts.phIdx !== undefined) {
      keys.push(`#${parts.phIdx}`);
      if (parts.phType) keys.push(`${parts.phType}#${parts.phIdx}`);
    }
    for (const key of keys) holders.set(key, mergeHolder(holders.get(key), holder));
    return true;
  });
}

/**
 * 把「更具体的层」（版式）合并到「更基础的层」（母版）之上。
 * 未定义的字段保留基础层的值 —— 这就是继承链的落地方式。
 */
function mergeHolder(base: Holder | undefined, over: Holder): Holder {
  if (!base) return over;
  return {
    xfrm: over.xfrm.present ? over.xfrm : base.xfrm,
    hasFill: over.hasFill || base.hasFill,
    fill: over.fill ?? base.fill,
    hasStroke: over.hasStroke || base.hasStroke,
    stroke: over.stroke ?? base.stroke,
    strokeWidth: over.strokeWidth ?? base.strokeWidth,
    text: mergeTextStyle(base.text, over.text),
    levelText: over.levelText ?? base.levelText,
  };
}

function buildHolder(parts: SpParts, ctx: ShapeCtx, levelText: TextStyle | undefined): Holder | undefined {
  const xfrm = xfrmFrom(parts.xfrmEl, parts.xfrm);
  const fill = parts.fill && !parts.fill.noFill ? fillFromParts(ctx, parts.fill) : undefined;
  const stroke = resolveStroke(ctx, parts, undefined);
  let text: TextStyle = {};
  if (parts.txBody) {
    // 占位符 txBody 里通常是空的 a:p，其 pPr/defRPr 就是该占位符的默认样式
    text = readBodyDefaults(parts.txBody, makeTextContext(ctx.theme, () => undefined, {}, 1, ctx.fonts));
  }
  return {
    xfrm,
    hasFill: parts.fill !== undefined && !parts.fill.noFill,
    fill: fill?.color,
    hasStroke: stroke !== undefined,
    stroke: stroke?.color,
    strokeWidth: stroke?.width,
    text,
    levelText,
  };
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 进入一个「可重放工厂」指向的元素，返回停在它 start 上的解析器。 */
function beginAt(factory: ParserFactory): { p: XmlPullParser; e: XmlEvent } {
  const p = factory();
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') return { p, e };
  }
  return { p, e: { type: 'start', name: '', local: '', prefix: '', attrs: null, selfClosing: true, text: '' } };
}
