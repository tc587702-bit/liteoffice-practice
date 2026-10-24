/**
 * CRC-32 (IEEE 802.3) —— ZIP 校验与写入都需要。
 * 表驱动实现，查表法比逐位快约 8 倍。
 */

let TABLE: Uint32Array | null = null;

function table(): Uint32Array {
  if (TABLE) return TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  TABLE = t;
  return t;
}

export function crc32(data: Uint8Array, seed = 0): number {
  const t = table();
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
