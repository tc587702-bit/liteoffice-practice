/**
 * ODF 表格（ods/ots/fods）解析：`office:spreadsheet` -> UDM `sheets`。
 *
 * 与文字处理里的表格不同，这里的目标是**大表也能打开**，所以：
 *   - 行按稀疏方式存放（空行是 null），单元格只存非空的
 *   - 空填充格共用一个 Cell 模板对象，逐格只改列号
 *   - 整表超过 limits.maxRows / maxCols / maxCells 时截断并记录 truncated
 *
 * `table:number-columns-repeated` 在 ods 里比在 odt 里更凶：LibreOffice 删空一列
 * 区域后会写成 `number-columns-repeated="1024"`，删空的行区间会写成上万。
 * 因此每个重复都必须先与「本表列上限」和「剩余单元格预算」取小，
 * 再决定实际构造多少个对象 —— 这是本文件最重要的一条约束。
 */
import type { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import type { Cell, CellRow, CellStyle, MergeRange, Sheet } from '../../core/src/index.ts';
import { MaterializedGrid } from '../../core/src/grid.ts';
import { attr, attrInt } from './xmlUtil.ts';
import { columnWidthPt, resolveCell, rowHeightPt } from './styles.ts';
import { markTruncated } from './types.ts';
import type { OdContext } from './types.ts';
import { clampRepeat } from './content.ts';

/** 单表单元格硬上限，避免一个畸形 ods 绕过 maxCells 吃光内存。 */
const MAX_CELLS_PER_SHEET = 500_000;
/** 单表列数硬上限：Excel 的物理上限，也是我们对畸形重复值的最后一道闸。 */
const HARD_MAX_COLS = 16_384;

/** UDM 的默认列宽/行高（pt）。ODF 不写默认值时用它 —— 与 Excel 的观感接近。 */
const DEFAULT_COL_WIDTH_PT = 48;
const DEFAULT_ROW_HEIGHT_PT = 12.8;

/** 工作表级的页面信息，供 reader 填 meta。 */
export interface PageSetupInfo {
  widthPt?: number;
  heightPt?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
}

/**
 * 解析 `office:body` 下的 `office:spreadsheet`。
 * 调用前提：解析器刚产出 `<office:spreadsheet>` 的 start 事件。
 */
export function parseSpreadsheetBody(p: XmlPullParser, ctx: OdContext, out: Sheet[], page: PageSetupInfo): void {
  let e: XmlEvent | null;
  let reachedEnd = false;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') {
      reachedEnd = true;
      break;
    }
    if (e.type !== 'start') continue;
    if (e.local === 'table') {
      if (out.length >= 1024) {
        markTruncated(ctx, 'maxSheets', '工作表数超过 1024，其余已忽略');
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      const sheet = parseSheet(p, e, ctx, page);
      if (sheet) out.push(sheet);
      continue;
    }
    if (!e.selfClosing) p.skipElement();
  }
  if (!reachedEnd) {
    // 拉取解析器在文档中途耗尽时返回 null 而不抛错，必须显式记账
    markTruncated(ctx, 'content', 'content.xml 在工作表列表中结束（文件被截断或损坏），已显示已解析的部分');
  }
}

