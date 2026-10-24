/**
 * worksheet 解析：**这是本包低内存主张的落点**。
 *
 * 两条路径，按 `<dimension>` 给出的单元格数自动选择：
 *
 *  1) 小表（≤ SMALL_TABLE_CELLS，默认 20 万格）：一次流式扫描直接物化成
 *     `MaterializedGrid`。快，且体积可控。
 *  2) 大表：只扫描**元数据**（dimension / cols / pane / mergeCells / autoFilter，
 *     `<sheetData>` 里的行只读 `r`/`ht` 属性然后整行跳过，不建任何单元格对象），
 *     然后把「怎么再读一次」的回调交给 `LazyGrid`。`fetch(start,end)` 每次重新
 *     流式扫描该 sheet，**只解析落在窗口内的行**：
 *
 *        峰值内存与窗口大小同阶，与全表行数无关。
 *
 *     代价是 CPU，且这条性质必须说清楚（否则会以为是漏了优化）：
 *       - **单独一次 fetch 的代价 ∝ 窗口距表头的距离**，而不是 ∝ 窗口大小。
 *         deflate 流不可随机访问，跳到第 5 万行就必须先扫过前面 5 万行
 *         （只做字符级跳过、不建对象，但仍然要解压+扫描）。
 *       - 缓解手段是**扫描游标**（见 makeCursorFetcher）：把「已扫到第几行」记住并
 *         让上游流保持打开，于是**顺序向下滚动**（最常见的交互）每次只付 O(窗口)，
 *         往回滚才需要重开流从表头再扫。
 *       - 代价随距离线性增长这一点在测试里有断言（表头窗口 ≪ 首次远跳），
 *         将来谁破坏了这条性质会立刻失败。
 *       - 另一种可选缓解是预取/加大 LRU（默认 600 行），方向一致：用一点内存换扫描。
 *
 * 跨块边界的坑（本文件 + xmlStream.ts 的重点）：
 *   每行的 XML 是被分块喂进来的，`<row` 可能被切在中间、属性可能被切开、
 *   `<c>` 可能只到了一半。因此**绝不能**对每个 chunk 做 `indexOf('<row')`。
 *   StreamXmlScanner 维护跨块的字符窗口，只在标签边界处切分，于是每一行
 *   总是完整可见的。测试里用 chunkSize=1/2/3/7… 强制切在最坏位置来锁死这一点。
 */
import { LazyGrid, MaterializedGrid } from '../../core/src/grid.ts';
import type { Cell, CellRow, Grid, MergeRange, Run, Sheet } from '../../core/src/model.ts';
import type { LimitGuard, Limits } from '../../core/src/limits.ts';
import { excelColWidthToPt } from '../../core/src/units.ts';
import { estimateBytes } from '../../core/src/memory.ts';
import { attr, attrBool, attrInt } from '../../ooxml/src/xmlUtil.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { StreamXmlScanner } from './xmlStream.ts';
import { readRichText, readTextNode } from './richtext.ts';
import { colOfRef, parseRangeRef } from './refs.ts';
import { formatExcelSerial, normalizeIsoDate } from './numFmt.ts';
import type { SharedStrings } from './sharedStrings.ts';
import type { StyleTable } from './styles.ts';

/** 小表阈值：低于它就物化（20 万格 ≈ 一个 2000×100 的表，内存可控）。 */
export const SMALL_TABLE_CELLS = 200_000;

export interface WorksheetMeta {
  rowCount: number;
  colCount: number;
  colWidths?: number[];
  rowHeights?: Map<number, number>;
  defaultColWidth: number;
  defaultRowHeight: number;
  merges?: MergeRange[];
  freeze?: { rows: number; cols: number };
  autoFilter?: MergeRange;
  truncated: boolean;
  /** 是否解析到 `<dimension>` */
  hasDimension: boolean;
  /** 扫描中实际见到的最大行数（1 起）与最大列数（+1，即列数的计数） */
  maxRowSeen: number;
  maxColSeen: number;
}

