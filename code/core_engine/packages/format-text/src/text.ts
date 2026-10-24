/**
 * txt / log / md 读取器。
 *
 * 共同点：都是「一坨文本」。差别只在块级语义（md 有标题/列表/表格）。
 *
 * 内存策略（大文件路径）：
 *   1. 先按 maxFileBytes 截断字节视图（truncated 记 'maxFileBytes'）
 *   2. 用 linesFromBytes 逐行解码 —— 任意时刻**只持有一行**文本、
 *      一个块数组，绝不出现「原始字符串 + 行数组 + 段落数组」三份共存
 *   3. 每行 push 一次就 probe 一次 maxBlocks，超限立即停下
 *      （继续解析只是白烧 CPU，用户看到的也不会更多）
 *
 * 编码：先嗅探再解码，gb18030 回退见 decode.ts 的说明。
 */
import type { Block, FormatId, LiteDocument, ParaStyle, Run } from '../../core/src/model.ts';
import type { ReadContext } from '../../core/src/registry.ts';
import { now } from '../../core/src/memory.ts';
import { DocBuilder, firstText } from './builder.ts';
import { detectEncoding, makeDecoder } from './decode.ts';
import { linesFromBytes } from './lineread.ts';
import { parseMarkdown, type MdOutlineItem } from './mdparse.ts';

/**
 * 登记一次「按上限截断」。
 *
 * 为什么不用 guard.probe：probe 的计数语义是「消耗量」，而文件字节数是
 * 一次性事实值，直接登记更诚实。名字用 limits 里的 key，UI 才能解释。
 */
function registerTruncation(ctx: ReadContext, key: 'maxFileBytes' | 'maxBlocks'): void {
  const g = ctx.guard;
  if (g.truncated.includes(key)) return;
  g.truncated.push(key);
  g.warnings.push(`${key} 达到上限 ${String(g.limits[key]).toLocaleString('en-US')}，后续内容已忽略`);
}

/** 取字节视图，必要时按 maxFileBytes 截断。返回是否发生截断。 */
function byteView(ctx: ReadContext, bytes: Uint8Array, b: DocBuilder): { view: Uint8Array; cut: boolean } {
  const budget = ctx.limits.maxFileBytes;
  if (bytes.length <= budget) return { view: bytes, cut: false };
  b.warn(`文件 ${bytes.length} 字节超过 maxFileBytes=${budget} 字节，已截断`);
  registerTruncation(ctx, 'maxFileBytes');
  return { view: bytes.subarray(0, budget), cut: true };
}

/** txt / log：一行一个段落，保留空行。 */
export async function readPlainText(ctx: ReadContext, format: FormatId): Promise<LiteDocument> {
  const b = new DocBuilder(ctx);
  const { view } = byteView(ctx, await ctx.bytes(), b);
  const encoding = detectEncoding(view);
  if (encoding === 'gb18030') b.warn('未检出 BOM 且 UTF-8 解码出现大量替换字符，已按 gb18030（GBK 超集）解码');
  else if (encoding !== 'utf-8') b.warn(`按 ${encoding} 解码`);

  const lines = linesFromBytes(view, encoding);
  let line: string | undefined;
  let count = 0;
  let pushed = 0;
  while ((line = lines.next()) !== undefined) {
    count++;
    if (!b.push({ kind: 'para', runs: [{ text: line }] })) break;
    pushed++;
    if ((count & 0x3fff) === 0 && ctx.signal?.aborted) {
      b.warn('读取被取消，仅返回已解析部分');
      break;
    }
  }
  if (count > 0 && pushed < count) registerTruncation(ctx, 'maxBlocks');
  // 空文件也要有合法块数组：渲染层不必对 blocks === [] 做特判
  if (b.blocks.length === 0) b.push({ kind: 'para', runs: [{ text: '' }] });
  ctx.onProgress?.({ phase: 'text', done: count });
  return b.finish(format, 'text', {
    meta: { paragraphCount: b.blocks.length, charCount: undefined },
  });
}

/** Markdown 读取器主体。 */
export async function readMarkdown(ctx: ReadContext): Promise<LiteDocument> {
  const b = new DocBuilder(ctx);
  const { view } = byteView(ctx, await ctx.bytes(), b);
  const encoding = detectEncoding(view);
  if (encoding === 'gb18030') b.warn('未检出 BOM 且 UTF-8 解码出现大量替换字符，已按 gb18030 解码');
  const text = makeDecoder(encoding).decode(view);

  const t0 = now();
  const parsed = parseMarkdown(text, { maxBlocks: ctx.limits.maxBlocks });
  const parseMs = now() - t0;
  for (const w of parsed.warnings) b.warn(w);
  if (parsed.truncated) registerTruncation(ctx, 'maxBlocks');
  for (const block of parsed.blocks) {
    if (!b.push(block)) break;
  }
  if (b.blocks.length === 0) b.push({ kind: 'para', runs: [{ text: '' }] });
  const outline = parsed.outline.map((o) => toOutlineItem(o));
  const doc = b.finish('md', 'text', {
    outline,
    meta: { title: parsed.outline[0]?.text ?? firstText(parsed.blocks), paragraphCount: b.blocks.length },
  });
  doc.stats.phases = { mdParse: parseMs };
  return doc;
}

function toOutlineItem(o: MdOutlineItem) {
  return { level: o.level, text: o.text, target: { kind: 'block' as const, index: o.blockIndex } };
}

/** 供其他读取器复用：把一段文本按行压成块（HTML 的 <pre>、JSON 的降级路径）。 */
export function pushLines(b: DocBuilder, lines: readonly string[], style?: ParaStyle, runStyle?: Run): boolean {
  for (const t of lines) {
    const run: Run = runStyle ? { ...runStyle, text: t } : { text: t };
    const block: Block = style ? { kind: 'para', runs: [run], style } : { kind: 'para', runs: [run] };
    if (!b.push(block)) return false;
  }
  return true;
}
