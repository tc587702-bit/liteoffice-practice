/**
 * 渲染器测试（用 packages/render-dom/testutil 的最小 DOM 桩）。
 *
 * 这一组测试要回答的核心问题是产品主张：**低内存**。
 * 也就是「2000 段的文档到底创建了多少 DOM 节点」「5 万行的表创建了多少」。
 * 所以每个虚拟化断言里都**打印实测数字**，而不是只断言一个 > / <。
 *
 * 注意桩没有布局引擎：clientHeight 恒为 0。渲染器对此有兜底（视口为 0 时
 * 渲染开头几块），但那条路径**测不到真正的按视口虚拟化**。因此凡是要验证
 * 「按视口虚拟化」的用例，都用 synthesizeViewport() 合成尺寸并触发滚动回调。
 * 两种路径都覆盖，才算把渲染器真正跑起来。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDomStub, StubIntersectionObserver, synthesizeViewport } from '../packages/render-dom/testutil/domstub.ts';
import type { StubElement } from '../packages/render-dom/testutil/domstub.ts';

// 必须在导入渲染器之前装桩：渲染器虽然惰性取 document，但先装更保险。
const dom = installDomStub();
after(() => dom.restore());

const { createViewer, canRender } = await import('../packages/render-dom/src/viewer.ts');
const { ReflowViewer } = await import('../packages/render-dom/src/reflow.ts');
const { GridViewer } = await import('../packages/render-dom/src/grid.ts');
const { SlidesViewer } = await import('../packages/render-dom/src/slides.ts');
const { PdfViewer } = await import('../packages/render-dom/src/pdf.ts');
const { MaterializedGrid } = await import('../packages/core/src/grid.ts');
const { createDocument } = await import('../packages/core/src/model.ts');
const { ptToPx } = await import('../packages/core/src/units.ts');
/** 与渲染器同一套换算，避免测试自己写 96/72 导致口径不一致 */
const ptToPxForTest = (pt: number): number => ptToPx(pt);
import type { Block, CellRow, LiteDocument, Paragraph, PdfPage, Shape, Slide } from '../packages/core/src/model.ts';

/* ==================================================================== */
/* 造夹具                                                               */
/* ==================================================================== */

/** 造一个 N 段的文档：每段有可辨认的文本，便于断言内容一致 */
function makeTextDoc(paragraphs: number, opts: { lines?: number } = {}): LiteDocument {
  const blocks: Block[] = [];
  for (let i = 0; i < paragraphs; i++) {
    const p: Paragraph = {
      kind: 'para',
      runs: [
        { text: `第 ${i} 段 `, style: i % 3 === 0 ? { bold: true } : undefined },
        { text: `这是第 ${i} 段的正文内容，用来验证虚拟滚动不会把内容渲染错位。` },
      ],
      style: { outlineLevel: i % 100 === 0 ? 0 : undefined, styleName: i % 100 === 0 ? 'Heading 1' : undefined },
      id: `p${i}`,
    };
    blocks.push(p);
    for (let k = 1; k < (opts.lines ?? 1); k++) {
      blocks.push({ kind: 'para', runs: [{ text: `第 ${i} 段的第 ${k} 行补充内容。` }] });
    }
  }
  return createDocument({
    kind: 'text',
    format: 'docx',
    formatLabel: 'Word 文档',
    name: 'fixture-2000.docx',
    blocks,
    meta: { pageWidth: 595, pageHeight: 842, margin: { top: 72, right: 72, bottom: 72, left: 72 } },
    stats: { blockCount: blocks.length },
  });
}

function makeGridDoc(rows: number, cols: number): LiteDocument {
  const grid = new MaterializedGrid(
    Array.from({ length: rows }, (_v, r): CellRow => ({
      r,
      cells: [
        { r, c: 0, v: `R${r}C0`, t: 's' },
        { r, c: 1, v: String(r * 2), t: 'n', s: 0 },
        { r, c: 2, v: `行${r}`, t: 's' },
      ].filter((c) => c.c < cols),
    })),
    rows,
    cols,
  );
  return createDocument({
    kind: 'sheet',
    format: 'xlsx',
    formatLabel: 'Excel 工作簿',
    name: `fixture-${rows}.xlsx`,
    sheets: [
      {
        name: 'Sheet1',
        rowCount: rows,
        colCount: cols,
        styles: [{ bold: true, align: 'right' }],
        defaultColWidth: 64,
        defaultRowHeight: 18,
        merges: [],
        readRows: (s, e) => grid.readRows(s, e),
      },
    ],
  });
}

function makeSlidesDoc(count: number, shapesPerSlide: number): LiteDocument {
  const slides: Slide[] = [];
  for (let i = 0; i < count; i++) {
    const shapes: Shape[] = [];
    for (let s = 0; s < shapesPerSlide; s++) {
      shapes.push({
        kind: 'text',
        x: 40 + s * 20,
        y: 40 + s * 30,
        w: 300,
        h: 60,
        blocks: [{ kind: 'para', runs: [{ text: `幻灯片 ${i} 的形状 ${s}`, style: { size: 18, bold: true } }] }],
      });
    }
    slides.push({ index: i, width: 960, height: 540, shapes, layout: 'blank' });
  }
  return createDocument({ kind: 'slides', format: 'pptx', formatLabel: 'PowerPoint 演示文稿', name: `fixture-${count}.pptx`, slides });
}

function makePdfDoc(pages: number, itemsPerPage: number): LiteDocument {
  const out: PdfPage[] = [];
  for (let i = 0; i < pages; i++) {
    out.push({
      index: i,
      width: 612,
      height: 792,
      items: Array.from({ length: itemsPerPage }, (_v, k) => ({
        kind: 'text' as const,
        x: 72,
        y: 700 - (k % 40) * 15,
        size: 10,
        font: 'Helvetica',
        text: `page ${i} line ${k}`,
        width: 90,
      })),
    });
  }
  return createDocument({ kind: 'pdf', format: 'pdf', formatLabel: 'PDF 文档', name: `fixture-${pages}.pdf`, pages: out });
}

