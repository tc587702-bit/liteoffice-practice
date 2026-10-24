/**
 * PDF 对象模型与对象解析器。
 *
 * 对象种类刻意做得很少：dict / array / name / number / string / bool / null / ref / stream。
 * 真实的 PDF 就这几种，多一层抽象只会拖慢热路径（内容流里几百万个数字）。
 *
 * 关键坑位（都在下面代码里注释了）：
 *   - `stream` 关键字后必须跟 CRLF 或 LF（只跟 CR 是非法的，但真的存在）
 *   - `/Length` 可能是**间接引用**，必须解析出来否则流边界全错
 *   - 有些 PDF 的 `/Length` 是错的，必须能退化到「搜 endstream」
 */
import {
  bytesToLatin1,
  concatBytes,
  indexOfAscii,
  isWhite,
  latin1,
  parseNumberAt,
  skipWs,
} from './byteutils.ts';
import {
  Lexer,
  TOK_ARRAY_CLOSE,
  TOK_ARRAY_OPEN,
  TOK_DICT_CLOSE,
  TOK_DICT_OPEN,
  TOK_EOF,
  TOK_NAME,
  TOK_NUMBER,
  TOK_STRING,
  TOK_WORD,
} from './lexer.ts';

export type PdfObject =
  | null
  | boolean
  | number
  | string
  | PdfName
  | PdfString
  | PdfArray
  | PdfDict
  | PdfRef
  | PdfStream;

/** 名字对象。用 {name} 包一层是为了能塞进 PdfObject 联合而不与 string 混淆。 */
export interface PdfName {
  name: string;
}

/** 字符串对象。保留原始字节 —— 编码解释要等知道字体之后才能做。 */
export interface PdfString {
  bytes: Uint8Array;
}

export type PdfArray = PdfObject[];

export interface PdfDict {
  [key: string]: PdfObject;
}

export interface PdfRef {
  num: number;
  gen: number;
}

export interface PdfStream {
  dict: PdfDict;
  /** 原始（未解码）流字节 */
  raw: Uint8Array;
}

export function isName(o: PdfObject): o is PdfName {
  return typeof o === 'object' && o !== null && typeof (o as PdfName).name === 'string';
}

export function isDict(o: PdfObject): o is PdfDict {
  return typeof o === 'object' && o !== null && !Array.isArray(o) && !isName(o) && !isRef(o) && !isString(o) && !isStream(o);
}

export function isArray(o: PdfObject): o is PdfArray {
  return Array.isArray(o);
}

export function isString(o: PdfObject): o is PdfString {
  return typeof o === 'object' && o !== null && (o as PdfString).bytes instanceof Uint8Array && !isStream(o);
}

export function isStream(o: PdfObject): o is PdfStream {
  return typeof o === 'object' && o !== null && (o as PdfStream).dict !== undefined && (o as PdfStream).raw instanceof Uint8Array;
}

export function isRef(o: PdfObject): o is PdfRef {
  return typeof o === 'object' && o !== null && typeof (o as PdfRef).num === 'number' && typeof (o as PdfRef).gen === 'number';
}

/* ==================================================================== */
/* 取值辅助：容错地把对象读成想要的基本类型                              */
/* ==================================================================== */

export function nameOf(o: PdfObject): string | undefined {
  return isName(o) ? o.name : undefined;
}

export function numOf(o: PdfObject): number | undefined {
  return typeof o === 'number' && Number.isFinite(o) ? o : undefined;
}

export function boolOf(o: PdfObject): boolean | undefined {
  return typeof o === 'boolean' ? o : undefined;
}

export function arrayOf(o: PdfObject): PdfArray | undefined {
  return isArray(o) ? o : undefined;
}

export function dictOf(o: PdfObject): PdfDict | undefined {
  if (isStream(o)) return o.dict;
  return isDict(o) ? o : undefined;
}

/** 把字符串对象按 Latin-1 转文本；非字符串返回 undefined。 */
export function textOf(o: PdfObject): string | undefined {
  if (!isString(o)) return undefined;
  return bytesToLatin1(o.bytes);
}

/** dict 里取名字值，例如 dictName(d, 'Type') -> 'Page' */
export function dictName(d: PdfDict | undefined, key: string): string | undefined {
  return d ? nameOf(d[key]) : undefined;
}

/* ==================================================================== */
/* 对象解析器                                                            */
/* ==================================================================== */

