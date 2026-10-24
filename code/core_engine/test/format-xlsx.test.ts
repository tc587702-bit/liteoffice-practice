/**
 * @liteoffice/format-xlsx 验证。
 *
 * 三层证据，缺一不可：
 *   1. **自造夹具**：ECMA-376 结构的合法 xlsx，逐特性精确断言
 *      （共享字符串索引、稀疏行、A1 引用、样式共享、日期序列号…）。
 *   2. **跨块边界**：每行的 XML 是分块喂进来的，用 chunkSize=1/2/3… 把
 *      `<row`、属性、`<c>` 全部切在最坏位置，断言结果与整串解析逐字节一致。
 *      这是最容易写错、也最难靠肉眼发现的地方。
 *   3. **真实文件 + 大表实测**：真实 WPS 生成的文件验证规范理解没跑偏；
 *      5 万行 × 20 列的大表打印实测内存与耗时，证明「不物化整表」不是一句注释。
 *
 * 大表夹具生成说明：生成时必须把 sheetData 按行分块拼接（不能一行一行 `+=`），
 * 否则光是生成过程就会产生几倍的中间字符串。测量只统计**解析**阶段，
 * 夹具字节与生成临时对象都在测量窗口之外。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { ZipReader, ZipWriter } from '../packages/zip/src/index.ts';
import {
  LazyGrid,
  LimitGuard,
  MaterializedGrid,
  estimateBytes,
  excelColWidthToPt,
  formatBytes,
  forceGc,
  measure,
  memSnapshot,
  withLimits,
} from '../packages/core/src/index.ts';
import type { Cell, CellRow, Limits, Sheet } from '../packages/core/src/index.ts';
import type { ReadContext } from '../packages/core/src/registry.ts';
import { openDocument } from '../packages/engine/src/index.ts';

import {
  StreamXmlScanner,
  chunkedStream,
  colIndexOfLetters,
  emptySharedStrings,
  formatExcelSerial,
  isDateFormat,
  lettersOfColIndex,
  loadSharedStrings,
  parseCellRef,
  parseRangeRef,
  parseStyles,
  scanSheet,
  serialToParts,
  stripFormatLiterals,
  xlsxReader,
} from '../packages/format-xlsx/src/index.ts';
import type { ScanOptions } from '../packages/format-xlsx/src/index.ts';

/* ==================================================================== */
/* 夹具构造                                                              */
/* ==================================================================== */

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

async function zipBytes(entries: Record<string, string>, first = '[Content_Types].xml'): Promise<Uint8Array> {
  const w = new ZipWriter();
  if (first && entries[first] !== undefined) w.addFirst(first, entries[first]);
  for (const [k, v] of Object.entries(entries)) if (k !== first) w.add(k, v);
  return w.build();
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG}">
<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

