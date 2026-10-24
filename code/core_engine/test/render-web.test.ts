/**
 * Web 壳测试。
 *
 * 这一组关注的是**纯逻辑能否在没有浏览器的环境里被验证**：
 *   - 格式读取器的动态注册与「格式支持」视图模型是否与运行时注册表一致
 *   - 相对导入路径是否真的解析得到（错一层的典型后果是整页白屏，
 *     而 `tools/build.mjs` 只做类型擦除、根本不解析导入，所以必须在测试里钉住）
 *   - 应用能否在最小 DOM 桩上完成启动流程（构造 + start 不抛错）
 *
 * 不测的东西（如实说明）：真实浏览器里的排版、File System Access API、
 * 拖放、CSS 视觉效果。这些没有浏览器就跑不了，硬测只会得到假信心。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDomStub } from '../packages/render-dom/testutil/domstub.ts';
import type { StubElement } from '../packages/render-dom/testutil/domstub.ts';

const dom = installDomStub();
after(() => dom.restore());

const { FORMATS, coveredFormats, allReaders } = await import('../packages/core/src/index.ts');
const { formatSupportGroups, formatSupportSummary, friendlyOpenError, readersStatusText, recommendReaderPackage, registerAllReaders, extraReaderFormats } =
  await import('../apps/web/src/format-registry.ts');

/* ==================================================================== */
/* 动态注册                                                             */
/* ==================================================================== */

test('动态注册：读取器包缺失时降级为「未安装」，不抛错、不阻塞其他包', async () => {
  const installs = await registerAllReaders();
  // 6 个候选包都要有结果（成功或明确的失败），绝不能整体抛错
  assert.equal(installs.length, 6, `应有 6 个读取器候选（实际 ${installs.length}）`);
  for (const it of installs) {
    assert.ok(typeof it.pkg === 'string' && it.pkg.length > 0);
    assert.equal(typeof it.ok, 'boolean');
    if (!it.ok) assert.ok(it.error, `失败项必须带原因：${it.pkg}`);
  }
  const okCount = installs.filter((i) => i.ok).length;
  console.log(`[读取器注册] 成功 ${okCount} / 共 ${installs.length} 个：${installs.map((i) => `${i.pkg}=${i.ok ? 'ok' : 'missing'}`).join(' ')}`);

  // 运行时注册表必须等于「导入成功的那些包」——
  // 若读取器忘记调用 registerReader()，这里会不等，能立刻发现
  const covered = new Set(coveredFormats());
  for (const it of installs) {
    if (!it.ok || !it.formats) continue;
    for (const f of it.formats) assert.ok(covered.has(f), `${it.pkg} 声称支持 ${f}，但注册表里没有`);
  }
});

test('格式支持面板：UI 状态与运行时注册表一致（不允许 UI 说支持但实际打不开）', () => {
  const covered = new Set(coveredFormats());
  const groups = formatSupportGroups();
  assert.ok(groups.length >= 4, '至少覆盖 文字/表格/演示/PDF 四类');

  let rows = 0;
  for (const g of groups) {
    for (const row of g.rows) {
      rows++;
      assert.equal(
        row.supported,
        covered.has(row.spec.id),
        `${row.spec.id} 的 UI 支持状态（${row.supported}）与注册表（${covered.has(row.spec.id)}）不一致`,
      );
    }
  }
  // 全部「非 unknown」格式都要出现在面板里，一个都不能漏
  const declared = FORMATS.filter((f) => f.id !== 'unknown').length;
  assert.equal(rows, declared, `面板应列出全部 ${declared} 种格式（实际 ${rows}）`);

  const summary = formatSupportSummary([]);
  assert.equal(summary.total, declared, 'total 应等于声明的格式数');
  // supported 只在「声明表全集」内统计 —— 不能直接用 covered.size，
  // 因为读取器可能声明声明表之外的 id（实测中有 potx/xltx），
  // 那会让「已支持 + 未安装 > 总数」，统计一眼就不可信。
  const coveredDeclared = FORMATS.filter((f) => f.id !== 'unknown' && covered.has(f.id)).length;
  assert.equal(summary.supported, coveredDeclared, `supported 应为「声明表内被覆盖」的数量（${summary.supported} vs ${coveredDeclared}）`);
  assert.equal(
    summary.supported + summary.missing.length,
    summary.total,
    `已支持(${summary.supported}) + 未安装(${summary.missing.length}) 必须等于声明总数(${summary.total})`,
  );
  // 读取器声明了声明表之外的格式时，必须能被诊断出来（不隐藏）
  const extra = extraReaderFormats();
  for (const id of extra) assert.ok(!FORMATS.some((f) => f.id === id), `${id} 确实不在声明表里`);
  if (extra.length > 0) console.log(`[格式支持] 读取器声明了声明表之外的 id（需读取器侧同步）：${extra.join(', ')}`);
  console.log(`[格式支持] 声明 ${summary.total} 种，运行时已支持 ${summary.supported} 种，未安装读取器 ${summary.missing.length} 种`);
});

