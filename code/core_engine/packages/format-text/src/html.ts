/**
 * HTML 读取器。
 *
 * 为什么用 XmlPullParser 而不是 DOMParser：
 *   DOMParser 会为整篇文档建对象树。一个 20 MB 的网页展开成 DOM 后常驻内存
 *   可达上百 MB，而且必须先整份驻留成字符串。XmlPullParser 是事件流，
 *   遇到 <script>/<style>/<head> 可以直接 skipElement() 跳过整棵子树，
 *   连事件都不产生。
 *
 * 覆盖原则：**只覆盖常见标签，未知标签递归取其子内容而不丢文本**。
 * 这比「尽量实现 HTML 规范」更适合本项目的目标（能打开、少内存、不抛错）。
 *
 * 已知不做（降级并记 warning）：
 *   - 不做 CSS 布局/盒模型（只取文本、表格、图片与少量行内样式）
 *   - 不解析 <style> 里的规则求色值
 *   - 不做 HTML 的隐式闭合恢复（<p> 不写 </p> 时靠栈的容错兜住）
 *   - <iframe>/<object> 等内联内容按未知标签递归取文本
 */
import type { Block, InlineImage, LiteDocument, OutlineItem, ParaStyle, Run, RunStyle, Table, TableCell, TableRow } from '../../core/src/model.ts';
import type { ReadContext } from '../../core/src/registry.ts';
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { DocBuilder } from './builder.ts';
import { detectEncoding, makeDecoder } from './decode.ts';
import { decodeDataUri, imageSizeFromBytes } from './image.ts';

const MONO = 'Consolas';
const BULLET = '\u2022';

/** 会产生独立块的标签 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'dl', 'dt', 'dd', 'blockquote', 'figure', 'figcaption', 'form', 'fieldset',
  'address', 'center', 'body', 'html', 'output', 'details', 'summary',
]);
/** 完全丢弃内容的标签 */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base', 'iframe']);
/** 会产生行内 RunStyle 的标签 */
const INLINE_STYLE_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'tt',
  'kbd', 'samp', 'sup', 'sub', 'mark', 'small', 'big', 'a', 'span', 'font',
]);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const MAX_WARN_TAGS = 40;

interface StyleFrame {
  tag: string;
  style: RunStyle | undefined;
}

interface ListCtx {
  ordered: boolean;
  counter: number;
}

interface Ctx {
  b: DocBuilder;
  parser: XmlPullParser;
  /** 当前段落的行内 run 缓冲 */
  buf: Run[];
  pendingBreak: boolean;
  styleStack: StyleFrame[];
  /** 当前块级标签携带的段落样式 */
  current: ParaStyle | undefined;
  lists: ListCtx[];
  /** <pre> 嵌套深度：>0 表示保留空白 */
  preDepth: number;
  warned: Set<string>;
  title: string | undefined;
  outline: OutlineItem[];
  full: boolean;
  /** 表格单元格正在收集 run（由 collectCellRuns 推送/弹出） */
  cellStack: Run[][];
}

/* ==================================================================== */
/* 主流程                                                               */
/* ==================================================================== */

