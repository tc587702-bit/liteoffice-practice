/**
 * ODF 读取器：把 odt / ott / ods / ots / odp / otp / odg 与扁平 fodt / fods / fodp
 * 读成统一文档模型 UDM。
 *
 * 三条路径的差异被收敛在 `openPartSource()` 一个点上：
 *   - zip 包（odt/ods/…）：mimetype + META-INF/manifest.xml + content.xml + styles.xml + meta.xml
 *   - 扁平 XML（fodt/fods/fodp）：单文件，所有部件都在 `office:document` 里
 * 之后无论哪条路径，都是同一个 `XmlPullParser` 事件流 + 同一批解析函数。
 *
 * 硬要求（见 docs/CONVENTIONS.md 第 5 节）：
 *   - 绝不因为某个子特性不支持而抛错：降级 + stats.warnings
 *   - 超限截断写 stats.truncated
 *   - 遵守 limits.maxPartBytes：content.xml 解压后超限时走 streamText() 流式路径
 *   - 如实填 stats（parseMs / modelBytes / blockCount / cellCount / shapeCount / imageCount）
 */
import { XmlPullParser, XmlError } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { ZipError } from '../../zip/src/index.ts';
import { createDocument, estimateBytes, now, outlineFromBlocks, ReadError } from '../../core/src/index.ts';
import type {
  Block,
  DocMeta,
  DocStats,
  FormatId,
  LiteDocument,
  Run,
  Sheet,
  Slide,
} from '../../core/src/index.ts';
import { registerReader } from '../../core/src/registry.ts';
import type { ContainerAccess, ReadContext, FormatReader } from '../../core/src/registry.ts';
import { attr, mimeFromPath, resolvePartPath } from './xmlUtil.ts';
import { emptyStyles, markTruncated, newContext, warn } from './types.ts';
import type { OdContext, OdManifest, OdPageLayout, OdStyleDef, OdStyles } from './types.ts';
import { familyFromFormat, familyFromMimetype, familyFromRoot, formatFromMimetype, parseManifest } from './package.ts';
import type { OdFamily } from './package.ts';
import { extractMetaSection, parseMetaXml } from './meta.ts';
import { parseOdStyles, parseStyleXml, resolvePageLayout } from './styles.ts';
import { parseTextBody } from './content.ts';
import type { TextParseTarget } from './content.ts';
import { parseSpreadsheetBody } from './sheets.ts';
import type { PageSetupInfo } from './sheets.ts';
import { DEFAULT_SLIDE_HEIGHT_PT, DEFAULT_SLIDE_WIDTH_PT, ensureShapeSize, parseSlidesBody } from './slides.ts';
import type { SlidesParseTarget } from './slides.ts';

/** reader 标识，用于诊断与「装了哪个读取器」的展示 */
const READER_ID = 'odf';