test('格式支持面板：分组标题与扩展名展示', () => {
  const groups = formatSupportGroups();
  const titles = groups.map((g) => g.title);
  assert.ok(titles.includes('文字文档'));
  assert.ok(titles.includes('表格'));
  const textGroup = groups.find((g) => g.kind === 'text');
  assert.ok(textGroup && textGroup.rows.length > 0, '文字文档组不应为空');
  const docx = textGroup?.rows.find((r) => r.spec.id === 'docx');
  assert.ok(docx, '声明表里应有 docx');
});

test('状态栏文案：已安装 N 个读取器 + 支持 M/N 种格式', () => {
  const text = readersStatusText([]);
  assert.match(text, /读取器 \d+ 个/);
  assert.match(text, /支持 \d+\/\d+ 种格式/);
});

test('推荐读取器包：按格式家族给出安装建议', () => {
  assert.equal(recommendReaderPackage('docx'), 'format-docx');
  assert.equal(recommendReaderPackage('xlsx'), 'format-xlsx');
  assert.equal(recommendReaderPackage('pptx'), 'format-pptx');
  assert.equal(recommendReaderPackage('odt'), 'format-odf');
  assert.equal(recommendReaderPackage('pdf'), 'format-pdf');
  assert.equal(recommendReaderPackage('md'), 'format-text');
  assert.equal(recommendReaderPackage('unknown'), null);
});

test('失败提示讲人话：NO_READER 情况附带安装建议，且不暴露堆栈', () => {
  const err = Object.assign(new Error('内部：未找到读取器 xyz'), { name: 'ReadError', code: 'NO_READER', format: 'docx' });
  const message = friendlyOpenError(err, 'docx');
  assert.ok(message.includes('暂不支持打开该格式'), `应给出人话解释，实际：${message}`);
  assert.ok(message.includes('format-docx'), `应建议安装哪个包，实际：${message}`);
  assert.ok(!/at .*\(.*:\d+:\d+\)/.test(message), '绝不能把堆栈丢给用户');

  // 旧版二进制格式要给出可执行的建议
  const legacy = Object.assign(new Error('legacy'), { code: 'LEGACY_BINARY', format: 'ole2-doc' });
  const legacyMsg = friendlyOpenError(legacy);
  assert.ok(legacyMsg.includes('另存为'), `旧版格式应建议另存为，实际：${legacyMsg}`);

  // 非 ReadError 也要能兜住
  assert.ok(friendlyOpenError(new Error('随便什么错')).length > 0);
  assert.ok(friendlyOpenError('字符串错误').length > 0);
});

/* ==================================================================== */
/* 相对导入：必须在真实文件系统上解析得到                                */
/* ==================================================================== */

