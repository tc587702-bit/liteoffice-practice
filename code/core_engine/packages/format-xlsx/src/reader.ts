/**
 * format-xlsx —— Excel OOXML 读取器（xlsx / xlsm / xltx）。
 *
 * 读取顺序（每一步都允许降级，绝不因为缺一个部件而整篇打不开）：
 *   1. 定位 workbook 部件：优先规范路径 `xl/workbook.xml`，否则从包关系
 *      `_rels/.rels` 的 officeDocument 关系解析，再否则在包里按名字找。
 *   2. 解析 `<sheets>` 与 `<workbookPr date1904>`。
 *   3. **通过 `xl/_rels/workbook.xml.rels` 的 r:id 求出每个工作表的真实路径**。
 *      绝不硬编码 `xl/worksheets/sheet1.xml` —— 第三方工具会把工作表放在别的目录，
 *      甚至只写 `sheet.xml`；关系缺失或 id 对不上时降级为按文件名排序，
 *      并把这件事写进 warnings。
 *   4. 共享字符串、样式表各只读一次，之后被所有工作表复用（这是省内存的关键之一）。
 *   5. 逐表解析（小表物化、大表惰性，见 worksheet.ts）。
 */
import { createDocument } from '../../core/src/index.ts';
import { ReadError } from '../../core/src/registry.ts';
import type { ContainerAccess, FormatReader, ReadContext } from '../../core/src/registry.ts';
import { estimateBytes } from '../../core/src/memory.ts';
import { extensionOf, formatSpec } from '../../core/src/formats.ts';
import type { DocMeta, FormatId, LiteDocument, OutlineItem, Sheet } from '../../core/src/model.ts';
import { XmlPullParser } from '../../xml/src/index.ts';
import { attr, attrBool, readTextContent } from '../../ooxml/src/xmlUtil.ts';
import { findRelByType, parseRels, relsPathFor } from '../../ooxml/src/package.ts';
import type { Relationship } from '../../ooxml/src/package.ts';
import { loadSharedStrings, emptySharedStrings } from './sharedStrings.ts';
import type { SharedStrings } from './sharedStrings.ts';
import { EMPTY_STYLE_TABLE, parseStyles } from './styles.ts';
import type { StyleTable } from './styles.ts';
import { attachSheet, parseWorksheet } from './worksheet.ts';
import { MaterializedGrid } from '../../core/src/grid.ts';

/**
 * 降级说明与截断记录的收集口（去重 + 上限，避免畸形文件把内存吃在警告上）。
 *
 * 注意：这两个方法会被**当作回调传出去**（`warn: sink.warn`），所以必须用箭头函数
 * 绑住 this。早期版本写成普通方法，结果一旦真的产生一条警告就抛
 * 「Cannot read properties of undefined」—— 而「没有警告」的正常文件完全掩盖了它，
 * 只有真正需要降级的文件才会崩。这正是真实文件交叉验证的价值。
 */
class StatSink {
  warnings: string[] = [];
  truncated: string[] = [];

  warn = (msg: string): void => {
    if (this.warnings.length >= 200) return;
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  };

  truncate = (what: string): void => {
    if (!this.truncated.includes(what)) this.truncated.push(what);
  };
}

interface SheetEntry {
  name: string;
  relId: string;
  hidden: boolean;
  /** 解析后的真实部件路径；空串表示关系没对上，需要走降级路径 */
  path: string;
}

interface WorkbookInfo {
  sheets: SheetEntry[];
  date1904: boolean;
}

const XLSX_LABELS: Record<string, string> = {
  xlsx: 'Excel 工作簿',
  xlsm: 'Excel 工作簿（含宏）',
  xltx: 'Excel 模板',
};

function labelFor(id: FormatId): string {
  const spec = formatSpec(id);
  return spec.id === 'unknown' ? (XLSX_LABELS[id] ?? 'Excel 工作簿') : spec.label;
}

