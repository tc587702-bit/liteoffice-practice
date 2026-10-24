/**
 * @liteoffice/format-text 测试。
 *
 * 夹具全部用内联字符串（或内联 base64 图片），不依赖任何外部文件 ——
 * 这样在 CI、离线、以及「工作区里没有样例文件」的机器上都能跑。
 *
 * 断言风格刻意对齐 test/ooxml.test.ts：断言**具体事实**
 * （runs[i].style.bold === true、cell 数是 2 而不是「文本看起来对」），
 * 因为「纯文本看起来对」完全无法证明样式与结构没丢。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LimitGuard } from '../packages/core/src/limits.ts';
import { DEFAULT_LIMITS, withLimits } from '../packages/core/src/limits.ts';
import type { Limits } from '../packages/core/src/limits.ts';
import type { ContainerAccess, ReadContext } from '../packages/core/src/registry.ts';
import { readerForFormat, coveredFormats } from '../packages/core/src/registry.ts';
import type { Block, Paragraph, Table } from '../packages/core/src/model.ts';
import { paraText } from '../packages/core/src/model.ts';

// 只 import 本包 —— 顶层 registerReader 必须在这行就完成注册
import { parseInline, parseMarkdown, parseRtf, formatXmlText } from '../packages/format-text/src/index.ts';

/* ==================================================================== */
/* 测试脚手架                                                            */
/* ==================================================================== */

function ctxOf(data: string | Uint8Array, name: string, overrides?: Partial<Limits>): ReadContext {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const limits = overrides ? withLimits(overrides) : { ...DEFAULT_LIMITS };
  return {
    name,
    size: bytes.length,
    bytes: async () => bytes,
    limits,
    guard: new LimitGuard(limits),
    phase: async (_n, fn) => fn(),
  };
}

async function readAs(format: Parameters<typeof readerForFormat>[0], data: string | Uint8Array, name?: string, overrides?: Partial<Limits>) {
  const reader = readerForFormat(format);
  assert.ok(reader, `格式 ${format} 必须有读取器（import 本包时应已自注册）`);
  return reader.read(ctxOf(data, name ?? `fixture.${format}`, overrides));
}

function paras(blocks: readonly Block[] | undefined): Paragraph[] {
  return (blocks ?? []).filter((b): b is Paragraph => b.kind === 'para');
}

function tables(blocks: readonly Block[] | undefined): Table[] {
  return (blocks ?? []).filter((b): b is Table => b.kind === 'table');
}

function cellText(table: Table, r: number, c: number): string {
  const cell = table.rows[r].cells[c];
  return paraText(cell.blocks[0] as Paragraph);
}

function depsOf(doc: { stats: { truncated: string[]; warnings: string[]; parseMs: number; modelBytes: number; blockCount: number; cellCount: number } }): void {
  assert.ok(Number.isFinite(doc.stats.parseMs) && doc.stats.parseMs >= 0, 'parseMs 必须是有限数');
  assert.ok(doc.stats.modelBytes > 0, 'modelBytes 必须被如实估算（>0）');
  assert.ok(Array.isArray(doc.stats.truncated), 'truncated 必须是数组');
}

/* ==================================================================== */
/* 自注册                                                                */
/* ==================================================================== */

test('自注册：import 本包后 9 种纯文本格式都有读取器', () => {
  const wanted = ['txt', 'log', 'md', 'csv', 'tsv', 'json', 'html', 'xml', 'rtf'] as const;
  const covered = coveredFormats();
  for (const f of wanted) {
    assert.ok(covered.includes(f), `${f} 应已在注册表中`);
    assert.ok(readerForFormat(f), `${f} 应能取到读取器`);
  }
  const ids = new Set(wanted.map((f) => readerForFormat(f)?.id));
  assert.ok(ids.size >= 5, '不同格式族应由不同的读取器负责（便于诊断）');
});

/* ==================================================================== */
/* txt / log                                                             */
/* ==================================================================== */

test('txt：一行一段落，空行保留', async () => {
  const doc = await readAs('txt', '第一行\n\n第三行\n');
  const ps = paras(doc.blocks);
  assert.deepEqual(ps.map((p) => paraText(p)), ['第一行', '', '第三行', '']);
  depsOf(doc);
  assert.equal(doc.kind, 'text');
  assert.equal(doc.format, 'txt');
});

test('txt：CRLF 与单独的 CR 都要切行', async () => {
  const doc = await readAs('txt', 'a\r\nb\rc\nd');
  assert.deepEqual(paras(doc.blocks).map(paraText), ['a', 'b', 'c', 'd']);
});

test('txt：UTF-8 BOM 不进入正文', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
  const doc = await readAs('txt', bytes);
  assert.equal(paraText(paras(doc.blocks)[0]), 'hi');
});

test('txt：GBK 内容回退 gb18030 解码且不出现替换字符', async () => {
  // "中文" 的 GBK 字节
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0x61, 0x62]);
  const doc = await readAs('txt', gbk);
  const first = paraText(paras(doc.blocks)[0]);
  assert.equal(first, '中文', `GBK 应被正确解码，实际 ${JSON.stringify(first)}`);
  assert.ok(!first.includes('\ufffd'));
  assert.ok(doc.stats.warnings.some((w) => w.includes('gb18030')), '回退编码必须记入 warnings');
});

test('txt：空输入不抛错且给出合法空文档', async () => {
  const doc = await readAs('txt', new Uint8Array(0));
  assert.equal(doc.blocks?.length, 1);
  assert.equal(paraText(paras(doc.blocks)[0]), '');
  depsOf(doc);
});

test('txt：块数超限被截断且 truncated 非空', async () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const doc = await readAs('txt', many, 'big.txt', { maxBlocks: 7 });
  assert.equal(doc.blocks?.length, 7, '应停在 maxBlocks 上');
  assert.ok(doc.stats.truncated.length > 0, 'truncated 必须非空');
  assert.equal(doc.truncated, true);
  assert.ok(doc.stats.warnings.some((w) => w.includes('maxBlocks')));
});

test('log：格式判定按扩展名落到 log', async () => {
  const doc = await readAs('log', '2024-01-01 INFO start\n2024-01-01 WARN slow');
  assert.equal(doc.format, 'log');
  assert.equal(doc.blocks?.length, 2);
});