export interface SheetCounters {
  cells: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
  /** 达到 limits.maxCells：停止继续物化 */
  exhausted: boolean;
}

export interface CellReadContext {
  limits: Limits;
  sst?: SharedStrings;
  styles?: StyleTable;
  date1904: boolean;
  counters: SheetCounters;
  onCell: () => boolean;
  warn: (msg: string) => void;
}

function newCounters(): SheetCounters {
  return { cells: 0, truncatedRows: false, truncatedCols: false, exhausted: false };
}

function rowIndexOf(e: XmlEvent, prev: number): number {
  const r = attrInt(e, 'r', 0);
  return r > 0 ? r : prev + 1;
}

/* ==================================================================== */
/* 单元格与行                                                            */
/* ==================================================================== */

/** 读取一个 `<c>`（start 事件已被消费）。返回 null 表示这一格在模型里是空的。 */
async function readCell(scanner: StreamXmlScanner, e: XmlEvent, row: number, col: number, rowStyle: number, ctx: CellReadContext): Promise<Cell | null> {
  const tRaw = (attr(e, 't') ?? 'n').trim();

  let styleIdx = attrInt(e, 's', -1);
  // 行级样式：<row s="1" customFormat="1"> 会给该行所有未显式指定样式的单元格打底。
  // 真实文件里很常见（整行加粗/加底纹），不处理会「一行里只有部分格子有格式」。
  if (styleIdx < 0) styleIdx = rowStyle;
  const table = ctx.styles;
  if (styleIdx >= 0 && (!table || styleIdx >= table.styles.length)) {
    ctx.warn(`单元格样式索引 ${styleIdx} 越界，已按默认样式显示`);
    styleIdx = -1;
  }

  let raw = '';
  let formula: string | undefined;
  let inlineText: string | undefined;
  let inlineRich: Run[] | undefined;

  if (!e.selfClosing) {
    for (;;) {
      const ev = await scanner.next();
      if (ev === null) break;
      if (ev.type === 'end') {
        if (ev.local === 'c') break;
        continue;
      }
      if (ev.type === 'text') continue;
      switch (ev.local) {
        case 'v':
          raw = await readTextNode(scanner, ev);
          break;
        case 'f': {
          const t = await readTextNode(scanner, ev);
          const clean = t.trim().replace(/^=/, '');
          if (clean) formula = clean;
          break;
        }
        case 'is': {
          const rt = await readRichText(scanner, ev);
          inlineText = rt.text;
          inlineRich = rt.runs ?? undefined;
          break;
        }
        default:
          if (!ev.selfClosing) await scanner.skipElement();
      }
    }
  }

  let value = raw;
  let type: Cell['t'] = 'n';
  let rich: Run[] | undefined;
  /** 引用了取不到的共享字符串（部件缺失 / 越界 / 被上限截断） */
  let missingText = false;

  switch (tRaw) {
    case 's': {
      type = 's';
      if (raw === '') {
        value = '';
        break;
      }
      const idx = Number.parseInt(raw, 10);
      const s = Number.isFinite(idx) ? ctx.sst?.get(idx) : undefined;
      if (s === undefined) {
        // 共享字符串表缺失/被上限截断/索引越界：**置空并记警告**，
        // 绝不把索引数字（或半截字符串）当文本显示出去 ——
        // 「静默给出错误文本」比「显示为空」严重得多。
        // 单元格本身仍然保留：位置和样式还在，只是文本不可得。
        value = '';
        missingText = true;
        ctx.warn('共享字符串缺失或超出上限，相关单元格文本置空');
      } else {
        value = s;
        const r = Number.isFinite(idx) ? ctx.sst?.rich(idx) : undefined;
        if (r) rich = r;
      }
      break;
    }
    case 'inlineStr': {
      type = 's';
      value = inlineText ?? '';
      rich = inlineRich;
      break;
    }
    case 'str':
      type = 'str';
      value = raw;
      break;
    case 'b':
      type = 'b';
      value = raw.trim() === '1' ? 'TRUE' : 'FALSE';
      break;
    case 'e':
      type = 'e';
      value = raw.trim();
      break;
    case 'd':
      type = 'd';
      value = normalizeIsoDate(raw);
      break;
    case 'n':
    case '':
    default: {
      type = 'n';
      value = raw;
      if (styleIdx >= 0 && table?.isDate[styleIdx] && raw !== '') {
        const n = Number.parseFloat(raw);
        if (Number.isFinite(n)) {
          const text = formatExcelSerial(n, table.numFmtCodes[styleIdx], ctx.date1904);
          if (text !== null) value = text;
        }
      }
      break;
    }
  }

  const hasContent = value !== '' || formula !== undefined || rich !== undefined;
  // 纯格式格（`<c r="A1" s="3"/>`）在真实文件里大量存在，代表底纹/边框，
  // 丢掉会让「整片表格的框线消失」。所以带样式就保留（v 为空串）。
  // missingText 同理：文本取不到但格子确实存在，保留它比凭空删掉更诚实。
  const keep = hasContent || styleIdx > 0 || missingText;
  if (!keep) return null;
  if (!ctx.onCell()) return null;

  const cell: Cell = { r: row, c: col, v: value };
  if (type !== 'n') cell.t = type;
  if (formula !== undefined) cell.f = formula;
  if (rich !== undefined) cell.rich = rich;
  // s=0 是默认样式，不写字段：一百万格省下的属性槽是可观的
  if (styleIdx > 0) cell.s = styleIdx;
  return cell;
}

