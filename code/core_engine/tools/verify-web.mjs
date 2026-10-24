/**
 * verify-web.mjs —— 从入口出发爬取整个模块图，确认浏览器不会 404。
 *
 * 为什么需要这个工具（而不是只 curl 首页）：
 *   `tools/build.mjs` 只做类型擦除，**不解析导入**。所以「源码里的相对导入在产物里
 *   是否真的指向一个存在的 .js」这件事，构建阶段完全看不见。
 *   一旦某个导入写错，表现是：构建成功、首页 200、控制台一行红、**整个应用白屏**。
 *   本项目已经踩过两次（跨包导入上溯层数算错、导入指向改过名的文件）。
 *
 *   `tools/lint.mjs` 会在**源码层**查这类问题；本工具从**产物层**再查一遍，
 *   而且是沿着真实的 import 图爬 —— 只有真正会被浏览器加载到的模块才在覆盖范围内。
 *
 * 用法：
 *   node tools/verify-web.mjs            # 起临时服务、爬完即退出
 *   node tools/verify-web.mjs --verbose  # 打印每个模块
 */
import { createStaticServer, listen } from './serve.mjs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const ENTRY_PATH = '/apps/web/';

if (!existsSync(join(ROOT, 'build', 'apps', 'web', 'src', 'main.js'))) {
  console.error('[verify-web] build/apps/web/src/main.js 不存在，请先跑 node tools/build.mjs');
  process.exit(1);
}

const server = createStaticServer(ROOT);
const port = await listen(server, 5199);
const origin = `http://127.0.0.1:${port}`;

/**
 * 从一段 JS 源码里提取所有导入说明符，并区分**静态**与**动态**。
 *
 * 这个区分至关重要：
 *   - **静态** `import x from "node:fs"` 会在浏览器加载模块时立刻解析 → 直接白屏
 *   - **动态** `await import("node:fs")` 是惰性的 → 只要那条分支在浏览器下不执行就安全
 * 本项目允许后者（`engine` 的 `openFile()` 就是这种写法：Node 专用、浏览器永不调用），
 * 禁止前者。若不区分，工具会把安全的惰性导入也报成错误，最终没人信它。
 */
function importSpecifiers(code) {
  const out = new Map(); // spec -> isDynamic
  const staticPatterns = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g];
  for (const re of staticPatterns) {
    let m;
    while ((m = re.exec(code)) !== null) out.set(m[1], out.get(m[1]) ?? false);
  }
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = dynamicRe.exec(code)) !== null) {
    // 同一个说明符若既有静态又有动态，静态优先（更危险）
    if (!out.has(m[1])) out.set(m[1], true);
  }
  return [...out.entries()].map(([spec, dynamic]) => ({ spec, dynamic }));
}

/** 把说明符解析成站内绝对路径；外部协议或数据 URI 返回 null */
function resolveSpecifier(spec, fromUrl) {
  if (/^(https?:|data:|blob:)/.test(spec)) return null;
  if (spec.startsWith('/')) return spec;
  if (spec.startsWith('./') || spec.startsWith('../')) return new URL(spec, origin + fromUrl).pathname;
  // 裸说明符：本架构没有 import map、也没有 node_modules
  return `__BARE__:${spec}`;
}

const seen = new Set();
const queue = [ENTRY_PATH];
const problems = [];
/** 裸说明符分类：静态 node: → 致命；动态 node: → 安全的惰性导入；其他裸 → 致命 */
const staticNodeImports = [];
const lazyNodeImports = new Set();
const otherBare = [];
let ok = 0;
const started = Date.now();

while (queue.length) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);

  if (path.startsWith('__BARE__:')) {
    const rest = path.slice('__BARE__:'.length);
    const [spec, kind] = rest.split('|');
    if (spec.startsWith('node:')) {
      if (kind === 'static') staticNodeImports.push(spec);
      else lazyNodeImports.add(spec);
    } else {
      otherBare.push(spec);
    }
    continue;
  }

  let res;
  try {
    res = await fetch(origin + path);
  } catch (err) {
    problems.push({ path, status: 0, reason: `请求失败：${err?.message ?? err}` });
    continue;
  }
  if (!res.ok) {
    problems.push({ path, status: res.status, reason: `HTTP ${res.status}` });
    continue;
  }
  ok++;
  if (verbose) console.log(`  200  ${path}`);

  const type = res.headers.get('content-type') ?? '';
  if (!/javascript|html/.test(type)) continue;

  const body = await res.text();
  if (/text\/html/.test(type)) {
    // 从 HTML 里找 script src 与 href
    for (const m of body.matchAll(/<script[^>]*src=["']([^"']+)["']/g)) queue.push(resolveSpecifier(m[1], path) ?? '');
    for (const m of body.matchAll(/<link[^>]*href=["']([^"']+)["']/g)) queue.push(resolveSpecifier(m[1], path) ?? '');
    queue.push('/apps/web/styles.css');
    queue.filter(Boolean);
    continue;
  }
  for (const { spec, dynamic } of importSpecifiers(body)) {
    const target = resolveSpecifier(spec, path);
    if (!target) continue;
    // 裸说明符要带上「静态还是动态」的信息，供分类判断
    queue.push(target.startsWith('__BARE__:') ? `${target}|${dynamic ? 'dynamic' : 'static'}` : target);
  }
}

server.close();

const ms = Date.now() - started;
console.log('');
console.log(`[verify-web] 从 ${ENTRY_PATH} 出发爬取模块图：${ok} 个资源 200，${problems.length} 个失败，耗时 ${ms} ms`);

if (lazyNodeImports.size) {
  console.log(
    `[verify-web] 惰性 node: 导入 ${lazyNodeImports.size} 个（安全 —— 只在 Node 专用分支里执行）：` +
      [...lazyNodeImports].join(', '),
  );
}

let failed = false;

if (staticNodeImports.length) {
  failed = true;
  console.error(`\n✖ ${staticNodeImports.length} 处**静态**导入 node: 模块（浏览器会直接白屏）：`);
  for (const s of [...new Set(staticNodeImports)]) console.error(`    ${s}`);
  console.error('  修法：改成惰性 `await import("node:...")`，并用运行环境判断把那条分支限死在 Node');
}

if (otherBare.length) {
  failed = true;
  console.error(`\n✖ ${otherBare.length} 个无法解析的裸模块说明符（本架构没有 import map / node_modules）：`);
  for (const s of [...new Set(otherBare)].slice(0, 20)) console.error(`    ${s}`);
  console.error('  修法：改成相对路径并带 .ts 后缀（构建会改写成 .js）');
}

if (problems.length) {
  failed = true;
  console.error(`\n✖ ${problems.length} 个资源加载失败（浏览器会白屏）：`);
  for (const p of problems.slice(0, 30)) console.error(`    ${p.status || 'ERR'}  ${p.path}  ${p.reason}`);
  console.error('\n  常见原因：相对导入上溯层数算错、指向了改过名的文件、或导入了构建范围之外的文件。');
  console.error('  先跑 node tools/lint.mjs —— 它能在源码层定位大部分此类问题。');
}

if (failed) process.exit(1);

console.log('[verify-web] ✔ 模块图完整可达，且无静态 node: 导入 —— 浏览器加载不会白屏');
