/**
 * Grid 的两个实现。
 *
 * 这是「低内存浏览大表」的落点，也是本项目相对 WPS 最实质的技术差异：
 * WPS/Excel 打开大表时倾向于把整表（或大面积区域）物化在内存里，
 * 于是 20 万行的表就能吃掉几百 MB。
 *
 * LiteOffice 的做法：
 *   - MaterializedGrid：小表直接放内存（快，但体积可控）
 *   - LazyGrid：只保留「怎么再读一次」的方法，按可视窗口重新流式解析
 *     —— 峰值内存与**窗口大小**同阶，与全表大小无关
 *
 * 读取器根据预估单元格数自动在两者之间选择。
 */
import type { Cell, CellRow, Grid, MergeRange } from './model.ts';
import { estimateBytes, estimateStringBytes } from './memory.ts';

/** 单个 Cell 对象的固定开销（对象头 + 若干数值字段） */
const CELL_OVERHEAD = 96;
/** 空 CellRow 的开销 */
const ROW_OVERHEAD = 48;

/** 估算一行单元格的字节数（供两个 Grid 实现共用，避免口径不一致） */
function estimateRowBytes(row: CellRow): number {
  let n = ROW_OVERHEAD + row.cells.length * 8;
  for (const c of row.cells) {
    n += CELL_OVERHEAD;
    n += estimateStringBytes(c.v);
    if (c.f) n += estimateStringBytes(c.f);
    if (c.rich) n += estimateBytes(c.rich);
  }
  return n;
}

export class MaterializedGrid implements Grid {
  readonly rowCount: number;
  readonly colCount: number;
  /** 按行索引的稀疏数组；空行是 null，避免为空区分配数组 */
  private readonly rows: (CellRow | null)[];

  constructor(rows: (CellRow | null)[], rowCount: number, colCount: number) {
    this.rows = rows;
    this.rowCount = rowCount;
    this.colCount = colCount;
  }

  async readRows(start: number, end: number): Promise<CellRow[]> {
    const lo = Math.max(0, Math.floor(start));
    const hi = Math.min(this.rowCount, Math.ceil(end));
    const out: CellRow[] = [];
    for (let r = lo; r < hi; r++) {
      out.push(this.rows[r] ?? { r, cells: [] });
    }
    return out;
  }

  /** 同步读取，供不需要 await 的调用方使用 */
  rowAt(r: number): CellRow {
    return this.rows[r] ?? { r, cells: [] };
  }

  /**
   * 物化实现：所有行都在内存里，所以报的就是全表占用。
   * 这是「大表不该走这条路径」的量化依据 —— 拿它和 LazyGrid 对比就能看出差距。
   */
  estimateBytes(): number {
    let n = 64;
    for (const row of this.rows) {
      if (row) n += estimateRowBytes(row);
    }
    return n;
  }

  /** 转为紧凑的二维稀疏表示，便于序列化到 Worker 或缓存 */
  toSparse(): CellRow[] {
    const out: CellRow[] = [];
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      if (row && row.cells.length) out.push(row);
    }
    return out;
  }
}

export interface LazyGridOptions {
  rowCount: number;
  colCount: number;
  /** 真正去取某一批行的方法。实现可以重新解压+扫描源 XML。 */
  fetch: (start: number, end: number) => Promise<CellRow[]>;
  /** 小 LRU 缓存，避免来回滚动时反复解析同一区域 */
  cacheRows?: number;
}

/**
 * LazyGrid —— 带 LRU 行缓存的惰性网格。
 *
 * 缓存大小刻意很小（默认 600 行）。缓存大就等价于物化整表，
 * 反而丧失低内存优势；这里的目标是「滚动流畅」而非「全部常驻」。
 */
