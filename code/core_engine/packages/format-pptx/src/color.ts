/**
 * DrawingML 颜色解析。
 *
 * 为什么单独成文件且写得比 docx 那份更啰嗦：
 *   pptx 的颜色语法是**递归+可变换**的：`<a:solidFill><a:schemeClr val="accent1">
 *   <a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr></a:solidFill>`。
 *   Word 那边颜色基本是一个属性值，PowerPoint 这边颜色是一个**小表达式**。
 *   如果只认 `srgbClr`，绝大多数真实 pptx 的形状填充与文字颜色会全部丢失 ——
 *   用户在缩略图上看到的就是一片没上色的方框。
 *
 * 变换实现取舍（诚实说明）：
 *   - `alpha`：完整实现，映射到 `Shape.opacity`（0..1）
 *   - `lumMod`/`lumOff`：在 HSL 亮度通道上近似（与 PowerPoint 的 sRGB 线性化略有差异）
 *   - `shade`/`tint`：按「乘到 0/混合到 1」近似
 *   - 其余（hueMod/satMod/comp/inv/gray/prstShade…）忽略并只记录一次汇总 warning：
 *     这些在真实文件里占比极低，逐个报 warning 反而会淹没真正重要的降级信息。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { attr, parseColor } from '../../ooxml/src/xmlUtil.ts';
import { skipDeep } from './scan.ts';
import type { Theme } from '../../ooxml/src/theme.ts';
import { themeColorAt, DEFAULT_OFFICE_THEME } from '../../ooxml/src/theme.ts';

/* ------------------------------ 预置色 ------------------------------ */

/**
 * DrawingML 预置色名（`<a:prstClr val="red"/>`）。
 * 按 ECMA-376 的 ST_PresetColorVal 覆盖常见项；未收录的名字会被忽略
 * （而不是猜一个颜色 —— 猜错比不着色更难排查）。
 */
const PRESET_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  orange: '#ffa500',
  purple: '#800080',
  brown: '#a52a2a',
  pink: '#ffc0cb',
  lime: '#00ff00',
  navy: '#000080',
  teal: '#008080',
  olive: '#808000',
  maroon: '#800000',
  silver: '#c0c0c0',
  gold: '#ffd700',
  darkred: '#8b0000',
  darkblue: '#00008b',
  darkgreen: '#006400',
  lightblue: '#add8e6',
  lightyellow: '#ffffe0',
  beige: '#f5f5dc',
  ivory: '#fffff0',
  indigo: '#4b0082',
  violet: '#ee82ee',
  tan: '#d2b48c',
  turquoise: '#40e0d0',
  skyblue: '#87ceeb',
  salmon: '#fa8072',
  khaki: '#f0e68c',
  coral: '#ff7f50',
};

/** 系统色（`<a:sysClr val="windowText" lastClr="000000"/>`）：只有 lastClr 是稳定值。 */
const SYS_COLOR_FALLBACK: Record<string, string> = {
  windowtext: '#000000',
  window: '#ffffff',
  scrollbar: '#c8c8c8',
  captiontext: '#000000',
  buttonface: '#f0f0f0',
  graytext: '#808080',
  highlight: '#0078d7',
  highlighttext: '#ffffff',
};

export function presetColor(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return PRESET_COLORS[name.trim().toLowerCase()];
}

/* ------------------------------ 变换 ------------------------------ */

export interface ColorMods {
  /** `<a:alpha val="50000"/>` -> 0.5 */
  alpha?: number;
  /** 亮度相乘（1 表示不变） */
  lumMod?: number;
  /** 亮度相加（-1..1） */
  lumOff?: number;
  /** 变暗（乘到黑） */
  shade?: number;
  /** 变亮（混合到白） */
  tint?: number;
}

export interface ResolvedColor {
  /** CSS 颜色串 */
  color: string;
  /** 透明度 0..1，未指定为 undefined */
  alpha?: number;
  /** 主题槽位名（如 accent1），用于诊断「为什么这个颜色没解析出来」 */
  themeKey?: string;
  /** 颜色上带了本读取器不支持的变换（hueMod/comp/inv…），调用方记一次 warning */
  unsupported?: boolean;
}

