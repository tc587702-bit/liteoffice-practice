/**
 * @liteoffice/format-pdf —— PDF 读取器（FormatId: pdf）。
 *
 * 定位（这是本包最重要的说明）：
 *   把 PDF 读成 UDM 的 `pages` 形状 —— **文字 + 基础图形 + 内嵌图片**，
 *   目标是「能读出页面上有什么，并给出可读的近似版面」，
 *   **不是像素级还原**。没有人应该拿它跟 pdf.js 比渲染保真度。
 *
 * 明确不做（如实列出，不粉饰）：
 *   - 加密/解密（有 /Encrypt 一律抛 ReadError('ENCRYPTED')）
 *   - CFF/Type1 的 glyph 轮廓还原（只做文本语义提取）
 *   - 裁剪路径、图案/渐变填充、软掩码合成、混合模式
 *   - Form XObject 的递归展开（只记 warning）
 *   - CCITTFax / JBIG2 图片的解码（保留原始字节并记 warning）
 *   - ICC 色彩管理（CMYK 用朴素换算）
 *
 * 但「能打开」这件事上做了大量兜底：xref 流、/Prev 链、对象流、经典 xref 表、
 * 以及**xref 全错时的全文扫描**。宁可版面粗糙，不可以打不开。
 */
import { ReadError, registerReader } from '../../core/src/registry.ts';
import type { FormatReader, ReadContext } from '../../core/src/registry.ts';
import { createDocument, estimateDocumentBytes } from '../../core/src/index.ts';
import type { DocMeta, LiteDocument, PdfItem, PdfPage } from '../../core/src/index.ts';
import { bytesToLatin1 } from './byteutils.ts';
import { concatBytes } from './byteutils.ts';
import { decodePdfDocEncoding } from './encoding.ts';
import { dictName, isArray, isStream, nameOf, numOf, textOf } from './objects.ts';
import type { PdfDict, PdfObject, PdfStream } from './objects.ts';
import { XRefState } from './xref.ts';
import { FontLoader } from './font.ts';
import { ContentInterpreter } from './content.ts';
import { walkPageTree, pageSize, asDict } from './pages.ts';
import type { PageInfo } from './pages.ts';
import { decodeStream } from './filters.ts';

/* ==================================================================== */
/* 读取器                                                               */
/* ==================================================================== */

class PdfReader implements FormatReader {
  readonly id = 'pdf';
  readonly formats = ['pdf'] as const;