function workbookXml(sheets: Array<{ name: string; rid: string; hidden?: boolean }>, attrs = ''): string {
  const items = sheets
    .map((s) => `<sheet name="${s.name}" sheetId="${s.rid.replace(/\D/g, '') || 1}"${s.hidden ? ' state="hidden"' : ''} r:id="${s.rid}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS}" xmlns:r="${NS_R}"><workbookPr${attrs}/><sheets>${items}</sheets></workbook>`;
}

function workbookRels(rels: Array<{ rid: string; type: string; target: string }>): string {
  const items = rels
    .map((r) => `<Relationship Id="${r.rid}" Type="${NS_R}/${r.type}" Target="${r.target}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG}">${items}</Relationships>`;
}

/** 默认关系：1 张表 + 共享字符串 + 样式 */
function defaultRels(sheetTargets: string[] = ['worksheets/sheet1.xml']): string {
  const rels = sheetTargets.map((t, i) => ({ rid: `rId${i + 1}`, type: 'worksheet', target: t }));
  rels.push({ rid: `rId${sheetTargets.length + 1}`, type: 'sharedStrings', target: 'sharedStrings.xml' });
  rels.push({ rid: `rId${sheetTargets.length + 2}`, type: 'styles', target: 'styles.xml' });
  return workbookRels(rels);
}

function sharedStringsXml(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${NS}" count="${items.length}" uniqueCount="${items.length}">${items.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`;
}

/**
 * 覆盖多种特性的样式表。
 * 刻意让 `<cellStyleXfs>` 出现在 `<cellXfs>` 之前：把两者的 `<xf>` 混在一起收集
 * 会让所有样式索引整体错位 —— 这是最隐蔽的一类错误（颜色都差一格）。
 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS}">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
<numFmt numFmtId="165" formatCode="0.00&quot;元&quot;"/>
<numFmt numFmtId="166" formatCode="[$-409]m/d/yy h:mm"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><i/><u/><strike/><sz val="14"/><color rgb="FFFF0000"/><name val="Arial"/></font>
<font><sz val="10.5"/><color theme="3"/><name val="宋体"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor indexed="10"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/></border>
<border><left style="thin"><color rgb="FF000000"/></left><bottom style="double"><color auto="1"/></bottom></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="165" fontId="2" fillId="3" borderId="0" xfId="0"><alignment horizontal="right" vertical="bottom"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0"/>
</cellXfs>
</styleSheet>`;

function sheetXml(body: string, head = ''): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS}" xmlns:r="${NS_R}">${head}<sheetData>${body}</sheetData></worksheet>`;
}

interface Harness {
  ctx: ReadContext;
  guard: LimitGuard;
  container: ZipReader;
  /** container() 被调用了几次 —— 契约要求只调用一次并复用 */
  containerCalls: () => number;
}

function makeCtx(bytes: Uint8Array, name = 'test.xlsx', overrides?: Partial<Limits>): Harness {
  const limits = withLimits(overrides);
  const guard = new LimitGuard(limits);
  const container = ZipReader.open(bytes, { maxEntryBytes: limits.maxEntryBytes });
  let calls = 0;
  const ctx: ReadContext = {
    name,
    size: bytes.length,
    bytes: async () => bytes,
    container: async () => {
      calls++;
      return container;
    },
    limits,
    guard,
    phase: async (_n, fn) => fn(),
  };
  return { ctx, guard, container, containerCalls: () => calls };
}

async function readXlsx(
  entries: Record<string, string>,
  opts: { name?: string; limits?: Partial<Limits> } = {},
): Promise<{ doc: Awaited<ReturnType<typeof xlsxReader.read>>; harness: Harness; bytes: Uint8Array }> {
  const bytes = await zipBytes(entries);
  const harness = makeCtx(bytes, opts.name ?? 'test.xlsx', opts.limits);
  const doc = await xlsxReader.read(harness.ctx);
  return { doc, harness, bytes };
}

/** 一个「最小但合法」的工作簿：给定 sheetData 内容 */
function minimalParts(sheetBody: string, head = '', extra: Record<string, string> = {}, sst: string[] = []): Record<string, string> {
  return {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'xl/workbook.xml': workbookXml([{ name: 'Sheet1', rid: 'rId1' }]),
    'xl/_rels/workbook.xml.rels': defaultRels(),
    'xl/sharedStrings.xml': sharedStringsXml(sst),
    'xl/styles.xml': STYLES_XML,
    'xl/worksheets/sheet1.xml': sheetXml(sheetBody, head),
    ...extra,
  };
}

async function firstSheet(entries: Record<string, string>, limits?: Partial<Limits>): Promise<Sheet> {
  const { doc } = await readXlsx(entries, { limits });
  assert.ok(doc.sheets && doc.sheets.length > 0, '应至少解析出一张工作表');
  return doc.sheets[0];
}

async function cellAt(sheet: Sheet, r: number, c: number): Promise<Cell | undefined> {
  const rows = await sheet.readRows(r, r + 1);
  return rows[0]?.cells.find((x) => x.c === c);
}

function rowText(row: CellRow | undefined): string {
  return row ? row.cells.map((c) => `${c.c}:${c.v}`).join('|') : '(无)';
}

/* ==================================================================== */
/* 1. 基本结构与自注册                                                    */
/* ==================================================================== */

test('xlsx：工件扫描、表顺序、隐藏标记、meta.sheetCount', async () => {
  const entries = minimalParts('<row r="1"><c r="A1"><v>1</v></c></row>', '<dimension ref="A1:A1"/>', {
    'xl/workbook.xml': workbookXml([
      { name: '数据', rid: 'rId1' },
      { name: '草稿', rid: 'rId2', hidden: true },
    ]),
    'xl/_rels/workbook.xml.rels': defaultRels(['worksheets/sheet1.xml', 'worksheets/sheet2.xml']),
    'xl/worksheets/sheet2.xml': sheetXml('<row r="1"><c r="A1"><v>2</v></c></row>', '<dimension ref="A1:A1"/>'),
  });
  const { doc, harness } = await readXlsx(entries);

  assert.equal(doc.kind, 'sheet');
  assert.equal(doc.format, 'xlsx');
  assert.equal(doc.formatLabel, 'Excel 工作簿');
  assert.equal(doc.meta.sheetCount, 2);
  assert.equal(doc.sheets?.length, 2);
  assert.equal(doc.sheets?.[0].name, '数据');
  assert.equal(doc.sheets?.[1].name, '草稿');
  assert.equal(doc.sheets?.[1].hidden, true);
  assert.equal(doc.sheets?.[0].hidden, undefined);
  assert.deepEqual(doc.outline.map((o) => o.text), ['数据', '草稿']);
  assert.equal(doc.outline[0].target?.kind, 'sheet');
  assert.equal(doc.stats.cellCount, 2);
  assert.equal(doc.stats.blockCount, 2);
  assert.ok(doc.stats.parseMs >= 0);
  assert.ok(doc.stats.modelBytes > 0);
  assert.equal(doc.stats.warnings.length, 0, `不应有警告：${doc.stats.warnings.join('; ')}`);
  // 契约：容器只打开一次并复用
  assert.equal(harness.containerCalls(), 1);
});

test('自注册：engine.openDocument 能派发到本读取器', async () => {
  const parts = minimalParts('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', '<dimension ref="A1:A1"/>', {}, ['你好']);
  const bytes = await zipBytes(parts);
  const result = await openDocument({ name: '自注册.xlsx', bytes });
  assert.equal(result.sniff.format, 'xlsx');
  assert.equal(result.document.kind, 'sheet');
  assert.equal(result.document.sheets?.[0].name, 'Sheet1');
  assert.equal(await cellAt(result.document.sheets![0], 0, 0).then((c) => c?.v), '你好');
  assert.ok(result.document.stats.sourceBytes === bytes.length);
});

/* ==================================================================== */
/* 2. 共享字符串 / 内联字符串 / 富文本                                     */
/* ==================================================================== */

test('sharedStrings：纯文本、富文本片段拼接、注音跳过、空白保留、实体解码', async () => {
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${NS}" count="6" uniqueCount="6">
<si><t>纯文本</t></si>
<si><r><rPr><b/><sz val="14"/><color rgb="FF0000FF"/><rFont val="Arial"/></rPr><t>粗体</t></r><r><t>与普通</t></r></si>
<si><t xml:space="preserve"> </t></si>
<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>
<si><t>a&amp;b&lt;c</t></si>
<si><r><rPr><i/></rPr><t>斜体</t></r></si>
</sst>`;
  const body =
    '<row r="1">' +
    [0, 1, 2, 3, 4, 5].map((i) => `<c r="${String.fromCharCode(65 + i)}1" t="s"><v>${i}</v></c>`).join('') +
    '</row>';
  const sheet = await firstSheet(minimalParts(body, '<dimension ref="A1:F1"/>', { 'xl/sharedStrings.xml': sst }));

  assert.equal((await cellAt(sheet, 0, 0))?.v, '纯文本');
  assert.equal((await cellAt(sheet, 0, 0))?.rich, undefined, '纯文本不该分配 rich 数组');

  const rich = await cellAt(sheet, 0, 1);
  assert.equal(rich?.v, '粗体与普通');
  assert.equal(rich?.rich?.length, 2);
  assert.equal(rich?.rich?.[0].text, '粗体');
  assert.equal(rich?.rich?.[0].style?.bold, true);
  // xlsx 的 sz 单位就是 pt，不能被除以 2（Word 才是半磅）
  assert.equal(rich?.rich?.[0].style?.size, 14);
  assert.equal(rich?.rich?.[0].style?.color, '#0000ff', 'ARGB 的 FF alpha 前缀必须去掉');
  assert.equal(rich?.rich?.[0].style?.font, 'Arial');
  assert.equal(rich?.rich?.[1].text, '与普通');

  assert.equal((await cellAt(sheet, 0, 2))?.v, ' ', 'xml:space="preserve" 的空白字符串必须保留');
  assert.equal((await cellAt(sheet, 0, 3))?.v, '東京', '注音 rPh 里的 <t> 绝不能被拼进来');
  assert.equal((await cellAt(sheet, 0, 3))?.rich, undefined);
  assert.equal((await cellAt(sheet, 0, 4))?.v, 'a&b<c');

  const italic = await cellAt(sheet, 0, 5);
  assert.equal(italic?.v, '斜体');
  assert.equal(italic?.rich?.[0].style?.italic, true);
});

test('内联字符串 <is>：纯文本与富文本片段', async () => {
  const body =
    '<row r="1">' +
    '<c r="A1" t="inlineStr"><is><t>内联</t></is></c>' +
    '<c r="B1" t="inlineStr"><is><r><rPr><b/></rPr><t>粗</t></r><r><t>细</t></r></is></c>' +
    '<c r="C1" t="inlineStr"><is><t xml:space="preserve"> x </t></is></c>' +
    '<c r="D1" t="inlineStr"><is><t>东</t><rPh><t>dong</t></rPh></is></c>' +
    '</row>';
  const sheet = await firstSheet(minimalParts(body, '<dimension ref="A1:D1"/>'));

  assert.equal((await cellAt(sheet, 0, 0))?.v, '内联');
  assert.equal((await cellAt(sheet, 0, 0))?.t, 's');
  const b = await cellAt(sheet, 0, 1);
  assert.equal(b?.v, '粗细');
  assert.equal(b?.rich?.[0].style?.bold, true);
  assert.equal((await cellAt(sheet, 0, 2))?.v, ' x ');
  assert.equal((await cellAt(sheet, 0, 3))?.v, '东');
});

/* ==================================================================== */
/* 3. 公式与单元格类型                                                    */
/* ==================================================================== */

test('公式与结果值、布尔/错误/字符串/ISO 日期类型', async () => {
  const body =
    '<row r="1">' +
    '<c r="A1"><f>SUM(B1:B2)</f><v>3</v></c>' +
    '<c r="B1" t="str"><f>CONCAT("a","b")</f><v>ab</v></c>' +
    '<c r="C1" t="b"><v>0</v></c>' +
    '<c r="D1" t="b"><v>1</v></c>' +
    '<c r="E1" t="e"><v>#N/A</v></c>' +
    '<c r="F1" t="str"><f t="shared" si="0" ref="F1:F2"/></c>' +
    '<c r="G1"><f t="shared" si="0">B1*2</f><v>6</v></c>' +
    '<c r="H1" t="d"><v>2024-03-05T08:30:00Z</v></c>' +
    '<c r="I1"><f t="array" ref="I1:I3">SUM(A1:A3)</f><v>9</v></c>' +
    '</row>';
  const sheet = await firstSheet(minimalParts(body, '<dimension ref="A1:I1"/>'));

  const a1 = await cellAt(sheet, 0, 0);
  assert.equal(a1?.f, 'SUM(B1:B2)', '公式不带前导 =');
  assert.equal(a1?.v, '3');
  assert.equal(a1?.t, undefined, '数字是默认类型，不必写 t');

  const b1 = await cellAt(sheet, 0, 1);
  assert.equal(b1?.t, 'str');
  assert.equal(b1?.v, 'ab');
  assert.equal(b1?.f, 'CONCAT("a","b")');

  assert.equal((await cellAt(sheet, 0, 2))?.v, 'FALSE');
  assert.equal((await cellAt(sheet, 0, 2))?.t, 'b');
  assert.equal((await cellAt(sheet, 0, 3))?.v, 'TRUE');
  assert.equal((await cellAt(sheet, 0, 4))?.v, '#N/A');
  assert.equal((await cellAt(sheet, 0, 4))?.t, 'e');
  // 共享公式的从属格（没有公式文本也没有缓存值）在模型里就是空格
  assert.equal(await cellAt(sheet, 0, 5), undefined);
  assert.equal((await cellAt(sheet, 0, 6))?.f, 'B1*2');
  assert.equal((await cellAt(sheet, 0, 7))?.v, '2024-03-05 08:30:00');
  assert.equal((await cellAt(sheet, 0, 7))?.t, 'd');
  assert.equal((await cellAt(sheet, 0, 8))?.f, 'SUM(A1:A3)');
});

/* ==================================================================== */
/* 4. 单元格引用与稀疏行                                                  */
/* ==================================================================== */

test('A1 引用：双字母列 AA/AB/BA，缺 r 属性时按列顺延', async () => {
  assert.deepEqual(parseCellRef('A1'), { r: 0, c: 0 });
  assert.deepEqual(parseCellRef('$B$12'), { r: 11, c: 1 });
  assert.deepEqual(parseCellRef('AA10'), { r: 9, c: 26 });
  assert.deepEqual(parseCellRef('AB1'), { r: 0, c: 27 });
  assert.deepEqual(parseCellRef('BA1'), { r: 0, c: 52 });
  assert.deepEqual(parseCellRef('XFD1048576'), { r: 1048575, c: 16383 });
  assert.equal(parseCellRef('1A'), null);
  assert.equal(parseCellRef(''), null);
  assert.equal(colIndexOfLetters('A'), 0);
  assert.equal(colIndexOfLetters('Z'), 25);
  assert.equal(colIndexOfLetters('AA'), 26);
  assert.equal(colIndexOfLetters('AB'), 27);
  assert.equal(colIndexOfLetters('BA'), 52);
  assert.deepEqual(parseRangeRef('C3:A1'), { r1: 0, c1: 0, r2: 2, c2: 2 });
  assert.deepEqual(parseRangeRef('B5:D5'), { r1: 4, c1: 1, r2: 4, c2: 3 });

  const body =
    '<row r="1"><c r="A1"><v>1</v></c><c r="AA1"><v>2</v></c><c r="AB1"><v>3</v></c><c r="BA1"><v>4</v></c></row>' +
    '<row r="3"><c r="B3"><v>20</v></c><c><v>21</v></c></row>' + // 第二个 <c> 没有 r -> 应顺延到 C3
    '<row r="4"/>' +
    '<row r="5"><c r="E5" t="inlineStr"><is><t>末</t></is></c></row>';
  const sheet = await firstSheet(minimalParts(body, '<dimension ref="A1:BA5"/>'));

  const r0 = (await sheet.readRows(0, 1))[0];
  assert.deepEqual(r0.cells.map((c) => c.c), [0, 26, 27, 52], 'AA/AB/BA 必须解析成 26/27/52');
  assert.deepEqual(r0.cells.map((c) => c.v), ['1', '2', '3', '4']);

  const r2 = (await sheet.readRows(2, 3))[0];
  assert.deepEqual(r2.cells.map((c) => [c.c, c.v]), [[1, '20'], [2, '21']]);

  assert.deepEqual((await sheet.readRows(3, 4))[0].cells, [], '自闭合空行');
  assert.equal((await cellAt(sheet, 4, 4))?.v, '末');

  // 稀疏：行窗口里没有内容的行必须是「空行」而不是缺行
  const rows = await sheet.readRows(0, 5);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.r), [0, 1, 2, 3, 4]);
  assert.equal(sheet.colCount, 53);
  assert.equal(sheet.rowCount, 5);
});

/* ==================================================================== */
/* 5. 列宽 / 冻结 / 合并 / 自动筛选 / 行高                                 */
/* ==================================================================== */

test('列宽换算成 pt、隐藏列、冻结窗格、合并区域、自动筛选、行高', async () => {
  const head =
    '<dimension ref="A1:F20"/>' +
    '<sheetViews><sheetView tabSelected="1"><pane xSplit="2" ySplit="3" topLeftCell="C4" activePane="bottomRight" state="frozen"/><selection activeCell="C4"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15.5" defaultColWidth="8.43"/>' +
    '<cols><col min="2" max="3" width="20" customWidth="1"/><col min="4" max="4" width="10" hidden="1"/><col min="5" max="16379" width="9"/></cols>';
  const tail = '<mergeCells count="2"><mergeCell ref="A1:C3"/><mergeCell ref="B5:D5"/></mergeCells><autoFilter ref="A1:F20"/>';
  const sheet = await firstSheet(
    minimalParts('<row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row>', head + tail, {
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${NS}" xmlns:r="${NS_R}">${head}<sheetData><row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row></sheetData>${tail}</worksheet>`,
    }),
  );

  assert.deepEqual(sheet.freeze, { rows: 3, cols: 2 });
  assert.equal(sheet.defaultRowHeight, 15.5);
  assert.ok(Math.abs((sheet.defaultColWidth ?? 0) - excelColWidthToPt(8.43)) < 1e-9);

  // Excel 列宽是「字符数」，模型里必须是 pt
  assert.ok(Math.abs((sheet.colWidths?.[1] ?? 0) - excelColWidthToPt(20)) < 1e-9);
  assert.ok(Math.abs((sheet.colWidths?.[2] ?? 0) - excelColWidthToPt(20)) < 1e-9);
  assert.equal(sheet.colWidths?.[3], 0, 'hidden 列宽记为 0');
  // min=5 max=16379 的一行不能让数组涨到上万长度（dimension 只有 6 列）
  assert.ok((sheet.colWidths?.length ?? 0) <= 6, `列宽数组被裁剪到本表列数，实际 ${sheet.colWidths?.length}`);
  assert.equal(sheet.rowHeights?.get(0), 30);

  assert.deepEqual(sheet.merges, [
    { r1: 0, c1: 0, r2: 2, c2: 2 },
    { r1: 4, c1: 1, r2: 4, c2: 3 },
  ]);
  assert.deepEqual(sheet.autoFilter, { r1: 0, c1: 0, r2: 19, c2: 5 });
  assert.equal(sheet.truncated, undefined, '按本表列数裁剪列宽不算截断');
});

