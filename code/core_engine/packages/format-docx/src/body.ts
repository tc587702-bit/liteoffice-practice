/**
 * 块级结构解析：w:body / w:p / w:tbl / w:tc（含嵌套表格）、脚注尾注正文。
 *
 * 设计要点：
 *   - 每个解析函数都「消费掉自己那个元素的结束标签」且**只**用它作为返回条件，
 *     这样就不需要维护深度计数，也不会出现「多吞一个兄弟元素」的经典 bug。
 *   - 一切不认识的东西都是「记一笔 + 跳过」，绝不抛错：能打开优先于完美还原。
 *   - 表格的纵向合并用「按列记录起点格」的方式实现，连续格标 merged=true 让渲染器跳过。
 */
import type { Block, BorderStyle, Paragraph, ParaStyle, Run, Table, TableCell, TableRow } from '../../core/src/model.ts';
import { blocksToText } from '../../core/src/index.ts';
import { twipToPt } from '../../core/src/units.ts';
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { attr, attrNum, parseColor } from '../../ooxml/src/index.ts';
import {
  createRunState,
  ensureParaStyle,
  noteUnknown,
  parseAlternateContent,
  readBorders,
  readSectPr,
  warnOnce,
  type DocxEnv,
} from './env.ts';
import { parseParagraphContent } from './inline.ts';

/* ==================================================================== */
/* 入口：从整份部件 XML 里取根元素后的块序列                              */
/* ==================================================================== */

/**
 * 在整份 XML 里找到 rootLocal 元素，把它下面的内容当块序列解析。
 * document.xml 用 'body'，页眉/页脚用 'hdr'/'ftr'。
 */
export async function parseBlocksAt(
  xml: string,
  env: DocxEnv,
  rootLocals: readonly string[],
  out: Block[],
): Promise<void> {
  const p = new XmlPullParser(xml, { keepWhitespace: true });
  let found = false;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start') continue;
    if (!rootLocals.includes(e.local)) continue; // 不跳过：继续自然下钻
    found = true;
    if (!e.selfClosing) await parseBlockList(p, env, out);
    break;
  }
  if (!found) warnOnce(env, 'noroot', `未在部件中找到 ${rootLocals.join('/')} 元素，内容可能为空`);
}

/* ==================================================================== */
/* 块序列                                                                */
/* ==================================================================== */

/** 块级「容器」白名单：只有这些元素才值得下钻，避免把属性容器误当内容解析。 */
const BLOCK_CONTAINERS = new Set([
  'ins',
  'moveTo',
  'sdt',
  'sdtContent',
  'customXml',
  'smartTag',
  'dir',
  'bdo',
  'body',
  'tc',
  'txbxContent',
  'hdr',
  'ftr',
  'footnote',
  'endnote',
  'comment',
  'header',
  'footer',
]);

