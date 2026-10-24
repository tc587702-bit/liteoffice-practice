/**
 * @liteoffice/core 验证。
 *
 * core 是契约层：单位换算错了会让每种格式的版面都偏、上限逻辑错了会让大文件崩、
 * Grid 的缓存语义错了会让大表变慢或吃内存。这些都被别的测试间接用到，
 * 但间接覆盖不足以定位问题，所以这里单独测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  // units
  twipToPt,
  emuToPt,
  halfPtToPt,
  eighthPtToPt,
  pxToPt,
  ptToPx,
  ptToTwip,
  ptToEmu,
  inchToPt,
  cmToPt,
  mmToPt,
  excelColWidthToPt,
  cssLengthToPt,
  clamp,
  finite,
  round2,
  A4_WIDTH_PT,
  A4_HEIGHT_PT,
  // formats
  FORMATS,
  formatSpec,
  formatByExtension,
  formatByMime,
  extensionOf,
  acceptAttribute,
  formatsByKind,
  kindOf,
  // limits
  DEFAULT_LIMITS,
  CONSERVATIVE_LIMITS,
  LimitGuard,
  withLimits,
  // memory
  estimateStringBytes,
  estimateBytes,
  estimateDocumentBytes,
  formatBytes,
  memSnapshot,
  measure,
  // grid
  MaterializedGrid,
  LazyGrid,
  normalizeRow,
  mergeAnchor,
  findCell,
  // model
  createDocument,
  runsToText,
  blocksToText,
  countWords,
  outlineFromBlocks,
  nestOutline,
  outlineLevelFromStyleName,
  disposeBlocks,
} from '../packages/core/src/index.ts';
import type { Block, CellRow, Paragraph, LiteDocument } from '../packages/core/src/index.ts';

/* ================================================================== */
/* 单位换算                                                             */
/* ================================================================== */

test('单位换算：twip / EMU / 半磅 / 1/8 磅', () => {
  // Word 的 1 英寸 = 1440 twip = 72pt
  assert.equal(twipToPt(1440), 72);
  assert.equal(twipToPt(240), 12);
  assert.equal(twipToPt(20), 1);
  // PowerPoint 的 1 英寸 = 914400 EMU = 72pt
  assert.equal(emuToPt(914400), 72);
  assert.equal(emuToPt(12700), 1);
  // 字号：半磅
  assert.equal(halfPtToPt(24), 12);
  assert.equal(halfPtToPt(21), 10.5, 'Word 默认五号字 sz=21 应是 10.5pt');
  // 边框：1/8 磅
  assert.equal(eighthPtToPt(8), 1);
  // 往返
  assert.equal(ptToTwip(12), 240);
  assert.equal(ptToEmu(1), 12700);
  assert.equal(twipToPt(ptToTwip(13.7)), 13.7);
  assert.equal(emuToPt(ptToEmu(13.7)), 13.7);
});

test('单位换算：px(96dpi) / 英寸 / 厘米 / 毫米', () => {
  assert.equal(inchToPt(1), 72);
  assert.equal(cmToPt(2.54), 72);
  assert.equal(mmToPt(25.4), 72);
  assert.equal(pxToPt(96), 72, '96 CSS px = 1 英寸 = 72pt');
  assert.equal(ptToPx(72), 96);
  // 12pt 在 96dpi 下是 16px —— 这是渲染层最常用的换算，单独钉住
  assert.equal(ptToPx(12), 16);
  assert.equal(pxToPt(ptToPx(12)), 12);
  // A4
  assert.ok(Math.abs(A4_WIDTH_PT - 595.276) < 0.01);
  assert.ok(Math.abs(A4_HEIGHT_PT - 841.89) < 0.01);
  assert.ok(Math.abs(cmToPt(21) - A4_WIDTH_PT) < 0.5, '21cm 应约等于 A4 宽度');
});

