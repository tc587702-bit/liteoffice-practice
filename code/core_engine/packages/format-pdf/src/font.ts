/**
 * 字体：字符码 -> Unicode 映射，以及字形宽度查询。
 *
 * 这是「中文 PDF 能不能提取出可读文字」的分界线，也是整个包里最需要讲究优先级的
 * 地方。取值顺序（高到低）：
 *
 *   1. /ToUnicode CMap         —— 子集化字体唯一的正确途径，中文 PDF 基本靠它
 *   2. /Encoding /Differences  —— 按字形名覆盖基编码
 *   3. 基编码（WinAnsi/MacRoman/Standard）
 *   4. Latin-1 直译            —— 最后的兜底，绝不返回空串把整页文本吃掉
 *
 * 复合字体（/Type0）额外有一条：
 *   Identity-H/V 下字符码是 2 字节 CID，没有 ToUnicode 时按预定义 CMap 近似
 *   （GBK-EUC-H -> gb18030，UniGB-UCS2-H -> utf-16be，Identity-H 无信息时先试
 *   utf-16be 再试 gb18030）。**这两种都不是精确还原**，会记 warning。
 *
 * 明确不支持：CFF/Type1 字体的 glyph 级轮廓还原（那需要实现 charstring 解释器），
 * 本项目只做「文本语义提取 + 近似版面」，不做字形轮廓。
 */
import { bytesToLatin1 } from './byteutils.ts';
import { baseEncodingTable, glyphNameToUnicode, lookupEncoding } from './encoding.ts';
import { arrayOf, dictName, isArray, isDict, isName, isStream, nameOf, numOf } from './objects.ts';
import type { PdfArray, PdfDict, PdfObject } from './objects.ts';

/** 取字节串第 i 个字符码对应的 Unicode；返回 null 表示无法解码（调用方应终止）。 */
export type CharDecoder = (bytes: Uint8Array, i: number) => DecodedChar | null;

export interface DecodedChar {
  text: string;
  next: number;
  /** 用于查 /Widths 的字符码（简单字体是字节值，复合字体是 CID） */
  code: number;
}

export interface Font {
  /** 资源名（/F1 等），写进 PdfTextItem.font */
  name: string;
  /** /BaseFont 名，去掉子集前缀 */
  baseFont: string;
  subtype: string;
  /** 每字节码的映射表（简单字体专用，256 项，省去每次查表的分支） */
  table?: string[];
  /** 复合字体：每字节码的字节数（1 或 2），可变长度 CMap 时为 0 */
  bytesPerCode: number;
  decoder: CharDecoder;
  /** 取字形宽度，单位 1/1000 em */
  width(code: number): number;
  /** 依赖 ToUnicode 之外的近似映射（需要 warning） */
  approximate: boolean;
}

export interface FontLoadContext {
  /** 解析间接引用（异步：解析 /ToUnicode 之外的资源时不涉及解压，但保持统一签名） */
  resolve(o: PdfObject): Promise<PdfObject>;
  /** 同步版本的解析（用于宽度表这种纯结构数据，避免把整条链路染成异步） */
  resolveSync(o: PdfObject): PdfObject;
  /** 解码一条流（/ToUnicode 几乎总是 FlateDecode 压缩的） */
  decodeStream(dict: PdfDict, raw: Uint8Array): Promise<Uint8Array | undefined>;
  note(message: string): void;
}

const utf16be = new TextDecoder('utf-16be');
let gb18030Decoder: TextDecoder | undefined;
function gbDecoder(): TextDecoder {
  // gb18030 是 GBK/GB2312 的超集，中文 PDF 用 GBK-EUC-H 时用它解码命中率最高
  gb18030Decoder ??= new TextDecoder('gb18030');
  return gb18030Decoder;
}

/** 默认宽度（1/1000 em）。拿不到 /Widths 时用它，宁可版面粗糙也不要丢文字。 */
const DEFAULT_WIDTH = 500;

/* ==================================================================== */
/* 字体加载器                                                            */
/* ==================================================================== */

export class FontLoader {
  private readonly ctx: FontLoadContext;
  /** 字体名 -> Promise<Font>。缓存 Promise 而不是 Font，保证同一字体只构建一次。 */
  private readonly cache = new Map<string, Promise<Font | undefined>>();
  /** 已警告过的字体名，避免同一个字体在每页都刷一遍 warning */
  private readonly warned = new Set<string>();