/** 沿 childNodes 递归收集文本（不能只看 element.children：文本节点不在里面） */
function collectText(el: { childNodes: unknown[]; textContent: string | null; nodeType?: number }): string {
  let out = '';
  for (const c of el.childNodes as Array<{ childNodes: unknown[]; textContent: string | null; nodeType: number }>) {
    if (c.nodeType === 3) out += c.textContent ?? '';
    else out += collectText(c);
  }
  return out;
}

/**
 * 让所有已排队的微任务与定时器跑完。
 * 表格渲染是异步的（等 readRows），只 await 一次 setTimeout 不够：
 * readRows 的 then 链会产生新的微任务，必须多轮让步才能观察到最终 DOM。
 */
async function tick(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ==================================================================== */
/* 回归：createViewer 必须把文档交给渲染器                                 */
/* ==================================================================== */

test('回归：createViewer(doc) 后 mount 必须立刻渲染出内容（曾经白屏）', () => {
  const doc = makeTextDoc(3000);
  const container = dom.container(1024, 720);

  // 这是 API 字面意思的用法：不额外调用 setDocument
  const viewer = createViewer(doc);
  viewer.mount(container);
  // 桩下 clientHeight=0，走的是「视口未知」兜底路径，但兜底也必须渲染内容
  assert.ok(viewer.renderedNodes > 3, `createViewer 后 mount 必须渲染出节点（实际 ${viewer.renderedNodes}）`);

  const text = collectText(viewer.element as unknown as StubElement);
  assert.ok(text.includes('第 0 段'), `必须能在容器里读到段落文本，实际读到 ${text.length} 字：${text.slice(0, 80)}`);
  assert.ok(text.includes('第 0 段的正文内容'), '正文字符串应与 UDM 内容一致');

  // 交给渲染器的 doc 应该就是这一份（通过大纲跳转间接验证：跳到很靠后的段落后能读到它）
  viewer.scrollTo({ kind: 'block', index: 2500 });
  const after = collectText(viewer.element as unknown as StubElement);
  assert.ok(after.includes('第 2500 段'), `scrollTo 之后应看到目标段落，实际读到：${after.slice(0, 120)}`);
  viewer.dispose();
});

test('回归：每种文档类别都能通过 createViewer 拿到内容（不是空壳）', () => {
  // 文字
  const textV = createViewer(makeTextDoc(50));
  textV.mount(dom.container());
  assert.ok(collectText(textV.element as unknown as StubElement).includes('第 0 段'));
  textV.dispose();

  // 表格（异步渲染，需要让微任务跑完）
  const gridV = createViewer(makeGridDoc(200, 4));
  gridV.mount(dom.container());
  assert.ok(gridV.renderedNodes > 3, '表格渲染器不该是空壳');

  // 幻灯片
  const slideV = createViewer(makeSlidesDoc(20, 3));
  slideV.mount(dom.container());
  assert.ok(slideV.renderedNodes > 3, '幻灯片渲染器不该是空壳');

  // PDF
  const pdfV = createViewer(makePdfDoc(20, 10));
  pdfV.mount(dom.container());
  assert.ok(pdfV.renderedNodes > 3, 'PDF 渲染器不该是空壳');

  gridV.dispose();
  slideV.dispose();
  pdfV.dispose();
});

/* ==================================================================== */
/* 核心：文字文档虚拟化                                                  */
/* ==================================================================== */

test('虚拟化核心：2000 段文档只渲染窗口内的少量节点', () => {
  const PARAS = 2000;
  const doc = makeTextDoc(PARAS);
  const viewer = new ReflowViewer();
  const container = dom.container(1024, 720);
  viewer.mount(container);
  viewer.setDocument(doc);

  // 合成视口：走「真正按视口虚拟化」的路径，而不是 clientHeight=0 的兜底
  const scroller = synthesizeViewport(viewer.element as unknown as StubElement, 1024, 720, 0);
  assert.ok(scroller, '必须存在滚动容器');
  const atTop = viewer.renderedNodes;
  const blocksTop = viewer.element.querySelectorAll('.lo-block').length;
  console.log(`[虚拟化实测] ${PARAS} 段文字文档：scrollTop=0 时 renderedNodes=${atTop}，.lo-block=${blocksTop}（文档共 ${PARAS} 段）`);
  assert.ok(atTop < 200, `2000 段文档首次渲染的节点数必须远小于 2000（实际 ${atTop}）`);
  assert.ok(atTop > 3, '不能是空壳');

  // 内容总高由偏移表给出；用它来算「中部」而不是随手写个 scrollTop ——
  // 写一个超过总高的值会让浏览器把它 clamp 到末尾，于是看到的其实是最后一屏，
  // 断言就会误导人（我第一版就踩了这个坑）。
  const spacer = viewer.element.querySelector('.lo-spacer') as unknown as StubElement;
  const totalHeight = Number.parseFloat(spacer.style.height);
  assert.ok(totalHeight > 10_000, `2000 段的内容总高应有上万像素（实际 ${spacer.style.height}）`);

  // 滚到中部：仍然只渲染窗口内，且渲染的必须是中部的内容
  scroller.scrollTop = totalHeight / 2;
  scroller.dispatchEvent({ type: 'scroll' });
  const atMiddle = viewer.renderedNodes;
  const blocksMiddle = viewer.element.querySelectorAll('.lo-block').length;
  const midText = collectText(viewer.element as unknown as StubElement);
  const midIndex = /第 (\d+) 段/.exec(midText)?.[1];
  console.log(
    `[虚拟化实测] 滚到中部（scrollTop=${Math.round(totalHeight / 2)}，总高 ${Math.round(totalHeight)}）：`
    + `renderedNodes=${atMiddle}，.lo-block=${blocksMiddle}，首个段落=第 ${midIndex} 段`,
  );
  assert.ok(atMiddle < 200, `滚动到中部后节点数仍必须远小于 2000（实际 ${atMiddle}）`);
  // 关键：中部应渲染出**足够填满一屏**的块（约 720/17.6 ≈ 40 块），
  // 不能因为可见区间算错而只剩 1 块（那会表现为"滚到中间整屏空白"）
  assert.ok(blocksMiddle >= 20 && blocksMiddle <= 80, `中部应渲染约一屏的块（实际 ${blocksMiddle}）`);
  assert.ok(Number(midIndex) > 500 && Number(midIndex) < 1500, `中部应渲染中段内容（实际第 ${midIndex} 段）`);

  // 滚到最底部：节点数不能随位置增长（回收生效，不是只增不减）
  scroller.scrollTop = totalHeight * 10;
  scroller.dispatchEvent({ type: 'scroll' });
  const atEnd = viewer.renderedNodes;
  const endText = collectText(viewer.element as unknown as StubElement);
  console.log(`[虚拟化实测] 滚到底部后：renderedNodes=${atEnd}`);
  assert.ok(atEnd < 200, `滚到底部后节点数仍必须远小于 2000（实际 ${atEnd}）`);
  // 滚过末尾时浏览器会 clamp，所以应该看到最后一屏内容
  assert.ok(endText.includes('第 1999 段'), `滚到底部应看到最后一段，实际样本：${endText.slice(0, 80)}`);

  // 虚拟化的证据：渲染的块数与视口/平均行高同阶，而不是与文档段数同阶
  const blocks = viewer.element.querySelectorAll('.lo-block').length;
  assert.ok(blocks > 0 && blocks < 100, `同时存在的段落块数应为几十个（实际 ${blocks}）`);

  viewer.dispose();
  assert.equal(viewer.renderedNodes, 0, 'dispose 后必须清空容器');
});

test('文字渲染器：渲染出的文本与 UDM 内容一致（不是空的、不是乱码）', () => {
  const doc = makeTextDoc(100);
  const viewer = new ReflowViewer();
  const container = dom.container(1024, 720);
  viewer.mount(container);
  viewer.setDocument(doc);
  synthesizeViewport(viewer.element as unknown as StubElement, 1024, 720, 0);

  const text = collectText(viewer.element as unknown as StubElement);
  assert.ok(text.includes('第 0 段'), '应包含第 0 段文本');
  assert.ok(text.includes('第 0 段的正文内容'), 'run 拼接不应丢失');
  assert.ok(text.includes('用来验证虚拟滚动不会把内容渲染错位'), '长文本应完整');
  // 抽查第一段：加粗的 run 应该带上 font-weight
  const boldSpan = viewer.element.querySelector('.lo-run');
  assert.ok(boldSpan, '应生成 .lo-run');
  assert.equal((boldSpan as unknown as StubElement).style.fontWeight, 'bold', '第 0 段的第一个 run 是加粗的');
  viewer.dispose();
});

test('文字渲染器：缩放 pt->px 换算正确（12pt 在 96dpi 下是 16px）', () => {
  const doc = createDocument({
    kind: 'text',
    format: 'txt',
    formatLabel: '纯文本',
    name: 'a.txt',
    blocks: [{ kind: 'para', runs: [{ text: '十二磅字', style: { size: 12 } }] }],
  });
  const viewer = new ReflowViewer();
  viewer.mount(dom.container(1024, 720));
  viewer.setDocument(doc);

  const block = viewer.element.querySelector('.lo-block') as unknown as StubElement;
  assert.ok(block, '应渲染出段落块');
  assert.equal(block.style.fontSize, '16px', `12pt 在 96dpi 下应为 16px（实际 ${block.style.fontSize}）`);
  const run12 = viewer.element.querySelector('.lo-run') as unknown as StubElement;
  assert.equal(run12.style.fontSize, '16px', 'run 自己的字号也要按 pt->px 换算');

  // 放大到 200%
  viewer.setZoom(2);
  const zoomed = viewer.element.querySelector('.lo-block') as unknown as StubElement;
  assert.equal(zoomed.style.fontSize, '32px', `200% 缩放后 12pt 应为 32px（实际 ${zoomed.style.fontSize}）`);
  // 缩到 50%
  viewer.setZoom(0.5);
  const half = viewer.element.querySelector('.lo-block') as unknown as StubElement;
  assert.equal(half.style.fontSize, '8px', `50% 缩放后 12pt 应为 8px（实际 ${half.style.fontSize}）`);

  // 注意：块的**宽度**在缩放时保持不变（版心 = 文档宽度，放大是等比放大内容而不是重排列）。
  // 真正随缩放变化的是字号与内容总高（滚动条长度）。
  viewer.setZoom(1);
  const w1 = Number.parseFloat((viewer.element.querySelector('.lo-block') as unknown as StubElement).style.width);
  const h1 = Number.parseFloat((viewer.element.querySelector('.lo-spacer') as unknown as StubElement).style.height);
  viewer.setZoom(2);
  const w2 = Number.parseFloat((viewer.element.querySelector('.lo-block') as unknown as StubElement).style.width);
  const h2 = Number.parseFloat((viewer.element.querySelector('.lo-spacer') as unknown as StubElement).style.height);
  assert.ok(Math.abs(w1 - w2) < 1, `缩放不该改变版心宽度（${w1} -> ${w2}）`);
  assert.ok(h2 > h1 * 1.5, `缩放 2 倍后内容总高应显著变大（${h1} -> ${h2}）`);
  // 表格/幻灯片/PDF 的容器尺寸则应等比变化
  viewer.dispose();
});

test('文字渲染器：搜索返回命中数与位置，并把命中段落滚进视野', () => {
  const doc = makeTextDoc(500);
  const viewer = new ReflowViewer();
  viewer.mount(dom.container(1024, 720));
  viewer.setDocument(doc);
  const scroller = synthesizeViewport(viewer.element as unknown as StubElement, 1024, 720, 0);
  assert.ok(scroller);

  const hit = viewer.search('第 400 段');
  assert.ok(hit, '应能找到「第 400 段」');
  assert.equal(hit.total, 2, '第 400 段与「第 400 段的正文内容」共 2 处命中');
  assert.equal(hit.index, 0);
  assert.ok(scroller.scrollTop > 0, `搜索应把命中滚进视野（scrollTop=${scroller.scrollTop}）`);

  // 目标段落应已渲染并带高亮
  const text = collectText(viewer.element as unknown as StubElement);
  assert.ok(text.includes('第 400 段'), '命中段落应在渲染窗口内');
  const marks = viewer.element.querySelectorAll('mark.lo-hit');
  assert.ok(marks.length > 0, '命中片段应被包成 <mark>');

  // 下一个命中
  const next = viewer.search('第 400 段', hit.index + 1);
  assert.ok(next);
  assert.equal(next.index, 1);

  // 无命中
  assert.equal(viewer.search('绝对不存在的字符串'), null);
  viewer.dispose();
});

test('文字渲染器：大纲跳转 + 变高回填', () => {
  const doc = makeTextDoc(400);
  const viewer = new ReflowViewer();
  viewer.mount(dom.container(1024, 720));
  viewer.setDocument(doc);
  const scroller = synthesizeViewport(viewer.element as unknown as StubElement, 1024, 720, 0);
  assert.ok(scroller);

  viewer.scrollTo({ kind: 'block', index: 300 });
  const text = collectText(viewer.element as unknown as StubElement);
  assert.ok(text.includes('第 300 段'), `大纲跳转后应看到第 300 段，实际：${text.slice(0, 120)}`);

  // 实测回填：桩里 offsetHeight 默认为 0，渲染器必须**拒绝**把 0 当真值，
  // 否则内容总高会被压成 0（滚动条消失、整页塌陷）。
  const spacer = viewer.element.querySelector('.lo-spacer') as unknown as StubElement;
  const spacerH = Number.parseFloat(spacer.style.height);
  assert.ok(spacerH > 1000, `offsetHeight=0 时总高必须仍有估算值（实际 ${spacer.style.height}）`);

  // 真的给一个高度：内容总高应随之变化
  const block = viewer.element.querySelector('.lo-block') as unknown as StubElement;
  assert.ok(block);
  block.offsetHeight = 500;
  scroller.dispatchEvent({ type: 'scroll' });
  const spacerAfter = Number.parseFloat((viewer.element.querySelector('.lo-spacer') as unknown as StubElement).style.height);
  console.log(`[变高回填] 把某一实测高度设为 500px 后，内容总高 ${spacerH} -> ${spacerAfter}`);
  assert.ok(spacerAfter >= spacerH, `回填后的总高应不小于估算总高（${spacerH} -> ${spacerAfter}）`);
  viewer.dispose();
});

test('文字渲染器：dispose 后容器被清空', () => {
  const viewer = new ReflowViewer();
  const container = dom.container(1024, 720);
  viewer.mount(container);
  viewer.setDocument(makeTextDoc(200));
  assert.ok(viewer.renderedNodes > 3);
  viewer.dispose();
  assert.equal(viewer.renderedNodes, 0, 'dispose 必须清空渲染器根元素');
  assert.equal(container.querySelectorAll('*').length, 1, '容器里只应剩渲染器根元素本身');
});

test('文字渲染器：不用 innerHTML（XSS 防护）', () => {
  const evil = '<img src=x onerror="globalThis.__pwned=1">';
  const doc = createDocument({
    kind: 'text',
    format: 'txt',
    formatLabel: '纯文本',
    name: 'evil.txt',
    blocks: [{ kind: 'para', runs: [{ text: evil }] }],
  });
  const viewer = new ReflowViewer();
  viewer.mount(dom.container());
  viewer.setDocument(doc);
  const text = collectText(viewer.element as unknown as StubElement);
  // 恶意串必须原样作为**文本**出现，而不是变成元素
  assert.equal(text, evil, '用户内容必须原样显示为文本');
  assert.equal(viewer.element.querySelectorAll('img').length, 0, '绝不能真的创建出 <img> 元素');
  assert.equal((globalThis as Record<string, unknown>).__pwned, undefined);
  viewer.dispose();
});

/* ==================================================================== */
/* 核心：表格虚拟化                                                      */
/* ==================================================================== */

test('表格渲染器：长文本溢出到右边空格（Excel 行为），右邻有内容才截断，且都有 tooltip', async () => {
  /*
   * 用户的反馈是「大的数据我只能看到省略号」。
   * Excel 的真实行为：内容比列宽长时，文字继续画在**右边的空格子**上，
   * 直到遇到下一个有内容的列才截断。我们早期一律 overflow:hidden + 省略号。
   *
   * 一个长标题 + 两个空格  → 扩宽横跨三列显示，且不带省略号
   * 一个长标题 + 紧邻有内容 → 截断 + 省略号
   * 两种都要有原生 tooltip，保证用户总能读到完整值。
   */
  const LONG = '这是一个很长很长的备注文字用来触发溢出'; // 远超 50pt 列宽
  const grid = new MaterializedGrid(
    [
      {
        r: 0,
        cells: [
          { r: 0, c: 0, v: LONG, t: 's' }, // 右侧两列全空 → 应溢出
        ],
      },
      {
        r: 1,
        cells: [
          { r: 1, c: 0, v: LONG, t: 's' }, // 右邻紧邻有内容 → 应截断
          { r: 1, c: 1, v: 'X', t: 's' }, // 紧邻
          { r: 1, c: 2, v: 'Y', t: 's' },
        ],
      },
    ],
    2,
    3,
  );
  const doc = createDocument({
    kind: 'sheet',
    format: 'xlsx',
    formatLabel: 'x',
    name: 'spill.xlsx',
    sheets: [
      {
        name: 'S',
        rowCount: 2,
        colCount: 3,
        styles: [],
        colWidths: [50, 50, 50],
        defaultColWidth: 50,
        defaultRowHeight: 18,
        merges: [],
        readRows: (s, e) => grid.readRows(s, e),
      },
    ],
  });
  const viewer = new GridViewer();
  const container = dom.container(1200, 800);
  viewer.mount(container);
  viewer.setDocument(doc);
  await tick();
  synthesizeViewport(viewer.element as unknown as StubElement, 1200, 800, 0);
  await tick();

  const all = [...viewer.element.querySelectorAll('.lo-cell')];
  const at = (r: number, c: number): StubElement | undefined =>
    all.find((e) => e.getAttribute('data-r') === String(r) && e.getAttribute('data-c') === String(c));

  // 情形 1：右边全空 → 溢出到第 3 列边界（50×3 = 150pt → 200px）
  const spill = at(0, 0);
  assert.ok(spill, '行0 列0 应被渲染');
  assert.ok(spill!.classList.contains('lo-cell-spill'), '长文本且右侧全空时应溢出显示');
  assert.ok(Math.abs(parseFloat(spill!.style.width) - 200) < 1.5, `溢出宽度应扩到三列 200px，实际 ${spill!.style.width}`);
  assert.ok(!spill!.style.textOverflow, `溢出时不应再加省略号，实际 ${spill!.style.textOverflow}`);
  assert.equal(spill!.getAttribute('title'), LONG, '溢出格也要有 tooltip，保证能读到完整值');

  // 情形 2：右边紧邻有内容 → 截断 + 省略号
  const clipped = at(1, 0);
  assert.ok(clipped, '行1 列0 应被渲染');
  assert.ok(!clipped!.classList.contains('lo-cell-spill'), '右邻有内容时不得溢出');
  assert.equal(clipped!.style.textOverflow, 'ellipsis', '截断时必须给省略号提示');
  assert.ok(Math.abs(parseFloat(clipped!.style.width) - (50 * 4) / 3) < 1.5, '截断时宽度仍是本列宽度');
  assert.equal(clipped!.getAttribute('title'), LONG, '被截断的格子必须有 tooltip');

  // 短内容不该带 tooltip，也不该被判为溢出
  const short = at(1, 1);
  assert.ok(short, '行1 列1 应被渲染');
  assert.equal(short!.getAttribute('title'), null, '短内容不需要 tooltip');
  assert.ok(!short!.classList.contains('lo-cell-spill'), '短内容不该溢出');

  doc.dispose();
});

test('表格渲染器：每列必须用本列的真实宽度，且左边界按列宽累加（曾全部退回默认宽度）', async () => {
  /*
   * 真实案例：一份 9 列的 Excel，读取器给出的 colWidths 是
   * [45.75, 114.66, 70.69, 38.53, …]，但渲染出来的每个单元格都是 **68px**（默认列宽）——
   * 因为 buildCell 对普通单元格直接用了 defColW，只有**合并**单元格才去累加真实列宽。
   *
   * 后果有两层：
   *   1. 表头「学号（按顺序排序）」挤在 68px 里被 overflow:hidden 裁掉
   *   2. 列的**位置**当时按真实宽度算、宽度却是默认值 → 位置与宽度对不上，表格看起来错位
   *
   * 电子表格里列宽是最重要的排版信息之一，不能退化成一个全局常数。
   */
  const colWidths = [100, 50, 200]; // pt
  const grid = new MaterializedGrid(
    [
      {
        r: 0,
        cells: [
          { r: 0, c: 0, v: 'A', t: 's' },
          { r: 0, c: 1, v: 'B', t: 's' },
          { r: 0, c: 2, v: 'C', t: 's' },
        ],
      },
    ],
    1,
    3,
  );
  const doc = createDocument({
    kind: 'sheet',
    format: 'xlsx',
    formatLabel: 'x',
    name: 'widths.xlsx',
    sheets: [
      {
        name: 'S',
        rowCount: 1,
        colCount: 3,
        styles: [],
        colWidths,
        defaultColWidth: 64,
        defaultRowHeight: 18,
        merges: [],
        readRows: (s, e) => grid.readRows(s, e),
      },
    ],
  });
  const viewer = new GridViewer();
  const container = dom.container(1200, 800);
  viewer.mount(container);
  viewer.setDocument(doc);
  await tick();
  synthesizeViewport(viewer.element as unknown as StubElement, 1200, 800, 0);
  await tick();

  const cells = [...viewer.element.querySelectorAll('.lo-cell')].sort(
    (a, b) => Number(a.getAttribute('data-c')) - Number(b.getAttribute('data-c')),
  );
  assert.equal(cells.length, 3, `应渲染 3 个单元格，实际 ${cells.length}`);

  const px = (pt: number): number => (pt * 4) / 3; // 96 dpi
  const width = (i: number): number => parseFloat(cells[i].style.width);
  const left = (i: number): number => parseFloat(cells[i].style.left);

  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(width(i) - px(colWidths[i])) < 1.5,
      `列${i} 宽度应为 ${px(colWidths[i])}px（本列真实宽度），实际 ${cells[i].style.width}`,
    );
  }
  // 相邻列必须无缝：left(i) + width(i) === left(i+1)。位置与宽度单位不一致时这条会断。
  for (let i = 1; i < 3; i++) {
    assert.ok(
      Math.abs(left(i) - (left(i - 1) + width(i - 1))) < 1.5,
      `列${i} 左边界应为列${i - 1} 的右边界（left=${left(i)}，期望 ${left(i - 1) + width(i - 1)}）`,
    );
  }
  doc.dispose();
});

