/**
 * validate.mjs —— 真实文件回归验证。
 *
 * 为什么需要它：单元测试只能验证「我们以为的规范」。真实世界的文件由 Word、WPS、
 * LibreOffice、各种在线转换器生成，有大量规范外的写法。**只有真实文件才能暴露规范误读。**
 *
 * 它做的事：递归扫描指定目录，把每一个认识的文档都尝试打开一遍，输出
 *   - 打开成功率（按格式分组）
 *   - 失败清单与失败原因（这是最有价值的部分）
 *   - 降级清单（打开了但丢了内容 —— 静默降级比打不开更危险）
 *
 * 用法：
 *   node tools/validate.mjs                       # 默认扫描用户常用目录
 *   node tools/validate.mjs <目录> [更多目录...]    # 指定目录
 *   node tools/validate.mjs --depth 6 --limit 500
 *   node tools/validate.mjs --json                # 只输出 JSON
 */
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'bench', 'out');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const jsonOnly = flags.has('--json');

function flagValue(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const roots = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) && existsSync(a) && statSync(a).isDirectory());
const searchRoots = roots.length
  ? roots
  : [
      'C:\\deepseekharness',
      'C:\\Users\\16595\\Desktop',
      'C:\\Users\\16595\\Documents',
      'C:\\Users\\16595\\Downloads',
      'C:\\Users\\16595\\OneDrive',
    ].filter((d) => existsSync(d));

const maxDepth = Number.parseInt(flagValue('--depth', '5'), 10);
const limit = Number.parseInt(flagValue('--limit', '800'), 10);

/* ------------------------------------------------------------------ */
/* 载入引擎与读取器                                                     */
/* ------------------------------------------------------------------ */

const { openDocument } = await import('../packages/engine/src/open.ts');
const { formatByExtension } = await import('../packages/core/src/formats.ts');
const { coveredFormats, allReaders, explainReadError } = await import('../packages/core/src/registry.ts');
const { formatBytes } = await import('../packages/core/src/memory.ts');
const { loadReaders } = await import('./load-readers.mjs');

// 统一走 tools/load-readers.mjs：绝对路径直接 import 会失败，
// 早期这里因此静默加载 0 个读取器，却输出了「成功率 0%」这种看起来合理的报告。
const { loaded, failed: loadFailed } = await loadReaders();
const missing = loadFailed.map((f) => `${f.pkg}: ${f.reason}`);

// 有加载失败说明读取器代码本身坏了。此时继续生成报告只会输出误导性的成功率，
// 因此明确中止并要求先修代码。
if (loadFailed.some((f) => f.kind === 'error')) {
  console.error('[validate] 读取器加载失败，无法进行有意义的验证：');
  for (const f of loadFailed.filter((x) => x.kind === 'error')) console.error(`  ${f.pkg}: ${f.reason}`);
  console.error('  请先修复上述错误（可跑 node tools/lint.mjs 与 node tools/build.mjs 定位）。');
  process.exit(1);
}

const covered = new Set(coveredFormats());

/**
 * 只收集「已安装读取器」能处理的文件 —— 否则会把大量不支持的格式算成失败，
 * 让成功率失去意义。旧版二进制例外：它们是刻意「识别但不支持」的，
 * 单独统计用来验证那个提示路径确实生效。
 */
function isSupportedFile(name) {
  const spec = formatByExtension(name);
  if (!spec) return false;
  if (spec.family === 'legacy') return true;
  return covered.has(spec.id);
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  'dist',
  '$RECYCLE.BIN',
  'System Volume Information',
  'AppData',
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'WPSDrive', // 云盘目录常含大量重复副本，默认只在显式指定时才扫
]);

function walk(dir, depth, out) {
  if (depth > maxDepth || out.length >= limit) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 权限不足等，静默跳过
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('~$')) continue;
      walk(p, depth + 1, out);
    } else if (e.isFile()) {
      if (e.name.startsWith('~$')) continue; // Office 临时锁文件
      if (isSupportedFile(e.name)) out.push(p);
    }
  }
}

const files = [];
for (const r of searchRoots) walk(r, 0, files);

