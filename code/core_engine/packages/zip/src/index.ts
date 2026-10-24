/**
 * @liteoffice/zip —— 流式 ZIP 容器读写。
 *
 * 为什么自己写：JSZip 会把整个压缩包读进内存并保留全部中间结构，
 * 打开一个 20 MB 的 xlsx 常驻内存可达数百 MB。LiteOffice 的定位要求
 * 「峰值内存与单个部件同阶」，因此这里只做中央目录索引 + 原生流式解压。
 */
export { ZipReader, ZipError, concat } from './reader.ts';
export type { ZipEntry, ZipOpenOptions } from './reader.ts';
export { ZipWriter, deflateRaw } from './writer.ts';
export type { ZipWriteOptions } from './writer.ts';
export { crc32 } from './crc32.ts';
export { ByteView, decodeName, ZIP_SIG } from './bytes.ts';
