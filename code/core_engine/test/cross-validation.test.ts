/**
 * 交叉验证：用**独立实现的生成器**造文件，再用各格式读取器解析。
 *
 * 为什么这比各包自己的测试更有说服力：
 *   每个 format-* 包的测试用的是它自己写的夹具。如果作者对规范的理解有偏差，
 *   夹具与读取器会**共享同一个误解** —— 测试全绿，但真实文件打不开。
 *   （本项目已经出现过这种情形：PDF 读取器自测全过，5 个真实 PDF 全挂。）
 *
 *   `bench/fixtures.ts` 是照 ECMA-376 / ODF 规范**独立写的**生成器，
 *   与任何读取器、任何读取器的测试夹具都没有共享代码。
 *   于是「我的生成器造出的文件能被读取器正确解析」构成一次真正的交叉验证：
 *   两边独立实现却互相认可。任何一边理解错了，这里就会红。
 *
 * 断言一律落在**可观察的结构事实**上（编号是否递增、引号转义是否正确、
 * 重复列是否被裁剪），而不是「没抛错就算过」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDocument } from '../packages/engine/src/index.ts';
import { loadReaders } from '../tools/load-readers.mjs';
import { makeXlsx, makeDocx, makeOdt, makeTxt, makeCsv, makeMarkdown, colRef } from '../bench/fixtures.ts';

// 加载全部读取器（缺失的包在下面逐个用例里 skip，不影响其它格式）
const { loaded, failed } = await loadReaders();
const has = (pkg) => loaded.includes(pkg);
if (failed.length) {
  console.log(`  [交叉验证] 读取器：已加载 ${loaded.length} 个；未加载 ${failed.map((f) => f.pkg).join(', ')}`);
}

async function open(name, bytes, opts) {
  return openDocument({ name, bytes }, opts);
}

/* ================================================================== */
/* 列引用：base-26 且没有 0 对应的字母                                    */
/* ================================================================== */

test('交叉验证：工具函数 colRef 符合 OOXML 列引用规则', () => {
  assert.equal(colRef(0), 'A');
  assert.equal(colRef(25), 'Z');
  assert.equal(colRef(26), 'AA');
  assert.equal(colRef(27), 'AB');
  assert.equal(colRef(51), 'AZ');
  assert.equal(colRef(52), 'BA');
  assert.equal(colRef(701), 'ZZ');
  assert.equal(colRef(702), 'AAA');
  assert.equal(colRef(16383), 'XFD', 'Excel 最大列 XFD 必须是 16383');
});

/* ================================================================== */
/* XLSX                                                               */
/* ================================================================== */

