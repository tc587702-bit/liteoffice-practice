/**
 * load-readers.mjs —— 工具脚本共用的「加载全部格式读取器」实现。
 *
 * 为什么抽成单独模块：这个逻辑一度在 status.mjs / bench.mjs / validate.mjs 里
 * 各写了一遍，于是同一个 bug 也存在了三份 —— 三个工具都用**绝对 Windows 路径**
 * 去 `await import()`，而 Node 的 ESM 加载器要求 file:// URL，
 * 报错是 "Only URLs with a scheme in: file, data, and node are supported"。
 *
 * 后果很隐蔽：三个工具都静默地「加载了 0 个读取器」。
 *   - status.mjs 生成了一份「0/6 已安装、可打开 0 种格式」的**假格式矩阵**
 *   - bench.mjs 打印「已加载 0 个」并跳过全部基准
 *   - validate.mjs 报「覆盖格式 0 种、找到候选文件 0 个」
 * 它们都没有崩，都输出了看起来合理的报告 —— 这是最危险的一类 bug。
 *
 * 因此这里只保留一份实现，并显式区分「未安装」与「加载失败」：
 * 前者是正常的开发中间态，后者是**必须让人看见的错误**。
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 已知的格式读取器包。新增格式包时在这里加一行（或让 tools/status.mjs 自动发现）。 */
export const READER_PACKAGES = [
  'format-text',
  'format-docx',
  'format-xlsx',
  'format-odf',
  'format-pptx',
  'format-pdf',
];

/**
 * 加载全部读取器包（import 即触发顶层 registerReader 自注册）。
 *
 * @returns loaded  成功加载的包名
 * @returns failed  { pkg, reason }，reason 已区分「未安装」与「加载失败」
 */
export async function loadReaders(packages = READER_PACKAGES) {
  const loaded = [];
  const failed = [];

  for (const p of packages) {
    const entry = join(ROOT, 'packages', p, 'src', 'index.ts');
    if (!existsSync(entry)) {
      failed.push({ pkg: p, kind: 'missing', reason: '入口文件不存在（尚未实现）' });
      continue;
    }
    try {
      // 关键：绝对路径必须转成 file:// URL，否则 Node 会把 "c:" 当成协议名而拒绝。
      await import(pathToFileURL(entry).href);
      loaded.push(p);
    } catch (err) {
      failed.push({ pkg: p, kind: 'error', reason: err?.message ?? String(err) });
    }
  }

  return { loaded, failed };
}

/** 汇总读取器覆盖情况，供各工具打印一致的状态行 */
export async function readerStatus() {
  const { loaded, failed } = await loadReaders();
  const { coveredFormats, allReaders } = await import('../packages/core/src/registry.ts');
  const hardErrors = failed.filter((f) => f.kind === 'error');
  return {
    loaded,
    failed,
    hardErrors,
    covered: coveredFormats(),
    readerCount: allReaders().length,
    /** 供工具决定是否应当中止：有加载失败说明代码坏了，不该继续生成报告 */
    healthy: hardErrors.length === 0,
    summaryLine: `[读取器] 已加载 ${loaded.length}/${loaded.length + failed.length} 个` +
      (loaded.length ? `（${loaded.join(', ')}）` : '') +
      (hardErrors.length ? `，⚠ ${hardErrors.length} 个加载失败：${hardErrors.map((f) => f.pkg).join(', ')}` : '') +
      `；覆盖格式 ${coveredFormats().length} 种`,
  };
}
