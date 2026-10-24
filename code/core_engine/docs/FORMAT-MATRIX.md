# 格式支持矩阵

> **本文件由 `node tools/status.mjs --write` 自动生成，请勿手动编辑。**
> 数据来源是运行时加载真实读取器包后查询注册表的结果，因此不会与代码脱节。

## 汇总

- 格式表登记：**34** 种（不含 unknown）
- 已安装读取器包：**6 / 6**（format-text, format-docx, format-xlsx, format-odf, format-pptx, format-pdf）
- 可实际打开的格式：**29** 种
- 已登记但尚无读取器：**2** 种

## 逐格式明细

### OOXML（Microsoft Office 2007+）

| 格式 | 名称 | 类别 | 容器 | 扩展名 | 读取器 |
|---|---|---|---|---|---|
| `docm` | Word 文档（含宏） | text | zip | .docm | ✅ `format-docx` |
| `docx` | Word 文档 | text | zip | .docx | ✅ `format-docx` |
| `dotx` | Word 模板 | text | zip | .dotx .dotm | ✅ `format-docx` |
| `potx` | PowerPoint 模板 | slides | zip | .potx .potm | ✅ `format-pptx` |
| `pptm` | PowerPoint 演示文稿（含宏） | slides | zip | .pptm .potm .ppsx .ppsm | ✅ `format-pptx` |
| `pptx` | PowerPoint 演示文稿 | slides | zip | .pptx | ✅ `format-pptx` |
| `xlsm` | Excel 工作簿（含宏） | sheet | zip | .xlsm | ✅ `format-xlsx` |
| `xlsx` | Excel 工作簿 | sheet | zip | .xlsx | ✅ `format-xlsx` |
| `xltx` | Excel 模板 | sheet | zip | .xltx .xltm | ✅ `format-xlsx` |

### ODF（OpenDocument）

| 格式 | 名称 | 类别 | 容器 | 扩展名 | 读取器 |
|---|---|---|---|---|---|
| `fodp` | OpenDocument 演示（扁平 XML） | slides | plain | .fodp | ✅ `odf` |
| `fods` | OpenDocument 表格（扁平 XML） | sheet | plain | .fods | ✅ `odf` |
| `fodt` | OpenDocument 文本（扁平 XML） | text | plain | .fodt | ✅ `odf` |
| `odg` | OpenDocument 图形 | slides | zip | .odg .otg | ✅ `odf` |
| `odp` | OpenDocument 演示文稿 | slides | zip | .odp | ✅ `odf` |
| `ods` | OpenDocument 电子表格 | sheet | zip | .ods | ✅ `odf` |
| `odt` | OpenDocument 文本文档 | text | zip | .odt | ✅ `odf` |
| `otp` | OpenDocument 演示模板 | slides | zip | .otp | ✅ `odf` |
| `ots` | OpenDocument 表格模板 | sheet | zip | .ots | ✅ `odf` |
| `ott` | OpenDocument 文本模板 | text | zip | .ott | ✅ `odf` |

### 固定版式

| 格式 | 名称 | 类别 | 容器 | 扩展名 | 读取器 |
|---|---|---|---|---|---|
| `pdf` | PDF 文档 | pdf | pdf | .pdf | ✅ `pdf` |

### 纯文本与表格

| 格式 | 名称 | 类别 | 容器 | 扩展名 | 读取器 |
|---|---|---|---|---|---|
| `csv` | CSV 表格 | sheet | plain | .csv | ✅ `text-delimited` |
| `json` | JSON | text | plain | .json .jsonc .json5 | ✅ `text-json` |
| `log` | 日志文本 | text | plain | .log | ✅ `text-plain` |
| `md` | Markdown | text | plain | .md .markdown .mdown .mkd | ✅ `text-markdown` |
| `rtf` | RTF 富文本 | text | plain | .rtf | ✅ `text-rtf` |
| `tsv` | TSV 表格 | sheet | plain | .tsv .tab | ✅ `text-delimited` |
| `txt` | 纯文本 | text | plain | .txt .text | ✅ `text-plain` |

### 标记与矢量

| 格式 | 名称 | 类别 | 容器 | 扩展名 | 读取器 |
|---|---|---|---|---|---|
| `epub` | EPUB 电子书 | text | epub | .epub | — 未安装 |
| `html` | HTML 网页 | text | plain | .html .htm .xhtml | ✅ `markup-html` |
| `svg` | SVG 矢量图 | slides | plain | .svg | — 未安装 |
| `xml` | XML 文档 | text | plain | .xml | ✅ `markup-xml` |

### 旧版二进制（仅识别）

| 格式 | 名称 | 类别 | 容器 | 扩展名 | 读取器 |
|---|---|---|---|---|---|
| `ole2-doc` | Word 97-2003 文档（旧版二进制） | text | ole2 | .doc | 识别并提示（不支持解析） |
| `ole2-ppt` | PowerPoint 97-2003 演示文稿（旧版二进制） | slides | ole2 | .ppt | 识别并提示（不支持解析） |
| `ole2-xls` | Excel 97-2003 工作簿（旧版二进制） | sheet | ole2 | .xls | 识别并提示（不支持解析） |

## 这些格式分别由哪个包负责

| 包 | 负责的格式 |
|---|---|
| `text-plain` | `txt` `log` |
| `text-markdown` | `md` |
| `text-delimited` | `csv` `tsv` |
| `text-json` | `json` |
| `markup-html` | `html` |
| `markup-xml` | `xml` |
| `text-rtf` | `rtf` |
| `format-docx` | `docx` `docm` `dotx` |
| `format-xlsx` | `xlsx` `xlsm` `xltx` |
| `odf` | `odt` `ott` `ods` `ots` `odp` `otp` `odg` `fodt` `fods` `fodp` |
| `format-pptx` | `pptx` `pptm` `potx` |
| `pdf` | `pdf` |

## 为什么「已登记」多于「已实现」

`packages/core/src/formats.ts` 里的格式表是**能力声明**，包含嗅探规则、MIME、
扩展名归属与 UI 展示名。它比读取器更早存在，这样：

1. 嗅探器能正确**识别**一种格式（哪怕读取器还没写），从而给出准确的提示
   （「这是 OpenDocument 表格，读取器未安装」而不是「不认识这个文件」）
2. UI 的「格式支持」面板能如实展示「已支持 / 未安装」，而不是把未实现当成不存在
3. 新增读取器时只需实现 `FormatReader` 并 `registerReader()`，
   嗅探、文件对话框、格式徽标、统计**全部自动生效**