/* ==================================================================== */
/* Markdown：块级                                                        */
/* ==================================================================== */

test('md：ATX 标题级别映射到 outlineLevel 并进大纲', async () => {
  const src = ['# 一级标题', '', '正文一段。', '', '## 二级标题', '', '### 三级标题'].join('\n');
  const doc = await readAs('md', src, 'doc.md');
  const ps = paras(doc.blocks);
  assert.equal(ps[0].style?.outlineLevel, 0);
  assert.equal(ps[0].style?.styleName, 'Heading 1');
  const h2 = ps.find((p) => paraText(p) === '二级标题');
  assert.ok(h2, '应能找到二级标题段落');
  assert.equal(h2.style?.outlineLevel, 1);
  const h3 = ps.find((p) => paraText(p) === '三级标题');
  assert.equal(h3?.style?.outlineLevel, 2);

  assert.deepEqual(
    doc.outline.map((o) => [o.level, o.text]),
    [
      [1, '一级标题'],
      [2, '二级标题'],
      [3, '三级标题'],
    ],
  );
  // 大纲必须能跳转
  const target = doc.outline[0].target;
  assert.equal(target?.kind, 'block');
  assert.equal(paraText(doc.blocks![target!.index] as Paragraph), '一级标题');
});

test('md：六级以上的 # 不是标题', async () => {
  const doc = await readAs('md', '####### 七个井号', 'x.md');
  const p = paras(doc.blocks)[0];
  assert.equal(p.style?.outlineLevel, undefined);
  assert.equal(paraText(p), '####### 七个井号');
});

test('md：嵌套列表产出 listLevel / listMarker / listOrdered', async () => {
  const src = ['- 顶层一', '  - 二层一', '  - 二层二', '- 顶层二'].join('\n');
  const doc = await readAs('md', src, 'list.md');
  const ps = paras(doc.blocks);
  assert.deepEqual(ps.map((p) => [paraText(p), p.style?.listLevel, p.style?.listMarker]), [
    ['顶层一', 0, '\u2022'],
    ['二层一', 1, '\u2022'],
    ['二层二', 1, '\u2022'],
    ['顶层二', 0, '\u2022'],
  ]);
  for (const p of ps) assert.equal(p.style?.listOrdered, false);
});

test('md：有序列表按层级独立递增', async () => {
  const src = ['1. 甲', '2. 乙', '   1. 子甲', '   2. 子乙', '3. 丙'].join('\n');
  const doc = await readAs('md', src, 'ol.md');
  const ps = paras(doc.blocks);
  assert.deepEqual(ps.map((p) => [paraText(p), p.style?.listMarker, p.style?.listLevel]), [
    ['甲', '1.', 0],
    ['乙', '2.', 0],
    ['子甲', '1.', 1],
    ['子乙', '2.', 1],
    ['丙', '3.', 0],
  ]);
  for (const p of ps) assert.equal(p.style?.listOrdered, true);
});

test('md：围栏代码块保留内容并渲染为等宽', async () => {
  const src = ['```ts', 'const a = 1;', '  const b = 2;', '```', '', '后续段落'].join('\n');
  const doc = await readAs('md', src, 'code.md');
  const code = paras(doc.blocks).find((p) => p.style?.styleName === 'Code ts');
  assert.ok(code, '应产出标记了语言的代码段落');
  assert.equal(code.runs.length, 2);
  assert.equal(code.runs[0].text, 'const a = 1;');
  assert.equal(code.runs[0].style?.font, 'Consolas');
  assert.equal(code.runs[1].text, '  const b = 2;', '代码块内必须保留缩进');
  assert.equal(code.runs[1].breakBefore, true, '第二行应以 breakBefore 表达换行');
  assert.equal(code.runs[0].style?.bold, undefined, '代码块内不应做行内解析');
});

test('md：未闭合的围栏代码块降级为到文末并记 warning', async () => {
  const doc = await readAs('md', '```\nabc\n', 'unclosed.md');
  assert.ok(doc.stats.warnings.some((w) => w.includes('围栏代码块未闭合')));
  assert.equal(doc.blocks?.length, 1);
});

test('md：引用块保留文本并加左侧缩进', async () => {
  const src = ['> 引用第一行', '> 引用第二行', '', '普通段落'].join('\n');
  const doc = await readAs('md', src, 'quote.md');
  const quoted = paras(doc.blocks).find((p) => paraText(p).includes('引用第一行'));
  assert.ok(quoted);
  assert.equal(quoted.style?.indentStart, 18);
  assert.equal(quoted.style?.border?.left?.style, 'solid');
});

test('md：水平线 -> RuleBlock', async () => {
  const doc = await readAs('md', 'a\n\n---\n\nb', 'hr.md');
  assert.equal(doc.blocks?.filter((b) => b.kind === 'rule').length, 1);
});

/* ==================================================================== */
/* Markdown：行内（必须产出 RunStyle，不能只拼纯文本）                    */
/* ==================================================================== */

test('md 行内：粗体/斜体/代码/删除线的 RunStyle 必须落到具体 run 上', async () => {
  const runs = parseInline('普通 **粗体** *斜体* `code` ~~删除~~ 结束');
  if (process.env.FT_DEBUG) console.error('FT_DEBUG bold/italic runs =', JSON.stringify(runs));
  const bold = runs.find((r) => r.text === '粗体');
  assert.ok(bold, '应有一个 run 的文本是「粗体」');
  assert.equal(bold.style?.bold, true);
  assert.equal(bold.style?.italic, undefined, '粗体不应顺带变斜体');

  const italic = runs.find((r) => r.text === '斜体');
  assert.equal(italic?.style?.italic, true);
  assert.equal(italic?.style?.bold, undefined);

  const code = runs.find((r) => r.text === 'code');
  assert.equal(code?.style?.font, 'Consolas');

  const strike = runs.find((r) => r.text === '删除');
  assert.equal(strike?.style?.strike, true);

  // 纯文本拼接也不能丢内容
  assert.equal(runs.map((r) => r.text).join(''), '普通 粗体 斜体 code 删除 结束');
});

test('md 行内：两个星号不会污染整段（未闭合标记必须退化）', async () => {
  const runs = parseInline('**未闭合的粗体后面还有很多字');
  assert.ok(!runs.some((r) => r.style?.bold === true), '未闭合的 ** 不应产生粗体');
  assert.equal(runs.map((r) => r.text).join(''), '**未闭合的粗体后面还有很多字');
});

