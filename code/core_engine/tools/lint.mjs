/**
 * lint.mjs —— 项目硬约束巡检。
 *
 * 为什么不用 ESLint：零依赖约束不允许引入它，而且这里要检查的规则非常项目特定
 * （可擦除语法、相对路径导入），通用 linter 反而要写一堆配置。
 * 一个 200 行的脚本能把这两类最容易出事的问题在**提交前**拦住：
 *
 *   1. 不可擦除的 TypeScript 语法
 *      Node 的 strip-only 模式会直接报错。报错信息很晦涩
 *      （"TypeScript parameter property is not supported in strip-only mode"），
 *      而且只有在真正执行到那个文件时才会暴露。提前检查能省大量排查时间。
 *
 *   2. 裸包名导入
 *      `import x from '@liteoffice/core'` 会因为 Node 拒绝对 node_modules 下的
 *      .ts 做类型擦除而失败（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。
 *      必须用相对路径。
 *
 * 用法：
 *   node tools/lint.mjs           # 只报错
 *   node tools/lint.mjs --warn    # 也报告警告级问题
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const showWarn = process.argv.includes('--warn');

const errors = [];
const warns = [];

function err(file, line, msg) {
  errors.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line, msg });
}
function warn(file, line, msg) {
  warns.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line, msg });
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'build' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && (extname(e.name) === '.ts' || extname(e.name) === '.mjs')) acc.push(p);
  }
  return acc;
}

const files = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'test')), ...walk(join(ROOT, 'tools')), ...walk(join(ROOT, 'bench')), ...walk(join(ROOT, 'docs'))];

/*
 * 文件必须是合法 UTF-8。
 *
 * 为什么单独检这一条：`readFileSync(f, 'utf8')` 遇到非法字节会**静默替换成 U+FFFD**，
 * 于是上面所有规则都在一份「已经被破坏的文本」上运行 —— 中文注释变成乱码，
 * 但没有任何规则会报错。而 Node 的 ESM 加载器遇到非法 UTF-8 会直接抛
 * SyntaxError，错误信息指向文件却不说原因。
 *
 * 真实踩过：用 PowerShell 的 `Get-Content | Set-Content` 处理中文文件时，
 * 读入按 GBK 解码、写出按 UTF-8 编码，一次往返就把中文全毁掉。
 * 这个检查让那种损坏在 lint 阶段就暴露，而不是等到运行时报一句莫名其妙的语法错误。
 */
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
for (const file of files) {
  try {
    utf8Fatal.decode(readFileSync(file));
  } catch {
    err(file, 1, '文件不是合法 UTF-8（会含 U+FFFD 替换字符），Node 加载时会直接语法报错。常见成因：用 Get-Content/Set-Content 做过编码往返');
  }
}

/*
 * 文档与数据文件也要是合法 UTF-8。
 *
 * 上面的 `files` 只收了 .ts/.mjs（面向代码规则），但 markdown / json / html / css
 * 同样是交付物：一个编码损坏的 README 或格式矩阵，读者只会看到满屏乱码，
 * 而没有任何工具会报错。检查成本极低，所以一并覆盖。
 */
const TEXT_ASSET_EXT = new Set(['.md', '.json', '.html', '.css', '.yml', '.yaml']);
function walkAll(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'build' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkAll(p, acc);
    else if (e.isFile() && TEXT_ASSET_EXT.has(extname(e.name))) acc.push(p);
  }
  return acc;
}
for (const file of walkAll(ROOT)) {
  try {
    utf8Fatal.decode(readFileSync(file));
  } catch {
    err(file, 1, '文档/数据文件不是合法 UTF-8（会在阅读器里显示成乱码，且没有任何其他工具会报错）');
  }
}

