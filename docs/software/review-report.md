# LiteOffice 代码审查报告（自动生成）

生成时间：2026-11-07 09:40

## 一、原生检查器结果

| 检查 | 结果 | 说明 |
|---|---|---|
| 前端类型检查（vue-tsc） | ✅ 通过 | > vue-tsc --noEmit |
| Python 静态检查（ruff） | ❌ 未通过 | 11 项问题 |
| 后端语法检查（node --check） | ✅ 通过 | 6 个文件 |

## 二、规模

共 57 个文件，9,389 行。

| 语言 | 文件数 | 行数 |
|---|---|---|
| TS | 21 | 4,411 |
| Vue | 19 | 2,203 |
| JS | 11 | 1,941 |
| Py | 6 | 834 |

### 最大的 10 个文件

| 行数 | 文件 |
|---|---|
| 986 | `code/frontend/src/lib/docx.ts` |
| 713 | `code/frontend/src/pages/Editor.vue` |
| 648 | `code/frontend/src/stores/workspace.ts` |
| 470 | `code/frontend/src/lib/agent/tools.ts` |
| 466 | `code/frontend/src/lib/xlsx.ts` |
| 459 | `code/backend/server/index.mjs` |
| 356 | `code/frontend/src/lib/markdown.ts` |
| 335 | `code/agent/app/tools.py` |
| 310 | `code/frontend/scripts/check-large-file.mjs` |
| 300 | `code/frontend/scripts/check-docx-export.mjs` |

### 超过 600 行的文件（3 个）

- `code/frontend/src/lib/docx.ts`（986 行）
- `code/frontend/src/pages/Editor.vue`（713 行）
- `code/frontend/src/stores/workspace.ts`（648 行）

## 三、可疑模式统计

| 模式 | 次数 | 示例位置 |
|---|---|---|
| any 类型 | 0 | — |
| console.log | 8 | `code/backend/server/index.mjs:450` |
| innerHTML 赋值 | 1 | `code/frontend/src/pages/Editor.vue:106` |
| v-html | 1 | `code/frontend/src/components/ui/AppIcon.vue:20` |
| eval / new Function | 0 | — |
| localStorage | 0 | — |
| TODO / FIXME | 1 | `code/agent/app/graph.py:66` |
| @ts-ignore | 0 | — |
| 裸 except（Python） | 0 | — |
| subprocess shell=True | 0 | — |
| 硬编码密钥 | 0 | — |

## 四、Python 能审到哪、审不到哪

| 能 | 不能 |
|---|---|
| 调用各语言原生检查器并汇总 | TS/Vue 的类型与模板语义（要靠 vue-tsc） |
| 文件规模、超大文件、热点文件 | 运行时行为（要靠测试） |
| 正则可发现的危险模式 | 复杂数据流、跨文件依赖（要靠 eslint / madge） |
| 统一输出成报告 | 性能问题（要靠 profiling） |
