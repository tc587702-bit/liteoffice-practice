/**
 * prepare-onlyoffice.mjs —— 把 onlyoffice-web-local 的静态资源装进 public/。
 *
 * 为什么必须复制而不是直接从 node_modules 引用：
 *   ONLYOFFICE 的编辑器在运行时用 **相对路径** 去加载 sdkjs / web-apps / wasm / fonts。
 *   它不知道什么是 node_modules，也不会经过 Vite 的模块解析。
 *   所以这些文件必须真的躺在站点可访问的目录里，我们再把那个目录通过
 *   `resourcePath` 告诉它。
 *
 * 一次性复制（约 199 MB），之后 dev / build 都直接可用，不用每次跑。
 * 代价是磁盘上多一份副本 —— 相比「每次构建都要处理」，这个取舍对课程项目更划算。
 *
 * 用法：
 *   node scripts/prepare-onlyoffice.mjs          复制
 *   node scripts/prepare-onlyoffice.mjs --check  只检查是否已就绪
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules', 'onlyoffice-web-local', 'dist');
const DEST = join(ROOT, 'public', 'onlyoffice');

/** 编辑器运行时会去找的目录。少一个都会导致「加载失败但看不出原因」。 */
const DIRS = ['sdkjs', 'web-apps', 'wasm', 'fonts', 'img'];

const checkOnly = process.argv.includes('--check');

if (!existsSync(SRC)) {
  console.error('[prepare-oo] 找不到 onlyoffice-web-local，请先运行：');
  console.error('             npm install onlyoffice-web-local');
  process.exit(1);
}

const missing = DIRS.filter((d) => !existsSync(join(SRC, d)));
if (missing.length) {
  console.error(`[prepare-oo] 包里缺少目录：${missing.join(', ')}`);
  console.error('             这个版本的包结构和预期不符，请检查 node_modules/onlyoffice-web-local/dist');
  process.exit(1);
}

if (checkOnly) {
  const ready = DIRS.every((d) => existsSync(join(DEST, d)));
  console.log(`[prepare-oo] public/onlyoffice 已就绪: ${ready}`);
  process.exit(ready ? 0 : 1);
}

mkdirSync(DEST, { recursive: true });

let files = 0;
let bytes = 0;
for (const dir of DIRS) {
  cpSync(join(SRC, dir), join(DEST, dir), { recursive: true });
  const count = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1), 0);
  const size = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
    const p = join(d, e.name);
    return n + (e.isDirectory() ? size(p) : statSync(p).size);
  }, 0);
  const c = count(join(DEST, dir));
  const s = size(join(DEST, dir));
  files += c;
  bytes += s;
  console.log(`  ${dir.padEnd(10)} ${String(c).padStart(4)} 个文件  ${(s / 1024 / 1024).toFixed(1)} MB`);
}

console.log(`[prepare-oo] 完成：${files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB -> public/onlyoffice`);
console.log('[prepare-oo] 编辑器资源路径应设为 "/onlyoffice"（见 src/lib/editorAdapter.ts）');
