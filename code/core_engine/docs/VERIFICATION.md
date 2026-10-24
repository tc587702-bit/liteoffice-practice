# 验证证据

本文件汇总 LiteOffice 的**可复现验证结果**。所有数字都能用下面这几条命令重跑出来：

```powershell
cd C:\deepseekharness\liteoffice

node tools/lint.mjs                    # 硬约束巡检
node tools/build.mjs                   # 零依赖构建（产物为原生 ESM）
node tools/test.mjs                    # 全量测试（同进程，363 个用例）
node --expose-gc bench/bench.mjs       # 内存/性能基准 → bench/out/BENCHMARKS.md
node tools/validate.mjs                # 真实文件回归 → bench/out/VALIDATION.md
node tools/status.mjs --write          # 重新生成格式矩阵 → docs/FORMAT-MATRIX.md
node tools/serve.mjs                   # 起服务后打开 http://127.0.0.1:5180/apps/web/
```

**整个仓库零运行时依赖**：没有 `node_modules`，没有 `package-lock.json`，
`pnpm`/`npm install` 都不需要。构建用的是 Node 内置的 `module.stripTypeScriptTypes()`。

---

## 一、当前测试结果

`node tools/test.mjs` → **364 个用例，363 通过，0 失败，1 跳过**

| 测试文件 | 覆盖对象 | 结果 |
|---|---|---|
| `core.test.ts` | 单位换算、格式表、资源上限、内存记账、Grid、模型辅助 | **25 / 0** |
| `ooxml.test.ts` | OPC 路径、关系、内容类型、Word 样式继承、编号、主题色 | **10 / 0** |
| `sniff.test.ts` | 嗅探判定（含 12 个真实文件） | **8 / 0** |
| `xml.test.ts` | 拉取解析器（含跨块边界、两个 skipElement 回归） | **22 / 0** |
| `zip.test.ts` | ZIP 读写（含真实 .docx） | **3 / 0** |
| `cross-validation.test.ts` | **独立生成器 ↔ 各读取器交叉验证** | **11 / 0** |
| `format-text.test.ts` | txt/md/csv/tsv/json/html/xml/rtf | **65 / 0** |
| `format-docx.test.ts` | docx（自造夹具 + 11 个真实文件） | **25 / 0** |
| `format-odf.test.ts` | odt/ods/odp/odg/fodt/fods/fodp | **16 / 0** |
| `format-xlsx.test.ts` | xlsx（含 100 万单元格合成夹具） | **38 / 0** |
| `format-pptx.test.ts` | pptx | **35 / 0**（+1 跳过） |
| `format-pdf.test.ts` | pdf | **53 / 0** |
| `render-layout.test.ts` | 纯布局数学（可见区间、偏移表、合并、y 翻转） | **26 / 0** |
| `render-dom.test.ts` | 渲染器 + DOM 桩（虚拟化实测） | **19 / 0** |
| `render-web.test.ts` | Web 壳（状态栏、格式面板、错误人话化、导入可解析性） | **10 / 0** |
| `integration.test.ts` | **真实文件 → 解析 → 渲染，端到端** | **7 / 0** |

**全部 16 个测试文件全绿，0 失败。**

唯一跳过的一条是 `真实 pptx：示例-成果汇报.pptx` —— 那个文件在本机是**云盘「仅在线」占位文件**，
`readFileSync` 读不出内容。测试正确地 `t.skip()` 并写明了原因，而不是假装通过。

---

## 二、三条最有力的证据

### 证据 1：端到端集成测试 7/7 —— 真实文件能解析且能渲染

`test/integration.test.ts` 用**真实第三方文件**走完「嗅探 → 读取器 → UDM → 渲染」全链路：

```
[集成] docx  753 KiB  kind=text   模型  967 KiB  节点 13  文本 123 字   79 ms
[集成] xlsx   12 KiB  kind=sheet  模型   53 KiB  节点  6  文本  18 字   30 ms
[集成] pptx  472 KiB  kind=slides 模型    7 KiB  节点 25  文本  12 字   58 ms
[集成] pdf    70 KiB  kind=pdf    ...（含在 7/7 通过内）
[集成] 3000 段文档 -> 节点 53，可视文本 941 字        ← 虚拟化生效
[集成] 滚到第 1500 段 -> 节点 55，可视文本 1040 字
```

