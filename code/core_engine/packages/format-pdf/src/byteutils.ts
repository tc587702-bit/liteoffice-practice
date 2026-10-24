/**
 * PDF 字节级工具。
 *
 * 为什么单独一层：PDF 是**字节语法**而不是文本格式。内容流里的字符串、xref 表、
 * 对象偏移全部是字节偏移。若先把整个文件 decode 成 JS 字符串再处理，会有两个问题：
 *   1. 一个 4 MiB 的 PDF 会变成 8 MiB 以上的堆字符串（V8 对非 Latin-1 用 2 字节/字符）
 *   2. `startxref` 给的偏移是**字节偏移**，字符串下标在含多字节内容时会错位
 * 所以这里全程围着 Uint8Array 走，只在确实产出文本时才 create 字符串。
 *
 * 词法扫描器（Lexer / Token）在 lexer.ts —— 那一层依赖这里的字符分类函数。
 */

const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const FF = 0x0c;
const NUL = 0x00;

/** PDF 空白符：NUL HT LF FF CR SP（注意 NUL 也算，这在真实文件里出现过） */
export function isWhite(b: number): boolean {
  return b === SPACE || b === LF || b === CR || b === TAB || b === FF || b === NUL;
}

export function isDelimiter(b: number): boolean {
  return (
    b === 0x28 || // (
    b === 0x29 || // )
    b === 0x3c || // <
    b === 0x3e || // >
    b === 0x5b || // [
    b === 0x5d || // ]
    b === 0x7b || // {
    b === 0x7d || // }
    b === 0x2f || // /
    b === 0x25 // %
  );
}

export function isRegular(b: number): boolean {
  return !isWhite(b) && !isDelimiter(b);
}

export function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

export function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

export function skipWs(buf: Uint8Array, pos: number): number {
  let i = pos;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (isWhite(b)) {
      i++;
      continue;
    }
    // 注释：% 到行尾。真实 PDF 里注释随处可见（尤其是生成器写入的标记）。
    if (b === 0x25) {
      i++;
      while (i < n && buf[i] !== CR && buf[i] !== LF) i++;
      continue;
    }
    break;
  }
  return i;
}

/** 解析 PDF 数字。返回 value，NaN 表示不是数字。PDF 允许 `+1`、`-.5`、`4.` 这类写法。 */
export function parseNumberAt(buf: Uint8Array, pos: number): { value: number; next: number } {
  const n = buf.length;
  let i = pos;
  let neg = false;
  if (i < n && (buf[i] === 0x2b || buf[i] === 0x2d)) {
    neg = buf[i] === 0x2d;
    i++;
  }
  let sawDigit = false;
  let value = 0;
  while (i < n && isDigit(buf[i])) {
    value = value * 10 + (buf[i] - 0x30);
    i++;
    sawDigit = true;
    // 防御：畸形文件里可能出现上千位的「数字」，直接截断避免精度与耗时失控
    if (i - pos > 24) break;
  }
  if (i < n && buf[i] === 0x2e) {
    i++;
    let scale = 0.1;
    while (i < n && isDigit(buf[i])) {
      value += (buf[i] - 0x30) * scale;
      scale *= 0.1;
      i++;
      sawDigit = true;
      if (i - pos > 24) break;
    }
  }
  if (!sawDigit) return { value: Number.NaN, next: pos };
  // 指数形式不是 PDF 语法，但某些生成器会写 1e-3；宽容处理
  if (i < n && (buf[i] === 0x65 || buf[i] === 0x45)) {
    const save = i;
    let j = i + 1;
    let expNeg = false;
    if (j < n && (buf[j] === 0x2b || buf[j] === 0x2d)) {
      expNeg = buf[j] === 0x2d;
      j++;
    }
    let exp = 0;
    let expDigits = 0;
    while (j < n && isDigit(buf[j]) && expDigits < 4) {
      exp = exp * 10 + (buf[j] - 0x30);
      j++;
      expDigits++;
    }
    if (expDigits > 0) {
      value *= Math.pow(10, expNeg ? -exp : exp);
      i = j;
    } else {
      i = save;
    }
  }
  return { value: neg ? -value : value, next: i };
}

export function isNumberStart(buf: Uint8Array, pos: number): boolean {
  const b = buf[pos];
  if (b === undefined) return false;
  if (isDigit(b)) return true;
  if (b === 0x2b || b === 0x2d) {
    const c = buf[pos + 1];
    return c !== undefined && (isDigit(c) || c === 0x2e);
  }
  if (b === 0x2e) {
    const c = buf[pos + 1];
    return c !== undefined && isDigit(c);
  }
  return false;
}

/** 把字节区间按 Latin-1 转字符串。PDF 的关键字/名字都是单字节 ASCII。 */
export function latin1(buf: Uint8Array, start: number, end: number): string {
  let s = '';
  const n = Math.min(end, buf.length);
  // 分块 fromCharCode，避免超长参数列表爆栈
  for (let i = start; i < n; i += 4096) {
    const chunk = buf.subarray(i, Math.min(i + 4096, n));
    s += String.fromCharCode(...chunk);
  }
  return s;
}

/** 在 buf 的 [from, limit) 区间里找 ASCII 关键字，返回其起始下标或 -1。 */
export function indexOfAscii(buf: Uint8Array, needle: string, from = 0, limit = -1): number {
  const end = limit < 0 ? buf.length : Math.min(limit, buf.length);
  const first = needle.charCodeAt(0);
  const nl = needle.length;
  for (let i = Math.max(0, from); i + nl <= end; i++) {
    if (buf[i] !== first) continue;
    let ok = true;
    for (let k = 1; k < nl; k++) {
      if (buf[i + k] !== needle.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/** 从尾部倒着找 ASCII 关键字（用于 startxref / %%EOF）。 */
export function lastIndexOfAscii(buf: Uint8Array, needle: string): number {
  const nl = needle.length;
  for (let i = buf.length - nl; i >= 0; i--) {
    if (buf[i] !== needle.charCodeAt(0)) continue;
    let ok = true;
    for (let k = 1; k < nl; k++) {
      if (buf[i + k] !== needle.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/** 判断 offset 处是否是「独立的关键字」（前后是分隔符/边界），避免匹配到子串。 */
export function keywordAt(buf: Uint8Array, offset: number, word: string): boolean {
  if (offset < 0 || offset + word.length > buf.length) return false;
  for (let k = 0; k < word.length; k++) if (buf[offset + k] !== word.charCodeAt(k)) return false;
  const before = offset > 0 ? buf[offset - 1] : 0;
  const after = offset + word.length < buf.length ? buf[offset + word.length] : 0;
  if (offset > 0 && isRegular(before)) return false;
  if (offset + word.length < buf.length && isRegular(after)) return false;
  return true;
}

export function bytesToLatin1(bytes: Uint8Array): string {
  return latin1(bytes, 0, bytes.length);
}

/** 拼接多个字节块 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