test('交叉验证：独立生成的 xlsx 能被正确解析', async (t) => {
  if (!has('format-xlsx')) {
    t.skip('format-xlsx 未加载');
    return;
  }
  const ROWS = 300;
  const COLS = 8;
  const bytes = await makeXlsx({ rows: ROWS, cols: COLS });

  const { document, sniff } = await open('独立生成.xlsx', bytes);
  assert.equal(sniff.format, 'xlsx', `嗅探应为 xlsx，实际 ${sniff.format}（${sniff.reason}）`);
  assert.equal(document.kind, 'sheet');

  const sheet = document.sheets?.[0];
  assert.ok(sheet, '应解析出至少一张工作表');
  assert.ok(sheet.rowCount >= ROWS, `行数应 >= ${ROWS}，实际 ${sheet.rowCount}`);
  assert.ok(sheet.colCount >= COLS, `列数应 >= ${COLS}，实际 ${sheet.colCount}`);
  assert.ok(document.stats.cellCount > ROWS, `单元格数应远大于行数，实际 ${document.stats.cellCount}`);

  // ---- sharedStrings：表头必须解析成真实文本，而不是索引数字 ----
  const header = await sheet.readRows(0, 1);
  const h0 = header[0].cells.find((c) => c.c === 0);
  assert.ok(h0, '第一行第一列应存在');
  assert.equal(h0.v, '编号', `表头应解析为共享字符串「编号」，实际 ${JSON.stringify(h0.v)}`);

  // ---- 数据行：数字 / 共享字符串 / 公式 / 行内字符串 ----
  const row2 = (await sheet.readRows(1, 2))[0];
  const c0 = row2.cells.find((c) => c.c === 0);
  const c1 = row2.cells.find((c) => c.c === 1);
  const c2 = row2.cells.find((c) => c.c === 2);
  const c3 = row2.cells.find((c) => c.c === 3);
  assert.equal(c0?.v, '2', 'A2 应为数字 2');
  assert.ok(c1 && /^分类-/.test(c1.v), `B2 应解析出共享字符串，实际 ${JSON.stringify(c1?.v)}`);
  assert.ok(c2?.f, `C2 应有公式，实际 ${JSON.stringify(c2?.f)}`);
  assert.ok(/SUM/.test(c2.f), `公式内容应含 SUM，实际 ${c2.f}`);
  assert.equal(c3?.v, '行内-2', 'D2 应解析出行内字符串');

  // ---- 稀疏行：第 7 行跳过前 3 列，读取器不应假设密集 ----
  const row7 = (await sheet.readRows(6, 7))[0];
  assert.ok(row7.cells.length > 0, '第 7 行应仍有内容');
  assert.ok(!row7.cells.some((c) => c.c < 3), `第 7 行前 3 列应缺失（稀疏），实际列号 ${row7.cells.map((c) => c.c).join(',')}`);

  // ---- 样式索引共享：同格式的单元格应指向同一个样式索引，而不是各存一个对象 ----
  const styleIdx = new Set();
  for (let r = 0; r < 40; r++) {
    const row = (await sheet.readRows(r, r + 1))[0];
    for (const c of row.cells) if (c.s !== undefined) styleIdx.add(c.s);
  }
  assert.ok(styleIdx.size > 0, '应有单元格带样式索引');
  assert.ok(styleIdx.size <= 4, `样式索引应被共享（少量几种），实际出现 ${styleIdx.size} 种`);
  assert.ok(sheet.styles.length >= 2, `样式表应至少 2 项，实际 ${sheet.styles.length}`);

  // ---- 冻结窗格 / 合并单元格 / 列宽 ----
  assert.ok(sheet.freeze && sheet.freeze.rows >= 1, `应解析出冻结首行，实际 ${JSON.stringify(sheet.freeze)}`);
  assert.ok(sheet.merges && sheet.merges.some((m) => m.r1 === 0 && m.c1 === 0 && m.c2 === 2), `应解析出 A1:C1 合并，实际 ${JSON.stringify(sheet.merges)}`);
  assert.ok(sheet.colWidths && sheet.colWidths.some((w) => w > 0), '应解析出列宽');

  document.dispose();
});