export async function parseBlockList(p: XmlPullParser, env: DocxEnv, out: Block[]): Promise<void> {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) return;
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'p': {
        // maxBlocks 是「整篇文档的块上限」：超了就停，绝不为了还原一份畸形文件把内存吃光
        if (!env.guard.probe('maxBlocks', 1)) {
          env.stopped = true;
          return;
        }
        if (e.selfClosing) {
          out.push({ kind: 'para', runs: [], id: `b${out.length}` });
          continue;
        }
        await parseParagraph(p, env, out);
        continue;
      }
      case 'tbl':
        if (!env.guard.probe('maxBlocks', 1)) {
          env.stopped = true;
          return;
        }
        if (!e.selfClosing) await parseTable(p, env, out);
        continue;
      case 'sectPr':
        if (!e.selfClosing) readSectPr(p, env);
        continue;
      case 'ins':
      case 'moveTo':
        warnOnce(env, 'revision-ins', '文档含修订标记（w:ins），已保留插入内容并忽略修订元数据');
        if (!e.selfClosing) await parseBlockList(p, env, out);
        continue;
      case 'del':
      case 'moveFrom':
        // 整段被删除（w:del 包住 w:p）：默认丢弃，只保留最终稿
        warnOnce(env, 'revision-del', '文档含修订删除（w:del），已丢弃删除内容（只保留最终稿）');
        if (!e.selfClosing) p.skipElement();
        continue;
      case 'bookmarkStart':
      case 'bookmarkEnd':
      case 'proofErr':
      case 'permStart':
      case 'permEnd':
      case 'commentRangeStart':
      case 'commentRangeEnd':
      case 'lastRenderedPageBreak':
      case 'customXmlInsRangeStart':
      case 'customXmlInsRangeEnd':
      case 'customXmlDelRangeStart':
      case 'customXmlDelRangeEnd':
      case 'customXmlMoveFromRangeStart':
      case 'customXmlMoveFromRangeEnd':
      case 'customXmlMoveToRangeStart':
      case 'customXmlMoveToRangeEnd':
      case 'insRangeStart':
      case 'insRangeEnd':
      case 'delRangeStart':
      case 'delRangeEnd':
        continue; // 纯标记，无内容
      case 'AlternateContent': {
        if (e.selfClosing) continue;
        // 与 run 层同样的去重规则：VML 回落不会重复生成整段内容
        const produced = out.length;
        await parseAlternateContent(p, produced, () => out.length, (pp) => parseBlockList(pp, env, out));
        continue;
      }
      default:
        if (BLOCK_CONTAINERS.has(e.local)) {
          if (!e.selfClosing) await parseBlockList(p, env, out);
          continue;
        }
        // 属性容器（tblPr / tcPr / sdtPr / tblGrid …）：整棵跳过，绝不下钻，
        // 否则里面的 tblW / gridCol 会被误当成正文元素
        if (!BLOCK_CONTAINERS.has(e.local) && !PROPERTY_CONTAINERS.has(e.local)) noteUnknown(env, e.local);
        if (!e.selfClosing) p.skipElement();
        continue;
    }
  }
}

/** 明确知道是「属性容器」的元素：跳过它们不算「不支持的特性」，不必记 unknown。 */
const PROPERTY_CONTAINERS = new Set([
  'tblPr',
  'tblPrEx',
  'tblGrid',
  'trPr',
  'tcPr',
  'pPr',
  'rPr',
  'sectPr',
  'sdtPr',
  'sdtEndPr',
  'numPr',
  'tabs',
  'pBdr',
  'tcMar',
  'tcBorders',
  'tblBorders',
  'rPrDefault',
  'pPrDefault',
  'docDefaults',
]);

/* ==================================================================== */
/* 段落                                                                  */
/* ==================================================================== */

/**
 * 解析 `w:p`。分页符（`w:br w:type="page"`）会在事件发生的位置把段落切开，
 * 中间插入一个 PageBreakBlock —— 这样「分页符前后的块顺序」与原文一致。
 */
export async function parseParagraph(p: XmlPullParser, env: DocxEnv, out: Block[]): Promise<void> {
  const st = createRunState();
  st.blockParser = (pp, o) => parseBlockList(pp, env, o);
  let sawPageBreak = false;

  const flushPara = (): void => {
    if (!st.runs.length) return;
    out.push(makePara(st.runs, ensureParaStyle(st, env), out.length));
    st.runs = [];
  };

  st.onPageBreak = () => {
    flushPara();
    // 文本框内容属于分页符之前的内容，先落盘再插分页符
    if (st.extraBlocks.length) {
      out.push(...st.extraBlocks);
      st.extraBlocks = [];
    }
    out.push({ kind: 'pagebreak' });
    sawPageBreak = true;
  };

  await parseParagraphContent(p, env, st);
  if (env.stopped) return;

  // st.runs 为空且发生过分页：说明分页符就是这段的全部内容，不再补空段落。
  // 但真正的空段落（<w:p/>）必须保留 —— Word 里它就是「空一行」。
  if (st.runs.length || !sawPageBreak) {
    out.push(makePara(st.runs, ensureParaStyle(st, env), out.length));
  }
  if (st.extraBlocks.length) out.push(...st.extraBlocks);
}

function makePara(runs: Run[], style: ParaStyle | undefined, index: number): Paragraph {
  const para: Paragraph = { kind: 'para', runs, id: `b${index}` };
  if (style) para.style = style;
  return para;
}

/* ==================================================================== */
/* 表格                                                                  */
/* ==================================================================== */

