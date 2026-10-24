/**
 * LiteOffice 内存与性能基准。
 *
 * 为什么需要它：「比 WPS 省内存」是本项目的核心主张，而**主张必须可测**。
 * 这个脚本给出三类可验证的数字：
 *
 *   1. 单文档代价 —— 源文件字节 vs 模型估算字节 vs 真实堆增量
 *   2. 泄漏检查 —— 同一文档反复打开 N 次后，堆是否回到基线（验证 dispose 真的有效）
 *   3. 虚拟化/惰性代价 —— 大文档的堆增量是否与文档体量同阶
 *
 * 数据集由两部分组成：
 *   - **合成夹具**（bench/fixtures.ts 生成，可复现、规模刻意做大）
 *   - 本机真实文件（存在才纳入）
 * 合成夹具是必需的：真实文件在别人机器上不存在，只靠它们会让基准静默跳过全部
 * 有意义的测量，输出一份「成功运行但没有数据」的报告。
 *
 * 诚实性约定（重要）：
 *   - 我们**不**伪造 WPS 的实测数字。本脚本只测 LiteOffice 自身的绝对数字与比值，
 *     WPS 的对比在文档里以「设计差异」的方式陈述，不给假的对照数据。
 *   - V8 的堆数字受 GC 时机影响，因此每项测量前都尝试 forceGc，
 *     并在输出里标注 GC 是否可用（未加 --expose-gc 时数字偏噪声）。
 *   - 峰值堆用 5ms 轮询采样，因此是**下界**而非精确峰值，输出里会注明。
 *
 * 用法：
 *   node --expose-gc bench/bench.mjs                 # 建议加 --expose-gc
 *   node bench/bench.mjs --no-synthetic              # 只测本机真实文件
 *   node bench/bench.mjs --xlsx-rows 200000 --xlsx-cols 30
 *   node bench/bench.mjs --json
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'bench', 'out');

const args = new Set(process.argv.slice(2));
const jsonOnly = args.has('--json');
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/* ------------------------------------------------------------------ */
/* 载入引擎与读取器                                                     */
/* ------------------------------------------------------------------ */

const { openDocument } = await import('../packages/engine/src/open.ts');
const { forceGc, memSnapshot, formatBytes, now } = await import('../packages/core/src/memory.ts');
const { coveredFormats, allReaders } = await import('../packages/core/src/registry.ts');
const { loadReaders } = await import('../tools/load-readers.mjs');

// 统一走 tools/load-readers.mjs。早期这里用绝对路径直接 import，静默加载 0 个读取器，
// 于是基准脚本「成功运行」却什么都没测 —— 比崩溃更危险。
const { loaded, failed: loadFailed } = await loadReaders();
const missing = loadFailed.map((f) => `${f.pkg}(${f.reason})`);
const hardErrors = loadFailed.filter((f) => f.kind === 'error');

/*
 * 有读取器加载失败时**不中止**，而是显著告警后继续。
 *
 * 取舍说明：
 *   - validate.mjs 会中止 —— 它报告的是「成功率」，一个坏掉的读取器会把成功率
 *     不公平地压低，那份报告是错的。
 *   - bench.mjs 继续 —— 它报告的是「每个文件各自的内存与耗时」。某个格式的读取器
 *     坏掉并不影响其它格式的测量有效性；中止只会让人一无所获。
 * 两者都必须在输出里把失败**说清楚**，否则读者会以为「没测到」等于「没问题」。
 */
if (hardErrors.length) {
  console.error('');
  console.error('  ╔══════════════════════════════════════════════════════════════════╗');
  console.error('  ║ ⚠ 有读取器加载失败，这些格式本轮不会有任何基准数据：              ║');
  for (const f of hardErrors) {
    console.error(`  ║   ${f.pkg}: ${String(f.reason).slice(0, 56).padEnd(56)} ║`);
  }
  console.error('  ║   请先修复（node tools/lint.mjs 可定位大部分此类问题）再重跑。      ║');
  console.error('  ╚══════════════════════════════════════════════════════════════════╝');
  console.error('');
}

/* ------------------------------------------------------------------ */
/* 合成夹具                                                            */
/* ------------------------------------------------------------------ */