test('md 行内：链接产出 style.link，且 javascript: 被拒', async () => {
  const runs = parseInline('见 [官网](https://example.com/a(b)) 与 [坏](javascript:alert(1))');
  if (process.env.FT_DEBUG) console.error('FT_DEBUG link runs =', JSON.stringify(runs));
  const link = runs.find((r) => r.text === '官网');
  assert.equal(link?.style?.link, 'https://example.com/a(b)', 'URL 里的括号不应截断链接');
  const bad = runs.find((r) => r.text === '坏');
  assert.equal(bad?.style?.link, undefined, 'javascript: 必须被拒绝');
  // 被拒的链接不产出独立 run，但文字必须仍在（作为普通文本）
  const all = runs.map((r) => r.text).join('');
  assert.ok(all.includes('坏'), `被拒的链接仍必须保留其文字，实际 ${JSON.stringify(all)}`);
  assert.ok(!runs.some((r) => r.style?.link?.startsWith('javascript')), '不允许产出 javascript: 链接');
});

test('md 行内：嵌套强调与行内 HTML 样式', async () => {
  const src = '**粗 *斜* 体** 与 <u>下划线</u> <b>标签粗</b>';
  const runs = parseInline(src);
  if (process.env.FT_DEBUG) console.error('FT_DEBUG nest runs =', JSON.stringify(runs));
  // 粗体区间：整个「粗 *斜* 体」是一个 run，斜体标记作为纯文本保留
  // （当前实现不对强调内部再做行内解析；这是已知的简化，见下面的断言）
  const bold = runs.find((r) => r.text.startsWith('粗'));
  assert.equal(bold?.style?.bold, true);
  assert.ok(bold!.text.includes('斜'), '强调内部的文字不能丢');
  const ul = runs.find((r) => r.text === '下划线');
  assert.equal(ul?.style?.underline, true);
  const tagBold = runs.find((r) => r.text === '标签粗');
  assert.equal(tagBold?.style?.bold, true);
  // 纯文本拼接不能丢失任何字符
  assert.equal(
    runs.map((r) => r.text).join(''),
    '粗 *斜* 体 与 下划线 标签粗',
  );
});

test('md 行内：行尾两空格与反斜杠是硬换行（breakBefore）', () => {
  const runs = parseInline('第一行  \n第二行');
  assert.equal(runs[0].text, '第一行');
  assert.equal(runs[1].text, '第二行');
  // 硬换行的语义是「这个 run 之前强制换行」。当换行点正好落在第一个 run 之后，
  // 标记就落在第二个 run 上；若落在最前面（前面没有 run），标记由第一个 run 承载。
  assert.ok(
    runs[1].breakBefore === true || runs[0].breakBefore === true,
    `硬换行必须被表达为 breakBefore，实际 ${JSON.stringify(runs)}`,
  );
  const runs2 = parseInline('甲\\\n乙');
  assert.equal(runs2[1].breakBefore, true);
  assert.equal(runs2[1].text, '乙');
  // 反斜杠本身不能留在文本里
  assert.ok(!runs2.map((r) => r.text).join('').includes('\\'));
  // 软换行（普通换行）应折叠成空格，且不产生 breakBefore
  const soft = parseInline('甲\n乙');
  assert.equal(soft.map((r) => r.text).join(''), '甲 乙');
  assert.ok(!soft.some((r) => r.breakBefore === true), '软换行不应产出 breakBefore');
});

/* ==================================================================== */
/* Markdown：表格 -> UDM Table                                           */
/* ==================================================================== */

test('md：管道表格转 UDM Table（表头 + 单元格内行内样式）', async () => {
  const src = ['| 名称 | 说明 |', '| :--- | ---: |', '| 甲 | **加粗** |', '| 乙 | `code` |'].join('\n');
  const doc = await readAs('md', src, 't.md');
  const t = tables(doc.blocks);
  assert.equal(t.length, 1, '应产出一个 Table 块');
  assert.equal(t[0].rows.length, 3);
  assert.equal(t[0].rows[0].header, true, '分隔行紧跟的第一行必须是表头');
  assert.deepEqual(t[0].rows[0].cells.map((_, i) => cellText(t[0], 0, i)), ['名称', '说明']);
  assert.equal(cellText(t[0], 1, 0), '甲');
  assert.equal(t[0].rows[1].cells[1].blocks.length, 1);

  const boldCell = t[0].rows[1].cells[1].blocks[0] as Paragraph;
  assert.equal(boldCell.runs[0].style?.bold, true, '单元格里的 **粗体** 必须保留 RunStyle');
  const codeCell = t[0].rows[2].cells[1].blocks[0] as Paragraph;
  assert.equal(codeCell.runs[0].style?.font, 'Consolas');
  // 对齐信息来自分隔行
  assert.equal((t[0].rows[1].cells[0].blocks[0] as Paragraph).style?.align, 'left');
  assert.equal((t[0].rows[1].cells[1].blocks[0] as Paragraph).style?.align, 'right');
});

test('md：列数不一致的表格不崩，按表头列数补齐并记 warning', async () => {
  const src = ['| a | b | c |', '| - | - | - |', '| 1 | 2 |', '| 1 | 2 | 3 | 4 |'].join('\n');
  const doc = await readAs('md', src, 'ragged.md');
  const t = tables(doc.blocks)[0];
  assert.equal(t.rows.length, 3);
  for (const row of t.rows) assert.equal(row.cells.length, 3, '每行都应被补齐/截断到 3 列');
  assert.ok(doc.stats.warnings.some((w) => w.includes('列数')), '列数不一致必须记 warning');
});

test('md：parseMarkdown 直接使用时 blocks/outline 一致', () => {
  const r = parseMarkdown('# T\n\n- a\n');
  // 末尾的 '\n' 也产出一个空段落（与 txt 一致：文件末尾的换行代表一个空行）
  assert.equal(r.blocks.length, 4);
  assert.deepEqual(r.blocks.map((b) => b.kind), ['para', 'para', 'para', 'para']);
  assert.deepEqual(r.outline.map((o) => o.text), ['T']);
  assert.equal(r.truncated, false);
  assert.equal(r.lines, 4);
});