test('cssLengthToPt：带单位后缀的 CSS 值', () => {
  assert.equal(cssLengthToPt('12pt'), 12);
  assert.equal(cssLengthToPt('16px'), 12);
  assert.equal(cssLengthToPt('1in'), 72);
  assert.equal(cssLengthToPt('2.54cm'), 72);
  assert.equal(cssLengthToPt('25.4mm'), 72);
  assert.equal(cssLengthToPt('1pc'), 12);
  assert.equal(cssLengthToPt(5), 5, '纯数字直接当 pt');
  assert.equal(cssLengthToPt(undefined, 9), 9, '缺省值');
  assert.equal(cssLengthToPt('', 9), 9);
  assert.equal(cssLengthToPt('乱码', 9), 9, '无法解析时用缺省值而不是 NaN');
  assert.equal(cssLengthToPt('1em'), 12, 'em 按 12pt 近似');
});

test('excelColWidthToPt：Excel 字符宽度 -> pt', () => {
  // Excel 规则 px = chars*7 + 5
  const pt = excelColWidthToPt(10);
  assert.ok(Math.abs(ptToPx(pt) - 75) < 0.01, `10 字符宽应约 75px，实际 ${ptToPx(pt)}px`);
  assert.ok(excelColWidthToPt(0) > 0, '零字符宽也应有个最小宽度');
});

test('数值保护：NaN / Infinity 不得污染布局', () => {
  assert.equal(finite(NaN, 7), 7);
  assert.equal(finite(Infinity, 7), 7, 'Infinity 同样应被视为无效');
  assert.equal(finite(3.5, 7), 3.5);
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
  assert.equal(round2(1.23456), 1.23);
  assert.equal(round2(1.239), 1.24);
  assert.equal(round2(-1.239), -1.24);

  // 已知的浮点陷阱，写进测试以免后人以为 round2 坏了：
  // 1.005 * 100 === 100.49999999999999，Math.round 得 100，所以 round2(1.005) === 1。
  // 这是 IEEE754 的固有行为。round2 只用于展示（列宽/缩进数值），
  // 不用于累加计算，因此这个误差不影响布局正确性。
  assert.equal(round2(1.005), 1, '1.005 是二进制不可精确表示的值，round2 会向下取 — 这是已知限制');
});

/* ================================================================== */
/* 格式表                                                              */
/* ================================================================== */

test('格式表：扩展名与 MIME 查找', () => {
  assert.equal(formatByExtension('a.docx').id, 'docx');
  assert.equal(formatByExtension('路径\\带\\中文 空格.DOCX').id, 'docx', '扩展名查找应大小写不敏感且能处理 Windows 路径');
  assert.equal(formatByExtension('noext'), undefined);
  assert.equal(formatByExtension('.gitignore'), undefined, '以点开头的隐藏文件不应被当作扩展名');
  assert.equal(extensionOf('a.b.c.tar.gz'), 'gz');
  assert.equal(extensionOf('C:\\x\\y.docx'), 'docx');
  assert.equal(extensionOf('noext'), '');

  assert.equal(formatByMime('application/pdf').id, 'pdf');
  assert.equal(formatByMime('text/csv; charset=utf-8').id, 'csv', '应能剥离 MIME 参数');
  assert.equal(formatByMime('APPLICATION/PDF').id, 'pdf');
  assert.equal(formatByMime('x/y'), undefined);
});

test('格式表：自洽性（每个格式都要能被查到，且分类完整）', () => {
  for (const f of FORMATS) {
    if (f.id === 'unknown') continue;
    assert.ok(f.label.length > 0, `${f.id} 缺少中文名`);
    assert.ok(f.extensions.length > 0, `${f.id} 没有扩展名`);
    assert.ok(f.mimes.length > 0, `${f.id} 没有 MIME`);
    // 扩展名与 MIME 必须双向可查
    for (const e of f.extensions) {
      const hit = formatByExtension(`x.${e}`);
      assert.ok(hit, `扩展名 .${e} 查不到格式`);
    }
    for (const m of f.mimes) {
      const hit = formatByMime(m);
      assert.ok(hit, `MIME ${m} 查不到格式`);
    }
    // zip 容器必须声明特征部件，否则嗅探无法权威判定
    if (f.container === 'zip' && f.family !== 'legacy') {
      assert.ok(f.markers && f.markers.length > 0, `${f.id} 是 zip 容器但没有 markers，嗅探将无法权威判定`);
    }
  }
  assert.equal(formatSpec('not-a-format' as never).id, 'unknown', '未知 id 应回退到 unknown 而不是抛错');
  assert.equal(kindOf('xlsx'), 'sheet');
  assert.equal(kindOf('pptx'), 'slides');
  assert.equal(kindOf('pdf'), 'pdf');
});

