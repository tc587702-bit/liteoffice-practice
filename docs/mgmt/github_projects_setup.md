# GitHub Projects 配置说明（Kanban / Team planning / Bug tracker）

> 文档编号：MGT-PRJ-001  
> 版本：1.0  状态：已生效  
> 关联：`communication_mgmt_plan.md`、`risk_mgmt_plan.md`

---

## 0. 为什么用三个 Project 而不是一个

一个看板塞下所有东西，最后会退化成"什么都有、什么都看不清"。
三者的读者、时间尺度和决策都不同：

| Project | 回答的问题 | 读者 | 时间尺度 | 卡片单位 |
|---|---|---|---|---|
| **Kanban** | 「现在这块谁在做、卡在哪」 | 全组 | 小时级 | 一个可独立验收的改动 |
| **Team planning** | 「这 5 天够不够、先后顺序对不对」 | 组长 + 教师 | 天级 | 里程碑 / 迭代条目 |
| **Bug tracker** | 「哪些缺陷必须演示前修掉」 | 全组 | 按严重度 | 一个可复现的缺陷 |

> **约定：一个工作项只存在于一个 Project 里。** Bug 不重复放到 Kanban；
> Kanban 里需要"修 bug"的卡片直接链接到对应 Issue。

---

## 1. 前置配置（只需做一次）

### 1.1 仓库级 Labels

进入 **Issues → Labels**，建议保留默认项并补充下列分组前缀（便于筛选）：

| Label | 颜色建议 | 用途 |
|---|---|---|
| `type/feature` | 蓝 | 新功能 |
| `type/bug` | 红 | 缺陷 |
| `type/docs` | 灰 | 文档 |
| `type/chore` | 灰 | 构建 / 脚本 / CI |
| `type/refactor` | 紫 | 重构 |
| `area/open` | 青 | 打开 / 拖放 / 格式识别 |
| `area/preview` | 青 | 预览（vue-office） |
| `area/edit` | 青 | 编辑（ONLYOFFICE） |
| `area/save` | 青 | 保存下载 |
| `area/ui` | 青 | 界面 / 样式 |
| `area/build` | 青 | 构建 / 脚本 / CI |
| `priority/P0` | 深红 | 核心闭环，必须完成 |
| `priority/P1` | 橙 | 影响可用性 |
| `priority/P2` | 黄 | 可选 |
| `priority/P3` | 浅灰 | 明确不做（留档） |
| `status/triage` | 黄 | 待分诊（Bug 报告默认） |
| `status/blocked` | 红 | 被阻塞 |
| `severity/S1` | 深红 | 核心闭环不可用 |
| `severity/S2` | 红 | 主要功能受损，有绕行 |
| `severity/S3` | 橙 | 体验问题 |
| `severity/S4` | 灰 | 文案 / 样式细节 |

批量创建（可用 `gh` CLI）：

```bash
gh label create "type/feature"  --color 1D76DB --description "新功能"
gh label create "type/bug"      --color D73A4A --description "缺陷"
gh label create "area/edit"     --color 0E8A16 --description "编辑（ONLYOFFICE）"
gh label create "priority/P0"   --color B60205 --description "核心闭环，必须完成"
gh label create "severity/S1"   --color B60205 --description "核心闭环不可用"
# 其余同理
```

### 1.2 里程碑（Milestones）

按 5 天周期建 5 个里程碑，与 `communication_mgmt_plan.md` 的评审节点对齐：

| 里程碑 | 验收标准（对应功能需求） |
|---|---|
| `D1 环境与骨架` | 仓库可克隆、`npm run setup && npm run dev` 成功、三栏界面可见 |
| `D2 打开与预览` | FR-FILE-01~07、FR-PREVIEW-01~06 通过（场景 A） |
| `D3 编辑闭环` | FR-EDIT-01~07 通过（场景 B 前半） |
| `D4 保存与完善` | FR-SAVE-01~05、FR-ERR-01~03 通过（场景 B 后半） |
| `D5 文档与交付` | 五份文档齐全、演示视频、答辩材料（场景 C/D/E） |

---

## 2. Project 一：Kanban（日常任务流）

### 2.1 创建

**Projects → New project → Board**，命名 `LiteOffice · Kanban`。

### 2.2 列（Status 字段选项）

