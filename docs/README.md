# 文档索引

| 目录 | 文档 | 内容 | 主要读者 |
|---|---|---|---|
| `requirements/` | [problem_definition.md](requirements/problem_definition.md) | 5W1H 报告、产品描述、竞品差异、成功判定 | 教师、组长 |
| `requirements/` | [functional_spec.md](requirements/functional_spec.md) | 功能需求（FR-*）、追溯矩阵、端到端验收场景 | 开发、评审 |
| `requirements/` | [user_stories.md](requirements/user_stories.md) | 用户故事（US-*）、编号化验收条件（AC-*）、INVEST 自检、史诗拆分、到 FR 的追溯 | 教师、组长、开发 |
| `requirements/` | [nonfunctional_spec.md](requirements/nonfunctional_spec.md) | 非功能需求（NFR-*）、技术选型实测、指标汇总 | 开发、教师 |
| `mgmt/` | [communication_mgmt_plan.md](mgmt/communication_mgmt_plan.md) | 干系人、沟通矩阵、会议节奏、归档规则 | 全组 |
| `mgmt/` | [risk_mgmt_plan.md](mgmt/risk_mgmt_plan.md) | 风险分级、12 项风险登记册、应急预案 | 组长、全组 |
| `mgmt/` | [github_projects_setup.md](mgmt/github_projects_setup.md) | 三个 Project（Kanban / Team planning / Bug tracker）的字段、视图与流转 | 组长 |
| `assignments/` | [assignment-1-mission-strategy.md](assignments/assignment-1-mission-strategy.md) | 作业 1：使命、口号、目标用户、争取策略、多维竞品对比、SWOT | 教师 |
| `assignments/` | [assignment-2-product-definition.md](assignments/assignment-2-product-definition.md) | 作业 2：定位陈述、名称、发布时间、客户规模、价值、方案、里程碑、团队 | 教师 |
| `assignments/` | [assignment-3-communication-risk.md](assignments/assignment-3-communication-risk.md) | 作业 3：22 条沟通条目（按生命周期）+ 15 项风险登记册（五维度） | 教师、全组 |

## 阅读顺序建议

**新成员第一天**：problem_definition → functional_spec 第 7 节（验收场景）→ CONTRIBUTING

**答辩前自查**：nonfunctional_spec 第 10 节（指标汇总表）→ risk_mgmt_plan 第 4 节（风险分布）

**遇到分歧**：先看 functional_spec 的优先级与非目标，再看 risk_mgmt_plan 的处置原则

## 文档约定

1. **每条需求可验收**：必须能判断真假，禁止"体验良好"这类表述
2. **每条需求可追溯**：标注实现位置（文件路径）与验证方式
3. **未完成项必须显式标注**：用 ⚠️ / ❌ 标出，并在 README「已知问题」同步
4. **变更留痕**：每份文档末尾有变更记录表，写清触发原因
5. **中文文件禁止 shell 文本往返**：见 `CONTRIBUTING.md`，会不可逆损坏编码