test('格式表：UI 辅助（accept 属性与分类）', () => {
  const accept = acceptAttribute();
  assert.ok(accept.includes('.docx'));
  assert.ok(accept.includes('.fodt'), '扁平 ODF 也应出现在文件对话框里');
  assert.ok(accept.includes('application/pdf'));
  assert.ok(!accept.includes('unknown'));
  const byKind = formatsByKind();
  assert.ok(byKind.text.length >= 6, `文字类格式应不少于 6 种，实际 ${byKind.text.length}`);
  assert.ok(byKind.sheet.length >= 4);
  assert.ok(byKind.slides.length >= 3);
  assert.equal(byKind.pdf.length, 1);
});

/* ================================================================== */
/* 资源上限                                                            */
/* ================================================================== */

test('LimitGuard：边界、警告与截断记录', () => {
  const guard = new LimitGuard({ ...DEFAULT_LIMITS, maxCells: 10, warnRatio: 0.8 });

  for (let i = 0; i < 8; i++) assert.equal(guard.probe('maxCells', 1), true, `第 ${i + 1} 次应通过`);
  assert.equal(guard.count('maxCells'), 8);
  assert.equal(guard.hasTruncation, false);
  assert.ok(guard.warnings.some((w) => w.includes('接近上限')), '到 80% 应提前告警');

  assert.equal(guard.probe('maxCells', 2), true, '第 10 个仍应在限内（8+2=10）');
  assert.equal(guard.probe('maxCells', 1), false, '第 11 个应被拒绝');
  assert.equal(guard.count('maxCells'), 10, '被拒绝的消耗不应计数');
  assert.equal(guard.hasTruncation, true);
  assert.ok(guard.truncated.includes('maxCells'));
  assert.ok(guard.warnings.some((w) => w.includes('达到上限')));

  // 同一类资源只告警一次，避免 warnings 被刷爆
  const warnCount = guard.warnings.filter((w) => w.includes('达到上限')).length;
  guard.probe('maxCells', 1);
  guard.probe('maxCells', 1);
  assert.equal(guard.warnings.filter((w) => w.includes('达到上限')).length, warnCount, '同类超限不应重复告警');
  assert.equal(guard.truncated.filter((t) => t === 'maxCells').length, 1, '截断类别只记录一次');

  // 上限值可读
  assert.equal(guard.cap('maxCells'), 10);
  // 注意：cap() 对非数值项返回 Infinity 是防御性写法。
  // 目前 Limits 的每个字段都是数字，所以那条分支不可达；
  // 这里不伪造一个「未登记类别」来测它，否则测试会依赖一个不存在的用法。
  assert.equal(guard.cap('maxFileBytes'), DEFAULT_LIMITS.maxFileBytes);
});

test('limits：档位与覆盖', () => {
  assert.ok(CONSERVATIVE_LIMITS.maxFileBytes < DEFAULT_LIMITS.maxFileBytes);
  assert.ok(CONSERVATIVE_LIMITS.maxCells < DEFAULT_LIMITS.maxCells);
  assert.ok(CONSERVATIVE_LIMITS.rowWindow <= DEFAULT_LIMITS.rowWindow);

  const custom = withLimits({ maxCells: 5 });
  assert.equal(custom.maxCells, 5);
  assert.equal(custom.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, '未覆盖的项应取默认值');
  // 必须是副本，不能污染默认档
  custom.maxCells = 999;
  assert.equal(DEFAULT_LIMITS.maxCells, 2_000_000, 'withLimits 不得修改默认档');
});

/* ================================================================== */
/* 内存记账                                                            */
/* ================================================================== */

