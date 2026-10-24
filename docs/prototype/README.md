# LiteOffice 交互原型（GitHub Pages 版）

浏览器里打开、预览、编辑 Office 文件的交互原型 —— **纯静态，无需构建、无需后端**。

在线演示：部署后把地址填在这里（例如 `https://<你的用户名>.github.io/<仓库名>/`）

---

## 这是什么

墨刀（modao.cc）导出的 `home.html` / `editor.html` 两份交互原型，做了三处工程化处理：

1. **依赖本地化**：原本引用的 6 个 CDN 脚本全部下到 `vendor/`，断网也能跑，页面不再请求任何外部域名。
2. **入口标准化**：`home.html` 改名为 `index.html`（GitHub Pages 默认入口），内部互链同步改掉。
3. **可直接托管**：全部使用相对路径，放在仓库子目录下也能正常打开。

> 源码由 AI 生成（墨刀 agent 导出），本仓库保留其交互逻辑，仅做上述打包处理。如果你要再分发，请自行确认来源与授权要求。

## 怎么部署到 GitHub Pages

```bash
# 1. 新建仓库后，在本目录执行
git init
git add .
git commit -m "LiteOffice interactive prototype"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

2. 仓库页面 → **Settings → Pages**
3. **Source** 选 `Deploy from a branch`，Branch 选 `main`，目录选 `/ (root)`，Save
4. 等 1–2 分钟，访问 `https://<用户名>.github.io/<仓库名>/`

不需要构建步骤，GitHub 直接把 HTML 当静态文件发出来。`.nojekyll` 已就位，避免走 Jekyll 处理。

## 本地预览

```bash
python3 -m http.server 5191
# 打开 http://127.0.0.1:5191/
```

**不要直接双击 index.html。** `file://` 协议下浏览器把页面视为不透明源，IndexedDB 会被拦，
跨页传文件会退化（代码有 `window.name` 兜底，但刷新后会话不保留）。

## 功能范围

| 能力 | 状态 |
|---|---|
| 拖入或选择 docx / xlsx / pptx / pdf | 支持，真实读取文件字节 |
| docx 渲染 | 解析 `word/document.xml`，支持标题、段落、表格、超链接、加粗斜体 |
| xlsx 渲染 | 用 SheetJS 读取单元格 |
| pdf 渲染 | pdf.js 逐页绘制 |
| 编辑 | `contenteditable`，工具栏命令 |
| 导出 | docx 用 docx.js 重建、xlsx 用 SheetJS 写回 |
| 会话 | IndexedDB 持久化 + `window.name` 跨页传递 |

## 已知限制

- **有序列表显示成圆点**：解析器里硬编码 `•`，没有 `<ol>` 与编号信息。
- **页眉页脚、图片、编号格式不处理**，这部分内容会丢失。
- **导出的 docx 由 HTML 重建**，字体、间距、样式与原文件不完全一致。
- **大文件会卡**：跨页传递靠 `window.name` 塞字节数组，几十 MB 的文件不适用。
- **这是原型，不是产品**：没有服务端、没有账号、没有多人协作。

## 目录结构

```
index.html              首页（打开文件 → 会话列表 → 文件就绪）
editor.html             编辑器（渲染 / 编辑 / 导出）
vendor/
  tailwindcss.js        样式（CDN 本地化）
  iconify-icon.min.js   图标
  xlsx.full.min.js      SheetJS，读写 xlsx
  docx.umd.js           docx.js，生成 docx
  pdf.min.js            pdf.js 主库
  pdf.worker.min.js     pdf.js worker
.nojekyll               关闭 GitHub Pages 的 Jekyll 处理
```

## 替代托管

不想用 GitHub Pages 的话，这个目录可以直接拖到：

- [Netlify Drop](https://app.netlify.com/drop)（免注册，拖拽即得网址）
- Vercel / Cloudflare Pages（连仓库自动部署）
- 任意静态文件服务器（Nginx、`python -m http.server` 都行）
