# LiteOffice 架构

## 一句话

**所有格式先归一到一个模型，所有视图只读这个模型。**

传统做法是「每种格式配一个查看器」，于是 M 种格式 × N 种视图 = M×N 份实现。
LiteOffice 把它压成 **M + N**。

```
        ┌──────────────────────────────────────────────┐
        │  格式读取器（M 个，互不认识）                  │
        │  format-text  format-docx  format-xlsx       │
        │  format-odf   format-pptx  format-pdf        │
        └───────────────────┬──────────────────────────┘
                            │  都产出同一种东西
                            ▼
        ┌──────────────────────────────────────────────┐
        │      UDM  统一文档模型（@liteoffice/core）     │
        │  blocks │ sheets │ slides │ pages │ meta     │
        └───────────────────┬──────────────────────────┘
                            │  都只读这一种东西
                            ▼
        ┌──────────────────────────────────────────────┐
        │  渲染器（N 个，不认识任何文件格式）             │
        │  reflow   grid   slides   pdf                │
        └──────────────────────────────────────────────┘
```

收益是具体的：
- 新增格式（比如 `.numbers`）→ 自动获得全部视图能力，不需要碰渲染层
- 新增视图（比如分页打印预览、投屏模式）→ 自动支持全部格式
- 「不支持某格式」变成一个**可安装的模块**问题，而不是一个功能裁剪问题

---

## 分层

| 层 | 包 | 依赖 | 职责 |
|---|---|---|---|
| 基础设施 | `@liteoffice/zip` | 无 | 流式 ZIP 容器读写（原生 `CompressionStream`） |
| 基础设施 | `@liteoffice/xml` | 无 | 低分配流式 XML 拉取解析器 |
| **契约层** | `@liteoffice/core` | **无** | UDM 类型、格式表、资源上限、内存记账、Grid 抽象、读取器注册表 |
| 领域共用 | `@liteoffice/ooxml` | core, xml | OPC 包结构、关系解析、Word 样式/编号、主题色 |
| 编排 | `@liteoffice/engine` | core, zip | 格式嗅探、打开流程、阶段计时、错误人话化 |
| 格式 | `format-text` `format-docx` `format-xlsx` `format-odf` `format-pptx` `format-pdf` | core, xml, zip, ooxml | 各自把一种格式读成 UDM，**自注册**进注册表 |
| 视图 | `render-dom` | core | 渲染器（虚拟化） |
| 外壳 | `apps/web` / `apps/desktop` | 全部 | 用户界面 |

**依赖只向下，永不向上。** `core` 不 import 任何格式包、不 import zip。
格式包通过 `registerReader()` 自注册，因此「支持哪些格式」由**导入什么**决定 ——
不用 PDF 就不必付 PDF 解析器的体积与内存代价。

### 为什么 `core` 坚持零依赖

`core` 里有 `ContainerAccess` 接口，但**故意不 import `@liteoffice/zip`**。
`ZipReader` 结构上直接满足该接口（它提供了 `entryNames` / `entrySize` / `has` / `read` / `text` / `stream` / `streamText`），
所以不需要适配层，也不需要 core 依赖 zip。这是用鸭子类型换来的分层干净。

---

## 三条低内存主线

「省内存」不是一句口号，它落实为三个可验证的机制。

### 1. 容器层：峰值内存与「单个部件」同阶，而非与「整个文档」同阶

`ZipReader.open()` **只扫描文件尾部的中央目录**，复杂度是 O(条目数) 而不是 O(文件体积)；
条目数据始终以 `subarray` 视图存在，不复制；
解压走原生 `DecompressionStream`，**逐块产出**。

对比：JSZip 之类的库会把整个压缩包读进内存并保留全部中间结构，
打开一个 20 MB 的 xlsx 常驻内存可达数百 MB。

```ts
const zip = ZipReader.open(bytes);        // 只解析目录
for await (const chunk of zip.streamText('xl/worksheets/sheet1.xml')) {
  // 边读边丢，50 MB 的 sheet XML 不需要 50 MB 常驻
}
```

### 2. 解析层：事件流 + 跳子树，从不建节点树

`XmlPullParser` 是拉取式解析器：
- 字节输入按块解码，**已消费的窗口随时丢弃**，缓冲区维持在块大小量级
- `skipElement()` 用深度计数跳过整棵子树，**跳过期间不分配任何事件对象**
- 因此遍历一个 10 万行的 `sheet1.xml`，代价是线性扫描字符，而不是 10 万个对象

对比：`DOMParser` / xmldom 会为每个节点建对象，且必须先把整个文档驻留成字符串。

### 3. 模型层：惰性网格 + 共享样式表