export async function readHtml(ctx: ReadContext): Promise<LiteDocument> {
  const b = new DocBuilder(ctx);
  const bytes = await ctx.bytes();
  const budget = ctx.limits.maxFileBytes;
  let view = bytes;
  if (bytes.length > budget) {
    view = bytes.subarray(0, budget);
    b.warn(`文件 ${bytes.length} 字节超过 maxFileBytes=${budget} 字节，已截断`);
    if (!ctx.guard.truncated.includes('maxFileBytes')) {
      ctx.guard.truncated.push('maxFileBytes');
      ctx.guard.warnings.push(`maxFileBytes 达到上限 ${budget.toLocaleString('en-US')}，后续内容已忽略`);
    }
  }
  const encoding = detectEncoding(view);
  if (encoding === 'gb18030') b.warn('已按 gb18030 解码（非 UTF-8 内容；HTML 未声明 charset 时很常见）');

  // 用字符串构造解析器：编码已在边界处定案，因此 <meta charset> 无需预扫描。
  const text = makeDecoder(encoding).decode(view);
  // <title> 单独预扫描：它在 <head> 里，而 <head> 会被整棵跳过（脚本/样式/元数据
  // 都不该进正文）。若把 title 的提取放进主循环，就必须为它放开 <head>，
  // 那是得不偿失的 —— 一行正则比放宽丢弃规则安全得多。
  const titleMatch = /<title[^>]*>([\s\S]{0,500}?)<\/title\s*>/i.exec(text);
  const title = titleMatch ? decodeBasicEntities(titleMatch[1]).trim().slice(0, 300) : undefined;
  const c: Ctx = {
    b,
    parser: new XmlPullParser(text, { keepWhitespace: true }),
    buf: [],
    pendingBreak: false,
    styleStack: [],
    current: undefined,
    lists: [],
    preDepth: 0,
    warned: new Set(),
    title: title || undefined,
    outline: [],
    full: false,
    cellStack: [],
  };

  await walk(c, '');

  const meta = { title: c.title ?? c.outline.find((o) => o.level === 1)?.text ?? c.outline[0]?.text };
  return b.finish('html', 'text', { outline: c.outline, meta });
}

/** 只处理最常见的实体（title 里出现 &amp; 之类很平常）。 */
function decodeBasicEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 事件主循环。`until` 是应当终止的结束标签名（'' 表示直到文档结束）。
 *
 * 为什么不需要在返回前手动跳过结束标签：XmlPullParser 自己维护标签嵌套深度，
 * 当它产出 `</div>` 事件时，下一个事件必然是该 div 之外的兄弟节点。
 */
