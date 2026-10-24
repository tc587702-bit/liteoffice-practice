/**
 * @liteoffice/format-text —— 纯文本家族读取器。
 *
 * 负责 FormatId：txt log md csv tsv json html xml rtf
 *
 * 架构约定：本包在**模块顶层自注册**读取器。因此「支持哪些格式」由
 * 「import 了哪些包」决定 —— 不用 Office 格式的用户不必为它们付出解析器体积
 * （这也是「轻量」在架构上的落点，见 docs/CONVENTIONS.md 第 5 节）。
 *
 * 不用 enum / 构造函数参数属性 / namespace（strip-only 类型擦除的硬约束）。
 *
 * 内存策略一句话：**能流就流** —— 大文本逐行解码（只持有一行），
 * 大 XML/HTML 用事件流（只持有祖先名字链），CSV 逐字符扫（只持有当前记录），
 * 受 maxFileBytes / maxBlocks / maxCells 三重约束，任何截断都记进 stats.truncated。
 */
import type { FormatId, LiteDocument } from '../../core/src/model.ts';
import type { FormatReader, ReadContext } from '../../core/src/registry.ts';
import { registerReader } from '../../core/src/registry.ts';
import { readMarkdown, readPlainText } from './text.ts';
import { readDelimited } from './csv.ts';
import { readJson } from './json.ts';
import { readHtml } from './html.ts';
import { readXml } from './xmltext.ts';
import { readRtf } from './rtf.ts';

/** 纯文本类（一行一段落） */
const PLAIN_FORMATS: readonly FormatId[] = ['txt', 'log'];

/**
 * 纯文本读取器：txt / log。
 * md 虽然也是 text 家族，但有自己的块级语义，见 MD_READER。
 */
const PLAIN_READER: FormatReader = {
  id: 'text-plain',
  formats: PLAIN_FORMATS,
  async read(ctx: ReadContext): Promise<LiteDocument> {
    // format 由扩展名/嗅探决定；这里用文件名兜底，保证 stats.format 正确
    const format = pickFormat(ctx.name, PLAIN_FORMATS);
    return ctx.phase('text', () => readPlainText(ctx, format));
  },
};

/** Markdown（自研解析器：标题/列表/代码块/引用/表格/行内样式） */
const MD_READER: FormatReader = {
  id: 'text-markdown',
  formats: ['md'],
  read: (ctx: ReadContext) => ctx.phase('markdown', () => readMarkdown(ctx)),
};

/** 分隔符表格：csv / tsv -> kind: 'sheet' 的 UDM 文档 */
const CSV_READER: FormatReader = {
  id: 'text-delimited',
  formats: ['csv', 'tsv'],
  read: (ctx: ReadContext) => ctx.phase('csv', () => readDelimited(ctx, pickFormat(ctx.name, ['csv', 'tsv']))),
};

/** JSON：格式化呈现 + 顶层键大纲，解析失败降级为纯文本 */
const JSON_READER: FormatReader = {
  id: 'text-json',
  formats: ['json'],
  read: (ctx: ReadContext) => ctx.phase('json', () => readJson(ctx)),
};

/** HTML：XmlPullParser 事件流，块级/行内/表格/图片映射到 UDM */
const HTML_READER: FormatReader = {
  id: 'markup-html',
  formats: ['html'],
  read: (ctx: ReadContext) => ctx.phase('html', () => readHtml(ctx)),
};

/** XML：格式化缩进 + 元素结构大纲 */
const XML_READER: FormatReader = {
  id: 'markup-xml',
  formats: ['xml'],
  read: (ctx: ReadContext) => ctx.phase('xml', () => readXml(ctx)),
};

/** RTF：够用的控制字解析器 */
const RTF_READER: FormatReader = {
  id: 'text-rtf',
  formats: ['rtf'],
  read: (ctx: ReadContext) => ctx.phase('rtf', () => readRtf(ctx)),
};

/**
 * 从文件名推断具体格式。
 *
 * 为什么需要它：一个读取器声明了多个格式（txt|log、csv|tsv），
 * 而 FormatReader.read() 只知道 ctx.name。用扩展名落定 format 才能让
 * stats.format / 元数据 / UI 标题都正确（否则 log 文件会被标成 txt）。
 */
function pickFormat(name: string, allowed: readonly FormatId[]): FormatId {
  const ext = name.replace(/\\/g, '/').split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  const hit = allowed.find((f) => f === ext);
  if (hit) return hit;
  return allowed[0];
}

// ---- 顶层自注册：import 本包即完成注册（CONVENTIONS 第 5 节的硬要求） ----
registerReader(PLAIN_READER);
registerReader(MD_READER);
registerReader(CSV_READER);
registerReader(JSON_READER);
registerReader(HTML_READER);
registerReader(XML_READER);
registerReader(RTF_READER);

export const READERS: readonly FormatReader[] = [PLAIN_READER, MD_READER, CSV_READER, JSON_READER, HTML_READER, XML_READER, RTF_READER];

export { readPlainText, readMarkdown } from './text.ts';
export { readDelimited, probeDelimiter, looksLikeHeader, DELIMITERS } from './csv.ts';
export type { Delimiter, DelimiterChoice } from './csv.ts';
export { readJson } from './json.ts';
export { readHtml, normalizeColor, imageFromAttrs } from './html.ts';
export { DocBuilder } from './builder.ts';
export { readXml, formatXmlText } from './xmltext.ts';
export { readRtf, parseRtf } from './rtf.ts';
export type { RtfParseResult, RtfOptions } from './rtf.ts';
export { parseMarkdown, parseInline, splitTableRow, isTableDelimiter } from './mdparse.ts';
export type { MdParseResult, MdOutlineItem, MdOptions } from './mdparse.ts';
export { decodeBytes, detectEncoding, makeDecoder, looksLikeUtf8 } from './decode.ts';
export { decodeBase64, decodeDataUri, imageSizeFromBytes } from './image.ts';
export { linesFromBytes, linesFromString } from './lineread.ts';
export type { LineSplitter } from './lineread.ts';
