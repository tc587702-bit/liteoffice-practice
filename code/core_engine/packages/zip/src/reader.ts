/**
 * ZipReader —— 只解析「中央目录」，不解压任何内容。
 *
 * 内存策略（这是 LiteOffice 相对 WPS 的核心差异之一）：
 *   - open() 只扫描文件尾部的中央目录，O(条目数) 而非 O(文件体积)
 *   - 条目数据始终以 subarray 视图存在，不复制
 *   - 解压走原生 DecompressionStream，逐块产出，峰值内存与「单个条目」同阶
 *     而不是与「整个文档」同阶
 */
import { ByteView, decodeName, ZIP_SIG } from './bytes.ts';
import { crc32 } from './crc32.ts';

export interface ZipEntry {
  /** 条目路径，如 "word/document.xml" */
  name: string;
  /** 0 = 存储, 8 = deflate */
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 本地头在文件中的偏移 */
  localHeaderOffset: number;
  isDir: boolean;
  encrypted: boolean;
  /** 压缩率，用于诊断与基准测试 */
  ratio: number;
}

export interface ZipOpenOptions {
  /** 安全阀：单个条目解压后允许的最大字节数，默认 256 MiB */
  maxEntryBytes?: number;
  /** 安全阀：中央目录最多接受多少条目，默认 65536 */
  maxEntries?: number;
}

export class ZipError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const DEFAULT_MAX_ENTRY = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 65536;

export class ZipReader {
  readonly bytes: Uint8Array;
  readonly options: Required<ZipOpenOptions>;

  private readonly byName = new Map<string, ZipEntry>();
  private readonly list: ZipEntry[] = [];

  private constructor(bytes: Uint8Array, options: Required<ZipOpenOptions>) {
    this.bytes = bytes;
    this.options = options;
  }

  static open(input: Uint8Array | ArrayBuffer, options: ZipOpenOptions = {}): ZipReader {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const opts = {
      maxEntryBytes: options.maxEntryBytes ?? DEFAULT_MAX_ENTRY,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    };
    const reader = new ZipReader(bytes, opts);
    reader.parseCentralDirectory();
    return reader;
  }

  get entries(): readonly ZipEntry[] {
    return this.list;
  }

  /**
   * 条目路径列表。
   * 存在这个 getter 是为了让 ZipReader **结构上**满足
   * @liteoffice/core 的 ContainerAccess 接口 —— 于是 core 不必 import 本包，
   * 保持零依赖契约层，也不需要任何适配器。
   */
  get entryNames(): string[] {
    return this.list.map((e) => e.name);
  }

  /** 单条目解压后字节数；不存在返回 0。 */
  entrySize(name: string): number {
    return this.find(name)?.uncompressedSize ?? 0;
  }

  get size(): number {
    return this.list.length;
  }

  has(name: string): boolean {
    return this.byName.has(normalizeName(name));
  }

  find(name: string): ZipEntry | undefined {
    return this.byName.get(normalizeName(name));
  }

  /** 按前缀列出条目，例如 "word/" 或 "xl/worksheets/" */
  list(prefix = ''): ZipEntry[] {
    return prefix ? this.list.filter((e) => e.name.startsWith(prefix)) : [...this.list];
  }

  /** 未压缩总字节数，用于在真正解压前预估内存压力。 */
  get totalUncompressedSize(): number {
    let n = 0;
    for (const e of this.list) n += e.uncompressedSize;
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* 读取                                                                */
  /* ------------------------------------------------------------------ */

  /** 取出条目的压缩数据视图（零拷贝）。 */
  private rawData(entry: ZipEntry): Uint8Array {
    const v = new ByteView(this.bytes, entry.localHeaderOffset);
    if (v.u32() !== ZIP_SIG.local) {
      throw new ZipError(`本地头签名错误: ${entry.name}`, 'BAD_LOCAL_HEADER');
    }
    v.skip(2 + 2 + 2 + 2 + 2 + 4 + 4 + 4); // version, flags, method, time, date, crc, csize, usize
    const nameLen = v.u16();
    const extraLen = v.u16();
    v.skip(nameLen + extraLen);
    const start = v.offset;
    const end = start + entry.compressedSize;
    if (end > this.bytes.length) {
      throw new ZipError(`条目数据越界: ${entry.name}`, 'TRUNCATED');
    }
    return this.bytes.subarray(start, end);
  }

  /** 整个条目解压为字节。受 maxEntryBytes 保护。 */
  async read(entry: ZipEntry | string): Promise<Uint8Array> {
    const e = this.resolve(entry);
    if (e.uncompressedSize > this.options.maxEntryBytes) {
      throw new ZipError(
        `条目 ${e.name} 解压后将达 ${(e.uncompressedSize / 1048576).toFixed(1)} MiB，超过上限 ${(this.options.maxEntryBytes / 1048576).toFixed(0)} MiB`,
        'TOO_LARGE',
      );
    }
    const raw = this.rawData(e);
    if (e.method === 0) return raw;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const c of this.inflateAll(raw)) {
      chunks.push(c);
      total += c.length;
      if (total > this.options.maxEntryBytes) {
        throw new ZipError(`条目 ${e.name} 解压超出上限`, 'TOO_LARGE');
      }
    }
    if (chunks.length === 1) return chunks[0];
    return concat(chunks, total);
  }