let syntheticFixtures = [];
if (!args.has('--no-synthetic')) {
  const opts = {
    xlsxRows: Number.parseInt(flag('--xlsx-rows', '50000'), 10),
    xlsxCols: Number.parseInt(flag('--xlsx-cols', '20'), 10),
    docxParas: Number.parseInt(flag('--docx-paras', '20000'), 10),
  };
  if (!jsonOnly) {
    console.log(`[bench] 生成/复用合成夹具（xlsx ${opts.xlsxRows}×${opts.xlsxCols}，docx ${opts.docxParas} 段）…`);
  }
  const { makeSyntheticFixtures } = await import('./fixtures.ts');
  syntheticFixtures = await makeSyntheticFixtures(join(OUT_DIR, 'fixtures'), opts);
}

/* ------------------------------------------------------------------ */
/* 数据集                                                              */
/* ------------------------------------------------------------------ */

/** 工作区里的真实 Word 文件（Word 生成，非自研产物） */
const WORKSPACE_DOCX = [
  '二极管伏安特性实验报告.docx',
  '实验报告-1N4001伏安特性.docx',
  '实验报告-1N60P伏安特性.docx',
  '实验报告-红色LED伏安特性.docx',
  'testA_nogrid.docx',
  'testF_del25.docx',
];

/**
 * 本机存在的真实第三方文档。这些文件属于用户本机数据，**不纳入版本库**，
 * 因此这里按绝对路径探测，缺失即跳过 —— 基准结果会标注实际参与的文件。
 */
const EXTERNAL = [
  ['xlsx', 'C:\\Users\\16595\\Desktop\\我的文件\\学生会\\2025年秋季学期第十三周主题班会汇总表 (1).xlsx'],
  ['xlsx', 'C:\\Users\\16595\\Downloads\\第十期入党积极分子培训考试成绩（最终成绩）.xlsx'],
  ['pptx', 'C:\\Users\\16595\\Documents\\九年级上课件\\22章ppt新\\22.1一元二次方程(1).pptx'],
  ['pptx', 'C:\\Users\\16595\\OneDrive\\我的职业体验.pptx'],
  ['pptx', 'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\我的模板\\示例-成果汇报.pptx'],
  ['pptx', 'C:\\Users\\16595\\OneDrive\\我的暑假游玩经历.pptx'],
  ['pdf', 'C:\\Users\\16595\\Documents\\非安居区籍考生报考申请.pdf'],
  ['pdf', 'C:\\Users\\16595\\Downloads\\AHL-GEC-IDE使用教程.pdf'],
  ['pdf', 'C:\\Users\\16595\\Downloads\\Linux+操作系统第一次上机 (1).pdf'],
  ['pdf', 'C:\\Users\\16595\\Downloads\\6aa26b24-4a34-4952-b45e-08e3384e73c4.pdf'],
  ['rtf', 'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\遂宁高新区城乡统筹建设发展中心关于对保升镇保升村四社杨婷房屋拆迁安置还房面积的情况说明2.rtf'],
];

function collectTargets(synthetic) {
  const out = [];
  const seen = new Set();
  const add = (path, origin, label) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, origin, label });
  };

  // 合成夹具优先：它们可复现、规模刻意做大，是低内存主张的主要证据来源
  for (const f of synthetic) add(f.path, 'synthetic', f.label);

  const ws = 'C:\\deepseekharness';
  if (existsSync(ws)) {
    for (const f of WORKSPACE_DOCX) {
      const p = join(ws, f);
      if (existsSync(p)) add(p, 'workspace', '');
    }
    for (const f of readdirSync(ws)) {
      if (!/\.docx$/i.test(f) || f.startsWith('~$')) continue;
      add(join(ws, f), 'workspace', '');
    }
  }
  for (const [, p] of EXTERNAL) {
    if (existsSync(p)) add(p, 'external', '');
  }
  return out;
}

const targets = collectTargets(syntheticFixtures);

/* ------------------------------------------------------------------ */
/* 测量                                                                */
/* ------------------------------------------------------------------ */

/**
 * 解析一个文件并测量。
 * 注意：打开前先 forceGc 并取基线，解析后取堆增量；峰值用轮询采样（下界）。
 */
