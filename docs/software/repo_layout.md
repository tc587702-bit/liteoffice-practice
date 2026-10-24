# 仓库布局约定

> 本文件解决一个问题：4 个人并行时，谁的代码放进哪个目录。
> 目录结构沿用课程提供的模板，**不改模板**，只在这里把映射关系写清楚。

## 一、模板目录 → 本项目内容

| 模板目录 | 本项目装什么 |
|---|---|
| `code/frontend` | **零构建**的原生 HTML/CSS/JS（`index.html` + `styles/` + `js/`），Day 2 起加入 `src-tauri/`（Tauri 2 桌面壳）和 `public/editor/`（Office 内核产物，gitignore） |
| `code/core_engine` | Office 内核**产物与工具**：`onlyoffice.html` 集成页、产物拉取脚本、字体槽位替换与核对脚本 |
| `code/backend` | **本期无后端**。见该目录 README：本地优先，刻意不引入服务端 |
| `tests/unit` | 会话层、注册表、打印样式作用域等单测 |
| `tests/integration` | 10 份测试文档的打开/保存回归（Playwright 或表驱动手工记录） |
| `docs/requirements` | 问题定义 + 与 v2 规划的范围裁剪说明 |
| `docs/algorithm` | 关键机制说明：md 解析链、保存链路、字体槽位替换逻辑 |
| `docs/software` | 架构、接口契约、本文件、`skeleton-walkthrough.md`、构建与部署说明 |
| `docs/mgmt` | 每日进度、分工、风险清单 |
| `docs/retrospection` | 复盘 |

> 技术方案已从 Vue + Vite + TS 调整为**原生 ES module、零构建**（团队只学过 Python/C++，见 `skeleton-walkthrough.md`）。
> 好处：无打包步骤、无 npm 依赖、断网天然可用、报错直接指向自己的代码行。

## 二、`code/frontend` 内部结构（只增不改）

```text
index.html                 # 三个容器（工具栏 / 两个视图 / 状态栏）+ 隐藏 file input
styles/
  app.css                  # 布局与组件样式，class 全部 lo- 前缀
  print.css                # 只放 @media print，必须挂在 body[data-printing] 下
js/
  main.js                  # 指挥中心：装配、唯一的 refresh()、打开/保存链路
  state.js                 # 全局唯一状态，只有 main.js 能改
  core/
    types.js               # 接口契约（DocumentSession / FileProvider）+ assert 自检
    registry.js            # 扩展名 → 会话工厂
    recents.js             # 最近文件（本地元数据，Web 不持久化）
    file/
      web.js               # FileProvider(Web)：选择 / 下载
      tauri.js             # 待 Day 2：FileProvider(桌面)：原生对话框 / 写回原路径
  session/
    markdown.js            # md 会话（textarea；Day 2 换 CodeMirror 只改这个文件）
    office.js              # 待 Day 2：docx/xlsx/pptx/pdf 共用一个类，靠 documentType 区分
  shell/
    toolbar.js             # 工具栏；按钮状态只从 caps/dirty 推导
    statusbar.js           # 状态栏
  views/
    home.js                # 首页：拖拽区、最近文件列表
    editor.js              # 编辑器：会话挂载点、空态
```

## 三、三条铁律

1. **`js/core/` 不得直接操作界面元素**，一律通过返回值或事件；界面只读 `state`。
2. **按钮的启用态只能由 `SessionCaps` 和 `dirty` 推导**，禁止在 `shell/` 里写 `if (ext === 'pdf')` 这类散落判断。
3. **产物不进 Git**：`code/frontend/public/editor/`、`**/src-tauri/target/`、`code/core_engine/*.tgz` 全部忽略。

## 四、归属

| 角色 | 主要目录 |
|---|---|
| A 外壳与 Office 集成 | `js/main.js`、`js/shell/`、`js/session/office.js`、`js/core/types.js` |
| B Markdown 内核 | `js/session/markdown.js`、`styles/print.css` |
| C 文件系统与打包 | `js/core/file/`、`src-tauri/`、Web 部署 |
| D 测试与文档 | `tests/`、`docs/` |