| 列 | 含义 | 进入条件 | 离开条件 |
|---|---|---|---|
| `Backlog` | 已识别、未排期 | 有人写下卡片 | 决定做 |
| `Todo` | 本次迭代要做 | 已认领、已评估 | 开始动手 |
| `In Progress` | 正在做 | 有人真的在做（**同一时间每人 ≤ 2 张**） | 提了 PR |
| `Review` | 等他人确认 | PR 已开 | 至少 1 人 approve |
| `Done` | 完成 | 已合并 + 通过验收 | — |

### 2.3 自定义字段

| 字段 | 类型 | 选项 |
|---|---|---|
| `Status` | 单选 | Backlog / Todo / In Progress / Review / Done |
| `Priority` | 单选 | P0 / P1 / P2 / P3 |
| `Area` | 单选 | open / preview / edit / save / ui / build |
| `Owner` | 人员 | 组内 5 人（每人 ≤ 2 张 In Progress） |
| `Estimate` | 数字 | 0.5 / 1 / 2 天（**超过 2 天必须拆卡**） |

### 2.4 视图

| 视图 | 类型 | 配置 | 用途 |
|---|---|---|---|
| `看板` | Board | 按 Status 分列，按 Priority 排序 | 日常主视图 |
| `我的` | Table | 过滤 `Owner = @me` | 每人自查 |
| `本周重点` | Board | 过滤 `Priority = P0` | 组长盯核心 |
| `阻塞` | Table | 过滤 `label = status/blocked` | 站会 1 分钟过一遍 |

### 2.5 内置自动化

在 Project 右上 `⋯ → Workflows` 启用：

| 自动化 | 配置 |
|---|---|
| Item closed | Issue 关闭 → `Status = Done` |
| Pull request merged | PR 合并 → `Status = Done` |
| Item reopened | Issue 重开 → `Status = Todo` |
| Auto-add to project | `label = type/feature` 的 Issue 自动加入 |

---

## 3. Project 二：Team planning（排期与里程碑）

### 3.1 创建

**Projects → New project → Roadmap**（或 Table），命名 `LiteOffice · Team planning`。

### 3.2 为什么单独建

Kanban 只回答"此刻在做什么"。**排期需要看到"5 天里每件事落在哪天"**，
并能在里程碑评审时判断是否要裁范围（对应风险 R-08）。

### 3.3 自定义字段

| 字段 | 类型 | 用途 |
|---|---|---|
| `Status` | 单选 | Not started / In progress / At risk / Done |
| `Milestone` | 单选（或使用仓库 Milestone） | D1–D5 |
| `Start` / `Target` | 日期 | Roadmap 视图的时间轴依据 |
| `Workstream` | 单选 | 需求文档 / 界面 / 集成 / 集成验证 / 交付物 |
| `Risk` | 单选 | 关联风险编号（R-01…R-12） |

### 3.4 视图

| 视图 | 类型 | 配置 |
|---|---|---|
| `路线图` | Roadmap | 按 `Target` 排布，按 `Workstream` 分组 |
| `按天` | Board | 按 `Milestone` 分列（D1…D5） |
| `风险视图` | Table | 过滤 `Risk` 非空，用于评审时对照风险计划 |

### 3.5 建议的初始条目（可直接照建）

| 条目 | Milestone | Workstream | 对应风险 |
|---|---|---|---|
| 仓库初始化 + CI + 模板 | D1 | 交付物 | R-07 |
| 依赖安装与 `npm run setup` 打通 | D1 | 集成 | R-07、R-10 |
| 三栏界面骨架 | D1 | 界面 | — |
| 打开 / 拖放 / 格式识别 | D2 | 界面 | R-11 |
| 预览模式四种格式 | D2 | 集成 | — |
| 编辑模式接入（iframe 隔离） | D3 | 集成 | **R-01** |
| 编辑器加载遮罩与超时 | D3 | 界面 | R-03 |
| 保存链路（触发导出 + 截获产物） | D4 | 集成 | **R-02** |
| 错误横幅与白屏防护 | D4 | 界面 | R-06 |
| 五份文档 | D5 | 需求文档 | R-11 |
| 演示视频 + 答辩 PPT | D5 | 交付物 | R-08 |

---

## 4. Project 三：Bug tracker（缺陷跟踪）

### 4.1 创建

**Projects → New project → Table**，命名 `LiteOffice · Bug tracker`。

Issue 由 `.github/ISSUE_TEMPLATE/bug_report.yml` 创建，自动带 `type/bug` 与 `status/triage`。

### 4.2 自定义字段