async function measureOne(target) {
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(target.path));
  } catch (err) {
    /*
     * 读不出内容：多为云盘「仅在线」占位文件（OneDrive / WPS Drive）。
     * 这类失败**不是被测代码的问题**，必须与「读取器解析失败」区分开 ——
     * 混在一起会让成功率与失败原因都失去意义。
     * 早期版本把它当异常抛出，报告里出现一条误导性的失败记录（实测踩到过）。
     */
    return {
      file: basename(target.path),
      label: target.label || '',
      path: target.path,
      origin: target.origin,
      sourceBytes: 0,
      ok: false,
      skipped: true,
      skipReason: '读不出文件内容（多为云盘「仅在线」占位文件，需先下载到本地）',
      error: `read: ${err?.code ?? err?.message ?? err}`,
      ms: 0,
    };
  }
  forceGc();
  const base = memSnapshot().heapUsedBytes;

  let peak = base;
  let timer = null;
  if (typeof setInterval === 'function') {
    timer = setInterval(() => {
      const cur = memSnapshot().heapUsedBytes;
      if (cur > peak) peak = cur;
    }, 5);
    timer.unref?.();
  }

  const t0 = now();
  let result;
  let error = null;
  try {
    result = await openDocument({ name: basename(target.path), bytes });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ms = now() - t0;
  if (timer) clearInterval(timer);

  const after = memSnapshot().heapUsedBytes;
  if (after > peak) peak = after;

  if (error) {
    return {
      file: basename(target.path),
      label: target.label || '',
      path: target.path,
      origin: target.origin,
      sourceBytes: bytes.length,
      ok: false,
      error,
      ms,
    };
  }

  const doc = result.document;
  const stats = doc.stats;
  const row = {
    file: basename(target.path),
    label: target.label || '',
    path: target.path,
    origin: target.origin,
    sourceBytes: bytes.length,
    format: result.sniff.format,
    formatLabel: result.sniff.spec.label,
    kind: doc.kind,
    ok: true,
    ms,
    sniffReason: result.sniff.reason,
    modelBytes: stats.modelBytes,
    heapDeltaBytes: after - base,
    peakDeltaBytes: peak - base,
    blockCount: stats.blockCount,
    cellCount: stats.cellCount,
    shapeCount: stats.shapeCount,
    imageCount: stats.imageCount,
    imageBytes: stats.imageBytes,
    warnings: stats.warnings,
    truncated: stats.truncated,
    /** 关键比值：模型占源文件的百分比 */
    ratio: bytes.length > 0 ? stats.modelBytes / bytes.length : 0,
    /** 堆增量占源文件的百分比 */
    heapRatio: bytes.length > 0 ? (after - base) / bytes.length : 0,
    phases: stats.phases,
    outlineItems: countOutline(doc.outline),
  };
  doc.dispose();
  return row;
}

function countOutline(items) {
  let n = 0;
  const walk = (arr) => {
    for (const it of arr) {
      n++;
      if (it.children) walk(it.children);
    }
  };
  walk(items ?? []);
  return n;
}

/**
 * 泄漏检查：同一文档反复打开 N 次，看堆是否回到基线附近。
 * 这验证的是「关闭文档后内存真的被释放」——办公软件长期使用后内存持续上涨
 * 正是这个环节没做好。
 */