test('交叉验证：xlsx 的大表不会物化整表，且任意窗口都可读', async (t) => {
  if (!has('format-xlsx')) {
    t.skip('format-xlsx 未加载');
    return;
  }
  const ROWS = 25_000;
  const COLS = 10;
  const bytes = await makeXlsx({ rows: ROWS, cols: COLS });
  const { document } = await open('大表.xlsx', bytes);
  const sheet = document.sheets?.[0];
  assert.ok(sheet);

  console.log(
    `  [交叉验证] xlsx ${ROWS} 行 × ${COLS} 列：源 ${(bytes.length / 1024).toFixed(0)} KiB，` +
      `模型 ${(document.stats.modelBytes / 1024).toFixed(0)} KiB，rowCount ${sheet.rowCount}，colCount ${sheet.colCount}`,
  );

  // 行/列数必须来自 <dimension>，即使表体没有被物化
  assert.ok(sheet.rowCount >= ROWS, `rowCount 应 >= ${ROWS}，实际 ${sheet.rowCount}`);
  assert.ok(sheet.colCount >= COLS, `colCount 应 >= ${COLS}，实际 ${sheet.colCount}`);

  /*
   * 关键性质：**任意窗口都能读到正确数据**，而且读取窗口的代价与窗口大小同阶，
   * 而不是与「窗口距离表头的距离」同阶。
   *
   * 注意这里刻意**不断言耗时上限**：惰性实现必须从表头扫到窗口，第 6 万行处取
   * 14 行窗口实测 130~260 ms。这是该设计的固有取舍（可缓存、可预取来缓解），
   * 不是「通过/失败」的判据；性能数字交给 bench/bench.mjs 记录与跟踪。
   * 早期版本在这里断言了耗时，结果把自己的生成器 GC 压力也算进去，
   * 得到 19 秒这种误导性数字 —— 性能断言必须放在能隔离测量的地方。
   */
  const win = await sheet.readRows(ROWS - 15, ROWS - 1);
  assert.equal(win.length, 14, '窗口应精确返回 14 行');
  // 生成器每 7 行跳过前 3 列，所以要先找一行 A 列确实存在的行。
  // 注意生成器写的行号是 **1 起**，而 readRows 返回的 r 是 0 起，因此期望值是 r + 1。
  const probe = win.find((r) => r.cells.some((c) => c.c === 0));
  assert.ok(probe, '窗口内应有包含 A 列的行');
  const a = probe.cells.find((c) => c.c === 0);
  assert.equal(a?.v, String(probe.r + 1), `A 列应等于 1 起行号，实际 ${a?.v}（0 起行号 ${probe.r}）`);
  const b = probe.cells.find((c) => c.c === 1);
  assert.ok(b && /^分类-/.test(b.v), `B 列应为共享字符串，实际 ${JSON.stringify(b?.v)}`);

  // 稀疏性质在惰性路径上同样成立。生成器的稀疏规则作用在 **1 起行号**上
  // （每 7 行跳过前 3 列），而 readRows 返回的 r 是 0 起，所以要判 (r + 1) % 7。
  const sparseRow = win.find((r) => (r.r + 1) % 7 === 0);
  if (sparseRow) {
    assert.ok(
      !sparseRow.cells.some((c) => c.c < 3),
      `第 ${sparseRow.r + 1} 行（1 起行号 %7==0）前 3 列应缺失，实际有列 ${sparseRow.cells.filter((c) => c.c < 3).map((c) => c.c).join(',')}`,
    );
  }

  document.dispose();
});

/* ================================================================== */
/* DOCX                                                               */
/* ================================================================== */