if (!jsonOnly) {
  console.log(`[validate] 读取器：已加载 ${loaded.length} 个${missing.length ? `，缺失 ${missing.length} 个（${missing.join(', ')}）` : ''}`);
  console.log(`[validate] 覆盖格式 ${covered.size} 种`);
  console.log(`[validate] 扫描目录：${searchRoots.join('  ')}`);
  console.log(`[validate] 找到候选文件 ${files.length} 个（depth≤${maxDepth}, limit=${limit}）`);
  console.log('');
}

/* ------------------------------------------------------------------ */
/* 逐个验证                                                            */
/* ------------------------------------------------------------------ */

const results = [];
let n = 0;
for (const path of files) {
  n++;
  let sourceBytes = 0;
  try {
    sourceBytes = statSync(path).size;
  } catch {
    continue;
  }
  // 超大文件跳过（不是失败），避免验证脚本自己把内存吃满
  if (sourceBytes > 128 * 1024 * 1024) {
    results.push({ path, file: basename(path), ok: false, skipped: true, reason: `超过 128 MiB（${formatBytes(sourceBytes)}），验证脚本主动跳过`, sourceBytes });
    continue;
  }

  const t0 = Date.now();
  try {
    const bytes = new Uint8Array(readFileSync(path));
    const { document, sniff } = await openDocument({ name: basename(path), bytes });
    const stats = document.stats;
    results.push({
      path,
      file: basename(path),
      ok: true,
      sourceBytes,
      format: sniff.format,
      formatLabel: sniff.spec.label,
      sniffReason: sniff.reason,
      kind: document.kind,
      ms: Date.now() - t0,
      modelBytes: stats.modelBytes,
      blocks: stats.blockCount,
      cells: stats.cellCount,
      shapes: stats.shapeCount,
      images: stats.imageCount,
      warnings: stats.warnings,
      truncated: stats.truncated,
      outline: document.outline.length,
    });
    document.dispose();
    if (!jsonOnly) process.stdout.write(`\r  验证中 ${n}/${files.length}  最后: ${basename(path).slice(0, 40).padEnd(42)}`);
  } catch (err) {
    const code = err?.code ?? 'UNKNOWN';
    /*
     * 区分「真失败」与「按设计的拒绝」—— 这直接决定成功率是否有意义。
     *
     * 实测踩过：119 个真实文件里有 14 个被算成失败，但逐个看全是**设计行为**：
     *   13 个旧版二进制 .doc/.xls/.ppt —— 本项目的定位就是「识别并给提示」，
     *        告诉用户「请先另存为 docx」，这恰恰是功能而不是缺陷
     *    1 个加密 PDF —— 明确报 ENCRYPTED 也是设计行为
     * 把它们混进成功率会让报告显示 88.2%，而真实情况是**能支持的文件 100% 打开**。
     * 这种被自己的工具抹黑的数字，比没有数字更糟。
     */
    const byDesign = code === 'LEGACY_BINARY' || code === 'ENCRYPTED';
    results.push({
      path,
      file: basename(path),
      ok: false,
      byDesign,
      sourceBytes,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      errorCode: code,
      human: explainReadError(err),
    });
    if (!jsonOnly) process.stdout.write(`\r  验证中 ${n}/${files.length}  最后: ${basename(path).slice(0, 40).padEnd(42)}`);
  }
}
if (!jsonOnly && files.length) process.stdout.write('\n');

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

const real = results.filter((r) => !r.skipped);
const ok = real.filter((r) => r.ok);
/**
 * 「按设计的拒绝」：旧版二进制（识别并提示）与加密文件（明确报 ENCRYPTED）。
 * 它们不是缺陷，因此**不计入成功率分母** —— 否则报告会被自己的正确行为抹黑。
 */
const byDesign = real.filter((r) => !r.ok && r.byDesign);
const failed = real.filter((r) => !r.ok && !r.byDesign);
/** 声称支持的集合大小（用于成功率分母） */
const supported = real.length - byDesign.length;
const legacy = byDesign.filter((r) => r.errorCode === 'LEGACY_BINARY');
const encrypted = byDesign.filter((r) => r.errorCode === 'ENCRYPTED');
const degraded = ok.filter((r) => (r.warnings?.length ?? 0) > 0 || (r.truncated?.length ?? 0) > 0);

