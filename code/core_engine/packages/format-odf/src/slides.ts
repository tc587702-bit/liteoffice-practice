/**
 * ODF 演示 / 图形（odp/otp/odg/fodp）解析：`office:presentation` / `office:drawing` -> UDM `slides`。
 *
 * 与只认 `office:presentation` 的实现不同，这里把两个根一并处理：
 * `.odg` 的根是 `office:drawing`，内容与 odp 完全同构（都是 `draw:page`），
 * 因此 UDM 里也落成 slides —— 一张画页就是一张「幻灯片」。
 * 这样 odg 白拿全部演示视图能力，不必为图形再写一套渲染器。
 *
 * 三类形状来源（都要支持，否则一眼就看出漏内容）：
 *   1) `draw:frame`   —— 位置+尺寸+旋转的容器，内含 draw:image / draw:text-box / 几何体
 *   2) 裸几何体       —— draw:rect / ellipse / circle / line / connector / custom-shape
 *                        可以直接挂在 draw:page 或 draw:g 下（LibreOffice 的流程图常这样）
 *   3) `draw:g`       —— 组合，递归成 Shape.shapes
 */
import type { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import type { Block, InlineImage, ParaStyle, Run, Shape, ShapeKind, Slide } from '../../core/src/index.ts';
import { parseTransformRotate, parseTransformScale, ptFrom, ptOrUndefined } from './geometry.ts';
import { attr, attrInt, isExternalHref, mimeFromPath, parseColor, resolvePartPath } from './xmlUtil.ts';
import { resolvePageLayout, resolvePara } from './styles.ts';
import { markTruncated, registerImage, warn } from './types.ts';
import type { OdContext, OdPageLayout, OdStyleDef } from './types.ts';
import { parseInline, parseTable, toRunStyle } from './content.ts';

/** ODF 默认画布：10in × 7.5in（4:3 旧版演示的默认值，也是 odg 的常见默认） */
export const DEFAULT_SLIDE_WIDTH_PT = 720;
export const DEFAULT_SLIDE_HEIGHT_PT = 540;

export interface SlidesParseTarget {
  slides: Slide[];
}

/**
 * 解析 `office:presentation` / `office:drawing`。
 * @param defaultLayout reader 预先解析出的页面尺寸（automatic-styles 的 page-layout）
 */
export function parseSlidesBody(
  p: XmlPullParser,
  ctx: OdContext,
  out: SlidesParseTarget,
  defaultLayout: OdPageLayout,
): void {
  let index = 0;
  let reachedEnd = false;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') {
      reachedEnd = true;
      break;
    }
    if (e.type !== 'start') continue;
    if (e.local === 'page') {
      if (out.slides.length >= ctx.limits.maxSlides) {
        markTruncated(ctx, 'maxSlides', `幻灯片数达到上限 ${ctx.limits.maxSlides}，其余已忽略`);
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      out.slides.push(parsePage(p, e, ctx, defaultLayout, index++));
      continue;
    }
    if (!e.selfClosing) p.skipElement();
  }
  if (!reachedEnd) {
    // 拉取解析器在文档中途耗尽时返回 null 而不抛错，必须显式记账
    markTruncated(ctx, 'content', 'content.xml 在页列表中途结束（文件被截断或损坏），已显示已解析的部分');
  }
}

function parsePage(
  p: XmlPullParser,
  e: XmlEvent,
  ctx: OdContext,
  defaultLayout: OdPageLayout,
  index: number,
): Slide {
  const masterName = attr(e, 'master-page-name');
  const layoutName = attr(e, 'style-name') ?? masterName;
  // 尺寸优先级：draw:page 的 master-page -> page-layout -> content.xml 的第一个 page-layout
  const layout = layoutFor(ctx, masterName) ?? defaultLayout;
  const slide: Slide = {
    index,
    width: layout.widthPt && layout.widthPt > 0 ? layout.widthPt : DEFAULT_SLIDE_WIDTH_PT,
    height: layout.heightPt && layout.heightPt > 0 ? layout.heightPt : DEFAULT_SLIDE_HEIGHT_PT,
    shapes: [],
  };
  if (layoutName) slide.layout = layoutName;
  if (layout.margin === undefined) {
    // 演示文稿的页边距对渲染没有意义（形状是绝对定位的），不写入模型
  }

  if (e.selfClosing) return slide;
  let c: XmlEvent | null;
  while ((c = p.next()) !== null) {
    if (c.type === 'end') break;
    if (c.type !== 'start') continue;
    if (c.local === 'notes') {
      slide.notes = readNotes(p, c, ctx);
      continue;
    }
    const shape = parseShape(p, c, ctx, 0, 0);
    if (shape) slide.shapes.push(shape);
    else if (!c.selfClosing) p.skipElement();
  }
  return slide;
}

