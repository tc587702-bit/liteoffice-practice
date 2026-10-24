/**
 * 共享的字节读取工具。所有多字节字段在 ZIP 中均为小端序。
 */
export class ByteView {
  readonly bytes: Uint8Array;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }

  u16(): number {
    const o = this.offset;
    if (o + 2 > this.bytes.length) throw new RangeError(`u16 越界 @${o}`);
    this.offset = o + 2;
    return this.bytes[o] | (this.bytes[o + 1] << 8);
  }

  u32(): number {
    const o = this.offset;
    if (o + 4 > this.bytes.length) throw new RangeError(`u32 越界 @${o}`);
    this.offset = o + 4;
    return (this.bytes[o] | (this.bytes[o + 1] << 8) | (this.bytes[o + 2] << 16) | (this.bytes[o + 3] << 24)) >>> 0;
  }

  u64(): number {
    const lo = this.u32();
    const hi = this.u32();
    // ZIP64 尺寸理论上可超 2^53，实际文档不会；超出则明确报错而不是静默丢精度。
    if (hi > 0x001fffff) throw new RangeError('ZIP64 字段超出 JS 安全整数范围');
    return hi * 0x100000000 + lo;
  }

  slice(n: number): Uint8Array {
    const o = this.offset;
    if (o + n > this.bytes.length) throw new RangeError(`slice 越界 @${o}+${n}`);
    this.offset = o + n;
    return this.bytes.subarray(o, o + n);
  }

  skip(n: number): void {
    this.offset += n;
  }
}

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

/** ZIP 未置 UTF-8 标志位时按 CP437 处理；这里退化为 latin1，足以保证不抛错。 */
export function decodeName(bytes: Uint8Array, isUtf8: boolean): string {
  const end = bytes.indexOf(0);
  const b = end >= 0 ? bytes.subarray(0, end) : bytes;
  return (isUtf8 ? utf8 : latin1).decode(b);
}

export const ZIP_SIG = {
  local: 0x04034b50,
  central: 0x02014b50,
  eocd: 0x06054b50,
  eocd64: 0x06064b50,
  eocd64Locator: 0x07064b50,
} as const;
