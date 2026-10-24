/**
 * 内嵌图片（data: URI）解码与尺寸探测。
 *
 * 为什么要自己解码 base64 而不用 atob/Buffer：
 *   - Buffer 是 Node 专有，浏览器里没有
 *   - atob 是浏览器专有，Node 里（未加 flag 时）没有
 *   本项目要同时跑在这两个环境，所以自备一个最小解码器（顺便能容忍换行、
 *   缺 padding、URL-safe 的 -_ 变体，这些在真实 HTML 里都出现过）。
 *
 * 尺寸：data: URI 里通常没有 width/height，若按 200×150 的默认值渲染，
 * 截图或二维码这类方形图会被拉变形。所以直接从文件头读出像素尺寸
 * （PNG/GIF/JPEG/BMP/WebP），再按 96dpi 换算。pt 是模型内唯一长度单位。
 */
import { pxToPt } from '../../core/src/units.ts';

export interface DataUri {
  mime: string;
  bytes: Uint8Array;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; // URL-safe 变体
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** 解码 base64 字符串。遇到非法字符就跳过（宽容优先，不抛错）。 */
export function decodeBase64(s: string): Uint8Array {
  const acc: number[] = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 128) continue;
    const v = B64_LOOKUP[c];
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      acc.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(acc);
}

/**
 * 解析 data: URI。
 * 支持 `data:[<mime>][;base64],<data>` 与百分号编码（`data:,hello%20world`）。
 * 不是 data: URI 或格式不合法时返回 undefined（调用方降级为占位图）。
 */
export function decodeDataUri(uri: string): DataUri | undefined {
  const m = /^data:([^,]*),([\s\S]*)$/.exec(uri.trim());
  if (!m) return undefined;
  const header = m[1];
  const payload = m[2];
  const parts = header.split(';');
  const mime = parts[0] && parts[0].includes('/') ? parts[0].toLowerCase() : 'text/plain';
  const isBase64 = parts.some((p) => p.trim().toLowerCase() === 'base64');
  if (isBase64) {
    const bytes = decodeBase64(payload);
    if (bytes.length === 0 && payload.trim() !== '') return undefined;
    return { mime, bytes };
  }
  try {
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return { mime, bytes: new TextEncoder().encode(payload) };
  }
}

export interface ImageSize {
  /** 像素宽高 */
  widthPx: number;
  heightPx: number;
  /** 换算成 pt（模型内单位） */
  widthPt: number;
  heightPt: number;
}

/**
 * 从字节头读出图片像素尺寸。识别不了就返回一个稳妥的默认值
 * （而不是抛错 —— 一张图读不出尺寸不该让文档打不开）。
 */
export function imageSizeFromBytes(mime: string, bytes: Uint8Array): ImageSize {
  const px = decodeSize(mime, bytes);
  const widthPx = px?.width ?? 200;
  const heightPx = px?.height ?? 150;
  return { widthPx, heightPx, widthPt: pxToPt(widthPx), heightPt: pxToPt(heightPx) };
}

function decodeSize(mime: string, b: Uint8Array): { width: number; height: number } | null {
  // PNG: 8 字节签名 + 4 字节长度 + "IHDR" + width(4) + height(4)
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: readU32(b, 16), height: readU32(b, 20) };
  }
  // GIF: "GIF87a"/"GIF89a" + 逻辑屏幕宽高（小端 16 位）
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: readU16(b, 6), height: readU16(b, 8) };
  }
  // BMP: "BM" + 文件头 14 字节后是 DIB 头，宽高为小端 32 位
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { width: readU32(b, 18), height: Math.abs(readI32(b, 22)) };
  }
  // WebP: RIFF....WEBP，三种子格式
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8 ') {
      const w = readU16(b, 26) & 0x3fff;
      const h = readU16(b, 28) & 0x3fff;
      if (w && h) return { width: w, height: h };
    }
    if (fourcc === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X' && b.length >= 30) {
      const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
      const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
      return { width: w, height: h };
    }
  }
  // JPEG: 扫 SOFn 段
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const j = jpegSize(b);
    if (j) return j;
  }
  void mime;
  return null;
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    // SOF0..SOF3、SOF5..SOF7、SOF9..SOF11、SOF13..SOF15 都带尺寸
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (isSof) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function readU16(b: Uint8Array, i: number): number {
  return ((b[i] << 8) | b[i + 1]) >>> 0;
}

function readU32(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function readI32(b: Uint8Array, i: number): number {
  const v = readU32(b, i);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}
