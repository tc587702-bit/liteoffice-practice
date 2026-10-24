/**
 * PDF 词法扫描器（Lexer / Token）。
 *
 * 对象语法与内容流算子都用同一个 Lexer —— 它们共用同一套 token 规则
 * （数字、名字、字面量串、十六进制串、数组/字典定界符、关键字）。
 * 分开成独立文件是为了让字节工具（byteutils.ts）保持无状态。
 */
import { hexVal, isNumberStart, isRegular, latin1, parseNumberAt, skipWs } from './byteutils.ts';

const CR = 0x0d;
const LF = 0x0a;
const TAB = 0x09;
const FF = 0x0c;

/* ==================================================================== */
/* 词法 token                                                            */
/* ==================================================================== */

// 注意：本项目禁用 enum（只用可擦除语法），因此 token 类型用「字符串常量 + 联合类型」表达。
export const TOK_EOF = 'eof';
export const TOK_NUMBER = 'num';
export const TOK_NAME = 'name';
export const TOK_STRING = 'str';
export const TOK_WORD = 'word';
export const TOK_ARRAY_OPEN = '[';
export const TOK_ARRAY_CLOSE = ']';
export const TOK_DICT_OPEN = '<<';
export const TOK_DICT_CLOSE = '>>';

export type TokenType =
  | typeof TOK_EOF
  | typeof TOK_NUMBER
  | typeof TOK_NAME
  | typeof TOK_STRING
  | typeof TOK_WORD
  | typeof TOK_ARRAY_OPEN
  | typeof TOK_ARRAY_CLOSE
  | typeof TOK_DICT_OPEN
  | typeof TOK_DICT_CLOSE;

export interface Token {
  type: TokenType;
  /** 数字 token 的数值 */
  num: number;
  /** name 去掉前导 '/' 且已解 #XX 后的文本；word/关键字的原文 */
  text: string;
  /** 字符串 token 的原始字节（已解转义/十六进制） */
  bytes: Uint8Array;
  /** 该 token 首字节的绝对偏移（由 Lexer 填写，用于 save/restore 正确回退） */
  start: number;
}

/**
 * 扫描器：支持任意位置的 peek/next，并且能 save/restore。
 *
 * 为什么需要 save/restore：解析 `N G R` 间接引用时要先看 3 个 token 才能确定
 * 它是引用还是「三个数字」。
 *
 * ⚠ 这个类有两个极易写错、后果又极严重的不变式（本项目逐条踩过，症状是
 *   「自造最小夹具全过、所有真实 PDF 打不开」，甚至直接挂死）。写在这里，
 *   改动前请先读完：
 *
 *   不变式 1：`pos` = **peek(0) 那个 token 的字节起点**，而不是扫描头。
 *     scan() 会把后续 token 预扫描进 tokens 数组。如果 next() 不把 pos
 *     推进到下一个 token，同一个 token 会被反复读出（死循环）；
 *     如果 restore() 后 pos 停在已被消费的字节上，重新扫描就会漏掉一段
 *     token —— `/Kids [5 0 R]` 之后的 `>>` 凭空消失，解析器于是越过 endobj
 *     把后面几个对象合并成一个字典。
 *
 *   不变式 2：`scanPos`（扫描头）**只能单调前进**。
 *     restore() 只允许回退 pos（读位置），绝不允许回退 scanPos：
 *     一旦回退，被丢弃的 token 会被重新扫描出来，peek() 的补全循环永远
 *     推进不下去，整个解析挂死。
 *
 *   两个不变式的组合效果：restore() 之后重新扫描时，scanPos 已经越过了
 *   被丢弃的 token，所以重新扫出来的是「那之后」的内容；而 pos 指向
 *   保留 token 的起点或 file-only 时用 scanPos 兜底 —— 都不会重复、不会遗漏。
 */