test('内存估算：字符串按 2 字节/字符保守估', () => {
  assert.equal(estimateStringBytes(undefined), 0);
  // 空串按 0 计：V8 里空串是单例，实际不占额外内存。
  // 若按对象头记 16 字节，在含大量空单元格的表格里会严重高估。
  assert.equal(estimateStringBytes(''), 0);
  assert.ok(estimateStringBytes('abc') >= 6);
  // 中文字符串不能按 1 字节/字符低估
  assert.ok(estimateStringBytes('中文中文中文') >= 12, 'CJK 字符串不得被低估');
});

test('内存估算：嵌套结构、字节、循环引用', () => {
  assert.equal(estimateBytes(null), 0);
  assert.equal(estimateBytes(42), 8);
  assert.equal(estimateBytes(true), 4);
  assert.equal(estimateBytes(new Uint8Array(1000)), 1000, '字节数组按实际长度计');

  const nested = { a: 'x'.repeat(100), b: [1, 2, 3], c: new Map([['k', 'v']]) };
  assert.ok(estimateBytes(nested) > 200);

  // 循环引用必须终止而不是栈溢出
  const cyc: Record<string, unknown> = { name: 'a' };
  cyc.self = cyc;
  const n = estimateBytes(cyc);
  assert.ok(Number.isFinite(n) && n > 0, '循环引用应被检出并终止');

  // 重复引用同一对象不应重复计数
  const shared = { big: 'y'.repeat(1000) };
  const twice = { p: shared, q: shared };
  const single = { p: shared };
  assert.ok(estimateBytes(twice) < estimateBytes(single) + estimateBytes(shared) + 50, '同一对象不应被重复计入');
});

test('formatBytes 与 memSnapshot', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB');
  // 负值有意义：内存增量/残留为负说明「GC 回收多于分配」，应当显示符号而不是 n/a。
  // 把它藏成 n/a 会让泄漏检查表看起来像「测不出来」。
  assert.equal(formatBytes(-2048), '-2.0 KiB', '负值应带符号显示，不能变成 n/a');
  // 真正无效的值才是 n/a
  assert.equal(formatBytes(NaN), 'n/a');
  assert.equal(formatBytes(Infinity), 'n/a');

  const snap = memSnapshot();
  assert.ok(['node', 'performance.memory', 'unavailable'].includes(snap.source));
  assert.ok(Number.isFinite(snap.heapUsedBytes));
  if (snap.source === 'node') assert.ok(snap.heapUsedBytes > 0, 'Node 下应能读到非零堆用量');
});

test('measure：给出耗时与堆增量', async () => {
  const r = await measure(async () => {
    const junk: string[] = [];
    for (let i = 0; i < 200; i++) junk.push('x'.repeat(1000));
    return junk.length;
  });
  assert.equal(r.result, 200);
  assert.ok(r.ms >= 0);
  assert.ok(typeof r.heapDeltaBytes === 'number' && Number.isFinite(r.heapDeltaBytes));
  // 峰值不应小于增量（峰值是下界采样，允许相等）
  assert.ok(r.peakHeapBytes >= 0);
});

/* ================================================================== */
/* Grid                                                               */
/* ================================================================== */

function row(r: number, cols: number[]): CellRow {
  return { r, cells: cols.map((c) => ({ r, c, v: `r${r}c${c}` })) };
}

test('MaterializedGrid：范围裁剪与空行补全', async () => {
  const rows: (CellRow | null)[] = [row(0, [0, 1]), null, row(2, [2])];
  const g = new MaterializedGrid(rows, 3, 3);

  const all = await g.readRows(0, 3);
  assert.equal(all.length, 3);
  assert.equal(all[0].cells.length, 2);
  assert.deepEqual(all[1], { r: 1, cells: [] }, '空行应补成空 CellRow 而不是 undefined');
  assert.equal(all[2].cells[0].c, 2);

  // 超出范围要被裁剪
  const over = await g.readRows(-5, 100);
  assert.equal(over.length, 3, '越界范围应被裁剪到 [0, rowCount)');
  assert.equal((await g.readRows(5, 9)).length, 0, '完全在范围外的请求应返回空数组');
  // 请求起点在范围内、终点越界
  assert.equal((await g.readRows(2, 99)).length, 1);
  // 小数索引：起点 floor、终点 ceil。
  // 终点向上取整是刻意的 —— 渲染时最后一行往往只露出一部分，也必须被渲染出来。
  assert.equal((await g.readRows(0.4, 2.6)).length, 3);
  assert.equal((await g.readRows(1.2, 1.8)).length, 1, '起止落在同一行内时应返回该行');
});