/**
 * 解析填充容器（`a:solidFill` / `a:gradFill` / `a:noFill`…）里的颜色。
 *
 * 两种调用方式都支持，因为两种在代码里都会出现：
 *   - 只传 `p`：解析器需**刚产出容器元素的 start 事件**，本函数自己取；
 *   - 传 `e`：调用方已经拿到容器元素的 start 事件（`eachChild` 风格遍历）。
 * 混用这两种约定是这类读取器最常见的 bug 来源：多读一次就会把**下一个兄弟
 * 元素**当成颜色，表现为「颜色丢失」或「颜色串到别的形状上」。
 *
 * `<a:noFill>` 与容器里没有颜色都返回 undefined —— **不要**返回黑色：
 * 「没有填充」和「填成黑色」在幻灯片上完全是两回事。
 */
export function parseFillColor(p: XmlPullParser, theme: Theme, e?: XmlEvent): ResolvedColor | undefined {
  let cur: XmlEvent | null = e ?? p.next();
  while (cur !== null) {
    if (cur.type === 'end') return undefined;
    if (cur.type === 'start') {
      if (cur.local === 'noFill' || cur.local === 'grpFill') return undefined;
      if (cur.local === 'solidFill') {
        if (cur.selfClosing) return undefined;
        // solidFill 是**容器**：颜色是它的子元素，不能把它本身当颜色元素
        return firstColorIn(p, theme, cur);
      }
      // 渐变/图案/图片填充：以整块填充的**首个色标**近似，交给调用方记 warning
      if (cur.local === 'gradFill' || cur.local === 'pattFill' || cur.local === 'blipFill') {
        if (cur.selfClosing) return undefined;
        return firstGradientStopIn(p, theme, cur);
      }
      if (!cur.selfClosing) skipDeep(p, cur);
    }
    cur = p.next();
  }
  return undefined;
}

/**
 * 解析一个**颜色容器**（`a:solidFill` / `a:gradFill` / `a:ln` 的填充部分）里的颜色。
 *
 * 这是最常用的入口：调用方手上只有容器元素，颜色是它的子元素。
 * 注意与 `readColorElement` 的区别 —— 后者要的是**颜色元素本身**
 * （`a:srgbClr` / `a:schemeClr`）。两者混用会得到 undefined，
 * 而且因为不抛错，很容易被当成「这个文件没写颜色」而长期潜伏。
 */
export function parseContainerColor(p: XmlPullParser, container: XmlEvent, theme: Theme): ResolvedColor | undefined {
  return firstColorIn(p, theme, container);
}

/**
 * 在 `a:gradFill` 等复杂填充里找第一个色标的颜色，作为近似。
 * 结构是 `gradFill/gsLst/gs/颜色元素`，这里按层级下钻一层。
 */
function firstGradientStopIn(p: XmlPullParser, theme: Theme, container: XmlEvent): ResolvedColor | undefined {
  let out: ResolvedColor | undefined;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return out;
    if (e.type !== 'start') continue;
    if (e.local === 'gsLst') {
      if (e.selfClosing) continue;
      // gsLst 的子元素是 gs，gs 的子元素才是颜色
      let ge: XmlEvent | null;
      while ((ge = p.next()) !== null) {
        if (ge.type === 'end') break;
        if (ge.type !== 'start') continue;
        if (ge.local === 'gs' && !out) {
          if (ge.selfClosing) continue;
          out = firstColorIn(p, theme, ge);
          continue;
        }
        if (!ge.selfClosing) p.skipElement();
      }
      continue;
    }
    if (!e.selfClosing) p.skipElement();
  }
  return out;
}

/** 在容器元素的直接子元素里找第一个颜色元素。消费容器子树。 */
function firstColorIn(p: XmlPullParser, theme: Theme, container: XmlEvent): ResolvedColor | undefined {
  let out: ResolvedColor | undefined;
  // 自闭合容器（`<a:solidFill/>`）里不可能有颜色：直接返回，且不用消费任何东西
  if (container.selfClosing) return undefined;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return out;
    if (e.type !== 'start') continue;
    // 显式「无填充」是**终态**：它表示「就是不填」，不能再往后找颜色。
    // 漏了这一条会让 `<a:solidFill><a:noFill/></a:solidFill>` 返回 undefined 之外
    // 还可能把后面的兄弟元素误当成颜色读走（解析器位置错位）。
    if (e.local === 'noFill' || e.local === 'grpFill') return undefined;
    if (!out) {
      out = readColorElement(p, e, theme);
      continue;
    }
    if (!e.selfClosing) p.skipElement();
  }
  return out;
}