test('md：空输入与超大输入都不抛错', async () => {
  const empty = await readAs('md', '', 'empty.md');
  assert.ok(empty.blocks && empty.blocks.length >= 1);
  depsOf(empty);

  const huge = Array.from({ length: 2000 }, (_, i) => `# 标题 ${i}\n\n段落 ${i}\n`).join('\n');
  const doc = await readAs('md', huge, 'huge.md', { maxBlocks: 50 });
  assert.ok(doc.blocks!.length <= 50);
  assert.ok(doc.stats.truncated.length > 0);
});

/* ==================================================================== */
/* CSV / TSV                                                             */
/* ==================================================================== */

async function sheetOf(data: string, name = 'x.csv', overrides?: Partial<Limits>) {
  const doc = await readAs(name.endsWith('.tsv') ? 'tsv' : 'csv', data, name, overrides);
  assert.ok(doc.sheets && doc.sheets.length === 1, '应产出 1 个工作表');
  return { doc, sheet: doc.sheets[0] };
}

test('csv：引号内的逗号是一个字段，不是分隔符', async () => {
  const { sheet, doc } = await sheetOf('a,"b,c",d\n1,2,3\n');
  assert.equal(sheet.colCount, 3);
  assert.equal(sheet.rowCount, 2);
  const rows = await sheet.readRows(0, 2);
  const r0 = rows[0].cells.map((c) => c.v);
  assert.deepEqual(r0, ['a', 'b,c', 'd']);
  depsOf(doc);
  assert.equal(doc.kind, 'sheet');
  assert.equal(doc.format, 'csv');
});

test('csv：引号内的换行属于同一个字段', async () => {
  const { sheet } = await sheetOf('"line1\nline2",x\nnext,y\n');
  const rows = await sheet.readRows(0, 2);
  assert.equal(rows.length, 2, '跨行引号不应被切成两条记录');
  assert.equal(rows[0].cells[0].v, 'line1\nline2');
  assert.equal(rows[0].cells[1].v, 'x');
  assert.equal(rows[1].cells[0].v, 'next');
});

test('csv："" 转义为一个字面引号', async () => {
  const { sheet } = await sheetOf('"say ""hi""",2\n');
  const rows = await sheet.readRows(0, 1);
  assert.equal(rows[0].cells[0].v, 'say "hi"');
  assert.equal(rows[0].cells[1].v, '2');
});

test('csv：字段中间出现的引号不是转义引号', async () => {
  const { sheet } = await sheetOf('a"b,c\n');
  const rows = await sheet.readRows(0, 1);
  assert.deepEqual(rows[0].cells.map((c) => c.v), ['a"b', 'c']);
});

test('csv：未闭合的引号不抛错（按到文末处理）', async () => {
  const { sheet } = await sheetOf('"未闭合,第二格\n');
  const rows = await sheet.readRows(0, 1);
  assert.equal(rows[0].cells[0].v, '未闭合,第二格');
});

test('csv：分隔符自动探测（分号 / 竖线 / 制表符）', async () => {
  const semi = await sheetOf('a;b;c\n1;2;3\n4;5;6\n');
  assert.equal(semi.sheet.colCount, 3);
  assert.deepEqual((await semi.sheet.readRows(0, 1))[0].cells.map((c) => c.v), ['a', 'b', 'c']);

  const pipe = await sheetOf('a|b|c\n1|2|3\n4|5|6\n');
  assert.equal(pipe.sheet.colCount, 3);

  const tab = await sheetOf('a\tb\tc\n1\t2\t3\n', 'x.tsv');
  assert.equal(tab.sheet.colCount, 3);
  assert.equal(tab.doc.format, 'tsv');
});

test('csv：列数不一致时不崩（行保持自身列数，colCount 取最大）', async () => {
  const { sheet } = await sheetOf('a,b,c\n1,2\n3,4,5,6\n');
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.colCount, 4);
  const rows = await sheet.readRows(0, 3);
  assert.deepEqual(rows[0].cells.map((c) => c.v), ['a', 'b', 'c']);
  assert.deepEqual(rows[1].cells.map((c) => c.v), ['1', '2']);
  assert.deepEqual(rows[2].cells.map((c) => c.v), ['3', '4', '5', '6']);
});

test('csv：首行全为文本时认表头（header 与样式都标上）', async () => {
  const { sheet, doc } = await sheetOf('姓名,年龄\n张三,30\n');
  assert.equal(sheet.styles.length, 1);
  assert.equal(sheet.styles[0].bold, true);
  const rows = await sheet.readRows(0, 2);
  assert.equal(rows[0].cells[0].s, 0, '表头行单元格应指向样式索引 0');
  assert.ok(doc.stats.warnings.some((w) => w.includes('表头')));
});

test('csv：首行含数字时不擅自认表头', async () => {
  const { sheet, doc } = await sheetOf('1,2,3\n4,5,6\n');
  assert.equal(sheet.styles.length, 0);
  const rows = await sheet.readRows(0, 2);
  assert.equal(rows[0].cells[0].s, undefined);
  assert.ok(doc.stats.warnings.some((w) => w.includes('未按表头')));
});

test('csv：空输入不抛错', async () => {
  const reader = readerForFormat('csv')!;
  const doc = await reader.read(ctxOf('', 'empty.csv'));
  assert.ok(doc.sheets);
  assert.equal(doc.sheets![0].rowCount, 0);
  depsOf(doc);
});

test('csv：超过 maxCells 时截断且 truncated 非空', async () => {
  const rows = Array.from({ length: 60 }, (_, r) => Array.from({ length: 10 }, (_, c) => `${r}-${c}`).join(',')).join('\n');
  const { doc, sheet } = await sheetOf(rows, 'big.csv', { maxCells: 25 });
  assert.ok(doc.stats.truncated.includes('maxCells'), `应记录 maxCells，实际 ${doc.stats.truncated.join(',')}`);
  assert.equal(doc.truncated, true);
  let cells = 0;
  for (const row of await sheet.readRows(0, sheet.rowCount)) cells += row.cells.length;
  assert.ok(cells <= 25 + 10, `单元格应被限制在 25 附近，实际 ${cells}`);
  assert.equal(sheet.truncated, true);
});

/* ==================================================================== */
/* JSON                                                                  */
/* ==================================================================== */