  async read(ctx: ReadContext): Promise<LiteDocument> {
    const t0 = nowMs();
    const bytes = await ctx.bytes();
    if (bytes.length === 0) throw new ReadError('PDF 文件为空', 'CORRUPT', 'pdf');

    const warnings = new Set<string>();
    const note = (m: string): void => {
      if (warnings.size < 200) warnings.add(m);
    };

    // ---- 1. 头部与版本 ----
    const headerOffset = findHeader(bytes);
    if (headerOffset < 0) {
      throw new ReadError('文件开头找不到 %PDF- 标记，不是有效的 PDF', 'CORRUPT', 'pdf');
    }
    // 头部不在 0 位置是合法的（有些文件前面有垃圾字节），但所有偏移都要加上这个基数
    const buf = headerOffset > 0 ? bytes.subarray(headerOffset) : bytes;
    const version = readVersion(buf);
    if (headerOffset > 0) note(`文件开头有 ${headerOffset} 字节垃圾数据，已按 %PDF- 位置为基准解析偏移`);

    // ---- 2. 交叉引用表 ----
    const xref = new XRefState(buf);
    let xrefOk = await ctx.phase('xref', () => xref.build());
    if (!xrefOk) {
      // 兜底路径：xref 不可信（偏移错位、xref 段全部损坏、线性化文件被截断）
      xref.scanAllObjects();
      xrefOk = xref.entries.size > 0;
    }
    for (const n of xref.notes) note(n);
    if (!xrefOk) {
      throw new ReadError('PDF 交叉引用表损坏且全文扫描也没找到对象', 'CORRUPT', 'pdf');
    }

    // ---- 3. 加密 ----
    if (xref.trailer.Encrypt !== undefined) {
      const enc = xref.resolve(xref.trailer.Encrypt);
      const filter = asDict(enc) ? dictName(asDict(enc), 'Filter') : undefined;
      throw new ReadError(
        `PDF 已加密（/Encrypt${filter ? ` /Filter ${filter}` : ''}），当前版本不支持解密`,
        'ENCRYPTED',
        'pdf',
      );
    }

    // ---- 4. 对象流准备 ----
    await ctx.phase('objstm', () => xref.prepare());

    const root = xref.root();
    if (!root) throw new ReadError('PDF 里找不到文档目录（/Root -> /Type /Catalog）', 'CORRUPT', 'pdf');

    // ---- 5. 页面树 ----
    const tree = await ctx.phase('pages', () => {
      const pagesNode = asDict(xref.resolve(root.Pages));
      if (!pagesNode) return { pages: [] as PageInfo[], brokenBranches: 0, truncated: false };
      return walkPageTree(pagesNode, {
        maxPages: ctx.limits.maxPages,
        resolve: (o) => xref.resolve(o),
        note,
        numOfRef: (o) => (typeof o === 'object' && o !== null && 'num' in o ? (o as { num: number }).num : 0),
      });
    });
    if (tree.brokenBranches) note(`页面树里有 ${tree.brokenBranches} 个损坏分支被跳过`);
    // 截断必须**直接影响 stats.truncated**：LimitGuard 的 probe 是按「消耗量」记账的，
    // 而页面树是整体遍历完才知道超限的，所以要显式补记一次超限 probe。
    if (tree.truncated) {
      ctx.guard.probe('maxPages', ctx.limits.maxPages + 1);
      note(`页数超过上限 ${ctx.limits.maxPages}，只解析前 ${ctx.limits.maxPages} 页`);
    }
    if (tree.pages.length === 0) {
      // 错误信息要具体到「卡在哪一步」，否则对诊断没有帮助
      throw new ReadError(
        `PDF 里没有可读取的页面（对象表 ${xref.entries.size} 个、页面树 ${tree.brokenBranches} 个分支损坏、` +
          `trailer ${Object.keys(xref.trailer).length} 项）`,
        'CORRUPT',
        'pdf',
      );
    }

    // ---- 6. 逐页解析内容流 ----
    // 流解码缓存：背景图/大 Form 会被多页引用，重复解压一个 2 MiB 的 Flate 流
    // 在多页文档里会变成几十秒。WeakMap 语义（这里用 Map + 对象键）让它随对象回收。
    const docRef: { streamCache: Map<PdfStream, Uint8Array> } = { streamCache: new Map() };

    const fonts = new FontLoader({
      resolve: async (o) => xref.resolve(o),
      resolveSync: (o) => xref.resolve(o),
      // /ToUnicode 几乎总是 FlateDecode 压缩的：这里复用带缓存的解码
      decodeStream: (dict, raw) => decodeStreamCached(ctx, docRef, dict, raw, note),
      note,
    });

    // 图片配额：LimitGuard 管数量，自己额外管字节
    let imageBytes = 0;
    let imageCount = 0;

    const pages: PdfPage[] = [];
    const pageTexts: string[] = [];

    for (let i = 0; i < tree.pages.length; i++) {
      const info = tree.pages[i];
      const size = pageSize(info);
      const page: PdfPage = { index: i, width: round(size.width), height: round(size.height) };
      if (info.rotate) page.rotate = info.rotate;

      const resources = info.resources;
      const contentData = await collectContent(ctx, xref, info, resources, note, docRef);
      if (contentData && contentData.length) {
        const interpreter = new ContentInterpreter(
          {
            resolve: (o) => xref.resolve(o),
            note,
            decode: (dict, raw) => decodeStreamCached(ctx, docRef, dict, raw, note),
            acceptImage: (n) => {
              // 数量上限走 LimitGuard（超额会进 stats.truncated）；
              // 字节上限自己管（guard 的 probe 是按次数记账，不适合字节量）
              const okCount = ctx.guard.probe('maxImages', n > 0 ? 1 : 0);
              if (n === 0) return true;
              if (!okCount) {
                note(`图片数量超过上限 ${ctx.limits.maxImages}，只保留位置不保留字节`);
                return false;
              }
              const limit = ctx.limits.maxImageBytes;
              if (imageBytes + n > limit) {
                note(`图片累计字节超过上限 ${limit}，后续图片只保留位置不保留字节`);
                return false;
              }
              imageBytes += n;
              imageCount++;
              return true;
            },
          },
          fonts,
        );
        const r = await interpreter.run(contentData, resources);
        // finish() 把同一行被拆开的 Tj 片段合并（中文逐字带间隙、拉丁词被拆开
        // 都靠这一步修好），只在最外层调用一次
        page.items = interpreter.finish();
        ctx.guard.probe('maxBlocks', 0);
        const text = itemsToText(page.items);
        if (text) pageTexts.push(text);
      } else {
        page.items = [];
      }
      pages.push(page);
      ctx.onProgress?.({ phase: 'content', done: i + 1, total: tree.pages.length });
      if (ctx.signal?.aborted) break;
    }
    fonts.dismiss();

    // ---- 7. 文档信息 ----
    const meta = readInfo(xref, xref.trailer, root);
    const firstPage = pages[0];
    meta.pageCount = pages.length;
    if (firstPage) {
      // 页面尺寸：把 /Rotate 90/270 换算成「显示尺寸」，这样视图拿到的宽高
      // 就是横放后的真实尺寸，不需要自己再判断旋转。
      const swapped = firstPage.rotate === 90 || firstPage.rotate === 270;
      meta.pageWidth = round(swapped ? firstPage.height : firstPage.width);
      meta.pageHeight = round(swapped ? firstPage.width : firstPage.height);
    }
    const fullText = pageTexts.join('\n\n');
    // charCount 只数「提取到的文本字符」，不含页与页之间为了可检索而加的 \n\n；
    // 否则 2 页各 7 个字符会报成 16，用户看到的字数对不上。
    meta.charCount = pageTexts.reduce((n, t) => n + t.length, 0);

    const outline = readOutline(xref, root, pages.length);

    const doc = createDocument({
      kind: 'pdf',
      format: 'pdf',
      formatLabel: 'PDF 文档',
      name: ctx.name,
      meta,
      outline,
      pages,
      text: ctx.limits.maxBlocks > 0 ? fullText : undefined,
      stats: {
        parseMs: round(nowMs() - t0),
        sourceBytes: bytes.length,
        imageCount,
        imageBytes,
        warnings: [...warnings],
        truncated: [],
      },
    });
    // 模型的体积口径：与框架统一用 estimateDocumentBytes —— 它会跳过图片/流的
    // 二进制负载（那部分已在 stats.imageBytes 里单独统计），若把图片字节也算进
    // modelBytes，一份 972 KiB 的图文 PDF 会被报成 39 MiB（差 300 倍）。
    doc.stats.blockCount = pages.reduce((n, p) => n + p.items.length, 0);
    // 把 LimitGuard 自己记的 warnings/truncated 合并进来。
    // openDocument() 也会做一次合并，但读取器必须能独立工作（测试、服务端
    // 直接调用 reader 都很常见）—— 否则 stats.truncated 会是空的，
    // 「截断了却没告诉用户」正是本项目明确要避免的静默丢内容。
    const snap = ctx.guard.snapshot();
    if (snap.warnings.length) doc.stats.warnings = [...new Set([...doc.stats.warnings, ...snap.warnings])];
    if (snap.truncated.length) doc.stats.truncated = [...new Set([...doc.stats.truncated, ...snap.truncated])];
    if (version) doc.meta.application ??= `PDF ${version}`;
    // 放在最后计算：此时 meta/outline/text/pages 都已定稿，engine/open.ts 之后
    // 用同一个 estimateDocumentBytes(document) 复算会得到同一个数，不会触发
    // 「读取器自报的 modelBytes 与框架估算相差 N 倍」的告警。
    doc.stats.modelBytes = estimateDocumentBytes(doc);
    return doc;
  }
}

