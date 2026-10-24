/**
 * XML 读取器。
 *
 * 定位：「结构化但不认识」的 XML。我们不知道它是配置、SVG 还是业务数据，
 * 所以不做任何语义映射，只给出两样最有用的东西：
 *   1. 缩进格式化的原文（可读、可复制）
 *   2. 用元素结构生成的大纲（顶层与前两层）—— 侧边栏可以直接跳到某个节点
 *
 * 为什么用事件流而不是建树：XML 往往深度很小但**宽度**极大（几万个同级节点）。
 * 建树会为每个节点分配对象；这里只保留一条祖先名字链（几十个字符串），
 * 峰值内存与「深度」同阶，而不是与文档规模同阶。
 */
import type { Block, LiteDocument, OutlineItem, Run } from '../../core/src/model.ts';
import type { ReadContext } from '../../core/src/registry.ts';
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { DocBuilder } from './builder.ts';
import { detectEncoding, makeDecoder } from './decode.ts';

/** 单个块最多容纳的行数：避免 10 万行 XML 产生 10 万个小块对象 */
const LINES_PER_BLOCK = 400;
/** 大纲最多记录多少项 */
const MAX_OUTLINE = 300;
/** 大纲只到第几层（顶层与前两层） */
const OUTLINE_DEPTH = 3;
/** 格式化输出行数上限 */
const MAX_LINES = 300000;

export async function readXml(ctx: ReadContext): Promise<LiteDocument> {
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
  if (encoding === 'gb18030') b.warn('已按 gb18030 解码（XML 未声明 encoding 时按内容推断）');
  const text = makeDecoder(encoding).decode(view);

  const fmt = formatXml(text, b);
  if (fmt.truncated) b.warn(`格式化行数超过 ${MAX_LINES.toLocaleString('en-US')}，后续内容未呈现`);
  const blockOfLine = pushFormatted(b, fmt.lines);
  // 大纲项的行号 -> 块索引：这一步让「点大纲跳转」在截断情况下也不会指向错块
  const outline: OutlineItem[] = [];
  for (const item of fmt.outline) {
    if (outline.length >= MAX_OUTLINE) {
      b.warn(`大纲项超过 ${MAX_OUTLINE} 个，已截断`);
      break;
    }
    const idx = blockOfLine[item.line] ?? blockOfLine[blockOfLine.length - 1];
    outline.push({ level: item.level, text: item.text, ...(idx === undefined ? {} : { target: { kind: 'block' as const, index: idx } }) });
  }
  return b.finish('xml', 'text', { outline, meta: { title: ctx.name, rootElement: fmt.root } });
}

interface RawOutline {
  level: number;
  text: string;
  /** 起始标签所在的行号 */
  line: number;
}

interface FormatResult {
  lines: string[];
  outline: RawOutline[];
  root?: string;
  truncated: boolean;
}

/**
 * 格式化：逐 token 输出，用**缩进栈**记住祖先名字与起始行，因此不需要建树。
 *
 * 输出规则（够用就好）：
 *   - 元素有子元素 -> 起始标签与结束标签各占一行
 *   - 空元素 / 只有文本的元素 -> 压成一行 `<a></a>` / `<a>text</a>`
 *   - 自闭合 -> 一行
 *   - 注释 / CDATA / PI / DOCTYPE 原样独立成行
 *   - 属性原样保留（不重排，避免破坏前缀与命名空间声明）
 */