  constructor(ctx: FontLoadContext) {
    this.ctx = ctx;
  }

  /**
   * 从页面的 /Resources /Font 字典里按名字取字体。
   *
   * 为什么是异步：/ToUnicode 通常是一个 **FlateDecode 压缩流**，
   * 必须先解压才能解析 CMap。早期版本直接拿原始压缩字节去解析，于是
   * 中文 PDF 全部落到「近似解码」分支，提取出一堆乱码 —— 中文可读性的
   * 关键就在这里。
   */
  load(fontDict: PdfDict | undefined, resName: string): Promise<Font | undefined> {
    const cached = this.cache.get(resName);
    if (cached) return cached;
    const promise = this.buildByName(fontDict, resName);
    this.cache.set(resName, promise);
    return promise;
  }

  private async buildByName(fontDict: PdfDict | undefined, resName: string): Promise<Font | undefined> {
    if (!fontDict) {
      // 页面的 /Resources 里没有 /Font 字典：规范上这是错误，但真实文件里出现过。
      // 直接返回 undefined 会让 showText() 把整段文字丢掉（静默丢内容），
      // 所以退化成 Latin-1 直译并记 warning。
      this.warnOnce(
        `fontdict:${resName}`,
        `页面的 /Resources 里没有字体字典，/${resName} 上的文本按 Latin-1 直译`,
      );
      return simpleFont(resName, {}, undefined);
    }
    const raw = await this.ctx.resolve(fontDict[resName]);
    const dict = isStream(raw) ? raw.dict : isDict(raw) ? raw : undefined;
    if (!dict) {
      this.warnOnce(`font:${resName}`, `字体资源 /${resName} 无法解析，该字体上的文本将按 Latin-1 直译`);
      return simpleFont(resName, {}, undefined);
    }
    return this.build(resName, dict);
  }

  dismiss(): void {
    this.cache.clear();
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.note(message);
  }

  private async build(resName: string, dict: PdfDict): Promise<Font> {
    const subtype = dictName(dict, 'Subtype') ?? '';
    const baseRaw = nameOf(dict.BaseFont) ?? '';
    const baseFont = stripSubsetPrefix(baseRaw);
    const isType0 = subtype === 'Type0';
    const toUnicode = await this.readToUnicode(dict.ToUnicode);

    if (isType0) {
      return this.buildComposite(resName, dict, subtype, baseFont, rawBase(baseRaw), toUnicode);
    }
    const simple = simpleFont(resName, dict, toUnicode);
    simple.subtype = subtype;
    simple.baseFont = baseFont;
    // 符号字体：没有 ToUnicode 也没法按编码表解出正确字符，只能记 warning
    if (!toUnicode && (baseFont.startsWith('Symbol') || baseFont.startsWith('ZapfDingbats'))) {
      this.warnOnce(
        `symbol:${baseFont}`,
        `符号字体 ${baseFont} 没有 /ToUnicode，提取出的字符可能是私用区码位（不影响版式，但复制文本会不准）`,
      );
      simple.approximate = true;
    }
    if (!toUnicode && !dict.Encoding) {
      this.warnOnce(
        `enc:${baseFont || resName}`,
        `字体 ${baseFont || resName} 既无 /ToUnicode 也无 /Encoding，文本按 Latin-1 直译`,
      );
      simple.approximate = true;
    }
    return simple;
  }

  /**
   * 读 /ToUnicode CMap。
   *
   * 关键：ToUnicode 流**几乎总是被 FlateDecode 压缩**（WPS/Word 导出的中文 PDF
   * 全是这样）。早期版本直接拿压缩字节去解析，`beginbfchar` 自然找不到，
   * 于是所有中文落到 CID 近似解码、提取出一页乱码。必须先解压。
   */
  private async readToUnicode(o: PdfObject | undefined): Promise<CMap | undefined> {
    if (o === undefined || o === null) return undefined;
    const raw = await this.ctx.resolve(o);
    if (!isStream(raw)) return undefined;
    const bytes = await this.ctx.decodeStream(raw.dict, raw.raw);
    if (!bytes || bytes.length === 0) {
      this.ctx.note('/ToUnicode 流解压失败，已退回基编码映射（该字体的文本可能不准）');
      return undefined;
    }
    const cmap = parseToUnicodeCMap(bytes);
    if (!cmap) this.ctx.note('/ToUnicode 流无法解析，已退回基编码映射');
    return cmap;
  }