async function leakCheck(target, iterations = 15) {
  const bytes = new Uint8Array(readFileSync(target.path));
  forceGc();
  const base = memSnapshot().heapUsedBytes;
  const samples = [];

  for (let i = 1; i <= iterations; i++) {
    const { document } = await openDocument({ name: basename(target.path), bytes });
    document.dispose();
    forceGc();
    samples.push(memSnapshot().heapUsedBytes - base);
  }

  // 线性回归斜率（字节/次）：接近 0 说明无累积泄漏
  const n = samples.length;
  const meanX = (n - 1) / 2;
  const meanY = samples.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (samples[i] - meanY);
    den += (i - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;

  return {
    file: basename(target.path),
    iterations,
    samples,
    baseBytes: base,
    finalDeltaBytes: samples[samples.length - 1],
    maxDeltaBytes: Math.max(...samples),
    slopeBytesPerOpen: slope,
    leaked: slope > 64 * 1024,
  };
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

const ORIGIN_LABEL = { synthetic: '合成', workspace: '工作区', external: '本机真实' };

function renderMarkdown(report) {
  const L = [];
  L.push('# LiteOffice 基准测试结果');
  L.push('');
  L.push(`生成时间：${report.generatedAt}`);
  L.push('');
  L.push(`- Node：${report.node}`);
  L.push(`- 平台：${report.platform}`);
  L.push(`- GC 可控：${report.gcAvailable ? '是（--expose-gc）' : '否（堆数字偏噪声，建议加 --expose-gc 重跑）'}`);
  L.push(`- 已加载读取器：${report.readersLoaded.join(', ') || '（无）'}`);
  if (report.readersMissing.length) L.push(`- ⚠ 缺失/异常读取器：${report.readersMissing.join(', ')}`);
  L.push(`- 覆盖格式数：${report.coveredFormats}`);
  L.push('');
  L.push('> 测量方法：每次解析前 forceGc 取基线；堆增量 = 解析后堆 − 基线；');
  L.push('> 峰值用 5ms 轮询采样，因此是**下界**。模型大小为 UDM 结构深估算，不含原始文件字节。');
  L.push('> 合成夹具由 `bench/fixtures.ts` 按 ECMA-376 / ODF 规范独立生成，可复现。');
  L.push('');

  L.push('## 单文档代价');
  L.push('');
  L.push('| 文件 | 说明 | 来源 | 格式 | 源文件 | 模型估算 | 模型/源 | 堆增量 | 堆/源 | 耗时 | 结构量 |');
  L.push('|---|---|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of report.results) {
    if (r.skipped) {
      L.push(`| ${r.file} | ${r.label || ''} | ${ORIGIN_LABEL[r.origin] ?? r.origin} | — | — | — | — | — | — | — | 跳过：${r.skipReason} |`);
      continue;
    }
    if (!r.ok) {
      L.push(`| ${r.file} | ${r.label || ''} | ${ORIGIN_LABEL[r.origin] ?? r.origin} | — | ${formatBytes(r.sourceBytes)} | — | — | — | — | — | **失败**：${r.error} |`);
      continue;
    }
    const struct = [
      r.blockCount ? `${r.blockCount} 块` : '',
      r.cellCount ? `${r.cellCount} 格` : '',
      r.shapeCount ? `${r.shapeCount} 形状` : '',
      r.imageCount ? `${r.imageCount} 图` : '',
      r.outlineItems ? `${r.outlineItems} 大纲项` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    L.push(
      `| ${r.file} | ${r.label || ''} | ${ORIGIN_LABEL[r.origin] ?? r.origin} | ${r.format} | ${formatBytes(r.sourceBytes)} | ${formatBytes(r.modelBytes)} | ${pct(r.ratio)} | ` +
        `${formatBytes(r.heapDeltaBytes)} | ${pct(r.heapRatio)} | ${r.ms.toFixed(0)} ms | ${struct || '—'} |`,
    );
  }
  L.push('');

  const ok = report.results.filter((r) => r.ok);
  if (ok.length) {
    const totalSrc = ok.reduce((a, r) => a + r.sourceBytes, 0);
    const totalModel = ok.reduce((a, r) => a + r.modelBytes, 0);
    const totalHeap = ok.reduce((a, r) => a + Math.max(0, r.heapDeltaBytes), 0);
    L.push('### 合计');
    L.push('');
    L.push(`- 成功解析：${ok.length} / ${report.results.length} 个文件`);
    L.push(`- 源文件合计：${formatBytes(totalSrc)}`);
    L.push(`- 模型合计：${formatBytes(totalModel)}（${pct(totalModel / totalSrc)}）`);
    L.push(`- 堆增量合计：${formatBytes(totalHeap)}（${pct(totalHeap / totalSrc)}）`);
    L.push(`- 平均解析耗时：${(ok.reduce((a, r) => a + r.ms, 0) / ok.length).toFixed(0)} ms`);
    L.push('');
  }

  if (report.leaks.length) {
    L.push('## 泄漏检查（同一文档反复打开并 dispose）');
    L.push('');
    L.push('| 文件 | 次数 | 首次残留 | 末次残留 | 最大残留 | 斜率 | 判定 |');
    L.push('|---|---:|---:|---:|---:|---:|---|');
    for (const l of report.leaks) {
      L.push(
        `| ${l.file} | ${l.iterations} | ${formatBytes(l.samples[0])} | ${formatBytes(l.finalDeltaBytes)} | ` +
          `${formatBytes(l.maxDeltaBytes)} | ${l.slopeBytesPerOpen.toFixed(0)} B/次 | ${l.leaked ? '⚠ 可疑泄漏' : '✅ 未检出'} |`,
      );
    }
    L.push('');
    L.push('判据：线性回归斜率 > 64 KiB/次 视为可疑（单次残留可能来自 V8 未回收的页，需多次复现才可信）。');
    L.push('');
    L.push('> **残留为负值是有意义的信息**，不是测量失败：它表示该次测量期间 GC 回收的内存多于分配的内存，');
    L.push('> 是「关闭文档后内存确实回落」的进一步佐证。只有 NaN/Infinity 才会显示 n/a。');
    L.push('');
  }

  L.push('## 未参与的文件');
  L.push('');
  if (report.skipped.length) {
    for (const s of report.skipped) L.push(`- ${s}`);
  } else {
    L.push('（无）');
  }
  L.push('');

  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

if (!jsonOnly) {
  console.log(`[bench] 读取器：已加载 ${loaded.length} 个${missing.length ? `，缺失/异常 ${missing.length} 个` : ''}`);
  console.log(`[bench] 覆盖格式 ${coveredFormats().length} 种，注册读取器 ${allReaders().length} 个`);
  console.log(`[bench] 合成夹具 ${syntheticFixtures.length} 个（可复现，规模刻意做大）`);
  console.log(`[bench] 待测文件合计 ${targets.length} 个${targets.length ? '' : '（未找到可测文件）'}`);
  console.log('');
}

const results = [];
for (const t of targets) {
  try {
    const row = await measureOne(t);
    results.push(row);
    if (!jsonOnly) {
      if (row.ok) {
        console.log(
          `  ${row.file.slice(0, 34).padEnd(36)} ${row.format.padEnd(5)} ` +
            `源 ${formatBytes(row.sourceBytes).padStart(9)}  模型 ${formatBytes(row.modelBytes).padStart(9)} (${pct(row.ratio).padStart(6)})  ` +
            `堆 ${formatBytes(row.heapDeltaBytes).padStart(9)} (${pct(row.heapRatio).padStart(6)})  ${row.ms.toFixed(0).padStart(6)} ms`,
        );
      } else {
        console.log(`  ${row.file.slice(0, 34).padEnd(36)} 失败: ${row.error}`);
      }
    }
  } catch (err) {
    results.push({ file: basename(t.path), label: t.label || '', path: t.path, origin: t.origin, ok: false, error: String(err), sourceBytes: statSync(t.path).size });
    if (!jsonOnly) console.log(`  ${basename(t.path)} 异常: ${err}`);
  }
}

// 泄漏检查：优先用最大的**合成**夹具（可复现、规模够大、反复打开 15 次不心疼）
const biggestSynthetic = results.filter((r) => r.ok && r.origin === 'synthetic').sort((a, b) => b.sourceBytes - a.sourceBytes)[0];
const biggestAny = results.filter((r) => r.ok).sort((a, b) => b.sourceBytes - a.sourceBytes)[0];
const leakTargetRow = biggestSynthetic ?? biggestAny;
const leaks = [];
if (leakTargetRow) {
  const target = targets.find((t) => t.path === leakTargetRow.path);
  if (target) {
    if (!jsonOnly) console.log(`\n[bench] 泄漏检查：${leakTargetRow.file} × 15 次打开+dispose`);
    const l = await leakCheck(target, 15);
    leaks.push(l);
    if (!jsonOnly) {
      console.log(
        `  残留 首次 ${formatBytes(l.samples[0])} / 末次 ${formatBytes(l.finalDeltaBytes)} / 最大 ${formatBytes(l.maxDeltaBytes)}` +
          `  斜率 ${l.slopeBytesPerOpen.toFixed(0)} B/次  ->  ${l.leaked ? '⚠ 可疑' : '✅ 未检出泄漏'}`,
      );
    }
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  gcAvailable: forceGc(),
  readersLoaded: loaded,
  readersMissing: missing,
  coveredFormats: coveredFormats().length,
  results,
  leaks,
  skipped: [
    ...EXTERNAL.filter(([, p]) => !existsSync(p)).map(([k, p]) => `${k}: ${p}（本机不存在）`),
    ...missing.map((m) => `读取器未安装或加载失败：${m}`),
  ],
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(report, null, 2));
writeFileSync(join(OUT_DIR, 'BENCHMARKS.md'), renderMarkdown(report));

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n[bench] 结果已写入 bench/out/results.json 与 bench/out/BENCHMARKS.md`);
  if (!report.gcAvailable) {
    console.log('[bench] 提示：加 --expose-gc 重跑可获得更干净的数字：node --expose-gc bench/bench.mjs');
  }
}
