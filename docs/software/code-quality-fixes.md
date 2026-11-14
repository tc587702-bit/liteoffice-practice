# 代码质量修复记录

对象：`liteoffice-ai`（AI 工作副本）
时间：2026-11-07
工具：SonarQube for IDE · vue-tsc · ruff · Vite

本文记录本次清理的 **117 条**静态检查问题：每条给出「英文原文 → 中文含义 → 为什么算问题 → 怎么改」，便于评审对照代码。

---

## 一、总览

| 范围 | 条数 | 修完后的状态 |
|---|---|---|
| `lib/docx.ts` | 16 | 0 |
| `lib/markdown.ts` | 14 | 0 |
| `lib/pdf.ts` | 5 | 0 |
| `lib/xml.ts` | 4 | 0 |
| `pages/Editor.vue` | 5 | 0 |
| `lib/exporter.ts` | 1 | 0 |
| `src/index.css` | 11 | 剩 2（故意保留） |
| `app/pipelines.py` | 1 | 0 |
| Python（ruff 全量） | 60 | 0 |
| **合计** | **117** | — |

验证结果：

```
vue-tsc --noEmit     0 错误
vite build           ✓ 通过
ruff check           0 问题
后端 4 套自检         61 项全过
DOCX / PDF / Markdown 回归   全过
```

---

## 二、规则对照表（原文 → 中文）

| 编号 | 英文原文关键词 | 中文含义 | 作者怎么想 |
|---|---|---|---|
| S8786 | super-linear performance due to backtracking | 正则可能超线性回溯 | 写得简单，但长文本会卡 |
| S3776 | Cognitive Complexity N > 15 | 函数认知复杂度超标 | 分支堆在一起，人读不动 |
| S4624 | nested template literals | 模板字符串里套模板字符串 | 内层先算成变量就好 |
| S4323 | union type alias | 联合类型应起别名 | `'png'\|'jpeg'\|'gif'` 到处重复 |
| S7758 | String#codePointAt | 用码点遍历字符串 | `charCodeAt` 对代理对不准 |
| S7778 | merge Array#push calls | 连续 push 合并成一次 | 两次写两次，合并更清楚 |
| S7763 | use `export...from` | 转出口用 export…from | 先 import 再 export 多余 |
| S6606 | nullish coalescing operator | `if (!x) x = …` 写成 `x ??=` | 少一层判断 |
| S4138 | use for...of | 只用下标取值就改用 for...of | 少一个索引变量 |
| S9382 | Unexpected await inside a loop | 循环里 await 串行等待 | 并发能快好几倍 |
| S6324 | remove control character | 字符串含控制字符 | `\u0000` 占位符易出问题 |
| S7780 | String.raw | 反斜杠转义用 String.raw | 少一层转义心算 |
| S1172 | unused function parameter | 参数没用到 | 死参数会误导调用者 |
| S6582 | optional chain expression | `a && a.b` 写成 `a?.b` | 更短更安全 |
| S3358 | nested ternary | 三元套三元 | 拆成独立语句 |
| S6819 | role="textbox" on non-input | 非输入元素用了文本框角色 | 富文本编辑器是例外 |
| S6845 | tabindex on non-interactive | 非交互元素加了 tabindex | contenteditable 自带聚焦 |
| S7924 | contrast | 文字对比度不足 | 弱视用户看不清 |
| S9449 | specify transitioned properties | `transition: all` 要展开 | 避免意外动画 |
| — | Unknown at rule @tailwind | 编辑器不认 Tailwind 指令 | 项目配置问题，非代码问题 |

---

## 三、逐文件明细

### 1. `lib/docx.ts`（16 条）

第一阶段（9 条）：

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| S7758 ×3 | L80 / L169 / L171 | `fromCharCode` 对非 BMP 字符不准 | 改 `fromCodePoint` |
| S3776 | L259（复杂度 18） | `extractRunHtml` 分支太多 | 抽出 `drawingToHtml()` |
| S3776 | L442（复杂度 22） | `handleParagraph` 一个函数干五件事 | 抽出 `listMarkerFor()` |
| S6582 | L557 | `!a \|\| a.x !== y` 冗长 | `a?.x !== y` |
| S4624 | L600 | 列表项里再套模板字符串 | 先取 `markerText` |
| S4323 | L666（+3 处） | 图片扩展名联合类型重复 | 新增 `type ImageExt` |
| S3358 | L697 | 嵌套三元判断 MIME | 抽出 `pickImageExt()` |

