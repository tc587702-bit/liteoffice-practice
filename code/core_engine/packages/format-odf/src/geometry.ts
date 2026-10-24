/**
 * ODF 图形几何辅助：长度取值、draw:transform 解析。
 *
 * ODF 的图形坐标（svg:x / svg:y / svg:width / svg:height / svg:stroke-width）
 * 全部是**带单位后缀**的字符串（`1.5cm` / `0.5in` / `12pt`），
 * 因此一律走 cssLengthToPt 统一到 pt（模型内只有 pt）。
 * 直接 Number.parseFloat("1.5cm") 会得到 1.5 —— 看起来能用，实际把所有
 * 以 cm 表述的尺寸缩小了 28 倍，这是 ODF 读取里最容易悄悄错掉的地方。
 */
import { cssLengthToPt } from '../../core/src/units.ts';

/** 取一个长度属性并转 pt；缺失/非法时返回 fallback。 */
export function ptFrom(value: string | undefined, fallback = 0): number {
  if (value === undefined || value === '') return fallback;
  const pt = cssLengthToPt(value, NaN);
  return Number.isFinite(pt) ? pt : fallback;
}

/** 取一个长度属性并转 pt，缺失时返回 undefined（用于「有没有给」的判断）。 */
export function ptOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const pt = cssLengthToPt(value, NaN);
  return Number.isFinite(pt) ? pt : undefined;
}

/**
 * 解析 `draw:transform` 里的旋转角（度）。
 *
 * ODF 允许多种写法：
 *   `rotate (90)`                       —— 最常见
 *   `translate(1cm, 2cm) rotate(30)`    —— 组合，按顺序
 *   `matrix(0 1 -1 0 0 0)`              —— 等价于旋转 90°
 *   `scale(1 -1)`                       —— 翻转
 * 模型的 Shape.rot 只承载旋转，因此这里只抽 rotate()，矩阵形式按 atan2 反推。
 * 抽不到就返回 undefined（而不是 0）—— 0 会让「未知」和「不旋转」无法区分。
 */
export function parseTransformRotate(transform: string | undefined): number | undefined {
  if (!transform) return undefined;
  const rotate = /rotate\s*\(\s*(-?[\d.]+)(?:\s*[,\s]\s*(-?[\d.]+))?\s*\)/i.exec(transform);
  if (rotate) {
    const deg = Number.parseFloat(rotate[1]);
    if (Number.isFinite(deg)) return deg;
  }
  const matrix = /matrix\s*\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)/i.exec(transform);
  if (matrix) {
    const a = Number.parseFloat(matrix[1]);
    const b = Number.parseFloat(matrix[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && (a !== 1 || b !== 0)) {
      return (Math.atan2(b, a) * 180) / Math.PI;
    }
  }
  return undefined;
}

/** 解析 `scale(sx sy)`，用于翻转判断。返回 undefined 表示没有缩放。 */
export function parseTransformScale(transform: string | undefined): { sx: number; sy: number } | undefined {
  if (!transform) return undefined;
  const m = /scale\s*\(\s*(-?[\d.]+)(?:\s*[,\s]\s*(-?[\d.]+))?\s*\)/i.exec(transform);
  if (!m) return undefined;
  const sx = Number.parseFloat(m[1]);
  const sy = m[2] !== undefined ? Number.parseFloat(m[2]) : sx;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return undefined;
  return { sx, sy };
}

/** 保留旧名，避免调用方为了一个单位换算而 import units。 */
export function inchesToPtSafe(inches: number): number {
  return cssLengthToPt(`${inches}in`, 0);
}