test('相对导入路径真实可解析（错一层就白屏，build 发现不了）', async () => {
  // 这些 import 一旦路径写错，build 依然成功（只做类型擦除），
  // 但浏览器加载时会 404 → 整个应用白屏。所以必须在这里真的导一次。
  const appMod = await import('../apps/web/src/app.ts');
  assert.equal(typeof appMod.LiteOfficeApp, 'function', 'app.ts 应导出 LiteOfficeApp');

  // main.ts 有副作用（DOMContentLoaded 后立即 bootstrap，会去查 #tabs 等节点），
  // 所以必须先准备好骨架再导入它。
  buildSkeleton();
  const mainMod = await import('../apps/web/src/main.ts');
  assert.ok(mainMod !== null, 'main.ts 应可加载');
});

/* ==================================================================== */
/* 启动流程（最小 DOM 桩）                                              */
/* ==================================================================== */

/** 造出 main.ts / app.ts 需要的全部 DOM 节点（只创建元素，不实现样式） */
function buildSkeleton(): void {
  const doc = dom.document;
  // 每次调用前清空 body，避免多个用例叠加出重复 id（getElementById 会取到旧节点）
  doc.body.replaceChildren();
  const ids = [
    'tabs',
    'views',
    'empty-state',
    'empty-formats',
    'search-input',
    'search-count',
    'zoom-range',
    'zoom-reset',
    'zoom-in',
    'zoom-out',
    'status-message',
    'status-readers',
    'panel-outline',
    'panel-info',
    'panel-tab-outline',
    'panel-tab-info',
    'formats-panel',
    'formats-body',
    'formats-summary',
    'formats-close',
    'drop-hint',
    'hud-source',
    'hud-model',
    'hud-ratio',
    'hud-heap',
    'hud-nodes',
    'hud-docs',
    'btn-open',
    'btn-formats',
    'btn-theme',
    'search-next',
  ];
  for (const id of ids) {
    const node = doc.createElement(id.startsWith('btn-') || id.startsWith('panel-tab') || id.startsWith('zoom-') ? 'button' : 'div');
    node.setAttribute('id', id);
    doc.body.appendChild(node);
  }
  // 复现真实 HTML 的初始状态：覆盖层与拖放提示默认带 is-hidden。
  // 少了这一步，测试会以为「格式面板一开始就是打开的」。
  doc.getElementById('formats-panel')?.classList.add('is-hidden');
  doc.getElementById('drop-hint')?.classList.add('is-hidden');
}