  private buildComposite(
    resName: string,
    dict: PdfDict,
    subtype: string,
    baseFont: string,
    rawName: string,
    toUnicode: CMap | undefined,
  ): Font {
    const encName = dictName(dict, 'Encoding') ?? predefinedCMapName(dict.Encoding) ?? '';
    // Type0 的底层字体（DescendantFonts[0]）里才有 /W 宽度表与 /CIDSystemInfo
    const desc = firstDescendant(dict, this.ctx.resolveSync);
    const widths = parseCidWidths(desc ? arrayOf(desc.W) : undefined, this.ctx.resolveSync);
    const defaultWidth = desc ? (numOf(desc.DW) ?? 1000) : 1000;

    const encLower = encName.toLowerCase();
    let approximate = false;
    let decoder: CharDecoder;
    let hint = '';
    // 默认按 2 字节（Identity-H 是绝大多数中文 PDF 的情形）
    let bytesPerCode = 2;

    if (toUnicode) {
      decoder = cmapDecoder(toUnicode);
      bytesPerCode = toUnicode.codeLengths.length === 1 ? toUnicode.codeLengths[0] : 2;
    } else if (encLower.includes('ucs2') || encLower.includes('utf16')) {
      decoder = utf16Decoder;
      approximate = true;
      hint = '按 utf-16be';
    } else if (encLower.includes('gbk') || encLower.includes('gb-') || encLower.includes('gbpc') || encLower.includes('gb2312')) {
      decoder = gb18030TwoByteDecoder;
      approximate = true;
      hint = '按 gb18030（GBK-EUC-H 近似）';
    } else if (encLower.includes('big5') || encLower.includes('b5pc') || encLower.includes('etens')) {
      decoder = big5Decoder;
      approximate = true;
      hint = '按 big5';
    } else if (encLower.includes('jis') || encLower.includes('90ms') || encLower.includes('90pv')) {
      decoder = eucJpDecoder;
      approximate = true;
      hint = '按 euc-jp';
    } else if (encLower.includes('kr') || encLower.includes('ksc') || encLower.includes('uhc')) {
      decoder = eucKrDecoder;
      approximate = true;
      hint = '按 euc-kr';
    } else {
      // Identity-H/V 或没有 Encoding：先试 utf-16be，再退 gb18030。
      // 为什么是这个顺序：Adobe/WPS 生成的中文 PDF 在 Identity-H 下常常把
      // UTF-16 码元直接当 CID 用，此时 utf-16be 完全正确；而 gb18030 会把
      // 有效码位解成乱码。反过来（真 GBK 码流）用 utf-16be 也只是乱码，
      // 所以这里选择「先精确后近似」，并对近似路径记 warning。
      decoder = identityFallbackDecoder;
      approximate = true;
      hint = encName ? `Identity 映射 + ${encName}` : 'Identity 映射';
    }

    if (approximate && !toUnicode) {
      this.ctx.note(
        `Type0 字体 ${baseFont || resName} 缺少 /ToUnicode，字符已按 CID ${hint} 近似解码（可能有个别字不准）`,
      );
    }
    void rawName;

    const widthFromW = (code: number): number => {
      const w = widths.get(code);
      return w === undefined ? defaultWidth : w;
    };

    return {
      name: resName,
      baseFont,
      subtype,
      bytesPerCode,
      decoder,
      width: widthFromW,
      approximate,
    };
  }
}

/** 预定义 CMap 名（Encoding 是名字对象而不是字典时）。 */
function predefinedCMapName(o: PdfObject): string | undefined {
  return isName(o) ? o.name : undefined;
}

function rawBase(o: PdfObject): string {
  return nameOf(o) ?? '';
}

/** 去掉子集前缀：ABCDEF+Arial -> Arial */
export function stripSubsetPrefix(name: string): string {
  const m = /^[A-Z]{6}\+(.+)$/.exec(name);
  return m ? m[1] : name;
}

function firstDescendant(dict: PdfDict, resolve: (o: PdfObject) => PdfObject): PdfDict | undefined {
  const arr = arrayOf(dict.DescendantFonts);
  if (!arr || arr.length === 0) return undefined;
  const d = resolve(arr[0]);
  if (isStream(d)) return d.dict;
  return isDict(d) ? d : undefined;
}

/* ==================================================================== */
/* 简单字体                                                              */
/* ==================================================================== */

