/**
 * build.mjs — 零依赖浏览器构建。
 *
 * 不引入 typescript / esbuild / rollup / vite。
 * 用 Node 内置 `module.stripTypeScriptTypes()` 做类型擦除，直接产出原生 ESM。
 *
 * 设计要点：跨包导入使用**相对路径**（如 ../../zip/src/index.ts）。
 * 因此构建只需把 .ts 擦成 .js 并保持目录结构，浏览器即可按原生 ESM 解析，
 * 既不需要 node_modules，也不需要 import map。
 */
import { stripTypeScriptTypes } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build');
const quiet = process.argv.includes('--quiet');

/**
 * walk 只走每个包的 src 目录，而不是整个包目录。
 *
 * 为什么这条边界重要：包里除了 src 还可能有 testutil（测试用 DOM 桩、
 * 假数据等）。它们依赖 node: 内置模块、或本身就是测试代码，
 * 一起构建进 build/ 会有两个后果：
 *   1. 把测试代码混进「发布产物」，浏览器树里多出没人 import 的文件
 *   2. 它们的语法错误会**连带让整个构建失败** —— 实测踩过：
 *      testutil 里一句注释含「星号紧跟斜杠」的序列，把块注释提前闭合了，
 *      于是构建整体挂掉。测试辅助代码不该有这个权限。
 *
 * 注意本注释本身也要避开那个序列 —— 这个坑项目里已经踩过四次了，
 * 所以 tools/lint.mjs 里有一条专门的检查。
 */
function walkSrc(pkgDir, acc = []) {
  return walkTs(join(pkgDir, 'src'), acc);
}

function walkTs(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

/** 擦除类型，并把相对导入的 .ts 改成 .js。 */
function compile(src) {
  const stripped = stripTypeScriptTypes(src, { mode: 'strip' });
  return stripped.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*?)(\.ts)?\2/g,
    (_m, pre, q, spec) => `${pre}${q}${spec}.js${q}`,
  );
}

const jobs = [];
for (const e of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
  if (e.isDirectory()) walkSrc(join(ROOT, 'packages', e.name), jobs);
}
jobs.push(...walkTs(join(ROOT, 'apps', 'web', 'src')));

/*
 * 先全部编译到内存，再统一落盘。
 *
 * 早期版本边编译边写，结果某个文件编译失败时 build/ 里会留下「一半新一半旧」的产物，
 * 浏览器加载到混合状态，报出与真实原因无关的错误（例如「找不到导出 X」），
 * 极难定位。原子写让失败时的 build/ 保持上一次的完整状态。
 */
const compiled = [];
let bytes = 0;
for (const file of jobs) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const dest = join(OUT, rel.replace(/\.ts$/, '.js'));
  let code;
  try {
    code = compile(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`\n[build] 编译失败：${rel}`);
    // 打印完整 stack —— 里面带源码上下文与出错列的位置。
    // 只打印 err.message 会丢掉那段上下文，而这类语法错误的错误信息本身
    // （"Expected ';', '}' or <eof>"）毫无指向性，没有上下文等于没报错。
    console.error(
      String(err?.stack ?? err?.message ?? err)
        .split('\n')
        .map((l) => `        ${l}`)
        .join('\n'),
    );
    console.error(`        提示：先跑 node tools/lint.mjs，它能提前抓到不可擦除语法、误闭合注释等问题。`);
    process.exit(1);
  }
  compiled.push({ dest, code });
  bytes += Buffer.byteLength(code);
}

for (const { dest, code } of compiled) {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, code);
}

/*
 * 在 build/ 里放一个 type:module 标记。
 *
 * 两个作用：
 *   1. 浏览器按原生 ESM 加载，语义明确
 *   2. 让 `node --check build/.../*.js` 能把这些产物**当模块**做语法校验
 *      —— 否则 node 会按 CommonJS 解析，遇到 import 就报错，校验形同虚设。
 *      这是在没有浏览器自动化的情况下，唯一能验证「构建产物是合法 ESM」的手段。
 */
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');

if (!quiet) {
  console.log(`[build] ${jobs.length} 个模块 -> build/  (${(bytes / 1024).toFixed(1)} KiB 未压缩 TS 源码)`);
  console.log(`[build] 产物为原生 ESM，浏览器可直接执行，无打包器、无 import map`);
}
