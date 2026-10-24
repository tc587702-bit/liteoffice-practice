/**
 * DocBuilder —— 文本家族读取器共用的「块装配 + 限额记账」层。
 *
 * 为什么单独抽出来：
 *   9 种格式的读取器都要做同样三件事——压块、按 limits.maxBlocks 截断、如实统计。
 *   如果每个读取器各写一遍，最容易出的错是**忘记 probe**：于是畸形文件能让
 *   段落数组无限增长，直到 OOM。把这件事收到一处，漏掉是不可能的。
 */
import type { Block, LiteDocument, OutlineItem, ParaStyle, Run } from '../../core/src/model.ts';
import { createDocument } from '../../core/src/model.ts';
import type { ReadContext } from '../../core/src/registry.ts';
import { estimateBytes, now } from '../../core/src/memory.ts';
import { formatSpec } from '../../core/src/formats.ts';

/** 一次读取的收尾参数 */
export interface DocFinish {
  meta?: LiteDocument['meta'];
  outline?: OutlineItem[];
  text?: string;
  warnings?: string[];
}

export class DocBuilder {
  readonly ctx: ReadContext;
  readonly blocks: Block[] = [];
  readonly outline: OutlineItem[] = [];
  readonly warnings: string[] = [];
  cellCount = 0;
  imageCount = 0;
  imageBytes = 0;
  /** 页数/表数等额外统计，finish 时并进 meta */
  started = now();

  constructor(ctx: ReadContext, initialWarnings?: readonly string[]) {
    this.ctx = ctx;
    if (initialWarnings) for (const w of initialWarnings) this.warn(w);
  }

  /** 记录一条降级说明。上限 200 条，与 LimitGuard 保持一致。 */
  warn(message: string): void {
    if (this.warnings.length < 200) this.warnings.push(message);
  }

  /** 已经因为块数上限停止接收内容 */
  get full(): boolean {
    return this.ctx.guard.truncated.includes('maxBlocks');
  }

  /**
   * 压入一个块。返回 false 表示已达块数上限、该块被丢弃。
   * 调用方拿到 false 后应当停止解析（继续解析只是白烧 CPU）。
   */
  push(block: Block): boolean {
    if (!this.ctx.guard.probe('maxBlocks', 1)) return false;
    this.blocks.push(block);
    return true;
  }

  /** 登记若干单元格，超限返回 false。 */
  addCells(n: number): boolean {
    if (n <= 0) return true;
    if (!this.ctx.guard.probe('maxCells', n)) return false;
    this.cellCount += n;
    return true;
  }

  addImage(bytes: number): void {
    this.imageCount++;
    this.imageBytes += bytes;
  }

  /** 组装最终文档。modelBytes 用 estimateBytes 如实估算。 */
  finish(format: LiteDocument['format'], kind: LiteDocument['kind'], finish: DocFinish = {}): LiteDocument {
    const stats = this.ctx.guard.snapshot();
    const outline = finish.outline ?? this.outline;
    const warnings = [...new Set([...this.warnings, ...stats.warnings])];
    const doc = createDocument({
      kind,
      format,
      formatLabel: formatSpec(format).label,
      name: this.ctx.name,
      meta: finish.meta ?? {},
      outline,
      blocks: this.blocks,
      text: finish.text,
      stats: {
        parseMs: now() - this.started,
        modelBytes: 0,
        sourceBytes: this.ctx.size,
        blockCount: this.blocks.length,
        cellCount: this.cellCount,
        imageCount: this.imageCount,
        imageBytes: this.imageBytes,
        warnings,
        truncated: stats.truncated,
      },
    });
    doc.stats.modelBytes = estimateBytes({ blocks: doc.blocks, outline: doc.outline, meta: doc.meta, text: doc.text });
    return doc;
  }
}

/** 生成一个段落块。 */
export function para(runs: Run[], style?: ParaStyle): Block {
  return style ? { kind: 'para', runs, style } : { kind: 'para', runs };
}

/** 单个纯文本 run 的段落。 */
export function textPara(text: string, style?: ParaStyle): Block {
  return para([{ text }], style);
}

/** 全空段落（Markdown 的空行、CSV 的空行都要保留）。 */
export function emptyPara(style?: ParaStyle): Block {
  return para([{ text: '' }], style);
}

/** 从块序列里取第一段非空文本，用于 meta.title 之类的兜底。 */
export function firstText(blocks: readonly Block[]): string | undefined {
  for (const b of blocks) {
    if (b.kind !== 'para') continue;
    const t = b.runs.map((r) => r.text).join('').trim();
    if (t) return t.length > 200 ? t.slice(0, 200) : t;
  }
  return undefined;
}