test('非冻结的 pane（state=split）不应被当成冻结窗格', async () => {
  const sheet = await firstSheet(
    minimalParts('<row r="1"><c r="A1"><v>1</v></c></row>', '<dimension ref="A1:A1"/><sheetViews><sheetView><pane xSplit="1" ySplit="1" state="split"/></sheetView></sheetViews>'),
  );
  assert.equal(sheet.freeze, undefined);
});

/* ==================================================================== */
/* 6. 样式表                                                              */
/* ==================================================================== */

test('styles：cellXfs 索引对齐（不与 cellStyleXfs 混）、字体/填充/边框/对齐、颜色三种写法', async () => {
  const table = parseStyles(STYLES_XML, () => {});
  assert.equal(table.styles.length, 7, 'cellStyleXfs 里的 <xf> 不能混进单元格格式表');

  // 1 号样式：粗斜下划线删除线 + 14pt + ARGB 红字 + 实心绿底 + 左细下双线边框 + 居中/顶对齐/自动换行
  const s1 = table.styles[1];
  assert.equal(s1.bold, true);
  assert.equal(s1.italic, true);
  assert.equal(s1.underline, true);
  assert.equal(s1.strike, true);
  assert.equal(s1.size, 14, 'xlsx 的 sz 就是 pt，不能除 2');
  assert.equal(s1.color, '#ff0000');
  assert.equal(s1.font, 'Arial');
  assert.equal(s1.bg, '#00ff00');
  assert.equal(s1.align, 'center');
  assert.equal(s1.vAlign, 'top');
  assert.equal(s1.wrap, true);
  assert.equal(s1.border?.left?.width, 0.75);
  assert.equal(s1.border?.left?.style, 'solid');
  assert.equal(s1.border?.left?.color, '#000000');
  assert.equal(s1.border?.bottom?.style, 'double');
  assert.equal(s1.border?.bottom?.color, undefined, 'auto 颜色应留空，由渲染器决定');

  // 5 号样式：theme 色 + indexed 填充 + 10.5pt
  const s5 = table.styles[5];
  assert.equal(s5.size, 10.5);
  assert.equal(s5.color, '#44546a', 'theme=3 -> dk2');
  assert.equal(s5.bg, '#ff0000', 'indexed=10 -> 调色板第 10 项');
  assert.equal(s5.align, 'right');
  assert.equal(s5.vAlign, 'bottom');
  assert.equal(s5.numFmt, '0.00"元"');

  // indexed=64/65 是「系统前景/背景」，等价于没有颜色 —— 不能变成黑白底纹
  const f = parseStyles(
    `<styleSheet xmlns="${NS}"><fills count="2"><fill><patternFill patternType="solid"><fgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><bgColor indexed="64"/><fgColor rgb="FF123456"/></patternFill></fill></fills><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="1" borderId="0"/></cellXfs></styleSheet>`,
    () => {},
  );
  assert.equal(f.styles[0].bg, undefined);
  assert.equal(f.styles[1].bg, '#123456');

  assert.deepEqual(table.numFmtCodes, ['General', 'General', 'm/d/yy', 'yyyy-mm-dd', 'h:mm', '0.00"元"', '[$-409]m/d/yy h:mm']);
  assert.deepEqual(table.isDate, [false, false, true, true, true, false, true]);
});

test('数字格式：内置表、日期判定、字面量剥离', () => {
  assert.equal(isDateFormat('General'), false);
  assert.equal(isDateFormat('@'), false);
  assert.equal(isDateFormat('0.00'), false);
  assert.equal(isDateFormat('#,##0'), false);
  assert.equal(isDateFormat('0.00E+00'), false);
  assert.equal(isDateFormat('m/d/yy'), true);
  assert.equal(isDateFormat('yyyy-mm-dd'), true);
  assert.equal(isDateFormat('h:mm:ss'), true);
  assert.equal(isDateFormat('[h]:mm:ss'), true, '[h] 是经过时间标记');
  assert.equal(isDateFormat('0.00"元"'), false, '引号里的字不能当日期标记');
  assert.equal(isDateFormat('_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"_ ;_ @_ '), false, 'WPS 会计格式');
  assert.equal(isDateFormat('[$-409]d/m/yyyy'), true);
  assert.equal(isDateFormat('[Red]0.00'), false);
  assert.equal(stripFormatLiterals('0.00"ymd"'), '0.00');
  assert.equal(stripFormatLiterals('[$-409]m/d/yy'), 'm/d/yy');
});

