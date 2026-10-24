/**
 * 流解码：把 PDF 的 Filter 链还原成原始字节。
 *
 * 为什么这层要单独写：流解码是「能不能打开」的分水岭 —— FlateDecode 占绝对多数，
 * 但真实文件里 Flate / LZW / ASCIIHex / RunLength / 各种 Predictor 会混合出现。
 * 一个 Filter 不认识不能让整页失败，只能记 warning 并把原始字节交回。
 *
 * 明确不支持（如实记录，不做假动作）：
 *   - CCITTFaxDecode（G3/G4 传真编码）→ 标注为不支持，保留原始字节
 *   - JBIG2Decode → 同上
 */
import { concatBytes, hexVal } from './byteutils.ts';
import { dictName, isArray, isName, isStream, nameOf, numOf } from './objects.ts';
import type { PdfDict, PdfObject } from './objects.ts';

/** 解析 Filter，统一成不含前导斜杠的名字数组。 */
export function filterNames(dict: PdfDict): string[] {
  const f = dict.Filter ?? dict.F;
  if (f === undefined) return [];
  if (isName(f)) return [f.name];
  if (isArray(f)) {
    const out: string[] = [];
    for (const x of f) {
      const n = nameOf(x);
      // 规范允许 Filter 数组里出现 null，必须跳过（Adobe 自己的输出就有）
      if (n) out.push(n);
    }
    return out;
  }
  return [];
}

/** DecodeParms 与 Filter 一一对应，可能为 null 或单个 dict。 */
export function decodeParmsList(dict: PdfDict): Array<PdfDict | undefined> {
  const p = dict.DecodeParms ?? dict.DP;
  if (p === undefined || p === null) return [];
  if (isArray(p)) {
    return p.map((x) => (x && typeof x === 'object' && !Array.isArray(x) && !isName(x) ? (x as PdfDict) : undefined));
  }
  if (typeof p === 'object' && !Array.isArray(p) && !isName(p)) return [p as PdfDict];
  return [];
}

export interface DecodeResult {
  data: Uint8Array;
  /** 未能解码的过滤器名（调用方写进 warnings） */
  failed: string[];
  /** 已识别的图片编码，用于给出 mime（DCTDecode -> image/jpeg） */
  imageMime?: string;
  /** 该流本身就是一个可直接使用的图片编码（JPEG/JPX），不需要解出像素 */
  passthrough: boolean;
}

/** 过滤器名归一化：PDF 允许缩写（/Fl、/AHx、/LZW、/RL、/CCF、/DCT）。 */
function normalizeFilter(name: string): string {
  switch (name) {
    case 'Fl':
      return 'FlateDecode';
    case 'AHx':
      return 'ASCIIHexDecode';
    case 'A85':
      return 'ASCII85Decode';
    case 'LZW':
      return 'LZWDecode';
    case 'RL':
      return 'RunLengthDecode';
    case 'CCF':
      return 'CCITTFaxDecode';
    case 'DCT':
      return 'DCTDecode';
    default:
      return name;
  }
}

/**
 * 解码一条流。
 *
 * 设计取舍：这里返回「尽力而为」的结果。只要还有一层没解，就把当前已解出的
 * 字节交回并记录 failed —— 让文本层拿垃圾也要比整页空白好（真实场景里
 * 一个未知 Filter 常常包裹的是水印层，丢掉它不影响正文）。
 */