async function walk(c: Ctx, until: string): Promise<void> {
  const p = c.parser;
  for (;;) {
    if (c.full) return;
    if (c.b.ctx.signal?.aborted) {
      c.b.warn('读取被取消，仅返回已解析部分');
      return;
    }
    let e: XmlEvent | null;
    try {
      e = p.next();
    } catch (err) {
      // 畸形 HTML 很常见（未闭合的 <div>、裸 &）：解析中断时就地收尾，
      // 而不是让整篇文档打不开 —— 「能打开优先于严格校验」。
      c.b.warn(`HTML 在偏移处解析中断：${err instanceof Error ? err.message : String(err)}；已保留此前内容`);
      return;
    }
    if (e === null) return;

    if (e.type === 'end') {
      const local = e.local.toLowerCase();
      if (until && local === until) return;
      popInline(c, local);
      continue;
    }
    if (e.type === 'text' || e.type === 'cdata') {
      if (c.preDepth > 0) appendRaw(c, e.text);
      else appendCollapsed(c, e.text);
      continue;
    }
    if (e.type !== 'start') continue;

    const local = e.local.toLowerCase();
    const attrs = e.attrs ?? {};

    if (c.preDepth > 0) {
      // <pre> 内不解释结构：只把 <br> 当换行，其余标签剥掉、文本原样保留
      if (local === 'br') appendRaw(c, '\n');
      else if (!e.selfClosing) await walk(c, local);
      continue;
    }

    if (DROP_TAGS.has(local)) {
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    if (local === 'title' && c.title === undefined) {
      const t = collectText(p, 'title').trim();
      if (t) c.title = t.slice(0, 300);
      continue;
    }
    if (local === 'table') {
      flushPara(c);
      const table = parseTable(c);
      if (table) emitBlock(c, table);
      else c.b.warn('遇到空的 <table>，已跳过');
      continue;
    }
    if (local === 'img') {
      pushImage(c, attrs);
      // **不要**在这里调用 skipElement()：自闭合元素没有子树，而
      // skipElement() 会一直读到下一次 skipDepth 归零 —— 也就是把紧随其后的
      // 兄弟节点（含 `<p>...</p>` 的结束标签）整段吞掉。
      // 实测踩过：`<p>a<img1><img2></p>` 只会出现 img1。
      continue;
    }
    if (local === 'br') {
      c.pendingBreak = true;
      continue;
    }
    if (local === 'hr') {
      flushPara(c);
      emitBlock(c, { kind: 'rule', thickness: 0.75 });
      continue;
    }
    if (local === 'ul' || local === 'ol') {
      // 不要在这里 flush：嵌套列表出现在 <li> 内部时，li 已经开好了段落，
      // 无条件 flush 会拿 li 的段落样式产出一个**空段落**
      // （表现为列表中间多出一个空行，踩过）。
      if (!e.selfClosing) {
        c.lists.push({ ordered: local === 'ol', counter: 0 });
        await walk(c, local);
        c.lists.pop();
      }
      continue;
    }
    if (local === 'pre') {
      const style: ParaStyle = { styleName: 'Preformatted' };
      startPara(c, style);
      c.preDepth++;
      if (!e.selfClosing) await walk(c, 'pre');
      c.preDepth--;
      flushPara(c, style);
      continue;
    }
    if (local === 'li') {
      const list = c.lists[c.lists.length - 1];
      if (list) list.counter++;
      const level = Math.max(0, c.lists.length - 1);
      const style: ParaStyle = {
        listLevel: level,
        listMarker: list ? (list.ordered ? `${list.counter}.` : BULLET) : BULLET,
        listOrdered: list?.ordered ?? false,
        indentStart: (level + 1) * 18,
      };
      flushPara(c);
      startPara(c, style);
      if (!e.selfClosing) await walk(c, 'li');
      // 只有确实产出了行内内容才落段。
      // 踩过的坑：无条件 flushPara 时，`<li>甲<ul>…</ul></li>` 这种「列表项里
      // 只有嵌套列表」的情况会在列表中间凭空多出一个空段落。
      if (c.buf.length > 0) flushPara(c, style);
      continue;
    }
    if (HEADING_TAGS.has(local)) {
      const level = Number.parseInt(local[1], 10);
      const style: ParaStyle = { outlineLevel: level - 1, styleName: `Heading ${level}`, spaceBefore: 8, spaceAfter: 4 };
      flushPara(c);
      startPara(c, style);
      const blockIndex = c.b.blocks.length;
      if (!e.selfClosing) await walk(c, local);
      const headingText = c.buf
        .map((r) => r.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (headingText) c.outline.push({ level, text: headingText.slice(0, 200), target: { kind: 'block', index: blockIndex } });
      flushPara(c, style);
      continue;
    }
    if (BLOCK_TAGS.has(local)) {
      flushPara(c);
      const style: ParaStyle | undefined =
        local === 'blockquote' ? { indentStart: 18, border: { left: { width: 2, color: '#cccccc', style: 'solid' } } } : undefined;
      startPara(c, style);
      if (!e.selfClosing) await walk(c, local);
      flushPara(c, style);
      continue;
    }
    if (local === 'td' || local === 'th' || local === 'tr' || local === 'tbody' || local === 'thead' || local === 'tfoot' || local === 'caption') {
      // 表格外的孤立单元格（畸形 HTML）：不要丢内容
      if (!e.selfClosing) await walk(c, local);
      continue;
    }
    if (INLINE_STYLE_TAGS.has(local)) {
      c.styleStack.push(makeStyleFrame(local, attrs, currentStyle(c)));
      if (!e.selfClosing) await walk(c, local);
      popInline(c, local);
      continue;
    }
    // 未知标签：递归取其子内容，绝不丢弃文本
    if (c.warned.size < MAX_WARN_TAGS && !c.warned.has(local)) {
      c.warned.add(local);
      c.b.warn(`未识别的标签 <${local}>：已保留其文本内容`);
    }
    if (!e.selfClosing) await walk(c, local);
  }
}

/** 弹出与 local 匹配的最近一个行内样式帧（畸形 HTML 里结束标签常常不配对）。 */
function popInline(c: Ctx, local: string): void {
  for (let i = c.styleStack.length - 1; i >= 0; i--) {
    if (c.styleStack[i].tag === local) {
      c.styleStack.splice(i, 1);
      return;
    }
  }
}

/* ==================================================================== */
/* 行内缓冲                                                             */
/* ==================================================================== */

function currentStyle(c: Ctx): RunStyle | undefined {
  return c.styleStack[c.styleStack.length - 1]?.style;
}

/**
 * 构造行内样式帧。样式是**派生**的（复制基准再叠加），
 * 这样 <a><b>x</b></a> 里的 x 同时带 link 与 bold。
 */
function makeStyleFrame(tag: string, attrs: Record<string, string>, base: RunStyle | undefined): StyleFrame {
  const style: RunStyle = base ? { ...base } : {};
  switch (tag) {
    case 'b':
    case 'strong':
      style.bold = true;
      break;
    case 'i':
    case 'em':
      style.italic = true;
      break;
    case 'u':
    case 'ins':
      style.underline = true;
      break;
    case 's':
    case 'strike':
    case 'del':
      style.strike = true;
      break;
    case 'code':
    case 'tt':
    case 'kbd':
    case 'samp':
      style.font = MONO;
      break;
    case 'sup':
      style.vertAlign = 'superscript';
      break;
    case 'sub':
      style.vertAlign = 'subscript';
      break;
    case 'mark':
      style.highlight = normalizeColor(attrs.color) ?? '#ffff00';
      break;
    case 'a':
      style.link = sanitizeHref(attrs.href);
      break;
    case 'font': {
      const col = normalizeColor(attrs.color);
      if (col) style.color = col;
      const size = attrs.size ? Number.parseFloat(attrs.size) : Number.NaN;
      if (Number.isFinite(size) && size > 0) style.size = size > 8 ? size : size * 12; // 1..7 是字号档位
      break;
    }
    default:
      break;
  }
  return { tag, style: Object.keys(style).length ? style : undefined };
}

function sanitizeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const t = href.trim();
  if (!t || /^\s*(javascript|vbscript|data:text\/html)/i.test(t)) return undefined;
  return t;
}

/** 把颜色属性（#rgb / #rrggbb / rgb() / 颜色名）归一为 #rrggbb。 */
export function normalizeColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(t);
  if (rgb) {
    const hex = (n: string) => Math.min(255, Number.parseInt(n, 10)).toString(16).padStart(2, '0');
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
  }
  return NAMED_COLORS[t];
}