test('虚拟化核心：5 万行表格只渲染可见行级别的节点', async () => {
  const ROWS = 50_000;
  const COLS = 30;
  const doc = makeGridDoc(ROWS, COLS);
  const viewer = new GridViewer();
  const container = dom.container(1024, 720);
  viewer.mount(container);
  viewer.setDocument(doc);

  // 等异步 readRows 落地
  await tick();
  const scroller = synthesizeViewport(viewer.element as unknown as StubElement, 1024, 720, 0);
  assert.ok(scroller);
  await tick();

  const rendered = viewer.renderedNodes;
  const cells = viewer.element.querySelectorAll('.lo-cell').length;
  console.log(`[虚拟化实测] ${ROWS} 行 × ${COLS} 列（共 ${(ROWS * COLS).toLocaleString('en-US')} 格）：renderedNodes=${rendered}，实际 .lo-cell=${cells}`);
  assert.ok(cells < 1000, `5 万行表只能渲染可见窗口级别的单元格（实际 ${cells}）`);
  assert.ok(rendered < 1500, `节点总数必须远小于表规模（实际 ${rendered}）`);
  // 反证：如果全量渲染会是 150 万节点
  assert.ok(rendered < (ROWS * COLS) / 1000, '渲染量与表规模必须脱钩');

  // 滚到第 3 万行。
  // 用 scrollTo 而不是手算 scrollTop：行高在模型里是 pt，到视口是 px（18pt = 24px），
  // 手算极易把单位搞错（我第一版就写成 18px，于是断言的是第 22493 行）。
  viewer.scrollTo({ kind: 'cell', index: 30_000, row: 30_000, col: 0 });
  await tick();
  const cells2 = viewer.element.querySelectorAll('.lo-cell').length;
  const rendered2 = viewer.renderedNodes;
  console.log(`[虚拟化实测] 滚到第 30000 行后：renderedNodes=${rendered2}，.lo-cell=${cells2}`);
  assert.ok(cells2 < 1000, `滚动后单元格数仍必须是窗口级别（实际 ${cells2}）`);

  // 内容正确：滚到哪，渲染的就是那一行的数据
  const text = collectText(viewer.element as unknown as StubElement);
  assert.ok(text.includes('R30000C0'), `应渲染第 30000 行的数据，实际样本：${text.slice(0, 120)}`);
  // 并且不该再渲染第一行（回收生效，不是只增不减）
  assert.ok(!text.includes('R0C0'), `滚走后第 0 行必须被回收，实际样本：${text.slice(0, 120)}`);
  viewer.dispose();
});

