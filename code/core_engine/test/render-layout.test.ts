/**
 * 纯布局数学测试（**不需要 DOM**）。
 *
 * 这一层是整个虚拟化里最容易出错、又最难靠肉眼发现问题的部分：
 * 偏移表差一项、合并格在窗口边界漏画、PDF 的 y 忘了翻转 ——
 * 这些 bug 在浏览器里表现为「偶发白屏」「滚到某处就少了半页」，
 * 复现成本极高。所以它们必须有确定性断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateBlockHeight,
  estimateParaHeight,
  gridVisibleCols,
  gridVisibleRows,
  OffsetTable,
  pageOffset,
  pdfPageToCss,
  pdfPointToCss,
  resolveColWidths,
  resolveMerges,
  visibleRange,
} from '../packages/render-dom/src/layout.ts';
import type { Paragraph, PdfPage } from '../packages/core/src/model.ts';

/* ==================================================================== */
/* visibleRange                                                         */
/* ==================================================================== */

test('visibleRange：基本区间与 overscan', () => {
  const starts = Array.from({ length: 100 }, (_v, i) => i * 20);
  const ends = starts.map((s) => s + 20);

  assert.deepEqual(visibleRange(0, 100, starts, ends), { start: 0, end: 5 });
  assert.deepEqual(visibleRange(400, 100, starts, ends), { start: 20, end: 25 });
  // overscan 向两侧各扩 40px；上沿 360 落在第 18 项起点的**边界**上，
  // 该项起点等于上沿（半开区间语义下应排除），所以从第 19 项开始
  assert.deepEqual(visibleRange(400, 100, starts, ends, { overscan: 2 }), { start: 19, end: 26 });
  // 空数据
  assert.deepEqual(visibleRange(0, 100, [], []), { start: 0, end: 0 });
});

test('回归：3000 项等高列表，视口 720 时可见区间必须有界（曾经返回整篇）', () => {
  // 这段夹具对应真实场景：3000 段、每段估 32px、总高 96000px、视口 720px。
  // 早期版本把 lower_bound 的二分方向写反，返回值一路增长到 count，
  // 于是 visibleRange 返回 {start:0,end:3000} —— 渲染器会把整篇文档都建出
  // DOM（实测 6003 个节点），虚拟化彻底失效且没有任何报错。
  const starts = Array.from({ length: 3000 }, (_v, i) => i * 32);
  const ends = starts.map((s) => s + 32);

  const r = visibleRange(0, 720, starts, ends, { overscan: 2 });
  assert.ok(r.end - r.start < 40, `可见区间必须有界，实际 ${JSON.stringify(r)}`);
  assert.equal(r.start, 0);
  // 可见 720/32 ≈ 22.5 项，加 overscan 2
  assert.ok(r.end >= 22 && r.end <= 26, `end 应约为 24，实际 ${r.end}`);

  const r2 = visibleRange(48000, 720, starts, ends, { overscan: 2 });
  assert.ok(r2.start >= 1490 && r2.start <= 1500, `滚到中部应命中附近项，实际 ${JSON.stringify(r2)}`);
  assert.ok(r2.end - r2.start < 40, `中部区的可见区间同样必须有界，实际 ${JSON.stringify(r2)}`);

  // 单调性：scrollTop 增大时 start 不应回退
  let prev = -1;
  for (let y = 0; y < 96000; y += 1000) {
    const rr = visibleRange(y, 720, starts, ends, { overscan: 0 });
    assert.ok(rr.start >= prev, `start 在 y=${y} 回退了（${prev} -> ${rr.start}）`);
    assert.ok(rr.end - rr.start < 40, `y=${y} 的可见区间失控：${JSON.stringify(rr)}`);
    prev = rr.start;
  }

  // 传 maxItemHeight（渲染器的真实用法）时结果必须完全一致
  const pruned = visibleRange(48000, 720, starts, ends, { overscan: 2, maxItemHeight: 32 });
  assert.deepEqual(pruned, r2, '剪枝参数不能改变结果');
});

