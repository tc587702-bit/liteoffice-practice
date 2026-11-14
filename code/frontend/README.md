# LiteOffice · Vue 3 + Vite + TypeScript

纯前端本地文档编辑器：docx / xlsx / pptx / md / pdf 在本机完成解析、编辑与导出，文件不上传。
本工程由原 React 版本迁移而来：解析与导出算法（`src/lib/*`）逐行保留，仅修正 import 与 URL 污染；
界面层全部重写为 Vue 3 `<script setup lang="ts">` + SFC，状态改为 Pinia，路由改为 vue-router。

## 常用命令

```bash
npm install      # 安装依赖
npm run dev      # 本地开发
npm run typecheck# vue-tsc --noEmit
npm run build    # 类型检查 + 生产构建（输出 dist/）
npm run preview  # 预览构建产物
```

## 目录结构

```
index.html
vite.config.ts
tsconfig.json
tailwind.config.js     # content: ['./index.html', './src/**/*.{vue,ts}']
postcss.config.js
src/
  main.ts              # createApp + Pinia + Router
  App.vue              # 外壳：ErrorBoundary / FileDropProvider / Toaster / 环境光
  router/index.ts      # createWebHashHistory（静态托管友好，base './'）
  stores/workspace.ts  # Pinia store（导入、会话、IndexedDB 持久化、Toast）
  pages/Home.vue       # 首页
  pages/Editor.vue     # 编辑页
  components/
    app/TopBar.vue  Sidebar.vue  Toaster.vue  SlotNumber.vue
    app/FileDropProvider.vue  app/fileDropContext.ts  app/ErrorBoundary.vue
    editor/Toolbar.vue  editor/SheetView.vue
    ui/AppButton.vue  AppCard.vue  AppBadge.vue  AppIcon.vue  ui/iconRegistry.ts
  lib/                 # 纯 TS 解析 / 导出（docx/xlsx/zip/xml/file/exporter 算法原样保留）
    docx.ts  xlsx.ts  pdf.ts  zip.ts  xml.ts  db.ts  file.ts  markdown.ts
    exporter.ts        # 下载与导出自检（blob URL）
    sheetjs-loader.ts  # 从 npm 包 xlsx 适配，不再走 public/vendor 或 http
    logger.ts          # 分级日志 + 最近 300 条环形缓冲 + 可选远程上报
    errors.ts          # AppError、全局兜底（Vue / window / promise / router）、诊断信息
  types/sheetjs.d.ts   # 内部最小类型声明
  index.css            # Tailwind + 冻结深色令牌 + 组件类 + 动效
```

## 设计冻结值（实现位置）


| 令牌      | 值                                                  | 实现                                     |
| ------- | -------------------------------------------------- | -------------------------------------- |
| 页面底色    | 纯黑 `#000000`                                       | `body` / `.lo-ambient`                 |
| 蓝紫径向光晕  | 0.07 – 0.09                                        | `.lo-ambient` 三层 `radial-gradient`     |
| 卡片      | `#303032`，24px 圆角，1px `rgba(255,255,255,0.08)`     | `.lo-card`                             |
| 主按钮     | `#0A84FF`，药丸形，`0 4px 16px rgba(10,132,255,0.3)`    | `.lo-btn-primary`                      |
| 次级按钮    | `#3A3A3C`                                          | `.lo-btn-secondary`                    |
| 文字层级    | `#F5F5F7` / `#98989D` / `#A1A1A6` / `#636366`      | CSS 变量 `--lo-text-1..4`                |
| 分割线     | `rgba(255,255,255,0.06)`                           | `--lo-divider` / `border-white/[0.06]` |
| 顶栏 / 侧栏 | `rgba(28,28,30,0.75)` + `blur(20px)`（含 `-webkit-`） | `.lo-glass`                            |


图标全部为内联 SVG（`src/components/ui/iconRegistry.ts`），动画全部为 CSS keyframes，无需图标库与动效库。

## 依赖

运行时：`vue`、`vue-router`、`pinia`、`xlsx`（SheetJS，按需异步 chunk）、
`pdfjs-dist@4.10.38`（PDF 文本提取 + 页面 canvas 渲染，按需异步 chunk；worker 由 Vite 本地打包）。
`docx` 未使用：DOCX 回写由内置 `lib/zip.ts` + `lib/docx.ts` 直接生成 OOXML。

构建期：`vite`、`@vitejs/plugin-vue`、`typescript`、`vue-tsc`、`tailwindcss`、`postcss`、`autoprefixer`。

## 日志与错误处理

- **日志**：`createLogger('scope')` 输出 `debug/info/warn/error`；开发环境全量进控制台，
  生产环境只输出 `error`，但**始终**保留最近 300 条在内存里。浏览器不能直接写硬盘，
  需要落盘时用下面的「导出诊断」下载成 txt。
- **导出诊断**：`collectDiagnostics()` 把 UA / 视口 / 地址 / 日志打包成 txt；
  错误边界页上有「下载诊断信息」按钮；控制台随时可执行 `__liteofficeDiagnose()`
  直接下载诊断文件，或 `__liteofficeLogs()` 打印纯文本。
- **全局兜底**：`installGlobalErrorHandlers(app, router)`（`main.ts` 中先于 `mount` 调用）
  接管 Vue 渲染错误、`window.onerror`、`unhandledrejection`、路由错误。
- **远程上报（可选）**：设置 `VITE_LOG_ENDPOINT` 后，`error` 级日志用 `sendBeacon` 上报，
  失败静默，不影响业务。
- **降级优先**：解析/导出失败一律「给出人话 + 提供下载原始文件」，不静默产出错误结果。

详见仓库根目录 [日志与错误处理规范](../../docs/software/observability.md)。

## 已知边界

- pptx / pdf 不支持回写，只能导出文本副本或下载原始文件。
- 单文件上限 4 MB，超大表格展示前 4000 行 / 200 列。
- IndexedDB 不可用时自动降级为「仅当前页面」。