/** 解析器与文档状态之间的窄接口 —— 避免 parser 直接 import xref 造成循环依赖结构。 */
export interface ObjectHost {
  /** 解析间接引用（仅用于解析 /Length 这类必须立刻取值的场景） */
  resolve(o: PdfObject, depth?: number): PdfObject;
  /** 记录一条降级说明（去重由调用方负责） */
  note(message: string): void;
}

/**
 * 解析单条 `N G obj ... endobj`。
 *
 * 返回值允许为 undefined —— 表示这个偏移处根本没有对象（真实文件里 xref 偏移
 * 错位很常见）。调用方据此决定是否退化到全文扫描。
 */
export function parseIndirectObjectAt(
  buf: Uint8Array,
  offset: number,
  host: ObjectHost,
): { obj: PdfObject; end: number } | undefined {
  if (offset < 0 || offset >= buf.length) return undefined;
  let i = skipWs(buf, offset);
  const numRes = parseNumberAt(buf, i);
  if (Number.isNaN(numRes.value)) return undefined;
  const objNum = numRes.value;
  i = skipWs(buf, numRes.next);
  const genRes = parseNumberAt(buf, i);
  if (Number.isNaN(genRes.value)) return undefined;
  i = skipWs(buf, genRes.next);
  if (latin1(buf, i, i + 3) !== 'obj') return undefined;
  if (i + 3 < buf.length) {
    // `obj` 后面必须是分隔符或空白，否则可能匹配到 `objX` 这种子串
    const c = buf[i + 3];
    if (c !== undefined && !isWhite(c) && c !== 0x3c && c !== 0x5b && c !== 0x2f) return undefined;
  }
  const lex = new Lexer(buf, i + 3);
  const obj = parseValue(lex, host, 0);
  const end = readStreamIfPresent(lex, obj, buf, host);
  return { obj: end.obj, end: end.end };
}

export interface StreamReadResult {
  obj: PdfObject;
  end: number;
}

/**
 * 若 `<<...>>` 后面紧跟 stream 关键字，则读取流字节。
 * 这是 PDF 里最容易出错的地方：长度来源优先级为
 *   1. /Length（如果是间接引用则解析它）
 *   2. 搜 endstream（/Length 错误或缺失时的兜底）
 *   3. 剩余全部字节（最后兜底，不崩）
 */
export function readStreamIfPresent(lex: Lexer, obj: PdfObject, buf: Uint8Array, host: ObjectHost): StreamReadResult {
  if (!isDict(obj)) return { obj, end: lex.scannedPos };
  const t = lex.peek(0);
  if (!(t.type === TOK_WORD && t.text === 'stream')) return { obj, end: lex.scannedPos };
  lex.next();
  // `stream` 关键字之后就是二进制数据，token 结构在此中断：
  // 必须用「已扫描到的字节位置」作为数据起点（它是字节语义的，pos 是 token 语义的）。
  let i = lex.scannedPos;
  // `stream` 后必须是 CRLF 或 LF；只跟 CR 的情况也存在（非规范），一并容忍
  if (buf[i] === 0x0d) i++;
  if (buf[i] === 0x0a) i++;
  else if (buf[i] === 0x0d) i++;

  // 注意：这里必须用原始 dict 上的 /Length，且要能解析间接引用 —— 经典坑。
  let len = numOf(obj.Length);
  if (len === undefined && isRef(obj.Length)) {
    const resolved = host.resolve(obj.Length);
    len = numOf(resolved);
    if (len === undefined) {
      host.note('流的 /Length 是间接引用但未能解析，改用 endstream 搜索确定边界');
    }
  }
  const dataStart = i;
  let dataEnd: number;
  if (len !== undefined && len >= 0 && dataStart + len <= buf.length) {
    dataEnd = dataStart + len;
    // 校验：期望位置附近应能看到 endstream。看不到说明 /Length 是错的。
    const probeEnd = Math.min(buf.length, dataEnd + 24);
    const probe = indexOfAscii(buf, 'endstream', Math.max(dataStart, dataEnd - 4), probeEnd);
    if (!(probe >= 0 && probe <= dataEnd + 22)) {
      const scanned = findEndstream(buf, dataStart);
      if (scanned >= 0) {
        host.note('/Length 与实际数据不符，已按 endstream 关键字重新划定流边界');
        dataEnd = trimEol(buf, dataStart, scanned);
      }
    }
  } else {
    const scanned = findEndstream(buf, dataStart);
    if (scanned < 0) {
      host.note(`流缺少 /Length 且找不到 endstream，已取到文件尾（对象 ${describeDict(obj)}）`);
      dataEnd = buf.length;
    } else {
      dataEnd = trimEol(buf, dataStart, scanned);
    }
  }

  const raw = buf.subarray(dataStart, Math.max(dataStart, dataEnd));
  // 跳到 endstream 之后：这里同样必须用字节语义的 seekTo（丢弃缓冲）
  lex.seekTo(skipWs(buf, Math.min(buf.length, dataEnd + 9)));
  return { obj: { dict: obj, raw }, end: lex.scannedPos };
}