export class LazyGrid implements Grid {
  readonly rowCount: number;
  readonly colCount: number;
  private readonly fetchFn: (start: number, end: number) => Promise<CellRow[]>;
  private readonly cache = new Map<number, CellRow>();
  private readonly cacheLimit: number;
  /** 并发去重：同一行被多个渲染帧同时请求时只解析一次 */
  private readonly inflight = new Map<number, Promise<CellRow[]>>();

  constructor(options: LazyGridOptions) {
    this.rowCount = options.rowCount;
    this.colCount = options.colCount;
    this.fetchFn = options.fetch;
    this.cacheLimit = options.cacheRows ?? 600;
  }

  async readRows(start: number, end: number): Promise<CellRow[]> {
    const lo = Math.max(0, Math.floor(start));
    const hi = Math.min(this.rowCount, Math.ceil(end));
    if (hi <= lo) return [];

    const missing: number[] = [];
    const out: CellRow[] = new Array(hi - lo);
    for (let r = lo; r < hi; r++) {
      const hit = this.cache.get(r);
      if (hit) {
        this.touch(r, hit);
        out[r - lo] = hit;
      } else {
        missing.push(r);
      }
    }

    if (missing.length === 0) return out;

    const fetched = await this.fetchRange(missing[0], missing[missing.length - 1] + 1);
    const byRow = new Map<number, CellRow>();
    for (const row of fetched) byRow.set(row.r, row);

    for (let i = 0; i < missing.length; i++) {
      const r = missing[i];
      const row = byRow.get(r) ?? { r, cells: [] };
      this.put(r, row);
      out[r - lo] = row;
    }
    return out;
  }

  /** 按范围取行并做并发去重 */
  private async fetchRange(start: number, end: number): Promise<CellRow[]> {
    const key = start;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.fetchFn(start, end).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private touch(r: number, row: CellRow): void {
    // Map 保序：删了再设即移到末尾（最近使用）
    this.cache.delete(r);
    this.cache.set(r, row);
  }

  private put(r: number, row: CellRow): void {
    this.cache.set(r, row);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** 当前缓存行数，供内存 HUD 展示 */
  get cachedRows(): number {
    return this.cache.size;
  }

  /**
   * 惰性实现：只报**缓存**占用的字节，而不是全表。
   *
   * 这正是我们要展示的性质 —— 峰值内存与可视窗口同阶、与全表行数无关。
   * 浏览 50 万行的表和浏览 500 行的表，这个数字应当基本相同。
   */
  estimateBytes(): number {
    let n = 128; // Grid 自身与缓存 Map 的开销
    for (const row of this.cache.values()) n += estimateRowBytes(row);
    n += this.cache.size * 8;
    return n;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * 把一行的单元格按列索引排好，并填平空隙 —— 渲染器需要稳定的列位置。
 * 输入允许乱序（OOXML 保证有序，但 ODF 的 number-columns-repeated 会产生跳跃）。
 */
export function normalizeRow(row: CellRow): CellRow {
  if (row.cells.length < 2) return row;
  let sorted = true;
  for (let i = 1; i < row.cells.length; i++) {
    if (row.cells[i - 1].c > row.cells[i].c) {
      sorted = false;
      break;
    }
  }
  if (sorted) return row;
  return { r: row.r, cells: [...row.cells].sort((a, b) => a.c - b.c) };
}

/** 判断某个坐标是否落在任意合并区域内（且不是该区域的左上角） */
export function mergeAnchor(merges: readonly MergeRange[] | undefined, r: number, c: number): { anchor: MergeRange; isTopLeft: boolean } | null {
  if (!merges) return null;
  for (const m of merges) {
    if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) {
      return { anchor: m, isTopLeft: r === m.r1 && c === m.c1 };
    }
  }
  return null;
}

/** 从行窗口里取某格；找不到返回 undefined */
export function findCell(row: CellRow | undefined, c: number): Cell | undefined {
  if (!row) return undefined;
  // 二分：行内单元格按列升序
  let lo = 0;
  let hi = row.cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mc = row.cells[mid].c;
    if (mc === c) return row.cells[mid];
    if (mc < c) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}