test('日期序列号：1900 闰年 bug 的边界 59/60/61、时间、1904 系统', () => {
  assert.deepEqual(serialToParts(1), { y: 1900, m: 1, d: 1, hh: 0, mm: 0, ss: 0 });
  assert.equal(formatExcelSerial(59, 'm/d/yy'), '1900-02-28');
  // 序列号 60 是 Excel 为兼容 Lotus 造出的「1900-02-29」，真实日历里不存在，
  // 这里按夹到 1900-02-28 处理（宁可差一天，也不给出 Invalid Date 或 1900-03-01 这种错位）
  assert.equal(formatExcelSerial(60, 'm/d/yy'), '1900-02-28');
  assert.equal(formatExcelSerial(61, 'm/d/yy'), '1900-03-01');
  assert.equal(formatExcelSerial(0, 'yyyy-mm-dd'), '1899-12-31');
  assert.equal(formatExcelSerial(42856, 'yyyy-mm-dd'), '2017-05-01');
  assert.equal(formatExcelSerial(25569, 'yyyy-mm-dd'), '1970-01-01');
  assert.equal(formatExcelSerial(36526, 'yyyy-mm-dd'), '2000-01-01');
  assert.equal(formatExcelSerial(0.5, 'h:mm'), '12:00');
  assert.equal(formatExcelSerial(0.5, 'h:mm:ss'), '12:00:00');
  assert.equal(formatExcelSerial(42856.5, 'm/d/yy h:mm'), '2017-05-01 12:00');
  assert.equal(formatExcelSerial(-5, 'yyyy-mm-dd'), null, '负数不是日期，调用方应保留原数字');
  assert.equal(formatExcelSerial(Number.NaN, 'yyyy-mm-dd'), null);
  assert.equal(formatExcelSerial(0, 'yyyy-mm-dd', true), '1904-01-01', '1904 日期系统没有闰年 bug');
});

test('日期样式：数字单元格按 numFmt 转成可读日期，非日期格式保持数字', async () => {
  const body =
    '<row r="1">' +
    '<c r="A1" s="2"><v>59</v></c>' +
    '<c r="B1" s="2"><v>60</v></c>' +
    '<c r="C1" s="2"><v>61</v></c>' +
    '<c r="D1" s="3"><v>42856</v></c>' +
    '<c r="E1" s="4"><v>0.5</v></c>' +
    '<c r="F1" s="6"><v>42856.5</v></c>' +
    '<c r="G1" s="5"><v>1234.5</v></c>' +
    '</row>';
  const sheet = await firstSheet(minimalParts(body, '<dimension ref="A1:G1"/>'));
  const vals = (await sheet.readRows(0, 1))[0].cells.map((c) => c.v);
  assert.deepEqual(vals, ['1900-02-28', '1900-02-28', '1900-03-01', '2017-05-01', '12:00', '2017-05-01 12:00', '1234.5']);
});

test('1904 日期系统（workbookPr date1904="1"）', async () => {
  const entries = minimalParts('<row r="1"><c r="A1" s="3"><v>0</v></c></row>', '<dimension ref="A1:A1"/>', {
    'xl/workbook.xml': workbookXml([{ name: 'Sheet1', rid: 'rId1' }], ' date1904="1"'),
  });
  const sheet = await firstSheet(entries);
  assert.equal((await cellAt(sheet, 0, 0))?.v, '1904-01-01');
});

test('样式索引共享：同格式单元格共享同一个 Cell.s，s=0 不写字段', async () => {
  const body =
    '<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"><v>2</v></c><c r="C1" s="0"><v>3</v></c><c r="D1"><v>4</v></c></row>';
  const sheet = await firstSheet(minimalParts(body, '<dimension ref="A1:D1"/>'));
  const cells = (await sheet.readRows(0, 1))[0].cells;
  assert.equal(cells[0].s, 1);
  assert.equal(cells[1].s, 1, '两个同格式单元格共享同一下标');
  assert.equal(cells[2].s, undefined, 's=0 是默认样式，不写字段以省内存');
  assert.equal(cells[3].s, undefined);
  assert.equal(sheet.styles.length, 7, '样式表在工作表间共享');
  assert.equal(sheet.styles[1].bold, true);
});

test('行级样式 <row s= customFormat=1> 作为单元格的默认样式', async () => {
  const body = '<row r="1" s="1" customFormat="1"><c r="A1"><v>1</v></c><c r="B1" s="0"><v>2</v></c></row>';
  const sheet = await firstSheet(minimalParts(body, '<dimension ref="A1:B1"/>'));
  const cells = (await sheet.readRows(0, 1))[0].cells;
  assert.equal(cells[0].s, 1, '未显式指定样式的单元格继承行样式');
  assert.equal(cells[1].s, undefined, '显式 s="0" 覆盖行样式');
});

test('越界的样式索引按默认样式降级并记警告', async () => {
  const body = '<row r="1"><c r="A1" s="99"><v>1</v></c></row>';
  const { doc } = await readXlsx(minimalParts(body, '<dimension ref="A1:A1"/>'));
  assert.equal(doc.sheets?.[0] && (await cellAt(doc.sheets[0], 0, 0))?.v, '1');
  assert.equal((await cellAt(doc.sheets![0], 0, 0))?.s, undefined);
  assert.ok(doc.stats.warnings.some((w) => w.includes('样式索引')), doc.stats.warnings.join('; '));
});

/* ==================================================================== */
/* 7. 跨块边界：行切块扫描器                                              */
/* ==================================================================== */

const CHUNK_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS}"><dimension ref="A1:C6"/><sheetViews><sheetView><pane ySplit="1" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="12"/></cols><sheetData><row r="1" spans="1:3"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1"><v>1.5</v></c><c r="C1" t="inlineStr"><is><t>内联文本</t></is></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"/><row r="4" ht="22" customHeight="1"><c r="AA4"><f>SUM(A1:A2)</f><v>3.5</v></c></row><row r="5"><c r="A5" t="b"><v>1</v></c><c r="B5" t="e"><v>#DIV/0!</v></c></row><row r="6"><c r="C6" t="s"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A5:B5"/></mergeCells><autoFilter ref="A1:C6"/></worksheet>`;

async function scanWithChunks(xml: string, chunkSize: number): Promise<{ rows: CellRow[]; meta: unknown }> {
  const limits = withLimits(undefined);
  const sstXml = sharedStringsXml(['共享甲', '共享乙']);
  const sstContainer = ZipReader.open(await zipBytes({ 's.xml': sstXml }));
  const sst = await loadSharedStrings(() => sstContainer.streamText('s.xml'), limits.maxStringBytes, () => {});
  const res = await scanSheet(() => chunkedStream(xml, chunkSize), {
    mode: 'collect',
    limits,
    sst,
    styles: parseStyles(STYLES_XML, () => {}),
    date1904: false,
    warn: () => {},
    truncate: () => {},
  });
  const rows: CellRow[] = [];
  for (const r of res.rows ?? []) if (r && r.cells.length) rows.push(r);
  return { rows, meta: res.meta };
}

test('跨块边界：任意 chunkSize 都与整串解析等价（含切在 <row / 属性 / <c> 中间）', async () => {
  const reference = await scanWithChunks(CHUNK_SHEET, CHUNK_SHEET.length);
  const refText = reference.rows.map((r) => `${r.r}=${rowText(r)}`).join('\n');
  assert.match(refText, /0=0:共享甲\|1:1\.5\|2:内联文本/);
  assert.match(refText, /3=26:3\.5/);
  assert.match(refText, /5=2:共享乙/);

  // chunkSize=1 会把 `<row`、`r="AA4"`、`<c`、`<is>` 全部切成单字符：
  // 任何「对单个 chunk 做 indexOf('<row')」的实现都会在这里露馅
  for (const size of [1, 2, 3, 4, 5, 7, 8, 13, 29, 64, 127, 1024]) {
    const got = await scanWithChunks(CHUNK_SHEET, size);
    const text = got.rows.map((r) => `${r.r}=${rowText(r)}`).join('\n');
    assert.equal(text, refText, `chunkSize=${size} 的解析结果应与整串一致`);
    assert.deepEqual(got.meta, reference.meta, `chunkSize=${size} 的元数据应与整串一致`);
  }
});

test('跨块边界：逐标签切分也不丢内容（含属性值里出现 > ）', async () => {
  const xml = `<worksheet xmlns="${NS}"><sheetData><row r="1" customAttr="a>b&lt;c"><c r="A1" t="inlineStr"><is><t>x&gt;y</t></is></c><c r="B1"><v>7</v></c></row></sheetData></worksheet>`;
  const ref = await scanWithChunks(xml, 4096);
  assert.equal(rowText(ref.rows[0]), '0:x>y|1:7');
  for (let size = 1; size <= 12; size++) {
    const got = await scanWithChunks(xml, size);
    assert.equal(rowText(got.rows[0]), '0:x>y|1:7', `chunkSize=${size}`);
  }
});

test('连续 skipElement 不吞兄弟元素（pull.ts 修过的那个坑）', async () => {
  const xml = `<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"/><row r="4"><c r="A4"><v>4</v></c></row></sheetData>`;
  const scanner = new StreamXmlScanner(chunkedStream(xml, 3));
  const seen: number[] = [];
  for (;;) {
    const e = await scanner.next();
    if (e === null) break;
    if (e.type === 'start' && e.local === 'row') {
      seen.push(Number.parseInt(e.attrs?.r ?? '0', 10));
      await scanner.skipElement();
    }
  }
  assert.deepEqual(seen, [1, 2, 3, 4], '每次跳过一行后必须还能看到后面的所有兄弟行');

  // 容器元素同理：只跳过 <cols>、<others>，其余兄弟必须全部可见
  const xml2 = `<worksheet><cols><col min="1" max="1" width="9"/></cols><mergeCells><mergeCell ref="A1:B2"/></mergeCells><autoFilter ref="A1:B9"/><others><a><b/></a></others></worksheet>`;
  const s2 = new StreamXmlScanner(chunkedStream(xml2, 4));
  const locals: string[] = [];
  for (;;) {
    const e = await s2.next();
    if (e === null) break;
    if (e.type !== 'start') continue;
    locals.push(e.local);
    if (e.local === 'cols' || e.local === 'others') await s2.skipElement();
  }
  assert.deepEqual(locals, ['worksheet', 'cols', 'mergeCells', 'mergeCell', 'autoFilter', 'others']);
});

