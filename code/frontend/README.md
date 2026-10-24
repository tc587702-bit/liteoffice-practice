# LiteOffice（Vue 版）

浏览器内打开、预览、编辑、保存 Office 文档。**文件不上传到任何服务器**，全部在本地内存里完成。

> 本文件按 `liteoffice-规划.md` 的需求逐条对照现状，**包含未完成项与风险项**，不做粉饰。

---

## 快速开始

```powershell
cd C:\deepseekharness\liteoffice-vue
npm install          # 首次
npm run dev          # 启动
```

打开：

- 工作台：<http://localhost:5180/>
- 纯 vue-office 演示（不含 ONLYOFFICE）：<http://localhost:5180/demo.html>

首次安装后如果编辑器加载失败，先确认静态资源已就位：

```powershell
npm run check:oo     # 检查 public/onlyoffice 是否完整
npm run prepare:oo   # 缺失时复制（约 199 MB）
```

---

## 需求对照表

### 1.3 核心目标：docx / xlsx / pptx 的打开、编辑、保存

| 项 | 状态 | 说明 |
|---|---|---|
| 打开 `.docx` / `.xlsx` / `.pptx` | ✅ | 预览（`@vue-office/*`）+ 编辑（ONLYOFFICE）两条路都通 |
| 打开 `.md` / `.markdown` | ✅ | **自建解析器 + VNode 渲染**，只读预览；不支持编辑（见下方「Markdown 的边界」） |
| 编辑 | ✅ | ONLYOFFICE WASM 编辑器，支持文本、表格、幻灯片 |
| **保存下载** | ⚠️ **待实测** | 见下方「保存是怎么实现的」 |
| PDF 浏览 | ✅ | `@vue-office/pdf`（`demo.html` 与工作台预览模式） |
| PDF 注释 / 表单 | ❌ 未做 | 规划中为「顺带目标，如果原生支持」；local 版无此能力 |

### 1.4 明确不做（与规划一致）

宏 / VBA、多人协作、云存储与账号、复杂排版高保真编辑、从零开发 Office 引擎、打包商业字体。

> ⚠️ 最后一条**有风险**，见「已知问题」。

### 2. 技术方案对照

| 规划要求 | 现状 |
|---|---|
| Vue 3 + Vite + TypeScript | ✅ `vue@3.5`、`vite@6`、`typescript@5.7` |
| 核心编辑器 `onlyoffice-web-local` | ✅ `1.0.2`（x2t 编译成 WASM，纯本地） |
| 文件读写：File API + Blob | ✅ 见 `src/lib/openFile.ts` / `saveFile.ts` |
| PDF 不额外引入独立库 | ⚠️ 用了 `@vue-office/pdf`（底层 pdf.js）；ONLYOFFICE 的 local 版不含 PDF 编辑 |
| 字体：开源替代 + `fontSubstitutes` | ❌ **未配置**，见「已知问题」 |
| Tauri 桌面加分项 | ❌ 未做（本机无 Rust 工具链） |
| 部署 GitHub / Gitee Pages | ⚠️ 未部署；**本机 hosts 屏蔽了 GitHub**，建议走 Gitee |

### 3. 模块划分对照

规划里列的模块，与当前文件一一对应：

| 规划模块 | 实际文件 |
|---|---|
| `Workbench.vue` 三栏布局 | `src/App.vue` |
| `TopBar` | `src/components/TopBar.vue` |
| `FileSidebar` | `src/components/FileSidebar.vue` |
| `StatusBar` | `src/components/StatusBar.vue` |
| `EditorHost.vue` 编辑器嵌入 | `src/components/EditorHost.vue` |
| `editorAdapter.ts` 打开/保存适配 | `src/lib/editorAdapter.ts` |
| `openFile.ts` / `saveFile.ts` | `src/lib/openFile.ts`、`src/lib/saveFile.ts` |
| `detectFormat.ts` | `src/lib/detectFormat.ts` |
| `AgentPanel.vue` 占位 | `src/components/AgentPanel.vue`（`features.agentEnabled = false`，默认不渲染） |
| `features.ts` 配置 | `src/lib/features.ts` |