/**
 * 构造简单字体（单字节码）的映射表。
 *
 * 表长度固定 256。为什么用数组而不是 Map：一页内容流里字符码查表次数是
 * 「字符数」量级（几万到几十万），数组下标比 Map.get 快得多，而且 256 项的
 * 字符串数组只有几 KB。
 */
export function simpleFont(resName: string, dict: PdfDict, toUnicode: CMap | undefined): Font {
  const table: string[] = new Array(256).fill('');
  const enc = dict.Encoding;
  const encDict = isDict(enc) ? enc : undefined;
  // 基编码：Encoding 是字典时取它的 /BaseEncoding（缺省 StandardEncoding）。
  // ⚠ 顺序必须是「先铺基编码 + Latin-1 兜底，最后用 /Differences 覆盖」。
  // 早期版本先应用 Differences、再用 BaseEncoding 回填整张表，于是 Differences
  // 被基编码原样盖掉（症状：/Differences 写了 /bullet /Euro，提取出来却是 A、B）。
  const baseName =
    (encDict ? dictName(encDict, 'BaseEncoding') : dictName(dict, 'Encoding')) ?? 'StandardEncoding';
  const base = baseEncodingTable(baseName === 'MacExpertEncoding' ? 'StandardEncoding' : baseName);

  for (let c = 0; c < 256; c++) {
    const ch = lookupEncoding(base, c);
    table[c] = ch ?? '';
  }
  // Latin-1 兜底：高区没有定义的码位按 ISO-8859-1 直译。
  // 为什么这么做：很多中文 PDF 的英文段落用 /Encoding /WinAnsiEncoding，
  // 但 0x80..0x9F 段是空的；若返回空串就会把整段吃掉。
  for (let c = 0xa0; c < 256; c++) if (!table[c]) table[c] = String.fromCharCode(c);

  // /Differences 最后覆盖（必须在基编码之后，否则会被基编码回填冲掉）
  if (encDict) {
    const diffs = arrayOf(encDict.Differences);
    if (diffs) applyDifferences(table, diffs);
  } else if (isArray(enc)) {
    // 极少见但合法：Encoding 直接是 Differences 数组
    applyDifferences(table, enc);
  }

  if (toUnicode) {
    for (const [code, text] of toUnicode.single) {
      if (code >= 0 && code < 256) table[code] = text;
    }
    // bfrange 也必须对简单字体生效：早期只把 single（bfchar）铺进表里，
    // 于是 `<21> <23> <0042>` 这种区段映射被整段忽略，退回基编码（A!"# 而不是 BCD）。
    if (toUnicode.ranges.length > 0) {
      for (let c = 0; c < 256; c++) {
        const hit = lookupCMap(toUnicode, c);
        if (hit !== undefined) table[c] = hit;
      }
    }
  }

  // /Widths：/FirstChar 起连续 N 个宽度
  const widths = new Map<number, number>();
  const firstChar = numOf(dict.FirstChar);
  const warr = arrayOf(dict.Widths);
  if (warr && firstChar !== undefined) {
    for (let i = 0; i < warr.length; i++) {
      const w = numOf(warr[i]);
      if (w !== undefined) widths.set(firstChar + i, w);
    }
  }
  // Type3 的宽度来自 FontMatrix（单位是文本空间的千分之一 em）。
  // 这里只把它当作简单字体宽度口径的记录：/Widths 里的值本身就是 1/1000 em，
  // 与 FontMatrix 无关，因此不做换算，只保证不把 FontMatrix 误当宽度用。
  const decoder: CharDecoder = (bytes, i) => {
    const code = bytes[i];
    const text = table[code];
    return { text: text !== undefined && text !== '' ? text : String.fromCharCode(code), next: i + 1, code };
  };

  return {
    name: resName,
    baseFont: stripSubsetPrefix(nameOf(dict.BaseFont) ?? ''),
    subtype: dictName(dict, 'Subtype') ?? 'Type1',
    table,
    bytesPerCode: 1,
    decoder,
    width: (code: number) => widths.get(code) ?? DEFAULT_WIDTH,
    approximate: false,
  };
}

function applyDifferences(table: string[], diffs: PdfArray): void {
  let code = 0;
  for (const item of diffs) {
    const n = numOf(item);
    if (n !== undefined) {
      code = n;
      continue;
    }
    const nm = nameOf(item);
    if (nm === undefined) continue;
    if (code >= 0 && code < 256) {
      const u = glyphNameToUnicode(nm);
      // 映射不出来时保留码位直译（不写空串，否则会静默吃掉字符）
      table[code] = u ?? table[code] ?? String.fromCharCode(code);
    }
    code++;
  }
}