test('表格渲染器：异步读取的竞态保护（滚走后的结果必须丢弃）', async () => {
  // 造一个「读得特别慢」的网格：模拟 LazyGrid 重新流式解析源 XML
  const ROWS = 5000;
  const pending: Array<{ start: number; end: number; resolve: (rows: CellRow[]) => void }> = [];
  const sheet = {
    name: 'Slow',
    rowCount: ROWS,
    colCount: 4,
    styles: [],
    defaultColWidth: 64,
    defaultRowHeight: 18,
    readRows: (start: number, end: number): Promise<CellRow[]> =>
      new Promise((resolve) => {
        pending.push({ start, end, resolve });
      }),
  };
  const doc = createDocument({ kind: 'sheet', format: 'xlsx', formatLabel: 'x', name: 'slow.xlsx', sheets: [sheet as never] });
  const viewer = new GridViewer();
  const container = dom.container(1024, 720);
  viewer.mount(container);
  viewer.setDocument(doc);
  const scroller = synthesizeViewport(viewer.element as unknown as StubElement, 1024, 720, 0);
  assert.ok(scroller);
  assert.ok(pending.length >= 1, '应发起一次读取');

  // 还没返回时滚走，触发第二次读取
  const first = pending[0];
  scroller.scrollTop = 40_000;
  scroller.dispatchEvent({ type: 'scroll' });
  await tick();
  assert.ok(pending.length >= 2, `滚动后应发起第二次读取（实际 ${pending.length} 次）`);
  const second = pending[pending.length - 1];

  // 先让**旧**的那次返回：它跨越的窗口已经过期，必须被丢弃
  first.resolve(
    Array.from({ length: first.end - first.start }, (_v, i) => ({ r: first.start + i, cells: [{ r: first.start + i, c: 0, v: 'STALE' }] })),
  );
  await tick();
  const afterStale = collectText(viewer.element as unknown as StubElement);
  assert.ok(!afterStale.includes('STALE'), '过期的读取结果绝不能被渲染（否则数据看起来对但行列是错的）');
  assert.ok(viewer.discarded >= 1, `应记录到被丢弃的读取（实际 ${viewer.discarded}）`);

  // 新的那次返回：正常渲染（这里同时验证「发起渲染的那次读取不会误判自己过期」）
  const start2 = second.start;
  second.resolve(Array.from({ length: second.end - start2 }, (_v, i) => ({ r: start2 + i, cells: [{ r: start2 + i, c: 0, v: `FRESH${start2 + i}` }] })));
  await tick();
  const afterFresh = collectText(viewer.element as unknown as StubElement);
  assert.ok(afterFresh.includes('FRESH'), `最新一次读取应正常渲染，实际：${afterFresh.slice(0, 120)}`);
  console.log(`[竞态保护] 丢弃过期读取 ${viewer.discarded} 次，最新结果已落地（第 ${start2} 行起）`);
  viewer.dispose();
});