它还断言了架构主张本身：
- 四种文档类别（文字/表格/演示/PDF）共用**同一个** `createViewer()` 入口
- 3000 段文档只创建 **53** 个 DOM 节点（修虚拟化 bug 之前是 **6003** 个）
- 未安装读取器的格式给出「未安装」而不是崩溃

### 证据 2：交叉验证 11/11 —— 两个独立实现互相认可

`bench/fixtures.ts` 是照 ECMA-376 / ODF 规范**独立写**的大文件生成器，
与任何读取器、任何读取器的测试夹具**没有共享代码**。

于是「我的生成器造出的文件能被读取器正确解析」构成真正的交叉验证 ——
如果任意一边对规范的理解有偏差，这里就会红。这是本项目发现「自测全过、真实文件全挂」
这类问题的机制（PDF 早期就栽在这上面）。

断言落在可观察的结构事实上，例如：
- xlsx：`A1` 解出共享字符串「编号」而不是索引数字、`C2` 的公式含 `SUM`、
  第 7 行前 3 列确实缺失（稀疏）、43 个单元格只共享 ≤4 个样式索引
- docx：有序列表标记真的递增（`1.` `2.` `3.`，不是全 `1.`）、
  「加粗」run 的 `style.bold === true` 而未显式加粗的普通文本不被误标、
  页边距 1440 twip → 72pt
- odt：`text:s text:c="3"` 展开成 3 个空格、加粗 run 文本「加粗蓝色」且 color 为 `#0000ff`、
  `table:number-columns-repeated="16380"` **不许造出上万个单元格对象**
- csv：`"含,逗号的值"` 不分割列、`""` 还原为一个引号、引号内换行不断行

### 证据 3：真实文件回归 122/122 —— 支持的格式 100% 能打开

```
尝试 139 个（跳过 1 个）
打开成功 122   真失败 0   成功率 100.0%
按设计的拒绝 17 个（旧版二进制 16 + 加密 1）
有降级告警 57 个（打开了但丢了内容）
源文件合计 88.6 MiB  ->  模型合计 17.6 MiB
平均解析耗时 约 20 ms
```

按格式：docx **103/103**、pdf **8/8**（另 1 个加密）、xlsx **6/6**、pptx **4/4**、html 1/1。
详见 [MEASUREMENTS.md](MEASUREMENTS.md) 与 `bench/out/VALIDATION.md`。

---

## 三、内存证据

### 大表不物化：100 万单元格 → 模型 1.8 KiB

由独立生成器造的 50,000 行 × 20 列工作簿（源 6.6 MiB）：

```
模型估算 1.8 KiB (0.0%)   堆增量 10.4 MiB   耗时 393 ms
```

`Sheet` 只持有「怎么再读一次」的方法与 600 行 LRU 缓存，表体从未被物化；
`readRows(任意窗口)` 都能取到正确数据（交叉验证里断言了第 25,000 行附近的窗口内容）。

### 泄漏检查通过：关闭文档内存真的会回落

```
文件：我的暑假游玩经历.pptx    次数：15 次打开 + dispose
残留  首次 532.3 KiB / 末次 372.8 KiB / 最大 532.3 KiB
斜率  7,595 B/次   ->  ✅ 未检出累积泄漏（判据 >64 KiB/次 为可疑）
```

这一条对应的正是「办公软件用久了内存持续上涨」的现象。末次残留**低于**首次，说明无累积。

完整方法与限制见 [MEASUREMENTS.md](MEASUREMENTS.md)。

---

## 四、Web 壳可加载性

### 4.1 整模块图爬取（`node tools/verify-web.mjs`）

单点 curl 首页**不足以**说明浏览器不会白屏 —— 真正的风险在模块图深处。
`verify-web.mjs` 起一个临时服务，从 `/apps/web/` 出发**沿着真实 import 图爬**：

```
[verify-web] 从 /apps/web/ 出发爬取模块图：98 个资源 200，0 个失败，耗时 234 ms
[verify-web] 惰性 node: 导入 2 个（安全 —— 只在 Node 专用分支里执行）：node:fs/promises, node:path
[verify-web] ✔ 模块图完整可达，且无静态 node: 导入 —— 浏览器加载不会白屏
```

它做三件**构建阶段查不出来**的事：

1. **每个资源的相对导入在产物里是否真的存在** —— `tools/build.mjs` 只做类型擦除，
   不解析导入，所以写错的相对路径能顺利构建、然后让浏览器白屏（已踩过两次）