/** 读取一个 `<row>`（start 事件已被消费），返回稀疏的 CellRow。 */
export async function readRow(scanner: StreamXmlScanner, start: XmlEvent, rowIndex: number, ctx: CellReadContext): Promise<CellRow> {
  const cells: Cell[] = [];
  const rowStyle = attrInt(start, 's', -1);
  let col = -1;

  if (!start.selfClosing) {
    for (;;) {
      const e = await scanner.next();
      if (e === null) break;
      if (e.type === 'end') {
        if (e.local === 'row') break;
        continue;
      }
      if (e.type === 'text') continue;
      if (e.local !== 'c') {
        if (!e.selfClosing) await scanner.skipElement();
        continue;
      }

      const ref = attr(e, 'r');
      if (ref !== undefined) {
        const c = colOfRef(ref);
        col = c >= 0 ? c : col + 1; // 引用坏掉时退化成「上一列 +1」，不丢格
      } else {
        col++;
      }

      if (col >= ctx.limits.maxCols) {
        ctx.counters.truncatedCols = true;
        if (!e.selfClosing) await scanner.skipElement();
        continue;
      }

      const cell = await readCell(scanner, e, rowIndex, col, rowStyle, ctx);
      if (cell) cells.push(cell);
      // 达到 maxCells：立即收手（调用方会中止整次扫描并取消流）
      if (ctx.counters.exhausted) break;
    }
  }
  return { r: rowIndex, cells };
}

/** 只统计一行的最大列号（无 dimension 时用来推断 colCount）——不建任何 Cell 对象。 */
async function scanRowMaxCol(scanner: StreamXmlScanner, start: XmlEvent): Promise<number> {
  if (start.selfClosing) return 0;
  let col = -1;
  for (;;) {
    const e = await scanner.next();
    if (e === null) break;
    if (e.type === 'end') {
      if (e.local === 'row') break;
      continue;
    }
    if (e.type !== 'start') continue;
    if (e.local === 'c') {
      const ref = attr(e, 'r');
      if (ref !== undefined) {
        const c = colOfRef(ref);
        col = c >= 0 ? c : col + 1;
      } else {
        col++;
      }
      if (!e.selfClosing) await scanner.skipElement();
      continue;
    }
    if (!e.selfClosing) await scanner.skipElement();
  }
  return col + 1;
}

/* ==================================================================== */
/* sheetData                                                            */
/* ==================================================================== */

interface SheetDataResult {
  rows: (CellRow | null)[] | null;
  nonEmpty: number;
}

