/**
 * 最小可用的 ZIP 读写实现（store，不压缩）。
 * 用于解析 docx / xlsx / pptx 内嵌 XML 与媒体，以及回写 docx。
 * 纯前端、无外部依赖，全部基于浏览器原生 DecompressionStream。
 */

export interface ZipEntry {
  name: string
  data: Uint8Array
  compressed: boolean
}

export interface ZipArchive {
  entries: Map<string, ZipEntry>
  names: string[]
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

function readU16(view: DataView, offset: number) {
  return view.getUint16(offset, true)
}
function readU32(view: DataView, offset: number) {
  return view.getUint32(offset, true)
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as unknown as { DecompressionStream?: new (format: string) => DecompressionStream })
    .DecompressionStream
  if (!Ctor) {
    throw new Error('当前浏览器不支持解压（DecompressionStream 不可用）')
  }
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new Ctor('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

function normalizeName(name: string) {
  return name.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/** 解析 zip 二进制。遇到损坏的单个条目只跳过该条目，不抛错。 */
export async function unzip(buffer: ArrayBuffer): Promise<ZipArchive> {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let eocd = -1
  const scanStart = Math.max(0, bytes.length - 66000)
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (readU32(view, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）')

  const total = readU16(view, eocd + 10)
  let offset = readU32(view, eocd + 16)
  const entries = new Map<string, ZipEntry>()
  const names: string[] = []

  for (let i = 0; i < total; i++) {
    if (offset + 46 > bytes.length) break
    if (readU32(view, offset) !== 0x02014b50) break
    const method = readU16(view, offset + 10)
    const compressedSize = readU32(view, offset + 20)
    const uncompressedSize = readU32(view, offset + 24)
    const nameLen = readU16(view, offset + 28)
    const extraLen = readU16(view, offset + 30)
    const commentLen = readU16(view, offset + 32)
    const localOffset = readU32(view, offset + 42)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    try {
      if (localOffset + 30 > bytes.length) continue
      if (readU32(view, localOffset) !== 0x04034b50) continue
      const localNameLen = readU16(view, localOffset + 26)
      const localExtraLen = readU16(view, localOffset + 28)
      const start = localOffset + 30 + localNameLen + localExtraLen
      const raw = bytes.subarray(start, start + compressedSize)
      let data: Uint8Array
      if (method === 0) {
        data = raw.slice()
      } else if (method === 8) {
        data = await inflateRaw(raw)
      } else {
        continue
      }
      if (uncompressedSize && data.length !== uncompressedSize && method === 0) continue
      const norm = normalizeName(name)
      names.push(name)
      entries.set(norm, { name, data, compressed: method === 8 })
    } catch {
      // 单个条目失败：跳过，不中断整包解析
      continue
    }
  }

  return { entries, names }
}

export function entryText(archive: ZipArchive | null, path: string): string | null {
  if (!archive) return null
  const entry = archive.entries.get(normalizeName(path))
  if (!entry) return null
  return decoder.decode(entry.data)
}

export function entryBytes(archive: ZipArchive | null, path: string): Uint8Array | null {
  if (!archive) return null
  const entry = archive.entries.get(normalizeName(path))
  return entry ? entry.data : null
}

export function listByPrefix(archive: ZipArchive | null, prefix: string): string[] {
  if (!archive) return []
  const normalized = normalizeName(prefix)
  return archive.names.filter((name) => normalizeName(name).startsWith(normalized))
}

/* ------------------------------------------------------------------ */
/* CRC32                                                               */
/* ------------------------------------------------------------------ */

let crcTable: Uint32Array | null = null
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/** 打包为 ZIP（store）。用于 docx 回写导出。 */
export function zip(files: { name: string; content: string | Uint8Array }[]): Uint8Array {
  const now = new Date()
  const { time, day } = dosDateTime(now)
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, 0, true)
    lv.setUint16(10, time, true)
    lv.setUint16(12, day, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)

    chunks.push(local, data)

    const cd = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, day, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    cd.set(nameBytes, 46)
    central.push(cd)

    offset += local.length + data.length
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + centralSize + end.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of [...chunks, ...central, end]) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

export function hasZipHeader(data: Uint8Array | ArrayBuffer): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return (
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  )
}