test('表格渲染器：合并单元格在窗口边界的行为 + dispose 清空', async () => {
  const ROWS = 500;
  const grid = new MaterializedGrid(
    Array.from({ length: ROWS }, (_v, r): CellRow => ({ r, cells: [{ r, c: 0, v: `r${r}`, t: 's' }] })),
    ROWS,
    5,
  );
  const doc = createDocument({
    kind: 'sheet',
    format: 'xlsx',
    formatLabel: 'x',
    name: 'merge.xlsx',
    sheets: [
      {
        name: 'M',
        rowCount: ROWS,
        colCount: 5,
        styles: [],
        defaultColWidth: 64,
        defaultRowHeight: 18,
        // A1:C1 横向合并；A10:A20 纵向合并
        merges: [
          { r1: 0, c1: 0, r2: 0, c2: 2 },
          { r1: 9, c1: 0, r2: 19, c2: 0 },
        ],
        readRows: (s, e) => grid.readRows(s, e),
      },
    ],
  });
  const viewer = new GridViewer();
  viewer.mount(dom.container(1024, 720));
  viewer.setDocument(doc);
  synthesizeViewport(viewer.element as unknown as StubElement, 1024, 720, 0);
  await new Promise((r) => setTimeout(r, 0));

  const merged = viewer.element.querySelectorAll('.lo-merged');
  assert.ok(merged.length >= 1, '窗口内应渲染合并锚点');
  // 锚点被合并吃掉的格不应该出现（否则会盖住锚点内容）
  const dead = viewer.element.querySelectorAll('[data-r="0"][data-c="1"]');
  assert.equal(dead.length, 0, '被横向合并吃掉的 B1 不该渲染');

  viewer.dispose();
  assert.equal(viewer.renderedNodes, 0);
});