| 字段 | 类型 | 选项 |
|---|---|---|
| `Status` | 单选 | Triage / Confirmed / In Progress / Fixed / Verified / Won't Fix |
| `Severity` | 单选 | S1 / S2 / S3 / S4 |
| `Area` | 单选 | open / preview / edit / save / ui / build |
| `Environment` | 单选 | 本机 Chrome / 局域网 Chrome / 局域网旧内核 / 其他 |
| `Found on` | 日期 | 发现日期 |

### 4.3 严重度定义与处置时限

| 级别 | 定义 | 处置时限 |
|---|---|---|
| **S1** | 核心闭环不可用（打不开、编辑区白屏、保存必失败） | **当天修或给出绕行**，否则触发 R-08 裁剪 |
| **S2** | 主要功能受损但有绕行（如保存需手动点导出） | 2 天内 |
| **S3** | 体验问题（提示不清、进度不可见） | 里程碑前 |
| **S4** | 文案 / 样式细节 | 有时间再做，可标记 `Won't Fix` 留档 |

### 4.4 状态流转

```
Triage ──确认复现──▶ Confirmed ──开始修──▶ In Progress ──修复+PR──▶ Fixed
   │                                                                  │
   └──无法复现/重复/非缺陷──▶ (关闭并说明原因)                         │
                                                                      ▼
   Won't Fix ◀──决定不修（必须写明理由）                       验证通过 ▶ Verified
```

**规则**：
- 进入 `Fixed` 前必须有 PR 关联（`Fixes #12`）
- `Verified` 只能由**非修复者**点，避免"自己说修好了"
- `Won't Fix` 必须写理由（进入 README「已知问题」或本文件）

### 4.5 视图

| 视图 | 类型 | 配置 |
|---|---|---|
| `待分诊` | Table | `Status = Triage`，按 Found on 升序 |
| `必修（演示前）` | Board | `Severity ∈ {S1, S2}`，按 Severity 分列 |
| `按模块` | Board | 按 `Area` 分列 |
| `已修待验` | Table | `Status = Fixed` |

### 4.6 本项目已知的 Bug 条目（可直接补录，作为示例）

| 标题 | Severity | Area | 状态 | 备注 |
|---|---|---|---|---|
| 编辑器挂载签名错误导致「异步任务出错」 | S1 | edit | Verified | `mountDocumentHandler` 只接受一个对象参数 |
| 编辑器容器高度链断裂，只见菜单栏 | S1 | edit | Verified | 库插入无高度包装 `<div>` |
| 表单编辑时整页白屏 | S1 | ui | Verified | 无全局错误捕获 |
| 光标固定在文字上方一行 | S2 | edit | Verified | 改为 iframe 隔离 |
| `@vue-office` 入口缺失导致启动失败 | S1 | build | Verified | npm 11 跳过 postinstall |
| 局域网首访误判为"编辑不了" | S2 | ui | Verified | 加加载遮罩 + 秒数 |
| 保存按钮无反应（找不到导出按钮） | S2 | save | In Progress | 需多环境验证 |
| 打开错误的地址显示 404 而非引导 | S3 | ui | Triage | 可加路由回退提示 |

---

## 5. 三个 Project 之间的约定

| 场景 | 做法 |
|---|---|
| 新想法 | 先建 Issue（`type/feature`），**不**直接加 Kanban |
| 决定要做 | 加入 Kanban，设 Owner 与 Estimate |
| 发现缺陷 | 用 Bug 模板建 Issue，自动进 Bug tracker |
| 缺陷导致进度变化 | 在 Team planning 把对应条目标 `At risk` |
| 缺陷需要改动接口 | PR 里 `@` 受影响成员，并更新 `docs/` |

---

## 6. 验收检查（建完后逐项对照）

- [ ] 三个 Project 可见性为 **Private**（课程作业避免公开暴露个人信息）
- [ ] Kanban 五列齐全，字段 `Priority/Area/Owner/Estimate` 可用
- [ ] Team planning 的 Roadmap 能按 `Target` 显示，D1–D5 五条里程碑已建
- [ ] Bug tracker 有 `Severity` 字段，且 S1/S2 视图可用
- [ ] 仓库 Labels 已按第 1.1 节建立
- [ ] Issue 模板可从页面选到（Bug / Feature 各一份）
- [ ] Kanban 自动化已启用（关闭 → Done）
- [ ] 至少录入 8 条真实卡面（第 3.5 与 4.6 节可直接用），不要留空板

> 空看板在评审时等于"没有项目管理"。哪怕只录入我们真实做过的条目，
> 也比一张干净的空板有说服力。

---

## 7. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-10-17 | 初版 | 三 Project 分工、字段、视图、Severity 定义与示例条目 |