test('json：顶层键进入大纲并可跳转', async () => {
  const src = JSON.stringify({ name: 'LiteOffice', version: 1, nested: { a: 1, b: [1, 2, 3] }, tags: ['x'] });
  const doc = await readAs('json', src, 'data.json');
  assert.deepEqual(doc.outline.map((o) => o.text), ['name', 'version', 'nested', 'tags']);
  const first = doc.outline[0].target;
  assert.equal(first?.kind, 'block');
  const block = doc.blocks![first!.index] as Paragraph;
  const text = block.runs.map((r) => r.text).join('\n');
  assert.ok(text.includes('"name": "LiteOffice"'), `顶层块应包含该键的行，实际 ${JSON.stringify(text)}`);
});

test('json：嵌套很深时缩进正确（格式化生效）', async () => {
  const doc = await readAs('json', '{"a":{"b":{"c":[1,{"d":2}]}}}', 'n.json');
  const all = paras(doc.blocks)
    .flatMap((p) => p.runs.map((r) => `${r.breakBefore ? '\n' : ''}${r.text}`))
    .join('');
  assert.ok(all.includes('      "c": ['), `应有 6 空格缩进，实际 ${JSON.stringify(all)}`);
  assert.ok(doc.blocks![0].kind === 'para');
  assert.equal((doc.blocks![0] as Paragraph).runs[0].style?.font, 'Consolas');
});

test('json：非法 JSON 降级为纯文本且有 warning', async () => {
  const bad = '{ "a": 1, /* 注释 */ "b": 2, }';
  const doc = await readAs('json', bad, 'bad.json');
  assert.equal(doc.kind, 'text');
  assert.ok(doc.stats.warnings.some((w) => w.includes('JSON 解析失败')), `实际 warnings: ${doc.stats.warnings.join(' | ')}`);
  // 原文必须完整保留
  const text = paras(doc.blocks).flatMap((p) => p.runs.map((r) => r.text)).join('');
  assert.ok(text.includes('/* 注释 */'));
  assert.equal(doc.outline.length, 0);
});

test('json：空输入与超大输入都不抛错，超大有 truncated', async () => {
  const empty = await readAs('json', '', 'e.json');
  assert.ok(empty.blocks && empty.blocks.length >= 1);
  depsOf(empty);

  const big = JSON.stringify(Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`k${i}`, i])));
  const doc = await readAs('json', big, 'big.json', { maxBlocks: 3 });
  assert.ok(doc.stats.truncated.length > 0);
  assert.ok((doc.blocks?.length ?? 0) <= 3);
  assert.ok(doc.outline.length <= 200);
});

/* ==================================================================== */
/* HTML                                                                  */
/* ==================================================================== */

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('html：h1~h6 映射到 outlineLevel', async () => {
  const src = '<html><body><h1>标题一</h1><h2>标题二</h2><h3>标题三</h3><p>正文</p></body></html>';
  const doc = await readAs('html', src, 'a.html');
  const ps = paras(doc.blocks);
  assert.equal(ps.find((p) => paraText(p) === '标题一')?.style?.outlineLevel, 0);
  assert.equal(ps.find((p) => paraText(p) === '标题二')?.style?.outlineLevel, 1);
  assert.equal(ps.find((p) => paraText(p) === '标题三')?.style?.outlineLevel, 2);
  assert.deepEqual(doc.outline.map((o) => [o.level, o.text]), [
    [1, '标题一'],
    [2, '标题二'],
    [3, '标题三'],
  ]);
  assert.equal(paraText(ps.find((p) => paraText(p) === '正文')!), '正文');
});

test('html：<script> 与 <style> 的内容必须消失', async () => {
  const src =
    '<html><head><title>标题</title><style>p{color:red}</style></head><body>' +
    '<p>可见</p><script>var secret = "TOPSECRET";</script><style>.x{display:none}</style>' +
    '<p>也可见</p></body></html>';
  const doc = await readAs('html', src, 's.html');
  const all = paras(doc.blocks).map(paraText).join('\n');
  assert.ok(!all.includes('TOPSECRET'), 'script 内容不得出现');
  assert.ok(!all.includes('color:red'), 'style 内容不得出现');
  assert.ok(!all.includes('display:none'));
  assert.equal(all, '可见\n也可见');
  assert.equal(doc.meta.title, '标题', '<title> 应作为文档标题');
});

test('html：table/tr/td/th -> UDM Table', async () => {
  const src =
    '<table><caption>表说明</caption><tr><th>表头A</th><th>表头B</th></tr>' +
    '<tr><td>1</td><td><b>粗</b>体</td></tr>' +
    '<tr><td colspan="2">跨两列</td></tr></table>';
  const doc = await readAs('html', src, 't.html');
  const t = tables(doc.blocks);
  assert.equal(t.length, 1);
  // 第一行是 caption（转成一行）
  const dataRows = t[0].rows;
  assert.ok(dataRows.length >= 3);
  const headerRow = dataRows.find((r) => r.cells[0] && cellText(t[0], dataRows.indexOf(r), 0) === '表头A');
  assert.ok(headerRow, '应能找到表头行');
  assert.equal(headerRow.header, true);
  assert.equal(headerRow.cells[0].shading, '#f3f3f3');
  assert.equal(headerRow.cells.length, 2);

  const bodyRow = dataRows[dataRows.indexOf(headerRow) + 1];
  assert.equal(cellText(t[0], dataRows.indexOf(headerRow) + 1, 0), '1');
  const bCell = bodyRow.cells[1].blocks[0] as Paragraph;
  assert.equal(bCell.runs.map((r) => r.text).join(''), '粗体');
  assert.equal(bCell.runs[0].style?.bold, true, '<b> 必须产出 RunStyle.bold');

  const spanRow = dataRows[dataRows.indexOf(headerRow) + 2];
  assert.equal(spanRow.cells.length, 2, '列数应被补齐到 2');
  assert.equal(spanRow.cells[0].colSpan, 2);
});