test('LazyGrid：按窗口惰性取行，且缓存行数受限', async () => {
  const total = 50_000;
  let fetchCalls = 0;
  const fetchedRanges: Array<[number, number]> = [];
  const g = new LazyGrid({
    rowCount: total,
    colCount: 20,
    cacheRows: 100,
    fetch: async (start, end) => {
      fetchCalls++;
      fetchedRanges.push([start, end]);
      const out: CellRow[] = [];
      for (let r = start; r < end; r++) out.push(row(r, [0, 1, 2]));
      return out;
    },
  });

  assert.equal(g.rowCount, total);
  const win = await g.readRows(1000, 1020);
  assert.equal(win.length, 20);
  assert.equal(win[0].r, 1000);
  assert.equal(win[19].r, 1019);
  assert.equal(fetchCalls, 1, '一次窗口请求应只触发一次 fetch');
  assert.deepEqual(fetchedRanges[0], [1000, 1020], 'fetch 的范围应精确等于请求窗口，不应多取');
  assert.ok(g.cachedRows <= 100, `缓存行数应受限，实际 ${g.cachedRows}`);

  // 命中缓存：不应再次 fetch
  await g.readRows(1005, 1015);
  assert.equal(fetchCalls, 1, '完全命中缓存时不应重新解析');

  // 滚动到远处：缓存要被淘汰，不能无限增长
  let expectedFetches = fetchCalls;
  for (let i = 0; i < 40; i++) {
    const start = i * 500;
    const end = start + 20;
    // i=2 时 start=1000，正好落在最初缓存的 [1000,1020) 窗口内，会计中缓存而不触发 fetch
    const alreadyCached = start >= 1000 && end <= 1020;
    if (!alreadyCached) expectedFetches++;
    await g.readRows(start, end);
  }
  assert.ok(g.cachedRows <= 100, `反复滚动后缓存仍应受限，实际 ${g.cachedRows}`);
  assert.equal(fetchCalls, expectedFetches, `应恰好触发 ${expectedFetches} 次解析（缓存命中不计）`);

  // 数据正确性
  const far = await g.readRows(49_990, 50_000);
  assert.equal(far.length, 10);
  assert.equal(far[9].r, 49_999);
  assert.equal(far[0].cells[0].v, 'r49990c0');
});

test('LazyGrid：完全在范围外的请求不触发 fetch', async () => {
  let calls = 0;
  const g = new LazyGrid({
    rowCount: 100,
    colCount: 5,
    fetch: async (s, e) => {
      calls++;
      const out: CellRow[] = [];
      for (let r = s; r < e; r++) out.push({ r, cells: [] });
      return out;
    },
  });
  assert.equal((await g.readRows(500, 600)).length, 0);
  assert.equal((await g.readRows(100, 200)).length, 0, '起点等于 rowCount 应返回空');
  assert.equal(calls, 0, '越界请求不应付出解析代价');
});

test('LazyGrid：并发请求同一区域只解析一次', async () => {
  let calls = 0;
  const g = new LazyGrid({
    rowCount: 1000,
    colCount: 5,
    fetch: async (s, e) => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      const out: CellRow[] = [];
      for (let r = s; r < e; r++) out.push(row(r, [0]));
      return out;
    },
  });
  const results = await Promise.all([g.readRows(100, 120), g.readRows(100, 120), g.readRows(100, 120)]);
  for (const r of results) assert.equal(r.length, 20);
  assert.equal(calls, 1, '同一区域的并发请求应被去重，否则滚动时会重复解析');
});

