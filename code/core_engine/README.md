# LiteOffice · 轻办公

**开源、零依赖、低内存的多格式文档平台。**
把「打开一个文件看看里面是什么」这件事做成秒级、可预期、不占内存。

```powershell
cd C:\deepseekharness\liteoffice
node tools/serve.mjs
# 浏览器打开 http://127.0.0.1:5180/apps/web/
```

或者**双击 `start-liteoffice.cmd`** —— 它会自动构建、起服务、并打开浏览器
（脚本内容刻意只用 ASCII：Windows 的 cmd.exe 按当前 OEM 代码页读取批处理文件，
写中文在部分机器上会变乱码）。

不需要 `npm install`。**这个仓库里没有也不会有 `node_modules`。**

### 想发给别人用 / 部署上线？

LiteOffice 是纯前端，没有后端。**别人不需要拿到这个文件夹** —— 给它一个网址就行：

```powershell
node tools/dist.mjs --verify    # 生成 dist/（103 个文件、约 1.3 MB、不含 .ts 源码）
```

然后把 `dist/` 整个拖到 [Netlify Drop](https://app.netlify.com/drop)，或上传到 GitHub Pages
等任何静态托管。`--verify` 会先把整个模块图爬一遍（98 个资源必须全 200）再宣告成功 ——
这一步能挡住「本地能跑、上线就白屏」这类问题。

同局域网临时分享、GitHub Pages 具体操作、装 git、以及**为什么入口必须用相对路径**，
都写在 [部署指南](docs/DEPLOY.md)。

---

## 现在到什么程度了

| 指标 | 实测 |
|---|---|
| 测试 | **363 / 364 通过，0 失败**（1 个跳过：本机某 pptx 是云盘占位文件、内容读不出） |
| 真实文件回归 | **139 个真实文件 → 支持的 122 个全部打开（100%）**，平均约 20 ms |
| 覆盖格式 | **29 种**（另 3 种旧版二进制只识别并提示） |
| 依赖 | **0 个**（11 个 package.json 全无 dependencies，无 node_modules） |
| 内存 | 100 万单元格工作簿 → 模型 **1.9 KiB**；关闭文档后内存**回到基线**（泄漏斜率 2 KB/次） |
| Web 壳 | 从入口爬取整个模块图 **98 个资源 200、0 个 404** |

全部可复现命令与证据见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。
**本轮是只读渲染 —— 不能编辑、不能导出**，这是与 WPS 最大的差距，见 [路线图](docs/ROADMAP.md)。

---

## 它解决什么问题

| 痛点 | LiteOffice 的做法 |
|---|---|
| 办公软件功能臃肿、启动慢 | 功能即模块：不导入 PDF 读取器，产物里就没有 PDF 解析器 |
| 打开大文件内存暴涨、关掉不回落 | 容器只索引不解压、事件流解析、惰性网格、DOM 虚拟化、显式 `dispose()` |
| 格式支持窄（ODF / Markdown / CSV / 扁平 ODF 常打不开） | 格式写在一张数据表里，新增格式自动获得全部视图能力 |
| 旧格式只报「不支持」 | 认得出 `.doc/.xls/.ppt` 并给「请另存为 docx」的人话提示 |

详见 [为什么轻](docs/WHY-LIGHT.md)。**那里也有一份明确的「还没做到」清单** —— 包括「不能编辑」。

---

## 核心设计

**所有格式先归一到一个模型，所有视图只读这个模型。**

```
M 种格式 × N 种视图  →  M + N
```

新增格式不必碰渲染层，新增视图自动支持全部格式。
完整说明见 [架构文档](docs/ARCHITECTURE.md)。

---

## 仓库结构

```
packages/
  core/          UDM 统一文档模型、格式表、资源上限、内存记账   ← 零依赖契约层
  zip/           流式 ZIP 读写（原生 DecompressionStream）
  xml/           低分配流式 XML 拉取解析器
  ooxml/         OPC 包结构、Word 样式/编号、主题色
  engine/        格式嗅探与打开编排
  format-text/   txt md csv tsv json html xml rtf log
  format-docx/   docx docm dotx
  format-xlsx/   xlsx xlsm
  format-odf/    odt ott ods ots odp otp odg fodt fods fodp
  format-pptx/   pptx pptm
  format-pdf/    pdf
  render-dom/    四种虚拟化渲染器（文字 / 表格 / 演示 / PDF）
apps/
  web/           Web 壳（零框架，原生 DOM）
  desktop/       桌面壳（Tauri 方案，见 docs/DESKTOP.md）
tools/           build / serve / test —— 全部零依赖
bench/           内存与性能基准
docs/            架构、约定、格式矩阵、路线图
```

---

## 命令

```powershell
node tools/build.mjs          # 类型擦除构建到 build/（浏览器用）
node tools/serve.mjs          # 起开发服务器（默认 127.0.0.1:5180）
node tools/test.mjs           # 跑全部测试
node tools/test.mjs format    # 只跑名字含 "format" 的测试文件
node --expose-gc bench/bench.mjs   # 内存/性能基准 → bench/out/BENCHMARKS.md
```

全部零依赖。`tools/build.mjs` 用 Node 内置的 `module.stripTypeScriptTypes()`
把 `.ts` 擦成原生 ESM，**没有 tsc、没有 esbuild、没有 vite、没有打包器**。

---

## 支持的格式

OOXML（`docx` `docm` `dotx` `xlsx` `xlsm` `pptx` `pptm` …）、
ODF（`odt` `ods` `odp` `odg` 及扁平变体 `fodt` `fods` `fodp`）、
`pdf`、`md` `txt` `log` `csv` `tsv` `json` `html` `xml` `svg` `rtf` `epub`，
以及旧版二进制 `doc` `xls` `ppt` 的**识别与提示**。

- 逐格式的实时支持矩阵：[docs/FORMAT-MATRIX.md](docs/FORMAT-MATRIX.md)（由运行时注册表生成，不会与代码脱节）
- 设计与「如何新增一种格式」：[docs/FORMATS.md](docs/FORMATS.md)
- **实测内存/性能数字与测量方法学**：[docs/MEASUREMENTS.md](docs/MEASUREMENTS.md)
- **可复现的验证证据**（命令、通过率、真实文件回归、已修缺陷清单）：[docs/VERIFICATION.md](docs/VERIFICATION.md)

> 当前状态：**129 个真实文件里支持格式的 112 个全部能打开（100%）**。
> 测试 344/363 通过，剩余失败集中在 `pptx`（8）与 `pdf`（12）两个包的细节算子。
> `svg` / `epub` 已登记但未安装读取器（UI 会如实显示「未安装读取器」）。
> 本轮是**只读渲染**，不能编辑、不能导出。

---

## 工程约束（改代码前请读）

本项目有几条**硬约束**，违反任何一条代码就跑不起来：

1. **零依赖。** 不引入 typescript / esbuild / vite / jest / JSZip / xmldom / pdfjs。
2. **只能用可擦除的 TypeScript 语法。** 禁止 `enum`、构造函数参数属性、`namespace`、装饰器
   —— 代码经 strip-only 擦除后直接在浏览器运行。
3. **跨包导入用相对路径带 `.ts` 后缀**（`../../core/src/index.ts`），不能用裸包名。
4. **模型内长度单位一律 pt**，px 只出现在 DOM 渲染最后一步。
5. **读取器绝不因为某个子特性不支持而抛错** —— 降级并写 `stats.warnings`；
   截断写 `stats.truncated`。能打开 > 完美还原 > 严格校验。

完整说明与原因见 [docs/CONVENTIONS.md](docs/CONVENTIONS.md)。

---

## 许可

MIT。见 [LICENSE](LICENSE)。

若你打算基于它做产品，建议考虑 Apache-2.0（含专利授权）或 MPL-2.0（文件级 copyleft，
LibreOffice 即采用此许可）—— 更换只需替换 `LICENSE` 文件并在 `package.json` 里改 `license` 字段。