`Sheet` 实现 `Grid` 接口，`readRows(start, end)` 是**异步**的，实现可以选择
「重新流式扫描源 XML 只取这一段」：

```ts
// 小表：直接物化，快
new MaterializedGrid(rows, rowCount, colCount)

// 大表：只保留「怎么再读一次」，带 600 行 LRU 缓存
new LazyGrid({ rowCount, colCount, fetch: (s, e) => rescanSheet(s, e) })
```

这带来一个关键性质：**峰值内存与可视窗口大小同阶，与全表行数无关**。
浏览 50 万行的表，内存代价和浏览 500 行是一样的。

另外，单元格样式用**索引共享**（`Cell.s` 指向 `Sheet.styles`），
而不是每格挂一个样式对象 —— 一百万个单元格就是一百万次对象分配的区别。

---

## 数据流：打开一个文件的完整路径

```
字节
 │
 ├─ 1. 尺寸与上限检查        超过 limits.maxFileBytes 直接拒绝（不读取）
 │
 ├─ 2. 嗅探（只看文件头 64 KiB）
 │     魔数 → ZIP 内部结构 → 文本启发式 → 扩展名兜底
 │     └─ ZIP 家族需要容器，此时才 open()，非 zip 文件永不付这个代价
 │
 ├─ 3. 派发到读取器          注册表查 FormatId → FormatReader
 │     未安装读取器 → ReadError('NO_READER') + 格式名（UI 可提示装哪个包）
 │
 ├─ 4. 读取器产出 UDM        各阶段耗时落进 stats.phases
 │
 └─ 5. 收尾                  补全 stats（源大小/耗时/模型估算/警告/截断）
```

**嗅探不靠扩展名。** 判定顺序是「内容优先，扩展名兜底」，因为：
用户会把 `.docx` 改名成 `.zip`、把 CSV 存成 `.txt`、把 ODF 存成 `.docx`。
只看扩展名会派发错读取器并给出莫名其妙的错误。

---

## 错误处理哲学

**能打开 > 完美还原 > 严格校验。**

- 读取器**绝不因为某个不支持的子特性而抛错**。遇到不认识的结构就跳过，
  把说明写进 `stats.warnings`。
- 超出上限就**降级并记录**，被截断的资源名进 `stats.truncated`。
  UI 必须把截断显眼地告诉用户 —— 静默丢内容比打不开更糟。
- 底层异常统一包成 `ReadError`，由 `explainReadError()` 转成人话。

这条哲学的直接后果：一个结构畸形但内容可读的文件，LiteOffice 会打开它并告诉你哪里降级了，
而不是弹一个「文件已损坏」。

---

## 零依赖是怎么做到的

本项目的硬约束是**零运行时依赖、零安装**。为此我们不用现成的库，而是用平台内置能力：

| 需求 | 常规做法 | LiteOffice 的做法 |
|---|---|---|
| ZIP 解压 | JSZip | 原生 `DecompressionStream('deflate-raw')` |
| ZIP 压缩 | JSZip | 原生 `CompressionStream('deflate-raw')` |
| XML 解析 | xmldom / DOMParser | 自研 `XmlPullParser` |
| PDF 解析 | pdf.js | 自研（文本 + 基础图形提取） |
| TypeScript 编译 | tsc / esbuild / vite | Node 内置 `module.stripTypeScriptTypes()` |
| 打包 | rollup / webpack | 不需要 —— 类型擦除后就是原生 ESM |
| 测试 | jest / vitest | `node:test` |
| 依赖管理 | npm / pnpm | 不需要 —— 跨包导入用相对路径 |

### 两个由此产生的硬约束

**① 只能用「可擦除」的 TypeScript 语法。**
代码经 strip-only 擦除后直接在浏览器运行，因此禁止 `enum`、构造函数参数属性、
`namespace`、装饰器。`tsconfig.json` 的 `erasableSyntaxOnly: true` 会兜住这条。

**② 跨包导入必须用相对路径带 `.ts` 后缀。**

```ts
// 正确
import { createDocument } from '../../core/src/index.ts';

// 错误 —— Node 拒绝对经 node_modules 解析的 .ts 做类型擦除
import { createDocument } from '@liteoffice/core';
```

这条是实测得出的：Node 的检查基于**解析后的 URL**而不是 realpath，
所以即使用 junction 把 `packages/core` 链到 `node_modules/@liteoffice/core`，
也会报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。

改用相对路径后有一个意外收获：**`node_modules`、包链接脚本、import map 全部消失了**。
同一份相对说明符在 Node、浏览器、构建产物里都成立，构建脚本因此只有 40 行。

---