/** 去掉 endstream 之前多出的 EOL（数据本身不包含它） */
function trimEol(buf: Uint8Array, start: number, end: number): number {
  let e = end;
  if (e > start && buf[e - 1] === 0x0a) e--;
  if (e > start && buf[e - 1] === 0x0d) e--;
  return e;
}

/**
 * 从 dataStart 往后找 `endstream`。
 * 为什么不能简单 indexOf：流内容是二进制，理论上可能包含 "endstream" 字样。
 * 因此要求它出现在行首（前面是 CR/LF 或起始），这是规范推荐的扫描方式。
 */
function findEndstream(buf: Uint8Array, dataStart: number): number {
  let from = dataStart;
  for (;;) {
    const at = indexOfAscii(buf, 'endstream', from);
    if (at < 0) return -1;
    const before = at > 0 ? buf[at - 1] : 0x0a;
    if (before === 0x0a || before === 0x0d) return at;
    from = at + 1;
  }
}

function describeDict(d: PdfDict): string {
  const type = nameOf(d.Type);
  return type ? `/Type ${type}` : '未知';
}

/** 解析任意对象值（不含 stream 包装，那由 readStreamIfPresent 处理）。 */
export function parseValue(lex: Lexer, host: ObjectHost, depth: number): PdfObject {
  if (depth > 64) {
    host.note('对象嵌套超过 64 层，已截断解析（畸形文件保护）');
    return null;
  }
  const t = lex.peek(0);
  switch (t.type) {
    case TOK_EOF:
      return null;
    case TOK_NUMBER: {
      // 可能是数字，也可能是 `N G R` 间接引用。判定必须**纯靠 peek**：
      // 早期版本先 next() 再 restore() 回退，但「回退」在缓冲非空时无法精确
      // 还原（save() 记录的是长度，而消耗掉的 token 与被丢弃的预读 token
      // 混在一起），结果是紧跟其后的一个 token 被永久吃掉 —— 症状是
      // `/Count 1` 后面整个 `/Kids [...]` 消失，进而真实 PDF 全部打不开。
      // 现在只看不取，最后一个 next() 才真正消费，语义无歧义。
      const first = lex.peek(0);
      const p1 = lex.peek(1);
      if (p1.type === TOK_NUMBER && Number.isInteger(first.num) && Number.isInteger(p1.num)) {
        const p2 = lex.peek(2);
        if (p2.type === TOK_WORD && p2.text === 'R') {
          lex.next();
          lex.next();
          lex.next();
          return { num: first.num, gen: p1.num };
        }
      }
      lex.next();
      return first.num;
    }
    case TOK_NAME: {
      lex.next();
      return { name: t.text };
    }
    case TOK_STRING: {
      lex.next();
      return { bytes: t.bytes };
    }
    case TOK_WORD: {
      lex.next();
      if (t.text === 'true') return true;
      if (t.text === 'false') return false;
      if (t.text === 'null') return null;
      // 未知关键字：当 null 处理，继续解析后面的内容
      host.note(`遇到未预期的关键字 "${t.text}"，已按 null 处理`);
      return null;
    }
    case TOK_ARRAY_OPEN: {
      lex.next();
      const arr: PdfArray = [];
      for (;;) {
        const p = lex.peek(0);
        if (p.type === TOK_EOF) break;
        if (p.type === TOK_ARRAY_CLOSE) {
          lex.next();
          break;
        }
        const before = lex.pos;
        const v = parseValue(lex, host, depth + 1);
        // 防御死循环：解析器没前进时强制推进一步。
        // ⚠ 必须用 pos（读位置）判断，不能用 scannedPos（扫描头）：
        // 数字/名字的解析会为了判断 `N G R` 预读后面的 token，此时扫描头已经
        // 越过被预读的 token 了；拿 scannedPos 比较就会误判「没前进」，把下一个
        // token 白白吃掉 —— 症状是数组/字典的**最后一个元素消失**
        // （实测：`/Differences [65 /bullet /Euro]` 解析成 `[65 /bullet]`）。
        if (lex.pos === before && lex.peek(0).type !== TOK_ARRAY_CLOSE && lex.peek(0).type !== TOK_EOF) lex.next();
        arr.push(v);
        if (arr.length > 200_000) {
          host.note('数组元素超过 20 万，已截断（畸形文件保护）');
          break;
        }
      }
      return arr;
    }
    case TOK_DICT_OPEN: {
      lex.next();
      const dict: PdfDict = {};
      for (;;) {
        const p = lex.peek(0);
        if (p.type === TOK_EOF) break;
        if (p.type === TOK_DICT_CLOSE) {
          lex.next();
          break;
        }
        if (p.type !== TOK_NAME) {
          // 畸形字典：丢掉一个 token 继续，尽量多读一点内容出来
          lex.next();
          continue;
        }
        const key = lex.next().text;
        const before = lex.pos;
        const v = parseValue(lex, host, depth + 1);
        // 防御死循环：解析器没前进时强制推进一步。
        // 用 pos 而不是 scannedPos，原因见上面数组分支的注释：预读会让扫描头
        // 提前越过未消费的 token，用 scannedPos 比较会误吃下一个字典项。
        if (lex.pos === before) lex.next();
        dict[key] = v;
      }
      return dict;
    }
    default:
      // ']' '>>' 等游离 token：吃掉以免死循环
      lex.next();
      return null;
  }
}

