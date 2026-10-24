/**
 * dist.mjs —— 打出一个「上传即可用」的静态站点目录。
 *
 * 为什么需要它：LiteOffice 是纯前端（零后端），所以分享给别人最省事的方式
 * 不是拷文件夹，而是给它一个**网址**。但仓库根目录不能直接当站点根：
 *   - 里面混着源码、测试、文档、基准脚本，静态托管会全部暴露
 *   - index.html 在 apps/web/ 下，需要保持和 build/ 的相对位置
 *
 * 所以这里把「运行应用真正需要的三个东西」按原样搬进 dist/：
 *   dist/apps/web/index.html     ← 入口（相对路径 ../../build/... 正好指向 dist/build）
 *   dist/apps/web/styles.css
 *   dist/build/**                ← 类型擦除后的原生 ESM 产物
 * 再补两个文件：
 *   dist/index.html              ← 301 到 ./apps/web/，这样站点根也能直接打开
 *   dist/.nojekyll               ← GitHub Pages 必需，否则下划线开头的文件会被 Jekyll 丢掉
 *
 * 用法：
 *   node tools/dist.mjs            生成 dist/
 *   node tools/dist.mjs --verify   生成后起临时服务爬一遍模块图，确认不会白屏
 *
 * 重要：dist/ 里**没有** packages/ 源码，也没有 node_modules（本来就没有）。
 * 产物是原生 ESM，任何静态服务器都能直接提供，不需要构建步骤。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer, listen } from './serve.mjs';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const verify = process.argv.includes('--verify');

function fail(message) {
  console.error(`[dist] ✖ ${message}`);
  process.exit(1);
}

// ---- 1. 先构建，保证 dist 里是当前的产物 ----
console.log('[dist] 构建中…');
try {
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build.mjs'), '--quiet'], { cwd: ROOT, stdio: 'inherit' });
} catch {
  fail('构建失败，请先修好 node tools/build.mjs');
}

if (!existsSync(join(ROOT, 'build', 'apps', 'web', 'src', 'main.js'))) {
  fail('build/apps/web/src/main.js 不存在 —— 构建产物不完整');
}

// ---- 2. 清空并重建 dist ----
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'apps', 'web'), { recursive: true });

// ---- 3. 搬运行应用所需的全部内容（保持相对结构不变）----
cpSync(join(ROOT, 'apps', 'web', 'index.html'), join(DIST, 'apps', 'web', 'index.html'));
cpSync(join(ROOT, 'apps', 'web', 'styles.css'), join(DIST, 'apps', 'web', 'styles.css'));
cpSync(join(ROOT, 'build'), join(DIST, 'build'), { recursive: true });

/*
 * ---- 4. 站点根**直接就是工作台**（不再是跳转页）----
 *
 * 早期这里放的是一个 `<meta refresh>` 跳转页，结果是：打开网址先闪一下，
 * 再跳到 /apps/web/。用户会说「这不像个正常网站」—— 而且多一层跳转也多一个出错点
 * （分享出去的链接失败时，很难分清是跳转没生效还是应用没加载）。
 *
 * 现在把 index.html 复制到根，并把里面的相对路径改写成「相对站点根」：
 *   ../../build/...  →  ./build/...        （build 在 dist 根）
 *   ./styles.css     →  ./apps/web/styles.css
 * 同时保留 /apps/web/ 那份，老链接继续可用。
 */
const shellPath = join(DIST, 'apps', 'web', 'index.html');
const rootShell = readFileSync(shellPath, 'utf8')
  .replace(/\.\.\/\.\.\/build\//g, './build/')
  .replace(/href="\.\/styles\.css"/g, 'href="./apps/web/styles.css"');
writeFileSync(join(DIST, 'index.html'), rootShell, 'utf8');

// ---- 5. GitHub Pages：别让 Jekyll 处理 ----
writeFileSync(join(DIST, '.nojekyll'), '', 'utf8');

/*
 * ---- 5b. Netlify / Cloudflare Pages 的缓存与安全头 ----
 *
 * 为什么需要：Netlify 默认给静态文件 `Cache-Control: public, max-age=0, must-revalidate`
 * =「每次回源校验」。本项目有 98 个 ES 模块，从中国大陆访问 Netlify 时单次往返
 * 实测能从 150ms 飙到 14 秒 —— 98 次校验足以让页面「卡到不能用」。
 *
 * 给 /build/ 一个**较短**的正缓存（10 分钟）：挡住同一会话内反复刷新的重复校验，
 * 又不会让重新部署后的旧代码长期赖在缓存里。
 *
 * 刻意不用 `immutable` / 一年那种长缓存：本项目文件名**不带内容哈希**，
 * 长缓存会导致「明明改了代码却看不到效果」—— 那种问题比慢更难排查。
 */
writeFileSync(
  join(DIST, '_headers'),
  `# 由 tools/dist.mjs 生成，不要手改
/apps/web/*
  Cache-Control: public, max-age=0, must-revalidate

/build/*
  Cache-Control: public, max-age=600

/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: no-referrer
`,
  'utf8',
);

// ---- 6. 统计体积 ----
function totalSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        files++;
        try {
          total += statSync(p).size;
        } catch {
          /* 忽略读不到的文件 */
        }
      }
    }
  };
  walk(dir);
  return { total, files };
}

const size = totalSize(DIST);
console.log(`[dist] 已生成 ${DIST}（${size.files} 个文件，${(size.total / 1024).toFixed(0)} KiB）`);
console.log(`[dist] 应用入口（本地预览）：http://127.0.0.1:5180/apps/web/`);
console.log('[dist] 部署：把这个 dist 目录整个上传到任何静态托管即可（Netlify / Vercel / GitHub Pages / Nginx）');
console.log('[dist] 注意：仓库里没有 dist/，它每次由本脚本重建，不要手工修改');

// ---- 7. 可选：起临时服务爬一遍模块图 ----
if (verify) {
  const server = createStaticServer(DIST);
  const port = await listen(server, 5299);
  const origin = `http://127.0.0.1:${port}`;
  const seen = new Set();
  const queue = ['/apps/web/'];
  const problems = [];
  let ok = 0;
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    let res;
    try {
      res = await fetch(origin + path);
    } catch (err) {
      problems.push(`${path}: ${err?.message ?? err}`);
      continue;
    }
    if (!res.ok) {
      problems.push(`${path}: HTTP ${res.status}`);
      continue;
    }
    ok++;
    const type = res.headers.get('content-type') ?? '';
    if (!/javascript|html/.test(type)) continue;
    const body = await res.text();
    // HTML：跟进 script src / link href（只看首页会漏掉整棵模块图）
    if (/text\/html/.test(type)) {
      for (const m of body.matchAll(/<script[^>]*src=["']([^"']+)["']/g)) {
        queue.push(new URL(m[1], origin + path).pathname);
      }
      continue;
    }
    // 静态 import + **动态 import()** 都要跟进：读取器是动态加载的，
    // 漏掉它们就会在校验里显示「全绿」，而实际上某个格式包 404 会导致该格式打不开。
    const specs = [];
    for (const m of body.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of body.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      queue.push(spec.startsWith('/') ? spec : new URL(spec, origin + path).pathname);
    }
  }
  server.close();
  console.log(`\n[dist] 校验：dist 里 ${ok} 个资源 200，${problems.length} 个失败`);
  if (problems.length) {
    for (const p of problems.slice(0, 20)) console.error(`    ✖ ${p}`);
    fail('dist 校验失败 —— 上传后别人会看到白屏');
  }
  console.log('[dist] ✔ dist 自包含可运行（入口 /apps/web/，相对路径全部可达）');
}