async function parseSheetData(
  scanner: StreamXmlScanner,
  meta: WorksheetMeta,
  rowHeights: Map<number, number>,
  ctx: CellReadContext,
  collect: boolean,
): Promise<SheetDataResult> {
  const rows: (CellRow | null)[] | null = collect ? [] : null;
  const scanCols = !meta.hasDimension;
  let nonEmpty = 0;
  let prev = 0;

  for (;;) {
    const e = await scanner.next();
    if (e === null) break;
    if (e.type === 'end') {
      if (e.local === 'sheetData') break;
      continue;
    }
    if (e.type === 'text') continue;
    if (e.local !== 'row') {
      if (!e.selfClosing) await scanner.skipElement();
      continue;
    }

    const r = rowIndexOf(e, prev);
    prev = r;
    if (r > meta.maxRowSeen) meta.maxRowSeen = r;

    if (r > ctx.limits.maxRows) {
      ctx.counters.truncatedRows = true;
      if (!e.selfClosing) await scanner.skipElement();
      continue;
    }

    // 行高：两种情况都顺手取（行 start 事件本来就要读属性）
    const ht = attr(e, 'ht');
    if (ht !== undefined) {
      const h = Number.parseFloat(ht);
      if (Number.isFinite(h) && h > 0) rowHeights.set(r - 1, h);
    }

    if (!collect) {
      if (scanCols) {
        const cols = await scanRowMaxCol(scanner, e);
        if (cols > meta.maxColSeen) meta.maxColSeen = cols;
      } else if (!e.selfClosing) {
        // 整行跳过：不解析、不建对象，只做字符级扫描
        await scanner.skipElement();
      }
      continue;
    }

    if (e.selfClosing) continue;
    const row = await readRow(scanner, e, r - 1, ctx);
    if (row.cells.length) {
      rows![r - 1] = row;
      nonEmpty++;
      const last = row.cells[row.cells.length - 1].c + 1;
      if (last > meta.maxColSeen) meta.maxColSeen = last;
    }
    if (ctx.counters.exhausted) break; // 剩下的格子不再物化
  }

  return { rows, nonEmpty };
}

/* ==================================================================== */
/* 整表扫描                                                             */
/* ==================================================================== */

export interface ScanOptions {
  /** auto：按 dimension 决定是否物化；collect：强制物化；skip：只要元数据 */
  mode: 'auto' | 'collect' | 'skip';
  limits: Limits;
  sst?: SharedStrings;
  styles?: StyleTable;
  date1904: boolean;
  guard?: LimitGuard;
  warn: (msg: string) => void;
  truncate: (what: string) => void;
  signal?: AbortSignal;
}

export interface ScanResult {
  meta: WorksheetMeta;
  /** mode=collect 时给出（下标为 0 起行号，空行缺省） */
  rows: (CellRow | null)[] | null;
  nonEmptyRows: number;
  counters: SheetCounters;
  /** 实际走了物化分支 */
  collected: boolean;
  /** 直到 `<sheetData>` 都还没见到 `<dimension>`（说明尺寸只能靠扫出来） */
  lateDecision: boolean;
}

/** 需要下探子元素的容器 —— 其余元素一律整棵跳过，避免把无关扩展元素误当成表结构。 */
const DESCEND = new Set(['worksheet', 'sheetPr', 'sheetViews', 'sheetView', 'cols', 'mergeCells']);

export async function scanSheet(open: () => ReadableStream<string>, o: ScanOptions): Promise<ScanResult> {
  const first = await scanOnce(open, o, o.mode);
  if (o.mode !== 'auto') return first;

  // 拿不到 <dimension> 时第一遍只能保守地不物化。若实际很小，再补一遍物化 ——
  // 代价是两次扫描，只发生在「缺 dimension 的小表」这个少见路径上。
  const small = first.meta.rowCount * first.meta.colCount <= smallThreshold(o.limits);
  if (!first.collected && (first.lateDecision || !first.meta.hasDimension) && small && !first.counters.exhausted) {
    return await scanOnce(open, o, 'collect');
  }
  return first;
}

function smallThreshold(limits: Limits): number {
  return Math.max(0, Math.min(SMALL_TABLE_CELLS, limits.maxCells));
}

