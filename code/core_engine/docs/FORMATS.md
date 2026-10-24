# 格式支持

> **逐格式的实时支持矩阵（含读取器挂载状态）见 [`FORMAT-MATRIX.md`](FORMAT-MATRIX.md)。**
> 那份文件由 `node tools/status.mjs --write` 从运行时注册表生成，不会与代码脱节。
> 本文件讲的是**设计**：格式是怎么被识别、派发、以及如何新增一种。

---

## 三层结构

```
① 格式表（能力声明）      packages/core/src/formats.ts
   登记 id / 名称 / 类别 / 容器类型 / 扩展名 / MIME / zip 特征部件
        │
        │  嗅探器据此判定"这是什么"
        ▼
② 嗅探（内容优先）        packages/engine/src/sniff.ts
   魔数 → ZIP 内部结构 → 文本启发式 → 扩展名兜底
        │
        │  得到一个 FormatId
        ▼
③ 读取器（注册表派发）    packages/format-*/src/index.ts
   各包顶层 registerReader() 自注册；注册表查 FormatId → FormatReader
```

**①与③是解耦的。** 格式表可以登记一种还没有读取器的格式 —— 这不是缺漏，而是刻意设计：

- 嗅探器能**正确识别**它，于是用户看到的是「这是 OpenDocument 表格，读取器未安装」，
  而不是「不认识这个文件」
- UI 的格式面板能如实区分「已支持」与「未安装」
- 新增读取器时不需要改嗅探、文件对话框、格式徽标、统计中的任何一处

---

## 为什么嗅探不能只看扩展名

真实的误判场景（都实际存在）：

| 用户行为 | 只看扩展名的后果 |
|---|---|
| 把 `.docx` 改名成 `.zip` | 派发不到读取器，报「不支持」 |
| 把 CSV 存成 `.txt` | 当成纯文本打开，表格结构全丢 |
| LibreOffice「另存为 Word」实际存成 ODF | 派发到 docx 读取器，报「文件损坏」 |
| 从邮件里存的附件被加了 `.dat` | 完全无法识别 |

因此判定顺序是**内容优先、扩展名兜底**：

```
1. 魔数
   %PDF-            → pdf
   D0CF11E0…        → OLE2（Office 97-2003 二进制）
   PK\x03\x04       → ZIP 家族，需要进一步看内部
   {\rtf            → rtf
2. ZIP 内部结构（权威）
   mimetype 条目    → ODF 的具体格式（这是 ODF 规范强制的权威判据）
   word/document.xml → docx      xl/workbook.xml → xlsx
   ppt/presentation.xml → pptx   META-INF/container.xml → epub
3. 文本启发式
   <!doctype html / <html → html     <svg → svg     <?xml → xml / 扁平 ODF
   可完整解析为 JSON     → json
   分隔符列数稳定        → csv / tsv
   Markdown 标记 ≥2 项    → md
4. 扩展名（最后兜底，confidence 标低）
```

**具体判据而非关键词**，这一点在几处很关键：

- JSON：只有**完整解析成功**才判定，否则 `{` 开头的 dump 日志会被误标成 JSON
- CSV：判据是「**各行列数是否稳定**」而不是「有没有逗号」，
  否则带逗号的散文会被误判成表格
- ODF：`mimetype` 条目是权威；没有它才退回「有 `content.xml` + `manifest.xml`」的弱判据

---

## 已知会「识别但不解析」的格式

`.doc` `.xls` `.ppt` 是 OLE2 复合文档，与 ZIP 是完全不同的容器，
内部是 FAT 式的目录结构 + 二进制记录流。解析它们需要一整套独立的实现。

**当前策略：识别 + 人话提示。**

```
这是 Office 97-2003 的旧版二进制格式，不是 ZIP 包结构，当前版本尚不支持。
建议先用任意 Office 另存为 docx/xlsx/pptx 或 odt/ods/odp 后再打开。
```