const NAMED_COLORS: Record<string, string | undefined> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
  lime: '#00ff00',
  aqua: '#00ffff',
  teal: '#008080',
  navy: '#000080',
  fuchsia: '#ff00ff',
  purple: '#800080',
};

function startPara(c: Ctx, style: ParaStyle | undefined): void {
  c.current = style;
  c.buf = [];
  c.pendingBreak = false;
}

/**
 * 折叠空白后追加文本。
 * HTML 渲染时换行与连续空格都折叠成一个空格，这里就地折叠，免得渲染层再猜。
 * 但**不**跨行内标签边界丢空格：`<b>a</b> <i>b</i>` 中间那个空格必须留下。
 */
function appendCollapsed(c: Ctx, raw: string): void {
  if (c.full) return;
  let text = raw.replace(/\s+/g, ' ');
  if (text === '') return;
  const last = c.buf[c.buf.length - 1];
  // 行首空格丢掉（HTML 里缩进产生的空白不参与渲染）；
  // 缓冲区尾部已有空格时不重复加。
  if (c.buf.length === 0) text = text.replace(/^ /, '');
  else if (last && (last.text === '' || /\s$/.test(last.text))) text = text.replace(/^ /, '');
  if (text === '') return;
  pushRun(c, text, false);
}

/** <pre> 内原样追加，并按换行切成多行（用 breakBefore 表达换行）。 */
function appendRaw(c: Ctx, raw: string): void {
  if (c.full || raw === '') return;
  const parts = raw.split(/\r\n|\r|\n/);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) c.pendingBreak = true;
    if (parts[i] !== '') pushRun(c, parts[i], true);
  }
}

