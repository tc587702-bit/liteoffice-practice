# LiteOffice 工程约定（必须遵守）

本文件是**硬约束**。违反其中任何一条，代码在本项目里就跑不起来或不一致。

---

## 1. 零依赖

- **不允许任何 `dependencies` / `devDependencies`。**
- 不允许 `node_modules`（仓库里就没有这个目录，也不要创建）。
- 不允许引入 typescript / esbuild / rollup / vite / jest / vitest / JSZip / xmldom / pdfjs。
- 需要的能力必须来自平台内置：
  | 需求 | 用什么 |
  |---|---|
  | ZIP 压缩/解压 | `CompressionStream('deflate-raw')` / `DecompressionStream('deflate-raw')`（见 `@liteoffice/zip`） |
  | XML 解析 | `@liteoffice/xml` 的 `XmlPullParser`（不要用 `DOMParser`） |
  | TypeScript 类型擦除 | Node 内置 `module.stripTypeScriptTypes()`（见 `tools/build.mjs`） |
  | 测试 | `node:test` + `tools/test.mjs` |
  | 文本编解码 | `TextEncoder` / `TextDecoder` / `TextDecoderStream` |

## 2. 只用「可擦除」TypeScript 语法

代码由 Node 的 **strip-only** 模式擦除类型后直接在浏览器运行。因此禁止：

| 禁止 | 改用 |
|---|---|
| `enum` | `const X = {...} as const` + `type X = typeof X[keyof typeof X]` |
| 构造函数参数属性 `constructor(readonly a: T)` | 显式声明字段并在构造函数里赋值 |
| `namespace` / `module` | 普通 ESM 模块 |
| `declare` 语句、装饰器 | 不要用 |
| `import x = require(...)` | `import` / 动态 `import()` |

`tsconfig.json` 已开启 `erasableSyntaxOnly: true` 来兜住这条。

## 3. 跨包导入用相对路径 + `.ts` 后缀

```ts
// 正确：packages/xlsx/src/reader.ts 里引用 core
import { createDocument } from '../../core/src/index.ts';

// 错误：不要用裸包名，Node 会拒绝对 node_modules 下的 .ts 做类型擦除
import { createDocument } from '@liteoffice/core';
```

- `packages/<a>/src/*` → `packages/<b>/src/index.ts` 用 `../../<b>/src/index.ts`
- `apps/web/src/*` → `packages/<b>/src/index.ts` 用 `../../../../packages/<b>/src/index.ts`
- 包内的相对导入也要带 `.ts`：`./styles.ts`
- `tools/build.mjs` 会自动把 `.ts` 改写成 `.js` 供浏览器使用，**不要手写 `.js`**

分离类型导入（`verbatimModuleSyntax` 已开启）：

```ts
import type { Block, Paragraph } from '../../core/src/model.ts';   // 只导入类型
import { createDocument } from '../../core/src/index.ts';          // 导入值
```

## 4. 单位：模型内一律 pt

- 模型里**所有长度都是 pt**（1pt = 1/72 英寸）。
- 换算函数在 `packages/core/src/units.ts`：`twipToPt`、`emuToPt`、`halfPtToPt`、`pxToPt`、`ptToPx`、`excelColWidthToPt` …
- **读取器必须在边界处完成换算**，不要把 twip / EMU / px 漏进模型。
- px 只允许出现在 DOM 渲染的最后一步（`ptToPx`）。

## 5. 读取器的硬要求

实现 `FormatReader`（见 `packages/core/src/registry.ts`）并**在模块顶层调用 `registerReader()`** 自注册。

必须做到：

1. **绝不因为某个不支持的子特性而抛错。** 遇到不认识的元素/属性就跳过，并把说明写进 `stats.warnings`。目标是「能打开」优先于「完美还原」。
2. **超限时降级并记录。** 用 `ctx.guard.probe('maxCells', n)` 之类的调用；被截断的资源名要进 `stats.truncated`。绝不静默丢内容。
3. **如实报告统计。** `stats.parseMs`、`stats.modelBytes`（用 `estimateBytes`）、`blockCount` / `cellCount` / `shapeCount` / `imageCount`。
4. **低内存优先。** 大表用 `LazyGrid`（`packages/core/src/grid.ts`）按窗口惰性取行，不要物化整表；大 XML 用 `XmlPullParser` 的事件流 + `skipElement()`，不要先建 DOM。
5. **遵守 `limits.maxPartBytes`。** 部件解压后超过此值时走流式扫描路径（`ctx.container().streamText()`），不要 `read()` 整块。

## 6. 失败要讲人话

- 抛错时用 `ReadError`（`packages/core/src/registry.ts`）并给出合适的 `code`：`NO_READER` / `TOO_LARGE` / `ENCRYPTED` / `CORRUPT` / `LEGACY_BINARY`。
- 不要把底层异常直接抛给 UI；`explainReadError()` 负责转成人话。

## 7. 测试

- 测试文件放 `test/*.test.ts`，命名 `<主题>.test.ts`。
- 运行：`node tools/test.mjs`（全部）或 `node tools/test.mjs <过滤词>`。
- **不要用 `node --test`**：它会 spawn 子进程并通过管道收输出，在受限环境下会被拒绝。`tools/test.mjs` 改为同进程加载。
- 测试之间**不得依赖全局可变状态**（注册表除外，它只增不改）。
- 优先用**自研写入器造夹具**（`ZipWriter`，见 `test` 目录现有用例），这样测试不依赖外部文件。
- 工作区 `C:\deepseekharness` 里有真实 Word 生成的 `.docx` 可作交叉验证：
  `二极管伏安特性实验报告.docx`、`实验报告-1N4001伏安特性.docx`、`testF_del25.docx` 等。
  这类用例在文件不存在时应当 `t.skip()` 而不是失败。
