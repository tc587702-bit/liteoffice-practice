/**
 * pack.mjs —— 把一个目录打成「可直接上传到静态托管」的 zip。
 *
 * 为什么不用 PowerShell 的 Compress-Archive / .NET ZipFile：
 * **它们写出的条目名用反斜杠**（`apps\web\index.html`），而 ZIP 规范（APPNOTE 4.4.17.1）
 * 要求用正斜杠。多数静态托管会把它当字面文件名，于是所有子目录资源全部 404 ——
 * 上传成功、网址能打开、然后白屏。实测本机 .NET 4.x 的 ZipFile 就是这个行为。
 *
 * 所以这里用**本项目自己的 ZipWriter**（`packages/zip`）来打包：
 * 它会把 `\` 规范成 `/`，并且顺带验证一次自己的 ZIP 实现是否正确。
 *
 * 用法：
 *   node tools/pack.mjs <源目录> <输出.zip>
 *   node tools/pack.mjs dist liteoffice-site.zip
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipWriter, ZipReader } from '../packages/zip/src/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法: node tools/pack.mjs <源目录> <输出.zip>');
  process.exit(1);
}
/** 相对路径按仓库根解析，绝对路径原样使用（避免 join 出 `C:\repo\C:\...` 这种怪路径） */
const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));
const srcDir = resolvePath(args[0]);
const outPath = resolvePath(args[1]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(srcDir);
if (files.length === 0) {
  console.error(`[pack] ✖ ${srcDir} 里没有文件`);
  process.exit(1);
}

const writer = new ZipWriter();
for (const file of files) {
  // 关键：用 POSIX 风格相对路径作为条目名（ZipWriter 内部也会把 \ 规范化）
  const name = relative(srcDir, file).split(sep).join('/');
  writer.add(name, new Uint8Array(readFileSync(file)));
}

const bytes = await writer.build();
writeFileSync(outPath, bytes);
console.log(`[pack] ${files.length} 个文件 -> ${outPath}（${(bytes.length / 1024).toFixed(0)} KiB）`);

// ---- 自校验：读回来，确认条目名是正斜杠、且入口齐全 ----
const zip = ZipReader.open(bytes);
const names = zip.entryNames;
const backslash = names.filter((n) => n.includes('\\'));
if (backslash.length) {
  console.error(`[pack] ✖ ${backslash.length} 个条目名含反斜杠，静态托管会 404`);
  process.exit(1);
}
const required = ['index.html', 'apps/web/index.html', 'apps/web/styles.css', 'build/apps/web/src/main.js'];
const missing = required.filter((r) => !names.includes(r));
if (missing.length) {
  console.error(`[pack] ✖ 缺少入口文件：${missing.join(', ')}`);
  process.exit(1);
}
console.log(`[pack] 条目 ${names.length} 个，全部正斜杠；入口文件齐全`);
for (const r of required) console.log(`    ${r}  (${zip.entrySize(r)} B)`);