/* ==================================================================== */
/* 宽度                                                                */
/* ==================================================================== */

/**
 * 解析复合字体的 /W 数组：
 *   [ c [w1 w2 …] cfirst clast w  … ]
 * 展开成 Map<cid, width>。用 Map 而不是数组：CID 可以很大（几万），
 * 数组会浪费大量内存，而实际出现的 CID 是稀疏的。
 */
export function parseCidWidths(warr: PdfArray | undefined, resolve: (o: PdfObject) => PdfObject): Map<number, number> {
  const out = new Map<number, number>();
  if (!warr) return out;
  let i = 0;
  while (i < warr.length) {
    const first = numOf(resolve(warr[i]));
    if (first === undefined) {
      i++;
      continue;
    }
    const second = resolve(warr[i + 1]);
    if (isArray(second)) {
      for (let k = 0; k < second.length; k++) {
        const w = numOf(second[k]);
        if (w !== undefined) out.set(first + k, w);
      }
      i += 2;
      continue;
    }
    const last = numOf(second);
    const w = numOf(resolve(warr[i + 2]));
    if (last !== undefined && w !== undefined) {
      // 范围写法：为避免构造巨大 Map，超过 65536 个 CID 的范围只记录起止
      if (last - first <= 65535) {
        for (let c = first; c <= last; c++) out.set(c, w);
      } else {
        out.set(first, w);
        out.set(last, w);
      }
      i += 3;
      continue;
    }
    i++;
  }
  return out;
}

/* ==================================================================== */
/* 编码器（字符码 -> Unicode）                                           */
/* ==================================================================== */

const utf16Decoder: CharDecoder = (bytes, i) => {
  if (i + 1 >= bytes.length) {
    const b = bytes[i];
    return { text: String.fromCharCode(b), next: i + 1, code: b };
  }
  const code = (bytes[i] << 8) | bytes[i + 1];
  return { text: decodeUtf16Unit(code), next: i + 2, code };
};

function decodeUtf16Unit(code: number): string {
  // 孤立代理项在真实 PDF 里会出现（截断的字符串），按 U+FFFD 处理而不是抛错
  if (code >= 0xd800 && code <= 0xdbff) return String.fromCharCode(code);
  if (code >= 0xdc00 && code <= 0xdfff) return '\ufffd';
  return String.fromCharCode(code);
}

const gb18030TwoByteDecoder: CharDecoder = (bytes, i) => {
  const b = bytes[i];
  if (i + 1 >= bytes.length) {
    return { text: String.fromCharCode(b), next: i + 1, code: b };
  }
  const pair = bytes.subarray(i, i + 2);
  const s = safeDecode(gbDecoder(), pair);
  if (s) return { text: s, next: i + 2, code: (b << 8) | bytes[i + 1] };
  // 解不出来（例如其实是单字节 ASCII）：按单字节走
  return { text: String.fromCharCode(b), next: i + 1, code: b };
};

/** EUC 类编码：ASCII 单字节、高位双字节。 */
function makeEucDecoder(label: string): CharDecoder {
  let dec: TextDecoder | undefined;
  return (bytes, i) => {
    const b = bytes[i];
    if (b < 0x80) return { text: String.fromCharCode(b), next: i + 1, code: b };
    if (i + 1 >= bytes.length) return { text: String.fromCharCode(b), next: i + 1, code: b };
    dec ??= new TextDecoder(label, { fatal: false });
    const s = safeDecode(dec, bytes.subarray(i, i + 2));
    if (s) return { text: s, next: i + 2, code: (b << 8) | bytes[i + 1] };
    return { text: String.fromCharCode(b), next: i + 1, code: b };
  };
}

const big5Decoder = makeEucDecoder('big5');
const eucJpDecoder = makeEucDecoder('euc-jp');
const eucKrDecoder = makeEucDecoder('euc-kr');

/**
 * Identity 映射的兜底解码器。
 *
 * 为什么不能简单地固定 2 字节：Identity-H 下字符码是 2 字节 CID，但**不保证**
 * 偶数个字节就一定合法（可能有奇数字节的截断串）。这里逐码位试 utf-16be，
 * 若得到的是控制字符/私用区，再试 gb18030。目的是「宁可字符不准，也不要吐出
 * 一堆不可读的乱码」，同时把不确定性如实记进 warnings。
 */