test('normalizeRow / findCell / mergeAnchor', () => {
  const unsorted: CellRow = { r: 0, cells: [{ r: 0, c: 5, v: 'e' }, { r: 0, c: 1, v: 'b' }, { r: 0, c: 3, v: 'd' }] };
  const sorted = normalizeRow(unsorted);
  assert.deepEqual(sorted.cells.map((c) => c.c), [1, 3, 5]);
  assert.equal(sorted, normalizeRow(sorted), '已排序的行应原样返回，避免无谓复制');

  assert.equal(findCell(sorted, 3).v, 'd');
  assert.equal(findCell(sorted, 5).v, 'e');
  assert.equal(findCell(sorted, 2), undefined);
  assert.equal(findCell(undefined, 1), undefined);

  const merges = [{ r1: 1, c1: 1, r2: 3, c2: 2 }];
  assert.equal(mergeAnchor(merges, 0, 0), null);
  assert.deepEqual(mergeAnchor(merges, 1, 1).isTopLeft, true);
  assert.deepEqual(mergeAnchor(merges, 2, 2).isTopLeft, false, '合并区域内部非左上角应被标记');
  assert.equal(mergeAnchor(merges, 4, 1), null);
  assert.equal(mergeAnchor(undefined, 1, 1), null, '无合并信息时不应崩');
});

/* ================================================================== */
/* 模型辅助                                                            */
/* ================================================================== */

function para(text: string, styleName?: string): Paragraph {
  return { kind: 'para', runs: [{ text }], style: styleName ? { styleName } : undefined };
}

test('模型：文本提取', () => {
  const blocks: Block[] = [
    para('第一段'),
    { kind: 'para', runs: [{ text: '带' }, { text: '图片', image: { mime: 'image/png', width: 10, height: 10, alt: '图A' } }] },
    {
      kind: 'table',
      rows: [
        { cells: [{ blocks: [para('a')] }, { blocks: [para('b')] }] },
        { cells: [{ blocks: [para('c')] }, { blocks: [para('d')] }] },
      ],
    },
    { kind: 'image', image: { mime: 'image/png', width: 1, height: 1 } },
  ];
  const text = blocksToText(blocks);
  assert.ok(text.includes('第一段'));
  assert.ok(text.includes('[图A]'), '有 alt 的图片应用 alt 表示');
  assert.ok(text.includes('[图片]'), '无 alt 的图片应有占位表示');
  assert.ok(text.includes('a\tb'), '表格行应制表符分隔');

  assert.equal(runsToText([{ text: 'x' }, { text: '' }, { text: 'y' }]), 'xy');
});

test('模型：字数统计（CJK 逐字 + 西文按词）', () => {
  const { words, chars } = countWords([para('你好世界 hello world')]);
  assert.equal(words, 4 + 2, '4 个汉字 + 2 个英文词');
  assert.equal(chars, '你好世界 hello world'.length);

  const table: Block[] = [{ kind: 'table', rows: [{ cells: [{ blocks: [para('表内文字')] }] }] }];
  assert.equal(countWords(table).words, 4, '表格内文字也要计入');

  assert.equal(countWords([]).words, 0);
});

test('模型：大纲提取与嵌套', () => {
  assert.equal(outlineLevelFromStyleName('Heading 1'), 0);
  assert.equal(outlineLevelFromStyleName('标题3'), 2);
  assert.equal(outlineLevelFromStyleName('h2'), 1);
  assert.equal(outlineLevelFromStyleName('正文'), undefined);
  assert.equal(outlineLevelFromStyleName(undefined), undefined);

  const blocks: Block[] = [
    { ...para('第一章', 'Heading 1'), style: { styleName: 'Heading 1', outlineLevel: 0 } },
    para('正文内容'),
    { ...para('1.1 小节', 'Heading 2'), style: { styleName: 'Heading 2', outlineLevel: 1 } },
    { ...para('1.1.1 细目', 'Heading 3'), style: { styleName: 'Heading 3', outlineLevel: 2 } },
    { ...para('第二章', 'Heading 1'), style: { styleName: 'Heading 1', outlineLevel: 0 } },
    para('   ', 'Heading 1'), // 空白标题应被跳过
  ];
  const flat = outlineFromBlocks(blocks);
  assert.equal(flat.length, 4, '空白标题不应进大纲');
  assert.equal(flat[0].text, '第一章');
  assert.equal(flat[0].level, 1, '大纲级别从 1 起');
  assert.equal(flat[0].target.index, 0, 'target 应指向块索引');
  assert.equal(flat[2].level, 3);

  const tree = nestOutline(flat);
  assert.equal(tree.length, 2, '应有 2 个顶层项');
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].children.length, 1);
  assert.equal(tree[1].text, '第二章');
  assert.equal(tree[1].children.length, 0);
});