2. **区分静态与动态 `node:` 导入** —— 静态的会白屏，动态的（只在 Node 分支执行）是安全的。
   不区分的话工具会把安全的惰性导入也报成错误，最终没人信它
3. **裸模块说明符** —— 本架构没有 import map、也没有 node_modules，裸说明符必然解析失败

> 这个工具本身做过自测：故意在 `apps/web/src/main.ts` 里加
> `import { readFileSync } from 'node:fs'`，工具以退出码 1 报出
> 「1 处**静态**导入 node: 模块（浏览器会直接白屏）：node:fs」，随后移除。

### 4.2 关键资源逐项状态

```
200   6035 B  text/html      /apps/web/
200  17942 B  text/css       /apps/web/styles.css
200   1736 B  text/javascript /build/apps/web/src/main.js
200  32201 B  text/javascript /build/apps/web/src/app.js
200   9661 B  text/javascript /build/apps/web/src/format-registry.js
200    459 B  text/javascript /build/packages/core/src/index.js
200   7999 B  text/javascript /build/packages/engine/src/open.js
200   1577 B  text/javascript /build/packages/render-dom/src/index.js
...（各 format-* 包的产物同样 200）
```

`index.html` 引用 `/build/apps/web/src/main.js`（绝对路径，因为 html 在 `apps/web/` 而产物在 `build/`），
且**没有 import map** —— 类型擦除后就是原生 ESM，不需要它。

---

## 五、验证过程中发现并修掉的真实缺陷

这一节比测试通过率更能说明工程质量：下面每一条都是「测试/真实文件暴露出来的真 bug」，
而不是走一遍流程。

| # | 缺陷 | 后果 | 发现方式 |
|---|---|---|---|
| 1 | `skipElement()` 跳过完成时多吞一个事件 | 真实 docx **静默丢 20/164 个样式、4/9 个编号定义** | 真实文件测试 |
| 2 | 对**自闭合**元素调用 `skipElement()` | 一路吞到文档末尾，HTML 里 `<img/>` 之后的内容凭空消失 | 格式读取器实测 |
| 3 | `visibleRange()` 二分方向写反 | **虚拟化完全失效**：3000 段文档渲染 6003 个节点 → 修后 53 个 | 集成测试 |
| 4 | `createViewer(doc)` 从未调用 `setDocument` | **整个应用白屏** | 集成测试 |
| 5 | `LimitGuard` 共用一组告警标记 | 超限时 `truncated` **永不写入** —— 正是要避免的「静默截断」 | 单元测试 |
| 6 | `outlineLevelFromStyleName('Heading 1')` | Word 最常见的标题样式名带空格 → **所有 Word 标题进不了大纲** | 单元测试 |
| 7 | `parseRels` 忽略 `TargetMode="External"` | 超链接被改写成 `word/https:/example.com`，**所有链接与外链图片失效** | 格式读取器反馈 |
| 8 | `formatByMime` 索引键未小写化 | 含大写的 MIME（`macroEnabled.12`）永远查不到 | 单元测试 |
| 9 | `estimateDocumentBytes` 看不到表格数据 | 2 万行 CSV 的模型被报成 **278 字节**（真实堆 60 MiB），核心指标失信 | 基准实测 |
| 10 | `status`/`bench`/`validate` 用绝对路径 `import()` | 三个工具**静默加载 0 个读取器**，生成过一份假的格式矩阵 | 工具输出异常 |
| 11 | 块注释被 `*/` 提前闭合 | 4 次踩中（`T*/Tf`、`packages/*/src`…）→ 已固化为 lint 规则 | 构建失败 |
| 12 | `validate.mjs` 把「按设计的拒绝」算成失败 | 成功率被自己的正确行为抹黑成 88.2%（真实 100%） | 报告审读 |
| 13 | `engine` 把信息性消息写进 `warnings` | 119 个文件里 103 个被标成「有降级」，**真正的降级完全看不见** | 报告审读 |
| 14 | 浏览器侧静态导入 `node:fs` | 构建能过，但**浏览器白屏** | lint 巡检 |
| 15 | 跨包导入上溯层数按错（4 层 vs 3 层） | 整个 Web 应用白屏，而 `build` 发现不了 | lint 巡检 |
| 16 | 一个测试文件加载失败会中断整个套件 | 全量运行只加载 3/15 个文件却输出「看起来正常」的报告 | 数字对不上 |
| 17 | **`/Resources /Font` 是间接引用时不解引用** | 整页文本变成控制字符乱码；一份 9 页中文讲义提取出 **0 个汉字** | **用户实测反馈「pdf 打开是乱码」** |
| 18 | `/ToUnicode` 的递增 `bfrange` 没生效 | 简单字体退回 WinAnsi，中文变 `!"#` | 测试 + 规范对照 |
| 19 | **`Td`/`TD`/`T*`/字形推进的平移没经文本矩阵缩放** | `Tm` 带 `0.05` 缩放时 `300 0 TD` 被当成 300pt（应 15pt）→ **放大 20 倍**，整行字被甩出页面、且碎成「一字一项」读起来像乱码 | **用户反馈同一批 PDF；判据是 x 跑到 3256 而页宽只有 595** |
| 20 | **`cm` 的复合顺序写反** | 嵌在页面翻转里的图片变换算成 `-160.32 × 841.9 + 711.96 ≈ -134261`，图片被放到页面外 13 万点处 → **「图片打不开」** | **用户实测反馈；判据是图片 y=-134261 而文本都在 600–730** |
| 21 | 裸像素图的 mime 是 `image/x-raw`（浏览器无法解码） | 530 张图里只有 96 张能显示，其余全是空白 | 图片统计 |
| 22 | **表格渲染忽略真实列宽**（普通单元格一律用默认宽度） | 9 列的 Excel 全部画成 68px：表头「学号（按顺序排序）」被 `overflow:hidden` 裁掉；列**位置**却按真实宽度算 → 表格错位 | **用户反馈「excel 支持不太好」** |
| 23 | `colOffsetOf` 返回 `pt × zoom` 却当 px 用（缺 4/3 换算） | 行用 px、列用 pt，单位不一致 → 横向滚动时单元格与滚动位置逐渐错开 | 同上 |
| 24 | **长文本一律 `overflow:hidden` + 省略号，不实现 Excel 的溢出显示** | 稍长的标题/备注/长数字全变成「…」；用户原话「大的数据我只能看到省略号」 | **用户反馈** |