export async function decodeStream(dict: PdfDict, raw: Uint8Array): Promise<DecodeResult> {
  const names = filterNames(dict).map(normalizeFilter);
  const parms = decodeParmsList(dict);
  let data = raw;
  const failed: string[] = [];
  let imageMime: string | undefined;
  let passthrough = false;

  for (let i = 0; i < names.length; i++) {
    const f = names[i];
    const p = parms[i] ?? parms[0];
    switch (f) {
      case 'FlateDecode':
      case 'Fl': {
        const out = await inflate(data);
        if (out) data = applyPredictor(out, p);
        else failed.push(f);
        break;
      }
      case 'LZWDecode': {
        const out = lzwDecode(data, p?.EarlyChange);
        if (out) data = applyPredictor(out, p);
        else failed.push(f);
        break;
      }
      case 'ASCIIHexDecode':
        data = asciiHexDecode(data);
        break;
      case 'ASCII85Decode':
        data = ascii85Decode(data);
        break;
      case 'RunLengthDecode':
        data = runLengthDecode(data);
        break;
      case 'DCTDecode':
        // JPEG：直接把压缩字节当 image/jpeg 用，不需要（也不应该）解像素
        imageMime = 'image/jpeg';
        passthrough = i === names.length - 1;
        break;
      case 'JPXDecode':
        imageMime = 'image/jp2';
        passthrough = i === names.length - 1;
        break;
      case 'JBIG2Decode':
        imageMime = 'image/jbig2';
        passthrough = i === names.length - 1;
        failed.push('JBIG2Decode（不支持，保留原始字节）');
        break;
      case 'CCITTFaxDecode':
        failed.push('CCITTFaxDecode（G3/G4 传真编码不支持）');
        break;
      case 'Crypt':
        // /Crypt 只为 /Identity 时才是空操作；这里不实现解密
        failed.push('Crypt（流级加密不支持）');
        break;
      default:
        failed.push(`${f}（未知过滤器）`);
        break;
    }
  }
  return { data, failed, imageMime, passthrough };
}

/* ==================================================================== */
/* FlateDecode                                                          */
/* ==================================================================== */

/**
 * zlib 解压。
 *
 * 为什么要试两种：PDF 规范要求 FlateDecode 是 **zlib 格式**（带 2 字节头 + Adler32），
 * 但相当多的生成器（尤其是自己写 deflate 的库）直接塞了 **raw deflate**。
 * 所以先按 'deflate' 解，失败再按 'deflate-raw' 解 —— 反过来也行，只是
 * zlib 更常见，先试命中率更高的那个。
 */
export async function inflate(data: Uint8Array): Promise<Uint8Array | undefined> {
  const zlibTry = await tryDecompress(data, 'deflate');
  if (zlibTry) return zlibTry;
  // 有些文件在 zlib 流后面拖了垃圾（增量更新留下的残渣、写错的 EOL），
  // DecompressionStream 会直接报 "Trailing junk found after the end of the
  // compressed stream"。这时二分出一个能解的最大前缀 —— 见 longestInflatablePrefix。
  const trimmed = await longestInflatablePrefix(data, 'deflate');
  if (trimmed) return trimmed;
  // 规范要求 zlib 包装，但相当多生成器（自写 deflate 的库）直接塞 raw deflate
  const rawTry = await tryDecompress(data, 'deflate-raw');
  if (rawTry) return rawTry;
  const rawTrimmed = await longestInflatablePrefix(data, 'deflate-raw');
  return rawTrimmed ?? undefined;
}

async function tryDecompress(data: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array | undefined> {
  if (data.length === 0) return new Uint8Array(0);
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) chunks.push(value);
    }
    return chunks.length === 0 ? new Uint8Array(0) : chunks.length === 1 ? chunks[0] : concatBytes(chunks);
  } catch {
    return undefined;
  }
}

/**
 * 找出「能成功解压的最长前缀」。
 *
 * 为什么不解析 zlib 结构直接算长度：压缩块边界（尤其带预设字典/多块时）
 * 手写解析容易出错，而二分只需要 O(log n) 次解压尝试，且对畸形流的鲁棒性
 * 天然更好。仅在正常路径失败后才会走到这里，不影响热路径性能。
 */