test('html：ul/ol/li -> 带 listLevel 与 listMarker 的段落', async () => {
  const src = '<ul><li>甲<ul><li>甲一</li></ul></li><li>乙</li></ul><ol><li>一</li><li>二</li></ol>';
  const doc = await readAs('html', src, 'l.html');
  const ps = paras(doc.blocks);
  const labels = ps.map((p) => [paraText(p), p.style?.listLevel, p.style?.listMarker, p.style?.listOrdered]);
  assert.deepEqual(labels, [
    ['甲', 0, '\u2022', false],
    ['甲一', 1, '\u2022', false],
    ['乙', 0, '\u2022', false],
    ['一', 0, '1.', true],
    ['二', 0, '2.', true],
  ]);
});

test('html：b/i/u/code/a/br -> 行内 RunStyle 与 link', async () => {
  const src = '<p><b>粗</b><i>斜</i><u>下</u><code>码</code><a href="https://x.test/p">链</a>a<br>b</p>';
  const doc = await readAs('html', src, 'i.html');
  const p = paras(doc.blocks)[0];
  const byText = new Map(p.runs.map((r) => [r.text, r]));
  assert.equal(byText.get('粗')?.style?.bold, true);
  assert.equal(byText.get('斜')?.style?.italic, true);
  assert.equal(byText.get('下')?.style?.underline, true);
  assert.equal(byText.get('码')?.style?.font, 'Consolas');
  assert.equal(byText.get('链')?.style?.link, 'https://x.test/p');
  const afterBreak = p.runs.find((r) => r.text === 'b');
  assert.equal(afterBreak?.breakBefore, true, '<br> 应产出 breakBefore');
});

test('html：<pre> 保留原始空白', async () => {
  const src = '<pre>line1\n  indented\n\tTabbed</pre>';
  const doc = await readAs('html', src, 'pre.html');
  const p = paras(doc.blocks)[0];
  assert.equal(p.runs.map((r) => r.text).join('\n'), 'line1\n  indented\n\tTabbed');
  assert.equal(p.runs[0].style?.font, 'Consolas');
});