test('应用启动：构造 + start 不抛错，并渲染出状态与格式面板', async () => {
  buildSkeleton();
  const { LiteOfficeApp } = await import('../apps/web/src/app.ts');
  const app = new LiteOfficeApp();
  assert.equal(app.openDocumentCount, 0, '初始没有打开的文档');

  await app.start();

  // 状态栏必须给出「读取器」信息（而不是空白）
  const readers = dom.document.getElementById('status-readers');
  assert.ok(readers, '应存在状态栏读取器节点');
  assert.match(readers.textContent ?? '', /读取器 \d+ 个/, `状态栏应显示读取器数量，实际：${readers.textContent}`);

  // 格式支持面板必须列出了全部声明格式
  const body = dom.document.getElementById('formats-body');
  assert.ok(body, '应存在格式面板主体');
  const rows = body.querySelectorAll('.format-row').length;
  const declared = FORMATS.filter((f) => f.id !== 'unknown').length;
  assert.equal(rows, declared, `格式面板应列出 ${declared} 行（实际 ${rows}）`);

  // 空状态应展示格式提示（用户第一眼要知道支持什么）
  const chips = dom.document.getElementById('empty-formats')?.querySelectorAll('.empty-chip').length ?? 0;
  assert.equal(chips, declared, `空状态应有 ${declared} 个格式提示（实际 ${chips}）`);

  // 内存 HUD 必须已经填过一轮（不能是初始的占位符 '—' 全部保留）
  const docs = dom.document.getElementById('hud-docs');
  assert.equal(docs?.textContent, '0', '已打开文档数应为 0');
  const heap = dom.document.getElementById('hud-heap');
  // Node 下 memSnapshot() 走 process.memoryUsage()，所以应显示真实数字；
  // 若环境不支持，则必须是「不可用」而不是 0（诚实性要求）
  assert.ok(heap, '应存在实时堆节点');
  assert.notEqual(heap.textContent, '0', '实时堆不允许显示 0（那会误导用户以为占用为 0）');
  assert.ok(heap.textContent === '不可用' || /B|KiB|MiB|GiB/.test(heap.textContent ?? ''), `实时堆应显示人话，实际：${heap.textContent}`);

  // 主题切换：只改 html 的 data-theme
  const themeBtn = dom.document.getElementById('btn-theme');
  assert.ok(themeBtn);
  const before = dom.document.documentElement.getAttribute('data-theme');
  themeBtn.dispatchEvent({ type: 'click' });
  const afterTheme = dom.document.documentElement.getAttribute('data-theme');
  assert.notEqual(afterTheme, before, '点主题按钮应切换主题');
  assert.ok(afterTheme === 'dark' || afterTheme === 'light');

  // 格式面板开关
  const panel = dom.document.getElementById('formats-panel');
  assert.ok(panel?.classList.contains('is-hidden'), '初始应关闭格式面板');
  dom.document.getElementById('btn-formats')?.dispatchEvent({ type: 'click' });
  assert.ok(!panel?.classList.contains('is-hidden'), '点「格式支持」应打开面板');
  dom.document.getElementById('formats-close')?.dispatchEvent({ type: 'click' });
  assert.ok(panel?.classList.contains('is-hidden'), '点关闭应隐藏面板');

  // 侧栏面板切换
  const outline = dom.document.getElementById('panel-outline');
  const info = dom.document.getElementById('panel-info');
  assert.ok(!outline?.classList.contains('is-hidden'), '默认显示大纲面板');
  dom.document.getElementById('panel-tab-info')?.dispatchEvent({ type: 'click' });
  assert.ok(outline?.classList.contains('is-hidden'), '切到文档信息后大纲应隐藏');
  assert.ok(!info?.classList.contains('is-hidden'), '文档信息应显示');

  // 没有文档时，两个面板都应给出「该文档没有可用大纲 / 尚未打开」之类的说明
  assert.ok((outline?.textContent ?? '').length > 0 || (info?.textContent ?? '').length > 0);

  app.dispose();
});

test('应用：没有文档时缩放与搜索不抛错', async () => {
  buildSkeleton();
  const { LiteOfficeApp } = await import('../apps/web/src/app.ts');
  const app = new LiteOfficeApp();
  await app.start();
  await app.start(); // 幂等：重复 start 不应抛错

  // 缩放按钮在无文档时也不能炸
  dom.document.getElementById('zoom-in')?.dispatchEvent({ type: 'click' });
  dom.document.getElementById('zoom-out')?.dispatchEvent({ type: 'click' });
  dom.document.getElementById('zoom-reset')?.dispatchEvent({ type: 'click' });
  // 搜索在无文档时也不能炸
  const input = dom.document.getElementById('search-input') as unknown as StubElement;
  input.value = '关键字';
  input.dispatchEvent({ type: 'input' });
  assert.equal(dom.document.getElementById('search-count')?.textContent, '', '无文档时不应显示命中数');

  // Esc 关闭面板
  dom.window.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.ok(dom.document.getElementById('formats-panel')?.classList.contains('is-hidden'));
  app.dispose();
});

test('读取器注册不依赖 DOM（纯逻辑可在 Node 里验证）', () => {
  // allReaders() 是 core 的注册表快照；条数应与 coveredFormats() 覆盖的格式数
  // 保持合理关系（每个读取器至少声明一种格式）
  for (const reader of allReaders()) {
    assert.ok(reader.formats.length > 0, `${reader.id} 必须声明至少一种格式`);
  }
});