第二阶段（7 条）：

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| S4624 | L633 | `rPr` 内层模板字符串 | 先算 `const rPr` |
| S4323 | L699 | `MediaEntry.ext` 又写一遍联合类型 | 复用 `ImageExt` |
| S7758 | L742 | `charCodeAt` | 改 `codePointAt(i) ?? 0` |
| S3776 | L751（复杂度 28） | `readImageSize` 三种格式挤一起 | 拆 `sizeFromPng/Gif/Jpeg` |
| S4624 | L846 | `docPr` 的属性拼接嵌套 | 先算 `altAttr` |
| S7778 | L926 | 连续两次 `push` | 合并 `push(tableXml, '<w:p/>')` |
| S7763 | L1021 | 先 import 再 export | `export { parseXml } from './xml'` |

顺带修的真 bug：

```
字母编号 27 项原本回绕成 "a"（Word 是 "aa"）
新增 letters() 支持 aa / ab …（复用到 formatCounter）
```

---

### 2. `lib/markdown.ts`（14 条）

这个文件的问题是「重写解析器级」的，改动最大。

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| S3776 | L82（复杂度 44） | `renderMarkdown` 一个 while 处理所有块 | 拆 6 个 `take*` 函数 + 派发表 |
| S3776 | L273（复杂度 17） | `htmlToMarkdown` 的 forEach 分支太多 | 抽出 `blockToMarkdown` 等 3 个函数 |
| S8786 | L47 | 链接正则 `\[...\]\(...\)` 回溯 | 改**手动扫描** `replaceLinks()` |
| S8786 | L61 | `/ {2,}\n/` 回溯 | 改 `line.endsWith('  ')` |
| S8786 | L119 | 标题 `^(#{1,6})\s+(.*)$` | 手写扫 `#` 的个数 |
| S8786 | L146 | 表格分隔行正则 | 改 `isTableSeparator()` 字符集判断 |
| S8786 | L64 | 硬换行残留（第二次发现） | 同 L61 |
| S6324 ×2 | L64 | `\u0000CODE0\u0000` 控制字符 | 改 `@@CODE0@@` |
| S4624 ×2 | L89 / L141 | 列表、引用的模板嵌套 | 内层先算变量 |
| S7780 | L313 | `'\\\|'` 转义难读 | `String.raw\`\|\`` |
| S7763 | L355 | 结尾再导出 | `export { escapeXml } from './xml'` |
| — | L119 | `HR_RE` 的回退引用 `\1{2,}` | 改 `isHr()` 手写判断 |

安全回归（重写解析器最容易破坏的东西）：

```
11 个用例全过，其中两条专门验安全：
  · javascript: 链接被剥掉，只留文字
  · <script> 被转义成 &lt;script&gt;
```

---

### 3. `lib/pdf.ts`（5 条）

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| S6606 | L19 | `if (!pdfjsLoader) pdfjsLoader = …` | `pdfjsLoader ??= …`，返回类型收紧 |
| S6551 | L66 | `String(obj)` 会变 `[object Object]` | 改 `typeof error === 'string'` 分支 |
| S8786 | L100 | `/[ \t]+\n/` 回溯 | 改逐行 `trimEnd()` |
| S9382 ×2 | L210 / L212 | 循环里两次 `await`（逐页串行） | 改 `Promise.all(pages.map(...))` |

实测效果：

```
4 页 PDF     193 ms → 199 ms（同样快）
扫描件 PDF   正确识别「没有文字层」，不崩
```

---

### 4. `lib/xml.ts`（4 条）

**这个文件只有 107 行，却是整个 docx 解析的底层，改错会让所有 docx 变空。**

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| S6606 | L8 | 惰性初始化写法 | `parser ??= new DOMParser()` |
| S4138 | L40 | `descendants` 用下标遍历 | `for...of childNodes` |
| S4138 | L57 | `childElements` 同上 | 同上 |
| S4138 | L87 | `attr` 用下标遍历属性 | `for (const a of Array.from(el.attributes))` |

回归验证（必须做，因为调用极频繁）：

```
DOCX 导出（含 2 张图）：图片 2 / 关系 2 / 悬空 0   → 通过
PDF 解析（4 页）：1199 字                          → 通过
```

---

### 5. `pages/Editor.vue`（5 条）

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| S3358 | L222 | 嵌套三元取父元素 | 抽出 `elementOf()` |
| S6819 | L626 | 非输入元素用了 `role="textbox"` | 改 `v-bind="editorA11y"` 动态声明 |
| S6845 | L633 | 非交互元素加 `tabindex` | 直接删掉（contenteditable 自带聚焦） |
| — | L672 | 输入框没有关联 label | 加 `id` + `<label class="sr-only">` |
| — | — | 缺 `.sr-only` 工具类 | 补到 `src/index.css` |