test('扫描器内存：缓冲区不随部件大小线性增长', async () => {
  // 20 万个 <c> 的部件：已消费前缀必须被裁掉，否则 buf 会涨到整个部件大小
  const rows: string[] = [];
  for (let i = 1; i <= 20000; i++) rows.push(`<row r="${i}"><c r="A${i}"><v>${i}</v></c><c r="B${i}"><v>${i * 2}</v></c></row>`);
  const xml = `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`;
  const scanner = new StreamXmlScanner(chunkedStream(xml, 8192));
  let maxBuf = 0;
  let count = 0;
  for (;;) {
    const e = await scanner.next();
    if (e === null) break;
    if (e.type === 'start' && e.local === 'row') {
      count++;
      await scanner.skipElement();
      maxBuf = Math.max(maxBuf, (scanner as unknown as { buf: string }).buf.length);
    }
  }
  assert.equal(count, 20000);
  assert.ok(maxBuf < 64 * 1024, `扫描缓冲区应保持小块（实测 ${maxBuf} 字符，部件 ${xml.length} 字符）`);
});

/* ==================================================================== */
/* 8. 大表：低内存路径（本任务的核心证据）                                 */
/* ==================================================================== */

test('惰性网格：读到流尾之后再读中间窗口，不得返回空行', async () => {
  // 这条用例锁一个真实踩到的坑：游标读到 EOF 后如果把「流已结束」当成全局结论，
  // 后续请求中间窗口会静默返回空行 —— 数据丢了还看不出来。
  // dimension 故意写大（> 20 万格）以便用很小的夹具走到惰性路径。
  const rows: string[] = [];
  for (let r = 1; r <= 300; r++) rows.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`);
  const sheet = await firstSheet(minimalParts(rows.join(''), '<dimension ref="A1:A200001"/>'), {});
  assert.ok(sheet instanceof LazyGrid, `应走惰性路径，实际 ${sheet.constructor.name}`);
  const tail = await sheet.readRows(290, 300);
  assert.equal(tail.length, 10);
  assert.equal(tail[0].cells[0].v, '291');
  const middle = await sheet.readRows(100, 110);
  assert.equal(middle.length, 10);
  assert.equal(middle[0].cells[0].v, '101', 'EOF 之后再读中间窗口必须仍能取到数据');
  const head = await sheet.readRows(0, 5);
  assert.equal(head[4].cells[0].v, '5');
  // 顺序续扫同样要正确
  const next = await sheet.readRows(5, 10);
  assert.equal(next[0].cells[0].v, '6');
});

const BIG_ROWS = 50_000;
const BIG_COLS = 20;
const BIG_SST_LEN = 64;

function bigValue(r: number, c: number): string {
  if (c === BIG_COLS - 1) return `标签${(r + 1) % BIG_SST_LEN}`;
  return String(((r + 1) * (c + 7)) % 100000);
}

/**
 * 造一个 5 万行 × 20 列的表（100 万格）。
 * 按 1000 行一块拼接，避免生成期出现多份巨型字符串。
 */
async function buildBigWorkbook(): Promise<{ bytes: Uint8Array; sheetChars: number }> {
  const cols = 'ABCDEFGHIJKLMNOPQRST';
  const chunks: string[] = [];
  for (let start = 0; start < BIG_ROWS; start += 1000) {
    const part: string[] = [];
    for (let r = start; r < Math.min(start + 1000, BIG_ROWS); r++) {
      let row = `<row r="${r + 1}">`;
      for (let c = 0; c < BIG_COLS; c++) {
        const ref = `${cols[c]}${r + 1}`;
        if (c === BIG_COLS - 1) row += `<c r="${ref}" s="1" t="s"><v>${(r + 1) % BIG_SST_LEN}</v></c>`;
        else row += `<c r="${ref}" s="1"><v>${((r + 1) * (c + 7)) % 100000}</v></c>`;
      }
      part.push(`${row}</row>`);
    }
    chunks.push(part.join(''));
  }
  const sheetBody = chunks.join('');
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><dimension ref="A1:T${BIG_ROWS}"/><sheetViews><sheetView><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15" defaultColWidth="8.43"/><cols><col min="1" max="20" width="12"/></cols><sheetData>${sheetBody}</sheetData><mergeCells count="1"><mergeCell ref="A1:A1"/></mergeCells><autoFilter ref="A1:T${BIG_ROWS}"/></worksheet>`;
  const sstItems = Array.from({ length: BIG_SST_LEN }, (_, i) => `标签${i}`);
  const bytes = await zipBytes({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'xl/workbook.xml': workbookXml([{ name: '大表', rid: 'rId1' }]),
    'xl/_rels/workbook.xml.rels': defaultRels(),
    'xl/sharedStrings.xml': sharedStringsXml(sstItems),
    'xl/styles.xml': STYLES_XML,
    'xl/worksheets/sheet1.xml': sheet,
  });
  return { bytes, sheetChars: sheet.length };
}

test('大表：走 LazyGrid 不物化整表，readRows 只返回窗口', async (t) => {
  const t0 = performance.now();
  const { bytes, sheetChars } = await buildBigWorkbook();
  const genMs = performance.now() - t0;
  const harness = makeCtx(bytes, 'big.xlsx');
  const uncompressed = harness.container.entrySize('xl/worksheets/sheet1.xml');

  // 只测量「解析」阶段：夹具字节与生成期临时对象都在窗口之外
  const measured = await measure(() => xlsxReader.read(harness.ctx));
  const doc = measured.result;
  const sheet = doc.sheets![0];

  assert.ok(sheet instanceof LazyGrid, '大表必须走 LazyGrid（惰性行）路径，而不是物化整表');
  assert.equal(sheet.rowCount, BIG_ROWS);
  assert.equal(sheet.colCount, BIG_COLS);
  assert.equal(doc.meta.sheetCount, 1);
  const grid = sheet as LazyGrid;
  assert.equal(grid.cachedRows, 0, '刚打开时不该缓存任何行');
  assert.deepEqual(sheet.freeze, { rows: 1, cols: 0 });

  // 结构性证据：常驻模型里根本没有表体
  const modelPerCell = doc.stats.modelBytes / (BIG_ROWS * BIG_COLS);
  assert.ok(
    doc.stats.modelBytes < uncompressed / 500,
    `模型常驻字节应远小于表体量：modelBytes=${formatBytes(doc.stats.modelBytes)}，表 XML=${formatBytes(uncompressed)}`,
  );
  // cellCount 不能是 0（UI 会显示「0 单元格」在撒谎）：惰性路径用 dimension 区域作上界估算
  assert.equal(
    doc.stats.cellCount,
    BIG_ROWS * BIG_COLS,
    '惰性表的 cellCount 应为 dimension 区域上界估算，绝不能是 0',
  );
  assert.ok(
    doc.stats.warnings.some((w) => w.includes('惰性')),
    `必须明确标注 cellCount 是估算：${doc.stats.warnings.join('; ')}`,
  );

  // 动态证据：解析期堆增量远小于表体量
  assert.ok(
    measured.heapDeltaBytes < uncompressed / 4,
    `解析期堆增量 ${formatBytes(measured.heapDeltaBytes)} 应远小于表 XML ${formatBytes(uncompressed)}`,
  );

  // ---- 窗口读取：末尾窗口的数据正确性 ----
  const tail = await sheet.readRows(BIG_ROWS - 10, BIG_ROWS);
  assert.equal(tail.length, 10, 'readRows 只返回请求的窗口');
  assert.deepEqual(tail.map((r) => r.r), Array.from({ length: 10 }, (_, i) => BIG_ROWS - 10 + i));
  assert.equal(tail[0].cells.length, BIG_COLS);
  assert.equal(tail[0].cells[0].v, bigValue(BIG_ROWS - 10, 0));
  assert.equal(tail[0].cells[BIG_COLS - 1].v, bigValue(BIG_ROWS - 10, BIG_COLS - 1));
  assert.equal(tail[9].cells[1].v, bigValue(BIG_ROWS - 1, 1));
  const cachedAfterTail = grid.cachedRows;
  assert.ok(cachedAfterTail <= 600, `LRU 缓存上界 600 行，实际 ${cachedAfterTail}`);
  assert.ok(cachedAfterTail * 10 < BIG_ROWS, `缓存行数(${cachedAfterTail})必须远小于总行数(${BIG_ROWS})`);

  /*
   * ---- 窗口读取代价：∝ 距表头距离（惰性设计的固有取舍）+ 游标缓解顺序滚动 ----
   *
   * deflate 流不可随机访问，所以「第一次跳到很后面」必然要扫过整张表；
   * 这是用 CPU 换内存的自觉取舍。但**顺序向下滚动**（最常见的交互）必须便宜，
   * 否则滚动会变成幻灯片 —— 游标（把已扫到的行号记住、上游流保持打开）就是为此存在。
   * 每次测量前都 clearCache()，确保测的是「扫描代价」而不是「缓存命中」。
   */
  const timed = async (start: number, end: number): Promise<{ ms: number; rows: CellRow[] }> => {
    grid.clearCache();
    const t = performance.now();
    const rows = await sheet.readRows(start, end);
    return { ms: performance.now() - t, rows };
  };

  const farFirst = await timed(BIG_ROWS - 20, BIG_ROWS - 10); // 首次远跳：从表头扫到底
  const headAgain = await timed(0, 10); // 回退：只能重开流，但只有 10 行
  const seq1 = await timed(10, 30); // 游标续扫
  const seq2 = await timed(30, 50); // 继续续扫
  const farAgain = await timed(BIG_ROWS - 5, BIG_ROWS); // 再次远跳：又要扫过整张表

  assert.equal(farFirst.rows.length, 10);
  assert.equal(farFirst.rows[0].cells[0].v, bigValue(BIG_ROWS - 20, 0));
  assert.equal(seq1.rows[0].cells[0].v, bigValue(10, 0));
  assert.equal(seq2.rows[9].cells[0].v, bigValue(39, 0));
  assert.equal(farAgain.rows[4].cells[0].v, bigValue(BIG_ROWS - 1, 0));

  // 从表头开始的窗口必须明显快于「首次远跳」——这条性质被破坏时应当马上失败
  assert.ok(
    headAgain.ms < Math.max(farFirst.ms / 4, 5),
    `表头窗口(${headAgain.ms.toFixed(1)}ms)应远快于首次远跳(${farFirst.ms.toFixed(0)}ms)`,
  );
  assert.ok(
    seq1.ms < Math.max(farFirst.ms / 4, 5) && seq2.ms < Math.max(farFirst.ms / 4, 5),
    `顺序续扫(${seq1.ms.toFixed(1)}ms / ${seq2.ms.toFixed(1)}ms)应远快于从表头重扫(${farFirst.ms.toFixed(0)}ms)`,
  );
  assert.ok(
    farAgain.ms > seq2.ms * 5,
    `远跳(${farAgain.ms.toFixed(0)}ms)本就要扫过整张表，应明显慢于续扫(${seq2.ms.toFixed(1)}ms)`,
  );

  const cached = grid.cachedRows;
  assert.ok(cached <= 600, `LRU 缓存上界 600 行，实际 ${cached}`);

  console.log(
    [
      '',
      '  ── 大表实测（format-xlsx 低内存证据）──',
      `  夹具：${BIG_ROWS.toLocaleString('en-US')} 行 × ${BIG_COLS} 列 = ${(BIG_ROWS * BIG_COLS).toLocaleString('en-US')} 单元格`,
      `  sheet XML 解压后：${formatBytes(uncompressed)}（用例生成耗时 ${genMs.toFixed(0)} ms，源码字符串 ${formatBytes(sheetChars)}）`,
      `  ZIP 文件体积：${formatBytes(bytes.length)}（压缩率 ${(uncompressed / bytes.length).toFixed(1)}:1）`,
      `  解析路径：LazyGrid（小表阈值 20 万格），打开耗时 ${measured.ms.toFixed(0)} ms`,
      `  打开期堆增量：${
        measured.heapDeltaBytes >= 0
          ? `${formatBytes(measured.heapDeltaBytes)} = 表体量的 ${((measured.heapDeltaBytes / uncompressed) * 100).toFixed(2)}%`
          : '负值（测量窗口内 GC 回收了夹具生成期的临时对象，属噪声 —— 同进程测量只能作上界参考）'
      }（forceGc 可用：${forceGc() ? '是' : '否（未加 --expose-gc）'}）`,
      `  常驻模型 modelBytes：${formatBytes(doc.stats.modelBytes)} = 表体量的 ${((doc.stats.modelBytes / uncompressed) * 100).toFixed(4)}%（每格 ${modelPerCell.toFixed(2)} 字节）`,
      `  stats.cellCount：${doc.stats.cellCount.toLocaleString('en-US')}（惰性表按 dimension 区域估算的上界）`,
      `  readRows 首次远跳(49980..49990)：${farFirst.ms.toFixed(0)} ms ← 代价 ∝ 距表头距离（压缩流不可随机访问）`,
      `  readRows 表头窗口(0..10)：${headAgain.ms.toFixed(1)} ms（回退需重开流，但只有 10 行）`,
      `  readRows 顺序续扫(10..30)：${seq1.ms.toFixed(1)} ms，(30..50)：${seq2.ms.toFixed(1)} ms ← 游标续扫，代价回到 O(窗口)`,
      `  readRows 再次远跳(49995..50000)：${farAgain.ms.toFixed(0)} ms`,
      `  LRU 缓存行数：${cached} / 总行数 ${BIG_ROWS.toLocaleString('en-US')} = ${((cached / BIG_ROWS) * 100).toFixed(2)}%`,
      `  堆快照来源：${memSnapshot().source}`,
      '',
    ].join('\n'),
  );
});

/* ==================================================================== */
/* 9. 降级路径（绝不因为子特性缺失而抛错）                                 */
/* ==================================================================== */

test('降级：缺少 sharedStrings.xml 时字符串格置空并记警告', async () => {
  const entries = minimalParts('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>5</v></c></row>', '<dimension ref="A1:B1"/>');
  delete entries['xl/sharedStrings.xml'];
  entries['xl/_rels/workbook.xml.rels'] = workbookRels([
    { rid: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
    { rid: 'rId2', type: 'styles', target: 'styles.xml' },
  ]);
  const { doc } = await readXlsx(entries);
  const sheet = doc.sheets![0];
  assert.equal((await cellAt(sheet, 0, 0))?.v, '', '共享字符串缺失时应为空串，而不是索引数字');
  assert.equal((await cellAt(sheet, 0, 1))?.v, '5');
  assert.ok(doc.stats.warnings.some((w) => w.includes('sharedStrings')), doc.stats.warnings.join('; '));
});

test('降级：共享字符串超出 maxStringBytes 时截断并记 truncated', async () => {
  const items = Array.from({ length: 40 }, (_, i) => `字符串内容-${i}-填充`);
  const cells = items.map((_, i) => `<c r="${lettersOfColIndex(i)}1" t="s"><v>${i}</v></c>`).join('');
  const body = `<row r="1">${cells}</row>`;
  const { doc } = await readXlsx(minimalParts(body, '<dimension ref="A1:AN1"/>', {}, items), { limits: { maxStringBytes: 120 } });
  assert.ok(doc.stats.truncated.includes('sharedStrings'), `truncated=${doc.stats.truncated.join(',')}`);
  assert.ok(doc.stats.warnings.some((w) => w.includes('sharedStrings')), doc.stats.warnings.join('; '));
  const sheet = doc.sheets![0];
  assert.equal((await cellAt(sheet, 0, 0))?.v, items[0], '上限内的字符串必须完整保留');
  assert.equal((await cellAt(sheet, 0, 39))?.v, '', '越界的索引给空串');
  assert.ok((await cellAt(sheet, 0, 39)) !== undefined, '取不到的字符串仍要保留单元格本身');
});

test('降级：缺少 workbook.xml.rels 或 r:id 对不上时按文件名顺序解析', async () => {
  const body = '<row r="1"><c r="A1"><v>1</v></c></row>';
  // 情况一：完全没有 rels 部件
  const noRels = minimalParts(body, '<dimension ref="A1:A1"/>');
  delete noRels['xl/_rels/workbook.xml.rels'];
  const a = await readXlsx(noRels);
  assert.equal((await cellAt(a.doc.sheets![0], 0, 0))?.v, '1');
  assert.ok(a.doc.stats.warnings.some((w) => w.includes('workbook.xml.rels')), a.doc.stats.warnings.join('; '));

  // 情况二：rels 存在但 id 对不上
  const mismatch = minimalParts(body, '<dimension ref="A1:A1"/>', {
    'xl/_rels/workbook.xml.rels': workbookRels([{ rid: 'rId9', type: 'worksheet', target: 'worksheets/sheet1.xml' }]),
  });
  const b = await readXlsx(mismatch);
  assert.equal((await cellAt(b.doc.sheets![0], 0, 0))?.v, '1');
  assert.ok(b.doc.stats.warnings.some((w) => w.includes('关系缺失')), b.doc.stats.warnings.join('; '));

  // 情况三：关系指向不存在的部件 -> 也要能打开
  const dangling = minimalParts(body, '<dimension ref="A1:A1"/>', {
    'xl/_rels/workbook.xml.rels': workbookRels([{ rid: 'rId1', type: 'worksheet', target: 'worksheets/nope.xml' }]),
  });
  const c = await readXlsx(dangling);
  assert.equal((await cellAt(c.doc.sheets![0], 0, 0))?.v, '1');
});

test('降级：没有 workbook.xml 时按 xl/worksheets/*.xml 打开', async () => {
  const entries: Record<string, string> = {
    '[Content_Types].xml': CONTENT_TYPES,
    'xl/worksheets/sheet1.xml': sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>兜底</t></is></c></row>', '<dimension ref="A1:A1"/>'),
  };
  const { doc } = await readXlsx(entries);
  assert.equal(doc.sheets?.length, 1);
  assert.equal(doc.sheets?.[0].name, 'Sheet1');
  assert.equal((await cellAt(doc.sheets![0], 0, 0))?.v, '兜底');
  assert.ok(doc.stats.warnings.some((w) => w.includes('工作表定义')), doc.stats.warnings.join('; '));
});

test('降级：既没有 workbook 也没有 worksheet -> ReadError(CORRUPT)', async () => {
  const bytes = await zipBytes({ '[Content_Types].xml': CONTENT_TYPES, 'xl/theme/theme1.xml': '<a/>' });
  const harness = makeCtx(bytes);
  await assert.rejects(
    () => xlsxReader.read(harness.ctx),
    (err: Error & { code?: string }) => err.code === 'CORRUPT',
  );
});

test('降级：没有 sharedStrings/样式/rels 的部件也不能抛错', async () => {
  const entries: Record<string, string> = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'xl/workbook.xml': workbookXml([{ name: '裸表', rid: 'rId1' }]),
    'xl/worksheets/sheet1.xml': sheetXml('<row r="1"><c r="A1" s="3"><v>9</v></c></row>', '<dimension ref="A1:A1"/>'),
  };
  const { doc } = await readXlsx(entries);
  const sheet = doc.sheets![0];
  assert.equal((await cellAt(sheet, 0, 0))?.v, '9');
  assert.equal(sheet.styles.length, 0);
  assert.equal((await cellAt(sheet, 0, 0))?.s, undefined, '样式表缺失时不该留下悬空索引');
});

test('降级：没有 dimension 的小表靠扫描得出行列数并物化', async () => {
  const body =
    '<row r="1"><c r="A1"><v>1</v></c><c r="AA1"><v>2</v></c></row>' +
    '<row r="2"><c r="B2" t="inlineStr"><is><t>x</t></is></c></row>';
  const sheet = await firstSheet(minimalParts(body, ''));
  assert.ok(sheet instanceof MaterializedGrid, `缺 dimension 的小表仍应物化，实际 ${sheet.constructor.name}`);
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.colCount, 27);
  assert.equal((await cellAt(sheet, 0, 26))?.v, '2');
});