function pushRun(c: Ctx, text: string, forceMono: boolean): void {
  const base = currentStyle(c);
  const style: RunStyle | undefined = forceMono ? { ...(base ?? {}), font: MONO } : base;
  const run: Run = { text };
  if (style && Object.keys(style).length > 0) run.style = { ...style };
  if (c.pendingBreak) {
    run.breakBefore = true;
    c.pendingBreak = false;
  }
  const target = c.cellStack[c.cellStack.length - 1];
  if (target) target.push(run);
  else c.buf.push(run);
}

/** 把当前缓冲落成一个段落块。 */
function flushPara(c: Ctx, style?: ParaStyle): void {
  const runs = c.buf;
  c.buf = [];
  c.pendingBreak = false;
  const st = style ?? c.current;
  c.current = undefined;
  if (runs.length === 0) {
    // 空段落：只有显式块级标签才值得保留（<p></p> 是作者写的空行）
    if (!st) return;
    emitBlock(c, { kind: 'para', runs: [{ text: '' }], style: st });
    return;
  }
  // 全空白的段落不产出，否则每个 `<div>\n</div>` 都会留一个空行。
  // 这里顺手去掉尾部多余空格：块级元素之间的缩进空白不该留在正文里。
  while (runs.length > 0 && runs[runs.length - 1].text.trim() === '') runs.pop();
  if (runs.length === 0) return;
  emitBlock(c, { kind: 'para', runs, style: st });
}

function emitBlock(c: Ctx, block: Block): void {
  if (c.full) return;
  if (!c.b.push(block)) {
    c.full = true;
    if (!c.b.ctx.guard.truncated.includes('maxBlocks')) {
      c.b.ctx.guard.truncated.push('maxBlocks');
      c.b.ctx.guard.warnings.push(`maxBlocks 达到上限 ${c.b.ctx.limits.maxBlocks.toLocaleString('en-US')}，后续内容已忽略`);
    }
  }
}

/** 收集某个元素的纯文本（用于 <title>）。会消费该元素的结束标签。 */
function collectText(p: XmlPullParser, tag: string): string {
  let out = '';
  let depth = 1;
  for (;;) {
    const e = p.next();
    if (e === null) break;
    if (e.type === 'start') {
      if (!e.selfClosing) depth++;
      continue;
    }
    if (e.type === 'end') {
      depth--;
      if (depth <= 0) break;
      continue;
    }
    if (out.length < 2000 && (e.type === 'text' || e.type === 'cdata')) out += e.text;
  }
  void tag;
  return out;
}

/* ==================================================================== */
/* 图片                                                                 */
/* ==================================================================== */

function pushImage(c: Ctx, attrs: Record<string, string>): void {
  const img = imageFromAttrs(c.b, attrs.src, attrs.alt, attrs.width, attrs.height);
  const target = c.cellStack[c.cellStack.length - 1];
  if (target) {
    // 表格单元格里只放行内 run
    const run: Run = { text: '', image: img };
    if (c.pendingBreak) {
      run.breakBefore = true;
      c.pendingBreak = false;
    }
    target.push(run);
    return;
  }
  // 段落里的图片：先落掉图片之前的文字，再把图片作为**块级** ImageBlock 产出。
  // 不要同时往行内缓冲里也塞一个图片 run —— 踩过的坑：缓冲里残留的 run 会在
  // 后面某个块结束时被 flush 出来，导致图片重复出现（甚至把后续 run 吞掉）。
  flushPara(c);
  c.pendingBreak = false;
  c.b.addImage(img.data?.byteLength ?? 0);
  emitBlock(c, { kind: 'image', image: img });
}

/**
 * 构造图片。
 *
 * data: URI 直接解码出字节（自包含，不需要网络）；外链只保留 alt 与 URL，
 * 因为读取器**刻意不做网络请求** —— 打开一份文档不该产生外部副作用。
 *
 * 参数用窄接口 `DocBuilder | undefined` 而不是内部的 Ctx：它只需要
 * 「能记 warning」这一件事，收窄接口避免把内部状态类型泄漏到导出签名上。
 */
