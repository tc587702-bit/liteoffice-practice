/**
 * CSV / TSV 读取器。
 *
 * 三个必须做对的地方（也是现实中 CSV 打开器最常翻车的点）：
 *
 * 1. **RFC4180 引号转义**
 *    `""` 是字段内的一个字面引号；引号内可以包含分隔符与换行。
 *    引号内的换行意味着「一条记录跨多行」——按行 split 再按逗号切的做法
 *    会把这类文件切得面目全非。这里用字符级状态机，不做行分割。
 *
 * 2. **分隔符自动探测**
 *    判据是「列数稳定性」：分别按 , \t ; | 解析前若干条记录，选列数最稳定
 *    （众数占比最高）的那个；平局时按 , > \t > ; > | 优先，并且当文件扩展名
 *    是 .tsv 时给予制表符额外权重。单列文件无法判定，直接返回默认分隔符。
 *
 * 3. **不许擅自认表头**
 *    真实世界的 CSV 里第一行是数据的情况极多，认错表头会直接毁掉数据。
 *    只有「首行所有非空单元格都不像数字、且至少有一个非空单元格」时才认表头，
 *    并在 warnings 里说明理由。
 *
 * 内存策略：逐块（64 KiB）读字节、逐字符扫，任一时刻只持有一块原文与已解析的
 * 记录；解析出的记录直接落进 MaterializedGrid。受 maxCells 约束，因此
 * 峰值内存与「模型大小」同阶，而不是与文件大小同阶。
 * 超过 maxCells 就停止并记 truncated —— 绝不静默丢内容。
 */
import type { Cell, CellRow, CellType, LiteDocument, Sheet } from '../../core/src/model.ts';
import type { ReadContext } from '../../core/src/registry.ts';
import { MaterializedGrid } from '../../core/src/grid.ts';
import { DocBuilder } from './builder.ts';
import { detectEncoding, makeDecoder } from './decode.ts';

