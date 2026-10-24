/**
 * ZipWriter —— 用于写出 OOXML / ODF 容器（测试夹具、未来「另存为」）。
 *
 * 同样零依赖：压缩走原生 CompressionStream('deflate-raw')。
 * 注意：OOXML 的 [Content_Types].xml 必须是第一个条目，ODF 的 mimetype
 * 必须是第一个且「存储不压缩」，这里通过 addFirst / store 显式支持。
 */
import { crc32 } from './crc32.ts';
import { concat } from './reader.ts';

export interface ZipWriteOptions {
  /** true = 不压缩直接存储（ODF 的 mimetype 条目要求） */
  store?: boolean;
  /** 覆盖条目的修改时间 */
  date?: Date;
}

interface PendingEntry {
  name: string;
  data: Uint8Array;
  store: boolean;
  date: Date;
}

const utf8 = new TextEncoder();

export class ZipWriter {
  private readonly entries: PendingEntry[] = [];

  /** 追加一个条目。name 使用 POSIX 风格路径。 */
  add(name: string, data: Uint8Array | string, options: ZipWriteOptions = {}): this {
    const bytes = typeof data === 'string' ? utf8.encode(data) : data;
    this.entries.push({
      name: name.replace(/\\/g, '/').replace(/^\//, ''),
      data: bytes,
      store: options.store ?? false,
      date: options.date ?? new Date(),
    });
    return this;
  }

  /** 保证条目排在第一位（OOXML 的 [Content_Types].xml、ODF 的 mimetype）。 */
  addFirst(name: string, data: Uint8Array | string, options: ZipWriteOptions = {}): this {
    const snapshot = this.entries.splice(0, this.entries.length);
    this.add(name, data, options);
    const [first] = this.entries.splice(0, 1);
    this.entries.push(first, ...snapshot);
    return this;
  }

  get size(): number {
    return this.entries.length;
  }

  /** 生成完整的 ZIP 字节流。 */
  async build(): Promise<Uint8Array> {
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let offset = 0;

    for (const e of this.entries) {
      const nameBytes = utf8.encode(e.name);
      const crc = crc32(e.data);
      const stored = e.store ? e.data : await deflateRaw(e.data);
      const method = e.store ? 0 : 8;
      const { time, date } = dosDateTime(e.date);

      // 本地文件头
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // 通用标志：文件名为 UTF-8
      lv.setUint16(8, method, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, stored.length, true);
      lv.setUint32(22, e.data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true); // extra length
      lh.set(nameBytes, 30);

      localParts.push(lh, stored);

      // 中央目录项
      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 0x031e, true); // version made by (UNIX, 3.0)
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, stored.length, true);
      cv.setUint32(24, e.data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); // extra
      cv.setUint16(32, 0, true); // comment
      cv.setUint16(34, 0, true); // disk
      cv.setUint16(36, 0, true); // internal attrs
      cv.setUint32(38, e.name.endsWith('/') ? 0x10 : 0, true); // external attrs
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      centralParts.push(ch);

      offset += lh.length + stored.length;
    }

    const central = concat(centralParts);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, this.entries.length, true);
    ev.setUint16(10, this.entries.length, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return concat([...localParts, central, eocd]);
  }
}

/** 用原生 CompressionStream 做 raw deflate。 */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (data.length === 0) return new Uint8Array(0);
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      chunks.push(value);
      total += value.length;
    }
  }
  return chunks.length === 1 ? chunks[0] : concat(chunks, total);
}

/** JS Date -> MS-DOS 时间/日期对（ZIP 本地时间，无时区）。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((Math.max(0, year - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
