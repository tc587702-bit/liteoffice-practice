/**
 * 长度单位归一。
 *
 * 决策：**整个内核统一用 pt（1/72 英寸）作为布局单位**。
 * 理由：Word 用 twip（1/20 pt）、PowerPoint 用 EMU（1/12700 pt）、
 * PDF 用 pt、Excel 行高用 pt 而列宽用「字符数」、CSS 用 px。
 * 如果模型里混存这些单位，每个渲染器都要各自做换算，必然出现
 * 「同一个 12pt 字号在不同视图里不一样大」的漂移。
 *
 * 因此所有读取器必须在**边界处**换算成 pt，模型内部只有 pt。
 * px 只出现在 DOM 渲染的最后一步。
 */

export const PT_PER_INCH = 72;
/** 浏览器 CSS 参考像素：96 dpi */
export const CSS_DPI = 96;
/** 屏幕像素 -> pt */
export const PX_PER_PT = CSS_DPI / PT_PER_INCH; // 1.3333…
export const TWIP_PER_PT = 20;
export const EMU_PER_PT = 12700;
export const MM_PER_INCH = 25.4;

/** A4 尺寸（pt） */
export const A4_WIDTH_PT = 595.276;
export const A4_HEIGHT_PT = 841.89;
/** US Letter（pt） */
export const LETTER_WIDTH_PT = 612;
export const LETTER_HEIGHT_PT = 792;

export function twipToPt(twip: number): number {
  return twip / TWIP_PER_PT;
}

export function emuToPt(emu: number): number {
  return emu / EMU_PER_PT;
}

/** OOXML 字号是半磅（half-point） */
export function halfPtToPt(half: number): number {
  return half / 2;
}

/** OOXML 边框宽度是 1/8 pt */
export function eighthPtToPt(eighth: number): number {
  return eighth / 8;
}

export function pxToPt(px: number): number {
  return (px * PT_PER_INCH) / CSS_DPI;
}

export function ptToPx(pt: number): number {
  return (pt * CSS_DPI) / PT_PER_INCH;
}

export function ptToTwip(pt: number): number {
  return pt * TWIP_PER_PT;
}

export function ptToEmu(pt: number): number {
  return pt * EMU_PER_PT;
}

export function inchToPt(inch: number): number {
  return inch * PT_PER_INCH;
}

export function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * PT_PER_INCH;
}

export function cmToPt(cm: number): number {
  return mmToPt(cm * 10);
}

/**
 * Excel/ODS 列宽（字符数）-> pt。
 * Excel 的规则是 width = floor(chars * MDW + 5) 像素（Calibri 11 的 MDW=7），
 * 这里取近似：px = chars * 7 + 5。渲染的目的是「比例正确」，不是像素级复刻。
 */
export function excelColWidthToPt(chars: number): number {
  return pxToPt(chars * 7 + 5);
}

/** pt -> 往返的 Excel 字符宽度（用于展示列宽数值） */
export function ptToExcelColWidth(pt: number): number {
  return Math.max(0, (ptToPx(pt) - 5) / 7);
}

/** 把可能带了单位后缀的 CSS 值（"12pt" / "1.5cm" / "10px"）转成 pt。 */
export function cssLengthToPt(value: string | number | undefined, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value;
  const m = /^\s*(-?[\d.]+)\s*([a-z%]*)\s*$/i.exec(value);
  if (!m) return fallback;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return fallback;
  switch (m[2].toLowerCase()) {
    case 'pt':
      return n;
    case 'px':
      return pxToPt(n);
    case 'in':
      return inchToPt(n);
    case 'cm':
      return cmToPt(n);
    case 'mm':
      return mmToPt(n);
    case 'pc':
      return n * 12;
    case 'em':
    case 'rem':
      return n * 12;
    default:
      return n;
  }
}

/** 数值安全收敛，避免 NaN/Infinity 污染布局计算。 */
export function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

/** 限制在 [lo, hi] 内。 */
export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
