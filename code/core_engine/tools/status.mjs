/**
 * status.mjs —— 从运行时的读取器注册表生成格式支持矩阵。
 *
 * 为什么不让文档手写这张表：手写的表一定会和代码脱节。
 * 新增一个格式包、或某个包的读取器注册失败，手写文档不会知道；
 * 而这张表是**加载真实代码后问注册表要来的**，因此不可能撒谎。
 *
 * 用法：
 *   node tools/status.mjs              # 打印到终端
 *   node tools/status.mjs --write      # 同时写入 docs/FORMAT-MATRIX.md
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReaders, READER_PACKAGES } from './load-readers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

const { FORMATS, formatSpec } = await import('../packages/core/src/formats.ts');
const { coveredFormats, allReaders, readerForFormat } = await import('../packages/core/src/registry.ts');

// 加载逻辑统一在 tools/load-readers.mjs —— 早期这里与 bench/validate 各写了一遍，
// 于是同一个「绝对路径 import 失败」的 bug 存在三份，导致本工具生成过一份假矩阵。
const { loaded, failed } = await loadReaders();
const PACKAGES = READER_PACKAGES;

const covered = new Set(coveredFormats());

const FAMILY_LABEL = {
  ooxml: 'OOXML（Microsoft Office 2007+）',
  odf: 'ODF（OpenDocument）',
  pdf: '固定版式',
  text: '纯文本与表格',
  markup: '标记与矢量',
  legacy: '旧版二进制（仅识别）',
};

const FAMILY_ORDER = ['ooxml', 'odf', 'pdf', 'text', 'markup', 'legacy'];

/** 按 family 分组 */
const groups = new Map();
for (const f of FORMATS) {
  if (f.id === 'unknown') continue;
  if (!groups.has(f.family)) groups.set(f.family, []);
  groups.get(f.family).push(f);
}

const L = [];
L.push('# 格式支持矩阵');
L.push('');
L.push('> **本文件由 `node tools/status.mjs --write` 自动生成，请勿手动编辑。**');
L.push('> 数据来源是运行时加载真实读取器包后查询注册表的结果，因此不会与代码脱节。');
L.push('');
L.push('## 汇总');
L.push('');
L.push(`- 格式表登记：**${FORMATS.length - 1}** 种（不含 unknown）`);
L.push(`- 已安装读取器包：**${loaded.length} / ${PACKAGES.length}**${loaded.length ? `（${loaded.join(', ')}）` : ''}`);
L.push(`- 可实际打开的格式：**${covered.size}** 种`);
const unimplemented = FORMATS.filter((f) => f.id !== 'unknown' && !covered.has(f.id) && f.family !== 'legacy');
L.push(`- 已登记但尚无读取器：**${unimplemented.length}** 种`);
L.push('');

if (failed.length) {
  L.push('### 读取器包状态');
  L.push('');
  L.push('| 包 | 状态 |');
  L.push('|---|---|');
  for (const p of PACKAGES) {
    const bad = failed.find((f) => f.pkg === p);
    L.push(`| \`${p}\` | ${bad ? `⚠ ${bad.reason}` : '✅ 已加载'} |`);
  }
  L.push('');
}
L.push('## 逐格式明细');
L.push('');

for (const family of FAMILY_ORDER) {
  const list = groups.get(family);
  if (!list || list.length === 0) continue;
  L.push(`### ${FAMILY_LABEL[family] ?? family}`);
  L.push('');
  L.push('| 格式 | 名称 | 类别 | 容器 | 扩展名 | 读取器 |');
  L.push('|---|---|---|---|---|---|');
  for (const f of list.sort((a, b) => a.id.localeCompare(b.id))) {
    const reader = readerForFormat(f.id);
    let status;
    if (f.family === 'legacy') status = '识别并提示（不支持解析）';
    else if (reader) status = `✅ \`${reader.id}\``;
    else status = '— 未安装';
    L.push(`| \`${f.id}\` | ${f.label} | ${f.kind} | ${f.container} | ${f.extensions.map((e) => `.${e}`).join(' ')} | ${status} |`);
  }
  L.push('');
}

L.push('## 这些格式分别由哪个包负责');
L.push('');
L.push('| 包 | 负责的格式 |');
L.push('|---|---|');
for (const r of allReaders()) {
  L.push(`| \`${r.id}\` | ${r.formats.map((f) => `\`${f}\``).join(' ')} |`);
}
if (allReaders().length === 0) L.push('| （无） | 尚未加载任何读取器 |');
L.push('');
L.push('## 为什么「已登记」多于「已实现」');
L.push('');
L.push('`packages/core/src/formats.ts` 里的格式表是**能力声明**，包含嗅探规则、MIME、');
L.push('扩展名归属与 UI 展示名。它比读取器更早存在，这样：');
L.push('');
L.push('1. 嗅探器能正确**识别**一种格式（哪怕读取器还没写），从而给出准确的提示');
L.push('   （「这是 OpenDocument 表格，读取器未安装」而不是「不认识这个文件」）');
L.push('2. UI 的「格式支持」面板能如实展示「已支持 / 未安装」，而不是把未实现当成不存在');
L.push('3. 新增读取器时只需实现 `FormatReader` 并 `registerReader()`，');
L.push('   嗅探、文件对话框、格式徽标、统计**全部自动生效**');
L.push('');

const md = L.join('\n');
console.log(md);

if (write) {
  const dest = join(ROOT, 'docs', 'FORMAT-MATRIX.md');
  writeFileSync(dest, md);
  console.log(`\n[status] 已写入 docs/FORMAT-MATRIX.md`);
}