interface TableCtx {
  /** 列号 -> 该列纵向合并的起点单元格 */
  vmerge: Map<number, TableCell>;
  /** 第 0 行各格的 w:tcW（twip），tblGrid 缺失时作为列宽兜底 */
  firstRowWidths: number[];
  rowIndex: number;
}

async function parseTable(p: XmlPullParser, env: DocxEnv, out: Block[]): Promise<void> {
  env.tableCount++;
  const rows: TableRow[] = [];
  const ctx: TableCtx = { vmerge: new Map(), firstRowWidths: [], rowIndex: 0 };
  let grid: number[] | undefined;
  let border: BorderStyle | undefined;
  let widthPt: number | undefined;
  let tblWType: string | undefined;
  let tblWVal = NaN;

  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) return;
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'tblGrid':
        if (!e.selfClosing) grid = readTblGrid(p);
        continue;
      case 'tblPr':
        if (!e.selfClosing) {
          const pr = readTblPr(p);
          if (pr.border) border = pr.border;
          if (pr.width !== undefined) widthPt = pr.width;
          if (pr.wType) tblWType = pr.wType;
          if (Number.isFinite(pr.wVal)) tblWVal = pr.wVal;
        }
        continue;
      case 'tr':
        if (!e.selfClosing) {
          rows.push(await parseTableRow(p, env, ctx));
          ctx.rowIndex++;
        }
        continue;
      default:
        if (!e.selfClosing) p.skipElement();
        continue;
    }
  }

  // tblGrid 缺失（第三方生成的 docx 常见）时用第 0 行的 tcW 兜底，好过没有列宽
  const widths = grid?.length ? grid : ctx.firstRowWidths.filter((w) => w > 0);

  const table: Table = { kind: 'table', rows, id: `t${env.tableCount}` };
  if (widths.length) table.widths = widths;
  if (border) table.border = border;
  if (widthPt !== undefined) table.width = widthPt;
  // w:tblW type="pct" 的单位是「1/50 百分比」（5000 = 100%）；页面尺寸要到正文末尾的
  // sectPr 才知道，所以先记下引用，等正文解析完再回填（见 reader.ts）
  if (widthPt === undefined && tblWType === 'pct' && Number.isFinite(tblWVal)) {
    env.pctWidthTables.push({ table, pct: tblWVal });
  }
  out.push(table);
}

/** 正文解析完之后回填百分比宽度（此时 env.page 已经是最终值）。 */
export function resolvePctTableWidths(env: DocxEnv): void {
  if (!env.pctWidthTables.length) return;
  const content = contentWidthPt(env);
  if (!content) return;
  for (const item of env.pctWidthTables) item.table.width = (content * item.pct) / 5000;
}

function contentWidthPt(env: DocxEnv): number | undefined {
  const total = env.page.widthPt;
  if (!total) return undefined;
  const left = env.page.margin?.left ?? 0;
  const right = env.page.margin?.right ?? 0;
  const w = total - left - right;
  return w > 0 ? w : undefined;
}

function readTblGrid(p: XmlPullParser): number[] {
  const cols: number[] = [];
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local !== 'gridCol') continue;
    const w = attrNum(e, 'w', NaN);
    cols.push(Number.isFinite(w) && w > 0 ? twipToPt(w) : 0);
  }
  return cols;
}

function readTblPr(p: XmlPullParser): { border?: BorderStyle; width?: number; wType?: string; wVal: number } {
  const out: { border?: BorderStyle; width?: number; wType?: string; wVal: number } = { wVal: NaN };
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local === 'tblBorders') {
      if (!e.selfClosing) out.border = readBorders(p);
      continue;
    }
    if (e.local === 'tblW') {
      const w = attrNum(e, 'w', NaN);
      const type = attr(e, 'type') ?? 'dxa';
      out.wType = type;
      out.wVal = w;
      if (type === 'dxa' && Number.isFinite(w)) out.width = twipToPt(w);
      continue;
    }
    if (!e.selfClosing) p.skipElement();
  }
  return out;
}