- **文件存在但内容读不出**（云盘「仅在线」占位文件、权限问题）时也应 `t.skip()` 并写明原因，
  不要判失败 —— 那是环境问题，不是被测代码的问题。实测本机有 4 个 WPS 云盘占位文件读不出内容。

### 性能断言不要放在测试套件里

本项目只能单进程跑测试，前面文件留下的垃圾会污染后面文件里的堆断言
（实测一条大文件压力测试单独跑通过、全量跑失败）。`tools/test.mjs` 现在在文件之间调
`globalThis.gc()` 缓解，但**权威的内存/性能口径在 `bench/`** —— 它是独立进程、先写盘再读盘，
能隔离测量。测试里若要保留内存断言，必须：解析前后各强制 GC、断言相对比值而非绝对字节、
拿不到 GC 时用 `t.diagnostic()` 跳过而不是硬失败。

### ⚠️ 在 `node:test` 里 `await` 特别贵（实测约 14µs/次）

这是本项目踩过的一个大坑，写异步读取器的人一定会遇到：

| 环境 | 单次 `await` 开销 |
|---|---|
| 普通 Node 进程 | 约 1 µs |
| `node:test` 内（async hooks 生效） | **约 14 µs** |

后果：一个每事件 4~6 次 `await` 的流式扫描器，同一份 5 万行表在测试里跑 **49 秒**、
独立进程只要 **2.4 秒** —— 差 19 倍。排查时会误以为「实现有性能问题」，
实际是测试环境的 async hook 开销。

应对：
1. 热点循环里**不要每次迭代都 await**。改成「同步 `tryNextSync()` + 只在需要补料时 `await` 一次」。
2. `skipElement()` 之类的跳跃操作用字符级深度扫描，不要靠事件级 while 循环。
3. **如果测试里莫名很慢，先数一数热点路径上的 `await` 次数**，再怀疑算法。
   本项目据此把 xlsx 的大表用例从 105 秒降到 3.3 秒。

### 对自闭合元素用「遍历子元素」会吞掉兄弟节点

`<patternFill/>`、`<left/>` 这类自闭合元素没有子节点。若用「进入元素 → 遍历子元素」的写法，
下一次 `next()` 拿到的就是**下一个兄弟**，于是它被当成子元素消费掉 ——
表现为填充/边框/样式**随机丢失**，而且极难定位。

`skipElement()` 已在解析器层做成「对自闭合元素安全 no-op」，但**遍历子元素的循环仍要自己守卫**：
```ts
if (e.selfClosing) { /* 没有子节点，直接处理属性，不要进入遍历 */ continue; }
```
更稳的做法是把守卫下沉进辅助函数（如 `eachChild(p, parent, cb)`），
而不是依赖每个调用点都记得写 —— 靠人记的守卫一定会漏。

## 8. 代码风格

- 注释用中文；解释**为什么**这么做，而不是复述代码在做什么。
- 遇到反直觉的实现，把踩过的坑写进注释（例如「早期版本这样做导致 X」）。
- 不要写 `console.log` 作为调试残留；测试里的诊断输出可以保留，但要有信息量。
- 优先小函数 + 早返回；避免深层嵌套。

## 9. 提交前自检

```powershell
cd C:\deepseekharness\liteoffice
node tools/lint.mjs          # 硬约束巡检：可擦除语法、相对路径导入、零依赖
node tools/build.mjs         # 必须无错（验证语法可被擦除）
node tools/test.mjs          # 全部测试必须通过，退出码 0
```

`tools/lint.mjs` 专抓两类最容易出事、且报错信息最晦涩的问题：

- **不可擦除语法**（`enum`、构造函数参数属性、`namespace`、`declare`、装饰器）
  Node 只在真正执行到那个文件时才报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，
  而且信息是「TypeScript parameter property is not supported in strip-only mode」这种，
  排查成本高。lint 提前拦住并直接给出改法。
- **裸包名导入**（`@liteoffice/xxx`）与**忘了写 `.ts` 后缀的相对导入**

一次完整的验证（含基准）：

```powershell
node tools/lint.mjs; node tools/build.mjs; node tools/test.mjs; node --expose-gc bench/bench.mjs
```

> 读源码文件请用编辑器的读取能力（或 `read` 工具），**不要用 PowerShell 的 `Get-Content`**：
> 本机默认文件编码不是 UTF-8，会把中文注释显示成乱码，看起来像文件损坏但其实是显示假象。
>
> ⚠️ **更危险的是写文件**：`Get-Content -Raw | Set-Content` 会把中文**真正毁掉**
> （读入按 GBK 解码、写出按 UTF-8 编码，一次往返即不可逆损坏），
> 之后 Node 加载该文件会抛一个指向文件但不说明原因的 SyntaxError。
> 本仓库已经因此损坏过两个文件。**改动含中文的文件只用编辑工具，不要用 shell 管道做文本替换。**
> `tools/lint.mjs` 现在会检出非法 UTF-8 文件。