这比「不支持的文件类型」有用得多 —— 它告诉用户**下一步该做什么**。
识别靠魔数 + 内部流名（`WordDocument` / `Workbook` / `PowerPoint Document`）区分具体类型。

---

## 如何新增一种格式

以「新增 `.numbers`（Apple Numbers）」为例，四步：

### ① 在格式表里登记

```ts
// packages/core/src/formats.ts
spec({
  id: 'numbers',            // 需要先在 model.ts 的 FormatId 联合类型里加上
  kind: 'sheet',
  label: 'Apple Numbers 表格',
  family: 'ooxml',          // 或新增一个 family
  container: 'zip',
  extensions: ['numbers'],
  mimes: ['application/vnd.apple.numbers'],
  markers: ['Index/Document.iwa'],   // zip 内的特征部件路径
}),
```

登记之后，**嗅探、文件对话框的 accept、格式徽标、格式支持面板立刻生效**，
即使读取器还没写。

### ② 写读取器

```ts
// packages/format-numbers/src/index.ts
import { registerReader } from '../../core/src/index.ts';
import type { FormatReader, ReadContext } from '../../core/src/registry.ts';
import type { LiteDocument } from '../../core/src/model.ts';

const reader: FormatReader = {
  id: 'format-numbers',
  formats: ['numbers'],
  async read(ctx: ReadContext): Promise<LiteDocument> {
    const zip = await ctx.container!();     // 只调用一次
    // ... 解析 ...
    // 遇到不认识的结构：跳过 + ctx.guard.warn(...)，绝不抛错
    // 超限：ctx.guard.probe('maxCells', n)，被截断的会自动进 stats.truncated
  },
};

registerReader(reader);      // ← 顶层自注册，import 该包即生效
export { reader };
```

### ③ 在 Web 壳里导入以完成注册

```ts
// apps/web/src/main.ts
await import('../../../../packages/format-numbers/src/index.ts');
```

未实现或加载失败的包**要能优雅跳过**，并在状态栏提示「已安装 N 个读取器」。

### ④ 写测试

- 自造夹具（用 `ZipWriter`）覆盖精确断言
- 尽可能找一个**真实第三方文件**做交叉验证，文件不存在时 `t.skip()`
- 验证降级路径：空文档、缺部件、超限截断、畸形结构都不能崩

---

## 读取器的契约

来自 `docs/CONVENTIONS.md`，这里重述四条最容易被违反的：

1. **绝不因为某个子特性不支持而抛错。** 跳过 + 写 `stats.warnings`。
   目标优先级：能打开 > 完美还原 > 严格校验。
2. **超限要显式。** 被截断的资源名必须进 `stats.truncated`。
   **静默丢内容比打不开更糟** —— 用户会以为文件本身有问题。
3. **`ctx.container()` 只调用一次并复用。** 重复调用会重复解析 ZIP 中央目录。
4. **守住 `limits.maxPartBytes`。** 单个 XML 部件解压后超过该值时，
   走 `container.streamText()` 的流式扫描路径，不要 `read()` 整块。

---

## 面向用户的能力边界

这份说明应该出现在产品文档里，而不只在代码注释里：

| 能做 | 不能做 |
|---|---|
| 读出文档的**文本内容与结构**（段落、表格、列表、标题层级） | 像素级还原版面（行距微调、分页、首字下沉） |
| 读出**样式**（粗体/斜体/颜色/字号/对齐/背景） | 完整样式体系（条件格式、主题变体链的全部层级） |
| 读出**图片** | 矢量图形的高保真渲染（EMF/WMF 只做占位） |
| 读 PDF 的**文本与基础图形**并给出近似版面 | PDF 的像素级渲染（渐变、混合模式、图案填充） |
| 读 `docm`/`xlsm`/`pptm` 的**内容** | 执行宏（安全考量，明确不做） |
| 打开 ODF 与扁平 ODF（`fodt`/`fods`/`fodp`） | 打开 `.doc`/`.xls`/`.ppt`（旧版二进制） |