/** 按格式分组统计（同样把「按设计的拒绝」单列，不要混进失败） */
const byFormat = new Map();
for (const r of real) {
  const key = r.ok ? r.format : (formatByExtension(r.file)?.id ?? 'unknown');
  const g = byFormat.get(key) ?? { format: key, total: 0, ok: 0, failed: 0, byDesign: 0, ms: 0, sourceBytes: 0 };
  g.total++;
  if (r.ok) {
    g.ok++;
    g.ms += r.ms;
    g.sourceBytes += r.sourceBytes;
  } else if (r.byDesign) {
    g.byDesign++;
  } else {
    g.failed++;
  }
  byFormat.set(key, g);
}

const summary = {
  scannedRoots: searchRoots,
  candidates: files.length,
  attempted: real.length,
  opened: ok.length,
  failed: failed.length,
  byDesign: byDesign.length,
  encrypted: encrypted.length,
  skipped: results.length - real.length,
  supported,
  openRate: supported ? ok.length / supported : 0,
  legacyIdentified: legacy.length,
  degraded: degraded.length,
  totalSourceBytes: ok.reduce((a, r) => a + r.sourceBytes, 0),
  totalModelBytes: ok.reduce((a, r) => a + r.modelBytes, 0),
  avgMs: ok.length ? ok.reduce((a, r) => a + r.ms, 0) / ok.length : 0,
  readersLoaded: loaded,
  readersMissing: missing,
  coveredFormats: covered.size,
};

/** 失败原因聚类 —— 用来判断下一步该修什么 */
const failureGroups = new Map();
for (const f of failed) {
  const key = `${f.errorCode}: ${(f.error ?? '').slice(0, 90)}`;
  const g = failureGroups.get(key) ?? { reason: key, count: 0, samples: [] };
  g.count++;
  if (g.samples.length < 3) g.samples.push(f.file);
  failureGroups.set(key, g);
}

if (!jsonOnly) {
  console.log('');
  console.log('════════ 验证结果 ════════');
  console.log(`  尝试 ${summary.attempted} 个（跳过 ${summary.skipped} 个）`);
  console.log(`  打开成功 ${summary.opened}   真失败 ${summary.failed}   成功率 ${(summary.openRate * 100).toFixed(1)}%`);
  console.log(
    `  按设计的拒绝 ${summary.byDesign} 个（旧版二进制 ${summary.legacyIdentified} + 加密 ${summary.encrypted}）` +
      `，不计入成功率分母；声称支持 ${summary.supported} 个`,
  );
  console.log(`  有降级告警 ${summary.degraded} 个（打开了但丢了内容，见下方清单）`);
  console.log(`  源文件合计 ${formatBytes(summary.totalSourceBytes)}  ->  模型合计 ${formatBytes(summary.totalModelBytes)}`);
  console.log(`  平均解析耗时 ${summary.avgMs.toFixed(0)} ms`);
  console.log('');
  console.log('  按格式：');
  for (const g of [...byFormat.values()].sort((a, b) => b.total - a.total)) {
    const denom = g.total - g.byDesign;
    const rate = denom ? ((g.ok / denom) * 100).toFixed(0) : 'n/a';
    const design = g.byDesign ? `  设计拒绝 ${String(g.byDesign).padStart(3)}` : '';
    console.log(
      `    ${g.format.padEnd(10)} 共 ${String(g.total).padStart(4)}  成功 ${String(g.ok).padStart(4)}  失败 ${String(g.failed).padStart(4)}${design}  (${rate}%)`,
    );
  }
  if (failureGroups.size) {
    console.log('');
    console.log('  失败原因聚类（修 bug 的优先级依据）：');
    for (const g of [...failureGroups.values()].sort((a, b) => b.count - a.count)) {
      console.log(`    [${g.count}×] ${g.reason}`);
      console.log(`          例: ${g.samples.join(', ')}`);
    }
  }
  if (degraded.length) {
    console.log('');
    console.log('  有降级告警的文件（打开了但丢了内容，值得逐条检查）：');
    for (const d of degraded.slice(0, 15)) {
      const w = [...(d.warnings ?? []), ...(d.truncated ?? [])].slice(0, 3).join(' | ');
      console.log(`    ${d.file.slice(0, 44).padEnd(46)} ${d.format.padEnd(5)} ${w.slice(0, 100)}`);
    }
    if (degraded.length > 15) console.log(`    …还有 ${degraded.length - 15} 个`);
  }
}

/* ------------------------------------------------------------------ */
/* 落盘                                                                */
/* ------------------------------------------------------------------ */

