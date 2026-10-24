/**
 * 形状几何：xfrm 解析、prstGeom -> ShapeKind 映射、组合形状的坐标变换。
 *
 * 单位说明（pptx 最容易搞错的部分之一）：
 *   `a:off x/y` 与 `a:ext cx/cy` 全是 EMU（1pt = 12700 EMU）
 *   `a:xfrm rot` 是 1/60000 度，且是**属性**而不是子元素
 *   `a:chOff`/`a:chExt` 也是 EMU，但描述的是**子坐标系**矩形
 * 三者都在这里换算成 pt / 度，绝不让 EMU 漏进 UDM。
 */
import { attr } from '../../ooxml/src/xmlUtil.ts';
import type { ShapeKind } from '../../core/src/model.ts';
import { emuToPt, num, rotToDegrees } from './units.ts';
import type { XmlEvent } from '../../xml/src/index.ts';

/** `a:xfrm` 的子元素（rot/flip 是属性，不在这里）。 */
export interface XfrmChildren {
  off?: XmlEvent;
  ext?: XmlEvent;
  chOff?: XmlEvent;
  chExt?: XmlEvent;
}

/** 已经换算成 pt 的变换（只含缩放+平移，不处理旋转，见 readGroup 的注释）。 */
export interface Xfrm {
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
  /** 是否真的存在 xfrm（缺失时调用方需要走占位符继承） */
  present: boolean;
}

export const IDENTITY_XFRM: Xfrm = { x: 0, y: 0, w: 0, h: 0, present: false };

/** 组合形状的子坐标系映射。 */
export interface GroupMap {
  /** child coord -> parent coord：parent = scale * child + offset */
  scale: number;
  offX: number;
  offY: number;
  /** 组合链累计的缩放，用于估算组内文字的字号（PowerPoint 会按比例缩放组内文本） */
  fontScale: number;
}

export const IDENTITY_MAP: GroupMap = { scale: 1, offX: 0, offY: 0, fontScale: 1 };

/** `a:off` + `a:ext` -> pt。 */
export function readOffExt(off: XmlEvent | undefined, ext: XmlEvent | undefined): { x: number; y: number; w: number; h: number } {
  return {
    x: off ? emuToPt(num(attr(off, 'x'))) : 0,
    y: off ? emuToPt(num(attr(off, 'y'))) : 0,
    w: ext ? emuToPt(num(attr(ext, 'cx'))) : 0,
    h: ext ? emuToPt(num(attr(ext, 'cy'))) : 0,
  };
}

/**
 * 解析 `a:xfrm`。
 *
 * 两个容易写错的地方：
 *   - `rot`/`flipH`/`flipV` 是 **xfrm 元素的属性**，不是子元素，所以不能只在
 *     子元素表里找（早期版本只扫子元素，导致旋转永远是 0）。
 *   - `rot` 的单位是 1/60000 度，且只在非零时才写进模型，
 *     这样「没旋转」和「旋转 0 度」在 UDM 里不会混为一谈。
 */
export function xfrmFrom(e: XmlEvent | undefined, children: XfrmChildren): Xfrm {
  if (!e) return IDENTITY_XFRM;
  const box = readOffExt(children.off, children.ext);
  const out: Xfrm = { ...box, present: true };
  const rot = attr(e, 'rot');
  if (rot !== undefined) {
    const deg = rotToDegrees(num(rot));
    if (deg !== 0) out.rot = deg;
  }
  const flipH = attr(e, 'flipH');
  if (flipH !== undefined && flipH !== '0' && flipH !== 'false') out.flipH = true;
  const flipV = attr(e, 'flipV');
  if (flipV !== undefined && flipV !== '0' && flipV !== 'false') out.flipV = true;
  return out;
}

/**
 * 计算组合形状的坐标映射。
 *
 * 规则（DrawingML）：子形状坐标定义在子坐标系里，该坐标系由 `a:chOff`/`a:chExt`
 * 描述，并被拉伸到组合自身的 `a:off`/`a:ext`：
 *     parent = (child - chOff) * (ext / chExt) + off
 *
 * 限制（诚实说明，不粉饰）：这里假设 `sx == sy`，用它们的平均值作为统一 scale。
 * 真实文件里组合极少出现各向异性缩放，且非等比缩放会连带影响组内文字与线宽，
 * 要正确处理需要引入完整的变换矩阵体系。旋转则是**完全不组合**的：
 * 组内形状保留自身 rot，组合的 rot 被丢弃（只记 warning），
 * 因为 UDM 的 Shape 没有变换矩阵，无法表达「绕组合中心旋转」。
 */