/** 通过 master-page -> page-layout 链取页面尺寸。 */
function layoutFor(ctx: OdContext, masterName: string | undefined): OdPageLayout | undefined {
  if (!masterName) return undefined;
  const master = ctx.styles.masterPages.get(masterName);
  const layoutName = master?.pageLayoutName;
  if (!layoutName) return undefined;
  const layout = resolvePageLayout(ctx.styles, layoutName);
  return layout.widthPt || layout.heightPt ? layout : undefined;
}

/* ==================================================================== */
/* 备注页                                                                */
/* ==================================================================== */

function readNotes(p: XmlPullParser, notes: XmlEvent, ctx: OdContext): string | undefined {
  if (notes.selfClosing) return undefined;
  const parts: string[] = [];
  let depth = 0;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') {
      // 与 parseShapeChildren 同理：备注框（draw:frame/draw:text-box）是下钻处理的，
      // 不做深度计数就会把 presentation:notes 的结束标签提前吃掉，
      // 于是后面的形状/页全部丢失。
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (e.type !== 'start') continue;
    if (e.local === 'p' || e.local === 'h') {
      const text = readPlainText(p, e);
      if (text.trim()) parts.push(text.trim());
      continue;
    }
    // 容器继续下钻（备注文本常在 draw:frame -> draw:text-box 里）
    if (!e.selfClosing) depth++;
  }
  void ctx;
  return parts.join('\n').trim() || undefined;
}

/** 读一个元素的纯文本（含 text:s / text:tab / text:line-break）。 */
function readPlainText(p: XmlPullParser, start: XmlEvent): string {
  if (start.selfClosing) return '';
  let acc = '';
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type === 'text' || e.type === 'cdata') {
      acc += e.text;
      continue;
    }
    if (e.type !== 'start') continue;
    if (e.local === 's') {
      acc += ' '.repeat(Math.max(1, Math.min(attrInt(e, 'c', 1), 4096)));
      continue;
    }
    if (e.local === 'tab') {
      acc += '\t';
      continue;
    }
    if (e.local === 'line-break') {
      acc += '\n';
      continue;
    }
    if (!e.selfClosing && e.local !== 'span' && e.local !== 'a') p.skipElement();
  }
  return acc;
}

/* ==================================================================== */
/* 形状                                                                  */
/* ==================================================================== */

const GEOMETRY_KIND: Record<string, ShapeKind> = {
  frame: 'text',
  rect: 'rect',
  ellipse: 'ellipse',
  circle: 'ellipse',
  line: 'line',
  connector: 'line',
  polyline: 'line',
  polygon: 'path',
  path: 'path',
  'custom-shape': 'path',
  measure: 'line',
  caption: 'text',
  'text-box': 'text',
  g: 'group',
};

/**
 * 解析一个形状（`draw:frame` / 几何体 / `draw:g`）。
 *
 * @param ox oy 组合内形状的父级偏移。ODF 里 `draw:g` 的子形状坐标是**相对组合**的，
 *             不累加父偏移会让整组图形挤在左上角（这是最常见的 odp 还原错误）。
 */