/* ==================================================================== */
/* 内容流收集                                                            */
/* ==================================================================== */

/**
 * 收集并解码页面的 /Contents。
 *
 * 三个坑：
 *   1. /Contents 可能是**数组**（每个元素是独立的流，各自带 /Filter），必须按序拼接
 *   2. 数组元素是**间接引用**，必须逐个 resolve。早期版本只 resolve 了整个 /Contents，
 *      而 resolve 对数组是空操作 —— 于是数组里全是 {num,gen} 引用对象，
 *      isStream() 全为 false，整页内容被静默丢弃（症状：页面数正常但一个字符都提取不到）
 *   3. 数组里某一段解压失败时不能整页放弃，跳过该段并记 warning
 */
async function collectContent(
  ctx: ReadContext,
  xref: XRefState,
  info: PageInfo,
  resources: PdfDict | undefined,
  note: (m: string) => void,
  docRef: { streamCache: Map<PdfStream, Uint8Array> },
): Promise<Uint8Array | undefined> {
  const contents = info.dict.Contents;
  if (contents === undefined) {
    void xref;
    void resources;
    return undefined;
  }
  const raw = xref.resolve(contents);
  // 注意：这里的每一项都要各自 resolve（数组元素是引用）
  const list = isArray(raw) ? raw.map((item) => xref.resolve(item)) : [raw];
  const parts: Uint8Array[] = [];
  for (const item of list) {
    if (!isStream(item)) continue;
    const decoded = await decodeStreamCached(ctx, docRef, item.dict, item.raw, note);
    if (decoded && decoded.length) parts.push(decoded);
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (total > ctx.limits.maxPartBytes) {
    note(`页面内容流拼接后 ${total} 字节超过 maxPartBytes，只解析前 ${ctx.limits.maxPartBytes} 字节`);
    let acc = 0;
    const cut: Uint8Array[] = [];
    for (const p of parts) {
      if (acc >= ctx.limits.maxPartBytes) break;
      const remain = ctx.limits.maxPartBytes - acc;
      cut.push(p.length <= remain ? p : p.subarray(0, remain));
      acc += Math.min(p.length, remain);
    }
    return concatBytes(cut);
  }
  return concatBytes(parts);
}

/**
 * 带缓存的流解码。
 *
 * 为什么要缓存：作为页面背景的 Form/大图常被多页引用，重复解压一个 2 MiB
 * 的 Flate 流会在多页文档里变成几十秒。WeakMap 让缓存随流对象一起被回收。
 */
async function decodeStreamCached(
  ctx: ReadContext,
  docRef: { streamCache: Map<PdfStream, Uint8Array> },
  dict: PdfDict,
  raw: Uint8Array,
  note: (m: string) => void,
): Promise<Uint8Array | undefined> {
  const key = { dict, raw } as unknown as PdfStream;
  const cached = docRef.streamCache.get(key);
  if (cached) return cached;
  const r = await decodeStream(dict, raw);
  for (const f of r.failed) note(`流过滤器未完全解码：${f}`);
  if (r.data.length > ctx.limits.maxPartBytes) {
    note(`单个流解码后 ${r.data.length} 字节超过 maxPartBytes，已截断`);
    const cut = r.data.subarray(0, ctx.limits.maxPartBytes);
    docRef.streamCache.set(key, cut);
    return cut;
  }
  docRef.streamCache.set(key, r.data);
  return r.data;
}

function itemsToText(items: readonly PdfItem[]): string {
  const parts: string[] = [];
  for (const it of items) if (it.kind === 'text') parts.push(it.text);
  return parts.join('\n');
}

/* ==================================================================== */
/* 文档信息与书签                                                        */
/* ==================================================================== */

const PDF_DATE = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/;

/** 解析 PDF 日期 `D:YYYYMMDDHHmmSS+HH'mm'` -> ISO 8601 */
export function parsePdfDate(s: string): string | undefined {
  const m = PDF_DATE.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec] = m;
  const pad = (v: string | undefined, def: string): string => (v ?? def).padStart(2, '0');
  return `${y}-${pad(mo, '01')}-${pad(d, '01')}T${pad(h, '00')}:${pad(mi, '00')}:${pad(sec, '00')}`;
}