async function longestInflatablePrefix(data: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array | undefined> {
  if (data.length < 8) return undefined;
  let ok = -1;
  let lo = 4;
  let hi = data.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const got = await tryDecompress(data.subarray(0, mid), format);
    if (got) {
      ok = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ok < 0) return undefined;
  // 再往后多吞几个字节，可能还能继续解（避免把合法尾部误判成垃圾）
  let best = await tryDecompress(data.subarray(0, ok), format);
  for (let extra = 1; extra <= 4 && ok + extra <= data.length; extra++) {
    const got = await tryDecompress(data.subarray(0, ok + extra), format);
    if (got) best = got;
  }
  return best;
}

/* ==================================================================== */
/* Predictor（PNG / TIFF 预测器）                                        */
/* ==================================================================== */

/**
 * 应用 Predictor。
 *
 * PDF 的 Predictor 有两种来源：
 *   - TIFF Predictor 2：同一行内相邻像素差分
 *   - PNG Predictor 10~15：每行前面 1 字节过滤器类型（None/Sub/Up/Average/Paeth）
 *
 * 这里的实现覆盖了 Predictor 1（无处理）与 2 / 10..15 的常见情形：
 * 8 位、单一颜色分量（也就是绝大多数 PDF 里 Predictor 的真实用法，
 * 因为它本来是给 xref 流和位图准备的）。其它组合按「尽力解」处理并保留原始数据。
 */
export function applyPredictor(data: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  if (!parms) return data;
  const predictor = numOf(parms.Predictor) ?? 1;
  if (predictor <= 1) return data;

  const colors = Math.max(1, numOf(parms.Colors) ?? 1);
  const bpc = Math.max(1, numOf(parms.BitsPerComponent) ?? 8);
  const columns = Math.max(1, numOf(parms.Columns) ?? 1);

  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8)); // bytes per pixel（>=1）
  const rowLen = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) return tiffPredictor(data, colors, bpc, columns, rowLen);
  return pngPredictor(data, rowLen, bpp, predictor);
}

function pngPredictor(data: Uint8Array, rowLen: number, bpp: number, predictor: number): Uint8Array {
  const stride = rowLen + 1;
  const rows = Math.floor(data.length / stride);
  if (rows === 0) return data;
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  let src = 0;
  for (let r = 0; r < rows; r++) {
    const ft = data[src];
    const row = data.subarray(src + 1, src + 1 + rowLen);
    const cur = new Uint8Array(rowLen);
    // PNG 规范：过滤器值在 0..4；但 PDF 里的 Predictor 值 10..15 会「隐含」过滤器，
    // 而某些生成器写的是 15 却只在行首放 0..4。行首字节合法（<=4）时以它为准。
    const ftUse = ft <= 4 ? ft : Math.max(0, predictor - 10) % 5;
    for (let i = 0; i < rowLen; i++) {
      const raw = row[i] ?? 0;
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i] ?? 0;
      const upLeft = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      let v: number;
      switch (ftUse) {
        case 1:
          v = raw + left;
          break;
        case 2:
          v = raw + up;
          break;
        case 3:
          v = raw + ((left + up) >> 1);
          break;
        case 4:
          v = raw + paeth(left, up, upLeft);
          break;
        default:
          v = raw;
          break;
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, r * rowLen);
    prev = cur;
    src += stride;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function tiffPredictor(data: Uint8Array, colors: number, bpc: number, columns: number, rowLen: number): Uint8Array {
  if (bpc !== 8) return data; // 非 8 位的 TIFF 预测器很少见，保守原样返回
  const rows = Math.floor(data.length / rowLen);
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const base = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const left = i >= colors ? out[base + i - colors] : 0;
      out[base + i] = (data[base + i] + left) & 0xff;
    }
  }
  void columns;
  return out;
}

/* ==================================================================== */
/* 其它过滤器                                                            */
/* ==================================================================== */

export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break; // '>'
    const v = hexVal(c);
    if (v < 0) continue; // 空白与非法字符都跳过
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return new Uint8Array(out);
}