async function scanOnce(open: () => ReadableStream<string>, o: ScanOptions, mode: ScanOptions['mode']): Promise<ScanResult> {
  const counters = newCounters();
  const meta: WorksheetMeta = {
    rowCount: 0,
    colCount: 0,
    defaultColWidth: excelColWidthToPt(8.43),
    defaultRowHeight: 15,
    truncated: false,
    hasDimension: false,
    maxRowSeen: 0,
    maxColSeen: 0,
  };
  const rowHeights = new Map<number, number>();
  const colWidths: number[] = [];

  // maxCells 用 guard 的**全局**预算（跨工作表），行/列上限则按工作表判 —
  // 否则「3 张各 40 万行的表」会被误判成超过 maxRows。
  const ctx: CellReadContext = {
    limits: o.limits,
    sst: o.sst,
    styles: o.styles,
    date1904: o.date1904,
    counters,
    warn: o.warn,
    onCell: () => {
      if (o.guard && !o.guard.probe('maxCells', 1)) {
        counters.exhausted = true;
        return false;
      }
      counters.cells++;
      return true;
    },
  };

  let collect = mode === 'collect';
  let decided = mode !== 'auto';
  let lateDecision = false;
  let rows: (CellRow | null)[] | null = null;
  let nonEmptyRows = 0;

  const scanner = new StreamXmlScanner(open());
  try {
    for (;;) {
      if (o.signal?.aborted) {
        o.warn('读取被调用方中止，结果可能不完整');
        break;
      }
      const e = await scanner.next();
      if (e === null) break;
      if (e.type === 'end') continue;
      if (e.type === 'text') continue;

      switch (e.local) {
        case 'dimension': {
          const range = parseRangeRef(attr(e, 'ref'));
          if (range) {
            meta.rowCount = range.r2 + 1;
            meta.colCount = range.c2 + 1;
          }
          meta.hasDimension = true;
          if (!decided) {
            collect = mode === 'collect' || (mode === 'auto' && meta.rowCount * meta.colCount <= smallThreshold(o.limits));
            decided = true;
          }
          continue;
        }
        case 'sheetFormatPr': {
          const rh = Number.parseFloat(attr(e, 'defaultRowHeight') ?? '');
          if (Number.isFinite(rh) && rh > 0) meta.defaultRowHeight = rh;
          const cw = Number.parseFloat(attr(e, 'defaultColWidth') ?? '');
          if (Number.isFinite(cw) && cw > 0) meta.defaultColWidth = excelColWidthToPt(cw);
          continue;
        }
        case 'pane': {
          const state = attr(e, 'state');
          const xs = attrInt(e, 'xSplit', 0);
          const ys = attrInt(e, 'ySplit', 0);
          if ((state === 'frozen' || state === 'frozenSplit') && (xs > 0 || ys > 0)) {
            meta.freeze = { rows: ys, cols: xs };
          }
          continue;
        }
        case 'col': {
          const min = attrInt(e, 'min', 1);
          const max = attrInt(e, 'max', min);
          const hidden = attrBool(e, 'hidden', false);
          const wRaw = attr(e, 'width');
          const w = wRaw !== undefined ? Number.parseFloat(wRaw) : Number.NaN;
          if (min >= 1 && max >= min) {
            // 上限保护：真实文件里常见 <col min="6" max="1048576"/>，
            // 不设上限就会分配一个百万长度的数组。
            //
            // 注意区分两种「裁剪」：
            //   - 按本表列数裁剪 —— 正常行为（写入器常把列格式一路铺到表尾），不记截断；
            //   - 撞上 limits.maxCols —— 真截断，必须记录。
            // 早期版本把前者也记成 truncated，于是打开一个正常的 WPS 文件就报
            // 「maxCols 被截断」，用户会以为内容丢了。
            const cap = meta.hasDimension && meta.colCount > 0 ? Math.min(meta.colCount, o.limits.maxCols) : o.limits.maxCols;
            if (max > o.limits.maxCols) {
              counters.truncatedCols = true;
              o.truncate('maxCols');
            }
            const hi = Math.min(max, cap) - 1;
            if (Number.isFinite(w) && hi >= min - 1) {
              const pt = hidden ? 0 : excelColWidthToPt(w);
              for (let c = min - 1; c <= hi; c++) colWidths[c] = pt;
            }
          }
          continue;
        }
        case 'mergeCell': {
          const range = parseRangeRef(attr(e, 'ref'));
          if (range) (meta.merges ??= []).push(range);
          continue;
        }
        case 'autoFilter': {
          const range = parseRangeRef(attr(e, 'ref'));
          if (range) meta.autoFilter = range;
          continue;
        }
        case 'sheetData': {
          if (!decided) {
            // 没有 dimension：默认不物化（宁可走惰性，也不赌它是个小表）
            collect = mode === 'collect';
            decided = true;
            lateDecision = true;
          }
          if (e.selfClosing) {
            // <sheetData/>：空表。仍要给出 rows=[]，否则会被当成「没物化」而走惰性分支
            if (collect) rows = [];
            continue;
          }
          const res = await parseSheetData(scanner, meta, rowHeights, ctx, collect);
          rows = res.rows;
          nonEmptyRows = res.nonEmpty;
          // 撞到 maxCells 后没有必要再扫完剩下的表：结果已经标记为截断，
          // 继续扫只会白白解压几千万字符。
          if (counters.exhausted) break;
          continue;
        }
        case 'hyperlinks':
          o.warn('超链接未保留到模型（仅单元格文本）');
          break;
        case 'conditionalFormatting':
          o.warn('条件格式未求值，按静态样式显示');
          break;
        case 'dataValidations':
          o.warn('数据验证规则未保留');
          break;
        case 'drawing':
        case 'legacyDrawing':
          o.warn('工作表中的图片/图形未解析');
          continue;
        case 'extLst':
          // 扩展列表整棵跳过：里面可能有形似 autoFilter / conditionalFormatting 的
          // x14/x15 元素，若下探会被误当成表级结构（例如把 x14:autoFilter 当成自动筛选）
          if (!e.selfClosing) await scanner.skipElement();
          continue;
        default:
          break;
      }

      if (DESCEND.has(e.local)) continue;
      if (!e.selfClosing) await scanner.skipElement();
    }
  } finally {
    await scanner.cancel();
  }

  // ---- 收尾：行列数与截断 ----
  meta.rowCount = Math.max(meta.rowCount, meta.maxRowSeen);
  meta.colCount = Math.max(meta.colCount, meta.maxColSeen);
  if (meta.rowCount > o.limits.maxRows) {
    meta.rowCount = o.limits.maxRows;
    counters.truncatedRows = true;
  }
  if (meta.colCount > o.limits.maxCols) {
    meta.colCount = o.limits.maxCols;
    counters.truncatedCols = true;
  }
  if (counters.truncatedRows) o.truncate('maxRows');
  if (counters.truncatedCols) o.truncate('maxCols');
  if (counters.exhausted) o.truncate('maxCells');
  if (colWidths.length) meta.colWidths = colWidths;
  if (rowHeights.size) meta.rowHeights = rowHeights;
  meta.truncated = counters.truncatedRows || counters.truncatedCols || counters.exhausted;

  return { meta, rows, nonEmptyRows, counters, collected: collect && rows !== null, lateDecision };
}