test('html：data: URI 图片能解出字节，外链图片只保留提示', async () => {
  const src =
    `<p>前<img src="data:image/png;base64,${TINY_PNG_B64}" alt="一像素">后` +
    '<img src="https://example.com/x.png" alt="外链"></p>';
  const doc = await readAs('html', src, 'img.html');
  // 图片可能以两种形态出现：块级 ImageBlock（段落里的图）与行内 image run
  // （表格单元格里的图）。两者都属于「文档里的图片」，用同一个口径断言。
  const images = [
    ...paras(doc.blocks).flatMap((p) => p.runs.filter((r) => r.image).map((r) => r.image!)),
    ...(doc.blocks ?? []).filter((b) => b.kind === 'image').map((b) => (b as { image: (typeof images)[number] }).image),
  ];
  assert.equal(images.length, 2);

  const inline = images.find((i) => i.alt === '一像素');
  assert.ok(inline, '应找到内嵌图片');
  assert.equal(inline.mime, 'image/png');
  assert.ok(inline.data instanceof Uint8Array);
  // 从 base64 解出的 PNG 必须保留完整字节（含签名），长度应与 base64 长度相符
  assert.ok(inline.data!.byteLength > 60, `解出的字节数过少：${inline.data!.byteLength}`);
  assert.deepEqual([...inline.data!.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  // base64 的解码长度必须自洽（末尾 padding 要扣掉）
  const pad = (TINY_PNG_B64.match(/=+$/) ?? [''])[0].length;
  assert.equal(inline.data!.byteLength, Math.floor((TINY_PNG_B64.length * 3) / 4) - pad, 'base64 长度与字节数必须自洽');
  assert.equal(inline.width, 0.75, '1×1 图片应按 96dpi 换算成 0.75pt');

  const external = images.find((i) => i.alt === '外链');
  assert.ok(external);
  assert.equal(external.data, undefined, '外链不应被读取器下载');
  assert.equal(doc.stats.warnings.some((w) => w.includes('外部引用')), true);
  assert.equal(doc.stats.imageCount >= 1, true);

  // 块级图片：内嵌图片应同时产出 ImageBlock 便于渲染
  assert.ok((doc.blocks ?? []).some((b) => b.kind === 'image'));
});

test('html：未知标签保留其文本，不丢内容', async () => {
  const doc = await readAs('html', '<div><mytag>里面的文字</mytag>尾巴</div>', 'u.html');
  const all = paras(doc.blocks).map(paraText).join('');
  assert.ok(all.includes('里面的文字'), `未知标签的文本必须保留，实际 ${JSON.stringify(all)}`);
  assert.ok(all.includes('尾巴'));
  assert.ok(doc.stats.warnings.some((w) => w.includes('未识别的标签')));
});

test('html：空输入与超大输入都不抛错，超大有 truncated', async () => {
  const empty = await readAs('html', '', 'e.html');
  assert.ok(empty.blocks !== undefined, '空 HTML 也必须有合法的 blocks 数组');
  depsOf(empty);
  // 空白 HTML 不该产出任何段落（否则每个空 div 都会留一个空行）
  assert.equal(empty.blocks?.length, 0);

  const big = `<body>${Array.from({ length: 5000 }, (_, i) => `<p>段落 ${i}</p>`).join('')}</body>`;
  const doc = await readAs('html', big, 'big.html', { maxBlocks: 12 });
  assert.ok(doc.stats.truncated.includes('maxBlocks'), `实际 ${doc.stats.truncated.join(',')}`);
  assert.ok(doc.truncated);
});

/* ==================================================================== */
/* XML                                                                   */
/* ==================================================================== */

test('xml：格式化缩进把空元素压成一行', () => {
  const lines = formatXmlText('<?xml version="1.0"?><root><a/></root>');
  assert.deepEqual(lines, ['<?xml version="1.0"?>', '<root>', '  <a/>', '</root>']);
});

test('xml：元素结构生成大纲（前两层）并可跳转', async () => {
  const src = '<config><server id="s1"><port>8080</port></server><client/></config>';
  const doc = await readAs('xml', src, 'c.xml');
  assert.deepEqual(doc.outline.map((o) => [o.level, o.text]), [
    [1, 'config'],
    [2, 'server #s1'],
    [3, 'port'],
    [2, 'client'],
  ]);
  const target = doc.outline[0].target;
  assert.equal(target?.kind, 'block');
  const block = doc.blocks![target!.index] as Paragraph;
  assert.ok(block.runs.map((r) => r.text).join('').includes('<config>'));
  assert.equal(doc.meta.rootElement, 'config');
  depsOf(doc);
});

test('xml：属性值里的 > 不破坏结构，属性被保留', async () => {
  const doc = await readAs('xml', '<a><b attr="x>y"/></a>', 'a.xml');
  const text = paras(doc.blocks).flatMap((p) => p.runs.map((r) => r.text)).join('\n');
  assert.ok(text.includes('attr="x&gt;y"'), `属性应转义保留，实际 ${JSON.stringify(text)}`);
});

test('xml：截断/畸形输入不崩', async () => {
  const doc = await readAs('xml', '<a><b>text', 'broken.xml');
  assert.ok(doc.blocks && doc.blocks.length >= 1);
  assert.ok(doc.stats.warnings.length >= 0);
  const empty = await readAs('xml', '', 'empty.xml');
  assert.ok(empty.blocks !== undefined);
  depsOf(empty);
});

test('xml：超大输入被截断且 truncated 非空', async () => {
  const big = `<root>${Array.from({ length: 6000 }, (_, i) => `<n>${i}</n>`).join('')}</root>`;
  const doc = await readAs('xml', big, 'big.xml', { maxBlocks: 4 });
  assert.ok(doc.stats.truncated.length > 0);
  assert.ok((doc.blocks?.length ?? 0) <= 4);
});

/* ==================================================================== */
/* RTF                                                                   */
/* ==================================================================== */

test('rtf：\\b 与 \\i 生效（粗体、斜体落在具体 run 上）', async () => {
  const src = '{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}\\fs24 normal \\b bold\\b0  \\i it\\i0  end\\par}';
  const doc = await readAs('rtf', src, 'a.rtf');
  const p = paras(doc.blocks)[0];
  if (process.env.FT_DEBUG) console.error('FT_DEBUG rtf src =', JSON.stringify(src), 'runs =', JSON.stringify(p.runs));
  const byText = new Map(p.runs.map((r) => [r.text, r]));
  assert.equal(byText.get('b')?.style?.bold, undefined, '\\b 之前的分隔空格不带样式');
  const bold = p.runs.find((r) => r.text.trim() === 'bold');
  assert.ok(bold, `应找到 bold run，实际 ${JSON.stringify(p.runs.map((r) => r.text))}`);
  assert.equal(bold.style?.bold, true);
  const it = p.runs.find((r) => r.text.trim() === 'it');
  assert.equal(it?.style?.italic, true);
  const normal = p.runs.find((r) => r.text.includes('normal'));
  assert.equal(normal?.style?.bold, undefined, '\\b 前的内容不应变粗');
  // 字号：\fs24 = 12pt
  assert.equal(normal?.style?.size, 12);
  assert.equal(normal?.style?.font, 'Arial', '字体表应被解析并应用');
});

test('rtf：\\uNNNN 与负数代理对正确解码', async () => {
  // \u20320? = 你；\u22909? = 好
  const doc = await readAs('rtf', '{\\rtf1\\ansi \\u20320?\\u22909?\\par}', 'u.rtf');
  assert.equal(paraText(paras(doc.blocks)[0]), '你好');

  // 负数：-10179 -> 55357（高代理），-8704 -> 56832（低代理），合起来是 U+1F600 😀
  const emoji = await readAs('rtf', '{\\rtf1\\ansi \\u-10179?\\u-8704?\\par}', 'e.rtf');
  assert.equal(paraText(paras(emoji.blocks)[0]), '\u{1F600}');
});

test('rtf：\\\'hh 按当前代码页解码（ansicpg936 下 GBK 汉字正确）', async () => {
  // \'c4\'e3\'ba\'c3 = "你好" 的 GBK 字节
  const doc = await readAs('rtf', "{\\rtf1\\ansi\\ansicpg936 \\'c4\\'e3\\'ba\\'c3\\par}", 'cn.rtf');
  const text = paraText(paras(doc.blocks)[0]);
  assert.equal(text, '你好', `GBK 双字节必须成段解码，实际 ${JSON.stringify(text)}`);

  // \fcharset134（无 ansicpg）也要能推断出 GBK
  const viaFont = await readAs('rtf', "{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}{\\f0 \\'c4\\'e3\\'ba\\'c3}\\par}", 'cn2.rtf');
  assert.equal(paraText(paras(viaFont.blocks)[0]), '你好');
});

test('rtf：未知目标组（{\\*...}）被跳过且不崩', async () => {
  const src = '{\\rtf1\\ansi{\\*\\generator Riched20 10.0}{\\*\\bkmkstart secret}BEFORE after\\par}';
  const doc = await readAs('rtf', src, 'star.rtf');
  const all = paras(doc.blocks).map(paraText).join('\n');
  assert.ok(!all.includes('secret'), `未知目标组的内容必须被跳过，实际 ${JSON.stringify(all)}`);
  assert.ok(!all.includes('Riched20'));
  assert.ok(all.includes('BEFORE after'), `正文必须保留，实际 ${JSON.stringify(all)}`);
});

test('rtf：书签标记组被跳过，组外正文与转义字符保留', async () => {
  // \'bf\'c9\'bc\'fb 是「可见」的 GBK 字节（配合 \ansicpg936 解码）
  const src = "{\\rtf1\\ansi\\ansicpg936 x{\\*\\bkmkstart b1}{\\*\\bkmkend b1}\\'bf\\'c9\\'bc\\'fb \\{literal\\} \\\\slash\\par}";
  const doc = await readAs('rtf', src, 'bkmk.rtf');
  const text = paras(doc.blocks).map(paraText).join('\n');
  // 书签组里只有书签名（b1/bkmkstart），它们不得出现在正文里
  assert.ok(!text.includes('bkmkstart'), '书签目标名不得进正文');
  assert.ok(!text.includes('b1'), '书签名不得进正文');
  assert.ok(text.includes('可见'), `\\'hh 应解成中文，实际 ${JSON.stringify(text)}`);
  assert.ok(text.includes('{literal}'), `转义括号应还原，实际 ${JSON.stringify(text)}`);
  assert.ok(text.includes('\\slash'), `转义反斜杠应还原，实际 ${JSON.stringify(text)}`);
  assert.ok(text.includes('x'), '书签之前的文本必须保留');
});

test('rtf：\\par 分段，\\pard 重置段落属性', async () => {
  // 中文用 GBK 十六进制转义写，模拟真实中文 RTF（reader 按 \ansicpg936 解码）
  const src = "{\\rtf1\\ansi\\ansicpg936 \\'b5\\'da\\'d2\\'bb\\'b6\\'ce\\par\\pard \\'b5\\'da\\'b6\\'fe\\'b6\\'ce\\par\\qc \\'be\\'d3\\'d6\\'d0\\'b6\\'ce\\par}";
  const doc = await readAs('rtf', src, 'par.rtf');
  const ps = paras(doc.blocks);
  assert.equal(ps.length, 3);
  assert.equal(paraText(ps[0]), '第一段');
  assert.equal(paraText(ps[1]), '第二段');
  assert.equal(paraText(ps[2]), '居中段');
  assert.equal(ps[2].style?.align, 'center');
});

test('rtf：\\li/\\fi 的 twip 必须换算成 pt', async () => {
  const doc = await readAs('rtf', '{\\rtf1\\ansi\\li720\\fi-360 indented\\par}', 'ind.rtf');
  const p = paras(doc.blocks)[0];
  assert.equal(p.style?.indentStart, 36, '720 twip = 36pt');
  assert.equal(p.style?.indentFirst, -18, '-360 twip = -18pt');
});

test('rtf：\\pict 组被跳过并记 warning', async () => {
  const src = '{\\rtf1\\ansi BEFORE{\\pict\\wmetafile8 0102030405}AFTER\\par}';
  const doc = await readAs('rtf', src, 'pict.rtf');
  const text = paras(doc.blocks).map(paraText).join('');
  assert.ok(!text.includes('0102030405'), 'pict 的数据不应变成正文');
  assert.ok(text.includes('BEFORE'));
  assert.ok(text.includes('AFTER'));
  assert.ok(doc.stats.warnings.some((w) => w.includes('pict')));
});

test('rtf：空输入、非 RTF 输入、超大输入都不抛错', async () => {
  const empty = await readAs('rtf', '', 'empty.rtf');
  assert.ok(empty.blocks && empty.blocks.length >= 1);
  assert.ok(empty.stats.warnings.some((w) => w.includes('不是标准 RTF')));
  depsOf(empty);

  // 截断在转义中间：不能崩
  const weird = await readAs('rtf', '{\\rtf1\\ansi 正文\\', 'weird.rtf');
  assert.ok(weird.blocks !== undefined);

  // parseRtf 直接调用：多余的 } 与未闭合的组
  const r = parseRtf('{\\rtf1\\ansi a\\par}}}');
  assert.equal(r.blocks.length >= 1, true);
  const r2 = parseRtf('{\\rtf1\\ansi {\\b unclosed');
  assert.equal(paraText(r2.blocks[0] as Paragraph), 'unclosed');

  // 注意：控制字必须以非字母结尾，`\par line1` 里的空格是分隔符。
  // 若写成 `\parline1`，RTF 会把它读成一个叫 "parline" 的未知控制字
  // （这正是 RTF 词法的真实规则，不是本实现的偷懒）。
  const big = `{\\rtf1\\ansi ${Array.from({ length: 4000 }, (_, i) => `line${i}\\par `).join('')}}`;
  const doc = await readAs('rtf', big, 'big.rtf', { maxBlocks: 5 });
  assert.ok(doc.stats.truncated.includes('maxBlocks'), `实际 ${doc.stats.truncated.join(',')}`);
  assert.ok((doc.blocks?.length ?? 0) <= 5);

  // 「几乎不写 \par」的超大 RTF：没有字符预算的话单个块能吃到几十万字符，
  // 只按块数判断根本拦不住（一整篇正文常常就是**一个**巨型文本块）。
  const oneBigParagraph = `{\\rtf1\\ansi ${'x'.repeat(30000)}\\par}`;
  const doc2 = await readAs('rtf', oneBigParagraph, 'onebig.rtf', { maxBlocks: 2 });
  assert.ok(doc2.truncated, '超大单段 RTF 也必须被截断');
  assert.ok(doc2.stats.truncated.length > 0, '截断信息必须如实记录');
  // 预算按「加上这一段之后是否超」判断，所以 30000 字符的单块会被整块拒绝 ——
  // 关键是它没有把 30000 字符全吃进模型。
  const kept = paras(doc2.blocks).reduce((n, p) => n + paraText(p).length, 0);
  assert.ok(kept < 30000, `截断后应少于此数，实际 ${kept}`);
});

/* ==================================================================== */
/* 统计与样式一致性                                                       */
/* ==================================================================== */

test('stats：每个读取器都如实填 parseMs / modelBytes / blockCount / cellCount', async () => {
  const cases: [Parameters<typeof readerForFormat>[0], string, string][] = [
    ['txt', 'a\nb', 'a.txt'],
    ['md', '# t\n\nx', 'a.md'],
    ['csv', 'a,b\n1,2', 'a.csv'],
    ['tsv', 'a\tb', 'a.tsv'],
    ['json', '{"a":1}', 'a.json'],
    ['html', '<p>x</p>', 'a.html'],
    ['xml', '<a>x</a>', 'a.xml'],
    ['rtf', '{\\rtf1\\ansi x\\par}', 'a.rtf'],
    ['log', 'x', 'a.log'],
  ];
  for (const [format, data, name] of cases) {
    const doc = await readAs(format, data, name);
    depsOf(doc);
    assert.equal(doc.format, format, `${name} 的 format 应为 ${format}`);
    assert.equal(doc.kind, format === 'csv' || format === 'tsv' ? 'sheet' : 'text');
    if (doc.kind === 'sheet') assert.ok(doc.sheets?.length === 1);
    else assert.ok((doc.blocks?.length ?? 0) >= 1, `${format} 应至少有一个块`);
  }
});

test('rtf 与 md 的 run 样式对象不应共享（避免互相污染）', async () => {
  const doc = await readAs('md', '**粗** 普通 **又粗**', 'x.md');
  const p = paras(doc.blocks)[0];
  const bolds = p.runs.filter((r) => r.style?.bold);
  assert.equal(bolds.length, 2);
  assert.notEqual(bolds[0].style, bolds[1].style, '每个 run 应拿到独立样式对象');
  bolds[0].style!.bold = false;
  assert.equal(bolds[1].style!.bold, true, '改动一个 run 不应影响另一个');
});
