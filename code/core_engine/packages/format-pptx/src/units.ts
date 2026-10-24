/**
 * pptx 侧的单位换算。
 *
 * UDM 的硬约定是「模型内一切长度都是 pt」（docs/CONVENTIONS.md §4），
 * 而 DrawingML 里长度几乎全是 EMU、字号是 **1/100 pt**、角度是 1/60000 度。
 * 这三个换算只在读取边界做一次，漏掉任何一个都会得到「大了 100 倍」或
 * 「旋转了 1000 圈」这类看着像渲染器 bug 的错，所以集中在这里并加测试。
 */
import { EMU_PER_PT, emuToPt } from '../../core/src/units.ts';

export { emuToPt, EMU_PER_PT };

/** DrawingML 的角度单位是 1/60000 度（不是弧度，也不是 1/100 度）。 */
export const ROT_PER_DEGREE = 60000;

/** `a:xfrm rot="5400000"` -> 90（度）。 */
export function rotToDegrees(rot: number): number {
  return rot / ROT_PER_DEGREE;
}

/**
 * `a:rPr sz="1800"` -> 18（pt）。
 *
 * 这是 pptx 与 docx 最容易混淆的地方：docx 的 `w:sz` 是**半磅**（21 -> 10.5pt），
 * 而 pptx 的 `a:sz` 是**1/100 磅**（1800 -> 18pt）。差 50 倍。
 * 早期若误用 halfPtToPt，幻灯片上的字会全部小一半，且「大标题」看起来像正文。
 */
export function hundredthPtToPt(v: number): number {
  return v / 100;
}

/** 属性里的数字；非有限值返回 fallback，避免 NaN 污染布局。 */
export function num(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * OOXML 的百分比属性（`val="50000"` 表示 50%）。返回倍率。
 */
export function pct(v: string | undefined, fallback = 0): number {
  const n = num(v, NaN);
  return Number.isFinite(n) ? n / 100000 : fallback;
}