export function groupMap(children: XfrmChildren, group: Xfrm, warn: (m: string) => void): GroupMap {
  const { chOff, chExt } = children;
  if (!chOff || !chExt) {
    // 没有子坐标系声明：退化为纯平移
    return { scale: 1, offX: group.x, offY: group.y, fontScale: 1 };
  }
  const cox = emuToPt(num(attr(chOff, 'x')));
  const coy = emuToPt(num(attr(chOff, 'y')));
  const cex = emuToPt(num(attr(chExt, 'cx')));
  const cey = emuToPt(num(attr(chExt, 'cy')));
  if (cex <= 0 || cey <= 0) {
    warn('组合形状的 a:chExt 非法（<=0），子形状坐标按纯平移处理');
    return { scale: 1, offX: group.x - cox, offY: group.y - coy, fontScale: 1 };
  }
  const sx = group.w / cex;
  const sy = group.h / cey;
  const scale = (sx + sy) / 2;
  return {
    scale,
    offX: group.x - cox * scale,
    offY: group.y - coy * scale,
    fontScale: scale,
  };
}

/** 把组合内子形状的 xfrm 映射到父坐标系。 */
export function transformShapeXfrm(sh: Xfrm, map: GroupMap): Xfrm {
  if (map.scale === 1 && map.offX === 0 && map.offY === 0) return sh;
  const out: Xfrm = {
    x: sh.x * map.scale + map.offX,
    y: sh.y * map.scale + map.offY,
    w: sh.w * map.scale,
    h: sh.h * map.scale,
    present: sh.present,
  };
  if (sh.rot !== undefined) out.rot = sh.rot;
  if (sh.flipH) out.flipH = true;
  if (sh.flipV) out.flipV = true;
  return out;
}

export function combineMaps(outer: GroupMap, inner: GroupMap): GroupMap {
  return {
    scale: outer.scale * inner.scale,
    offX: inner.offX * outer.scale + outer.offX,
    offY: inner.offY * outer.scale + outer.offY,
    fontScale: outer.fontScale * inner.fontScale,
  };
}

/* --------------------------- 形状类型映射 --------------------------- */

/**
 * `a:prstGeom prst` -> UDM ShapeKind。
 *
 * UDM 只有 8 种 kind，而 DrawingML 有 180+ 种预设几何。映射策略是
 * 「按视觉大类归并」：圆角/尖角/箭头/流程图全都落到 rect 或 ellipse，
 * 靠 `radius` 保留圆角的差别。不认识的 prst 落回 rect —— 丢一个形状的
 * 精确外形可以接受，丢整个形状不行。
 */
const LINE_PRESETS = new Set([
  'line',
  'straightConnector1',
  'bentConnector2',
  'bentConnector3',
  'bentConnector4',
  'bentConnector5',
  'curvedConnector2',
  'curvedConnector3',
  'curvedConnector4',
  'curvedConnector5',
]);

const ELLIPSE_PRESETS = new Set(['ellipse', 'oval', 'circle', 'donut', 'blockArc', 'flowChartConnector']);
const ROUND_PRESETS = new Set([
  'roundRect',
  'round1Rect',
  'round2SameRect',
  'round2DiagRect',
  'roundSingleCorner',
  'flowChartAlternateProcess',
  'flowChartDelay',
]);
const TEXT_PRESETS = new Set(['textBox', 'txBox']);

export function kindFromPreset(prst: string | undefined): ShapeKind | undefined {
  if (!prst) return undefined;
  if (TEXT_PRESETS.has(prst)) return 'text';
  if (LINE_PRESETS.has(prst)) return 'line';
  if (ELLIPSE_PRESETS.has(prst)) return 'ellipse';
  // 其余（含 rect、圆角矩形、箭头、星形、流程图…）统一视作矩形：
  // 外形不精确，但位置/文字/颜色都保住了
  return 'rect';
}

/** `roundRect` 的默认圆角半径（pt，按形状短边的比例估）。 */
export function radiusFromPreset(prst: string | undefined, w: number, h: number): number | undefined {
  if (!prst || !ROUND_PRESETS.has(prst)) return undefined;
  const short = Math.max(0, Math.min(w, h));
  return short * 0.16667;
}