export class Lexer {
  readonly buf: Uint8Array;
  /** peek(0) 对应 token 的字节起点（不变式 1） */
  pos: number;
  private readonly tokens: Token[] = [];
  /** 扫描头位置（不变式 2：单调前进） */
  private scanPos: number;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.pos = pos;
    this.scanPos = pos;
  }

  peek(k = 0): Token {
    const wasEmpty = this.tokens.length === 0;
    while (this.tokens.length <= k) {
      const t = this.scan();
      t.start = this.scanPos;
      this.scanPos = this.pos;
      this.tokens.push(t);
    }
    // 缓冲由空变非空时，pos 必须重新指向 peek(0)
    if (wasEmpty) this.pos = this.tokens[0].start;
    return this.tokens[k];
  }

  /** 取下一个 token。保持不变式 1：调用后 pos 指向新的 peek(0)。 */
  next(): Token {
    const t = this.peek(0);
    this.tokens.shift();
    this.pos = this.tokens.length > 0 ? this.tokens[0].start : this.scanPos;
    return t;
  }

  /** 已扫描到的字节位置。二进制数据（内联图片）与流数据必须用它，不能用 pos。 */
  get scannedPos(): number {
    return this.scanPos;
  }

  /**
   * 把扫描器绝对定位到 bytePos，并丢弃已缓冲的 token。
   *
   * 为什么需要它：内联图片（BI/ID/EI）与流数据里没有 token 结构，必须用
   * 字节偏移直接跳过。若不丢弃缓冲，缓冲里的 token 会在新位置之后被
   * 「补扫」出来，造成内容流解析错位。
   */
  seekTo(bytePos: number): void {
    const p = Math.max(0, Math.min(bytePos, this.buf.length));
    this.tokens.length = 0;
    this.pos = p;
    this.scanPos = p;
  }

  /** 尝试吃掉一个关键字（word）；命中才推进。 */
  eatKeyword(word: string): boolean {
    const t = this.peek(0);
    if (t.type === TOK_WORD && t.text === word) {
      this.next();
      return true;
    }
    return false;
  }

  /** 在接下来 maxBytes 范围内找某个关键字；找到则吃掉它及其之前的内容。 */
  skipToKeyword(word: string, maxBytes = 1 << 20): boolean {
    const end = Math.min(this.buf.length, this.pos + maxBytes);
    while (this.pos < end) {
      const t = this.next();
      if (t.type === TOK_EOF) return false;
      if (t.type === TOK_WORD && t.text === word) return true;
    }
    return false;
  }

  private scan(): Token {
    const buf = this.buf;
    const n = buf.length;
    // ⚠ 必须从 scanPos（扫描头）起扫，**不能**用 this.pos：
    // pos 是「peek(0) 的起点」，peek() 会把它写回缓冲头，于是同一段字节会被
    // 反复扫出同一个 token（表现为 peek(0)/peek(1) 返回同一个 token，
    // 间接引用 `1 0 R` 于是永远识别不出来 —— 本项目踩过）。
    const start = skipWs(buf, this.scanPos);
    this.pos = start;
    const i = start;
    if (i >= n) {
      this.pos = n;
      return emptyToken(TOK_EOF);
    }
    const b = buf[i];

    if (b === 0x5b) {
      this.pos = i + 1;
      return emptyToken(TOK_ARRAY_OPEN);
    }
    if (b === 0x5d) {
      this.pos = i + 1;
      return emptyToken(TOK_ARRAY_CLOSE);
    }
    if (b === 0x3c) {
      if (buf[i + 1] === 0x3c) {
        this.pos = i + 2;
        return emptyToken(TOK_DICT_OPEN);
      }
      return this.scanHexString(i);
    }
    if (b === 0x3e) {
      if (buf[i + 1] === 0x3e) {
        this.pos = i + 2;
        return emptyToken(TOK_DICT_CLOSE);
      }
      // 孤立的 '>' 是畸形输入，跳过避免死循环
      this.pos = i + 1;
      return emptyToken(TOK_WORD);
    }
    if (b === 0x2f) return this.scanName(i);
    if (b === 0x28) return this.scanLiteralString(i);
    if (isNumberStart(buf, i)) {
      const { value, next } = parseNumberAt(buf, i);
      this.pos = next;
      if (Number.isNaN(value)) {
        this.pos = i + 1;
        return emptyToken(TOK_WORD);
      }
      const t = emptyToken(TOK_NUMBER);
      t.num = value;
      return t;
    }
    // 普通关键字 / 算子（BT、Tj、obj、stream、true …）
    let j = i;
    while (j < n && isRegular(buf[j])) j++;
    if (j === i) j = i + 1; // 极端畸形：保证前进
    this.pos = j;
    const t = emptyToken(TOK_WORD);
    t.text = latin1(buf, i, j);
    return t;
  }

  private scanName(i: number): Token {
    const buf = this.buf;
    const n = buf.length;
    let j = i + 1;
    let out = '';
    while (j < n && isRegular(buf[j])) {
      const c = buf[j];
      if (c === 0x23 && j + 2 < n) {
        // name 里的 #XX 十六进制转义
        const h1 = hexVal(buf[j + 1]);
        const h2 = hexVal(buf[j + 2]);
        if (h1 >= 0 && h2 >= 0) {
          out += String.fromCharCode(h1 * 16 + h2);
          j += 3;
          continue;
        }
      }
      out += String.fromCharCode(c);
      j++;
    }
    this.pos = j;
    const t = emptyToken(TOK_NAME);
    t.text = out;
    return t;
  }

  private scanHexString(i: number): Token {
    const buf = this.buf;
    const n = buf.length;
    let j = i + 1;
    const out: number[] = [];
    let hi = -1;
    while (j < n) {
      const c = buf[j];
      if (c === 0x3e) {
        j++;
        break;
      }
      const v = hexVal(c);
      if (v >= 0) {
        if (hi < 0) hi = v;
        else {
          out.push(hi * 16 + v);
          hi = -1;
        }
      }
      j++;
    }
    // 奇数个十六进制位：末位补 0（规范如此）
    if (hi >= 0) out.push(hi * 16);
    this.pos = j;
    const t = emptyToken(TOK_STRING);
    t.bytes = new Uint8Array(out);
    return t;
  }

  private scanLiteralString(i: number): Token {
    const buf = this.buf;
    const n = buf.length;
    let j = i + 1;
    let depth = 1;
    const out: number[] = [];
    while (j < n) {
      const c = buf[j];
      if (c === 0x5c) {
        // 转义序列：\n \r \t \b \f \( \) \\ \ddd(八进制) 以及「行尾续行」
        const d = buf[j + 1];
        if (d === undefined) {
          j++;
          break;
        }
        switch (d) {
          case 0x6e:
            out.push(LF);
            j += 2;
            break;
          case 0x72:
            out.push(CR);
            j += 2;
            break;
          case 0x74:
            out.push(TAB);
            j += 2;
            break;
          case 0x62:
            out.push(0x08);
            j += 2;
            break;
          case 0x66:
            out.push(FF);
            j += 2;
            break;
          case 0x28:
            out.push(0x28);
            j += 2;
            break;
          case 0x29:
            out.push(0x29);
            j += 2;
            break;
          case 0x5c:
            out.push(0x5c);
            j += 2;
            break;
          case CR:
            j += buf[j + 2] === LF ? 3 : 2;
            break;
          case LF:
            j += 2;
            break;
          default: {
            if (d >= 0x30 && d <= 0x37) {
              let v = 0;
              let k = 0;
              while (k < 3 && j + 1 + k < n) {
                const o = buf[j + 1 + k];
                if (o < 0x30 || o > 0x37) break;
                v = v * 8 + (o - 0x30);
                k++;
              }
              // 八进制可以超过 255（如 \777），按 PDF 惯例截到字节
              out.push(v & 0xff);
              j += 1 + k;
            } else {
              // 未知转义：规范说反斜杠被忽略，字符保留
              out.push(d);
              j += 2;
            }
          }
        }
        continue;
      }
      if (c === 0x28) {
        depth++;
        out.push(c);
        j++;
        continue;
      }
      if (c === 0x29) {
        depth--;
        j++;
        if (depth === 0) break;
        out.push(c);
        continue;
      }
      out.push(c);
      j++;
    }
    this.pos = j;
    const t = emptyToken(TOK_STRING);
    t.bytes = new Uint8Array(out);
    return t;
  }
}

function emptyToken(type: TokenType): Token {
  return { type, num: 0, text: '', bytes: EMPTY_BYTES, start: 0 };
}

const EMPTY_BYTES = new Uint8Array(0);