export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // '~' 结束符
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) continue;
    if (c === 0x7a && count === 0) {
      // 'z' 表示 4 个 0 字节（整组）
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    tuple = tuple * 85 + (c - 0x21);
    count++;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 1) {
    // 不足 5 个字符：补 'u' 到 5 位，只输出 count-1 个字节
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    for (let k = 0; k < count - 1; k++) out.push(bytes[k]);
  }
  return new Uint8Array(out);
}

export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const l = data[i++];
    if (l === 128) break;
    if (l < 128) {
      for (let k = 0; k <= l && i < data.length; k++) out.push(data[i++]);
    } else {
      const n = 257 - l;
      const b = i < data.length ? data[i++] : 0;
      for (let k = 0; k < n; k++) out.push(b);
    }
  }
  return new Uint8Array(out);
}

/**
 * LZWDecode。
 * 为什么值得实现：PDF 1.1 时代的文件、以及一些扫描仪/传真软件的输出大量用 LZW。
 * EarlyChange=1（默认）表示码长在 511/1023/2047 处提前加一。
 */
export function lzwDecode(data: Uint8Array, earlyChange: PdfObject | undefined): Uint8Array | undefined {
  const early = numOf(earlyChange) ?? 1;
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []); // 256=clear, 257=eod
  };
  reset();
  let codeLen = 9;
  let bitPos = 0;
  let prev: number[] | null = null;

  const totalBits = data.length * 8;
  const readCode = (): number => {
    let code = 0;
    for (let k = 0; k < codeLen; k++) {
      const byteIdx = bitPos >> 3;
      if (byteIdx >= data.length) return -1;
      const bit = (data[byteIdx] >> (7 - (bitPos & 7))) & 1;
      code = (code << 1) | bit;
      bitPos++;
    }
    return code;
  };

  for (;;) {
    if (bitPos + codeLen > totalBits) break;
    const code = readCode();
    if (code < 0) break;
    if (code === 256) {
      reset();
      codeLen = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry: number[];
    if (code < dict.length && dict[code].length > 0) entry = dict[code];
    else if (code === dict.length && prev) entry = [...prev, prev[0]];
    else break; // 码流损坏：停止而不是抛错（调用方会记录 failed）
    for (const b of entry) out.push(b);
    if (prev) {
      dict.push([...prev, entry[0]]);
      const limit = (1 << codeLen) - (early ? 1 : 0);
      if (dict.length + 1 >= limit && codeLen < 12) codeLen++;
    }
    prev = entry;
    if (out.length > 256 * 1024 * 1024) return undefined; // 防御：解码炸弹
  }
  return new Uint8Array(out);
}

/* ==================================================================== */
/* 图片辅助                                                              */
/* ==================================================================== */

/** 从图片 XObject 的字典推出 mime；未知返回 undefined。 */
export function imageMimeOf(dict: PdfDict, filters: readonly string[]): string | undefined {
  for (const f of filters) {
    if (f === 'DCTDecode' || f === 'DCT') return 'image/jpeg';
    if (f === 'JPXDecode') return 'image/jp2';
    if (f === 'JBIG2Decode') return 'image/jbig2';
    if (f === 'CCITTFaxDecode' || f === 'CCF') {
      // 注意：**不是** image/tiff。CCITT G3/G4 是传真编码的位流，
      // 没有 TIFF 容器头，浏览器拿到会显示成破图。谎报 mime 比说「不支持」更糟。
      return 'image/x-ccitt';
    }
  }
  // 无过滤器：裸像素。按色彩空间/位深给出「裸位图」标记，渲染端需要自行理解。
  const cs = dict.ColorSpace;
  const isGray = isName(cs) && (cs.name === 'DeviceGray' || cs.name === 'G');
  if (isGray) return 'image/x-raw-gray';
  return 'image/x-raw';
}

export function isImageStream(o: PdfObject): boolean {
  return isStream(o) && dictName(o.dict, 'Subtype') === 'Image';
}

export function filtersOf(o: PdfObject): string[] {
  if (!isStream(o)) return [];
  return filterNames(o.dict);
}