export function imageFromAttrs(
  b: DocBuilder | undefined,
  src: string | undefined,
  alt: string | undefined,
  widthAttr?: string,
  heightAttr?: string,
): InlineImage {
  const w = parseCssLen(widthAttr);
  const h = parseCssLen(heightAttr);
  if (src && /^data:/i.test(src)) {
    const decoded = decodeDataUri(src);
    if (decoded) {
      const size = imageSizeFromBytes(decoded.mime, decoded.bytes);
      return {
        mime: decoded.mime,
        width: w ?? size.widthPt,
        height: h ?? size.heightPt,
        alt: alt || undefined,
        data: decoded.bytes,
      };
    }
    b?.warn('有一个 data: URI 图片无法解码（不是合法 base64），已按占位图处理');
  }
  if (src) b?.warn(`图片为外部引用（${src.slice(0, 120)}），未联网加载，仅保留链接与 alt 文本`);
  return { mime: 'image/*', width: w ?? 200, height: h ?? 150, alt: alt || undefined, partPath: src };
}

/** CSS 长度 -> pt（模型内唯一长度单位）。百分比无法在此解析成绝对值。 */
function parseCssLen(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^\s*(-?[\d.]+)\s*(px|pt|em|rem|%)?\s*$/.exec(v);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2] ?? 'px';
  if (unit === 'pt') return n;
  if (unit === 'em' || unit === 'rem') return n * 12;
  if (unit === '%') return undefined;
  return (n * 72) / 96;
}

/* ==================================================================== */
/* 表格                                                                 */
/* ==================================================================== */

/**
 * 解析 <table>。整棵子树（含结束标签）由本函数消费，调用方不要再 skipElement。
 *
 * 列数不一致时按最宽行补齐并记 warning。colspan 会被保留为 colSpan，
 * 但**不**生成占位格 —— 占位格会让补齐后的列位置整体错位。
 */