async function parseTableRow(p: XmlPullParser, env: DocxEnv, ctx: TableCtx): Promise<TableRow> {
  const cells: TableCell[] = [];
  const row: TableRow = { cells };
  // 本行已经给哪些起点格加过 rowSpan：跨列的合并格会被查到多次，只能加一次
  const incremented = new Set<TableCell>();
  let col = 0;

  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) return row;
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local === 'trPr') {
      if (!e.selfClosing) readTrPr(p, row, (n) => (col += n));
      continue;
    }
    if (e.local !== 'tc') {
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    if (e.selfClosing) {
      cells.push({ blocks: [] });
      col += 1;
      continue;
    }

    const info = await parseTableCell(p, env, ctx);
    const cell = info.cell;
    const span = info.gridSpan && info.gridSpan > 0 ? info.gridSpan : 1;
    if (span > 1) cell.colSpan = span;

    if (info.vMerge === 'continue') {
      // 延续格：标 merged 让渲染器跳过，并把上方的起点格 rowSpan 加一
      cell.merged = true;
      for (let c = col; c < col + span; c++) {
        const origin = ctx.vmerge.get(c);
        if (origin && !incremented.has(origin)) {
          incremented.add(origin);
          origin.rowSpan = (origin.rowSpan ?? 1) + 1;
        }
      }
    } else {
      // 普通格会「打断」该列的纵向合并，必须清掉陈旧的起点，否则后面的
      // vMerge=continue 会错误地挂到很早以前的格子上
      for (let c = col; c < col + span; c++) ctx.vmerge.delete(c);
      if (info.vMerge === 'restart') {
        for (let c = col; c < col + span; c++) ctx.vmerge.set(c, cell);
      }
    }

    if (info.hMerge === 'continue') cell.merged = true; // 旧式横向合并
    if (ctx.rowIndex === 0 && info.widthTwip !== undefined) ctx.firstRowWidths.push(twipToPt(info.widthTwip));
    cells.push(cell);
    col += span;
  }
  return row;
}

function readTrPr(p: XmlPullParser, row: TableRow, skipCols: (n: number) => void): void {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local === 'tblHeader') row.header = true;
    else if (e.local === 'trHeight') {
      const v = attrNum(e, 'val', NaN);
      if (Number.isFinite(v) && v > 0) row.height = twipToPt(v);
    } else if (e.local === 'gridBefore') {
      // 行首「跳过 N 列」：不改 col 的话后面所有格都会错位
      const v = attrNum(e, 'val', NaN);
      if (Number.isFinite(v) && v > 0) skipCols(v);
    }
    if (!e.selfClosing) p.skipElement();
  }
}

interface CellInfo {
  cell: TableCell;
  gridSpan?: number;
  vMerge?: 'restart' | 'continue';
  hMerge?: string;
  widthTwip?: number;
}

async function parseTableCell(p: XmlPullParser, env: DocxEnv, ctx: TableCtx): Promise<CellInfo> {
  env.cellCount++;
  const cell: TableCell = { blocks: [] };
  const info: CellInfo = { cell };

  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) return info;
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'tcPr':
        if (!e.selfClosing) readTcPr(p, cell, info);
        continue;
      case 'p':
        if (!env.guard.probe('maxBlocks', 1)) {
          env.stopped = true;
          return info;
        }
        if (e.selfClosing) cell.blocks.push({ kind: 'para', runs: [], id: `b${cell.blocks.length}` });
        else await parseParagraph(p, env, cell.blocks);
        continue;
      case 'tbl':
        // 段内嵌套表格：直接递归，单元格的 blocks 本身就能装表格
        if (!e.selfClosing) await parseTable(p, env, cell.blocks);
        continue;
      case 'sdt':
      case 'sdtContent':
      case 'ins':
      case 'customXml':
      case 'smartTag':
      case 'txbxContent':
        // 这些包装元素内部仍然是块序列，交给块解析器
        if (!e.selfClosing) await parseBlockList(p, env, cell.blocks);
        continue;
      case 'del':
      case 'moveFrom':
        warnOnce(env, 'revision-del', '文档含修订删除（w:del），已丢弃删除内容（只保留最终稿）');
        if (!e.selfClosing) p.skipElement();
        continue;
      default:
        if (!e.selfClosing) p.skipElement();
        continue;
    }
  }
  // 空单元格在 Word 里合法（但通常至少有一个空 w:p）：没有块时补一个空段落，
  // 否则渲染器会把它画成 0 高度的塌陷格
  if (!cell.blocks.length) cell.blocks.push({ kind: 'para', runs: [], id: 'b0' });
  return info;
}