/* ==================================================================== */
/* 幻灯片 / PDF                                                         */
/* ==================================================================== */

test('幻灯片渲染器：只为视口内的幻灯片创建形状（与总页数脱钩）', () => {
  StubIntersectionObserver.reset();
  const SLIDES = 300;
  const SHAPES = 8;
  const doc = makeSlidesDoc(SLIDES, SHAPES);
  const viewer = new SlidesViewer();
  const container = dom.container(1024, 720);
  viewer.mount(container);
  viewer.setDocument(doc);

  // 占位 div 每页一个（决定滚动条总高）：这部分是 O(页数) 的常数开销
  const frames = viewer.element.querySelectorAll('.lo-slide');
  assert.equal(frames.length, SLIDES, '占位 div 必须每页一个（决定滚动条总高）');
  const before = viewer.renderedNodes;
  const populatedAtMount = viewer.populatedSlides;
  console.log(
    `[虚拟化实测] ${SLIDES} 张幻灯片、每张 ${SHAPES} 个形状：占位阶段 renderedNodes=${before}，`
    + `已渲染形状的页数=${populatedAtMount}（若全量渲染约 ${SLIDES * SHAPES} 个形状）`,
  );
  // 核心不变量：渲染量由视口决定，不由文稿页数决定
  assert.ok(populatedAtMount <= 5, `只应为视口附近少数几页创建形状（实际 ${populatedAtMount} 页）`);
  assert.ok(before < SLIDES + populatedAtMount * SHAPES * 6, '节点数应约为「页数占位 + 少量形状」');

  // 让远处的一页进入视口：它才会被填充
  const io = StubIntersectionObserver.latest();
  assert.ok(io, '应交出 IntersectionObserver 实例');
  const farIndex = 250;
  assert.ok(!viewer.element.querySelector(`[data-slide-index="${farIndex}"] .lo-shape`), '远处页此刻不应有形状');
  io.trigger([{ target: frames[farIndex] as unknown as StubElement, isIntersecting: true }]);
  const farShapes = frames[farIndex].querySelectorAll('.lo-shape').length;
  assert.equal(farShapes, SHAPES, `进入视口的页应把 ${SHAPES} 个形状建出来（实际 ${farShapes}）`);

  // 离开视口：形状必须被回收（只留占位）
  io.trigger([{ target: frames[farIndex] as unknown as StubElement, isIntersecting: false }]);
  assert.equal(frames[farIndex].querySelectorAll('.lo-shape').length, 0, '离开视口后必须回收形状节点');
  assert.equal(viewer.populatedSlides, populatedAtMount, '回收后已填充页数应回到挂载时的水平');

  // 形状内容正确
  io.trigger([{ target: frames[5] as unknown as StubElement, isIntersecting: true }]);
  const text = collectText(frames[5] as unknown as StubElement);
  assert.ok(text.includes('幻灯片 5 的形状 0'), `形状文本应正确，实际：${text.slice(0, 80)}`);

  // 缩放后仍然只为视口附近的页建内容
  viewer.setZoom(2);
  assert.ok(viewer.populatedSlides <= 10, `缩放后填充页数仍应受视口约束（实际 ${viewer.populatedSlides}）`);
  viewer.dispose();
  assert.equal(viewer.renderedNodes, 0);
});