## 双壳设计（Web 先行，桌面后补）

`apps/desktop` 与 `apps/web` **共享同一个内核**（core + engine + 全部格式包）。
外壳之间的差异被收敛到一个薄的适配层：

| 能力 | Web 壳 | 桌面壳（Tauri/Rust） |
|---|---|---|
| 读文件 | `File` / `Blob` + File System Access API | 直接读路径 |
| 写文件 | File System Access API / 下载 | 直接写路径 |
| 字体 | 系统字体（受浏览器沙箱限制） | 可枚举并嵌入系统字体 |
| 内存上限 | 标签页受浏览器限制 | 进程可控 |

`openDocument()` 的输入已经抽象成 `OpenInput`（`bytes` 或 `blob`），
桌面壳只需多提供一条「按路径惰性读」的实现即可。详见 `DESKTOP.md`。

---

## 目录

```
liteoffice/
├── packages/
│   ├── core/            UDM、格式表、上限、内存记账、Grid、注册表   ← 零依赖契约层
│   ├── zip/             流式 ZIP 读写
│   ├── xml/             流式 XML 拉取解析器
│   ├── ooxml/           OPC 包结构 / Word 样式编号 / 主题色
│   ├── engine/          嗅探 + 打开编排
│   ├── format-text/     txt md csv tsv json html xml rtf log
│   ├── format-docx/     docx docm dotx
│   ├── format-xlsx/     xlsx xlsm
│   ├── format-odf/      odt ods odp odg fodt fods fodp
│   ├── format-pptx/     pptx pptm
│   ├── format-pdf/      pdf
│   └── render-dom/      四种虚拟化渲染器
├── apps/
│   ├── web/             Web 壳（零框架，原生 DOM）
│   └── desktop/         桌面壳（设计 + 待构建，见 DESKTOP.md）
├── tools/               全部零依赖的开发工具（见下表）
├── bench/               内存与性能基准
│   ├── bench.mjs        基准主程序
│   └── fixtures.ts      按 ECMA-376 / ODF 规范**独立实现**的大文件生成器
├── test/                同进程测试（含交叉验证）
└── docs/                本目录
```

### 工具链一览

这些脚本本身也是交付物：没有它们，「省内存」就只能靠嘴说。

| 工具 | 作用 |
|---|---|
| `tools/build.mjs` | 类型擦除构建到 `build/`。**先全部编译到内存再统一落盘** —— 失败时不会留下半新半旧的产物 |
| `tools/serve.mjs` | 零依赖静态服务器（正确 MIME、no-store、路径穿越防护） |
| `tools/test.mjs` | 同进程测试运行器。逐个文件 try/catch，**加载失败会单独汇总并显式告知「通过数不包含它们」** |
| `tools/lint.mjs` | 硬约束巡检：可擦除语法、相对导入存在性、浏览器侧 `node:` 静态导入、注释误闭合、**非法 UTF-8** |
| `tools/load-readers.mjs` | 三个工具共用的读取器加载逻辑（避免同一个 bug 存在于三处） |
| `bench/bench.mjs` | 单文档代价 + 泄漏检查（回归斜率） + 合成夹具 |
| `tools/validate.mjs` | 真实文件回归集：成功率、失败原因聚类、**降级清单** |
| `tools/status.mjs` | 从运行时注册表生成格式矩阵，**不可能与代码脱节** |
| `tools/verify-web.mjs` | 沿真实 import 图爬取整个 Web 产物，查 404 与静态 `node:` 导入（构建阶段看不见的盲区） |

其中 `tools/lint.mjs` 抓的都是「构建查不出、只有运行时才炸」的问题。实测它已经抓到过：
裸包名导入、`.js` 后缀写进源码、导入指向已改名的文件、跨包导入上溯层数算错、
浏览器侧静态导入 `node:fs`、块注释被 `*/` 提前闭合（踩了四次）、文件不是合法 UTF-8。

## 相关文档

- [工程约定](CONVENTIONS.md) —— 动手前必读的硬约束
- [验证证据](VERIFICATION.md) —— 可复现的命令、通过率、真实文件回归、已修缺陷清单
- [实测数据](MEASUREMENTS.md) —— 内存/性能数字与测量方法学（含读数字时必须知道的限制）
- [为什么轻](WHY-LIGHT.md) —— 与 WPS 痛点的逐条对照
- [格式支持](FORMATS.md) —— 支持矩阵与「如何新增一种格式」
- [格式矩阵](FORMAT-MATRIX.md) —— 由运行时注册表生成的逐格式状态（自动维护）
- [路线图](ROADMAP.md)
- [桌面壳设计](DESKTOP.md)
