/**
 * A1 引用解析：列名 ↔ 列号、单元格引用、区域引用。
 *
 * 为什么单独成文件：xlsx 里「引用」出现的次数是单元格数的 1~2 倍
 * （每个 `<c r="B12">`、每个 `<mergeCell ref="A1:C3">`、每个 `<autoFilter ref>`），
 * 而解析一次要走上百万遍。放在这里可以单独测、单独优化，也避免散落在各处的
 * 「只支持单字母列」的半成品实现。
 *
 * 坑：列名是 **bijective base-26**（没有零位）：A=1 … Z=26, AA=27, AB=28, BA=53。
 * 早期版本写成 `n = n * 26 + v` 但 v 从 0 起，于是 AA 算成 26、AB 算成 27，
 * 整表列错位一格 —— 这类错误在只有 A~Z 的小文件上完全看不出来。
 * 本文件用测试锁死 AA=26 / AB=27 / BA=52（0 起）。
 */
import type { MergeRange } from '../../core/src/model.ts';

/** 列名字母 -> 0 起的列号。'A'->0, 'Z'->25, 'AA'->26, 'AB'->27, 'BA'->52。非法返回 -1。 */
export function colIndexOfLetters(letters: string): number {
  if (!letters) return -1;
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const code = letters.charCodeAt(i);
    let v: number;
    if (code >= 65 && code <= 90) v = code - 64; // 'A'..'Z' -> 1..26
    else if (code >= 97 && code <= 122) v = code - 96; // 小写也认（某些生成器不小写化）
    else return -1;
    n = n * 26 + v;
    // 防御畸形引用：XFD 是 Excel 的最后一列（16383）。远大于它的只可能是坏数据，
    // 让它返回 -1 而不是算出一个天文数字去分配数组。
    if (n > 1 << 21) return -1;
  }
  return n - 1;
}

/** 0 起的列号 -> 列名字母。0->'A', 25->'Z', 26->'AA', 52->'BA'。 */
export function lettersOfColIndex(index: number): string {
  let n = Math.floor(index) + 1;
  if (!(n > 0)) return '';
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * 解析单元格引用，返回 0 起的行列。容忍 `$A$1` 形式。
 * 非法返回 null（调用方应降级成「上一列 +1」，而不是抛错）。
 */
export function parseCellRef(ref: string): { r: number; c: number } | null {
  if (!ref) return null;
  let i = 0;
  let letters = '';
  let digits = '';
  for (; i < ref.length; i++) {
    const ch = ref[i];
    if (ch === '$') continue;
    if (ch >= '0' && ch <= '9') break;
    letters += ch;
  }
  for (; i < ref.length; i++) {
    const ch = ref[i];
    if (ch === '$') continue;
    if (ch < '0' || ch > '9') return null;
    digits += ch;
  }
  if (!letters || !digits) return null;
  const c = colIndexOfLetters(letters);
  const r = Number.parseInt(digits, 10);
  if (c < 0 || !Number.isFinite(r) || r < 1) return null;
  return { r: r - 1, c };
}

/** 只要列号（行号无关时用，例如统计 colCount）。非法返回 -1。 */
export function colOfRef(ref: string): number {
  if (!ref) return -1;
  let letters = '';
  for (let i = 0; i < ref.length; i++) {
    const ch = ref[i];
    if (ch === '$') continue;
    if (ch >= '0' && ch <= '9') break;
    letters += ch;
  }
  return colIndexOfLetters(letters);
}

/** 行号（0 起）。非法返回 -1。 */
export function rowOfRef(ref: string): number {
  const p = parseCellRef(ref);
  return p ? p.r : -1;
}

/**
 * 解析 `A1:C3` / `A1` 形式的区域。返回的矩形已归一化（r1<=r2, c1<=c2）。
 * 单格 `A1` 会得到 r1==r2 的退化矩形 —— 调用方不必特判。
 */
export function parseRangeRef(ref: string | undefined): MergeRange | null {
  if (!ref) return null;
  const colon = ref.indexOf(':');
  const a = parseCellRef(colon < 0 ? ref : ref.slice(0, colon));
  if (!a) return null;
  const b = colon < 0 ? a : parseCellRef(ref.slice(colon + 1));
  if (!b) return { r1: a.r, c1: a.c, r2: a.r, c2: a.c };
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  };
}

/** 把区域写成 `A1:C3`（测试与调试用）。 */
export function formatRangeRef(range: MergeRange): string {
  const a = `${lettersOfColIndex(range.c1)}${range.r1 + 1}`;
  const b = `${lettersOfColIndex(range.c2)}${range.r2 + 1}`;
  return a === b ? a : `${a}:${b}`;
}
