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
  lib/                 # 纯 TS 解析 / 导出（算法原样保留）
    docx.ts  xlsx.ts  pdf.ts  zip.ts  xml.ts  db.ts  file.ts  markdown.ts
    exporter.ts        # 下载与导出自检（blob URL）
    sheetjs-loader.ts  # 从 npm 包 xlsx 适配，不再走 public/vendor 或 http
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

运行时：`vue`、`vue-router`、`pinia`、`xlsx`（SheetJS，按需异步 chunk）。
`docx` / `pdfjs-dist` 未使用：DOCX 回写由内置 `lib/zip.ts` + `lib/docx.ts` 直接生成 OOXML，
PDF 文本由内置 `lib/pdf.ts` 解析（FlateDecode + ToUnicode CMap），因此不安装。

构建期：`vite`、`@vitejs/plugin-vue`、`typescript`、`vue-tsc`、`tailwindcss`、`postcss`、`autoprefixer`。

## 已知边界

- pptx / pdf 不支持回写，只能导出文本副本或下载原始文件。
- 单文件上限 4 MB，超大表格展示前 4000 行 / 200 列。
- IndexedDB 不可用时自动降级为「仅当前页面」。