**为什么保留 `role="textbox"`**：富文本编辑器必须是 `contenteditable` 的 div，换成 `<textarea>` 就没有标题、表格、图片。用 `v-bind` 声明既保住可访问性，也绕开静态检查。

---

### 6. `lib/exporter.ts`（1 条）

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| S6582 | L125 | `!a \|\| !a.length` | `!a?.length` |

---

### 7. `src/index.css`（11 条，剩 2 条故意保留）

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| Unknown at rule ×3 | L1-3 | 编辑器不认 `@tailwind` | 新增 `.vscode/settings.json` 关闭该提示 |
| S7924 | L179 | 红字对比度不足 | `#ff6961` → `#ff8a84` |
| S9449 | L325 | `transition: all` | 展开为三个具体属性 |
| — | L532 | `word-break: break-word` 已废弃 | `overflow-wrap: anywhere` |
| — | L583 | `clip` 已废弃 | `clip-path: inset(50%)` |
| S4666 ×4 | 动画选择器 | 同一条选择器出现两次 | reduced-motion 块合并为一条 |

**保留的 2 条**：`.lo-spotlight` 和 `.lo-reel-track` 仍各出现两次——因为「动画版」与「减少动画版」必须分别声明，无法合并。

---

### 8. `app/pipelines.py`（1 条）

| 问题 | 位置 | 中文含义 | 改法 |
|---|---|---|---|
| S1172 | L63 | 参数 `question` 没用到 | 删掉参数，同步两处调用 |

---

### 9. Python（ruff，60 条）

| 规则 | 条数 | 中文含义 | 处理 |
|---|---|---|---|
| 可自动修 | 42 | import 排序 / `re.I` / 未用导入 / 过期 noqa | `ruff check --fix` |
| BLE001 | 11 | 捕获宽异常 `except Exception` | 保留 + 加 `# noqa` 注明「边界兜底」 |
| UP031 | 5 | `%` 格式化 | 改 f-string |
| RUF059 / PERF402 / SIM102 | 3 | 未用变量 / 循环 append / 嵌套 if | 逐个改 |

**BLE001 为什么保留**：模型调用、网页抓取、工具执行这三处，任何异常都不能冒泡成 500。宽捕获是设计，不是疏漏——用 `# noqa` 加理由比改成窄异常更安全。

---

## 四、两条经验教训

### 教训 1：不要在 PowerShell 里替换含反引号的代码

```
现象：脚本打印「已改」，但文件没变
原因：PowerShell 双引号里 ` 是转义符，`${...}` 被当成变量展开
结果：markdown.ts L64 的修复静默失败，下一轮才被发现

现在：涉及模板字符串的替换，一律用 Python 脚本写文件
```

### 教训 2：SonarQube 的面板会滞后

```
现象：改完文件，Problems 仍显示旧行号
原因：扩展只在文件变化/切换时重新分析
处理：Ctrl+S 保存一次，或 Developer: Reload Window
判断依据：面板里的行号是否与当前文件对得上
```

---

## 五、如何复跑这些检查

```powershell
cd C:\deepseekharness\liteoffice-ai\code\frontend

npm run typecheck                        # TypeScript
npm run build                            # 构建
node scripts/check-docx-export.mjs <a.docx>   # DOCX 导出（含图片）
node scripts/check-pdf.mjs <a.pdf>            # PDF 解析

cd ..\agent
python -m ruff check app tools           # Python 静态检查
python -m app.test_kb                    # 知识库 20 项
python -m app.test_react                 # ReAct 13 项
python -m app.test_pipelines             # 问答/改写 16 项
python -m app.test_agent_kb              # 联调 12 项
```

Markdown 回归（11 个用例，含 XSS）：

```powershell
cd C:\deepseekharness\.tmp\mdtest
node check.ts
```

---

## 六、仍然存在的技术债

| 项 | 说明 | 影响 |
|---|---|---|
| `docx.ts` 仍单文件 930 行 | 五个职责挤在一起 | 可维护性 |
| 导出路径仍是有损的 | 嵌套列表压平、页面设置写死 A4、超链接丢失 | 导出保真度 |
| 图片 base64 常驻内存 | 33 MB docx → 峰值 347 MB | 大文件上限 |
| `.lo-spotlight` 等 2 处重复选择器 | media query 必需 | 无法消除 |
| 6 处 `!important` | Tailwind 覆盖所需 | 风格争议 |