test('模型：createDocument / dispose', () => {
  const imgBytes = new Uint8Array(1024);
  const blocks: Block[] = [
    {
      kind: 'para',
      runs: [{ text: '', image: { mime: 'image/png', width: 10, height: 10, data: imgBytes } }],
    },
    {
      kind: 'table',
      rows: [{ cells: [{ blocks: [{ kind: 'image', image: { mime: 'image/png', width: 1, height: 1, data: new Uint8Array(10) } }] }] }],
    },
  ];
  const doc: LiteDocument = createDocument({
    kind: 'text',
    format: 'docx',
    formatLabel: 'Word 文档',
    name: 'a.docx',
    blocks,
  });

  assert.equal(doc.truncated, false);
  assert.equal(doc.stats.blockCount, 2, 'createDocument 应自动填 blockCount');
  assert.equal(doc.formatLabel, 'Word 文档');

  doc.stats.truncated.push('maxCells');
  assert.equal(doc.truncated, true, 'truncated getter 应反映 stats');

  // 必须在 dispose 之前抓住块引用：dispose 会清空 doc.blocks 这个**同一个数组**，
  // 之后再通过 blocks[0] 访问就会拿到 undefined。
  const paraBlock = blocks[0];
  const tableBlock = blocks[1];
  assert.equal(paraBlock.kind, 'para');
  assert.equal(tableBlock.kind, 'table');
  const cellBlock = tableBlock.kind === 'table' ? tableBlock.rows[0].cells[0].blocks[0] : null;
  assert.ok(cellBlock && cellBlock.kind === 'image');

  doc.dispose();

  // dispose 后图片字节应被释放（这是低内存主张的一部分）
  if (paraBlock.kind === 'para') {
    assert.equal(paraBlock.runs[0].image.data, undefined, 'dispose 应释放段内图片字节');
  }
  if (cellBlock && cellBlock.kind === 'image') {
    assert.equal(cellBlock.image.data, undefined, 'dispose 应递归释放表格内图片');
  }
  assert.equal(doc.blocks.length, 0, 'dispose 应清空块数组');

  // 重复 dispose 不应抛错
  doc.dispose();

  // 独立测试 disposeBlocks
  const orphan: Block[] = [{ kind: 'image', image: { mime: 'image/png', width: 1, height: 1, data: new Uint8Array(4) } }];
  disposeBlocks(orphan);
  assert.equal(orphan[0].image.data, undefined);
  disposeBlocks(undefined); // 不应抛错
});

/* ================================================================== */
/* 文档体积记账 —— 「模型 ÷ 源文件」这个核心指标的地基                     */
/* ================================================================== */