  /** 整个条目解压为文本。 */
  async text(entry: ZipEntry | string): Promise<string> {
    const bytes = await this.read(entry);
    // XML 声明可能写 encoding="UTF-8"（含 BOM）；OOXML/ODF 实际均为 UTF-8。
    const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return new TextDecoder('utf-8').decode(start ? bytes.subarray(start) : bytes);
  }

  /** 解析为 JSON（用于 ODF 之外的 .json 部件与测试）。 */
  async json<T = unknown>(entry: ZipEntry | string): Promise<T> {
    return JSON.parse(await this.text(entry)) as T;
  }

  /**
   * 流式解压：用于超大部件（例如 50 MB 的 sheet1.xml）。
   * 调用方可以边读边丢，峰值内存不随条目体积线性增长。
   */
  stream(entry: ZipEntry | string): ReadableStream<Uint8Array> {
    const e = this.resolve(entry);
    const raw = this.rawData(e);
    if (e.method === 0) {
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(raw);
          c.close();
        },
      });
    }
    return new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  }

  /**
   * 流式解压并解码为**字符串**块，适合按块扫描大 XML。
   * 注意：产出的是字符串，不能直接作为 Response/Blob 的 body（它们只收字节块）。
   * 需要字节时用 stream()。
   */
  streamText(entry: ZipEntry | string): ReadableStream<string> {
    return this.stream(entry).pipeThrough(new TextDecoderStream('utf-8'));
  }

  /** 校验条目 CRC，用于自检与测试。 */
  async verify(entry: ZipEntry | string): Promise<boolean> {
    const e = this.resolve(entry);
    return crc32(await this.read(e)) === e.crc32;
  }

  private resolve(entry: ZipEntry | string): ZipEntry {
    if (typeof entry !== 'string') return entry;
    const found = this.find(entry);
    if (!found) throw new ZipError(`未找到条目: ${entry}`, 'ENTRY_NOT_FOUND');
    return found;
  }

  /** 原生 raw-deflate 流式解压。逐块产出，不缓存整个结果。 */
  private async *inflateAll(raw: Uint8Array): AsyncGenerator<Uint8Array> {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) yield value;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 中央目录                                                            */
  /* ------------------------------------------------------------------ */

  private parseCentralDirectory(): void {
    const eocd = this.findEocd();
    let entryCount = eocd.count;
    let cdOffset = eocd.offset;
    let cdSize = eocd.size;

    // ZIP64：EOCD 字段被填成哨兵值时，回退读取 ZIP64 记录
    if (eocd.needsZip64) {
      const z64 = this.findZip64(eocd.recordOffset);
      if (z64) {
        entryCount = z64.count;
        cdOffset = z64.offset;
        cdSize = z64.size;
      }
    }

    if (entryCount > this.options.maxEntries) {
      throw new ZipError(`条目数 ${entryCount} 超过上限 ${this.options.maxEntries}`, 'TOO_MANY_ENTRIES');
    }

    const v = new ByteView(this.bytes, cdOffset);
    const cdEnd = cdOffset + cdSize;
    while (v.offset + 46 <= cdEnd && this.list.length < entryCount) {
      const sig = v.u32();
      if (sig !== ZIP_SIG.central) break;
      v.skip(2 + 2); // versionMadeBy, versionNeeded
      const flags = v.u16();
      const method = v.u16();
      v.skip(2 + 2); // time, date
      const crc = v.u32();
      let compressedSize = v.u32();
      let uncompressedSize = v.u32();
      const nameLen = v.u16();
      const extraLen = v.u16();
      const commentLen = v.u16();
      v.skip(2 + 2 + 4); // diskStart, internalAttrs, externalAttrs
      let localHeaderOffset = v.u32();
      const nameBytes = v.slice(nameLen);
      const extra = v.slice(extraLen);
      v.skip(commentLen);

      // ZIP64 扩展字段按需覆盖哨兵值
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        const z = parseZip64Extra(extra);
        if (z) {
          if (uncompressedSize === 0xffffffff) uncompressedSize = z.uncompressedSize ?? uncompressedSize;
          if (compressedSize === 0xffffffff) compressedSize = z.compressedSize ?? compressedSize;
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = z.localHeaderOffset ?? localHeaderOffset;
        }
      }

      const name = decodeName(nameBytes, (flags & 0x0800) !== 0);
      const entry: ZipEntry = {
        name,
        method: method === 8 ? 8 : 0,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isDir: name.endsWith('/'),
        encrypted: (flags & 0x0001) !== 0,
        ratio: uncompressedSize > 0 ? compressedSize / uncompressedSize : 1,
      };
      this.list.push(entry);
      if (!entry.isDir) this.byName.set(normalizeName(name), entry);
    }

    if (this.list.length === 0) throw new ZipError('中央目录为空或损坏', 'EMPTY_DIRECTORY');
  }

  private findEocd(): { count: number; size: number; offset: number; recordOffset: number; needsZip64: boolean } {
    const bytes = this.bytes;
    const min = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        const v = new ByteView(bytes, i + 4);
        v.skip(2 + 2); // diskNum, cdDiskNum
        const countOnDisk = v.u16();
        const total = v.u16();
        const size = v.u32();
        const offset = v.u32();
        const count = total || countOnDisk;
        const needsZip64 = count === 0xffff || size === 0xffffffff || offset === 0xffffffff;
        return { count, size, offset, recordOffset: i, needsZip64 };
      }
    }
    throw new ZipError('未找到 EOCD 记录（不是 ZIP 文件或已损坏）', 'NO_EOCD');
  }

  private findZip64(eocdOffset: number): { count: number; size: number; offset: number } | null {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset < 0) return null;
    const v = new ByteView(this.bytes, locatorOffset);
    if (v.u32() !== ZIP_SIG.eocd64Locator) return null;
    v.skip(4); // disk with zip64 eocd
    const z64Offset = v.u64();
    const w = new ByteView(this.bytes, z64Offset);
    if (w.u32() !== ZIP_SIG.eocd64) return null;
    w.skip(4 + 2 + 2 + 4 + 4); // size, versionMade, versionNeeded, disk, cdDisk
    w.skip(8 + 8); // entriesOnDisk, totalEntries (u64 each)
    const size = w.u64();
    const offset = w.u64();
    const total = new ByteView(this.bytes, z64Offset + 32).u64();
    return { count: total, size, offset };
  }
}

function parseZip64Extra(extra: Uint8Array): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } | null {
  let o = 0;
  while (o + 4 <= extra.length) {
    const id = extra[o] | (extra[o + 1] << 8);
    const size = extra[o + 2] | (extra[o + 3] << 8);
    if (id === 0x0001) {
      const v = new ByteView(extra, o + 4);
      const end = o + 4 + size;
      const out: { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } = {};
      if (v.offset + 8 <= end) out.uncompressedSize = v.u64();
      if (v.offset + 8 <= end) out.compressedSize = v.u64();
      if (v.offset + 8 <= end) out.localHeaderOffset = v.u64();
      return out;
    }
    o += 4 + size;
  }
  return null;
}

/** ZIP 路径统一为 POSIX 风格，兼容以 "/" 开头的异常写入器。 */
function normalizeName(name: string): string {
  const n = name.replace(/\\/g, '/');
  return n.startsWith('/') ? n.slice(1) : n;
}

export function concat(chunks: readonly Uint8Array[], total?: number): Uint8Array {
  const size = total ?? chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