test('降级：空表（<sheetData/> 与无 sheetData）', async () => {
  const empty = await firstSheet(minimalParts('', '<dimension ref="A1"/>'));
  assert.ok(empty instanceof MaterializedGrid);
  assert.equal((await empty.readRows(0, 1)).length, 1);
  assert.deepEqual((await empty.readRows(0, 1))[0].cells, []);

  const selfClosed = await firstSheet(
    minimalParts('', '<dimension ref="A1"/>', {
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${NS}"><dimension ref="A1"/><sheetData/></worksheet>`,
    }),
  );
  assert.ok(selfClosed instanceof MaterializedGrid, '<sheetData/> 也必须走物化分支');
  assert.equal(selfClosed.rowCount, 1);

  const noData = await firstSheet(minimalParts('', '<dimension ref="A1"/>', {
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${NS}"></worksheet>`,
  }));
  assert.equal(noData.rowCount, 0);
  assert.deepEqual(await noData.readRows(0, 5), []);
});

test('上限：maxCells 截断并标记 truncated', async () => {
  // dimension 故意撒谎（A1:B2），让读取器先走物化路径，再被实际格数顶到上限
  const rows: string[] = [];
  for (let r = 1; r <= 10; r++) {
    rows.push(`<row r="${r}">${['A', 'B', 'C', 'D'].map((col) => `<c r="${col}${r}"><v>${r}</v></c>`).join('')}</row>`);
  }
  const { doc } = await readXlsx(minimalParts(rows.join(''), '<dimension ref="A1:B2"/>'), { limits: { maxCells: 10 } });
  assert.ok(doc.stats.truncated.includes('maxCells'), `truncated=${doc.stats.truncated.join(',')}`);
  assert.equal(doc.truncated, true);
  assert.equal(doc.sheets?.[0].truncated, true);
  assert.ok(doc.stats.cellCount <= 10, `物化格数应被限制在 10 以内，实际 ${doc.stats.cellCount}`);
  // 截断发生在扫描中途，因此 rowCount 只能反映「已经看到的部分」（不会凭空吹大）
  const win = await doc.sheets![0].readRows(0, 10);
  assert.equal(win.length, doc.sheets![0].rowCount, '被截断的表仍然可以读行窗口');
  assert.ok(win.length >= 1 && win.length <= 10);
});