/** 逐行检查。用行号报错，方便直接跳转。 */
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const isTs = extname(file) === '.ts';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    // 注释行要区分对待：
    //   - 面向「代码」的规则（语法、导入）在注释行上会误判，必须跳过
    //   - 但「注释内容本身」的规则（如块注释被提前终止）只在注释行上有意义
    // 早期版本在这里直接 `continue`，导致后者永远不可达 —— 规则写了但从不生效。
    const trimmed = line.trim();
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');

    /*
     * 块注释被提前终止。
     *
     * 真实踩过的坑（而且写这条规则时自己又踩了一次）：
     * PDF 内容流算子列表写成 `Tm/Td/TD/T*` 紧跟 `/Tf`，其中「星号+斜杠」
     * 这个两字符序列正好是块注释的结束符，于是注释在这里就断了，
     * 后面的注释文字变成代码，报出 `Expected ';', '}' or <eof>`，
     * 而错误位置指向注释内容 —— 完全看不出真正原因。
     *
     * 判据：注释续行（trim 后以 * 开头）里若出现该结束符且其后还有非空白字符，
     * 几乎一定是误闭合（合法的结束符后面不应该再有内容）。
     */
    if (isComment && /^\s*\*/.test(line)) {
      const closer = '*' + '/';
      const close = line.indexOf(closer);
      if (close >= 0 && line.slice(close + 2).trim() !== '') {
        err(
          file,
          ln,
          `块注释里出现了注释结束符，会提前终止注释（其后还有内容："${line.slice(close + 2).trim().slice(0, 24)}"）。请改写该处，例如写成 "T* / Tf"，或改用行注释`,
        );
      }
    }

    if (isComment) continue;

    if (isTs) {
      // ---- 不可擦除语法 ----
      if (/^\s*(?:export\s+)?(?:const\s+)?enum\s+\w/.test(line)) {
        err(file, ln, '禁止 enum（不可擦除）。改用 `const X = {...} as const` + `type X = typeof X[keyof typeof X]`');
      }
      if (/^\s*(?:export\s+)?namespace\s+\w/.test(line)) {
        err(file, ln, '禁止 namespace（不可擦除）。改用普通 ESM 模块');
      }
      // 构造函数参数属性：constructor(... readonly x: T ...)
      if (/\bconstructor\s*\(/.test(line)) {
        // 可能跨行：把构造函数的参数区拼起来看
        let buf = line;
        let j = i;
        while (!buf.includes(')') && j + 1 < lines.length && j - i < 30) {
          j++;
          buf += ' ' + lines[j];
        }
        if (/\b(?:public|private|protected|readonly)\s+\w+\s*[:?]/.test(buf)) {
          err(file, ln, '禁止构造函数参数属性（不可擦除）。改为显式声明字段并在构造函数里赋值');
        }
      }
      if (/^\s*(?:export\s+)?declare\s+(?:module|namespace|global|const|class|function)\b/.test(line)) {
        err(file, ln, '禁止 declare 语句（不可擦除）');
      }
      if (/^\s*@\w+\s*\(/.test(line) && !/^\s*@liteoffice/.test(line)) {
        warn(file, ln, '疑似装饰器（不可擦除）。若不是装饰器请忽略');
      }
      if (/\bimport\s+\w+\s*=\s*require\s*\(/.test(line)) {
        err(file, ln, '禁止 import = require（不可擦除）。改用 import / 动态 import()');
      }

      // ---- 导入路径 ----
      const importRe = /(?:\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/g;
      let m;
      while ((m = importRe.exec(line)) !== null) {
        const spec = m[2];
        if (spec.startsWith('@liteoffice/')) {
          err(file, ln, `禁止裸包名导入 "${spec}"。Node 拒绝对经 node_modules 解析的 .ts 做类型擦除，必须用相对路径`);
        } else if (/^\.{1,2}\//.test(spec) && !spec.endsWith('.ts') && !spec.endsWith('.json') && !spec.endsWith('.mjs')) {
          // 允许目录形式的 ../../x/src/index.ts；这里只拦「忘了写后缀」的情况
          if (!spec.endsWith('/')) {
            err(file, ln, `相对导入 "${spec}" 缺少 .ts 后缀。必须写 "./x.ts"（构建脚本会自动改成 .js）`);
          }
        } else if (spec.startsWith('/')) {
          warn(file, ln, `绝对路径导入 "${spec}" 不利于移植`);
        }
      }

      // ---- 其他项目特定规则 ----
      if (/\bdocument\.write\s*\(/.test(line)) err(file, ln, '禁止 document.write');
      if (/\.innerHTML\s*=/.test(line) && !/=\s*''/.test(line) && !/=\s*""/.test(line)) {
        warn(file, ln, '给 innerHTML 赋值有 XSS 风险。渲染用户内容请用 createElement + textContent');
      }
      if (/\bnew\s+Function\s*\(/.test(line) || /\beval\s*\(/.test(line)) {
        err(file, ln, '禁止 eval / new Function');
      }
    }

    // ---- 依赖声明（静态 import 的裸模块）----
    if (isTs) {
      const bareRe = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](?!\.|\/|@liteoffice\/)([^"']+)["']/g;
      let b;
      while ((b = bareRe.exec(line)) !== null) {
        const spec = b[1];
        const ok = spec.startsWith('node:');
        if (!ok) {
          err(file, ln, `引用了外部模块 "${spec}"。本项目零依赖，只允许 node: 内置模块`);
        }
      }

      // ---- 浏览器侧代码不得【静态】导入 node: 模块 ----
      // 关键区分：静态导入会在浏览器加载模块时立刻解析 → 直接报错、整个应用起不来。
      // 动态 `await import('node:fs/promises')` 是惰性的，只要那条分支在浏览器下不会执行就安全，
      // 因此只拦静态形式。这是「同一份代码既跑 Node 又跑浏览器」这条架构线的守门人。
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      const isBrowserBound = (rel.startsWith('packages/') || rel.startsWith('apps/web/')) && rel.includes('/src/');
      if (isBrowserBound && /^\s*import\b/.test(line)) {
        const staticNode = /^\s*import\s+(?:type\s+)?[^'"]*from\s*["'](node:[^"']+)["']/.exec(line);
        const staticSideEffect = /^\s*import\s*["'](node:[^"']+)["']/.exec(line);
        const hit = staticNode ?? staticSideEffect;
        if (hit) {
          err(file, ln, `浏览器侧代码不得静态导入 "${hit[1]}"。若只在 Node 下使用，请改为惰性 \`await import("${hit[1]}")\` 并加运行环境判断`);
        }
      }
    }
  }
}

// ---- package.json 不许有依赖 ----
for (const dir of ['', 'packages/core', 'packages/zip', 'packages/xml', 'packages/ooxml', 'packages/engine', 'packages/format-text', 'packages/format-docx', 'packages/format-xlsx', 'packages/format-odf', 'packages/format-pptx', 'packages/format-pdf', 'packages/render-dom']) {
  const pj = join(ROOT, dir, 'package.json');
  if (!existsSync(pj)) continue;
  try {
    const meta = JSON.parse(readFileSync(pj, 'utf8'));
    if (meta.dependencies && Object.keys(meta.dependencies).length) {
      err(pj, 1, `不允许 dependencies：${Object.keys(meta.dependencies).join(', ')}`);
    }
    if (meta.devDependencies && Object.keys(meta.devDependencies).length) {
      err(pj, 1, `不允许 devDependencies：${Object.keys(meta.devDependencies).join(', ')}`);
    }
  } catch (e) {
    err(pj, 1, `package.json 解析失败：${e.message}`);
  }
}

// ---- node_modules 不该存在 ----
if (existsSync(join(ROOT, 'node_modules'))) {
  err(join(ROOT, 'node_modules'), 0, 'node_modules 存在。本项目零依赖，不应该有它（若是误建请删除）');
}

// ---- 相对导入必须指向真实存在的文件 ----
/**
 * 为什么必须静态检查这件事：
 * `stripTypeScriptTypes` 只做类型擦除，**不解析导入**。所以一个写错的相对导入
 * （文件名拼错、目录层级写错、把 `./reader.ts` 写成 `./readers.ts`）
 * 能顺利通过构建，只在**运行时**抛 ERR_MODULE_NOT_FOUND。
 * 在浏览器里那表现为「整个应用白屏，控制台一行红色」，排查成本极高。
 * 这里在构建前把它拦住，并给出「是否想写 xxx」的提示。
 */
for (const file of files) {
  if (extname(file) !== '.ts') continue;
  const src = readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      const spec = m[1];
      const target = join(dirname(file), spec);
      if (existsSync(target)) continue;
      // 也允许指向目录（目录下应有 index.ts）
      if (existsSync(join(target, 'index.ts'))) continue;
      // 给一个「可能是想写这个」的提示
      let hint = '';
      const dir = dirname(target);
      const want = target.slice(dir.length + 1).replace(/\.ts$/, '');
      if (existsSync(dir)) {
        const near = readdirSync(dir)
          .filter((f) => f.endsWith('.ts') && f.replace(/\.ts$/, '').includes(want.slice(0, Math.max(2, want.length - 2))))
          .slice(0, 4);
        if (near.length) hint = `；该目录下有相似文件：${near.join(', ')}`;
      }
      err(file, i + 1, `相对导入 "${spec}" 指向不存在的文件${hint}`);
    }
  }
}

// ---- 浏览器侧源文件只能导入「构建范围内」的文件 ----
/**
 * `tools/build.mjs` 只编译 `packages/<包>/src/**` 与 `apps/web/src/**`。
 * 如果这些文件里的相对导入指到了构建范围之外（例如某个包的 `testutil/`、
 * 或 `bench/`、`test/`），源码在 Node 下能跑（Node 会直接执行那个 .ts），
 * 但**构建产物里不会有对应的 .js** —— 浏览器加载时 404，整个应用白屏。
 *
 * 这是「Node 与浏览器共用同一份源码」这条架构线上最隐蔽的一类断裂：
 * 单测全过、build 也过，只有真正在浏览器里才炸。
 */
const BUILD_SCOPE = /^(?:packages[\\/][^\\/]+[\\/]src[\\/]|apps[\\/]web[\\/]src[\\/])/;
for (const file of files) {
  if (extname(file) !== '.ts') continue;
  const relFile = relative(ROOT, file).replace(/\\/g, '/');
  if (!BUILD_SCOPE.test(relFile)) continue;

  const src = readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      const target = relative(ROOT, join(dirname(file), m[1])).replace(/\\/g, '/');
      if (BUILD_SCOPE.test(target)) continue;
      err(
        file,
        i + 1,
        `浏览器侧源码导入了构建范围之外的 "${m[1]}"（解析为 ${target}）。构建只覆盖 packages/<包>/src 与 apps/web/src，产物里不会有它，浏览器会 404 白屏`,
      );
    }
  }
}

// ---- 已构建的产物里，相对导入必须全部可解析 ----
/**
 * 构建只做类型擦除 + 把 `.ts` 改写成 `.js`，**不解析导入**。
 * 所以「产物里的相对路径是否真的指向一个存在的 .js」这件事没人管过。
 * 这里直接对 build/ 做一遍检查 —— 它是浏览器实际会加载的那份东西，
 * 比检查源码更接近真相。（build/ 不存在时跳过，不影响干净检出后的 lint。）
 */
const BUILD_DIR = join(ROOT, 'build');
if (existsSync(BUILD_DIR)) {
  const builtFiles = walk(BUILD_DIR).filter((f) => extname(f) === '.js');
  for (const file of builtFiles) {
    const src = readFileSync(file, 'utf8');
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const target = join(dirname(file), m[1]);
      if (existsSync(target)) continue;
      err(file, 0, `构建产物里的相对导入 "${m[1]}" 指向不存在的文件（浏览器会 404 白屏）。跑 node tools/build.mjs 重建；若仍失败，说明源码里有构建范围外的导入`);
    }
  }
}

// ---- FormatId 联合类型与 FORMATS 表必须一一对应 ----
/**
 * TypeScript 无法在运行时枚举一个类型联合的成员，所以这条一致性只能靠读源码。
 *
 * 为什么必须查：`FormatId` 里多出一个成员、而 `FORMATS` 表里没有对应行时，
 * 读取器**可以**声明支持它（`formats: ['potx']`），但：
 *   - `formatSpec('potx')` 会回退到 unknown，UI 显示成「未知格式」
 *   - 「已支持 + 未安装 > 声明总数」的统计自相矛盾
 * 实际踩过：`xltx` / `potx` 只作为 `xlsm` / `pptm` 的**扩展名**存在，
 * 却被写进了 FormatId 联合类型，于是 pptx 读取器声明 potx 后统计失衡。
 */
{
  const modelPath = join(ROOT, 'packages', 'core', 'src', 'model.ts');
  if (existsSync(modelPath)) {
    const modelSrc = readFileSync(modelPath, 'utf8');
    const unionMatch = /export type FormatId =([\s\S]*?);/.exec(modelSrc);
    if (!unionMatch) {
      err(modelPath, 0, '找不到 FormatId 联合类型定义（lint 检查依赖于它的形状）');
    } else {
      const unionIds = [...unionMatch[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      const formatsSrc = readFileSync(join(ROOT, 'packages', 'core', 'src', 'formats.ts'), 'utf8');
      const tableIds = new Set([...formatsSrc.matchAll(/\bid:\s*'([^']+)'/g)].map((x) => x[1]));
      for (const id of unionIds) {
        if (!tableIds.has(id)) {
          err(
            modelPath,
            0,
            `FormatId 联合类型里的 '${id}' 在 FORMATS 表里没有对应条目。读取器可以声明它，但 formatSpec() 会回退到 unknown、UI 显示成「未知格式」。请二选一：在 formats.ts 里补一条 spec，或从联合类型里删掉它`,
          );
        }
      }
    }
  }
}

/*
 * 乱码检测：UTF-8 字节被当成 GBK/CP936 解读后再存成 UTF-8 的典型产物。
 *
 * 为什么需要单独一条：这种损坏**能通过所有其他检查** —— 文件仍是合法 UTF-8、
 * 语法正确、类型正确、测试也能跑（只是用户看到的格式名变成 "Excel" 后面跟一串怪字）。
 * 只有人眼会发现，而人眼不会每次都看。
 *
 * 判据用的是「只可能在乱码里出现」的码位：UTF-8 的中文标点与常用字被按 GBK
 * 拆解后会落到下表这些码位，真实中文几乎不会用到。
 * 用码位构造正则而不是直接写字面量 —— 否则本文件自己会被这条规则命中（自指）。
 *
 * 真实踩过两次：
 *   1. `Get-Content -Raw | Set-Content` 往返毁掉两个文件的中文（不可逆）
 *   2. 更隐蔽的一次：PowerShell 读→写把 formats.ts 里**所有格式名**变成乱码
 *      且吞掉换行，而 lint（当时只查 UTF-8 合法性）与全部测试都是绿的
 */
const MOJIBAKE_CODEPOINTS = [0x950b, 0x9286, 0x9225, 0x935c, 0x9428, 0x6d60, 0x9182, 0x5a34];
const MOJIBAKE = new RegExp(`[${MOJIBAKE_CODEPOINTS.map((c) => `\\u{${c.toString(16)}}`).join('')}]`, 'u');
for (const file of [...files, ...walkAll(ROOT)]) {
  let text;
  try {
    text = utf8Fatal.decode(readFileSync(file));
  } catch {
    continue; // 非法 UTF-8 已由上面的检查报过，这里不重复
  }
  const lines = text.split(/\r?\n/);
  let reported = 0;
  for (let i = 0; i < lines.length && reported < 3; i++) {
    if (MOJIBAKE.test(lines[i])) {
      err(
        file,
        i + 1,
        `疑似编码损坏（乱码）："${lines[i].trim().slice(0, 50)}"。成因通常是用 PowerShell 的 Get-Content/Set-Content 处理过含中文的文件 —— 读写按不同编码解释，往返即不可逆损坏。请用编辑工具重写该文件`,
      );
      reported++;
    }
  }
}
if (errors.length) {
  console.log(`\n✖ ${errors.length} 处违规：\n`);
  for (const e of errors) console.log(`  ${e.file}:${e.line}  ${e.msg}`);
}
if (showWarn && warns.length) {
  console.log(`\n⚠ ${warns.length} 处警告：\n`);
  for (const w of warns) console.log(`  ${w.file}:${w.line}  ${w.msg}`);
}
if (!errors.length && (!showWarn || !warns.length)) {
  console.log(`✔ 巡检通过：${files.length} 个文件，无违规${showWarn ? '' : `（警告数 ${warns.length}，加 --warn 查看）`}`);
} else if (!errors.length) {
  console.log(`\n✔ 无错误，${warns.length} 处警告`);
}

process.exit(errors.length ? 1 : 0);