### 为此固化的工具

- `tools/lint.mjs` —— 抓「构建查不出、只有运行时才炸」的问题：
  可擦除语法、裸包名导入、相对导入指向不存在的文件、**浏览器侧 `node:` 静态导入**、
  **跨包导入越出构建范围**、注释误闭合、**非法 UTF-8**、构建产物里的悬空导入
- `tools/test.mjs` —— 逐文件 try/catch；加载失败单独汇总并明示「通过数不包含它们」，退出码非零
- `tools/load-readers.mjs` —— 三个工具共用一份加载逻辑（同一个 bug 曾存在三份）
- `tools/validate.mjs` —— 区分「真失败」与「按设计的拒绝」，并输出**降级清单**
- `tools/status.mjs` —— 从运行时注册表生成格式矩阵，**不可能与代码脱节**

---

## 六、尚未完成（明确列出）

**第一轮的功能目标已全部达成**（内核 + 三件套只读渲染 + 多格式 + Web 壳 + 基准 + 文档）。
以下是**下一轮的边界**，不是本轮未完成项：

1. **不能编辑、不能导出**：本轮交付是只读渲染 —— 这是与 WPS 最大的差距。
   见 [ROADMAP.md](ROADMAP.md) 第二、三轮。
2. **`svg` / `epub` 未安装读取器**（格式表已登记，UI 会如实显示「未安装读取器」）。
3. **桌面壳未构建**：本机无 Rust 工具链，`apps/desktop` 只有设计与 `HostAdapter` 接口
   （见 [DESKTOP.md](DESKTOP.md)）。
4. **排版是近似的**，不是像素级还原；字体依赖系统（Web 壳无法嵌入文档自带字体）。
5. **真实浏览器行为未自动化验证**：拖放、File System Access API、CSS 视觉效果、
   IntersectionObserver 的真实触发都没有测。没有浏览器跑不了，硬测只会得到假信心。
   已做的是「整模块图爬取」：从 `main.js` 出发跟踪每个 import，
   **98 个资源全部 200、0 个 404**（`node tools/verify-web.mjs`）。
6. **内存效率仍有优化空间**：每段落约 930 字节的对象开销偏重（见 MEASUREMENTS.md 第五节）。

这些不是「小瑕疵」，而是**为下一轮划定的边界**。一个不知道边界的工具没法被信任。