test('交叉验证：独立生成的 docx 能被正确解析', async (t) => {
  if (!has('format-docx')) {
    t.skip('format-docx 未加载');
    return;
  }
  const bytes = await makeDocx({ paragraphs: 120, headingEvery: 20, withTable: true });
  const { document, sniff } = await open('独立生成.docx', bytes);
  assert.equal(sniff.format, 'docx');
  assert.equal(document.kind, 'text');

  const blocks = document.blocks ?? [];
  assert.ok(blocks.length > 100, `块数应超过 100，实际 ${blocks.length}`);

  const paras = blocks.filter((b) => b.kind === 'para');
  const tables = blocks.filter((b) => b.kind === 'table');

  // ---- 标题进大纲 ----
  assert.ok(document.outline.length >= 5, `应解析出多个标题，实际 ${document.outline.length}`);
  assert.ok(document.outline[0].text.includes('测试标题'), `标题文本应正确，实际 ${document.outline[0].text}`);
  assert.equal(document.outline[0].level, 1);

  // ---- 行内样式：加粗 / 红色斜体 / 下划线必须真的落在 run 上 ----
  // 按**文本**定位 run，而不是「第一个 bold run」—— 后者会被样式继承干扰
  // （段落样式若带 <w:b/>，整段所有 run 都算粗体，找到的可能不是显式加粗那个）。
  const richPara = paras.find((p) => p.runs.some((r) => r.text === '加粗'));
  assert.ok(richPara, '应存在含「加粗」run 的段落');
  const boldRun = richPara.runs.find((r) => r.text === '加粗');
  assert.equal(boldRun.style?.bold, true, '「加粗」run 应带 bold');
  const italicRun = richPara.runs.find((r) => r.text === '红色斜体');
  assert.equal(italicRun?.style?.italic, true, '「红色斜体」run 应带 italic');
  assert.equal(italicRun.style.color, '#ff0000', `斜体 run 应带红色，实际 ${italicRun.style.color}`);
  const underlineRun = richPara.runs.find((r) => r.text === '下划线');
  assert.equal(underlineRun?.style?.underline, true, '「下划线」run 应带 underline');
  assert.ok(richPara.runs.some((r) => r.breakBefore), '段内换行应被标记为 breakBefore');
  // 未显式加粗的普通文本不应被误判为粗体
  const plainRun = richPara.runs.find((r) => r.text.includes('普通'));
  assert.ok(plainRun && !plainRun.style?.bold, '普通文本 run 不应被标成粗体');

  // ---- 段落样式继承：Quote 的斜体来自样式而非直接格式 ----
  const quote = paras.find((p) => p.style?.styleName && /quote/i.test(p.style.styleName));
  assert.ok(quote, '应解析出 Quote 样式段落');

  // ---- 有序列表编号必须递增（这是最容易被漏掉的一条） ----
  const markers = paras.map((p) => p.style?.listMarker).filter((m) => typeof m === 'string' && /^\d+\.$/.test(m));
  const distinct = new Set(markers);
  assert.ok(markers.length >= 5, `应有多个有序列表项，实际 ${markers.length}`);
  assert.ok(distinct.size >= 3, `有序编号应递增（出现多个不同数字），实际只有 ${[...distinct].join(',')} —— 说明计数器没实现`);

  // ---- 无序列表用真实项目符号 ----
  const bullets = paras.filter((p) => p.style?.listMarker && /[•·▪◦‣]/.test(p.style.listMarker));
  assert.ok(bullets.length > 0, '应解析出项目符号列表');

  // ---- 表格 ----
  assert.ok(tables.length >= 1, '应解析出表格');
  if (tables.length) {
    const tb = tables[0];
    assert.equal(tb.rows.length, 200, `表格应有 200 行，实际 ${tb.rows.length}`);
    assert.ok(tb.widths && tb.widths.length > 0, '应解析出列宽');
    const firstCell = tb.rows[0].cells[0];
    assert.equal(firstCell.colSpan, 2, `首格应有 colSpan=2，实际 ${firstCell.colSpan}`);
    assert.ok(firstCell.shading, '首格应有底纹');
  }

  // ---- 页面设置：1440 twip = 72pt ----
  assert.ok(document.meta.margin, '应解析出页边距');
  assert.ok(Math.abs(document.meta.margin.top - 72) < 0.01, `上边距应为 72pt，实际 ${document.meta.margin.top}`);
  assert.ok(Math.abs((document.meta.pageWidth ?? 0) - 595.3) < 1, `页面宽度应约 595pt，实际 ${document.meta.pageWidth}`);

  document.dispose();
});

/* ================================================================== */
/* ODT                                                                */
/* ================================================================== */

