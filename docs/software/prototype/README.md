# LiteOffice 交互原型（AI 生成的交互式原型页面）

> 课程作业「原型展示」提交物。
> 位置：`docs/software/prototype/`
> 打开方式：`docs/software/prototype/index.html`

浏览器里打开、预览、编辑 Office 文件的**交互式原型** —— 纯静态，无需构建、无需后端、断网可跑。

---

## 一、这是什么

由一个 AI 原型平台（墨刀 modao.cc 的 agent）生成的两份可点击 HTML 页面：

| 文件 | 内容 |
|---|---|
| `index.html` | 首页：拖入文件 → 会话列表 → 文件就绪 → 进入编辑器 |
| `editor.html` | 编辑器：渲染、编辑、导出，含深色界面与工具栏 |

它不是效果图，而是**能真实读取文件的页面**：拖入 docx / xlsx / pptx / pdf 后，页面用自写的解析器解析字节并渲染出来。

### AI 生成声明

本目录下的全部页面与交互逻辑由 **AI 生成**（墨刀 agent 导出），人工只做了三处工程化处理：

1. **依赖本地化** —— 原本引用的 6 个 CDN 脚本全部下到 `vendor/`，页面不再请求任何外部域名；
2. **入口标准化** —— `home.html` 改名为 `index.html`，内部互链同步改掉；
3. **打包优化** —— 相对路径化，放在任意子目录都能打开。

按要求保留了生成平台原有的标识，未做删除或遮盖。

---

## 二、怎么打开

### 方式 1：本地起一个静态服务（推荐）

```bash
cd docs/software/prototype
python -m http.server 5191
# 浏览器打开 http://127.0.0.1:5191/
```

### 方式 2：直接双击 `index.html`

也能打开，但 `file://` 协议下浏览器把页面视为不透明源：

- IndexedDB 可能被拦截，刷新后会话不保留；
- 跨页传文件退化为 `window.name` 兜底；
- 建议只用来看界面，不要用它验证持久化。

> **不要**用 `file://` 验证"刷新后恢复会话"，那不是它有问题的场景，而是协议限制。

---

## 三、原型实现了什么

| 能力 | 状态 | 说明 |
|---|---|---|
| 拖入 / 选择文件 | ✅ | docx、xlsx、pptx、pdf，读取真实字节 |
| docx 渲染 | ✅ | 解析 `word/document.xml`：标题、段落、表格、超链接、加粗斜体 |
| xlsx 渲染 | ✅ | SheetJS 读取单元格 |
| pdf 渲染 | ✅ | pdf.js 逐页绘制到 canvas |
| pptx 渲染 | ⚠️ | 仅抽取文字行 |
| 编辑 | ✅ | `contenteditable` + 工具栏命令 |
| 导出 docx | ✅ | 用 docx.js 由 HTML 重建 |
| 导出 xlsx | ✅ | SheetJS 写回 |
| 会话持久化 | ✅ | IndexedDB + `window.name` 跨页传递 |
| 深色界面 | ✅ | 纯黑背景 + 蓝紫光晕，卡片 #303032，主按钮 #0A84FF |

---

## 四、已知限制（如实列出）

- **有序列表显示成圆点**：解析器里编号被硬编码为 `•`，丢失 `<ol>` 的编号信息。
- **图片不渲染**：docx 里的图片目前不显示，只显示占位。
- **页眉页脚、批注、修订不处理**，这部分内容会丢失。
- **导出的 docx 由 HTML 重建**：字体、间距与原文件不完全一致。
- **大文件会卡**：跨页传文件靠 `window.name` 塞字节数组，几十 MB 不适用。
- **这是原型，不是产品**：没有服务端、没有账号、没有多人协作。

---

## 五、目录结构

```
index.html                首页（打开文件 → 会话列表 → 文件就绪）
editor.html               编辑器（渲染 / 编辑 / 导出）
README.md                 本文件
.nojekyll                 关闭 GitHub Pages 的 Jekyll 处理
vendor/
  tailwindcss.js          样式（原 CDN 本地化）
  iconify-icon.min.js     图标
  xlsx.full.min.js        SheetJS：读写 xlsx
  docx.umd.js             docx.js：生成 docx
  pdf.min.js              pdf.js 主库
  pdf.worker.min.js       pdf.js worker
```

体积：约 3.5 MB，其中 3.4 MB 是 `vendor/` 下的依赖副本。

---

## 六、定位：它是设计基准，不是最终实现

本仓库的**可运行实现**在 `code/frontend/`（Vue 3 工程）。这个原型的作用是：

1. 交付「原型展示」这一项作业；
2. 作为**冻结的设计基准** —— 真实实现的配色、间距、圆角、动效以它为准；
3. 演示"不做后端也能读文件"的可行性。

两者关系：

```
docs/software/prototype/   交互原型（AI 生成，静态 HTML，只读基准）
code/frontend/             Vue 3 实现（能编辑、能导出、能持久化）
```

> 修改 `code/frontend` 的界面时，应回到本原型对照，而不是各改各的。