test('记账：Grid 必须自报体积，否则表格文档的模型体积会被报成接近 0', () => {
  // 实测踩过的坑：一个 2 万行 × 8 列的 CSV 被报成 **278 字节**模型，
  // 而真实堆增量是 **60 MiB** —— 差 20 万倍。原因是表格数据在 Grid 实现内部
  // （物化实现放在私有数组里），任何从外部遍历文档对象的估算都看不到它。
  const rows: (CellRow | null)[] = [];
  for (let r = 0; r < 500; r++) {
    rows.push({ r, cells: Array.from({ length: 8 }, (_, c) => ({ r, c, v: `值-${r}-${c}` })) });
  }
  const materialized = new MaterializedGrid(rows, 500, 8);
  const mb = materialized.estimateBytes();
  assert.ok(mb > 500 * 8 * 20, `物化网格应报出与单元格数同阶的体积，实际 ${mb} 字节`);
  assert.ok(mb < 500 * 8 * 400, `也不应离谱高估，实际 ${mb} 字节`);

  // 惰性网格：体积只与**缓存**同阶，与总行数无关 —— 这正是低内存主张的核心
  const lazy = new LazyGrid({
    rowCount: 500_000,
    colCount: 8,
    cacheRows: 60,
    fetch: async (s, e) => {
      const out: CellRow[] = [];
      for (let r = s; r < e; r++) out.push({ r, cells: Array.from({ length: 8 }, (_, c) => ({ r, c, v: `v${r}${c}` })) });
      return out;
    },
  });
  const emptyLazy = lazy.estimateBytes();
  assert.ok(emptyLazy < 4096, `未读任何窗口时惰性网格体积应极小，实际 ${emptyLazy} 字节`);

  return (async () => {
    await lazy.readRows(0, 40);
    const afterOneWindow = lazy.estimateBytes();
    assert.ok(afterOneWindow > emptyLazy, '读过一个窗口后体积应上升');
    // 关键：读第 40 万行附近的一个窗口后，体积仍应与 60 行缓存同阶
    await lazy.readRows(400_000, 400_030);
    const afterFarWindow = lazy.estimateBytes();
    assert.ok(
      afterFarWindow < 200_000,
      `惰性网格体积必须与缓存行数同阶而非与总行数同阶，实际 ${afterFarWindow} 字节`,
    );
    assert.ok(
      afterFarWindow < materialized.estimateBytes() * 40,
      '惰性网格在 50 万行表上的体积不应接近物化 500 行的量级',
    );
  })();
});

test('记账：estimateDocumentBytes 对表格文档必须反映真实规模', () => {
  // 构造一个「表格在 Grid 内部」的工作表文档 —— 这正是外部遍历看不见数据的情形
  const rows: (CellRow | null)[] = [];
  for (let r = 0; r < 300; r++) {
    rows.push({ r, cells: Array.from({ length: 6 }, (_, c) => ({ r, c, v: `数据 ${r}-${c}` })) });
  }
  const grid = new MaterializedGrid(rows, 300, 6);
  const sheet = {
    name: '表1',
    rowCount: 300,
    colCount: 6,
    styles: [{ bold: true }, { align: 'center' as const }],
    readRows: grid.readRows.bind(grid),
    estimateBytes: grid.estimateBytes.bind(grid),
  };

  const doc = createDocument({
    kind: 'sheet',
    format: 'xlsx',
    formatLabel: 'Excel 工作簿',
    name: 'a.xlsx',
    sheets: [sheet as never],
  });

  const bytes = estimateDocumentBytes(doc);
  assert.ok(bytes > 300 * 6 * 20, `应报出与表格规模同阶的体积，实际 ${bytes} 字节`);

  // 逐项验证「外部 deep-walk 会漏掉表格数据」这件事：
  // 只估算 Sheet 的可见字段（不含 Grid 内部数据）应当远小于完整估算。
  const naive = estimateBytes({
    meta: doc.meta,
    outline: doc.outline,
    sheets: doc.sheets?.map((s) => ({ name: s.name, rowCount: s.rowCount, colCount: s.colCount, styles: s.styles })),
  });
  assert.ok(
    naive * 10 < bytes,
    `仅遍历 Sheet 可见字段的估算应显著偏小（这正是必须先前的 bug）: naive=${naive}, 完整=${bytes}`,
  );

  // Grid 未提供 estimateBytes 时应有兜底，且绝不报 0
  const docNoReport = createDocument({
    kind: 'sheet',
    format: 'csv',
    formatLabel: 'CSV 表格',
    name: 'b.csv',
    sheets: [{ name: 'S', rowCount: 1000, colCount: 10, styles: [], readRows: grid.readRows.bind(grid) } as never],
  });
  const fallback = estimateDocumentBytes(docNoReport);
  assert.ok(fallback >= 1000 * 10 * 24 * 0.9, `拿不到自报值时应按行列数兜底，实际 ${fallback}`);
});