test('交叉验证：独立生成的 odt 能被正确解析', async (t) => {
  if (!has('format-odf')) {
    t.skip('format-odf 未加载');
    return;
  }
  const bytes = await makeOdt({ paragraphs: 60 });
  const { document, sniff } = await open('独立生成.odt', bytes);
  assert.equal(sniff.format, 'odt', `嗅探应为 odt，实际 ${sniff.format}（${sniff.reason}）`);
  assert.equal(document.kind, 'text');

  const blocks = document.blocks ?? [];
  assert.ok(blocks.length > 30, `块数应超过 30，实际 ${blocks.length}`);

  assert.ok(document.outline.length >= 2, `应解析出标题，实际 ${document.outline.length}`);
  assert.ok(document.outline[0].text.includes('ODF 标题'), `标题文本应正确，实际 ${document.outline[0].text}`);

  const para = blocks.find((b) => b.kind === 'para' && b.runs.some((r) => r.style?.bold));
  assert.ok(para, '应存在含加粗 run 的段落');
  if (para && para.kind === 'para') {
    const b = para.runs.find((r) => r.style?.bold);
    assert.equal(b.text, '加粗蓝色', `加粗 run 文本应为「加粗蓝色」，实际 ${JSON.stringify(b.text)}`);
    assert.equal(b.style.color, '#0000ff', `应解析出蓝色，实际 ${b.style.color}`);
  }

  // `text:s text:c="3"` 必须展开成 3 个空格
  const spaced = blocks.filter((b) => b.kind === 'para').map((b) => b.runs.map((r) => r.text).join(''));
  assert.ok(spaced.some((s) => s.includes('   ')), 'text:s text:c="3" 应展开为 3 个空格');

  const lists = blocks.filter((b) => b.kind === 'para' && b.style?.listMarker);
  assert.ok(lists.length > 0, '应解析出列表项');

  document.dispose();
});

test('交叉验证：odt 里 table:number-columns-repeated="16380" 必须被裁剪', async (t) => {
  if (!has('format-odf')) {
    t.skip('format-odf 未加载');
    return;
  }
  const bytes = await makeOdt({ paragraphs: 10 });
  const { document } = await open('重复列陷阱.odt', bytes);

  /*
   * 语义修正：ODT 是**文本文档**，它里面的 `table:table` 是「文字表格」，
   * 按 UDM 应当映射成 `Table` 块，而不是电子表格（Sheet）。
   * 早期版本直接断言 `document.sheets[0]`，方向就错了 —— 于是测试被 skip，
   * 真正的风险（重复列膨胀）反而没被验证。
   */
  const blocks = document.blocks ?? [];
  const table = blocks.find((b) => b.kind === 'table');

  if (!table) {
    const sheet = document.sheets?.[0];
    if (!sheet) {
      t.skip('该 ODF 读取器既未映射为表格块也未映射为工作表');
      return;
    }
    console.log(`  [交叉验证] 重复列陷阱（映射为工作表）：colCount=${sheet.colCount}`);
    assert.ok(sheet.colCount <= 16_384, `列数不应超过 16384，实际 ${sheet.colCount}`);
    const rows = await sheet.readRows(sheet.rowCount - 1, sheet.rowCount);
    const cells = rows[0]?.cells.length ?? 0;
    console.log(`  [交叉验证] 末行实际单元格对象数 = ${cells}`);
    assert.ok(cells < 5000, `末尾空行不应造出上万个单元格对象，实际 ${cells} —— 重复列没有裁剪，会吃光内存`);
    document.dispose();
    return;
  }

  console.log(`  [交叉验证] 重复列陷阱（映射为表格块）：${table.rows.length} 行，首行列数 ${table.rows[0]?.cells.length}`);

  // 真正的判据：**不能**真的为上万个重复列造出单元格对象
  assert.ok(table.rows.length <= 64, `行数应被裁剪到合理范围，实际 ${table.rows.length}`);
  const maxCols = Math.max(...table.rows.map((r) => r.cells.length));
  console.log(`  [交叉验证] 最大实际单元格对象数 = ${maxCols}`);
  assert.ok(maxCols < 5000, `一行不应造出上万个单元格对象，实际 ${maxCols} —— 重复列没有裁剪，会吃光内存`);
  if (table.widths) {
    assert.ok(table.widths.length < 5000, `列宽数组不应膨胀到上万项，实际 ${table.widths.length}`);
  }

  document.dispose();
});