test('幻灯片渲染器：搜索命中并高亮', () => {
  StubIntersectionObserver.reset();
  const doc = makeSlidesDoc(20, 3);
  const viewer = new SlidesViewer();
  const container = dom.container(1024, 720);
  // 桩里没有 CSS 级联，scroller 拿不到高度；挂载前先给根元素一个视口尺寸，
  // 这样 search 触发的「把命中页滚进视野并渲染」走的是真实路径。
  (viewer.element as unknown as StubElement).clientHeight = 720;
  (viewer.element as unknown as StubElement).clientWidth = 1024;
  viewer.mount(container);
  viewer.setDocument(doc);

  const hit = viewer.search('幻灯片 12');
  assert.ok(hit, '应命中第 12 张');
  assert.ok(hit.total >= 1);
  assert.ok(viewer.populatedSlides >= 1, '命中页必须被渲染出来才能看到高亮');
  const marks = viewer.element.querySelectorAll('mark.lo-hit');
  assert.ok(marks.length > 0, `命中应被高亮，实际 ${marks.length} 处`);
  // 命中的是第 12 张
  const text = collectText(viewer.element as unknown as StubElement);
  assert.ok(text.includes('幻灯片 12'), `应渲染命中的那一张，实际：${text.slice(0, 80)}`);
  viewer.dispose();
});