function parseSheet(p: XmlPullParser, e: XmlEvent, ctx: OdContext, page: PageSetupInfo): Sheet | undefined {
  const name = attr(e, 'name') ?? '未命名工作表';
  const hidden = attr(e, 'display') === 'false';

  const styles: CellStyle[] = [];
  /** 同名样式只解析一次，避免每格都算一遍继承链（大表上是数量级差异） */
  const styleIndexByName = new Map<string, number>();
  const rows: (CellRow | null)[] = [];
  const colDeclared: number[] = [];
  const rowHeights = new Map<number, number>();
  const merges: MergeRange[] = [];

  const maxRows = Math.max(1, ctx.limits.maxRows);
  const maxCols = Math.max(1, Math.min(ctx.limits.maxCols, HARD_MAX_COLS));
  let cellsLeft = Math.max(1, Math.min(ctx.limits.maxCells, MAX_CELLS_PER_SHEET));
  let rowIndex = 0;
  let maxColUsed = 0;
  let truncatedRows = false;
  let truncatedCols = false;
  let truncatedCells = false;

  if (!e.selfClosing) {
    let c: XmlEvent | null;
    while ((c = p.next()) !== null) {
      if (c.type === 'end') break;
      if (c.type !== 'start') continue;

      if (c.local === 'table-column') {
        const raw = attrInt(c, 'number-columns-repeated', 1);
        const repeat = clampRepeat(raw, Math.max(0, maxCols - colDeclared.length), () => {
          truncatedCols = true;
          markTruncated(
            ctx,
            'number-columns-repeated',
            `table:table-column 的 number-columns-repeated=${raw} 过大，已裁剪到列上限 ${maxCols}`,
          );
        });
        const pt = columnWidthPt(ctx.styles, attr(c, 'style-name'));
        for (let i = 0; i < repeat; i++) colDeclared.push(pt ?? 0);
        if (!c.selfClosing) p.skipElement();
        continue;
      }

      if (c.local === 'table-row') {
        if (rowIndex >= maxRows) {
          truncatedRows = true;
          if (!c.selfClosing) p.skipElement();
          continue;
        }
        const rawRepeat = attrInt(c, 'number-rows-repeated', 1);
        const repeat = clampRepeat(rawRepeat, maxRows - rowIndex, () => {
          truncatedRows = true;
        });
        const height = rowHeightPt(ctx.styles, attr(c, 'style-name'));
        const row: CellRow = { r: rowIndex, cells: [] };
        if (!c.selfClosing) {
          // 行内的列数上界：**以表的列声明为准**（它先于所有 table-row 出现），
          // 没有声明时才退回 limits.maxCols。
          // 这一步决定了 `number-columns-repeated="16380"` 是被裁到「表的真实
          // 列数」还是被裁到一个常数 —— 后者会让一张 4 列的表每行白白物化
          // 上千个空单元格对象，只是把问题缩小而不是消掉。
          // 留一点余量（+8），避免把「声明之外的真实内容格」误裁掉。
          const rowColLimit = colDeclared.length > 0 ? Math.min(colDeclared.length + 8, maxCols) : maxCols;
          parseRow(p, c, ctx, row, {
            maxCols: rowColLimit,
            styles,
            styleIndexByName,
            merges,
            spend: () => {
              cellsLeft -= 1;
            },
            get cellsLeft() {
              return cellsLeft;
            },
            onTruncate: (what) => {
              if (what === 'cols') truncatedCols = true;
              else truncatedCells = true;
            },
          });
        }
        if (row.cells.length > maxColUsed) maxColUsed = Math.min(row.cells.length, maxCols);

        for (let i = 0; i < repeat; i++) {
          const r = rowIndex + i;
          if (r >= maxRows) break;
          if (height !== undefined) rowHeights.set(r, height);
          if (row.cells.length === 0) {
            // 空行不分配数组：几十万行空白不会占内存（稀疏表示的关键）
            rows[r] = null;
            continue;
          }
          if (i === 0) {
            rows[r] = row;
            continue;
          }
          // 重复的非空行：只改行号，Cell 对象共享（它们是只读的）
          rows[r] = { r, cells: row.cells.map((cell) => ({ ...cell, r })) };
          cellsLeft -= row.cells.length;
          if (cellsLeft <= 0) {
            truncatedCells = true;
            break;
          }
        }
        rowIndex += repeat;
        continue;
      }

      if (c.local === 'table-header-rows' || c.local === 'table-rows') continue;
      if (!c.selfClosing) p.skipElement();
    }
  }

  const colCount = Math.max(maxColUsed, colDeclared.length);
  if (rowIndex === 0 && colCount === 0) return undefined;

  // 列宽：ODF 只给有样式声明的列；缺省列用默认宽度补齐（渲染时比例才正确）
  const colWidths: number[] = [];
  for (let i = 0; i < Math.min(colDeclared.length, maxCols); i++) {
    colWidths[i] = colDeclared[i] > 0 ? colDeclared[i] : DEFAULT_COL_WIDTH_PT;
  }

  if (truncatedRows) markTruncated(ctx, 'maxRows', `工作表「${name}」行数超过上限 ${maxRows}，其余行已忽略`);
  if (truncatedCols) markTruncated(ctx, 'maxCols', `工作表「${name}」列数超过上限 ${maxCols}，其余列已裁剪`);
  if (truncatedCells) markTruncated(ctx, 'maxCells', `工作表「${name}」单元格数超过上限，其余单元格已忽略`);

  const grid = new MaterializedGrid(rows, Math.max(rowIndex, rows.length), Math.max(colCount, 1));
  const sheet = new OdfSheet(grid, {
    name,
    hidden: hidden || undefined,
    styles,
    colWidths: colWidths.length ? colWidths : undefined,
    rowHeights: rowHeights.size ? rowHeights : undefined,
    merges: merges.length ? merges : undefined,
    truncated: truncatedRows || truncatedCols || truncatedCells || undefined,
  });
  void page;
  return sheet;
}

