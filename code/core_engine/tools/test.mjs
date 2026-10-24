/**
 * test.mjs —— 零依赖测试运行器。
 *
 * 为什么不用 `node --test`：内置 runner 会为每个测试文件 spawn 一个子进程并通过
 * 管道收集输出。在受限环境下 spawn+pipe 会被拒绝；而且多进程本身会让内存基准失真
 * （每个进程有自己的 V8 堆）。这里改为同进程顺序 import 每个测试文件，
 * node:test 自动接管、汇总并设置退出码。
 *
 * 约定：测试之间不得写全局可变状态 —— 这正好也是本项目要验证的性质
 * （打开的文档不应互相泄漏内存）。
 *
 * ── 关于「加载失败」的处理（重要） ──
 *
 * 早期版本直接 `await import(f)`，任何一个测试文件在**导入期**抛错（最常见的是
 * 它静态导入的 format-* 包本身坏了）都会让整个循环中断，于是：
 *   - 后面的测试文件一个都不跑
 *   - 已注册的测试照常汇总，输出看起来像「全套跑完了，只有几个失败」
 * 实测吃过这个亏：一次全量运行只加载了 3 个文件、汇总出 59 个测试，
 * 而真实规模是 300+。**一份看起来正常但不完整的报告比崩溃更危险。**
 *
 * 因此现在：逐个文件 try/catch，失败的记为「加载失败」并继续；
 * 最后单独汇总加载失败清单，并以非零退出码结束。
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');
const filter = process.argv[2];

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

const files = walk(TEST_DIR).filter((f) => !filter || f.includes(filter));
if (files.length === 0) {
  console.error(`[test] 未找到测试文件${filter ? `（过滤: ${filter}）` : ''}`);
  process.exit(1);
}

const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');
console.log(`[test] 同进程加载 ${files.length} 个测试文件`);
for (const f of files) console.log(`       ${rel(f)}`);
console.log('');

const loadFailures = [];
/**
 * 文件之间主动 GC 一次（仅在 --expose-gc 下可用）。
 *
 * 为什么需要：本项目只能用**单进程**跑测试（spawn+pipe 在受限环境会被拒绝），
 * 于是前一个测试文件留下的垃圾会污染后一个文件里的**内存敏感断言**。
 * 实测：`format-pdf.test.ts` 里有一条「堆增量应远小于按字符串全文处理的开销」，
 * 单独跑通过，但在 15 个文件之后跑就失败 —— 那不是实现问题，是测量环境问题。
 *
 * 注意这只是缓解。**内存/性能断言应当放在 `bench/` 里**（它是「先写盘、再读盘」的
 * 独立进程，能隔离测量），测试套件里只保留功能断言。
 */
const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;

for (const f of files) {
  if (gc) gc();
  try {
    await import(pathToFileURL(f).href);
  } catch (err) {
    // 导入期失败：通常是该文件静态导入的包坏了（语法错误、导入路径不存在、
    // 浏览器侧静态导入 node: 模块等）。记下来继续跑其余文件。
    loadFailures.push({ file: rel(f), message: err?.message ?? String(err), code: err?.code ?? '' });
  }
}

if (loadFailures.length) {
  console.error('');
  console.error('════════ 测试文件加载失败 ════════');
  for (const f of loadFailures) {
    console.error(`  ✖ ${f.file}`);
    console.error(`      ${f.code ? `[${f.code}] ` : ''}${String(f.message).split('\n')[0]}`);
  }
  console.error('');
  console.error('  这些文件里的测试**一个都没有执行**，上面的通过数不包含它们。');
  console.error('  先跑 node tools/lint.mjs（能定位大部分导入路径问题），再重跑本命令。');
  console.error('');
  // 让退出码非零，避免「加载失败」被当成「通过」
  process.exitCode = 1;
}

// node:test 的隐式根测试会保持事件循环存活直到全部用例结束，并在失败时设置退出码。
