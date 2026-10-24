/**
 * check-encoding.mjs —— 检查源文件有没有被「编码事故」破坏。
 *
 * 为什么需要这个脚本：本项目开发期间**真实踩过三次**同一类事故——
 * 用 PowerShell 的 `Get-Content` / `Set-Content`（或 `ConvertTo-Json | Set-Content`）
 * 去改写文件，因为它按 GBK 读、按 UTF-8 写，会产生两种不可逆损坏：
 *
 *   1. **BOM 泄漏**：PS 5.1 的 `-Encoding UTF8` 会在文件开头写 EF BB BF，
 *      而 `package.json` / `tsconfig.json` 带 BOM 会让 JSON.parse 直接报
 *      `Unexpected token '﻿'`，Vite 启动失败。
 *   2. **中文乱码 + 换行被吞**：中文变成 `鐗堬細娴忚`，相邻行被并成一行，
 *      于是 `<div>` 标签"缺闭合"——报错指向的位置和真实病因完全无关，极难排查。
 *
 * 所以：**改含中文的文件只能用编辑工具**，不能用 shell 文本往返。
 * 这个脚本用来在启动前把这类问题抓出来。
 *
 * 用法：node scripts/check-encoding.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 需要检查的文件类型 */
const EXT = new Set(['.ts', '.vue', '.css', '.json', '.html', '.mjs', '.md']);

/** 只检查这些目录（node_modules / dist / public 里的第三方资源不归我们管） */
const DIRS = ['src', 'scripts', 'public/onlyoffice/..'];
const ROOT_FILES = ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'demo.html'];

/** UTF-8 中文被当 GBK 解读后的典型产物。正常中文几乎不会用到这些字。 */
const MOJIBAKE = /[\u935C\u9428\u95F3\u7F02\u5A11\u9342\u5BEE\u951B\u9286\u9225]/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

const files = [];
for (const d of ['src', 'scripts']) {
  try {
    walk(join(ROOT, d), files);
  } catch {
    /* 目录不存在就跳过 */
  }
}
for (const f of ROOT_FILES) {
  try {
    files.push(join(ROOT, f));
  } catch {
    /* 忽略 */
  }
}

let problems = 0;

for (const file of files) {
  const buf = readFileSync(file);
  const rel = relative(ROOT, file);

  // 1) BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    console.error(`  ✖ ${rel}  : 文件开头有 BOM（EF BB BF）。JSON 带 BOM 会让 JSON.parse 失败`);
    problems++;
  }

  // 2) 非法 UTF-8
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    console.error(`  ✖ ${rel}  : 不是合法的 UTF-8`);
    problems++;
    continue;
  }

  // 3) 乱码特征
  const lines = text.split(/\r?\n/);
  let reported = 0;
  for (let i = 0; i < lines.length && reported < 3; i++) {
    if (MOJIBAKE.test(lines[i])) {
      console.error(`  ✖ ${rel}:${i + 1}  : 疑似编码损坏 -> "${lines[i].trim().slice(0, 60)}"`);
      problems++;
      reported++;
    }
  }
}

if (problems === 0) {
  console.log(`[check-enc] ✔ 检查了 ${files.length} 个文件，没有 BOM / 编码损坏`);
  process.exit(0);
}

console.error(`\n[check-enc] ✖ 发现 ${problems} 处问题。`);
console.error('[check-enc] 修法：用编辑工具重写这些文件（不要用 PowerShell 的 Get-Content/Set-Content 往返）');
process.exit(1);
