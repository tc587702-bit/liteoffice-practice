/**
 * JSON 读取器。
 *
 * 目标不只是「把 JSON 显示出来」，而是让它**可导航**：
 *   1. 格式化缩进后作为等宽文本呈现（JSON.stringify(v, null, 2)）
 *   2. 顶层键（对象）或下标（数组）进大纲，侧边栏点一下就能跳到对应块
 *
 * 大纲与块的对应关系是精确的：顶层键在图里恰好对应「外层容器内的第一层」，
 * 逐行扫描缩进深度即可定位，不需要二次搜索文本。
 *
 * 降级：JSON 解析失败（注释、尾逗号、被截断的日志）不抛错，转为纯文本并记
 * warning —— 用户至少还能读到原始内容。
 */
import type { Block, LiteDocument, OutlineItem, Run } from '../../core/src/model.ts';
import type { ReadContext } from '../../core/src/registry.ts';
import { DocBuilder } from './builder.ts';
import { detectEncoding, makeDecoder } from './decode.ts';
import { splitLines } from './mdparse.ts';

/** 每个块容纳的最大行数：避免 10 万行 JSON 产生 10 万个小块对象 */
const LINES_PER_BLOCK = 400;
/** 顶层键进大纲的数量上限（再多没人看，且会拖慢侧边栏渲染） */
const MAX_OUTLINE_KEYS = 200;

export async function readJson(ctx: ReadContext): Promise<LiteDocument> {
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
  if (encoding === 'gb18030') b.warn('已按 gb18030 解码（非 UTF-8 内容）');
  const text = makeDecoder(encoding).decode(view);

  let parsed: unknown;
  let ok = true;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (err) {
    ok = false;
    b.warn(`JSON 解析失败，已降级为纯文本呈现：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!ok) {
    pushLinesAsBlocks(b, splitLines(text), ctx.limits.maxBlocks);
    return b.finish('json', 'text', {
      meta: { title: ctx.name, description: 'JSON 解析失败，按纯文本呈现' },
    });
  }

  const formatted = JSON.stringify(parsed, null, 2) ?? '';
  const lines = splitLines(formatted);
  const blockOfLine = pushLinesAsBlocks(b, lines, ctx.limits.maxBlocks);
  const outline = outlineFromJson(parsed, lines, blockOfLine, b);
  return b.finish('json', 'text', {
    outline,
    meta: { title: ctx.name, description: 'JSON（已格式化）' },
  });
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 把行压成等宽块，返回「行号 -> 块索引」的映射（未呈现的行保持 undefined）。
 *
 * 分块策略：累计 LINES_PER_BLOCK 行开一个新块。既保证「某行属于哪个块」可查，
 * 又不会让块对象数与行数同阶。行内用 breakBefore 表达换行而不是拼 '\n'：
 * 渲染器可以自行决定换行策略，也不会和段落分隔混淆。
 */
function pushLinesAsBlocks(b: DocBuilder, lines: string[], maxBlocks: number): (number | undefined)[] {
  const blockOfLine: (number | undefined)[] = new Array(lines.length);
  let i = 0;
  while (i < lines.length) {
    if (b.blocks.length >= maxBlocks) {
      b.warn(`块数达到 maxBlocks=${maxBlocks.toLocaleString('en-US')}，后续文本未呈现`);
      if (!b.ctx.guard.truncated.includes('maxBlocks')) {
        b.ctx.guard.truncated.push('maxBlocks');
        b.ctx.guard.warnings.push(`maxBlocks 达到上限 ${maxBlocks.toLocaleString('en-US')}，后续内容已忽略`);
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

/** 数一行里字符串外的 `{`/`[` 与 `}`/`]`，返回该行结束后的嵌套深度变化。 */
function depthDelta(line: string): number {
  let d = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') d++;
    else if (c === '}' || c === ']') d--;
  }
  return d;
}

/**
 * 从格式化后的行里提取顶层键作大纲。
 *
 * 判据：位于「最外层容器内部的第 1 层」，即该行处理前的深度为 1，
 * 且形如 `"key": ...` 或 `"key": {`。这条判据对对象与数组都成立
 * （数组的元素行不带 `"key":`，因此不会误入大纲）。
 *
 * 为什么不递归遍历对象：那只能拿到键名，拿不到「它在文档里的哪一行」，
 * 而大纲必须能跳转。缩进扫描天然给出位置。
 */
function outlineFromJson(
  value: unknown,
  lines: string[],
  blockOfLine: (number | undefined)[],
  b: DocBuilder,
): OutlineItem[] {
  if (value === null || typeof value !== 'object') return [];
  const items: OutlineItem[] = [];
  let depth = 0;
  let totalTop = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const atTop = depth === 1;
    if (atTop) {
      const m = /^\s{2}"((?:[^"\\]|\\.)*)"\s*:/.exec(line);
      if (m) {
        totalTop++;
        if (items.length < MAX_OUTLINE_KEYS) {
          let key = m[1];
          try {
            // 键里可能有 \" 之类的转义：用 JSON.parse 还原才是真键名
            key = JSON.parse(`"${m[1]}"`) as string;
          } catch {
            /* 转义不合法时就用原样，不影响可读性 */
          }
          const blockIndex = blockOfLine[ln];
          items.push({
            level: 1,
            text: key,
            ...(blockIndex === undefined ? {} : { target: { kind: 'block' as const, index: blockIndex } }),
          });
        }
      }
    }
    depth += depthDelta(line);
  }
  if (totalTop > MAX_OUTLINE_KEYS) {
    b.warn(`顶层键共 ${totalTop} 个，大纲只保留前 ${MAX_OUTLINE_KEYS} 个`);
  }
  return items;
}