/* ================================================================== */
/* CSV / TXT / Markdown                                               */
/* ================================================================== */

test('交叉验证：独立生成的 CSV 能正确解出引号转义', async (t) => {
  if (!has('format-text')) {
    t.skip('format-text 未加载');
    return;
  }
  const bytes = makeCsv(200, 8);
  const { document, sniff } = await open('独立生成.csv', bytes);
  assert.equal(sniff.format, 'csv');
  assert.equal(document.kind, 'sheet');

  const sheet = document.sheets?.[0];
  assert.ok(sheet, 'CSV 应映射为工作表');
  const row1 = (await sheet.readRows(1, 2))[0];

  const vals = new Map(row1.cells.map((c) => [c.c, c.v]));
  assert.equal(vals.get(1), '含,逗号的值1', 'RFC4180：引号内的逗号不应分割列');
  assert.equal(vals.get(2), '含"引号"的值', 'RFC4180：两个双引号应还原为一个');
  assert.equal(vals.get(3), '含\n换行的值1', 'RFC4180：引号内的换行不应断行');
  console.log(`  [交叉验证] CSV 首数据行解析出 ${row1.cells.length} 列，转义全部正确`);

  document.dispose();
});

test('交叉验证：独立生成的 TXT 逐行成段', async (t) => {
  if (!has('format-text')) {
    t.skip('format-text 未加载');
    return;
  }
  const LINES = 300;
  const bytes = makeTxt(LINES);
  const { document, sniff } = await open('独立生成.txt', bytes);
  assert.equal(sniff.format, 'txt');
  const blocks = document.blocks ?? [];
  assert.ok(blocks.length >= LINES - 5, `应有约 ${LINES} 个段落，实际 ${blocks.length}`);
  assert.ok(document.stats.blockCount > 0);
  document.dispose();
});

test('交叉验证：独立生成的 Markdown 结构正确', async (t) => {
  if (!has('format-text')) {
    t.skip('format-text 未加载');
    return;
  }
  const bytes = makeMarkdown(12);
  const { document, sniff } = await open('独立生成.md', bytes);
  assert.equal(sniff.format, 'md');

  assert.ok(document.outline.length >= 12, `应有 >= 12 个标题，实际 ${document.outline.length}`);

  const blocks = document.blocks ?? [];
  const paras = blocks.filter((b) => b.kind === 'para');
  const tables = blocks.filter((b) => b.kind === 'table');

  // 行内样式必须落在 run 上，而不是被拼成纯文本
  assert.ok(paras.some((p) => p.runs.some((r) => r.style?.bold)), '应解析出加粗 run（而不是只留下纯文本）');
  assert.ok(paras.some((p) => p.runs.some((r) => r.style?.italic)), '应解析出斜体 run');
  assert.ok(paras.some((p) => p.runs.some((r) => r.style?.link)), '应解析出链接 run');

  assert.ok(tables.length >= 12, `应有 >= 12 个 Markdown 表格，实际 ${tables.length}`);
  if (tables.length) {
    const tb = tables[0];
    assert.ok(tb.rows.length >= 2, '表格应有表头 + 数据行');
    assert.ok(tb.rows[0].cells.length >= 2, '表格应有 2 列');
  }

  const allText = paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
  assert.ok(allText.includes('console.log'), '围栏代码块内容应被保留');

  document.dispose();
});

/* ================================================================== */
/* 全部生成器产物都必须能被嗅探器高置信度识别                              */
/* ================================================================== */