const report = {
  generatedAt: new Date().toISOString(),
  summary,
  byFormat: [...byFormat.values()],
  failureGroups: [...failureGroups.values()],
  results,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'validation.json'), JSON.stringify(report, null, 2));

const L = [];
L.push('# 真实文件回归验证报告');
L.push('');
L.push(`生成时间：${report.generatedAt}`);
L.push('');
L.push(`- 读取器：已加载 ${loaded.length} 个${missing.length ? `，缺失 ${missing.length} 个` : ''}，覆盖格式 ${covered.size} 种`);
L.push(`- 扫描目录：${searchRoots.map((r) => `\`${r}\``).join('、')}`);
L.push(`- 候选文件：${summary.candidates} 个（深度 ≤ ${maxDepth}）`);
L.push('');
L.push('## 总体');
L.push('');
L.push('> **成功率的分母是「我们声称支持的格式」**，即已排除「按设计的拒绝」：');
L.push('> 旧版二进制 `.doc/.xls/.ppt`（本项目的定位是识别并提示「请另存为 docx」）');
L.push('> 与加密文件（明确报 `ENCRYPTED`）。把它们算作失败会让报告被自己的正确行为抹黑。');
L.push('');
L.push('| 指标 | 值 |');
L.push('|---|---:|');
L.push(`| 尝试打开 | ${summary.attempted} |`);
L.push(`| 打开成功 | ${summary.opened} |`);
L.push(`| **真失败** | **${summary.failed}** |`);
L.push(`| 声称支持的文件数（成功率分母） | ${summary.supported} |`);
L.push(`| **成功率** | **${(summary.openRate * 100).toFixed(1)}%** |`);
L.push(`| 按设计的拒绝（旧版二进制） | ${summary.legacyIdentified} |`);
L.push(`| 按设计的拒绝（加密 PDF） | ${summary.encrypted} |`);
L.push(`| 跳过（超大/不可读） | ${summary.skipped} |`);
L.push(`| **有降级告警**（打开了但丢了内容） | ${summary.degraded} |`);
L.push(`| 源文件合计 | ${formatBytes(summary.totalSourceBytes)} |`);
L.push(`| 模型合计 | ${formatBytes(summary.totalModelBytes)} |`);
L.push(`| 平均解析耗时 | ${summary.avgMs.toFixed(0)} ms |`);
L.push('');
L.push('## 按格式');
L.push('');
L.push('| 格式 | 总数 | 成功 | 真失败 | 按设计拒绝 | 成功率 |');
L.push('|---|---:|---:|---:|---:|---:|');
for (const g of [...byFormat.values()].sort((a, b) => b.total - a.total)) {
  const denom = g.total - g.byDesign;
  L.push(
    `| ${g.format} | ${g.total} | ${g.ok} | ${g.failed} | ${g.byDesign} | ${denom ? ((g.ok / denom) * 100).toFixed(0) : 'n/a'}% |`,
  );
}
L.push('');
if (failureGroups.size) {
  L.push('## 失败原因聚类');
  L.push('');
  L.push('这是决定下一步修什么的依据。');
  L.push('');
  L.push('| 次数 | 原因 | 样例 |');
  L.push('|---:|---|---|');
  for (const g of [...failureGroups.values()].sort((a, b) => b.count - a.count)) {
    L.push(`| ${g.count} | ${g.reason.replace(/\|/g, '\\|')} | ${g.samples.join('<br>')} |`);
  }
  L.push('');
}
if (degraded.length) {
  L.push('## 降级清单');
  L.push('');
  L.push('**打开了但丢了内容** —— 这比打不开更危险，因为用户不会察觉。');
  L.push('');
  L.push('| 文件 | 格式 | 告警 |');
  L.push('|---|---|---|');
  for (const d of degraded) {
    L.push(`| ${d.file} | ${d.format} | ${[...(d.warnings ?? []), ...(d.truncated ?? [])].slice(0, 4).join('<br>').replace(/\|/g, '\\|')} |`);
  }
  L.push('');
}
writeFileSync(join(OUT_DIR, 'VALIDATION.md'), L.join('\n'));

if (jsonOnly) console.log(JSON.stringify(report, null, 2));
else console.log(`\n[validate] 报告已写入 bench/out/VALIDATION.md 与 bench/out/validation.json`);