export function parseShape(p: XmlPullParser, e: XmlEvent, ctx: OdContext, ox: number, oy: number): Shape | undefined {
  const local = e.local;
  const baseKind = GEOMETRY_KIND[local];
  if (!baseKind) return undefined;
  if (!ctx.guard.probe('maxShapes')) {
    markTruncated(ctx, 'maxShapes', `形状数达到上限 ${ctx.limits.maxShapes}，其余已忽略`);
    return undefined;
  }

  const styleName = attr(e, 'style-name');
  const def = styleName
    ? ctx.styles.defs.get(`graphic\u0000${styleName}`) ?? ctx.styles.defs.get(styleName)
    : undefined;

  const shape: Shape = {
    kind: baseKind,
    x: ox + ptFrom(attr(e, 'x'), 0),
    y: oy + ptFrom(attr(e, 'y'), 0),
    w: ptFrom(attr(e, 'width'), 0),
    h: ptFrom(attr(e, 'height'), 0),
  };
  const name = attr(e, 'name');
  if (name) shape.name = name;
  const id = attr(e, 'id');
  if (id) shape.id = id;

  // draw:transform：不解析旋转，旋转的形状会全部正交摆放，一眼看出是错的
  const transform = attr(e, 'transform');
  const rotate = parseTransformRotate(transform);
  if (rotate !== undefined) shape.rot = rotate;
  const scale = parseTransformScale(transform);
  if (scale) {
    if (scale.sx < 0) shape.flipH = true;
    if (scale.sy < 0) shape.flipV = true;
  }
  if (attr(e, 'mirror-horizontal') === 'true') shape.flipH = true;
  if (attr(e, 'mirror-vertical') === 'true') shape.flipV = true;

  applyShapeStyle(shape, e, def);

  // draw:line / connector：模型里 line 也用 x/y/w/h，因此用端点算包围盒，
  // 否则渲染器只能画出一条零长度的线。
  if (local === 'line' || local === 'connector' || local === 'polyline') {
    const x1 = ptOrUndefined(attr(e, 'x1'));
    const y1 = ptOrUndefined(attr(e, 'y1'));
    const x2 = ptOrUndefined(attr(e, 'x2'));
    const y2 = ptOrUndefined(attr(e, 'y2'));
    if (x1 !== undefined && x2 !== undefined) {
      shape.x = ox + Math.min(x1, x2);
      shape.w = Math.abs(x2 - x1);
    }
    if (y1 !== undefined && y2 !== undefined) {
      shape.y = oy + Math.min(y1, y2);
      shape.h = Math.abs(y2 - y1);
    }
  }

  if (baseKind === 'group') {
    shape.shapes = [];
    if (!e.selfClosing) {
      let c: XmlEvent | null;
      while ((c = p.next()) !== null) {
        if (c.type === 'end') break;
        if (c.type !== 'start') continue;
        const child = parseShape(p, c, ctx, shape.x, shape.y);
        if (child) shape.shapes.push(child);
        else if (!c.selfClosing) p.skipElement();
      }
    }
    if (shape.shapes.length === 0) shape.empty = true;
    return shape;
  }

  const blocks: Block[] = [];
  parseShapeChildren(p, e, ctx, shape, blocks);
  if (blocks.length) shape.blocks = blocks;
  // 只有一个空段落且没有图片时，标记为空占位符（渲染器可据此画虚线框）
  if (!shape.image && !blocks.length && (baseKind === 'text' || baseKind === 'rect')) shape.empty = true;
  return shape;
}

/** 填充 / 描边 / 透明度：元素自身的属性优先，其次样式里的 graphic-properties。 */
function applyShapeStyle(shape: Shape, e: XmlEvent, def: OdStyleDef | undefined): void {
  const fillMode = attr(e, 'fill');
  const fill = parseColor(attr(e, 'fill-color'));
  if (fillMode !== 'none') {
    if (fill) shape.fill = fill;
    else if (def?.fill) shape.fill = def.fill;
  }

  const strokeMode = attr(e, 'stroke');
  if (strokeMode === 'none') shape.stroke = 'none';
  else {
    const sc = parseColor(attr(e, 'stroke-color'));
    if (sc) shape.stroke = sc;
    else if (def?.stroke) shape.stroke = def.stroke;
  }

  const sw = ptOrUndefined(attr(e, 'stroke-width'));
  if (sw !== undefined) shape.strokeWidth = sw;
  else if (def?.strokeWidthPt !== undefined) shape.strokeWidth = def.strokeWidthPt;

  const opacity = attr(e, 'opacity');
  if (opacity !== undefined) {
    const n = Number.parseFloat(opacity);
    if (Number.isFinite(n)) shape.opacity = n >= 0 && n <= 1 ? n : Math.min(1, Math.max(0, n / 100));
  } else if (def?.opacity !== undefined) {
    shape.opacity = def.opacity;
  }

  // 圆角：draw:corner-radius 只对矩形有意义
  const radius = ptOrUndefined(attr(e, 'corner-radius'));
  if (radius !== undefined && radius > 0) shape.radius = radius;

  // 文本锚点：draw:textarea-vertical-align
  const anchor = attr(e, 'textarea-vertical-align');
  if (anchor === 'top' || anchor === 'middle' || anchor === 'bottom') shape.anchor = anchor;
}

/**
 * 遍历形状子树，抽出图片、文本块与嵌套形状。
 *
 * **必须做深度计数**：调用方把 start 事件交给我们，我们要消费到**它自己的** end 为止。
 * 早期版本遇到第一个 end 就返回，而 `draw:text-box` / `text-list` 这类容器是下钻处理的，
 * 于是 text-box 的 `</draw:text-box>` 被当成 frame 的结束标签，紧接着 frame 真正的
 * `</draw:frame>` 就落到调用方头上 —— 调用方以为整个 frame 结束了，
 * 结果同一页里后面的形状、甚至后面的页全部被漏掉（一个 4 形状的页只解析出 1 个）。
 */