/* ==================================================================== */
/* 惰性网格                                                             */
/* ==================================================================== */

/**
 * 惰性窗口取数器（**带扫描游标**）。
 *
 * 先说清代价性质：deflate 流无法随机访问，所以一次 fetch 必须**从表头扫到窗口位置** ——
 * 读窗口的代价 ∝ 窗口距表头的距离，而不是 ∝ 窗口大小。这是低内存设计的固有取舍
 * （用 CPU 换内存），必须显式承认，而不是假装它和窗口同阶。
 *
 * 缓解（本函数存在的理由）：
 *   - 「往下滚一屏」是最常见的交互。如果每次 fetch 都重开流从头扫，第 6 万行的窗口
 *     每次都要付 6 万行的扫描成本，滚动会变成幻灯片。
 *     因此这里记住**已经扫到哪一行**，并把上游解压流保持打开：
 *     顺序向下请求直接从游标续扫，代价回到 O(窗口)。
 *   - 往回滚（start < 游标）无法在压缩流里后退，只能重开流从表头再扫（代价 O(start)）。
 *     这是可接受的：LRU 行缓存（默认 600 行）会兜住小幅回滚。
 *   - 若要跳到窗口右边界之后的行，游标仍然有效：中间的行做字符级跳过，不建对象。
 *
 * 并发：LazyGrid 的并发去重是按 start 键做的，不同窗口仍可能同时在飞。
 * 这里用一条 Promise 链把请求串行化，避免两个请求同时消费同一个流造成错位。
 *
 * 资源：两次 fetch 之间上游流保持打开（几十 KB 的解压状态 + 一个 Blob 视图）。
 * 命中流尾时会立刻 cancel 并释放；文档整体被回收时也随之一并释放。
 */