const identityFallbackDecoder: CharDecoder = (bytes, i) => {
  const b0 = bytes[i];
  if (i + 1 >= bytes.length) {
    return { text: String.fromCharCode(b0), next: i + 1, code: b0 };
  }
  const code = (b0 << 8) | bytes[i + 1];
  // 常见 CID：ASCII 或 CJK 统一表意文字区间，直接按 Unicode 码位用
  if (code < 0x80) return { text: String.fromCharCode(code), next: i + 2, code };
  if (code >= 0x4e00 && code <= 0x9fff) return { text: String.fromCharCode(code), next: i + 2, code };
  if (code >= 0x3000 && code <= 0x303f) return { text: String.fromCharCode(code), next: i + 2, code };
  if (code >= 0xff00 && code <= 0xffef) return { text: String.fromCharCode(code), next: i + 2, code };
  if (code >= 0x2000 && code <= 0x206f) return { text: String.fromCharCode(code), next: i + 2, code };
  const s = safeDecode(gbDecoder(), bytes.subarray(i, i + 2));
  if (s && s.length === 1 && !isBadChar(s)) return { text: s, next: i + 2, code };
  return { text: decodeUtf16Unit(code), next: i + 2, code };
};

function isBadChar(s: string): boolean {
  const c = s.charCodeAt(0);
  if (c === 0xfffd) return true;
  // 私用区与未定义码位视为「解错了」
  if (c >= 0xe000 && c <= 0xf8ff) return true;
  return false;
}

function safeDecode(dec: TextDecoder, bytes: Uint8Array): string {
  try {
    const s = dec.decode(bytes);
    return s.includes('\ufffd') ? '' : s;
  } catch {
    return '';
  }
}

/* ==================================================================== */
/* ToUnicode CMap                                                        */
/* ==================================================================== */

export interface CMap {
  /** 单码映射：bfchar / bfrange 的单字符结果 */
  single: Map<number, string>;
  /** 区段映射（用于变长 CMap），按 lo 升序 */
  ranges: Array<{ lo: number; hi: number; base: string }>;
  /** codespace 声明的码长集合 */
  codeLengths: number[];
  /** 多字符映射（一个码位对应多个 Unicode 字符，如连字） */
  multi?: Map<number, string>;
}

/** 复合字体的字符码 -> Unicode 解码器（走 CMap）。 */
export function cmapDecoder(cmap: CMap): CharDecoder {
  const lengths = cmap.codeLengths.length ? cmap.codeLengths.slice().sort((a, b) => a - b) : [2];
  const maxLen = Math.min(4, Math.max(...lengths));
  return (bytes, i) => {
    // 变长 CMap：从短到长试，命中即用。固定长度的 CMap 只试一次。
    for (let k = 0; k < lengths.length; k++) {
      const len = lengths[k];
      if (i + len > bytes.length) continue;
      const code = readCode(bytes, i, len);
      const hit = lookupCMap(cmap, code);
      if (hit !== undefined) return { text: hit, next: i + len, code };
    }
    // 全都没命中：按最长码长前进，避免死循环；字符用 Latin-1 兜底
    const len = Math.max(1, Math.min(maxLen, bytes.length - i));
    const code = readCode(bytes, i, len);
    return { text: bytesToLatin1(bytes.subarray(i, i + len)).replace(/[\u0000-\u001f]/g, ''), next: i + len, code };
  };
}

function readCode(bytes: Uint8Array, i: number, len: number): number {
  let code = 0;
  for (let k = 0; k < len; k++) code = code * 256 + bytes[i + k];
  return code;
}

function lookupCMap(cmap: CMap, code: number): string | undefined {
  const direct = cmap.multi?.get(code) ?? cmap.single.get(code);
  if (direct !== undefined) return direct;
  const ranges = cmap.ranges;
  if (ranges.length === 0) return undefined;
  // 线性扫描：ranges 通常只有几十条（ToUnicode 里 bfrange 很少上百条），
  // 比每次构造二分查找更简单且够快。
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (code < r.lo || code > r.hi) continue;
    // bfrange 的目标是连续码点（规范：目标首字符 + 偏移）。
    // 偏移必须加在**最后一个** UTF-16 码元上（目标串可能是多字符，例如连字），
    // 早期版本固定取 charCodeAt(0)，多字符目标会从第一个字符开始递增。
    const base = r.base;
    const last = base.charCodeAt(base.length - 1);
    return base.slice(0, -1) + String.fromCharCode(last + (code - r.lo));
  }
  return undefined;
}