function parseShapeChildren(p: XmlPullParser, start: XmlEvent, ctx: OdContext, shape: Shape, blocks: Block[]): void {
  if (start.selfClosing) return;
  let depth = 0;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') {
      if (depth === 0) return;
      depth--;
      continue;
    }
    if (e.type !== 'start') continue;

    switch (e.local) {
      case 'image': {
        const img = shapeImage(e, ctx, shape);
        if (img) {
          shape.image = img;
          // 有图的 frame 在 UDM 里就是 image 形状（渲染器据此走图片路径）
          if (shape.kind === 'text') shape.kind = 'image';
        }
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      case 'p':
      case 'h': {
        const para = buildParagraph(p, e, ctx);
        if (para) blocks.push(para);
        continue;
      }
      case 'table': {
        parseTable(p, e, ctx, { blocks });
        continue;
      }
      case 'frame':
      case 'g': {
        // 形状里嵌套的形状（少见但合法）：作为子形状而不是文本
        const nested = parseShape(p, e, ctx, shape.x, shape.y);
        if (nested) {
          shape.shapes ??= [];
          shape.shapes.push(nested);
        }
        continue;
      }
      default:
        // 容器或未知元素：下钻一拍（里面可能藏着 text:p）。
        // 用 depth 记住「还有一层没关」，避免把外层 frame 的 end 吃掉。
        if (!e.selfClosing) depth++;
        continue;
    }
  }
}

function buildParagraph(p: XmlPullParser, e: XmlEvent, ctx: OdContext): Block | undefined {
  const styleName = attr(e, 'style-name');
  const resolved = resolvePara(ctx.styles, styleName);
  const runs: Run[] = [];
  if (!e.selfClosing) parseInline(p, ctx, runs, toRunStyle(resolved.run ?? {}));
  if (runs.length === 0) return undefined;
  const style: ParaStyle = {};
  if (styleName) style.styleName = styleName;
  if (resolved.align) style.align = resolved.align;
  if (resolved.outlineLevel !== undefined) style.outlineLevel = resolved.outlineLevel;
  if (resolved.spaceBeforePt !== undefined) style.spaceBefore = resolved.spaceBeforePt;
  if (resolved.spaceAfterPt !== undefined) style.spaceAfter = resolved.spaceAfterPt;
  return { kind: 'para', runs, style };
}

/**
 * `draw:image` -> InlineImage。
 *
 * 显示尺寸取**外层 draw:frame 的尺寸**而不是图片自身的像素尺寸 ——
 * 用户缩放的是 frame。image 元素自己也可能带 svg:width/height，
 * 仅在 frame 没给尺寸时兜底。
 */
function shapeImage(e: XmlEvent, ctx: OdContext, frame: Shape): InlineImage | undefined {
  const href = attr(e, 'href');
  if (!href) {
    warn(ctx, 'draw:image 缺少 xlink:href，已跳过');
    return undefined;
  }
  if (isExternalHref(href)) {
    // 外部 URL：只保留提示，绝不联网加载（离线优先 + 解析期不做网络请求）
    warn(ctx, `图片为外部链接（${href}），已跳过加载`);
    return { mime: 'image/*', width: frame.w, height: frame.h, alt: href };
  }
  const part = resolvePartPath(href);
  const cached = ctx.images.get(part);
  const w = frame.w > 0 ? frame.w : ptFrom(attr(e, 'width'), 0);
  const h = frame.h > 0 ? frame.h : ptFrom(attr(e, 'height'), 0);
  const img: InlineImage = {
    mime: cached?.mime ?? mimeFromPath(part),
    width: w,
    height: h,
    partPath: part,
  };
  // 两遍法：这里只登记路径，字节由 reader 统一按 limits 加载
  registerImage(ctx, img, part);
  return img;
}

/**
 * 尺寸兜底：一点尺寸都没有的形状给一个最小可点击框。
 * 缺了它，一个没有 svg:width 的文本框在渲染时会变成 0×0 的不可见元素，
 * 用户会以为内容丢了。
 */
export function ensureShapeSize(shape: Shape): void {
  if (shape.w <= 0) shape.w = shape.kind === 'image' ? 96 : 144;
  if (shape.h <= 0) shape.h = shape.kind === 'image' ? 96 : 24;
  if (shape.shapes) for (const c of shape.shapes) ensureShapeSize(c);
}
