# LiteOffice

浏览器里打开、预览、编辑 Office 文档的轻量办公项目。**文件不上传到任何服务器**，全部在本地内存中完成。

> 软件实践课程小组项目。本仓库包含两个可独立运行的子项目：只读内核与 Vue 前端。

---

## 项目由两部分组成

| 模块 | 位置 | 是什么 | 规模 |
|---|---|---|---|
| **只读内核** | [`code/core_engine/`](code/core_engine/) | 零依赖、零框架的文档解析内核，覆盖 29 种格式（OOXML / ODF / PDF / Markdown / CSV / RTF / EPUB 等），只读渲染 | 162 个文件，约 2.2 MB |
| **Vue 前端** | [`code/frontend/`](code/frontend/) | 可交互的工作台：多格式预览 + ONLYOFFICE 编辑 + Markdown 预览，支持拖放与局域网访问 | 39 个源文件 |

两者定位不同，**不是同一套代码的两个版本**：

- 内核追求「零依赖、秒开、低内存」，用自研解析器直接产出统一文档模型（UDM），再渲染成 DOM。**只读，不能编辑。**
- 前端追求「能改能存」，预览用 `@vue-office/*`，编辑用 ONLYOFFICE 的 WASM 内核，md 用自研解析器。**代价是首次加载约 199 MB。**

`code/backend/` 为空 —— 本项目**没有后端**，这是隐私设计的一部分，不是没做完。

---

## 快速开始

### 跑 Vue 前端（主要交付物）

```bash
cd code/frontend
npm install          # 约 400 MB，含 ONLYOFFICE 编辑内核
npm run setup        # 必需：补跑 @vue-office 的 postinstall + 复制编辑器静态资源
npm run dev          # 默认 http://localhost:5190/
```

`npm run setup` 不能省。它做两件事，两件都容易踩坑：

1. 补跑 `@vue-office/*` 的 postinstall —— npm 11 起默认不执行 postinstall，不补跑会报 `Failed to resolve entry for package "@vue-office/docx"`
2. 把 ONLYOFFICE 的 356 个静态文件（198 MB）从 `node_modules` 复制到 `public/onlyoffice` —— 这些文件不入库，必须本地生成

### 跑只读内核

```bash
cd code/core_engine
node tools/build.mjs      # 类型擦除构建（无 tsc、无打包器）
node tools/serve.mjs      # http://127.0.0.1:5180/apps/web/
node tools/test.mjs       # 全部测试
```

内核**不需要 `npm install`**，全仓库没有 dependencies。

---

## 在线原型

`docs/prototype/` 是设计阶段的交互原型（墨刀导出，AI 生成），纯静态：

- 本地看：起任意静态服务器，打开 `docs/prototype/index.html`
- 在线看：仓库 Settings → Pages → Source 选 `Deploy from a branch` + `/docs`，之后访问
  `https://<用户名>.github.io/liteoffice-practice/prototype/`

原型与最终实现的差异：原型是深色主题、选完文件停在「文件就绪」页；实现是浅色主题、选完直接渲染正文。**原型不含真实解析能力**。

---

## 文档

| 文档 | 内容 |
|---|---|
| [文档索引](docs/README.md) | 全部文档的导航与阅读顺序 |
| [问题定义（5W1H）](docs/requirements/problem_definition.md) | 为什么做、给谁用、如何实现 |
| [功能需求规范](docs/requirements/functional_spec.md) | `FR-*` 需求 + 追溯矩阵 + 端到端验收场景 |
| [非功能需求规范](docs/requirements/nonfunctional_spec.md) | `NFR-*` 指标与实测值 |
| [用户故事](docs/requirements/user_stories.md) | 8 条故事 + Gherkin 验收标准 + INVEST 自检 |
| [沟通管理计划](docs/mgmt/communication_mgmt_plan.md) | 干系人、沟通矩阵、会议节奏 |
| [风险管理计划](docs/mgmt/risk_mgmt_plan.md) | 风险登记册与应急预案 |
| [GitHub Projects 配置](docs/mgmt/github_projects_setup.md) | Kanban / Team planning / Bug tracker |
| [贡献规范](CONTRIBUTING.md) | 分支、提交信息、PR 清单 |

---

## 已知限制

**只读内核**

- 只读，不能编辑、不能导出
- `svg` / `epub` 已登记但未安装读取器，界面会如实显示「未安装读取器」
- 部分 pptx / pdf 细节算子仍有测试失败

**Vue 前端**

- 编辑模式首次加载约 199 MB，慢网络需 1–3 分钟
- 「保存下载」链路依赖编辑器导出按钮，**尚未在多环境下充分验证**
- 字体合规未解决：`public/onlyoffice/fonts/` 含商业字体（等线、宋体、Arial 等），公开分发前必须替换为开源字体
- Markdown 只读，不能编辑；有序列表会显示成圆点；图片不加载本地路径

**原型**

- AI 生成，含「豆包AI」标识，不得删除
- 无真实解析能力，只是交互流程

---

## 许可

内核部分见 [code/core_engine/LICENSE](code/core_engine/LICENSE)（MIT）。

ONLYOFFICE 及其静态资源遵循其自身许可，商业字体问题见上方「已知限制」。