额外增加的：

- `src/components/PreviewPane.vue` —— 预览模式（用 `@vue-office/*`，秒开）
- `src/components/MarkdownPreview.vue` + `src/lib/md/*` —— md 预览（自建解析器与渲染器，零新增依赖）
- `src/lib/preview.ts` —— 预览组件的按需加载（打开 docx 不会下载 excel 的 13 MB）
- `demo.html` + `src/demo/` —— 纯 vue-office 演示页，与工作台互不影响

---

## Markdown 的边界（重要，别被问倒）

**md 只读，不能编辑。** 原因不是没做完，而是架构上不通：

- 编辑内核（ONLYOFFICE + x2t-WASM）只认 OOXML 与 ODF，md 的字节进不了转换器；
  硬塞进去的报错是「异步任务出错」这种看不懂的东西，所以 `EditorHost.vue` 直接拦住，
  顶部「编辑」按钮对 md 是禁用态并在 tooltip 里说明原因。
- 要编辑 md 需要另建双栏文本编辑器（左 textarea / 右实时预览），那是独立需求
  （`user_stories.md` 里的 US-09，未开工）。

**实现方式**：解析器移植自只读内核 `liteoffice/packages/format-text/src/mdparse.ts`
（零依赖，行内样式用「活跃标记栈」而不是正则替换），渲染器把它产出的 UDM 块转成 Vue VNode。

| 能力 | 支持 | 不支持（降级为纯文本） |
|---|---|---|
| 块级 | ATX 标题、段落、有序/无序/嵌套列表、围栏与缩进代码块、引用、水平线、管道表格 | Setext 标题、定义列表、内嵌 HTML 块、脚注、任务列表 |
| 行内 | 粗体、斜体、删除线、行内代码、链接、硬换行、常见 HTML 标签（`b/i/s/u/code/a/img`）的样式映射 | 引用式链接、数学公式、图片**不加载内容**（只显示占位，见下） |
| 编码 | UTF-8（含 BOM）、UTF-16（BOM）、GB18030 回退 | — |

三点必须知道的行为：

1. **图片不显示**。md 里写 `![](./a.png)` 时浏览器无权读本地相对路径，只显示一个占位块。
   要显示图片必须有文件系统访问能力（Tauri 方案），本期不做。
2. **行内 HTML 不执行**。解析器会把 `<script>` 这类未知标签**整段抹掉**，只留内部文字；
   渲染又走 VNode（不经 `v-html`），所以即使解析器将来改行为，也没有脚本执行通道。
3. **有上限**：单文件读 4 MB、最多 20000 个块，超出只渲染前部并在顶部说明，不会把标签页卡死。

---

## 双模式设计（为什么不是只有 ONLYOFFICE）
```
打开文件 ──▶ 预览模式（@vue-office，秒开，只读）
                 │  点「编辑」
                 ▼
             编辑模式（ONLYOFFICE，加载 WASM，可改可导出）
```

| | 预览模式 | 编辑模式 |
|---|---|---|
| 首屏体积 | docx 1.2 MB / xlsx 13.5 MB / pptx 9.3 MB / pdf 16 MB（按需） | 199 MB 静态资源，首次加载慢 |
| 能力 | 只读 | 编辑 + 导出 |
| 用途 | 快速确认内容 | 真正修改 |

好处：日常查看不用等 199 MB；答辩时两种能力都能演示；ONLYOFFICE 加载失败也不至于开天窗。

---

## 保存是怎么实现的（重要，含脆弱点）

`onlyoffice-web-local@1.0.2` **没有公开保存 API**：

- `package.json` 声明了 `"types": "dist/index.d.ts"`，但**这个文件没有发布**（本地 `node_modules` 与 CDN 均确认）。
- 只导出 `{ DocumentHandler, default, mountDocumentHandler }`。
- 真正的导出方法 `convertBinToDocumentAndDownload(bin, 文件名, 格式)` 挂在**内部单例**上，
  而编辑后的 `bin` 只存在于编辑器内部，外部拿不到。

因此实现方式（`src/lib/editorAdapter.ts`）：