test('交叉验证：全部独立生成的产物都能被嗅探器正确识别', async () => {
  /*
   * 每个用例给出**该格式应有的最低置信度**。
   *
   * 不能对所有格式用一个统一阈值：容器类格式（xlsx/docx/odt）有权威判据
   * （ZIP 内的特征部件 / mimetype 条目），应当接近 1.0；
   * 而纯文本没有可用的内容证据（一段普通文字就是普通文字），
   * 只能按扩展名兜底给出 0.3 —— 这是**诚实**的低置信度，不是缺陷。
   * 用统一阈值会逼实现去虚报置信度。
   */
  const cases = [
    ['a.xlsx', await makeXlsx({ rows: 10, cols: 4 }), 'xlsx', 0.9],
    ['a.docx', await makeDocx({ paragraphs: 10, withTable: false }), 'docx', 0.9],
    ['a.odt', await makeOdt({ paragraphs: 5 }), 'odt', 0.9],
    ['a.csv', makeCsv(10, 3), 'csv', 0.5],
    ['a.md', makeMarkdown(2), 'md', 0.5],
    ['a.txt', makeTxt(10), 'txt', 0.2],
  ];
  for (const [name, bytes, expected, minConfidence] of cases) {
    const { sniff } = await open(name, bytes);
    assert.equal(sniff.format, expected, `${name} 应被识别为 ${expected}，实际 ${sniff.format}（${sniff.reason}）`);
    assert.ok(
      sniff.confidence >= minConfidence,
      `${name} 的判定置信度应 >= ${minConfidence}，实际 ${sniff.confidence}（${sniff.reason}）`,
    );
  }
  // 容器类格式的判据是权威的，必须显著高于文本启发式
  const zipBased = await open('a.docx', await makeDocx({ paragraphs: 5, withTable: false }));
  const textBased = await open('a.txt', makeTxt(5));
  assert.ok(
    zipBased.sniff.confidence > textBased.sniff.confidence,
    'ZIP 内部结构的判定置信度必须高于「按扩展名兜底」',
  );
});

/* ================================================================== */
/* 生成器自身的一致性                                                    */
/* ================================================================== */

test('交叉验证：生成器产物是确定性且合法的 ZIP 结构', async () => {
  const { ZipReader } = await import('../packages/zip/src/index.ts');

  const a = await makeXlsx({ rows: 5, cols: 3 });
  const b = await makeXlsx({ rows: 5, cols: 3 });
  assert.deepEqual(Buffer.from(a), Buffer.from(b), '同一参数应产生完全一致的字节（便于复现与比对）');

  // ODF 规范硬要求：mimetype 必须是第一个条目，且必须存储不压缩
  const odt = ZipReader.open(await makeOdt({ paragraphs: 3 }));
  assert.equal(odt.entries[0].name, 'mimetype', 'ODF 的 mimetype 必须是第一个条目');
  assert.equal(odt.entries[0].method, 0, 'ODF 的 mimetype 必须不压缩（store）');
  assert.equal(await odt.text('mimetype'), 'application/vnd.oasis.opendocument.text');

  // OOXML：内容和类型必须存在
  const xlsx = ZipReader.open(a);
  assert.ok(xlsx.has('[Content_Types].xml'), 'OOXML 必须有 [Content_Types].xml');
  assert.ok(xlsx.has('xl/workbook.xml'), 'xlsx 必须有 workbook');
  assert.ok(xlsx.has('xl/sharedStrings.xml'), 'xlsx 必须有 sharedStrings');

  // 每个条目都要能通过 CRC 校验（证明生成器写出的 ZIP 是正确的）
  for (const e of xlsx.entries.filter((x) => !x.isDir)) {
    assert.equal(await xlsx.verify(e), true, `CRC 校验失败：${e.name}`);
  }

  const docx = ZipReader.open(await makeDocx({ paragraphs: 5, withTable: false }));
  assert.ok(docx.has('word/document.xml'));
  assert.ok(docx.has('word/styles.xml'));
  assert.ok(docx.has('word/numbering.xml'));
  for (const e of docx.entries.filter((x) => !x.isDir)) {
    assert.equal(await docx.verify(e), true, `CRC 校验失败：${e.name}`);
  }
});