/** 按扩展名 + 是否含宏判定 FormatId。xltx 在 core 的格式表里没有独立条目，这里保留它。 */
function detectFormat(name: string, hasMacro: boolean): FormatId {
  const ext = extensionOf(name);
  if (ext === 'xltx' || ext === 'xltm') return ext === 'xltm' ? 'xlsm' : 'xltx';
  if (ext === 'xlsm' || ext === 'xlsx') return ext === 'xlsm' || hasMacro ? 'xlsm' : 'xlsx';
  return hasMacro ? 'xlsm' : 'xlsx';
}

/* ==================================================================== */
/* 部件定位                                                              */
/* ==================================================================== */

function findPartByName(container: ContainerAccess, basename: string): string | undefined {
  const lower = basename.toLowerCase();
  let best: string | undefined;
  for (const n of container.entryNames) {
    if (n.endsWith('/')) continue;
    const slash = n.lastIndexOf('/');
    const base = (slash < 0 ? n : n.slice(slash + 1)).toLowerCase();
    if (base !== lower) continue;
    // 多个同名件时取路径最短的（通常在 xl/ 下），保证结果稳定
    if (best === undefined || n.length < best.length) best = n;
  }
  return best;
}

async function locateWorkbook(container: ContainerAccess, sink: StatSink): Promise<string> {
  if (container.has('xl/workbook.xml')) return 'xl/workbook.xml';

  if (container.has('_rels/.rels')) {
    const rels = parseRels(await container.text('_rels/.rels'), '');
    const officeDoc = findRelByType(rels, 'officeDocument');
    if (officeDoc && container.has(officeDoc.target)) {
      sink.warn(`主工作簿不在规范路径，通过包关系解析为 ${officeDoc.target}`);
      return officeDoc.target;
    }
  }

  const found = findPartByName(container, 'workbook.xml');
  if (found) {
    sink.warn(`未找到 xl/workbook.xml，改按文件名定位到 ${found}`);
    return found;
  }
  return '';
}