function parseTable(c: Ctx): Table | undefined {
  const p = c.parser;
  const rows: TableRow[] = [];
  let pendingRow: TableRow | undefined;
  let cell: { runs: Run[]; colSpan: number; header: boolean } | undefined;

  const finishCell = (): void => {
    if (!cell) return;
    const para: Block = { kind: 'para', runs: cell.runs.length ? cell.runs : [{ text: '' }], style: cell.header ? { align: 'center' } : undefined };
    const cellObj: TableCell = { blocks: [para] };
    if (cell.colSpan > 1) cellObj.colSpan = cell.colSpan;
    if (cell.header) cellObj.shading = '#f3f3f3';
    if (pendingRow) pendingRow.cells.push(cellObj);
    cell = undefined;
  };

  for (;;) {
    const e = p.next();
    if (e === null) break;
    const local = e.local.toLowerCase();

    if (e.type === 'end') {
      if (local === 'table') break;
      continue;
    }
    if (e.type === 'text' || e.type === 'cdata') {
      if (cell) {
        const collapsed = e.text.replace(/\s+/g, ' ');
        appendCellText(cell.runs, collapsed);
      }
      continue;
    }
    if (e.type !== 'start') continue;

    if (local === 'tr') {
      finishCell();
      if (pendingRow) rows.push(pendingRow);
      pendingRow = { cells: [] };
      if (e.selfClosing) {
        rows.push(pendingRow);
        pendingRow = undefined;
      }
      continue;
    }
    if (local === 'td' || local === 'th') {
      finishCell();
      const span = Number.parseInt(e.attrs?.colspan ?? '1', 10);
      cell = { runs: [], colSpan: Number.isFinite(span) && span > 1 ? Math.min(64, span) : 1, header: local === 'th' };
      if (pendingRow && local === 'th') pendingRow.header = true;
      if (!e.selfClosing) cell.runs = collectCellRuns(c);
      finishCell();
      continue;
    }
    if (local === 'caption') {
      const cap = e.selfClosing ? '' : collectText(p, 'caption');
      if (cap.trim()) {
        rows.unshift({ cells: [{ blocks: [{ kind: 'para', runs: [{ text: cap.replace(/\s+/g, ' ').trim(), style: { italic: true } }] }] }] });
      }
      continue;
    }
    if (local === 'script' || local === 'style') {
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    if (local === 'br') {
      if (cell) cell.runs.push({ text: '', breakBefore: true });
      continue;
    }
    // 其他结构标签（tbody/thead/tfoot/colgroup/col）跳过自身，继续读子节点
    if (!e.selfClosing) p.skipElement();
  }
  finishCell();
  if (pendingRow) rows.push(pendingRow);
  if (rows.length === 0) return undefined;

  const cols = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  if (cols === 0) return undefined;
  let padded = false;
  for (const r of rows) {
    while (r.cells.length < cols) {
      r.cells.push({ blocks: [{ kind: 'para', runs: [{ text: '' }] }] });
      padded = true;
    }
  }
  if (padded) c.b.warn('表格各行列数不一致，已按最宽行补齐空单元格');
  return { kind: 'table', rows };
}

/** 单元格文本追加：折叠空白，但保留标签之间的单个空格。 */
function appendCellText(runs: Run[], collapsed: string): void {
  if (collapsed === '') return;
  let text = collapsed;
  const last = runs[runs.length - 1];
  if (runs.length === 0) text = text.replace(/^ /, '');
  else if (last && (last.text === '' || /\s$/.test(last.text))) text = text.replace(/^ /, '');
  if (text === '') return;
  runs.push({ text });
}

/**
 * 收集一个单元格的行内内容。
 *
 * 不复用 walk()：walk 产出的是块级段落，而单元格内容必须是纯 Run[]。
 * 本函数消费该单元格的结束标签。
 */
function collectCellRuns(c: Ctx): Run[] {
  const p = c.parser;
  const runs: Run[] = [];
  const styleStack: StyleFrame[] = [];
  let depth = 1;
  c.cellStack.push(runs);
  try {
    for (;;) {
      const e = p.next();
      if (e === null) break;
      if (e.type === 'start') {
        const local = e.local.toLowerCase();
        if (local === 'br') {
          runs.push({ text: '', breakBefore: true });
          continue;
        }
        if (local === 'script' || local === 'style') {
          if (!e.selfClosing) p.skipElement();
          continue;
        }
        if (INLINE_STYLE_TAGS.has(local)) {
          styleStack.push(makeStyleFrame(local, e.attrs ?? {}, styleStack[styleStack.length - 1]?.style));
        }
        if (!e.selfClosing) depth++;
        continue;
      }
      if (e.type === 'end') {
        depth--;
        if (depth <= 0) break;
        const local = e.local.toLowerCase();
        for (let i = styleStack.length - 1; i >= 0; i--) {
          if (styleStack[i].tag === local) {
            styleStack.splice(i, 1);
            break;
          }
        }
        continue;
      }
      if (e.type === 'text' || e.type === 'cdata') {
        const collapsed = e.text.replace(/\s+/g, ' ');
        if (collapsed.trim() === '') {
          if (runs.length > 0 && !/\s$/.test(runs[runs.length - 1].text)) runs.push({ text: ' ' });
          continue;
        }
        const frame = styleStack[styleStack.length - 1];
        const style = frame?.style;
        const run: Run = { text: collapsed };
        if (style && Object.keys(style).length) run.style = { ...style };
        runs.push(run);
      }
    }
  } finally {
    c.cellStack.pop();
  }
  // 去掉首尾多余空格
  const first = runs[0];
  if (first && first.text) first.text = first.text.replace(/^ /, '');
  const last = runs[runs.length - 1];
  if (last && last.text) last.text = last.text.replace(/ $/, '');
  return runs.filter((r) => r.text !== '' || r.breakBefore || r.image);
}