/**
 * Sheet 的实体。
 *
 * 为什么用**组合**而不是给 MaterializedGrid 打补丁：
 *   `readRows()` 是原型上的方法，`Object.assign` 复制不到它 —— 早期版本
 *   用 Object.assign 挂字段，结果 sheet.readRows 是 undefined，
 *   渲染器一取行就 TypeError。组合虽然多一层调用，但语义明确且不可能漏方法。
 */
class OdfSheet implements Sheet {
  readonly name: string;
  readonly hidden?: boolean;
  readonly styles: CellStyle[];
  readonly colWidths?: number[];
  readonly rowHeights?: Map<number, number>;
  readonly defaultColWidth: number;
  readonly defaultRowHeight: number;
  readonly merges?: MergeRange[];
  readonly truncated?: boolean;
  private readonly grid: MaterializedGrid;

  constructor(
    grid: MaterializedGrid,
    init: {
      name: string;
      hidden?: boolean;
      styles: CellStyle[];
      colWidths?: number[];
      rowHeights?: Map<number, number>;
      merges?: MergeRange[];
      truncated?: boolean;
    },
  ) {
    this.grid = grid;
    this.name = init.name;
    this.hidden = init.hidden;
    this.styles = init.styles;
    this.colWidths = init.colWidths;
    this.rowHeights = init.rowHeights;
    this.defaultColWidth = DEFAULT_COL_WIDTH_PT;
    this.defaultRowHeight = DEFAULT_ROW_HEIGHT_PT;
    this.merges = init.merges;
    this.truncated = init.truncated;
  }

  get rowCount(): number {
    return this.grid.rowCount;
  }

  get colCount(): number {
    return this.grid.colCount;
  }

  readRows(start: number, end: number): Promise<CellRow[]> {
    return this.grid.readRows(start, end);
  }

  /** 供需要同步访问的调用方（例如预览第一屏）使用 */
  rowAt(r: number): CellRow {
    return this.grid.rowAt(r);
  }
}

interface RowBudget {
  maxCols: number;
  styles: CellStyle[];
  styleIndexByName: Map<string, number>;
  merges: MergeRange[];
  spend(): void;
  readonly cellsLeft: number;
  onTruncate(what: 'cols' | 'cells'): void;
}

function parseRow(p: XmlPullParser, rowStart: XmlEvent, ctx: OdContext, row: CellRow, budget: RowBudget): void {
  void rowStart;
  let col = 0;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    if (e.local !== 'table-cell' && e.local !== 'covered-table-cell') {
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    const covered = e.local === 'covered-table-cell';
    const colSpan = covered ? 1 : Math.max(1, attrInt(e, 'number-columns-spanned', 1));
    const rowSpan = covered ? 1 : Math.max(1, attrInt(e, 'number-rows-spanned', 1));
    const rawRepeat = attrInt(e, 'number-columns-repeated', 1);

    // 剩余列数按 colSpan 折算成「还能放几份」，再与剩余单元格预算取小。
    // 这一步就是「16384 列填充不会撑爆内存」的落点。
    const colsLeft = Math.max(0, budget.maxCols - col);
    const byCols = Math.floor(colsLeft / colSpan);
    const allowance = Math.max(0, Math.min(byCols, budget.cellsLeft));
    const repeat = rawRepeat <= 1 ? 1 : clampRepeat(rawRepeat, allowance, () => {
      markTruncated(
        ctx,
        'number-columns-repeated',
        `table:number-columns-repeated=${rawRepeat} 过大，已裁剪到列上限 ${budget.maxCols}`,
      );
      budget.onTruncate('cols');
    });

    const startCol = col;
    const cell = parseCell(p, e, ctx, budget, startCol, row.r, covered);
    if (rowSpan > 1 || colSpan > 1) {
      budget.merges.push({ r1: row.r, c1: startCol, r2: row.r + rowSpan - 1, c2: startCol + colSpan - 1 });
    }

    if (repeat <= 0) {
      // 已被裁剪：只推进列游标，不构造对象
      col += colSpan * Math.max(1, repeat);
      continue;
    }
    if (!cell && covered) {
      // 被合并吃掉的延续格：不建对象，只占列位。UDM 里 merges 已经表达了这件事，
      // 再塞一个空 Cell 只会让每行多出大量只为占位的对象（大表上很可观）。
      col += colSpan;
      continue;
    }
    if (!cell) {
      // 完全空的格子（空填充）：整个重复段都不入模型。
      // 早期版本仍然 push 了第一份，于是 `number-columns-repeated="10"` 之外的
      // 每个稀疏空档都会留下一个只为占位的对象 —— 大表上纯属浪费内存。
      col += colSpan * repeat;
      continue;
    }
    const template: Cell = cell;
    const blank = isBlankCellData(template);
    for (let i = 0; i < repeat; i++) {
      if (col + colSpan > budget.maxCols) {
        budget.onTruncate('cols');
        break;
      }
      if (budget.cellsLeft <= 0) {
        budget.onTruncate('cells');
        break;
      }
      if (blank && i > 0) {
        // 空白重复格不进模型：ODF 用 number-columns-repeated 表达
        // 「这一行后面还有 1024 个空格子」。把它们物化成对象会让一个 20 KB
        // 的文件产生上百万个对象；稀疏存储的语义本来就是「不存空格」。
        // 因此只推进列游标 —— 列位置仍由有内容的格子与 table:table-column 决定。
        col += colSpan;
        continue;
      }
      row.cells.push({ ...template, c: col });
      budget.spend();
      col += colSpan;
    }
  }
}