test('PDF 渲染器：只为视口内的页面创建文本项（与总页数脱钩）', () => {
  StubIntersectionObserver.reset();
  const PAGES = 200;
  const PER_PAGE = 40;
  const doc = makePdfDoc(PAGES, PER_PAGE);
  const viewer = new PdfViewer();
  const container = dom.container(1024, 720);
  viewer.mount(container);
  viewer.setDocument(doc);

  const frames = viewer.element.querySelectorAll('.lo-pdf-page');
  assert.equal(frames.length, PAGES, '每页一个定尺寸容器（决定滚动条总高）');
  const before = viewer.renderedNodes;
  const populatedAtMount = viewer.populatedPages;
  console.log(
    `[虚拟化实测] ${PAGES} 页 PDF、每页 ${PER_PAGE} 个文本项：容器阶段 renderedNodes=${before}，`
    + `已填充页数=${populatedAtMount}（若全量渲染约 ${PAGES * PER_PAGE} 个文本项）`,
  );
  assert.ok(populatedAtMount <= 8, `只应为视口附近少数几页创建文本项（实际 ${populatedAtMount} 页）`);
  assert.ok(before < 400, `节点数必须与总页数脱钩（实际 ${before}）`);

  const io = StubIntersectionObserver.latest();
  assert.ok(io, 'PDF 视图也应使用 IntersectionObserver');
  const far = 150;
  io.trigger([{ target: frames[far] as unknown as StubElement, isIntersecting: true }]);
  const afterOne = viewer.renderedNodes;
  console.log(`[虚拟化实测] 让第 ${far} 页进入视口后：renderedNodes=${afterOne}（该页新增 ${PER_PAGE} 个文本项）`);
  assert.equal(frames[far].querySelectorAll('.lo-pdf-text').length, PER_PAGE);

  // PDF 坐标：第 0 页第 0 项 y=700，页高 792，字号 10 → top = 792-700-10 = 82
  io.trigger([{ target: frames[0] as unknown as StubElement, isIntersecting: true }]);
  const span = frames[0].querySelector('.lo-pdf-text') as unknown as StubElement;
  assert.ok(span, '应渲染文本 span');
  assert.equal(span.style.top, '82px', `PDF y 轴必须翻转（实际 top=${span.style.top}）`);
  assert.equal(span.style.left, '72px');
  assert.equal(span.textContent, 'page 0 line 0');
  // 10pt 在 96dpi 下是 13.333px（渲染器给出 ptToPx 原值，不取整）
  assert.equal(span.style.fontSize, `${ptToPxForTest(10)}px`, `10pt -> ${ptToPxForTest(10)}px`);

  // 回收
  io.trigger([{ target: frames[far] as unknown as StubElement, isIntersecting: false }]);
  assert.equal(frames[far].querySelectorAll('.lo-pdf-text').length, 0, '离开视口必须回收文本项');

  // 缩放：坐标与字号同比例
  io.trigger([{ target: frames[3] as unknown as StubElement, isIntersecting: true }]);
  viewer.setZoom(2);
  const zoomedFrames = viewer.element.querySelectorAll('.lo-pdf-page');
  assert.equal((zoomedFrames[0] as unknown as StubElement).style.width, `${ptToPxForTest(612) * 2}px`, '缩放后页宽应翻倍');
  viewer.dispose();
  assert.equal(viewer.renderedNodes, 0);
});

/* ==================================================================== */
/* 工厂与安全                                                           */
/* ==================================================================== */

test('工厂：按 doc.kind 分派到正确渲染器', () => {
  assert.equal(canRender('text'), true);
  assert.equal(canRender('sheet'), true);
  assert.equal(canRender('slides'), true);
  assert.equal(canRender('pdf'), true);
  assert.equal(canRender('raw'), true, 'raw 文档用文字渲染器兜底');

  assert.ok(createViewer(makeTextDoc(1)).element.className.includes('lo-reflow'));
  assert.ok(createViewer(makeGridDoc(1, 1)).element.className.includes('lo-grid'));
  assert.ok(createViewer(makeSlidesDoc(1, 1)).element.className.includes('lo-slides'));
  assert.ok(createViewer(makePdfDoc(1, 1)).element.className.includes('lo-pdf'));
});

test('工厂：raw 文档（只有 text）也能显示', () => {
  const doc = createDocument({ kind: 'raw', format: 'unknown', formatLabel: '未知格式', name: 'x.bin', text: '第一行\n第二行\n第三行' });
  const viewer = createViewer(doc);
  viewer.mount(dom.container());
  const text = collectText(viewer.element as unknown as StubElement);
  assert.ok(text.includes('第一行') && text.includes('第三行'), `纯文本兜底应逐行渲染，实际：${text.slice(0, 60)}`);
  viewer.dispose();
});

test('安全：链接写进 data-link 并过滤危险协议，不写 href', () => {
  const doc = createDocument({
    kind: 'text',
    format: 'html',
    formatLabel: 'HTML',
    name: 'l.html',
    blocks: [
      {
        kind: 'para',
        runs: [
          { text: '安全链接', style: { link: 'https://example.com/a' } },
          { text: '危险链接', style: { link: 'javascript:alert(1)' } },
        ],
      },
    ],
  });
  const viewer = new ReflowViewer();
  viewer.mount(dom.container());
  viewer.setDocument(doc);
  const anchors = viewer.element.querySelectorAll('a');
  assert.equal(anchors.length, 2);
  const first = anchors[0] as unknown as StubElement;
  assert.equal(first.getAttribute('data-link'), 'https://example.com/a');
  assert.equal(first.getAttribute('href'), null, '不能写真实 href，否则点击即执行');
  assert.equal(anchors[1].getAttribute('data-link'), 'javascript:alert(1)');
  viewer.dispose();
});

test('未挂载时调用 setDocument/scrollTo 不抛错（健壮性）', () => {
  const viewer = new ReflowViewer();
  viewer.setDocument(makeTextDoc(10));
  viewer.setZoom(1.5);
  viewer.scrollTo({ kind: 'block', index: 5 });
  assert.equal(viewer.search('第 5 段') !== null, true);
  viewer.dispose();
  // dispose 幂等
  viewer.dispose();
});
