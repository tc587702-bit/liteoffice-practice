# LiteOffice

浏览器里打开、预览、编辑 Office 文档的轻量办公工具。**文件不上传到任何服务器**，全部在本地内存中完成。

> 软件实践课程小组项目。本仓库只有一个可运行实现：`code/frontend/`。

---

## 项目结构

```
liteoffice-practice/
├── code/
│   ├── frontend/          Vue 3 应用（唯一实现，44 个源文件）
│   └── backend/           空 —— 本项目没有后端，这是隐私设计的一部分
├── docs/
│   ├── requirements/      问题定义、功能需求（38 条）、非功能需求、用户故事
│   ├── mgmt/              沟通计划、风险计划、GitHub Projects 配置
│   ├── assignments/       三次课程作业
│   ├── software/          Vue 重写任务书、PDF 修复任务书
│   └── prototype/         设计阶段交互原型（墨刀导出，只读基准）
└── tests/                 预留
```

`docs/prototype/` 是**冻结的设计基准**：UI 的配色、间距、动效以它为准，只读不修改。

---

## 快速开始

```bash
cd code/frontend
npm install          # 5 个运行时依赖：vue / vue-router / pinia / xlsx / pdfjs-dist
npm run dev          # 默认 http://localhost:5173/
npm run build        # 类型检查 + 生产构建，产物在 dist/
npm run typecheck    # vue-tsc --noEmit
```

无需后端、无需环境变量、无需构建脚本以外的配置。

> 本项目**不使用** ONLYOFFICE：编辑能力由 `contenteditable` + 自研解析器实现，
> 体积从 199 MB 降到 2 MB 级，代价是排版保真度低于专业内核。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Vue 3（`<script setup lang="ts">`）+ Vite + TypeScript |
| 路由 / 状态 | vue-router + Pinia |
| 样式 | TailwindCSS（深色设计令牌） |
| 文档解析 | 自研：`docx.ts` / `xlsx.ts` / `markdown.ts` / `zip.ts` / `xml.ts` |
| PDF | `pdfjs-dist`（worker 本地打包，不依赖 CDN） |
| 持久化 | IndexedDB（会话与编辑内容，刷新可恢复） |

依赖刻意收敛：运行时 5 个、开发时 7 个，没有 UI 组件库、图标库、动画库。

---

## 能力与边界

**支持**

| 格式 | 打开 | 编辑 | 导出 |
|---|---|---|---|
| docx | ✅ 标题/段落/表格/图片/有序列表 | ✅ | ✅ 回写 |
| xlsx | ✅ 多工作表 | ✅ 单元格 | ✅ 回写（保留表名） |
| md | ✅ 标题/列表/代码块/表格 | ✅ | ✅ 文本 |
| pdf | ✅ 文本层 + canvas 渲染 | ❌ | 明确的「不支持回写」提示 |
| pptx | ✅ 文本抽取 | ❌ | 明确的「不支持回写」提示 |

**已知限制**

- **PDF 只读**，且扫描件（无文字层）不支持 OCR，会明确提示
- **pptx / pdf 无法回写**编辑结果，导出时明示，不静默产出不符的文件
- 超大工作簿（>2 MB 或 >2 万行）只加载前 N 行并标注已截断
- docx 编辑后导出是 HTML 重建，复杂排版（分栏、文本框、页眉页脚）会丢失
- 手机窄屏未做自适应

---

## 文档

| 文档 | 内容 |
|---|---|
| [文档索引](docs/README.md) | 全部文档导航与阅读顺序 |
| [问题定义（5W1H）](docs/requirements/problem_definition.md) | 为什么做、给谁用 |
| [功能需求规范](docs/requirements/functional_spec.md) | 38 条 `FR-*`（含 Markdown 与 AI 辅助）+ 追溯矩阵 + 7 个验收场景 |
| [非功能需求规范](docs/requirements/nonfunctional_spec.md) | `NFR-*` 指标与实测值 |
| [用户故事](docs/requirements/user_stories.md) | 8 条故事 + Gherkin 验收 + INVEST 自检 |
| [沟通管理计划](docs/mgmt/communication_mgmt_plan.md) | 干系人、沟通矩阵、会议节奏 |
| [风险管理计划](docs/mgmt/risk_mgmt_plan.md) | 风险登记册与应急预案 |

---

## AI 参与说明

**本项目代码与文档由 AI 辅助生成**，人工负责需求提出、取舍决策、验收测试与问题定位。

- 前端实现：AI 生成（Vue 3 工程），人工验收（构建、类型检查、真实文件解析实测）
- 设计原型：墨刀 AI 生成，含「豆包AI」标识，按要求保留
- 文档：AI 起草，人工补充实测数据与风险项

如需在课程/公开场合展示，请如实说明上述参与方式。

---

## 许可

见 [LICENSE](LICENSE)。第三方组件遵循其自身许可（`pdfjs-dist` Apache-2.0、`xlsx` Apache-2.0、Vue MIT）。