1. 用户点顶部「保存下载」
2. 我们在宿主 DOM 里找到编辑器的**导出按钮**并点击它
3. 编辑器走 x2t 做 bin → docx 转换，产出 Blob
4. 我们通过临时钩住 `URL.createObjectURL` 捕获这个 Blob
5. 用它触发一次我们自己的下载（并回报文件名）

**脆弱点**：第 2 步依赖按钮的文字/类名匹配。找不到时会明确提示用户手动点导出，
不会出现"按钮点了没反应"。**这条链路必须在浏览器里实测确认**。

---

## 已知问题（不要当成已完成）

1. **字体合规未解决** ⚠️
   `public/onlyoffice/fonts/` 由包自带（16 个文件、80 MB）。
   抽查发现 `fonts/322`、`fonts/340` 的元数据里含 `Times New Roman` / `Microsoft` 字样。
   这意味着**不能声称"未打包商业字体"**。要公开分发或商用前，必须：
   - 改用开源字体（Carlito / Caladea / Gelasio / Liberation / Noto）替换，或
   - 确认该字体集合的许可允许再分发。

2. **保存链路未实测** ⚠️
   开发环境（本仓库的自动化校验）只能验证类型与构建，跑不了浏览器。
   `npm run dev` 之后的实际点击流程需要人工验证。

3. **首次加载慢**
   编辑模式要拉 199 MB 静态资源。建议演示前先打开一次预热。

4. **PDF 只能看，不能注释/表单**。
   规划把它列为「顺带目标」，未承诺。

5. **未部署**
   GitHub 在本机被 hosts 屏蔽（`127.0.0.1 github.com` 等 27 条），需要走 Gitee Pages，
   或先修 hosts。

---

## 开发脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（端口 5180） |
| `npm run typecheck` | `vue-tsc --noEmit`，模板与类型检查 |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run prepare:oo` | 复制 ONLYOFFICE 静态资源到 `public/onlyoffice` |
| `npm run check:oo` | 检查这些资源是否就位 |
| `npm run check:enc` | 检查 BOM / 中文编码损坏（本项目开发中踩过三次） |

---

## 目录结构

```
liteoffice-vue/
├── index.html              工作台入口
├── demo.html               纯 vue-office 演示入口
├── vite.config.ts
├── tsconfig.json
├── public/onlyoffice/      ONLYOFFICE 静态资源（199 MB，git 忽略）
├── scripts/
│   ├── prepare-onlyoffice.mjs
│   └── check-encoding.mjs
└── src/
    ├── main.ts
    ├── App.vue             三栏工作台
    ├── styles.css          设计令牌 + 组件样式
    ├── components/
    │   ├── TopBar.vue      打开 / 保存 / 预览-编辑切换
    │   ├── FileSidebar.vue 会话文件列表（彩色类型块）
    │   ├── EditorHost.vue  渲染内核宿主（预览 或 编辑）
    │   ├── PreviewPane.vue @vue-office 预览
    │   ├── MarkdownPreview.vue  md 预览（自建渲染器）
    │   ├── StatusBar.vue
    │   └── AgentPanel.vue  占位（默认关闭）
    ├── lib/
    │   ├── types.ts
    │   ├── features.ts     功能开关
    │   ├── detectFormat.ts 扩展名 + ZIP 头 / 文本字节双重校验
    │   ├── openFile.ts     选文件 / 拖放 / 校验
    │   ├── saveFile.ts     Blob 下载
    │   ├── preview.ts      预览组件按需加载
    │   ├── editorAdapter.ts  ONLYOFFICE 适配（唯一知道编辑器的地方）
    │   └── md/             Markdown：自建解析器与渲染
    │       ├── mdparse.ts      解析器（移植自只读内核，见文件头来源说明）
    │       ├── udm.ts          渲染需要的最小 UDM 类型子集
    │       ├── render.ts       UDM 块 → Vue VNode（不用 v-html）
    │       ├── MdBody.ts       无状态渲染组件
    │       └── decodeText.ts   UTF-8 / UTF-16 / GB18030 判定
    └── demo/               纯 vue-office 演示页
```