export function makeCursorFetcher(open: () => ReadableStream<string>, o: ScanOptions): (start: number, end: number) => Promise<CellRow[]> {
  const counters = newCounters();
  const ctx: CellReadContext = {
    limits: o.limits,
    sst: o.sst,
    styles: o.styles,
    date1904: o.date1904,
    counters,
    warn: o.warn,
    // 惰性路径下窗口大小由调用方决定，这里不再用全局 maxCells 卡它
    // （否则「滚动到很后面」会莫名其妙地开始缺格）。
    onCell: () => {
      counters.cells++;
      return true;
    },
  };

  let scanner: StreamXmlScanner | null = null;
  let inData = false;
  /** 扫描游标：下一个待消费的行号（0 起）。scanner 正好停在这一行之前 */
  let cursor = 0;
  /** 已读到 start 事件但尚未消费的行 —— 为了「停在窗口右边界」必须留着它 */
  let pending: { start: XmlEvent; row0: number } | null = null;
  /** 最近一次见到的 1 起行号，用于缺 r 属性时顺延 */
  let lastRowNumber = 0;
  let chain: Promise<unknown> = Promise.resolve();

  /**
   * 丢掉当前流。注意**不要**在这里清 eof 之类的全局结论 ——
   * 这只表示「这条流用完了」，下次请求会重新 open() 一条新流从头扫。
   * 早期版本在 EOF 之后用一个 eof 旗标直接返回空窗口，结果是
   * 「先读末尾、再读中间」时中间窗口静默变成空行 —— 数据丢了还看不出来。
   */
  const dropScanner = async (): Promise<void> => {
    const s = scanner;
    scanner = null;
    inData = false;
    cursor = 0;
    pending = null;
    lastRowNumber = 0;
    if (s) await s.cancel();
  };

  async function scanWindow(start: number, end: number): Promise<CellRow[]> {
    if (start < cursor) await dropScanner(); // 回退：压缩流不能倒退，只能重开

    const out: CellRow[] = [];
    for (;;) {
      // ---- 1. 取得「当前行」的 start 事件 ----
      let rowStart: XmlEvent;
      let row0: number;

      if (pending) {
        if (pending.row0 < start) {
          const p = pending;
          pending = null;
          if (!p.start.selfClosing && scanner) await scanner.skipElement();
          cursor = p.row0 + 1;
          continue;
        }
        if (pending.row0 >= end) return out; // 窗口右边界：保留游标，下次从这里续
        rowStart = pending.start;
        row0 = pending.row0;
        pending = null;
      } else {
        if (!scanner) {
          scanner = new StreamXmlScanner(open());
          inData = false;
          cursor = 0;
          lastRowNumber = 0;
        }
        let found = false;
        for (;;) {
          const e = await scanner.next();
          if (e === null) {
            await dropScanner(); // 这条流读完：下次请求会重开一条新流
            return out;
          }
          if (e.type !== 'start') continue;
          if (!inData) {
            if (e.local === 'sheetData') inData = true;
            continue;
          }
          if (e.local !== 'row') {
            if (!e.selfClosing) await scanner.skipElement();
            continue;
          }
          const r = rowIndexOf(e, lastRowNumber);
          lastRowNumber = r;
          row0 = r - 1;
          rowStart = e;
          found = true;
          break;
        }
        if (!found) return out;
      }

      // ---- 2. 处理这一行 ----
      if (row0! < start) {
        if (!rowStart!.selfClosing && scanner) await scanner.skipElement();
        cursor = row0! + 1;
        continue;
      }
      if (row0! >= end) {
        pending = { start: rowStart!, row0: row0! };
        cursor = row0!;
        return out;
      }
      cursor = row0! + 1;
      if (rowStart!.selfClosing) continue;
      const row = await readRow(scanner!, rowStart!, row0!, ctx);
      if (row.cells.length) out.push(row);
    }
  }

  return (start: number, end: number): Promise<CellRow[]> => {
    const run = chain.then(() => scanWindow(start, end));
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/* ==================================================================== */
/* 组装 Sheet                                                           */
/* ==================================================================== */

/**
 * 把 Sheet 的附加字段**挂到 grid 实例上**，而不是包一层壳。
 * 原因：`sheet instanceof LazyGrid` 必须成立，UI/测试才能读到 `cachedRows`
 * 来展示「当前常驻了多少行」；包一层壳会让这个能力消失。
 */
export function attachSheet(grid: Grid, fields: Omit<Sheet, keyof Grid>): Sheet {
  const sheet = grid as unknown as Sheet;
  Object.assign(sheet, fields);
  return sheet;
}

export interface WorksheetParseOptions {
  open: () => ReadableStream<string>;
  limits: Limits;
  guard?: LimitGuard;
  sst?: SharedStrings;
  styles?: StyleTable;
  date1904: boolean;
  warn: (msg: string) => void;
  truncate: (what: string) => void;
  signal?: AbortSignal;
}

export interface WorksheetParseResult {
  meta: WorksheetMeta;
  grid: Grid;
  /** 本次解析实际物化的单元格数（惰性表为 0，随 fetch 增长） */
  cells: number;
  /**
   * 惰性表的单元格数**估算**（rowCount × colCount 的区域上界）。
   * 不物化就不可能逐格统计，但统计字段绝不能报 0（UI 会显示「0 单元格」在撒谎），
   * 所以给上界并由调用方标注「估算」。物化路径下为 0（此时 cells 是精确值）。
   */
  estimatedCells: number;
  /** 已物化行的估算字节数（惰性表为 0：行还没被物化出来） */
  modelBytes: number;
  usedLazy: boolean;
}

export async function parseWorksheet(o: WorksheetParseOptions): Promise<WorksheetParseResult> {
  const scanOptions: ScanOptions = {
    mode: 'auto',
    limits: o.limits,
    sst: o.sst,
    styles: o.styles,
    date1904: o.date1904,
    guard: o.guard,
    warn: o.warn,
    truncate: o.truncate,
    signal: o.signal,
  };

  const result = await scanSheet(o.open, scanOptions);
  const meta = result.meta;

  if (result.collected && result.rows) {
    const grid = new MaterializedGrid(result.rows, meta.rowCount, meta.colCount);
    return {
      meta,
      grid,
      cells: result.counters.cells,
      estimatedCells: 0,
      modelBytes: estimateBytes(result.rows),
      usedLazy: false,
    };
  }

  // 大表：缓存刻意小（默认 600 行）。缓存大就等价于物化整表，反而丧失低内存优势。
  const cacheRows = Math.max(64, Math.min(600, Math.floor(o.limits.rowWindow * 3)));
  const fetch = makeCursorFetcher(o.open, { ...scanOptions, mode: 'skip' });
  const grid = new LazyGrid({ rowCount: meta.rowCount, colCount: meta.colCount, fetch, cacheRows });
  return {
    meta,
    grid,
    cells: 0,
    estimatedCells: meta.rowCount * meta.colCount,
    modelBytes: 0,
    usedLazy: true,
  };
}