test('上限：maxRows / maxCols 截断并记录', async () => {
  const rows: string[] = [];
  for (let r = 1; r <= 10; r++) rows.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`);
  const cutRows = await readXlsx(minimalParts(rows.join(''), '<dimension ref="A1:A10"/>'), { limits: { maxRows: 5 } });
  assert.ok(cutRows.doc.stats.truncated.includes('maxRows'), cutRows.doc.stats.truncated.join(','));
  assert.equal(cutRows.doc.sheets?.[0].rowCount, 5);
  assert.equal(cutRows.doc.sheets?.[0].truncated, true);

  const wide = '<row r="1">' + ['A', 'B', 'C', 'D', 'E'].map((col) => `<c r="${col}1"><v>1</v></c>`).join('') + '</row>';
  const cutCols = await readXlsx(minimalParts(wide, '<dimension ref="A1:E1"/>'), { limits: { maxCols: 3 } });
  assert.ok(cutCols.doc.stats.truncated.includes('maxCols'), cutCols.doc.stats.truncated.join(','));
  assert.equal(cutCols.doc.sheets?.[0].colCount, 3);
  const cells = (await cutCols.doc.sheets![0].readRows(0, 1))[0].cells;
  assert.deepEqual(cells.map((c) => c.c), [0, 1, 2]);
});

test('降级：条件格式/数据验证/超链接/图片等未支持特性只写警告不抛错', async () => {
  const extra =
    '<conditionalFormatting sqref="A1:A9"><cfRule type="cellIs" priority="1"/></conditionalFormatting>' +
    '<dataValidations count="1"><dataValidation type="list" sqref="B1"><formula1>"a,b"</formula1></dataValidation></dataValidations>' +
    '<hyperlinks><hyperlink ref="A1" r:id="rIdX"/></hyperlinks>' +
    '<drawing r:id="rIdY"/><extLst><ext uri="x"><x14:autoFilter ref="Z1:Z9" xmlns:x14="x"/></ext></extLst>';
  const xml = `<?xml version="1.0"?><worksheet xmlns="${NS}" xmlns:r="${NS_R}"><dimension ref="A1:B9"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>${extra}</worksheet>`;
  const { doc } = await readXlsx(minimalParts('', '', { 'xl/worksheets/sheet1.xml': xml }));
  const sheet = doc.sheets![0];
  assert.equal((await cellAt(sheet, 0, 0))?.v, '1');
  assert.equal(sheet.autoFilter, undefined, 'extLst 里形似 autoFilter 的元素不能被误当成表级自动筛选');
  assert.ok(doc.stats.warnings.length >= 3, `应记录多条降级说明，实际 ${JSON.stringify(doc.stats.warnings)}`);
});

test('xlsm / xltx：格式判定与宏提示', async () => {
  const withMacro = minimalParts('<row r="1"><c r="A1"><v>1</v></c></row>', '<dimension ref="A1:A1"/>', { 'xl/vbaProject.bin': 'MZfake' });
  const a = await readXlsx(withMacro, { name: '宏.xlsm' });
  assert.equal(a.doc.format, 'xlsm');
  assert.equal(a.doc.formatLabel, 'Excel 工作簿（含宏）');
  assert.ok(a.doc.stats.warnings.some((w) => w.includes('宏')), a.doc.stats.warnings.join('; '));

  const b = await readXlsx(withMacro, { name: '宏.xlsx' });
  assert.equal(b.doc.format, 'xlsm', '扩展名是 xlsx 但含 vbaProject.bin 时按含宏处理');

  const c = await readXlsx(minimalParts('<row r="1"><c r="A1"><v>1</v></c></row>', '<dimension ref="A1:A1"/>'), { name: '模板.xltx' });
  assert.equal(c.doc.format, 'xltx');
  assert.equal(c.doc.formatLabel, 'Excel 模板');
});

test('损坏的行内 XML 不抛错（能打开优先）', async () => {
  const broken = `<?xml version="1.0"?><worksheet xmlns="${NS}"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><v>1</v></c><row r="2"><c r="A2"><v>2</v>`;
  const { doc } = await readXlsx(minimalParts('', '', { 'xl/worksheets/sheet1.xml': broken }));
  assert.equal(doc.sheets?.length, 1);
  const sheet = doc.sheets![0];
  assert.equal((await cellAt(sheet, 0, 0))?.v, '1');
});

test('docProps：标题/作者/公司等元数据', async () => {
  const entries = minimalParts('<row r="1"><c r="A1"><v>1</v></c></row>', '<dimension ref="A1:A1"/>', {
    'docProps/core.xml': `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z"><dc:title>季度报表</dc:title><dc:creator>张三</dc:creator><dcterms:created>2024-03-05T08:30:00Z</dcterms:created></cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0"?><Properties xmlns="w"><Application>LiteOffice</Application><Company>某某公司</Company></Properties>`,
  });
  const { doc } = await readXlsx(entries);
  assert.equal(doc.meta.title, '季度报表');
  assert.equal(doc.meta.author, '张三');
  assert.equal(doc.meta.created, '2024-03-05T08:30:00Z');
  assert.equal(doc.meta.company, '某某公司');
});

test('统计：惰性表读窗口不改变 modelBytes / cellCount（统计算的是常驻模型）', async () => {
  const rows: string[] = [];
  for (let r = 1; r <= 200; r++) rows.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`);
  const { doc } = await readXlsx(minimalParts(rows.join(''), '<dimension ref="A1:B200001"/>'));
  const sheet = doc.sheets![0];
  assert.ok(sheet instanceof LazyGrid);
  const modelBefore = doc.stats.modelBytes;
  const cellsBefore = doc.stats.cellCount;
  assert.ok(modelBefore > 0, 'modelBytes 应反映常驻的样式/列宽/元数据，而不是 0');
  assert.equal(cellsBefore, 200001 * 2, 'cellCount 用 dimension 区域作上界估算');

  await sheet.readRows(0, 50);
  await sheet.readRows(100, 150);
  assert.equal(doc.stats.modelBytes, modelBefore, '读取窗口不应该改变常驻模型体积');
  assert.equal(doc.stats.cellCount, cellsBefore);
  assert.ok(emptySharedStrings().get(0) === undefined);
  assert.ok(estimateBytes(await sheet.readRows(0, 2)) > 0);
});