export const DELIMITERS = [',', '\t', ';', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

const CHUNK = 65536;

/** 字符级记录读取器：屏蔽「字节流」与「字符串」两种输入的差异。 */
interface CharReader {
  next(): string | undefined;
}

function charReaderFromBytes(bytes: Uint8Array, encoding: ReturnType<typeof detectEncoding>): CharReader {
  const decoder = makeDecoder(encoding);
  let pos = 0;
  let buf = '';
  let bufPos = 0;
  return {
    next(): string | undefined {
      for (;;) {
        if (bufPos < buf.length) return buf[bufPos++];
        if (pos >= bytes.length) return undefined;
        const end = Math.min(pos + CHUNK, bytes.length);
        buf = decoder.decode(bytes.subarray(pos, end), { stream: end < bytes.length });
        bufPos = 0;
        pos = end;
      }
    },
  };
}

function charReaderFromString(text: string): CharReader {
  let i = 0;
  return { next: () => (i < text.length ? text[i++] : undefined) };
}

/**
 * 读一条记录。返回 undefined 表示已到输入末尾。
 *
 * 状态机（start / inQuotes / afterQuote）是必须的：
 * 只在「字段开头」出现的引号才是转义引号，字段中间出现的引号是普通字符
 * —— 这条规则被大量实现忽略，于是 `a"b,c` 这类数据会被解析错。
 */
function readRecord(r: CharReader, delim: string): string[] | undefined {
  const fields: string[] = [];
  let field = '';
  let state: 'start' | 'inQuotes' | 'afterQuote' | 'plain' = 'start';
  let sawAny = false;

  for (;;) {
    const ch = r.next();
    if (ch === undefined) {
      if (!sawAny) return undefined;
      if (state === 'inQuotes') {
        // 引号未闭合：不抛错，把已读到的内容当作完整字段返回（降级但要能打开）。
        // 末尾那个换行是文件的最后一行结束符，不属于字段内容（用户没写引号闭合，
        // 我们也不该把「文件尾」当成字段的一部分）。
        fields.push(field.replace(/\r?\n$/, ''));
        return fields;
      }
      fields.push(field);
      return fields;
    }
    sawAny = true;

    if (state === 'inQuotes') {
      if (ch === '"') {
        state = 'afterQuote';
        continue;
      }
      field += ch;
      continue;
    }

    if (state === 'afterQuote') {
      if (ch === '"') {
        // "" -> 一个字面引号
        field += '"';
        state = 'inQuotes';
        continue;
      }
      if (ch === delim) {
        fields.push(field);
        field = '';
        state = 'start';
        continue;
      }
      if (ch === '\r') continue; // \r\n 的 \r
      if (ch === '\n') {
        fields.push(field);
        return fields;
      }
      // 引号后出现其他字符（非法 CSV）：按普通字符继续，不抛错
      field += ch;
      state = 'plain';
      continue;
    }

    // start / plain
    if (ch === '"' && (state === 'start' || field === '')) {
      state = 'inQuotes';
      continue;
    }
    if (ch === delim) {
      fields.push(field);
      field = '';
      state = 'start';
      continue;
    }
    if (ch === '\n') {
      fields.push(field);
      return fields;
    }
    if (ch === '\r') continue;
    field += ch;
    state = 'plain';
  }
}

/** 去掉行尾的空字段（RFC4180 不区分 `a,b,` 与 `a,b`，去掉以免列数虚高）。 */
function trimTrailingEmpties(fields: string[]): string[] {
  let end = fields.length;
  while (end > 1 && fields[end - 1] === '') end--;
  return fields.slice(0, end);
}

export interface DelimiterChoice {
  delimiter: Delimiter;
  /** 众数列数的占比，1 表示完全稳定 */
  stability: number;
  samples: number;
}

/**
 * 分隔符探测。返回列数最稳定的候选。
 * 只有在至少能取到 2 条记录时才可能选出非默认值（列数稳定性无从谈起）。
 */
export function probeDelimiter(sampleText: string, preferred?: Delimiter): DelimiterChoice {
  const candidates: Delimiter[] = preferred && preferred !== ',' ? [preferred, ...DELIMITERS.filter((d) => d !== preferred)] : [...DELIMITERS];
  let best: DelimiterChoice = { delimiter: preferred ?? ',', stability: 0, samples: 0 };

  for (const d of candidates) {
    const r = charReaderFromString(sampleText);
    const counts: number[] = [];
    for (let k = 0; k < 64; k++) {
      const rec = readRecord(r, d);
      if (rec === undefined) break;
      // 纯空行通常是文件末尾的换行，不能当样本
      if (rec.length === 1 && rec[0].trim() === '') continue;
      counts.push(trimTrailingEmpties(rec).length);
    }
    if (counts.length < 2) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modeCols = 0;
    let modeCount = 0;
    for (const [cols, n] of freq) {
      // 只有「>1 列」的众数才算有意义：全行都是一列的候选说明分隔符根本没出现
      if (n > modeCount || (n === modeCount && cols > modeCols)) {
        modeCount = n;
        modeCols = cols;
      }
    }
    if (modeCols < 2) continue; // 该分隔符切不出多列
    const stability = modeCount / counts.length;
    const bonus = preferred === d ? 2e-9 : 0; // 平局时给扩展名提示的分隔符极小加权
    if (stability + bonus > best.stability) best = { delimiter: d, stability, samples: counts.length };
  }
  if (best.stability === 0) return { delimiter: preferred ?? ',', stability: 0, samples: 0 };
  return best;
}

const NUMERIC_RE = /^[+-]?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?([eE][+-]?\d+)?%?$/;
/** 常见日期/时间开头也视作「像数据」，避免把日期表头认成标题 */
const DATE_LIKE_RE = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?/;

/** 判断首行是否像表头：所有非空单元格都不是数字/日期，且至少有一个非空单元格。 */
export function looksLikeHeader(cells: readonly string[]): boolean {
  let nonEmpty = 0;
  let allText = true;
  for (const c of cells) {
    const t = c.trim();
    if (t === '') continue;
    nonEmpty++;
    if (NUMERIC_RE.test(t) || DATE_LIKE_RE.test(t)) allText = false;
  }
  return nonEmpty > 0 && allText;
}

function guessType(v: string): CellType | undefined {
  const t = v.trim();
  if (t === '') return undefined;
  if (NUMERIC_RE.test(t) && !t.endsWith('%')) return 'n';
  if (/^(true|false)$/i.test(t)) return 'b';
  return 's';
}

export async function readDelimited(ctx: ReadContext, format: 'csv' | 'tsv'): Promise<LiteDocument> {
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

  // 探测分隔符：只解码文件头一小段，避免为了探测而整份解码
  const sampleText = makeDecoder(encoding).decode(view.subarray(0, Math.min(view.length, CHUNK)));
  const preferred: Delimiter | undefined = format === 'tsv' ? '\t' : extensionDelimiter(ctx.name);
  const choice = probeDelimiter(sampleText, preferred);
  if (choice.samples === 0) b.warn('无法从内容判定分隔符（记录太少），已按扩展名/默认分隔符解析');
  else if (choice.stability < 1) b.warn(`分隔符探测：以「${describe(choice.delimiter)}」为准，列数稳定性 ${(choice.stability * 100).toFixed(0)}%`);

  const rows = await parseGrid(ctx, b, view, encoding, choice.delimiter);
  return buildSheetDoc(ctx, b, format, rows.rows, choice.delimiter, rows.truncated);
}

function describe(d: Delimiter): string {
  if (d === '\t') return '制表符';
  if (d === ',') return '逗号';
  if (d === ';') return '分号';
  return '竖线';
}

function extensionDelimiter(name: string): Delimiter | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return '\t';
  if (lower.endsWith('.csv')) return ',';
  return undefined;
}