/** 空的填充格：只有位置没有值。这类格子可以安全共享。 */
function isBlankCellData(cell: Cell): boolean {
  return cell.v === '' && cell.t === undefined && cell.f === undefined && !cell.rich && cell.s === undefined;
}

function parseCell(
  p: XmlPullParser,
  e: XmlEvent,
  ctx: OdContext,
  budget: RowBudget,
  col: number,
  rowIndex: number,
  covered: boolean,
): Cell | undefined {
  const valueType = attr(e, 'value-type');
  const formula = normalizeFormula(attr(e, 'formula'));
  const styleName = attr(e, 'style-name');

  // 必须先消费子树：单元格里的 text:p 可能是唯一的内容来源
  const rich = readCellRuns(p, e);
  const text = rich.map((r) => r.text).join('');

  const { value, type } = cellValue(e, valueType, text);
  const styleIdx = styleName ? styleIndexOf(ctx, budget, styleName) : undefined;
  if (value === '' && !formula && styleIdx === undefined && rich.length === 0) {
    // 完全空的格子不入模型：稀疏存储的前提
    return undefined;
  }

  const cell: Cell = { r: rowIndex, c: col, v: value };
  if (type !== undefined) cell.t = type;
  if (formula) cell.f = formula;
  if (styleIdx !== undefined) cell.s = styleIdx;
  if (rich.some((r) => r.style)) cell.rich = rich;
  return cell;
}

/** 取/建单元格样式索引。样式表按索引共享，不每格一个对象。 */
function styleIndexOf(ctx: OdContext, budget: RowBudget, styleName: string): number {
  const cached = budget.styleIndexByName.get(styleName);
  if (cached !== undefined) return cached;
  const resolved = resolveCell(ctx.styles, styleName);
  const style: CellStyle = {};
  if (resolved.bg) style.bg = resolved.bg;
  if (resolved.vAlign) style.vAlign = resolved.vAlign;
  if (resolved.wrap) style.wrap = true;
  if (resolved.align) style.align = resolved.align;
  if (resolved.bold !== undefined) style.bold = resolved.bold;
  if (resolved.italic !== undefined) style.italic = resolved.italic;
  if (resolved.underline !== undefined) style.underline = resolved.underline;
  if (resolved.strike !== undefined) style.strike = resolved.strike;
  if (resolved.color) style.color = resolved.color;
  if (resolved.sizePt !== undefined) style.size = resolved.sizePt;
  if (resolved.font) style.font = resolved.font;
  if (resolved.numFmt) style.numFmt = resolved.numFmt;
  if (resolved.borderWidthPt) {
    const line = { width: resolved.borderWidthPt, color: resolved.borderColor, style: resolved.borderStyle ?? 'solid' } as const;
    style.border = { top: { ...line }, bottom: { ...line }, left: { ...line }, right: { ...line } };
  }
  const idx = budget.styles.length;
  budget.styles.push(style);
  budget.styleIndexByName.set(styleName, idx);
  return idx;
}

/**
 * 读取单元格里的富文本（text:p -> runs）。
 *
 * 为什么单元格要保留 rich：
 *   ods 单元格里的加粗/颜色是**行内**格式（同一格内可以只加粗几个字），
 *   只用纯文本会让整格的字符格式全部丢失。
 */