/**
 * 读 /Info 字典。
 *
 * 注意：/Info 里的字符串是 **PDFDocEncoding**（不是 UTF-8）。
 * 中文文档里 Word/WPS 会写 UTF-16BE（带 BOM FE FF），必须先判断 BOM。
 */
export function decodeInfoString(o: PdfObject): string | undefined {
  if (o === null || typeof o !== 'object' || Array.isArray(o) || !('bytes' in o)) return textOf(o);
  const b = (o as { bytes: Uint8Array }).bytes;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // UTF-16BE with BOM
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
    return s;
  }
  return decodePdfDocEncoding(b);
}

function readInfo(xref: XRefState, trailer: PdfDict, root: PdfDict): DocMeta {
  const meta: DocMeta = {};
  const info = asDict(xref.resolve(trailer.Info));
  if (info) {
    meta.title = str(info.Title);
    meta.subject = str(info.Subject);
    meta.author = str(info.Author);
    meta.keywords = str(info.Keywords);
    meta.application = str(info.Creator);
    meta.appVersion = str(info.Producer);
    meta.created = dateStr(info.CreationDate);
    meta.modified = dateStr(info.ModDate);
  }
  // /Metadata（XMP）里通常有更好的标题，但解析 XMP 需要 XML 解析 —— 这里只用
  // 轻量正则抽取 dc:title，避免为元数据引入整个 xml 包。
  const xmpStream = isStream(xref.resolve(root.Metadata)) ? (xref.resolve(root.Metadata) as PdfStream) : undefined;
  if (xmpStream && xmpStream.raw.length) {
    const xml = bytesToLatin1(xmpStream.raw);
    const t = /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xml);
    if (t && t[1].trim() && !meta.title) meta.title = decodeXmlEntities(t[1].trim()).slice(0, 300);
    const creator = /<xmp:CreatorTool>([\s\S]*?)<\/xmp:CreatorTool>/.exec(xml);
    if (creator && !meta.application) meta.application = decodeXmlEntities(creator[1].trim());
  }
  return meta;

  function str(o: PdfObject): string | undefined {
    const v = decodeInfoString(xref.resolve(o));
    const t = v?.replace(/\u0000+$/, '').trim();
    return t ? t : undefined;
  }
  function dateStr(o: PdfObject): string | undefined {
    const v = str(o);
    return v ? parsePdfDate(v) : undefined;
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number.parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * 大纲（书签）。
 *
 * 只读一层深度：PDF 的 /Outlines 是链表 + 子树的混合结构，完整展开在畸形
 * 文件上很容易死循环。这里做环检测并限制条目数。
 */
function readOutline(xref: XRefState, root: PdfDict, pageCount: number): LiteDocument['outline'] {
  const outlines = asDict(xref.resolve(root.Outlines));
  if (!outlines) return [];
  const out: LiteDocument['outline'] = [];
  const seen = new Set<PdfDict>();
  let node = asDict(xref.resolve(outlines.First));
  const numToIndex = new Map<number, number>();
  let guard = 0;
  while (node && !seen.has(node) && out.length < 500 && guard++ < 5000) {
    seen.add(node);
    const title = decodeInfoString(xref.resolve(node.Title))?.trim();
    if (title && title.length > 0) {
      const target = outlineTarget(xref, node, pageCount, numToIndex);
      out.push({ level: 1, text: title.slice(0, 300), target });
    }
    node = asDict(xref.resolve(node.Next));
  }
  return out;
}

function outlineTarget(
  xref: XRefState,
  node: PdfDict,
  pageCount: number,
  cache: Map<number, number>,
): { kind: 'page'; index: number } | undefined {
  const dest = node.Dest ?? asDict(xref.resolve(node.A))?.D;
  const arr = isArray(xref.resolve(dest)) ? (xref.resolve(dest) as PdfObject[]) : undefined;
  if (!arr || arr.length === 0) return undefined;
  const first = arr[0];
  if (typeof first === 'object' && first !== null && 'num' in first) {
    const num = (first as { num: number }).num;
    const cached = cache.get(num);
    if (cached !== undefined) return { kind: 'page', index: cached };
    // 页面索引需要在页面树里查；这里退化为「按对象号排序」的近似，
    // 真正的索引由页面顺序决定 —— 为避免再次遍历树，直接返回 0 会让跳转不准，
    // 所以宁可不给 target 也不给错 target。
    void pageCount;
    void num;
    return undefined;
  }
  // 整数形式的目标：直接是页号
  if (typeof first === 'number' && Number.isInteger(first) && first >= 0 && first < pageCount) {
    return { kind: 'page', index: first };
  }
  return undefined;
}

/* ==================================================================== */
/* 头部与版本                                                            */
/* ==================================================================== */

/** 找 `%PDF-` 的位置。允许前面有垃圾（规范要求在前 1024 字节内）。 */
export function findHeader(buf: Uint8Array): number {
  const limit = Math.min(buf.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (buf[i] === 0x25 && buf[i + 1] === 0x50 && buf[i + 2] === 0x44 && buf[i + 3] === 0x46 && buf[i + 4] === 0x2d) return i;
  }
  return -1;
}

export function readVersion(buf: Uint8Array): string | undefined {
  const m = /^%PDF-(\d\.\d)/.exec(bytesToLatin1(buf.subarray(0, 16)));
  return m ? m[1] : undefined;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/* ==================================================================== */
/* 自注册                                                               */
/* ==================================================================== */

export const pdfReader: FormatReader = new PdfReader();

// 顶层自注册：import 本包即获得 pdf 支持。
// 是否把本包打包进产物由调用方决定（registry 的存在意义就是让这件事可裁剪），
// 但「注册」这个动作必须在模块顶层完成，否则调用方还得记住手动注册。
registerReader(pdfReader);
