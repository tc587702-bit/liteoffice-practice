/**
 * 文本编码识别与增量解码。
 *
 * 纯文本家族没有「容器」也没有编码声明（HTML/XML 的 meta 声明另说），
 * 所以编码识别只能靠**嗅探 + 回退**。策略：
 *   1. BOM 最权威：UTF-8 / UTF-16LE / UTF-16BE 直接定案
 *   2. 否则先按 UTF-8 试解一段样本：UTF-8 是自校验编码，非法字节会出现 U+FFFD。
 *      替换字符占比超过阈值就判定「不是 UTF-8」，回退 gb18030（GBK 的超集）。
 *   3. 全都失败就按 latin1 硬解 —— 目标是「能打开看到内容」，不是还原编码真相。
 *
 * 为什么要先取样再整体解码：中文 Windows 上的 .txt/.csv 大量是 GBK。
 * 若直接按 UTF-8 全量解码，一个 200 MB 的日志会先产出一个装满 U+FFFD 的
 * 同样巨大的字符串，再被丢弃 —— 峰值内存瞬间翻倍。取样只需几毫秒。
 */

export interface DecodeResult {
  text: string;
  /** 实际使用的编码标签，进 warnings 供诊断 */
  encoding: string;
}

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'latin1';

/** 每种编码的 BOM（字节序列） */
function bomOf(bytes: Uint8Array): { encoding: TextEncoding; skip: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', skip: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', skip: 2 };
  return null;
}

/** 构造解码器；GBK/GB18030 的标签名在不同运行时略有差异，失败即回退 UTF-8。 */
export function makeDecoder(encoding: TextEncoding, fatal = false): TextDecoder {
  const candidates: string[] =
    encoding === 'gb18030' ? ['gb18030', 'gbk', 'gb2312'] : encoding === 'latin1' ? ['windows-1252', 'latin1'] : [encoding];
  for (const label of candidates) {
    try {
      return new TextDecoder(label, { fatal });
    } catch {
      /* 该运行时没有这个编码，试下一个 */
    }
  }
  return new TextDecoder('utf-8', { fatal });
}

/**
 * 判断样本是不是「好 UTF-8」。
 *
 * 不用 fatal 解码抛异常来判断，而是数替换字符：浏览器与 Node 对 fatal 的支持
 * 一致，但替换字符计数能顺便给出「坏到什么程度」，而 GBK 文本恰好经常
 * 只出现少量坏字节（ASCII 段正常），一刀切会误判。
 */
export function looksLikeUtf8(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const text = makeDecoder('utf-8').decode(bytes);
  if (text.length === 0) return true;
  const bad = countChar(text, '\ufffd');
  if (bad === 0) return true;
  return bad / text.length < 0.01;
}

/** 统计 UTF-16 里的 NUL 字节比例，用于识别「无 BOM 的 UTF-16」。 */
function looksLikeUtf16(bytes: Uint8Array): TextEncoding | null {
  const n = Math.min(bytes.length, 4096);
  if (n < 8) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i + 1 < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n >> 1;
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return 'utf-16be';
  return null;
}

function countChar(text: string, ch: string): number {
  let n = 0;
  let i = text.indexOf(ch);
  while (i >= 0) {
    n++;
    i = text.indexOf(ch, i + 1);
  }
  return n;
}

export function detectEncoding(bytes: Uint8Array, sampleBytes = 65536): TextEncoding {
  const bom = bomOf(bytes);
  if (bom) return bom.encoding;
  const sample = bytes.subarray(0, Math.min(bytes.length, sampleBytes));
  const utf16 = looksLikeUtf16(sample);
  if (utf16) return utf16;
  if (looksLikeUtf8(sample)) return 'utf-8';
  return 'gb18030';
}

/** 去掉 BOM 后再解码。 */
export function decodeBytes(bytes: Uint8Array, sampleBytes = 65536): DecodeResult {
  const bom = bomOf(bytes);
  const encoding = bom ? bom.encoding : detectEncoding(bytes, sampleBytes);
  const body = bom ? bytes.subarray(bom.skip) : bytes;
  return { text: makeDecoder(encoding).decode(body), encoding };
}

/**
 * 流式解码：按块喂 TextDecoder（{stream:true} 保证跨块的多字节序列不被打断）。
 * 这是「大文件低内存」路径的核心：原始字节与解码结果都不会被同时整份持有 ——
 * 调用方可以边解边消费，只保留当前窗口。
 */
export async function* decodeChunks(
  bytes: Uint8Array,
  chunkBytes = 262144,
  encoding?: TextEncoding,
): AsyncGenerator<string> {
  const enc = encoding ?? detectEncoding(bytes);
  const decoder = makeDecoder(enc);
  const bom = bomOf(bytes);
  let pos = enc === bom?.encoding ? bom.skip : 0;
  while (pos < bytes.length) {
    const end = Math.min(pos + chunkBytes, bytes.length);
    yield decoder.decode(bytes.subarray(pos, end), { stream: end < bytes.length });
    pos = end;
  }
}