/**
 * 解析一个「颜色元素」（srgbClr / schemeClr / prstClr / sysClr / scrgbClr / hslClr）
 * 及其子变换。调用前提：p 刚产出该颜色元素的 start 事件。
 *
 * 注意 `a:alpha` 在 `<a:solidFill>` 里是颜色元素的**子节点**（形如
 * `<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill>`），
 * 所以在这里一并读出，而不是当成颜色元素之外的兄弟节点。
 */
export function parseColorChild(p: XmlPullParser, theme: Theme): ResolvedColor | undefined {
  const e = p.next();
  if (!e || e.type !== 'start') return undefined;
  return readColorElement(p, e, theme);
}

/**
 * 读取一个**已经拿到 start 事件**的颜色元素及其子变换。
 *
 * 为什么需要这个变体：`readChildrenDeep` 风格的遍历里，调用方手上已经有
 * `XmlEvent` 了，若再去调 `parseColorChild`（内部会 `p.next()`），
 * 解析器会越过当前元素、把**下一个兄弟元素**当成颜色读 —— 表现为
 * 「颜色全丢」或「颜色串到别的属性上」。这是本读取器早期最隐蔽的一个 bug：
 * 夹具里只有一个颜色元素时它恰好还能工作，一旦有第二个就全错。
 */
export function readColorElement(p: XmlPullParser, e: XmlEvent, theme: Theme): ResolvedColor | undefined {
  const base = baseColorOf(e, theme);
  const selfClosing = e.selfClosing;
  if (!base) {
    if (!selfClosing) p.skipElement();
    return undefined;
  }
  if (selfClosing) return base;

  const mods: ColorMods = {};
  let unsupported = false;
  let ce: XmlEvent | null;
  while ((ce = p.next()) !== null) {
    if (ce.type === 'end') break;
    if (ce.type !== 'start') continue;
    // 注意 lumOff/shade 的 val 可以是负数（例如 lumOff="-20000"），
    // 因此不能用「< 0 即非法」来判定，必须看属性是否存在。
    switch (ce.local) {
      case 'alpha': {
        const v = intAttr(ce);
        if (v !== undefined) mods.alpha = v / 100000;
        break;
      }
      case 'lumMod': {
        const v = intAttr(ce);
        if (v !== undefined) mods.lumMod = v / 100000;
        break;
      }
      case 'lumOff': {
        const v = intAttr(ce);
        if (v !== undefined) mods.lumOff = v / 100000;
        break;
      }
      case 'shade': {
        const v = intAttr(ce);
        if (v !== undefined) mods.shade = v / 100000;
        break;
      }
      case 'tint': {
        const v = intAttr(ce);
        if (v !== undefined) mods.tint = v / 100000;
        break;
      }
      case 'hueMod':
      case 'hueOff':
      case 'satMod':
      case 'satOff':
      case 'comp':
      case 'inv':
      case 'gray':
      case 'gamma':
      case 'invGamma':
      case 'redMod':
      case 'greenMod':
      case 'blueMod':
        unsupported = true;
        break;
      default:
        break;
    }
    if (!ce.selfClosing) p.skipElement();
  }
  const color = applyColorMods(base.color, mods);
  const out: ResolvedColor = { color };
  if (mods.alpha !== undefined) out.alpha = Math.max(0, Math.min(1, mods.alpha));
  if (base.themeKey) out.themeKey = base.themeKey;
  if (unsupported) out.unsupported = true;
  return out;
}