function formatXml(text: string, b: DocBuilder): FormatResult {
  const lines: string[] = [];
  const outline: RawOutline[] = [];
  let root: string | undefined;
  let truncated = false;

  /** 祖先链：元素名 + 它的起始标签在 lines 里的下标 */
  const stack: { name: string; startLine: number; contentLine: number }[] = [];

  const emitStart = (e: XmlEvent): void => {
    const indent = '  '.repeat(stack.length);
    const attrs = e.attrs
      ? Object.entries(e.attrs)
          .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
          .join('')
      : '';
    const line = e.selfClosing ? `${indent}<${e.name}${attrs}/>` : `${indent}<${e.name}${attrs}>`;
    const idx = lines.length;
    lines.push(line);
    if (stack.length < OUTLINE_DEPTH) {
      outline.push({ level: stack.length + 1, text: outlineLabel(e), line: idx });
    }
    if (root === undefined) root = e.name;
    // 起始标签自身占了一行，不算「父元素的内容」
    const parent = stack[stack.length - 1];
    if (parent) parent.contentLine = Math.max(parent.contentLine, idx);
    if (!e.selfClosing) stack.push({ name: e.name, startLine: idx, contentLine: -1 });
  };

  const parser = new XmlPullParser(text, { keepWhitespace: false });
  let guard = 0;
  for (;;) {
    if (lines.length >= MAX_LINES) {
      truncated = true;
      break;
    }
    if ((guard++ & 0x3fff) === 0 && b.ctx.signal?.aborted) {
      b.warn('读取被取消，仅返回已格式化部分');
      break;
    }
    let e: XmlEvent | null;
    try {
      e = parser.next();
    } catch (err) {
      // 截断或畸形 XML：不抛错，保留已经格式化的部分
      b.warn(`XML 在偏移处解析中断：${err instanceof Error ? err.message : String(err)}；已保留此前的格式化内容`);
      break;
    }
    if (e === null) break;

    if (e.type === 'text' || e.type === 'cdata') {
      const t = e.text.trim();
      if (t === '') continue;
      const top = stack[stack.length - 1];
      // 若父元素的起始标签行还没有任何内容，就把文本并进那一行
      if (top && lines[top.startLine] !== undefined && !lines[top.startLine].includes('</')) {
        lines[top.startLine] = `${lines[top.startLine]}${escapeText(t)}`;
        top.contentLine = top.startLine;
      } else {
        const idx = lines.length;
        lines.push(`${'  '.repeat(stack.length)}${escapeText(t)}`);
        if (top) top.contentLine = idx;
      }
      continue;
    }
    if (e.type === 'comment') {
      const idx = lines.length;
      lines.push(`${'  '.repeat(stack.length)}<!--${e.text.trim()}-->`);
      const parent = stack[stack.length - 1];
      if (parent) parent.contentLine = Math.max(parent.contentLine, idx);
      continue;
    }
    if (e.type === 'pi') {
      lines.push(`${'  '.repeat(stack.length)}<?${e.text.trim()}?>`);
      continue;
    }
    if (e.type === 'doctype') {
      lines.push(`<!${e.text.trim()}>`);
      continue;
    }
    if (e.type === 'start') {
      emitStart(e);
      continue;
    }
    if (e.type === 'end') {
      const top = stack.pop();
      if (!top) continue; // 畸形的结束标签：忽略
      // 只有**同名**元素、且它起始行之后没有追加过任何行（contentLine 仍为 -1，
      // 说明没有子元素/文本）时，才就地补结束标签 —— 也就是 `<>` 与 `</>` 贴成一行。
      // 少这个判断的话，`<root><a/></root>` 里 root 会误判为空元素而被写成
      // `<root></root>`，同时 `</root>` 消失，缩进结构完全走样。
      const startLine = lines[top.startLine];
      if (top.name === e.name && startLine !== undefined && top.contentLine === -1 && !/<\/[^>]+>$/.test(startLine)) {
        lines[top.startLine] = `${startLine}</${top.name}>`;
        continue;
      }
      const idx = lines.length;
      lines.push(`${'  '.repeat(stack.length)}</${e.name}>`);
      const parent = stack[stack.length - 1];
      if (parent) parent.contentLine = Math.max(parent.contentLine, idx);
      continue;
    }
  }

  return { lines, outline, root, truncated };
}

function outlineLabel(e: XmlEvent): string {
  const attrs = e.attrs;
  if (attrs) {
    const id = attrs.id ?? attrs.ID ?? attrs.name ?? attrs.key;
    if (id) return `${e.name} #${id}`;
  }
  return e.name;
}

/** 属性值转义（回写文本时不能破坏结构） */
function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把格式化行压成块，返回「行号 -> 块索引」映射。
 * 行内换行用 breakBefore 表达（不拼 '\n'），渲染层可自行决定换行策略。
 */
function pushFormatted(b: DocBuilder, lines: string[]): number[] {
  const blockOfLine: number[] = new Array(lines.length).fill(-1);
  let i = 0;
  while (i < lines.length) {
    if (b.blocks.length >= b.ctx.limits.maxBlocks) {
      b.warn(`块数达到 maxBlocks=${b.ctx.limits.maxBlocks.toLocaleString('en-US')}，后续内容未呈现`);
      if (!b.ctx.guard.truncated.includes('maxBlocks')) {
        b.ctx.guard.truncated.push('maxBlocks');
        b.ctx.guard.warnings.push(`maxBlocks 达到上限 ${b.ctx.limits.maxBlocks.toLocaleString('en-US')}，后续内容已忽略`);
      }
      break;
    }
    const end = Math.min(i + LINES_PER_BLOCK, lines.length);
    const runs: Run[] = [];
    for (let k = i; k < end; k++) {
      const run: Run = { text: lines[k], style: { font: 'Consolas' } };
      if (k > i) run.breakBefore = true;
      runs.push(run);
    }
    const block: Block = { kind: 'para', runs, style: { styleName: 'Code', lineHeight: 1.25 } };
    const idx = b.blocks.length;
    if (!b.push(block)) break;
    for (let k = i; k < end; k++) blockOfLine[k] = idx;
    i = end;
  }
  return blockOfLine;
}

/** 便利导出：把 XML 文本格式化成行数组（测试与外部调用用）。 */
export function formatXmlText(text: string, warnings?: string[]): string[] {
  const stub = {
    ctx: { signal: undefined },
    warn: (m: string) => warnings?.push(m),
  } as unknown as DocBuilder;
  return formatXml(text, stub).lines;
}