/** 降级用：列出包里所有工作表部件，按名字里的数字排序。 */
function fallbackWorksheets(container: ContainerAccess): string[] {
  const list: string[] = [];
  for (const n of container.entryNames) {
    if (n.endsWith('/')) continue;
    if (!/(^|\/)worksheets\/[^/]*\.xml$/i.test(n)) continue;
    list.push(n);
  }
  const numOf = (p: string): number => {
    const m = /(\d+)(?=\.xml$)/.exec(p);
    return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  return list.sort((a, b) => numOf(a) - numOf(b) || a.localeCompare(b));
}

/* ==================================================================== */
/* workbook.xml                                                         */
/* ==================================================================== */

function parseWorkbook(xml: string, sink: StatSink): WorkbookInfo {
  const sheets: SheetEntry[] = [];
  const p = new XmlPullParser(xml);
  let date1904 = false;

  for (;;) {
    const e = p.next();
    if (e === null) break;
    if (e.type !== 'start') continue;
    if (e.local === 'workbookPr') {
      // 1904 日期系统：Mac 老文件用，序列号基准不同（0 = 1904-01-01，没有闰年 bug）
      if (attrBool(e, 'date1904', false)) date1904 = true;
      continue;
    }
    if (e.local !== 'sheet') continue;
    const name = attr(e, 'name') ?? `Sheet${sheets.length + 1}`;
    // attr() 会回退到本地名匹配，因此 r:id 也能用 'id' 取到
    const relId = attr(e, 'id') ?? '';
    const state = (attr(e, 'state') ?? '').toLowerCase();
    sheets.push({ name, relId, hidden: state === 'hidden' || state === 'veryhidden', path: '' });
  }

  if (sheets.length === 0) sink.warn('workbook.xml 中没有 <sheet> 定义');
  return { sheets, date1904 };
}

/** 给每个工作表求出真实部件路径；关系缺失/对不上时降级为按文件名顺序。 */
function resolveSheetPaths(entries: SheetEntry[], rels: Map<string, Relationship>, container: ContainerAccess, sink: StatSink): SheetEntry[] {
  const out: SheetEntry[] = [];
  const needsFallback: SheetEntry[] = [];

  for (const e of entries) {
    const rel = e.relId ? rels.get(e.relId) : undefined;
    if (rel && rel.shortType === 'worksheet' && container.has(rel.target)) {
      out.push({ ...e, path: rel.target });
    } else {
      if (rel && rel.shortType !== 'worksheet') {
        sink.warn(`关系 ${e.relId} 的类型是 ${rel.shortType} 而不是 worksheet，已忽略`);
      }
      needsFallback.push({ ...e, path: '' });
    }
  }

  if (needsFallback.length === 0) return out;

  const pool = fallbackWorksheets(container);
  sink.warn(`有 ${needsFallback.length} 张工作表的关系缺失或对不上，改按 xl/worksheets/*.xml 文件名顺序匹配`);
  for (let i = 0; i < needsFallback.length; i++) {
    const e = needsFallback[i];
    const guess = pool[i];
    if (guess) out.push({ ...e, path: guess });
    else sink.warn(`工作表「${e.name}」找不到对应的 XML 部件，已跳过`);
  }
  return out;
}

/* ==================================================================== */
/* docProps                                                             */
/* ==================================================================== */

const CORE_PROPS: Record<string, keyof DocMeta> = {
  title: 'title',
  subject: 'subject',
  creator: 'author',
  lastModifiedBy: 'lastModifiedBy',
  created: 'created',
  modified: 'modified',
  keywords: 'keywords',
  description: 'description',
  category: 'category',
};

const APP_PROPS: Record<string, keyof DocMeta> = {
  Application: 'application',
  AppVersion: 'appVersion',
  Company: 'company',
  Manager: 'manager',
};

function readProps(xml: string, map: Record<string, keyof DocMeta>, meta: DocMeta): void {
  const p = new XmlPullParser(xml);
  for (;;) {
    const e = p.next();
    if (e === null) break;
    if (e.type !== 'start') continue;
    const key = map[e.name] ?? map[e.local];
    if (!key) continue;
    const text = e.selfClosing ? '' : readTextContent(p).trim();
    if (text) (meta as Record<string, unknown>)[key] = text;
  }
}

async function readDocProps(container: ContainerAccess, sink: StatSink): Promise<DocMeta> {
  const meta: DocMeta = {};
  const core = container.has('docProps/core.xml') ? 'docProps/core.xml' : findPartByName(container, 'core.xml');
  if (core) {
    try {
      readProps(await container.text(core), CORE_PROPS, meta);
    } catch {
      sink.warn('docProps/core.xml 解析失败，已忽略文档属性');
    }
  }
  const app = container.has('docProps/app.xml') ? 'docProps/app.xml' : findPartByName(container, 'app.xml');
  if (app) {
    try {
      readProps(await container.text(app), APP_PROPS, meta);
    } catch {
      sink.warn('docProps/app.xml 解析失败，已忽略应用属性');
    }
  }
  return meta;
}

/* ==================================================================== */
/* 读取器                                                               */
/* ==================================================================== */

export const xlsxReader: FormatReader = {
  id: 'format-xlsx',
  formats: ['xlsx', 'xlsm', 'xltx'],

  async read(ctx: ReadContext): Promise<LiteDocument> {
    const t0 = Date.now();
    const sink = new StatSink();
    // 容器只打开一次并复用（ReadContext 的契约）
    const container = await ctx.container?.();
    if (!container) throw new ReadError('xlsx 需要 ZIP 容器，但容器不可用', 'CORRUPT', 'xlsx');

    const hasMacro = container.has('xl/vbaProject.bin');
    const format = detectFormat(ctx.name, hasMacro);
    if (hasMacro) sink.warn('该工作簿含 VBA 宏（xl/vbaProject.bin），宏内容不会被读取');

    // ---- 1. workbook ----
    const workbookPath = await locateWorkbook(container, sink);
    let info: WorkbookInfo = { sheets: [], date1904: false };
    const wbTooBig = workbookPath !== '' && container.entrySize(workbookPath) > ctx.limits.maxPartBytes;
    if (workbookPath && !wbTooBig) {
      try {
        info = parseWorkbook(await container.text(workbookPath), sink);
      } catch {
        sink.warn('workbook.xml 解析失败，改按 xl/worksheets/*.xml 顺序解析');
      }
    } else if (wbTooBig) {
      sink.warn('workbook.xml 超过单部件上限，改按 xl/worksheets/*.xml 顺序解析');
      sink.truncate('workbook');
    }

    // ---- 2. 关系 -> 工作表真实路径 ----
    let rels = new Map<string, Relationship>();
    if (workbookPath) {
      const relsPath = relsPathFor(workbookPath);
      if (container.has(relsPath)) {
        try {
          rels = parseRels(await container.text(relsPath), workbookPath);
        } catch {
          sink.warn('xl/_rels/workbook.xml.rels 解析失败，改按文件名顺序解析工作表');
        }
      } else {
        sink.warn('缺少 xl/_rels/workbook.xml.rels，改按 xl/worksheets/*.xml 文件名顺序解析');
      }
    }

    let entries = info.sheets;
    if (entries.length === 0) {
      // workbook.xml 缺失或没有 <sheet>：直接用兜底清单，至少让内容能被看到
      entries = fallbackWorksheets(container).map((path, i) => ({
        name: `Sheet${i + 1}`,
        relId: '',
        hidden: false,
        path,
      }));
      if (entries.length) sink.warn('未解析到工作表定义，已按 xl/worksheets/*.xml 顺序打开');
    }
    const resolved = resolveSheetPaths(entries, rels, container, sink);

    if (resolved.length === 0) {
      throw new ReadError('不是有效的 xlsx：既没有 workbook.xml，也没有任何 worksheet 部件', 'CORRUPT', format);
    }

    // ---- 3. 共享字符串（只读一次，所有表复用）----
    let sst: SharedStrings = emptySharedStrings();
    const sstRel = findRelByType(rels, 'sharedStrings');
    const sstPath = sstRel && container.has(sstRel.target) ? sstRel.target : findPartByName(container, 'sharedStrings.xml');
    if (sstPath) {
      try {
        sst = await ctx.phase('sharedStrings', () =>
          loadSharedStrings(() => container.streamText(sstPath), ctx.limits.maxStringBytes, sink.warn),
        );
        if (sst.truncated) sink.truncate('sharedStrings');
      } catch {
        sink.warn('sharedStrings.xml 读取失败，字符串单元格将为空');
        sink.truncate('sharedStrings');
      }
    } else {
      sink.warn('包里没有 sharedStrings.xml，引用共享字符串的单元格将为空');
    }

    // ---- 4. 样式表（只读一次）----
    let styleTable: StyleTable = EMPTY_STYLE_TABLE;
    const stylesRel = findRelByType(rels, 'styles');
    const stylesPath = stylesRel && container.has(stylesRel.target) ? stylesRel.target : findPartByName(container, 'styles.xml');
    if (stylesPath) {
      try {
        if (container.entrySize(stylesPath) > ctx.limits.maxPartBytes) {
          sink.warn('styles.xml 超过单部件上限，已忽略样式');
          sink.truncate('styles');
        } else {
          styleTable = parseStyles(await container.text(stylesPath), sink.warn);
        }
      } catch {
        sink.warn('styles.xml 解析失败，已忽略全部样式');
      }
    }

    // ---- 5. 逐表解析 ----
    const sheets: Sheet[] = [];
    /** 物化路径下逐格统计出的**精确**单元格数 */
    let cellCount = 0;
    /** 惰性表的区域上界估算（rowCount×colCount） */
    let estimatedCells = 0;
    let lazySheets = 0;
    let materializedBytes = 0;

    await ctx.phase('worksheets', async () => {
      for (const entry of resolved) {
        try {
          const parsed = await parseWorksheet({
            open: () => container.streamText(entry.path),
            limits: ctx.limits,
            guard: ctx.guard,
            sst,
            styles: styleTable,
            date1904: info.date1904,
            warn: sink.warn,
            truncate: sink.truncate,
            signal: ctx.signal,
          });
          cellCount += parsed.cells;
          estimatedCells += parsed.estimatedCells;
          if (parsed.usedLazy) lazySheets++;
          materializedBytes += parsed.modelBytes;
          sheets.push(
            attachSheet(parsed.grid, {
              name: entry.name,
              hidden: entry.hidden || undefined,
              styles: styleTable.styles,
              colWidths: parsed.meta.colWidths,
              rowHeights: parsed.meta.rowHeights,
              defaultColWidth: parsed.meta.defaultColWidth,
              defaultRowHeight: parsed.meta.defaultRowHeight,
              merges: parsed.meta.merges,
              freeze: parsed.meta.freeze,
              autoFilter: parsed.meta.autoFilter,
              truncated: parsed.meta.truncated || undefined,
            }),
          );
        } catch (err) {
          // 单张表读坏了不该让整个工作簿打不开：给一张空表占位并记录。
          // 附上底层信息（截断到 120 字符）—— 否则用户只会看到「空表」，无从判断原因。
          const detail = err instanceof Error ? err.message : String(err);
          sink.warn(`工作表「${entry.name}」解析失败，已用空表占位（${detail.slice(0, 120)}）`);
          sheets.push(
            attachSheet(new MaterializedGrid([], 0, 0), {
              name: entry.name,
              hidden: entry.hidden || undefined,
              styles: styleTable.styles,
              defaultColWidth: 48,
              defaultRowHeight: 15,
            }),
          );
        }
      }
    });

    // 惰性表没被逐格统计，但统计字段绝不能是 0 —— UI 会显示「0 单元格」，
    // 那是在撒谎。用 <dimension> 的区域上界并明确标注是估算。
    if (lazySheets > 0) {
      sink.warn(`${lazySheets} 张工作表走惰性路径（未物化表体）：cellCount 含按 dimension 区域推算的上界估算，非逐格精确值`);
    }

    // ---- 6. 元数据与统计 ----
    const props = await readDocProps(container, sink);
    const docMeta: DocMeta = { ...props, sheetCount: sheets.length };

    const outline: OutlineItem[] = sheets.map((s, i) => ({
      level: 1,
      text: s.name,
      target: { kind: 'sheet', index: i },
    }));

    /*
     * modelBytes 的诚实性说明：
     * 惰性表**不物化行**，所以它的 modelBytes 不是「算不出来」而是「真的没有表体」——
     * 常驻的只有样式表、列宽、合并区与行列数。这里把已物化小表的行（materializedBytes）
     * 与各表的常驻结构加起来，得到的就是「打开这个工作簿实际占住的内存」。
     * 表体字节要等到 readRows() 取窗口时才出现，而且只有窗口那一小段。
     */
    const modelBytes =
      materializedBytes +
      estimateBytes({
        meta: docMeta,
        sheets: sheets.map((s) => ({
          name: s.name,
          rowCount: s.rowCount,
          colCount: s.colCount,
          styles: s.styles,
          colWidths: s.colWidths,
          merges: s.merges,
          freeze: s.freeze,
          autoFilter: s.autoFilter,
          hidden: s.hidden,
        })),
      });

    const stats = {
      parseMs: Date.now() - t0,
      modelBytes,
      sourceBytes: ctx.size,
      // 表格类文档里「块」对应工作表
      blockCount: sheets.length,
      // 精确值 + 惰性表的区域上界估算（见上面的 warning 说明）
      cellCount: cellCount + estimatedCells,
      shapeCount: 0,
      imageCount: 0,
      imageBytes: 0,
      warnings: dedupe([...sink.warnings, ...ctx.guard.warnings]),
      truncated: dedupe([...sink.truncated, ...ctx.guard.truncated]),
    };

    return createDocument({
      kind: 'sheet',
      format,
      formatLabel: labelFor(format),
      name: ctx.name,
      meta: docMeta,
      outline,
      stats,
      sheets,
    });
  },
};

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)];
}