/** 取 val 的整数值；缺失或非数字返回 undefined。 */
function intAttr(e: XmlEvent): number | undefined {
  const raw = attr(e, 'val');
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * DrawingML 的 schemeClr 取值 -> clrScheme 槽位。
 *
 * ooxml 层的 `THEME_ALIAS` 只覆盖了 Word 用的 `text1`/`background1` 那套，
 * **没有** `tx1`/`bg1`/`tx2`/`bg2` —— 而 pptx 里几乎所有的
 * `<a:schemeClr val="tx1"/>`（正文色）与 `bg1`（背景色）都是这四个名字。
 * 不补这一层，真实 pptx 的正文与背景色会整片丢失（退化成「没有颜色」）。
 * 另外 pptx 还多一个 `phClr`（占位符颜色，只在主题填充样式里有意义），
 * 这里映射到 tx1，好过完全不处理。
 */
const SHAPE_THEME_ALIAS: Record<string, string> = {
  tx1: 'dk1',
  tx2: 'dk2',
  bg1: 'lt1',
  bg2: 'lt2',
  phclr: 'dk1',
};

/** 合并 ooxml 的别名与本包补充的 ptx 别名后查主题。 */
export function schemeColorAt(theme: Theme, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.trim();
  return themeColorAt(theme, key) ?? theme.get(SHAPE_THEME_ALIAS[key.toLowerCase()] ?? '');
}

/** 颜色元素本身 -> 基色。 */
function baseColorOf(e: XmlEvent, theme: Theme): ResolvedColor | undefined {
  switch (e.local) {
    case 'srgbClr': {
      const c = parseColor(attr(e, 'val'));
      return c ? { color: c } : undefined;
    }
    case 'schemeClr': {
      const key = attr(e, 'val');
      const c = schemeColorAt(theme, key);
      return c ? { color: c, themeKey: key } : undefined;
    }
    case 'prstClr': {
      const c = presetColor(attr(e, 'val'));
      return c ? { color: c } : undefined;
    }
    case 'sysClr': {
      const c = parseColor(attr(e, 'lastClr')) ?? SYS_COLOR_FALLBACK[(attr(e, 'val') ?? '').toLowerCase()];
      return c ? { color: c } : undefined;
    }
    case 'scrgbClr': {
      // 线性 sRGB 百分比 -> 8 位。gamma 近似用 1/2.2，够用且便宜。
      const r = pctToByte(attr(e, 'r'));
      const g = pctToByte(attr(e, 'g'));
      const b = pctToByte(attr(e, 'b'));
      if (r === undefined || g === undefined || b === undefined) return undefined;
      return { color: `#${hex2(r)}${hex2(g)}${hex2(b)}` };
    }
    case 'hslClr': {
      const hue = Number.parseFloat(attr(e, 'hue') ?? 'NaN') / 60000;
      const sat = Number.parseFloat(attr(e, 'sat') ?? 'NaN') / 100000;
      const lum = Number.parseFloat(attr(e, 'lum') ?? 'NaN') / 100000;
      if (![hue, sat, lum].every((x) => Number.isFinite(x))) return undefined;
      const { r, g, b } = hslToRgb(hue / 360, sat, lum);
      return { color: `#${hex2(r)}${hex2(g)}${hex2(b)}` };
    }
    default:
      return undefined;
  }
}

function pctToByte(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return undefined;
  const linear = Math.min(1, Math.max(0, n / 100000));
  // 线性 -> sRGB 传递函数（近似 2.2 幂）
  return Math.round(Math.pow(linear, 1 / 2.2) * 255);
}

/* ------------------------------ 颜色运算 ------------------------------ */

/** 应用 lumMod/lumOff/shade/tint。全部在 HSL 亮度通道上做近似。 */
export function applyColorMods(hex: string, mods: ColorMods): string {
  if (mods.lumMod === undefined && mods.lumOff === undefined && mods.shade === undefined && mods.tint === undefined) {
    return hex;
  }
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  let l = hsl.l;
  if (mods.lumMod !== undefined) l *= mods.lumMod;
  if (mods.lumOff !== undefined) l += mods.lumOff;
  // shade：整体压向黑；tint：整体混向白
  if (mods.shade !== undefined) l *= mods.shade;
  if (mods.tint !== undefined) l = l + (1 - l) * (1 - mods.tint);
  const out = hslToRgb(hsl.h, hsl.s, Math.min(1, Math.max(0, l)));
  return `#${hex2(out.r)}${hex2(out.g)}${hex2(out.b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const pp = 2 * l - q;
  const hk = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return pp + (q - pp) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return pp + (q - pp) * (2 / 3 - tt) * 6;
    return pp;
  };
  return {
    r: Math.round(hk(h + 1 / 3) * 255),
    g: Math.round(hk(h) * 255),
    b: Math.round(hk(h - 1 / 3) * 255),
  };
}

function hex2(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
}

/** 主题缺失时的兜底：用 Office 默认主题，好过整篇无色。 */
export function themeOrDefault(theme: Theme | undefined): Theme {
  return theme && theme.size > 0 ? theme : DEFAULT_OFFICE_THEME;
}