/* ==================================================================== */
/* 对象流（/Type /ObjStm）                                               */
/* ==================================================================== */

export interface EmbeddedObject {
  num: number;
  offset: number;
}

/**
 * 解析对象流的头部：`N1 off1 N2 off2 …`。
 * 这些数字是 ASCII，但对象流整体被压缩过，所以必须先解码才能看到。
 */
export function parseObjStmHeader(data: Uint8Array, count: number): EmbeddedObject[] {
  const out: EmbeddedObject[] = [];
  let i = 0;
  const n = data.length;
  for (let k = 0; k < count && i < n; k++) {
    const a = parseNumberAt(data, skipWs(data, i));
    if (Number.isNaN(a.value)) break;
    const b = parseNumberAt(data, skipWs(data, a.next));
    if (Number.isNaN(b.value)) break;
    out.push({ num: a.value, offset: b.value });
    i = b.next;
  }
  return out;
}

/** 从对象流的数据区里取出第 index 个对象的原始字节切片。 */
export function sliceObjStmEntry(data: Uint8Array, entries: readonly EmbeddedObject[], index: number): Uint8Array {
  const start = 0; // 对象流的偏移是相对 data 开头的
  const off = entries[index].offset;
  const next = index + 1 < entries.length ? entries[index + 1].offset : data.length - start;
  const from = start + off;
  const to = start + Math.min(next, data.length - start);
  if (from < 0 || from >= data.length) return new Uint8Array(0);
  return data.subarray(from, Math.max(from, Math.min(to, data.length)));
}

/** 在给定字节里解析出一个独立对象（对象流内部的对象没有 obj/endobj 包装）。 */
export function parseObjectBytes(data: Uint8Array, host: ObjectHost): PdfObject {
  const lex = new Lexer(data, 0);
  const v = parseValue(lex, host, 0);
  return readStreamIfPresent(lex, v, data, host).obj;
}

export interface ParsedValueAt {
  value: PdfObject;
  /** 解析结束后的绝对偏移（相对传入的 buf） */
  end: number;
}

/**
 * 从 buf 的 offset 处解析一个**裸对象值**（没有 `N G obj` 包装）。
 *
 * 为什么需要它：trailer 字典写的是 `trailer << /Root 1 0 R >>`，
 * 这里 `<< ... >>` 是裸字典。早期版本用「截到 endobj 再整体解析」的做法，
 * 结果把 startxref/%%EOF 一起喂给解析器，字典里混进了后续内容，
 * 表现为 /Root 缺失并触发全文扫描 —— 一个很难从表象定位的 bug。
 */
export function parseValueAt(buf: Uint8Array, offset: number, host: ObjectHost): ParsedValueAt {
  const lex = new Lexer(buf, offset);
  const value = parseValue(lex, host, 0);
  return { value, end: lex.scannedPos };
}

/** 把已解析的 PdfObject 收敛成字典（非字典返回 undefined）。 */
export function asDictObject(o: PdfObject): PdfDict | undefined {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined;
  if (isStream(o)) return o.dict;
  if (isName(o) || isString(o) || isRef(o)) return undefined;
  return o as PdfDict;
}

export { concatBytes, latin1 };
