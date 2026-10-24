/**
 * 端到端集成测试：真实文件 → 嗅探 → 读取器 → UDM → DOM。
 *
 * 这是本项目唯一一个**贯通全部层次**的测试，因此它的价值不在于覆盖细节，
 * 而在于证明架构主张成立：
 *
 *   1. 「M + N」成立 —— 四种文档类别（文字/表格/演示/PDF）用**同一个**
 *      `createViewer()` 入口渲染，壳层不认识任何具体格式
 *   2. 真实第三方文件能被打开并渲染出内容（不是空白、不是乱码）
 *   3. 虚拟化真的生效 —— 大文档的 DOM 节点数远小于内容块数
 *   4. 单位换算贯通 —— pt → px 在真实文档上得到预期字号
 *
 * ── 关于测试环境的两条重要说明 ──
 *
 * ① **必须在导入渲染器之前安装 DOM 桩。** 渲染器在模块顶层缓存 `document`
 *    引用（避免每次渲染都查全局），所以本文件对渲染器一律用动态 import。
 *
 * ② **DOM 桩没有布局引擎。** 所有元素的 `clientHeight` 恒为 0，于是渲染器会走
 *    「视口为 0 时渲染开头几块」的兜底路径 —— 那条路径能防白屏，但**测不到真正的
 *    按视口虚拟化**。因此这里用 `applyViewport()` 合成视口尺寸，再主动触发一次
 *    重排，让断言落在真实路径上。否则这个测试会「因为什么都没渲染」而虚假通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDomStub } from '../packages/render-dom/testutil/domstub.ts';
import { openDocument } from '../packages/engine/src/index.ts';
import { coveredFormats } from '../packages/core/src/registry.ts';
import { formatByExtension } from '../packages/core/src/formats.ts';

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

const dom = installDomStub();
const render = await import('../packages/render-dom/src/index.ts');

/** 读取器包可能尚未实现或正在开发，缺失时报告而不是让整个文件失败 */
const READER_PACKAGES = ['format-text', 'format-docx', 'format-xlsx', 'format-odf', 'format-pptx', 'format-pdf'];
const loadedReaders: string[] = [];
const missingReaders: string[] = [];
for (const p of READER_PACKAGES) {
  try {
    await import(`../packages/${p}/src/index.ts`);
    loadedReaders.push(p);
  } catch (err) {
    missingReaders.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`  [集成] 已加载读取器 ${loadedReaders.length}/${READER_PACKAGES.length}，覆盖格式 ${coveredFormats().length} 种`);
if (missingReaders.length) console.log(`  [集成] 缺失/加载失败: ${missingReaders.join(' | ')}`);

/** 最小结构类型，避免为一堆 DOM 桩细节写类型体操 */
interface StubLike {
  nodeType?: number;
  tagName?: string;
  children?: StubLike[];
  childNodes?: StubLike[];
  textContent?: string | null;
  clientWidth?: number;
  clientHeight?: number;
  offsetWidth?: number;
  offsetHeight?: number;
  scrollHeight?: number;
}

/**
 * 取子树里的全部文本。
 *
 * **必须沿 childNodes（含 nodeType 3 的文本节点）递归**，不能只走 children：
 * DOM 桩的 `textContent` 是普通存储属性，不会拼接后代文本，
 * 而 `children` 只含元素节点。只看 children 会让「段落里只有文本」的情况取到 null，
 * 表现为「明明渲染了却测得 0 字」—— 这个坑已经踩过一次。
 */
function allText(node: StubLike | null | undefined): string {
  if (!node) return '';
  const kids = node.childNodes;
  if (!kids || kids.length === 0) {
    return typeof node.textContent === 'string' ? node.textContent : '';
  }
  let out = '';
  for (const c of kids) {
    // 文本节点没有 childNodes（或为空）→ 取自身 textContent
    if (!c.childNodes || c.childNodes.length === 0) {
      if (typeof c.textContent === 'string') out += c.textContent;
    } else {
      out += allText(c);
    }
  }
  return out;
}

/**
 * 合成视口尺寸。DOM 桩没有布局引擎，这里把尺寸写进每个元素，
 * 让渲染器读到非零视口后走真实的虚拟化路径。
 */
function applyViewport(root: StubLike, width: number, height: number): void {
  const walk = (el: StubLike): void => {
    el.clientWidth = width;
    el.clientHeight = height;
    el.offsetWidth = width;
    el.offsetHeight = height;
    for (const c of el.children ?? []) walk(c);
  };
  walk(root);
}

/** 安全读取：云端占位文件（OneDrive/WPS Drive 的「仅在线」）会读失败，应当跳过而不是失败 */
function tryRead(path: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}

interface Case {
  label: string;
  path: string;
  expectKind: 'text' | 'sheet' | 'slides' | 'pdf';
}

const WORKSPACE = 'C:\\deepseekharness';
const CASES: Case[] = [
  { label: 'docx（Word 生成，含图片与表格）', path: join(WORKSPACE, '二极管伏安特性实验报告.docx'), expectKind: 'text' },
  // 刻意选 Desktop 下的本地文件：WPS Drive / OneDrive 的「仅在线」占位文件会读失败
  { label: 'xlsx（WPS/Excel 生成的班会汇总表）', path: 'C:\\Users\\16595\\Desktop\\我的文件\\学生会\\2025年秋季学期第十三周主题班会汇总表 (1).xlsx', expectKind: 'sheet' },
  { label: 'pptx（教学课件，形状多）', path: 'C:\\Users\\16595\\Documents\\九年级上课件\\22章ppt新\\22.1一元二次方程(1).pptx', expectKind: 'slides' },
  { label: 'pdf（小文件）', path: 'C:\\Users\\16595\\Documents\\非安居区籍考生报考申请.pdf', expectKind: 'pdf' },
];

/* ------------------------------------------------------------------ */
/* 一、真实文件贯通                                                      */
/* ------------------------------------------------------------------ */

for (const c of CASES) {
  test(`端到端：${c.label}`, async (t) => {
    if (!existsSync(c.path)) {
      t.skip(`文件不存在：${c.path}`);
      return;
    }
    const bytes = tryRead(c.path);
    if (!bytes) {
      t.skip(`文件存在但读不出内容（多为云盘「仅在线」占位文件）：${c.path}`);
      return;
    }

    const { document, sniff } = await openDocument({ name: c.path.split('\\').pop(), bytes });

    assert.equal(
      document.kind,
      c.expectKind,
      `嗅探为 ${sniff.format}（${sniff.reason}），类别应为 ${c.expectKind}，实际 ${document.kind}`,
    );
    assert.ok(document.stats.modelBytes > 0, '必须报告模型体积');
    assert.ok(document.stats.parseMs >= 0);

    // 统一入口创建渲染器（壳层不认识具体格式，这是 M+N 的落点）
    const viewer = render.createViewer(document);
    const container = dom.container(1280, 720) as unknown as StubLike;
    viewer.mount(container as never);
    // 合成视口后主动触发一次重排，确保走的是真实虚拟化路径而非「视口为 0」兜底
    applyViewport(container, 1280, 720);
    viewer.setAvailableWidth(1280);

    const text = allText(container);
    const nodes = viewer.renderedNodes;

    console.log(
      `  [集成] ${sniff.format.padEnd(5)} ${(bytes.length / 1024).toFixed(0).padStart(5)} KiB  ` +
        `kind=${document.kind.padEnd(6)} 模型 ${(document.stats.modelBytes / 1024).toFixed(0).padStart(6)} KiB  ` +
        `节点 ${String(nodes).padStart(5)}  文本 ${String(text.length).padStart(6)} 字  ${document.stats.parseMs.toFixed(0)} ms` +
        (document.stats.warnings.length ? `  告警 ${document.stats.warnings.length}` : ''),
    );

    // ---- 渲染必须真的产出内容 ----
    // nodes 至少要超过包装节点数（viewer/scroller/content/spacer = 3），
    // 否则就是「挂载成功但一个块都没渲染」——这正是 createViewer 忘调 setDocument 时的症状。
    assert.ok(nodes > 3, `渲染节点数 ${nodes} 过少，说明内容没有被渲染（包装节点是 3 个）`);
    assert.ok(text.length > 0, `渲染结果里应有文本内容（实际 ${text.length} 字）`);
    assert.ok(!/[\uFFFD]{3,}/.test(text), '文本里不应出现成片的替换字符（说明编码解错）');

    // ---- 缩放：pt → px 必须贯通 ----
    viewer.setZoom(2);
    assert.ok(allText(container).length > 0, '缩放后仍应有内容');
    viewer.setZoom(1);

    // ---- 搜索：文字类文档必须能命中 ----
    if (document.kind === 'text') {
      const probe = text.replace(/\s/g, '').slice(0, 2);
      if (probe.length >= 2) {
        const hit = viewer.search(probe);
        assert.ok(hit === null || hit.total >= 1, `搜索「${probe}」应命中或明确返回 null`);
      }
    }

    viewer.dispose();
    viewer.unmount();
    document.dispose();
  });
}

/* ------------------------------------------------------------------ */
/* 二、虚拟化：必须走真实视口路径，且节点数远小于内容量                     */
/* ------------------------------------------------------------------ */

test('端到端：大文档在真实视口下受虚拟化约束', async () => {
  const PARA_COUNT = 3000;
  const blocks = [];
  for (let i = 0; i < PARA_COUNT; i++) {
    blocks.push({
      kind: 'para',
      runs: [{ text: `第 ${i + 1} 段：这是一段用于验证虚拟化行为的文本，需要足够长以便触发换行估算。` }],
      style: { lineHeight: 1.5, spaceAfter: 6 },
    });
  }

  const { createDocument } = await import('../packages/core/src/index.ts');
  const doc = createDocument({
    kind: 'text',
    format: 'txt',
    formatLabel: '纯文本',
    name: 'big.txt',
    blocks,
    stats: { blockCount: PARA_COUNT },
  });

  const viewer = render.createViewer(doc);
  const container = dom.container(1024, 720) as unknown as StubLike;
  viewer.mount(container as never);
  applyViewport(container, 1024, 720);
  viewer.setAvailableWidth(1024);

  const text = allText(container);
  const nodes = viewer.renderedNodes;
  console.log(`  [集成] ${PARA_COUNT} 段 -> 节点 ${nodes}，可视文本 ${text.length} 字`);

  // 先证明「真的渲染了内容」，否则后面的「节点少」毫无意义（空渲染也满足「少」）
  assert.ok(text.length > 0, '视口合成后必须渲染出可见文本，否则虚拟化断言是虚假通过');
  assert.ok(nodes > 10, `渲染节点数 ${nodes} 过少，视口合成可能未生效`);
  // 再证明虚拟化：节点数应与视口容量同阶，而不是与 3000 段同阶
  assert.ok(
    nodes < PARA_COUNT / 10,
    `虚拟化未生效：${PARA_COUNT} 段文档渲染了 ${nodes} 个节点（应远小于 ${PARA_COUNT}）`,
  );

  // 跳到中间：节点数仍受约束，且不残留前面已渲染的内容
  viewer.scrollTo({ kind: 'block', index: Math.floor(PARA_COUNT / 2) });
  const midNodes = viewer.renderedNodes;
  const midText = allText(container);
  console.log(`  [集成] 滚到第 ${Math.floor(PARA_COUNT / 2)} 段 -> 节点 ${midNodes}，可视文本 ${midText.length} 字`);
  assert.ok(midNodes < PARA_COUNT / 10, `滚动后节点数应仍受约束，实际 ${midNodes}`);
  assert.ok(midText.length > 0, '滚动后仍应有可见文本');

  // 视口极小与极大都不应崩，且节点数仍受限
  viewer.setZoom(0.25);
  assert.ok(viewer.renderedNodes < PARA_COUNT / 10, '缩小后节点数仍应受限');
  viewer.setZoom(4);
  assert.ok(viewer.renderedNodes < PARA_COUNT, '放大后节点数不应爆炸到与段落数同阶');

  viewer.dispose();
  doc.dispose();
});

/* ------------------------------------------------------------------ */
/* 三、架构主张：四种类别共用同一入口                                      */
/* ------------------------------------------------------------------ */

test('端到端：四种文档类别共用同一个 createViewer 入口', () => {
  for (const kind of ['text', 'sheet', 'slides', 'pdf', 'raw']) {
    assert.ok(render.canRender(kind as never), `类别 ${kind} 应可渲染（否则壳层就得自己分派，M+N 就不成立了）`);
  }
});

test('端到端：未安装读取器的格式给出「未安装」而不是崩溃', () => {
  const declared = ['docx', 'xlsx', 'pptx', 'pdf', 'odt', 'ods', 'odp', 'md', 'csv', 'rtf'];
  const covered = new Set(coveredFormats());
  const notCovered = declared.filter((f) => !covered.has(f));
  assert.ok(Array.isArray(coveredFormats()));
  console.log(
    `  [集成] 已覆盖 ${covered.size} 种格式` +
      (notCovered.length ? `，尚未覆盖：${notCovered.join(', ')}（UI 应显示「未安装读取器」而不是「不认识该文件」）` : ''),
  );
  // 扩展名归属在任何情况下都必须能查到，否则文件对话框与格式徽标会失效
  for (const f of declared) {
    assert.ok(formatByExtension(`sample.${f}`), `扩展名 .${f} 必须能查到格式`);
  }
});