test('回归：O(log n + k) —— 大列表的查询成本与表大小脱钩', () => {
  // 1 万项，只查一次；断言可见区间仍然是窗口级别
  const N = 100_000;
  const starts = Array.from({ length: N }, (_v, i) => i * 20);
  const ends = starts.map((s) => s + 20);
  const r = visibleRange(1_000_000, 720, starts, ends, { overscan: 2, maxItemHeight: 20 });
  assert.ok(r.end - r.start < 60, `10 万项列表的可见区间应为常数级，实际 ${JSON.stringify(r)}`);
  assert.ok(r.start >= 49_000 && r.start <= 50_000, `起点应落在 5 万项附近，实际 ${r.start}`);
  // 剪枝必须严格等价于不剪枝（历史上剪枝写成 top-maxHeight-1 时会把
  // 恰好卡在视口上沿的那一项剪掉，滚动时内容一跳一跳）
  assert.deepEqual(
    visibleRange(1_000_000, 720, starts, ends, { overscan: 2 }),
    r,
    '传入 maxItemHeight 剪枝后结果必须完全一致',
  );
  for (const y of [0, 20, 999_999, 1_000_010, 500_000, 999_980]) {
    const a = visibleRange(y, 720, starts, ends, { overscan: 2 });
    const b = visibleRange(y, 720, starts, ends, { overscan: 2, maxItemHeight: 20 });
    assert.deepEqual(b, a, `y=${y} 时剪枝改变了可见区间：${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
});

test('回归：一项高到覆盖整个视口时，往前仍能找到它（ends 非单调）', () => {
  // 窗口里行数多于列数时，大表每行都「覆盖整个视口」，
  // 于是该项之前所有项的 ends 都 ≤ top，ends 在窗口附近不单调。
  const starts = [0, 100, 200, 300, 400];
  const ends = [100, 200, 1000, 400, 500];
  // 视口 [350, 450)：第 2 项 [200,1000) 覆盖整个视口，必须被找到
  const r = visibleRange(350, 100, starts, ends, { overscan: 0 });
  assert.equal(r.start, 2, `覆盖视口的那一项必须可见，实际 ${JSON.stringify(r)}`);
  assert.ok(r.end >= 3);

  // 零宽/零高（折叠）项不该被渲染
  const collapsed = visibleRange(100, 100, [0, 100, 200], [0, 100, 200], { overscan: 0 });
  assert.equal(collapsed.start, 2, '折叠项与其前驱都不算可见');
});

test('visibleRange：viewport 大于总高 / 滚到末尾 / 变高项', () => {
  // 变高：第 0 项 100px，其后每项 20px
  const heights = [100, ...Array.from({ length: 9 }, () => 20)];
  const starts: number[] = [];
  const ends: number[] = [];
  let acc = 0;
  for (const h of heights) {
    starts.push(acc);
    acc += h;
    ends.push(acc);
  }
  // 视口 1000 比总高 280 还大 → 全部渲染，且不能越界
  assert.deepEqual(visibleRange(0, 1000, starts, ends), { start: 0, end: 10 });
  // 滚到末尾之外 → 至少渲染最后一项，不能返回空区间（否则整屏空白）
  const tail = visibleRange(10_000, 100, starts, ends);
  assert.equal(tail.end, 10);
  assert.ok(tail.start < tail.end, '滚过内容末尾时仍要渲染最后一项');
  // 首项高于视口：滚到 0 时只覆盖第 0 项
  assert.deepEqual(visibleRange(0, 50, starts, ends), { start: 0, end: 1 });
  // 滚到第 0 项内部（y=60）时第 0 项仍可见
  assert.equal(visibleRange(60, 40, starts, ends).start, 0);
});

/* ==================================================================== */
/* OffsetTable                                                          */
/* ==================================================================== */

test('OffsetTable：1000 个变高项的 indexAt(offsetOf(i)) === i', () => {
  const N = 1000;
  const table = new OffsetTable(N, 16);
  // 用确定性伪随机（不依赖 Math.random，失败可复现）
  const heights: number[] = [];
  let seed = 1234567;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    heights.push(10 + (seed % 90));
  }
  for (let i = 0; i < N; i++) table.setHeight(i, heights[i]);

  // 总高 = 各高之和
  const expected = heights.reduce((a, b) => a + b, 0);
  assert.equal(table.totalHeight, expected);

  // 核心性质：任意项的起点回查必须命中该项本身
  for (let i = 0; i < N; i++) {
    assert.equal(table.indexAt(table.offsetOf(i)), i, `第 ${i} 项起点回查失败`);
    // 项内任意位置也落在该项（取中点）
    const mid = table.offsetOf(i) + heights[i] / 2;
    assert.equal(table.indexAt(mid), i, `第 ${i} 项中点回查失败`);
  }
  // 边界
  assert.equal(table.indexAt(0), 0);
  assert.equal(table.indexAt(-5), 0);
  assert.equal(table.indexAt(expected), N, '内容下方应返回 count');
  assert.equal(table.offsetOf(-1), 0);
  assert.equal(table.offsetOf(0), 0);
  assert.equal(table.offsetOf(N + 10), expected);
});

test('OffsetTable：随机插入高度修正后仍自洽，且查询不是 O(n) 求和', () => {
  const N = 300;
  const table = new OffsetTable(N, 20);
  // 先整体建一次表（模拟首屏估算）
  for (let i = 0; i < N; i++) table.setHeight(i, 20);

  const heights = new Array<number>(N).fill(20);
  // 随机修正一批（模拟渲染后实测回填）
  const patches = [7, 88, 250, 3, 199, 299, 42, 41, 40];
  for (const i of patches) {
    heights[i] = 20 + (i % 7) * 13;
    table.setHeight(i, heights[i]);
  }
  const expected = heights.reduce((a, b) => a + b, 0);
  assert.equal(table.totalHeight, expected);

  // 抽查回查正确性
  for (const i of [0, 1, 7, 40, 41, 100, 250, 299]) {
    assert.equal(table.indexAt(table.offsetOf(i)), i);
  }

  // 「不是每次查询都全量求和」：前缀和只重算有限次。
  // 这里连续查 500 次，rebuilds 不应随之增长。
  const before = table.rebuilds;
  for (let k = 0; k < 500; k++) table.indexAt(k * 37);
  assert.equal(table.rebuilds, before, `查询不应触发重算（query 500 次后 rebuilds 从 ${before} 变了）`);
  assert.ok(before <= 4, `重算次数应被摊销（实际 ${before} 次）`);
});

test('OffsetTable：均匀高度走快速路径（不需要前缀和数组）', () => {
  const table = new OffsetTable(5000, 24);
  assert.equal(table.isUniform, true);
  assert.equal(table.totalHeight, 5000 * 24);
  assert.equal(table.offsetOf(4321), 4321 * 24);
  assert.equal(table.indexAt(4321 * 24), 4321);
  // 不等高后快速路径失效
  table.setHeight(10, 100);
  assert.equal(table.isUniform, false);
  assert.equal(table.totalHeight, 5000 * 24 + 76);
  assert.equal(table.offsetOf(11), 11 * 24 + 76, '第 10 项变高后，第 11 项的起点应整体后移 76px');
  assert.equal(table.indexAt(11 * 24 + 76), 11);
});

test('OffsetTable：setHeight 幂等（相同值不标脏，且重算被推迟）', () => {
  const table = new OffsetTable(10, 20);
  table.totalHeight; // 建表
  const rebuilds = table.rebuilds;
  // 写回与现有值相同的高度：不标脏，因此下一次查询也不会重算
  table.setHeight(3, 20);
  table.offsetOf(9);
  assert.equal(table.rebuilds, rebuilds, '写回相同高度不应触发重算');
  // 真的变了：标脏，但重算只发生在下一次**查询**时（惰性）
  table.setHeight(3, 21);
  assert.equal(table.rebuilds, rebuilds, 'setHeight 本身不该立刻求和');
  table.offsetOf(9);
  assert.equal(table.rebuilds, rebuilds + 1);
  assert.equal(table.offsetOf(4), 3 * 20 + 21, '第 3 项高度改为此值后，第 4 项起点应相应变化');
});

test('OffsetTable：可见区间与稀疏高度结合（滚动到底）', () => {
  const N = 50_000;
  const table = new OffsetTable(N, 20);
  const total = table.totalHeight;
  assert.equal(total, N * 20);
  // 滚到最后一行附近
  const y = total - 100;
  const range = visibleRange(y, 200, table.snapshotStarts(), table.snapshotEnds(), { overscan: 2 });
  assert.ok(range.end === N, `应渲染到最后一行为止（end=${range.end}）`);
  assert.ok(range.start < N && range.start > N - 30, `start 应靠近末尾（actual ${range.start}）`);
});

/* ==================================================================== */
/* estimateParaHeight                                                   */
/* ==================================================================== */

function para(text: string, style?: Paragraph['style']): Paragraph {
  return { kind: 'para', runs: [{ text }], style };
}

test('estimateParaHeight：CJK 宽度按 1em（一行放不下必须换行）', () => {
  // 版心 100pt、字号 12pt（=16px/字），约 8 个汉字一行
  const oneLine = estimateParaHeight(para('四个汉字'), 100, 12);
  const twoLines = estimateParaHeight(para('十四个汉字十四个汉字十四个汉字'), 100, 12);
  assert.ok(twoLines > oneLine, `多行必须更高（一行 ${oneLine}px，三行 ${twoLines}px）`);
  // 12pt 字号、1.2 倍行距 → 一行约 16 * 1.2 = 19.2px
  assert.ok(Math.abs(oneLine - 19.2) < 0.5, `单行高度应在 19.2px 附近（实际 ${oneLine}）`);
  // 40 个汉字 / 每行 8 字 = 5 行 → 约 96px
  const five = estimateParaHeight(para('汉'.repeat(40)), 100, 12);
  assert.ok(Math.abs(five - 96) < 2, `40 个汉字应约 5 行 96px（实际 ${five}）`);
});

test('estimateParaHeight：西文按 0.5em，同样字符数比 CJK 矮', () => {
  const cjk = estimateParaHeight(para('a'.repeat(0) + '汉'.repeat(30)), 120, 12);
  const latin = estimateParaHeight(para('a'.repeat(30)), 120, 12);
  assert.ok(latin < cjk, `同样 30 字符，西文应比 CJK 少占行（latin ${latin} < cjk ${cjk}）`);
  // 30 个西文字符 = 15em = 180pt > 120pt，至少 2 行
  assert.ok(latin >= 2 * 12 * 1.2 * (96 / 72) * 0.99, '西文 30 字符在 120pt 版心下至少两行');
});

test('estimateParaHeight：spaceBefore / spaceAfter / lineHeightExact 参与计算', () => {
  const base = estimateParaHeight(para('测试'), 400, 12);
  const withSpacing = estimateParaHeight(para('测试', { spaceBefore: 6, spaceAfter: 6 }), 400, 12);
  // 6pt + 6pt = 12pt = 16px
  assert.ok(Math.abs(withSpacing - base - 16) < 0.2, `段前段后间距应精确加到高度上（${withSpacing} vs ${base}）`);

  // 固定行距 30pt = 40px（优先于 lineHeight 倍率）
  const exact = estimateParaHeight(para('测试', { lineHeightExact: 30 }), 400, 12);
  assert.ok(Math.abs(exact - 40) < 0.2, `固定行距 30pt 应为 40px（实际 ${exact}）`);
  // lineHeight 倍率 3.0 → 12*3 = 36pt = 48px
  const ratio = estimateParaHeight(para('测试', { lineHeight: 3 }), 400, 12);
  assert.ok(Math.abs(ratio - 48) < 0.2, `3 倍行距应为 48px（实际 ${ratio}）`);
});

test('estimateParaHeight：单调性（文本越长/字号越大，高度不减）', () => {
  let prev = 0;
  for (let n = 1; n <= 200; n += 7) {
    const h = estimateParaHeight(para('汉'.repeat(n)), 200, 12);
    assert.ok(h >= prev, `文本变长时高度不应下降（n=${n}: ${h} < ${prev}）`);
    prev = h;
  }
  let prevSize = 0;
  for (const size of [8, 9, 10, 11, 12, 14, 18, 24, 36]) {
    const h = estimateParaHeight(para('同一个段落', { }), 200, size);
    assert.ok(h >= prevSize, `字号变大时高度不应下降（size=${size}）`);
    prevSize = h;
  }
});

test('estimateParaHeight：换行与图片', () => {
  // 显式换行 \n 必须增加行数
  const one = estimateParaHeight(para('第一行'), 400, 12);
  const two = estimateParaHeight(para('第一行\n第二行'), 400, 12);
  assert.ok(Math.abs(two - 2 * one) < 0.3, '显式换行应增加一行');
  // breakBefore 同样换行
  const withBreak: Paragraph = { kind: 'para', runs: [{ text: 'A' }, { text: 'B', breakBefore: true }] };
  const noBreak: Paragraph = { kind: 'para', runs: [{ text: 'A' }, { text: 'B' }] };
  assert.ok(estimateParaHeight(withBreak, 400, 12) > estimateParaHeight(noBreak, 400, 12), 'breakBefore 应换行');
  // 行内图片按自身高度计入
  const withImage: Paragraph = { kind: 'para', runs: [{ image: { mime: 'image/png', width: 50, height: 60 } }] };
  assert.ok(estimateParaHeight(withImage, 400, 12) >= 80, '60pt 高的图片至少贡献 80px');
  // 空段落仍占一行（否则文档里的空行会消失）
  assert.ok(estimateParaHeight({ kind: 'para', runs: [] }, 400, 12) > 0, '空段落高度必须 > 0');
});

test('estimateBlockHeight：各类块都有非负高度', () => {
  assert.ok(estimateBlockHeight(para('文字'), 400) > 0);
  assert.ok(estimateBlockHeight({ kind: 'pagebreak' }, 400) > 0);
  assert.ok(estimateBlockHeight({ kind: 'rule' }, 400) > 0);
  assert.ok(estimateBlockHeight({ kind: 'raw', text: 'x' }, 400) > 0);
  const table = estimateBlockHeight(
    { kind: 'table', rows: [{ cells: [{ blocks: [para('a')] }] }, { cells: [{ blocks: [para('b')] }] }] },
    400,
  );
  assert.ok(table > 0, '表格高度应大于 0');
});

/* ==================================================================== */
/* gridVisibleRows / gridVisibleCols                                    */
/* ==================================================================== */

test('gridVisibleRows：5 万行只覆盖窗口', () => {
  const r = gridVisibleRows(0, 400, undefined, 20, 50_000, 2);
  // 可见 [0,400) 加 overscan 上下各 2 行；下沿 440 正好落在第 22 行的边界上，
  // 该行起点等于下沿、按半开区间语义排除 → 覆盖 0..20，上界 21。
  assert.equal(r.start, 0);
  assert.equal(r.end, 21);
  assert.equal(r.top, 0);
  assert.equal(r.bottom, 21 * 20);

  const mid = gridVisibleRows(10_000, 400, undefined, 20, 50_000, 2);
  // 下沿 10440 正好是第 522 行的起点（522*20），该行被排除 → 上界 521
  assert.equal(mid.start, 498);
  assert.equal(mid.end, 521);
  assert.equal(mid.top, 498 * 20);
  // 渲染的行数只与窗口有关，与表大小无关
  assert.ok(mid.end - mid.start <= 30, '窗口内渲染行数必须是个小常数');
  // 快路径与逐步前缀和（传一个稀疏 Map 走慢路径）必须给出一致结果
  const slow = gridVisibleRows(10_000, 400, new Map([[0, 20]]), 20, 50_000, 2);
  assert.deepEqual(
    { start: slow.start, end: slow.end },
    { start: mid.start, end: mid.end },
    '行高快路径与慢路径结果必须一致',
  );
  // 两条路径的边界行为也要一致（下沿刚好压在行边界上）
  const slowEdge = gridVisibleRows(0, 400, new Map([[0, 20]]), 20, 50_000, 2);
  assert.deepEqual({ start: slowEdge.start, end: slowEdge.end }, { start: r.start, end: r.end });
});

test('gridVisibleRows：稀疏行高 / 滚动到底 / 空表 / 视口大于总高', () => {
  const rowHeights = new Map<number, number>([[0, 60], [1, 40]]);
  const top = gridVisibleRows(0, 50, rowHeights, 20, 100, 0);
  assert.equal(top.start, 0);
  assert.ok(top.end >= 1, '自定义行高时也要渲染首行');
  // 第 2 行起点应是 60+40=100
  const at100 = gridVisibleRows(100, 20, rowHeights, 20, 100, 0);
  assert.equal(at100.start, 2);
  assert.equal(at100.top, 100);

  // 滚动到底：end 必须等于 count
  const bottom = gridVisibleRows(100 * 20, 400, undefined, 20, 100, 2);
  assert.equal(bottom.end, 100);

  // 视口大于总高 → 全部
  const all = gridVisibleRows(0, 10_000, undefined, 20, 100, 0);
  assert.deepEqual({ s: all.start, e: all.end }, { s: 0, e: 100 });

  // 空表
  assert.deepEqual(gridVisibleRows(0, 400, undefined, 20, 0, 2), { start: 0, end: 0, top: 0, bottom: 0 });
  // 无行高信息
  assert.deepEqual(gridVisibleRows(0, 400, undefined, 0, 100, 2), { start: 0, end: 0, top: 0, bottom: 0 });
});

test('gridVisibleCols：列宽不齐也能算对偏移', () => {
  const widths = [100, 50, 50, 200, 50];
  const cols = gridVisibleCols(0, 120, widths, 60, 5, 0);
  assert.equal(cols.start, 0);
  // 第 0 列 [0,100)、第 1 列 [100,150) 与视口 [0,120) 真重叠；
  // 第 2 列起点 150 已在视口之外。判定用半开区间严格比较，所以这里是 2。
  assert.equal(cols.end, 2);
  assert.equal(cols.left, 0);
  assert.equal(cols.right, 150);

  // 第 2 列起点与视口左沿重合 -> 它的终点 200 > 150，仍然可见
  const scrolled = gridVisibleCols(150, 100, widths, 60, 5, 0);
  assert.equal(scrolled.start, 2, 'scrollLeft=150 时第 2 列刚好贴在左沿，仍应渲染');
  assert.equal(scrolled.left, 150);

  // 完全滚过第 2 列（左沿 200）后第 1 列不可见、第 2 列终点等于上沿也不可见
  const past = gridVisibleCols(200, 100, widths, 60, 5, 0);
  assert.equal(past.start, 3);

  // overscan 只多带一列：第 2 列（起点 150）比视口右沿 120 还远，不该进来。
  // 这正是「窗口边界」类断言该钉住的行为 —— 多带会把大表的列数也放大。
  const over = gridVisibleCols(0, 120, widths, 60, 5, 1);
  assert.equal(over.end, 2);
  // 视口刚好切进第 3 列时，第 3 列必须被渲染（否则右侧露出空白）
  const into3 = gridVisibleCols(0, 160, widths, 60, 5, 0);
  assert.equal(into3.end, 3, '视口下沿压在第 3 列起点上时应渲染第 3 列');

  // 缺省列宽补齐
  assert.deepEqual(resolveColWidths([100], 60, 3), [100, 60, 60]);
  assert.deepEqual(resolveColWidths(undefined, 60, 2), [60, 60]);
  // 空
  assert.deepEqual(gridVisibleCols(0, 100, widths, 60, 0, 0), { start: 0, end: 0, left: 0, right: 0 });
});

/* ==================================================================== */
/* resolveMerges                                                        */
/* ==================================================================== */

test('resolveMerges：跨行跨列的锚点与延续格', () => {
  const merges = [
    { r1: 0, c1: 0, r2: 1, c2: 1 }, // 2x2，锚点在窗口内
    { r1: 10, c1: 0, r2: 12, c2: 0 }, // 远在窗口外
    { r1: 3, c1: 3, r2: 3, c2: 3 }, // 单格，应被忽略
  ];
  const r = resolveMerges(merges, { start: 0, end: 5 }, { start: 0, end: 5 });
  assert.equal(r.visible.length, 1);
  assert.deepEqual(r.visible[0], { r1: 0, c1: 0, r2: 1, c2: 1 });
  // 3 个延续格：(0,1) (1,0) (1,1)
  assert.equal(r.skip.length, 3);
  const keys = r.skip.map((s) => `${s.r}:${s.c}`).sort();
  assert.deepEqual(keys, ['0:1', '1:0', '1:1']);
});

test('resolveMerges：锚点滚出窗口时整块不渲染', () => {
  const merges = [{ r1: 0, c1: 0, r2: 4, c2: 0 }];
  // 窗口从第 2 行开始：锚点（第 0 行）不可见
  const r = resolveMerges(merges, { start: 2, end: 6 }, { start: 0, end: 3 });
  assert.equal(r.visible.length, 0, '锚点不可见时必须整块跳过，否则会画出高度错误的半截格子');
  assert.equal(r.skip.length, 0, '不渲染锚点时也不该跳过任何格，否则内容凭空消失');
  // 锚点可见时正常
  const r2 = resolveMerges(merges, { start: 0, end: 6 }, { start: 0, end: 3 });
  assert.equal(r2.visible.length, 1);
  assert.equal(r2.skip.length, 4);
});

test('resolveMerges：窗口内的 skip 只落在可视范围（不越界产生无用节点）', () => {
  const merges = [{ r1: 1, c1: 1, r2: 8, c2: 8 }];
  const r = resolveMerges(merges, { start: 0, end: 3 }, { start: 0, end: 3 });
  assert.equal(r.visible.length, 1);
  // 窗口内只有 (1,2) (2,1) (2,2) 三格被跳过
  assert.deepEqual(r.skip.map((s) => `${s.r}:${s.c}`).sort(), ['1:2', '2:1', '2:2']);
  // 空输入
  assert.deepEqual(resolveMerges(undefined, { start: 0, end: 3 }, { start: 0, end: 3 }), { visible: [], skip: [] });
  assert.deepEqual(resolveMerges([], { start: 0, end: 3 }, { start: 0, end: 3 }), { visible: [], skip: [] });
});

/* ==================================================================== */
/* pdfPageToCss                                                         */
/* ==================================================================== */

test('pdfPageToCss：y 轴翻转（PDF 原点左下 -> CSS 原点左上）', () => {
  const page: PdfPage = {
    index: 0,
    width: 612,
    height: 792,
    items: [{ kind: 'text', x: 100, y: 700, size: 12, font: 'Times', text: 'Hello' }],
  };
  const [box] = pdfPageToCss(page.items, page, 1, 1);
  // 左端 x 不变
  assert.equal(box.left, 100);
  // 基线 y=700（距底 700）→ 距顶 792-700=92，再减去字身高 12 → 80
  assert.equal(box.top, 792 - 700 - 12);
  assert.equal(box.height, 12);
  // scale=2 时全部翻倍
  const [big] = pdfPageToCss(page.items, page, 2, 1);
  assert.equal(big.left, 200);
  assert.equal(big.top, 160);
  // zoom 与 scale 相乘
  const [zoom] = pdfPageToCss(page.items, page, 1, 3);
  assert.equal(zoom.left, 300);
});

test('pdfPageToCss：矩形 / 线段 / 图片；宽度缺失时用字号估算', () => {
  const page: PdfPage = {
    index: 0,
    width: 200,
    height: 100,
    items: [
      { kind: 'rect', x: 10, y: 20, w: 30, h: 5, fill: '#fff' },
      { kind: 'line', x1: 0, y1: 50, x2: 200, y2: 50, lw: 1 },
      { kind: 'image', x: 0, y: 0, w: 40, h: 20 },
      { kind: 'text', x: 0, y: 90, size: 10, font: 'F', text: 'abcdefgh', width: 42 },
    ],
  };
  const boxes = pdfPageToCss(page.items, page, 1, 1);
  assert.equal(boxes.length, 4);
  // rect: top = 100 - 20 - 5 = 75
  assert.equal(boxes[0].top, 75);
  assert.equal(boxes[0].width, 30);
  // line: 水平线外接盒，top = 100 - 50 - 0.2
  assert.ok(Math.abs(boxes[1].top - 49.8) < 0.001);
  assert.equal(boxes[1].width, 200);
  // image
  assert.equal(boxes[2].top, 80);
  assert.equal(boxes[2].height, 20);
  // 文本给了 width 就用 width
  assert.equal(boxes[3].width, 42);
});

test('pdfPageToCss：/Rotate 90 交换页面朝向（否则文字会挤在一条竖线上）', () => {
  const page: PdfPage = {
    index: 0,
    width: 200,
    height: 100,
    rotate: 90,
    items: [{ kind: 'rect', x: 0, y: 0, w: 200, h: 100 }],
  };
  const [box] = pdfPageToCss(page.items, page, 1, 1);
  // 顺时针 90°：视觉上宽高对调
  assert.equal(box.width, 100);
  assert.equal(box.height, 200);
  assert.equal(box.left, 0);
  assert.equal(box.top, 0);

  const point = pdfPointToCss(200, 0, page, 1);
  assert.equal(point.left, 0);
  assert.equal(point.top, 200);
});

test('pageOffset：页间距累计', () => {
  assert.equal(pageOffset(0, 800, 10), 0);
  assert.equal(pageOffset(1, 800, 10), 810);
  assert.equal(pageOffset(3, 800, 10), 2430);
  assert.equal(pageOffset(-2, 800, 10), 0);
});