/** 各格式对应的具体读取器名（UI 上显示得比 "odf" 更具体） */
const ODF_FORMATS: readonly FormatId[] = ['odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'odg', 'fodt', 'fods', 'fodp'];

/** mimetype 条目允许的最大字节数：规范说它是 ASCII 短串，超过这个值必然是畸形/攻击。 */
const MAX_MIMETYPE_BYTES = 256;

/* ==================================================================== */
/* 部件来源抽象                                                          */
/* ==================================================================== */

/**
 * 「怎么拿到 content.xml / styles.xml / meta.xml」的抽象。
 * zip 与扁平两条路径都实现它，之后所有解析逻辑不必分支。
 */
interface PartSource {
  /** 是否 zip 容器（决定要不要为图片去容器取字节） */
  readonly zipped: boolean;
  /** mimetype 条目的值，未知返回 undefined */
  mimetype(): Promise<string | undefined>;
  /** 包结构信息（条目表、加密标记） */
  manifest(): Promise<OdManifest>;
  /** 正文 XML 文本；不存在返回 undefined */
  content(): Promise<string | undefined>;
  /** 命名样式 XML 文本；不存在返回 undefined */
  styles(): Promise<string | undefined>;
  /** 元数据 XML 文本；不存在返回 undefined */
  meta(): Promise<string | undefined>;
  /** 取一个包内条目的字节（图片用）。不存在返回 undefined。 */
  partBytes(path: string): Promise<Uint8Array | undefined>;
  /** 该路径在容器里是否存在 */
  has(path: string): boolean;
}

/** 打开部件来源。**每个 zip 变体只调用 ctx.container() 一次**。 */
async function openPartSource(ctx: ReadContext, flat: boolean): Promise<PartSource> {
  if (flat) return openFlatSource(ctx);
  return openZipSource(ctx);
}

/* ---------------------------- zip 路径 ---------------------------- */

async function openZipSource(ctx: ReadContext): Promise<PartSource> {
  let container: ContainerAccess;
  try {
    if (!ctx.container) throw new ReadError('缺少 zip 容器访问能力', 'CORRUPT');
    container = await ctx.container();
  } catch (err) {
    if (err instanceof ReadError) throw err;
    if (err instanceof ZipError) throw new ReadError(`ODF 包结构损坏：${err.message}`, 'CORRUPT');
    throw err;
  }

  let manifestCache: OdManifest | undefined;
  const maxEntry = ctx.limits.maxEntryBytes;

  /** 按上限读取一个 XML 部件：超过 maxPartBytes 时走 streamText 流式截断路径。 */
  const readXml = async (name: string): Promise<string | undefined> => {
    if (!container.has(name)) return undefined;
    const size = container.entrySize(name);
    if (size <= ctx.limits.maxPartBytes) {
      try {
        return await container.text(name);
      } catch (err) {
        return await streamCapped(container, name, ctx, err);
      }
    }
    warn(
      ctx,
      `${name} 解压后 ${(size / 1048576).toFixed(1)} MiB，超过 maxPartBytes ${(ctx.limits.maxPartBytes / 1048576).toFixed(0)} MiB，改用流式读取并在上限处截断`,
    );
    markTruncated(ctx, 'maxPartBytes', `${name} 超过单部件上限，后续内容未解析（文档可能不完整）`);
    return streamCapped(container, name, ctx, undefined, size > maxEntry);
  };

  return {
    zipped: true,
    async mimetype() {
      if (!container.has('mimetype')) return undefined;
      // mimetype 必须是「不压缩存储」的短 ASCII；这里只取前若干字节，
      // 避免一个声称 4 GB 的畸形条目让我们白解压。
      const size = container.entrySize('mimetype');
      if (size > MAX_MIMETYPE_BYTES) {
        warn(ctx, `mimetype 条目长度异常（${size} 字节），已忽略`);
        return undefined;
      }
      try {
        return (await container.text('mimetype')).trim();
      } catch {
        return undefined;
      }
    },
    async manifest() {
      if (manifestCache) return manifestCache;
      if (!container.has('META-INF/manifest.xml')) {
        manifestCache = { entries: new Map(), encrypted: false, encryptedEntries: [] };
        return manifestCache;
      }
      try {
        const xml = await container.text('META-INF/manifest.xml');
        manifestCache = parseManifest(xml);
      } catch {
        warn(ctx, 'META-INF/manifest.xml 无法读取，已跳过（不影响正文）');
        manifestCache = { entries: new Map(), encrypted: false, encryptedEntries: [] };
      }
      return manifestCache;
    },
    content: () => readXml('content.xml'),
    styles: () => readXml('styles.xml'),
    meta: () => readXml('meta.xml'),
    has: (path) => container.has(path),
    async partBytes(path) {
      if (!container.has(path)) return undefined;
      try {
        return await container.read(path);
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * 用 streamText() 读大部件，读到 maxPartBytes 就停。
 *
 * 这个函数存在的原因：`XmlPullParser` 只能接受「整块字符串或字节」，
 * 没有 async 迭代入口（那需要改 packages/xml，超出本包的范围）。
 * 因此「流式读取」在这里的准确含义是：**按块读取并在上限处停止**，
 * 峰值内存被 maxPartBytes 钉住，而不是随部件体积线性增长。
 * 超过上限的部分被截断，并记录在 stats.truncated 里 —— 不静默丢内容。
 *
 * @param oversized 已知条目超过 maxEntryBytes：此时容器连 read() 都会拒绝，
 *                  只能走流式。
 */
async function streamCapped(
  container: ContainerAccess,
  name: string,
  ctx: OdContext,
  cause?: unknown,
  oversized = false,
): Promise<string | undefined> {
  const cap = ctx.limits.maxPartBytes;
  const parts: string[] = [];
  let total = 0;
  try {
    const reader = container.streamText(name).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total >= cap) {
        parts.push(value.slice(0, Math.max(0, cap - (total - value.length))));
        markTruncated(
          ctx,
          'maxPartBytes',
          `${name} 超过单部件上限 ${(cap / 1048576).toFixed(0)} MiB，已在 ${(cap / 1048576).toFixed(0)} MiB 处截断（文档可能显示不全）`,
        );
        try {
          await reader.cancel();
        } catch {
          /* 取消流失败不影响已有数据 */
        }
        break;
      }
      parts.push(value);
    }
  } catch (err) {
    if (!oversized && cause === undefined) {
      warn(ctx, `${name} 流式读取失败：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    warn(ctx, `${name} 无法读取（${err instanceof Error ? err.message : String(err)}），已跳过`);
    return undefined;
  }
  if (!parts.length) return undefined;
  return parts.join('');
}

/* ---------------------------- 扁平路径 ---------------------------- */

/**
 * 扁平 ODF：单个 XML 文件，根是 `office:document`。
 * **绝不调用 ctx.container()** —— 它不是 zip，去开容器只会白付代价并可能抛错。
 */
async function openFlatSource(ctx: ReadContext): Promise<PartSource> {
  const bytes = await ctx.bytes();
  const xml = decodeXml(bytes);
  const root = scanFlatRoot(xml);
  let chunksCache: StyleChunks | undefined;

  const chunks = (): StyleChunks => (chunksCache ??= collectStyleChunks(xml, root));

  return {
    zipped: false,
    async mimetype() {
      // 扁平 ODF 把 mimetype 写在根元素的 office:mimetype 属性上
      return root.mimetype;
    },
    async manifest() {
      // 扁平文件没有 META-INF/manifest.xml：条目表为空，且天然不会加密
      return { entries: new Map(), encrypted: false, encryptedEntries: [] };
    },
    async content() {
      // 扁平 ODF 的「content 部件」= office:document 里除 styles/master-styles/meta 之外的部分。
      // 直接把整个文档交给解析器：parseTextBody 只认 office:text 之类，
      // 会自然忽略 office:automatic-styles / office:meta 等兄弟节点。
      return xml;
    },
    async styles() {
      // 命名样式 + 自动样式 + 母版页：拼成一段伪 styles.xml 交给同一个解析器。
      // 为什么不用真正的 XML 封装：解析器按 local name 匹配，拼接后的片段
      // 只要标签平衡就够了（下面的切片保证平衡）。
      const c = chunks();
      const joined = [c.styles, c.automatic, c.master].filter(Boolean).join('');
      return joined || undefined;
    },
    async meta() {
      return extractMetaSection(xml);
    },
    has: () => false,
    async partBytes() {
      // 扁平 ODF 理论上可以用 office:binary-data 内嵌 base64 图片（极少见），
      // 这里明确不支持并降级 —— 不能假装成功返回空字节。
      warn(ctx, '扁平 ODF 的内嵌二进制图片（office:binary-data）暂不支持，图片将显示为占位');
      return undefined;
    },
  };
}

/** 去掉 UTF-8 BOM 并解码。扁平 ODF 也可能是带 BOM 的 UTF-8。 */
function decodeXml(bytes: Uint8Array): string {
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(start ? bytes.subarray(start) : bytes);
}

interface FlatRootInfo {
  /** 根元素名（本地名），如 "document" / "document-content" */
  root: string;
  mimetype?: string;
  /** office:body 的起始偏移（'<' 的位置），找不到为 -1 */
  bodyStart: number;
}

/**
 * 扫描扁平 ODF 的根元素信息。
 *
 * 只读文件头部：扁平 ODF 的根属性与 office:meta 都在最前面，
 * 而正文可能几十 MB。为了元数据遍历整棵树是浪费。
 *
 * 扁平 ODF 的形态是
 *   <office:document office:mimetype="…">
 *     <office:meta/> <office:styles/> <office:automatic-styles/>
 *     <office:body><office:text>…</office:text></office:body>
 *   </office:document>
 * 注意 `office:body` 的**子**元素名（text/spreadsheet/…）才决定走哪条解析路径，
 * 因此这里记录根元素与 body 是否存在即可，具体分派由 scanBodyDetail 完成。
 */
function scanFlatRoot(xml: string): FlatRootInfo {
  const info: FlatRootInfo = { root: '', bodyStart: -1 };
  const limit = Math.min(xml.length, 256 * 1024);
  let p: XmlPullParser;
  try {
    p = new XmlPullParser(xml.slice(0, limit));
  } catch {
    return info;
  }
  try {
    let e: XmlEvent | null;
    while ((e = p.next()) !== null) {
      if (e.type !== 'start') continue;
      if (!info.root) {
        info.root = e.local;
        const mime = attr(e, 'mimetype');
        if (mime) info.mimetype = mime;
        if (e.selfClosing) return info;
        continue;
      }
      if (e.local === 'body') {
        info.bodyStart = xml.indexOf('<office:body');
        return info;
      }
      if (!e.selfClosing) p.skipElement();
    }
  } catch {
    /* 头部扫描失败：交给后续 fallback */
  }
  return info;
}

interface StyleChunks {
  styles?: string;
  automatic?: string;
  master?: string;
  /** 所有 style:page-layout 的定义（按 name） */
  pageLayouts: Map<string, OdStyleDef>;
}

/**
 * 从扁平 ODF 里按区间切出样式片段。
 *
 * 为什么用「找起止标签」而不是解析器遍历：
 *   拼接后的片段要交给 `parseStyleXml`，它按 local name 收集 style/default-style/
 *   list-style/master-page。用一个起止切片即可，代价与文档大小无关。
 *   风险来自嵌套同名标签 —— ODF 里 `office:styles` / `office:automatic-styles`
 *   不会互相嵌套，因此这个简化是安全的。
 */
function collectStyleChunks(xml: string, root: FlatRootInfo): StyleChunks {
  const chunks: StyleChunks = { pageLayouts: new Map() };
  chunks.styles = sliceElement(xml, 'office:styles');
  chunks.automatic = sliceElement(xml, 'office:automatic-styles');
  chunks.master = sliceElement(xml, 'office:master-styles');

  // 页面尺寸：从 automatic-styles 里取（那里才有 style:page-layout）
  if (chunks.automatic) {
    const tmp = emptyStyles();
    parseStyleXml(chunks.automatic, tmp, tmp.defs);
    for (const [key, def] of tmp.defs) {
      if (def.family === 'page-layout') chunks.pageLayouts.set(key, def);
    }
  }
  void root;
  return chunks;
}

/** 取出第一个 `<name ...>…</name>` 的完整片段（含起止标签）；没有返回 undefined。 */
function sliceElement(xml: string, name: string): string | undefined {
  const open = xml.indexOf(`<${name}`);
  if (open < 0) return undefined;
  const close = xml.indexOf(`</${name}>`, open);
  if (close < 0) return undefined;
  return xml.slice(open, close + name.length + 3);
}

/* ==================================================================== */
/* 读取主流程                                                            */
/* ==================================================================== */

async function readOdf(ctx: ReadContext): Promise<LiteDocument> {
  const started = now();
  const flat = ctx.name.toLowerCase().endsWith('.fodt') || ctx.name.toLowerCase().endsWith('.fods') || ctx.name.toLowerCase().endsWith('.fodp');

  const source = await openPartSource(ctx, flat);

  // ---- 1. mimetype：权威判定具体格式 ----
  const mimetype = await source.mimetype();
  const manifest = await source.manifest();
  if (manifest.encrypted) {
    // 加密条目解压出来是乱码，继续解析只会给出莫名其妙的 XML 错误。
    // 明确抛 ENCRYPTED，让 UI 说人话（见 explainReadError）。
    const which = manifest.encryptedEntries.length ? `（${manifest.encryptedEntries.slice(0, 3).join(', ')}）` : '';
    throw new ReadError(`文档已加密${which}，当前版本不支持解密`, 'ENCRYPTED');
  }

  const declared = formatFromMimetype(mimetype ?? '', flat);
  const format = declared ?? fallbackFormat(ctx.name, flat);

  // ---- 2. 部件文本 ----
  const contentXml = await ctx.phase('content', () => source.content());
  if (!contentXml) {
    throw new ReadError('ODF 包中缺少 content.xml，无法读取正文', 'CORRUPT', format);
  }

  // ---- 3. 样式：content.xml 的自动样式优先于 styles.xml 的命名样式 ----
  const stylesXml = await ctx.phase('styles', () => source.styles());
  const styles = await ctx.phase('styles', async () => {
    if (flat) return parseOdStyles({ styles: stylesXml, content: undefined });
    // zip 包的 content.xml 里也有 office:automatic-styles（直接格式导出的自动样式），
    // 因此必须把 content.xml 也喂给样式解析器，且**后注册**（优先级更高）。
    return parseOdStyles({ styles: stylesXml, content: contentXml });
  });

  const odCtx = newContext(ctx.limits, ctx.guard, styles);

  // ---- 4. 正文解析：按 body 的根元素分派三条路径 ----
  const detail = scanBodyDetail(contentXml);
  const family = familyFromMimetype(mimetype ?? '') ?? familyFromRoot(detail.bodyLocal ?? '') ?? familyFromFormat(format);

  const body = await ctx.phase('body', async () => parseBody(contentXml, odCtx, family, detail));

  // ---- 5. 图片字节 ----
  await ctx.phase('images', () => loadImages(source, odCtx));

  // ---- 6. 元数据 ----
  const meta = await ctx.phase('meta', async () => {
    const metaXml = await source.meta();
    const parsed = metaXml ? parseMetaXml(metaXml) : {};
    if (mimetype) parsed.application ??= undefined;
    if (!metaXml && !flat) warn(odCtx, '缺少 meta.xml，元数据为空');
    return parsed;
  });

  return finishDocument(ctx, odCtx, {
    format,
    family,
    meta,
    body,
    contentXml,
    started,
    pageLayout: resolveDefaultLayout(styles),
  });
}

/** mimetype 缺失时的兜底：按扩展名判定（引擎已嗅探过，这里只是二次确认）。 */
function fallbackFormat(name: string, flat: boolean): FormatId {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const table: Record<string, FormatId> = {
    odt: 'odt',
    ott: 'ott',
    ods: 'ods',
    ots: 'ots',
    odp: 'odp',
    otp: 'otp',
    odg: 'odg',
    fodt: 'fodt',
    fods: 'fods',
    fodp: 'fodp',
  };
  return table[ext] ?? (flat ? 'fodt' : 'odt');
}

interface BodyDetail {
  /** office:body 的子元素本地名：text / spreadsheet / presentation / drawing */
  bodyLocal?: string;
}

/**
 * 扫描 content.xml，取出正文根元素的本地名。
 *
 * 两条路径的形态不同，必须都认：
 *   - zip 包：`<office:document-content><office:body><office:text>`
 *   - 扁平：  `<office:document><office:body><office:text>`，
 *            甚至 `<office:document><office:text>`（部分生成器省略 body）
 * 因此这里记录「第一个出现在 body 之下、名字属于四选一的元素」。
 * 只看文件头部，正文可能有几十 MB。
 */
function scanBodyDetail(xml: string): BodyDetail {
  const out: BodyDetail = {};
  const limit = Math.min(xml.length, 4 * 1024 * 1024);
  let p: XmlPullParser;
  try {
    p = new XmlPullParser(xml.slice(0, limit));
  } catch {
    return out;
  }
  let inBody = false;
  let bodyDepth = 0;
  try {
    let e: XmlEvent | null;
    while ((e = p.next()) !== null) {
      if (e.type === 'end') {
        if (inBody && --bodyDepth <= 0) return out;
        continue;
      }
      if (e.type !== 'start') continue;
      if (inBody) {
        // body 内最深一层：正文根就是 body 的第一个子元素。
        if (familyFromRoot(e.local)) {
          out.bodyLocal = e.local;
          return out;
        }
        // 其它元素（office:automatic-styles 之类）整棵跳过，避免误判
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      if (familyFromRoot(e.local)) {
        // 扁平 ODF 可能省略 office:body，正文根直接挂在根元素下
        out.bodyLocal = e.local;
        return out;
      }
      if (e.local === 'body') {
        inBody = true;
        bodyDepth = 1;
        if (e.selfClosing) return out;
        continue;
      }
      if (!e.selfClosing) p.skipElement();
    }
  } catch {
    /* 头部扫描失败：按 mimetype 推定的 family 继续 */
  }
  return out;
}

type BodyResult =
  | { kind: 'text'; blocks: Block[] }
  | { kind: 'sheet'; sheets: Sheet[]; page: PageSetupInfo }
  | { kind: 'slides'; slides: Slide[] };

function parseBody(xml: string, odCtx: OdContext, family: OdFamily, detail: BodyDetail): BodyResult {
  const target: TextParseTarget = { blocks: [] };
  const slides: SlidesParseTarget = { slides: [] };
  const sheets: Sheet[] = [];
  const page: PageSetupInfo = {};

  let parser: XmlPullParser;
  try {
    parser = new XmlPullParser(xml);
  } catch {
    warn(odCtx, 'content.xml 无法解析（可能已损坏），已返回空文档');
    return family === 'sheet'
      ? { kind: 'sheet', sheets, page }
      : family === 'slides'
        ? { kind: 'slides', slides: slides.slides }
        : { kind: 'text', blocks: [] };
  }

  try {
    walkBody(parser, odCtx, family, detail, target, sheets, slides, page);
  } catch (err) {
    // 解析中途失败（畸形 XML / 截断的流）：保留已解析出来的部分而不是整篇丢弃。
    // 「能打开一部分」远比「打不开」有价值，且必须让用户知道不完整。
    const msg = err instanceof XmlError ? err.message : err instanceof Error ? err.message : String(err);
    markTruncated(odCtx, 'content', `content.xml 解析中断（${msg}），已显示已成功解析的部分`);
  }

  if (family === 'sheet') return { kind: 'sheet', sheets, page };
  if (family === 'slides') return { kind: 'slides', slides: slides.slides };
  return { kind: 'text', blocks: target.blocks };
}

function walkBody(
  parser: XmlPullParser,
  odCtx: OdContext,
  family: OdFamily,
  detail: BodyDetail,
  target: TextParseTarget,
  sheets: Sheet[],
  slides: SlidesParseTarget,
  page: PageSetupInfo,
): void {
  let e: XmlEvent | null;
  while ((e = parser.next()) !== null) {
    if (e.type !== 'start') continue;
    const local = e.local;
    if (local === 'text' && family === 'text') {
      parseTextBody(parser, odCtx, target);
      continue;
    }
    if (local === 'spreadsheet' && family === 'sheet') {
      parseSpreadsheetBody(parser, odCtx, sheets, page);
      continue;
    }
    if ((local === 'presentation' || local === 'drawing') && family === 'slides') {
      parseSlidesBody(parser, odCtx, slides, defaultSlideLayout(odCtx, detail));
      continue;
    }
    // 根容器（office:document-content / office:document / office:body）不跳过，
    // 继续向下找真正的正文根。其它元素整棵跳过。
    if (local === 'document-content' || local === 'document' || local === 'body' || local === 'document-meta') continue;
    if (!e.selfClosing) parser.skipElement();
  }
}

/** content.xml 里的页面布局：取第一个有尺寸的 style:page-layout。 */
function resolveDefaultLayout(styles: OdStyles): OdPageLayout {
  for (const def of styles.defs.values()) {
    if (def.family !== 'page-layout' || !def.page) continue;
    if (def.page.widthPt && def.page.heightPt) return def.page;
  }
  return {};
}

function defaultSlideLayout(odCtx: OdContext, detail: BodyDetail): OdPageLayout {
  void detail;
  const layout = resolveDefaultLayout(odCtx.styles);
  if (layout.widthPt && layout.heightPt) return layout;
  return { widthPt: DEFAULT_SLIDE_WIDTH_PT, heightPt: DEFAULT_SLIDE_HEIGHT_PT };
}

/* ==================================================================== */
/* 图片                                                                  */
/* ==================================================================== */

/** 一次性把模型里引用到的图片字节取回来，并计入 limits。 */
async function loadImages(source: PartSource, odCtx: OdContext): Promise<void> {
  if (odCtx.images.size === 0) return;
  if (!source.zipped) {
    // 扁平 ODF：图片要么内嵌为 base64（不支持），要么根本不在文件里。
    // 明确说明而不是留一堆取不到字节的占位图。
    warn(odCtx, '扁平 ODF 不含独立图片条目，图片将以占位形式显示');
    return;
  }
  const manifest = await source.manifest();
  for (const path of odCtx.pendingImages) {
    const img = odCtx.images.get(path);
    if (!img) continue;
    if (odCtx.imageCount >= odCtx.limits.maxImages) {
      markTruncated(odCtx, 'maxImages', `图片数量达到上限 ${odCtx.limits.maxImages}，其余图片未加载（仍保留位置占位）`);
      continue;
    }
    if (odCtx.imageBytes >= odCtx.limits.maxImageBytes) {
      markTruncated(odCtx, 'maxImageBytes', '图片累计字节达到上限，其余图片未加载（仍保留位置占位）');
      continue;
    }
    if (!source.has(path)) {
      warn(odCtx, `图片条目 ${path} 不在包内（可能被外部引用或已被裁剪），将显示为占位`);
      continue;
    }
    const bytes = await source.partBytes(path);
    if (!bytes) {
      warn(odCtx, `图片条目 ${path} 读取失败，将显示为占位`);
      continue;
    }
    img.data = bytes;
    const declaredMime = manifest.entries.get(path);
    if (declaredMime) img.mime = declaredMime;
    else if (img.mime === 'application/octet-stream') img.mime = mimeFromPath(path);
    odCtx.imageCount++;
    odCtx.imageBytes += bytes.length;
  }
}

/* ==================================================================== */
/* 收尾：组装 LiteDocument                                               */
/* ==================================================================== */

interface FinishInput {
  format: FormatId;
  family: OdFamily;
  meta: DocMeta;
  body: BodyResult;
  contentXml: string;
  started: number;
  pageLayout: OdPageLayout;
}

function finishDocument(ctx: ReadContext, odCtx: OdContext, input: FinishInput): LiteDocument {
  const stats: Partial<DocStats> = {
    warnings: [...new Set([...odCtx.warnings, ...ctx.guard.warnings])],
    truncated: [...new Set([...odCtx.truncated, ...ctx.guard.truncated])],
    imageCount: odCtx.imageCount,
    imageBytes: odCtx.imageBytes,
    sourceBytes: ctx.size,
  };

  const meta = input.meta;
  let outline: LiteDocument['outline'] = [];
  let blocks: Block[] | undefined;
  let sheets: Sheet[] | undefined;
  let slides: Slide[] | undefined;
  let kind: LiteDocument['kind'];

  if (input.body.kind === 'text') {
    kind = 'text';
    blocks = input.body.blocks;
    outline = outlineFromBlocks(blocks);
    stats.blockCount = countBlocks(blocks);
  } else if (input.body.kind === 'sheet') {
    kind = 'sheet';
    sheets = input.body.sheets;
    stats.cellCount = sheets.reduce((n, s) => n + Math.min(s.rowCount * s.colCount, ctx.limits.maxCells), 0);
    stats.blockCount = sheets.length;
    meta.sheetCount = sheets.length;
    // 页面尺寸来自工作表的 page-layout（style:page-layout-properties）
    if (input.body.page.widthPt) meta.pageWidth = input.body.page.widthPt;
    if (input.body.page.heightPt) meta.pageHeight = input.body.page.heightPt;
    if (input.body.page.margin) meta.margin = input.body.page.margin;
    outline = sheets.map((s, i) => ({ level: 1, text: s.name, target: { kind: 'sheet' as const, index: i } }));
  } else {
    kind = 'slides';
    slides = input.body.slides;
    for (const slide of slides) for (const shape of slide.shapes) ensureShapeSize(shape);
    stats.shapeCount = slides.reduce((n, s) => n + countShapes(s.shapes), 0);
    stats.blockCount = slides.length;
    meta.slideCount = slides.length;
    if (slides.length) {
      meta.pageWidth = slides[0].width;
      meta.pageHeight = slides[0].height;
    }
    outline = slides.map((s, i) => ({ level: 1, text: slideTitle(s) ?? `幻灯片 ${i + 1}`, target: { kind: 'slide' as const, index: i } }));
  }

  // 文字处理文档的页面尺寸也来自 page-layout（A4 的 odt 必须显示成 A4）
  if (kind === 'text' && input.pageLayout.widthPt) {
    meta.pageWidth = input.pageLayout.widthPt;
    meta.pageHeight = input.pageLayout.heightPt;
    if (input.pageLayout.margin) meta.margin = input.pageLayout.margin;
  }

  const doc = createDocument({
    kind,
    format: input.format,
    formatLabel: formatLabelFor(input.format),
    name: ctx.name,
    meta,
    outline,
    stats,
    blocks,
    sheets,
    slides,
  });

  // 统计：模型体积与耗时（engine 会补 parseMs，这里先给一个诚实的初值）
  doc.stats.modelBytes = estimateBytes({
    meta,
    outline,
    blocks,
    sheets: sheets?.map((s) => ({ name: s.name, rows: s.rowCount, cols: s.colCount, styles: s.styles, merges: s.merges })),
    slides: slides?.map((s) => ({ i: s.index, w: s.width, h: s.height, shapes: s.shapes.length, notes: s.notes })),
  });
  doc.stats.parseMs = now() - input.started;
  // 内容解析成功但 bytes 长度异常小 —— 大概率是空文档，明确写一条提示而不是静默
  if (kind === 'text' && blocks && blocks.length === 0) warn(odCtx, '文档正文为空（没有 text:p / text:h 元素）');
  return doc;
}

function countBlocks(blocks: readonly Block[]): number {
  let n = 0;
  for (const b of blocks) {
    n++;
    if (b.kind === 'table') for (const row of b.rows) for (const cell of row.cells) n += countBlocks(cell.blocks);
  }
  return n;
}

function countShapes(shapes: readonly Slide['shapes'][number][]): number {
  let n = 0;
  for (const s of shapes) {
    n++;
    if (s.shapes) n += countShapes(s.shapes);
  }
  return n;
}

/** 幻灯片标题：取第一个有文字的文本形状的前 120 字，供大纲显示。 */
function slideTitle(slide: Slide): string | undefined {
  for (const shape of slide.shapes) {
    if (!shape.blocks) continue;
    for (const b of shape.blocks) {
      if (b.kind !== 'para') continue;
      const text = (b.runs as Run[]).map((r) => r.text).join('').trim();
      if (text) return text.slice(0, 120);
    }
  }
  return undefined;
}

/** 带缓存的格式标签（避免每次走一遍 formats 表）。 */
const LABELS: Record<string, string> = {
  odt: 'OpenDocument 文本文档',
  ott: 'OpenDocument 文本模板',
  ods: 'OpenDocument 电子表格',
  ots: 'OpenDocument 表格模板',
  odp: 'OpenDocument 演示文稿',
  otp: 'OpenDocument 演示模板',
  odg: 'OpenDocument 图形',
  fodt: 'OpenDocument 文本（扁平 XML）',
  fods: 'OpenDocument 表格（扁平 XML）',
  fodp: 'OpenDocument 演示（扁平 XML）',
};

function formatLabelFor(id: FormatId): string {
  return LABELS[id] ?? 'OpenDocument 文档';
}

/* ==================================================================== */
/* 自注册                                                                */
/* ==================================================================== */

export const odfReader: FormatReader = {
  id: READER_ID,
  formats: ODF_FORMATS,
  read: readOdf,
};

// 模块顶层自注册：导入本包即「安装」了 ODF 支持。
// 这也让「支持哪些格式」由导入图决定，而不是靠一个中心开关 —— 见 registry.ts 的分层意图。
registerReader(odfReader);