function readCellRuns(p: XmlPullParser, e: XmlEvent): NonNullable<Cell['rich']> {
  if (e.selfClosing) return [];
  const runs: NonNullable<Cell['rich']> = [];
  let c: XmlEvent | null;
  while ((c = p.next()) !== null) {
    if (c.type === 'end') break;
    if (c.type !== 'start') continue;
    if (c.local === 'p') {
      collectParagraphText(p, c, runs);
      continue;
    }
    if (!c.selfClosing) p.skipElement();
  }
  return runs;
}

/** 收集 text:p 里的文本（span 等容器下钻即可）。 */
function collectParagraphText(p: XmlPullParser, start: XmlEvent, runs: NonNullable<Cell['rich']>): void {
  if (start.selfClosing) return;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type === 'text' || e.type === 'cdata') {
      if (e.text) runs.push({ text: e.text });
      continue;
    }
    if (e.type !== 'start') continue;
    if (e.local === 's') {
      const count = Math.max(1, Math.min(attrInt(e, 'c', 1), 4096));
      runs.push({ text: ' '.repeat(count) });
      continue;
    }
    if (e.local === 'tab') {
      runs.push({ text: '\t' });
      continue;
    }
    if (e.local === 'line-break') {
      runs.push({ text: '\n' });
      continue;
    }
    // span / a 等行内容器下钻；其余未知元素跳过整棵
    if (!e.selfClosing && e.local !== 'span' && e.local !== 'a') p.skipElement();
  }
}

/**
 * 把 ODF 的值属性归一成 (显示值, 单元格类型)。
 *
 * 注意：`office:value` 是**机器可读原值**，`office:string-value` 才是显示文本。
 * 优先用机器值是因为数字要保持精度与可排序性 —— 把 3.14159 存成格式化后的
 * "3.14" 会丢数据，而 numFmt 已经能让渲染器决定怎么显示。
 */
function cellValue(e: XmlEvent, valueType: string | undefined, text: string): { value: string; type: Cell['t'] } {
  switch (valueType) {
    case 'float':
    case 'currency':
    case 'percentage': {
      const v = attr(e, 'value');
      if (v !== undefined) return { value: v, type: 'n' };
      break;
    }
    case 'boolean': {
      const v = attr(e, 'boolean-value');
      if (v !== undefined) return { value: v === 'true' || v === '1' ? 'TRUE' : 'FALSE', type: 'b' };
      break;
    }
    case 'date': {
      const v = attr(e, 'date-value');
      if (v !== undefined) return { value: v, type: 'd' };
      break;
    }
    case 'time': {
      const v = attr(e, 'time-value');
      if (v !== undefined) return { value: normalizeTime(v), type: 'd' };
      break;
    }
    case 'string': {
      const v = attr(e, 'string-value');
      if (v !== undefined && v !== '') return { value: v, type: 's' };
      break;
    }
    default:
      break;
  }
  // 无 value-type（或该类型没带值）：只能靠显示文本
  const sv = attr(e, 'string-value');
  if (sv !== undefined && sv !== '') return { value: sv, type: 's' };
  if (text) return { value: text, type: 's' };
  return { value: '', type: undefined };
}

/** ODF 的 time-value 是 ISO 8601 duration（PT01H30M00S / P1DT2H）。 */
function normalizeTime(v: string): string {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(v.trim());
  if (!m) return v;
  const days = Number.parseInt(m[1] ?? '0', 10) || 0;
  const hours = (Number.parseInt(m[2] ?? '0', 10) || 0) + days * 24;
  const mins = Number.parseInt(m[3] ?? '0', 10) || 0;
  const secs = Math.floor(Number.parseFloat(m[4] ?? '0') || 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

/**
 * 去掉 ODF 公式的命名空间前缀。
 * `of:=SUM([.A1:.B2])` / `oooc:=[.A1]+[.B1]` -> `SUM([.A1:.B2])` / `[.A1]+[.B1]`
 *
 * 为什么只去前缀、不改写引用语法：
 *   ODF 的引用写作 `[.A1]`，与 Excel 的 `A1` 不同。双向转换极易出错且有损
 *   （跨表引用、绝对引用、区域运算符各不相同）。模型里 Cell.f 的用途是
 *   「让用户知道这里有公式」，保留原语法最诚实。
 */
export function normalizeFormula(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  const m = /^[A-Za-z][\w.-]*:(.*)$/.exec(s);
  if (m && !s.startsWith('[')) s = m[1];
  if (s.startsWith('=')) s = s.slice(1);
  s = s.trim();
  return s || undefined;
}