/* ==================================================================== */
/* 10. 真实文件交叉验证                                                   */
/* ==================================================================== */

/**
 * 真实第三方 xlsx（WPS 生成，含中日文、合并单元格、日期格式、16379 列格式等）。
 * **不复制进仓库**（含个人数据）：只按绝对路径读，读不到就跳过。
 */
const REAL_FILES = [
  'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\工作簿.xlsx',
  'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\工作簿(1).xlsx',
  'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\工作簿(2).xlsx',
  'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\工作簿(3).xlsx',
  'C:\\Users\\16595\\Desktop\\我的文件\\学生会\\2025年秋季学期第十三周主题班会汇总表 (1).xlsx',
  'C:\\Users\\16595\\Desktop\\我的文件\\学生会\\2026年春季学期第七周班会汇总表.xlsx',
  'C:\\Users\\16595\\Desktop\\我的文件\\学生会\\22数据科学专升本2班团员信息收集表.xlsx',
  'C:\\Users\\16595\\Desktop\\我的文件\\2025年新生入学登记表材料\\新生入学登记表移送清单.xlsx',
  'C:\\Users\\16595\\Downloads\\第十期入党积极分子培训考试成绩（最终成绩）.xlsx',
];

test('真实文件：能打开、行列数合理、文本非空、小表走物化分支', async (t) => {
  const loaded: Array<{ path: string; bytes: Uint8Array }> = [];
  const unreadable: string[] = [];
  for (const path of REAL_FILES) {
    if (!existsSync(path)) continue;
    try {
      loaded.push({ path, bytes: new Uint8Array(readFileSync(path)) });
    } catch {
      // 云盘占位文件（未下载）在 OS 层就 EIO；与「文件不存在」同样处理
      unreadable.push(path);
    }
  }
  if (loaded.length === 0) {
    t.skip(`没有可读的真实 xlsx（候选 ${REAL_FILES.length} 个，不可读 ${unreadable.length} 个）`);
    return;
  }

  console.log(`\n  ── 真实 xlsx 交叉验证（可读 ${loaded.length} / 候选 ${REAL_FILES.length}，云盘占位不可读 ${unreadable.length}）──`);
  let textCells = 0;
  let materialized = 0;
  let sawDate = false;
  let sawMerge = false;
  let sawCustomFmt = false;

  for (const { path, bytes } of loaded) {
    const harness = makeCtx(bytes, path.split('\\').pop() ?? 'real.xlsx');
    const measured = await measure(() => xlsxReader.read(harness.ctx));
    const doc = measured.result;
    assert.equal(doc.kind, 'sheet');
    assert.ok(doc.sheets && doc.sheets.length > 0, `${path} 应解析出工作表`);
    assert.equal(doc.meta.sheetCount, doc.sheets.length);

    let cells = 0;
    let texts = 0;
    let sample = '';
    for (const sheet of doc.sheets) {
      assert.ok(sheet.rowCount >= 0 && sheet.colCount >= 0);
      assert.ok(sheet.rowCount <= 1_048_576 && sheet.colCount <= 16_384);
      const win = await sheet.readRows(0, Math.min(sheet.rowCount, 8));
      for (const row of win) {
        cells += row.cells.length;
        for (const c of row.cells) {
          if (c.t === 's' && c.v.length > 0) {
            texts++;
            if (!sample) sample = c.v;
          }
          if (c.v.match(/^\d{4}-\d{2}-\d{2}/)) sawDate = true;
        }
      }
      if (sheet.merges?.length) sawMerge = true;
      if (sheet.styles.some((s) => s.numFmt && s.numFmt !== 'General')) sawCustomFmt = true;
    }
    assert.ok(cells > 0, `${path} 首屏窗口应有单元格`);
    assert.ok(texts > 0, `${path} 共享字符串解析出的文本不应为空`);
    assert.equal(typeof sample, 'string');
    if (doc.sheets[0] instanceof MaterializedGrid) materialized++;
    textCells += texts;

    console.log(
      `  ${(path.split('\\').pop() ?? '').padEnd(42)} 表数=${doc.sheets.length} ` +
        `首表=${doc.sheets[0].rowCount}×${doc.sheets[0].colCount} 分支=${doc.sheets[0] instanceof LazyGrid ? 'LazyGrid' : 'MaterializedGrid'} ` +
        `首屏格数=${cells} 文本格=${texts} 解析=${measured.ms.toFixed(0)}ms 堆增量=${formatBytes(measured.heapDeltaBytes)} ` +
        `warnings=${doc.stats.warnings.length}${doc.stats.truncated.length ? ` truncated=${doc.stats.truncated.join(',')}` : ''}`,
    );
    if (doc.stats.warnings.length) console.log(`      警告：${doc.stats.warnings.join(' | ')}`);
    console.log(`      抽样：${JSON.stringify(sample)}`);
  }

  assert.ok(textCells > 0);
  assert.equal(materialized, loaded.length, '这些小文件必须全部走 MaterializedGrid 分支（不能因为小而走错路径）');
  console.log(
    `  小结：${loaded.length} 个文件全部物化；命中日期格式=${sawDate} 合并区=${sawMerge} 自定义数字格式=${sawCustomFmt}，共享字符串文本格合计=${textCells}\n`,
  );
});