function readTcPr(p: XmlPullParser, cell: TableCell, info: CellInfo): void {
  const pads: number[] = [];
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'gridSpan': {
        const v = attrNum(e, 'val', NaN);
        if (Number.isFinite(v) && v > 1) info.gridSpan = v;
        break;
      }
      case 'vMerge': {
        // 注意：没有 w:val 的 <w:vMerge/> 表示「延续」，这是规范里最反直觉的一处
        const v = attr(e, 'val');
        info.vMerge = v === 'restart' ? 'restart' : 'continue';
        break;
      }
      case 'hMerge':
        info.hMerge = attr(e, 'val') ?? 'continue';
        break;
      case 'shd': {
        const c = parseColor(attr(e, 'fill'));
        if (c) cell.shading = c;
        break;
      }
      case 'vAlign': {
        const v = attr(e, 'val');
        if (v === 'center' || v === 'top' || v === 'bottom') cell.vAlign = v;
        break;
      }
      case 'tcW': {
        const v = attrNum(e, 'w', NaN);
        if (Number.isFinite(v) && v > 0) {
          info.widthTwip = v;
          // type="pct" 时 w 是 1/50 百分比而不是 twip；UDM 逐格宽度无槽位，
          // 只用它兜底列宽，因此这里仅接受 dxa
          if ((attr(e, 'type') ?? 'dxa') !== 'dxa') info.widthTwip = undefined;
        }
        break;
      }
      case 'tcBorders':
        if (!e.selfClosing) {
          const b = readBorders(p);
          if (b) cell.border = b;
        }
        continue; // 子树已被 readBorders 消费，绝不能落到末尾的 skipElement（会吞掉兄弟元素）
      case 'tcMar':
        if (!e.selfClosing) readTcMar(p, pads);
        continue; // 同上
      default:
        break;
    }
    if (!e.selfClosing) p.skipElement();
  }
  // UDM 的 padding 是单值：取四边最大值，宁可留白多一点也不要贴边
  if (pads.length) cell.padding = Math.max(...pads);
}

function readTcMar(p: XmlPullParser, pads: number[]): void {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local === 'top' || e.local === 'left' || e.local === 'bottom' || e.local === 'right' || e.local === 'start' || e.local === 'end') {
      const v = attrNum(e, 'w', NaN);
      if (Number.isFinite(v) && v > 0) pads.push(twipToPt(v));
    }
    if (!e.selfClosing) p.skipElement();
  }
}

/* ==================================================================== */
/* 脚注 / 尾注 / 页眉 / 页脚                                              */
/* ==================================================================== */

/**
 * 解析 footnotes.xml / endnotes.xml：id -> 该注的块序列。
 * 语义上这些内容不属于正文，reader.ts 会把它们追加到文档末尾并记一条 warning
 * （宁可放在末尾让用户看得到，也不要静默丢弃）。
 */
export async function parseNotesPart(
  xml: string,
  env: DocxEnv,
  rootLocal: 'footnotes' | 'endnotes',
): Promise<Map<string, Block[]>> {
  const out = new Map<string, Block[]>();
  const p = new XmlPullParser(xml, { keepWhitespace: true });
  let inRoot = false;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) break;
    if (e.type === 'start' && e.local === rootLocal) {
      inRoot = true;
      if (e.selfClosing) break;
      continue;
    }
    if (!inRoot) continue;
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local !== 'footnote' && e.local !== 'endnote') {
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    const id = attr(e, 'id');
    if (e.selfClosing) continue;
    const blocks: Block[] = [];
    await parseBlockList(p, env, blocks);
    // id <= 0 是「分隔符/延续分隔符」这两个特殊条目，不是真正的注释
    if (id !== undefined && Number.parseInt(id, 10) > 0) out.set(id, blocks);
  }
  return out;
}

/** 把块序列压成一行文本（页眉/页脚只需要文字）。 */
export function blocksText(blocks: readonly Block[]): string {
  return blocksToText(blocks, ' ').replace(/\s+/g, ' ').trim();
}