interface ParseOutcome {
  rows: CellRow[];
  truncated: boolean;
}

/**
 * 主解析循环：字符级状态机 -> 稀疏 CellRow[]。
 *
 * 受 maxCells / maxCols / maxRows 三重约束。到达任一上限即停止并记 truncated
 * （具体是哪一项由 guard 记录，这里只负责停）。
 */
async function parseGrid(
  ctx: ReadContext,
  b: DocBuilder,
  bytes: Uint8Array,
  encoding: ReturnType<typeof detectEncoding>,
  delim: Delimiter,
): Promise<ParseOutcome> {
  const reader = charReaderFromBytes(bytes, encoding);
  const rows: CellRow[] = [];
  let colCount = 0;
  let truncated = false;
  let n = 0;

  for (;;) {
    if (n % 64 === 0 && ctx.signal?.aborted) {
      b.warn('读取被取消，仅返回已解析部分');
      truncated = true;
      break;
    }
    const fields = readRecord(reader, delim);
    if (fields === undefined) break;
    n++;
    // 空行：`a,b\n\nc,d` 里的空行不是三条记录中的一条，跳过以免行号整体错位
    if (fields.length === 1 && fields[0] === '') continue;
    if (!ctx.guard.probe('maxRows', 1)) {
      truncated = true;
      break;
    }
    if (fields.length > colCount) {
      if (!ctx.guard.probe('maxCols', fields.length - colCount)) {
        truncated = true;
        break;
      }
      colCount = fields.length;
    }

    const cells: Cell[] = [];
    let stop = false;
    for (let c = 0; c < fields.length; c++) {
      const v = fields[c];
      if (v === '') continue;
      // 空格不产出 Cell：稀疏存储是低内存浏览大表的前提
      if (!ctx.guard.probe('maxCells', 1)) {
        stop = true;
        truncated = true;
        break;
      }
      b.cellCount++;
      const cell: Cell = { r: rows.length, c, v };
      const t = guessType(v);
      if (t) cell.t = t;
      cells.push(cell);
    }
    if (cells.length > 0) rows.push({ r: rows.length, cells });
    if (stop) break;
  }

  return { rows, truncated };
}

function buildSheetDoc(
  ctx: ReadContext,
  b: DocBuilder,
  format: 'csv' | 'tsv',
  rows: CellRow[],
  delim: Delimiter,
  truncated: boolean,
): LiteDocument {
  let colCount = 0;
  for (const r of rows) for (const c of r.cells) if (c.c + 1 > colCount) colCount = c.c + 1;

  const headerRow = rows.length > 0 && looksLikeHeader(rows[0].cells.map((c) => c.v));
  if (headerRow) {
    b.warn('首行所有非空单元格都不是数字/日期，已按表头处理（渲染时冻结加粗）；如判断有误可在视图中关闭');
  } else if (rows.length > 0) {
    b.warn('首行含数字/日期，未按表头处理（CSV 没有表头语法，认错会损坏数据）');
  }

  const grid = new MaterializedGrid(rows, rows.length, colCount);
  // 显式转发 readRows，而不是 {...grid}：展开会带上 rowAt/toSparse，
  // 让 Sheet 的接口面变得不可预测（也会让 estimateBytes 多算）。
  const sheet: Sheet = {
    name: ctx.name.replace(/\.[^.]+$/, '') || 'Sheet1',
    rowCount: grid.rowCount,
    colCount: grid.colCount,
    readRows: (start, end) => grid.readRows(start, end),
    styles: headerRow ? [{ bold: true, bg: '#f3f3f3' }] : [],
    defaultColWidth: 64,
    defaultRowHeight: 15,
    truncated,
  };
  if (headerRow) {
    for (const c of rows[0].cells) c.s = 0;
  }

  const doc = b.finish(format, 'sheet', {
    meta: { sheetCount: 1 },
  });
  return withSheet(doc, sheet);
}

/**
 * LiteDocument.sheets 在 createDocument 里是只读字段（readonly 是类型层面的约束），
 * 但读取器必须能给出 sheets。用 Object.assign 就地补上，避免重建整个文档对象
 * —— 重建会丢掉 dispose() 与 truncated getter（engine/open.ts 里同样的坑）。
 */
function withSheet(doc: LiteDocument, sheet: Sheet): LiteDocument {
  const target = doc as unknown as { sheets?: Sheet[] };
  target.sheets = [sheet];
  return doc as LiteDocument;
}