/**
 * 解析 /ToUnicode CMap。
 *
 * 只关心两件事：codespace 声明的码长、以及 bfchar/bfrange 的映射。
 * 之所以自己写而不是复用 xml 解析器：CMap 的语法是 `beginbfchar ... endbfchar`
 * 这种后置定界符的 PostScript 风格，用 XML 解析器反而更绕。
 */
export function parseToUnicodeCMap(bytes: Uint8Array): CMap | undefined {
  if (bytes.length === 0) return undefined;
  const text = bytesToLatin1(bytes);
  if (!/beginbfchar|beginbfrange|begincidchar|begincidrange/i.test(text)) return undefined;

  const cmap: CMap = { single: new Map(), ranges: [], codeLengths: [], multi: new Map() };
  const tokens = tokenizeCMap(text);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'begincodespacerange') {
      const end = findToken(tokens, i, 'endcodespacerange');
      for (let k = i + 1; k + 1 < (end < 0 ? tokens.length : end); k += 2) {
        const lo = parseHexToken(tokens[k]);
        if (lo < 0) break;
        const len = hexDigitCount(tokens[k]);
        if (len > 0 && !cmap.codeLengths.includes(len / 2)) cmap.codeLengths.push(len / 2);
      }
      i = end < 0 ? tokens.length : end;
      continue;
    }
    if (t === 'beginbfchar') {
      const end = findToken(tokens, i, 'endbfchar');
      const stop = end < 0 ? tokens.length : end;
      for (let k = i + 1; k + 1 < stop; k += 2) {
        const code = parseHexToken(tokens[k]);
        const dst = decodeCMapString(tokens[k + 1]);
        if (code < 0 || dst === undefined) continue;
        cmap.single.set(code, dst);
      }
      recordCodeLength(cmap, tokens, i + 1, stop, 2);
      i = stop;
      continue;
    }
    if (t === 'beginbfrange') {
      const end = findToken(tokens, i, 'endbfrange');
      const stop = end < 0 ? tokens.length : end;
      let k = i + 1;
      while (k < stop) {
        const lo = parseHexToken(tokens[k]);
        if (lo < 0) {
          k++;
          continue;
        }
        const hi = parseHexToken(tokens[k + 1]);
        if (hi < 0) {
          k++;
          continue;
        }
        const dstTok = tokens[k + 2];
        if (dstTok === undefined) break;
        if (dstTok.startsWith('[')) {
          // 目标数组形式：lo..hi 依次对应数组元素。规范禁止，但真实文件里有。
          const arr = readBracketArray(tokens, k + 2);
          for (let j = 0; j < arr.length && lo + j <= hi; j++) {
            if (arr[j] !== undefined) cmap.single.set(lo + j, arr[j]);
          }
          k += 2 + arr.length + (arr.length > 0 ? 1 : 0);
          continue;
        }
        const base = decodeCMapString(dstTok);
        if (base === undefined || base.length === 0) {
          k += 3;
          continue;
        }
        cmap.ranges.push({ lo, hi, base });
        k += 3;
      }
      // bfrange 是三元一组，只看每组的第一个（lo）才是源码长度
      recordCodeLength(cmap, tokens, i + 1, stop, 3);
      i = stop;
      continue;
    }
    // CID 类映射（/CIDToGIDMap 的另一半）对文本提取没用：它们是 CID 到 GID，
    // 不是 Unicode。忽略但不要报错。
  }

  if (cmap.codeLengths.length === 0) {
    // 没有 codespacerange 时按映射用到的最大码位推断码长
    let max = 0;
    for (const c of cmap.single.keys()) if (c > max) max = c;
    for (const r of cmap.ranges) if (r.hi > max) max = r.hi;
    if (max > 0xffff) cmap.codeLengths.push(4);
    else if (max > 0xff) cmap.codeLengths.push(2);
    else cmap.codeLengths.push(1);
  }
  if (cmap.single.size === 0 && cmap.ranges.length === 0) return undefined;
  return cmap;
}

