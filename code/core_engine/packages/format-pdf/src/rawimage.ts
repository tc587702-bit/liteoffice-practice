/**
 * 把「裸像素」图片转成浏览器能显示的 BMP。
 *
 * 背景：PDF 里的图片有三种常见形态
 *   1. `DCTDecode`  → 本身就是 JPEG，直接给 `image/jpeg` 即可显示
 *   2. `JPXDecode` / `JBIG2Decode` / `CCITTFaxDecode` → 需要专门解码器，本轮不支持
 *   3. **无过滤器或 FlateDecode** → 解出来的是**原始像素**（DeviceRGB/DeviceGray 采样），
 *      没有任何容器格式。浏览器把它当图片是**显示不出来**的
 *      （实测：一份图文教程 47 张图全是这种，用户看到的就是「图片打不开」）。
 *
 * 所以这里把第 3 类包一层 BMP 容器。选 BMP 而不是 PNG 的原因：
 *   - BMP 不需要压缩、不需要 CRC，纯字节拼装，出错面最小
 *   - 浏览器原生支持 `image/bmp`
 *   - PNG 需要 zlib + CRC32（虽然 packages/zip 里有），但会让 format-pdf
 *     依赖 zip 包 —— 一个解析器不该为了画一张图去依赖压缩包模块
 *
 * 只处理最常见的情形：8 位/分量 + DeviceRGB 或 DeviceGray。
 * 其余（Indexed 调色板、CMYK、1/2/4/16 位、ICCBased）返回 undefined，
 * 调用方保持 `image/x-raw` 并显示占位 —— 宁可显示占位，也不要显示一张花屏。
 */
import type { PdfDict } from './objects.ts';
import { isName, numOf } from './objects.ts';

/** 24 位 BMP 的文件头(14) + 信息头(40) */
const BMP_HEADER = 54;

/**
 * @returns 24 位 BMP 字节；无法转换时返回 undefined（调用方降级为占位）
 */
export function rawToBmp(dict: PdfDict, data: Uint8Array): Uint8Array | undefined {
  const width = numOf(dict.Width);
  const height = numOf(dict.Height);
  if (!width || !height || width <= 0 || height <= 0) return undefined;
  // 防爆：一张 2 万×2 万的图会产生 1.2 GB 的 BMP，直接放弃
  if (width * height > 40_000_000) return undefined;

  const bpc = numOf(dict.BitsPerComponent) ?? 8;
  if (bpc !== 8) return undefined;

  const cs = dict.ColorSpace;
  if (!isName(cs)) return undefined;
  const cname = cs.name;
  let channels: 3 | 1;
  if (cname === 'DeviceRGB' || cname === 'RGB' || cname === 'CalRGB') channels = 3;
  else if (cname === 'DeviceGray' || cname === 'G' || cname === 'CalGray') channels = 1;
  else return undefined;

  const need = width * height * channels;
  if (data.length < need) return undefined;

  const rowBytes = width * 3;
  const rowSize = rowBytes + ((4 - (rowBytes % 4)) % 4); // 每行按 4 字节对齐
  const pixelBytes = rowSize * height;
  const total = BMP_HEADER + pixelBytes;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  // ---- BITMAPFILEHEADER ----
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  dv.setUint32(2, total, true); // 文件总大小
  dv.setUint32(6, 0, true); // 保留
  dv.setUint32(10, BMP_HEADER, true); // 像素数据偏移

  // ---- BITMAPINFOHEADER ----
  dv.setUint32(14, 40, true); // 信息头大小
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true); // 正数表示 bottom-up（BMP 的常规约定）
  dv.setUint16(26, 1, true); // planes
  dv.setUint16(28, 24, true); // 位深
  dv.setUint32(30, 0, true); // BI_RGB，不压缩
  dv.setUint32(34, pixelBytes, true);
  dv.setInt32(38, 2835, true); // 约 72 DPI
  dv.setInt32(42, 2835, true);
  dv.setUint32(46, 0, true);
  dv.setUint32(50, 0, true);

  // ---- 像素：BMP 自下而上，且通道顺序是 BGR ----
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * channels;
    let o = BMP_HEADER + y * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * channels;
      if (channels === 3) {
        out[o++] = data[s + 2];
        out[o++] = data[s + 1];
        out[o++] = data[s];
      } else {
        const g = data[s];
        out[o++] = g;
        out[o++] = g;
        out[o++] = g;
      }
    }
  }
  return out;
}