/**
 * 从 bfchar/bfrange 区段里推断**源码**的字节长度。
 *
 * ⚠ 只能看「源」侧的 token：bfchar 是 `码 目标` 两两成对（取偶数位），
 * bfrange 是 `lo hi 目标` 三元一组（取每组第一个）。早期版本把区段里所有
 * `<...>` 都当成源码来统计，于是 1 字节的源码 + 2 字节的目标串被记为
 * 「码长 1 和 2」，解码器先试 1 字节解不出来、再按 2 字节前进 —— 直接把
 * 后面的字节吃掉，映射全错（症状：`<21> <23> <0042>` 这种 1 字节码的
 * CMap 解出来是 `A!"#` 而不是 `ABCD`）。
 */
function recordCodeLength(cmap: CMap, tokens: string[], from: number, to: number, stride: number): void {
  // codespacerange 已经声明了码长时，以它为准（那是规范给的信息，最可靠）
  if (cmap.codeLengths.length > 0) return;
  for (let k = from; k < to; k += stride) {
    const t = tokens[k];
    if (!t || !t.startsWith('<')) continue;
    // 源码必须位于组的第一个位置；组内其它位置是目标串
    const len = hexDigitCount(t) / 2;
    if (len >= 1 && len <= 4 && !cmap.codeLengths.includes(len)) cmap.codeLengths.push(len);
  }
  // 只保留最短的那个：同一个 CMap 里源码长度是固定的，
  // 出现多个值只可能是把目标串混了进来
  if (cmap.codeLengths.length > 1) cmap.codeLengths = [Math.min(...cmap.codeLengths)];
}

function findToken(tokens: string[], from: number, what: string): number {
  for (let i = from + 1; i < tokens.length; i++) if (tokens[i] === what) return i;
  return -1;
}

function hexDigitCount(t: string): number {
  if (!t.startsWith('<')) return 0;
  let n = 0;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) n++;
  }
  return n;
}

function parseHexToken(t: string | undefined): number {
  if (t === undefined || !t.startsWith('<')) return -1;
  let v = 0;
  let digits = 0;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    let d = -1;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
    if (d < 0) continue;
    v = v * 16 + d;
    digits++;
    if (digits > 8) break;
  }
  return digits === 0 ? -1 : v;
}

/**
 * 把 CMap 里的目标串（通常是 <XXXX> 的 UTF-16BE）解成 JS 字符串。
 * 注意：经常出现 <0000> 表示「无映射」，这种情况返回 undefined 让调用方跳过。
 */
function decodeCMapString(t: string | undefined): string | undefined {
  if (t === undefined) return undefined;
  if (!t.startsWith('<')) {
    // 也可能是字面量串，但 ToUnicode 里几乎不用；保守忽略
    return undefined;
  }
  const bytes: number[] = [];
  let hi = -1;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    let d = -1;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
    if (d < 0) continue;
    if (hi < 0) hi = d;
    else {
      bytes.push(hi * 16 + d);
      hi = -1;
    }
  }
  if (hi >= 0) bytes.push(hi * 16);
  if (bytes.length === 0) return undefined;
  // 全 0 视为「该码位无对应字符」
  let allZero = true;
  for (const b of bytes) if (b !== 0) allZero = false;
  if (allZero) return undefined;
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const u = (bytes[i] << 8) | bytes[i + 1];
    if (u === 0) continue;
    out += u >= 0xd800 && u <= 0xdfff ? String.fromCharCode(u) : String.fromCharCode(u);
  }
  if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]);
  return out.length ? out : undefined;
}

function readBracketArray(tokens: string[], at: number): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  // tokenizer 把 '[' 单独成一个 token，数组元素是后续的 <...>，直到 ']'
  let k = at + 1;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (t === ']') break;
    out.push(decodeCMapString(t));
  }
  return out;
}

/** CMap 的词法：把 `beginbfchar`、`<0041>`、`[` 等切成 token。 */
function tokenizeCMap(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '%') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '<') {
      const j = text.indexOf('>', i);
      if (j < 0) break;
      out.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '[' || c === ']') {
      out.push(c);
      i++;
      continue;
    }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !/[\s<>\[\]%]/.test(text[j])) j++;
    if (j === i) {
      i++;
      continue;
    }
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

/** 供 reader 做「这个字体是不是符号字体」判断。 */
export function isSymbolFontName(name: string): boolean {
  const base = stripSubsetPrefix(name);
  return base.startsWith('Symbol') || base.startsWith('ZapfDingbats');
}
