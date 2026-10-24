import { describe, it, expect } from "vitest";
import {
  mimeFor,
  hasBytes,
  getExtension,
  formatSize,
  escapeHtml,
  safeHref,
  inlineMd,
  splitTableRow,
  renderMarkdown,
  columnIndex,
  formatCellValue,
  renderSheetTable,
  countWords,
  exportFormatHint,
  applyRestoredEdits
} from "../src/liteoffice-core.js";
/* ============ index.html：文件类型与扩展名（故事 4 / 故事 7） ============ */
describe("getExtension（故事 4：中文文件名与扩展名）", () => {
  it("普通文件名取小写扩展名", () => {
    expect(getExtension("报告.docx")).toBe("docx");
    expect(getExtension("data.XLSX")).toBe("xlsx"); // 大小写归一
  });
  it("多点的复合名取最后一段", () => {
    expect(getExtension("a.b.c.pdf")).toBe("pdf");
  });
  it("无扩展名返回空串", () => {
    expect(getExtension("README")).toBe("");
  });

  it("隐藏点文件名也能正确解析", () => {
    expect(getExtension(".gitignore")).toBe("gitignore");
  });
});

describe("formatSize（侧栏文件大小展示）", () => {
  it("非正数 / 非法值归零", () => {
    expect(formatSize(0)).toBe("0 KB");
    expect(formatSize(-5)).toBe("0 KB");
    expect(formatSize(NaN)).toBe("0 KB");
  });

  it("不足 1MB 以 KB 计且至少 1KB", () => {
    expect(formatSize(500)).toBe("1 KB");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1536)).toBe("2 KB");
  });

  it("达到 1MB 切换为 MB 并保留 1 位小数", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(Math.round(2.5 * 1024 * 1024))).toBe("2.5 MB");
  });
});

describe("mimeFor / hasBytes（故事 2 / 故事 7：格式与魔数校验）", () => {
  it("已知扩展名映射到正确 MIME", () => {
    expect(mimeFor("docx")).toContain("wordprocessingml");
    expect(mimeFor("pdf")).toBe("application/pdf");
    expect(mimeFor("md")).toContain("markdown");
  });

  it("未知扩展名回退为 octet-stream", () => {
    expect(mimeFor("txt")).toBe("application/octet-stream");
  });

  it("hasBytes 正确识别 ZIP 与 PDF 魔数", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const fake = new Uint8Array([0x00, 0x01, 0x02]);

    expect(hasBytes(zip, [0x50, 0x4b])).toBe(true); // docx/xlsx/pptx 都是 ZIP
    expect(hasBytes(pdf, [0x25, 0x50, 0x44, 0x46])).toBe(true);
    expect(hasBytes(fake, [0x50, 0x4b])).toBe(false);
  });

  it("字节不足时安全返回 false（故事 7：损坏文件不被误判）", () => {
    expect(hasBytes(new Uint8Array([0x50]), [0x50, 0x4b])).toBe(false);
    expect(hasBytes(null, [0x50])).toBe(false);
  });
});

/* ============ index.html：HTML 安全（防止 XSS） ============ */

describe("escapeHtml / safeHref（预览内容不应造成 XSS）", () => {
  it("escapeHtml 转义关键字符", () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml('a & "b" \'c\'')).toBe("a &amp; &quot;b&quot; &#39;c&#39;");
  });

  it("escapeHtml 对空值安全", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("safeHref 放行合法协议", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeHref("#anchor")).toBe("#anchor");
    expect(safeHref("/relative/path")).toBe("/relative/path");
  });

  it("safeHref 阻断 javascript: 与协议相对注入", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("//evil.com/x")).toBe("#");
    expect(safeHref("  ftp://x ")).toBe("#");
  });
});

/* ============ index.html：Markdown 渲染（故事 6 / md 预览） ============ */

describe("inlineMd（行内 Markdown 与链接安全）", () => {
  it("加粗、行内代码、链接渲染正确", () => {
    expect(inlineMd("**粗**")).toBe("<strong>粗</strong>");
    expect(inlineMd("`code`")).toBe("<code>code</code>");
    expect(inlineMd("[百度](https://b.com)")).toContain('href="https://b.com"');
  });

  it("危险链接被 safeHref 降级为 #", () => {
    expect(inlineMd("[x](javascript:alert(1))")).toContain('href="#"');
  });
});

describe("renderMarkdown（块级 Markdown）", () => {
  it("标题层级", () => {
    expect(renderMarkdown("# 标题")).toBe("<h1>标题</h1>");
    expect(renderMarkdown("## 二级")).toBe("<h2>二级</h2>");
  });

  it("无序与有序列表", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("代码块带语言标记", () => {
    expect(renderMarkdown("```js\nconst a=1;\n```")).toBe(
      '<pre data-lang="js"><code>const a=1;</code></pre>'
    );
  });

  it("表格", () => {
    const md = "| 列1 | 列2 |\n| --- | --- |\n| a | b |";
    const out = renderMarkdown(md);
    expect(out).toContain("<table>");
    expect(out).toContain("<th>列1</th>");
    expect(out).toContain("<td>a</td>");
  });

  it("空白文档给出占位提示", () => {
    expect(renderMarkdown("   ")).toContain("doc-empty");
  });
});

describe("splitTableRow（表格行拆分）", () => {
  it("去除首尾竖线并 trim 单元格", () => {
    expect(splitTableRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitTableRow("|  x | y  |")).toEqual(["x", "y"]);
  });
});

/* ============ index.html：XLSX 单元格（故事 5 / 表格渲染） ============ */

describe("columnIndex（列引用 -> 序号）", () => {
  it("A-Z 与 AA 及以上", () => {
    expect(columnIndex("A")).toBe(1);
    expect(columnIndex("Z")).toBe(26);
    expect(columnIndex("AA")).toBe(27);
    expect(columnIndex("AB")).toBe(28);
  });
  it("大小写不敏感", () => {
    expect(columnIndex("a")).toBe(1);
    expect(columnIndex("ab")).toBe(28);
  });
});

describe("formatCellValue（数值格式化）", () => {
  it("空单元格返回空串", () => {
    expect(formatCellValue({ text: "" })).toBe("");
    expect(formatCellValue(null)).toBe("");
  });
  it("浮点保留 8 位精度后取整显示", () => {
    expect(formatCellValue({ text: "3.1415926535", numeric: true })).toBe("3.14159265");
  });
  it("科学记数法保持原样", () => {
    expect(formatCellValue({ text: "1e3", numeric: true })).toBe("1e3");
  });
  it("非数值文本原样返回", () => {
    expect(formatCellValue({ text: "abc" })).toBe("abc");
  });
});

describe("renderSheetTable（工作表 HTML）", () => {
  it("无数据返回占位", () => {
    expect(renderSheetTable({ rows: [] })).toContain("doc-empty");
  });
  it("有数据生成表格并标记数值列", () => {
    const sheet = { rows: [[{ text: "5", numeric: true }, { text: "x" }]] };
    const out = renderSheetTable(sheet);
    expect(out).toContain("<table>");
    expect(out).toContain('class="num"');
    expect(out).toContain(">x<");
  });
});

/* ============ editor.html：字数统计（故事 9 编辑态） ============ */

describe("countWords（字数统计）", () => {
  it("英文按词计数", () => {
    expect(countWords("hello world")).toBe(2);
  });
  it("中文按字计数", () => {
    expect(countWords("你好世界")).toBe(4);
  });
  it("中英文混合相加", () => {
    expect(countWords("Hello 世界 test")).toBe(4); // 拉丁 2 + 中日韩 2
  });
  it("空串为 0", () => {
    expect(countWords("")).toBe(0);
  });
});

/* ============ editor.html：导出格式提示（故事 3 / 故事 4 保存下载） ============ */

describe("exportFormatHint（保存下载的格式与文案）", () => {
  it("可回写格式直接导出原格式", () => {
    expect(exportFormatHint("docx")[0]).toBe("docx");
    expect(exportFormatHint("xlsx")[0]).toBe("xlsx");
    expect(exportFormatHint("md")[0]).toBe("markdown");
  });
  it("pptx / pdf / 未知降级为 html 副本", () => {
    expect(exportFormatHint("pptx")[0]).toBe("html");
    expect(exportFormatHint("pdf")[0]).toBe("html");
    expect(exportFormatHint("xyz")[0]).toBe("html");
  });
});

/* ============ editor.html：恢复已编辑内容到真实文档（DOM 依赖，jsdom） ============ */

describe("applyRestoredEdits（把编辑结果写回预览容器）", () => {
  it("将标题与正文分别写入 head / editable body", () => {
    const realDoc = document.createElement("div");
    realDoc.innerHTML = '<div class="doc-page"></div>';
    const edited = "<h1>标题</h1><p>正文内容</p>";
    applyRestoredEdits(edited, realDoc);

    const page = realDoc.querySelector(".doc-page");
    expect(page.querySelector(".doc-head").innerHTML).toContain("<h1>标题</h1>");
    expect(page.querySelector("[data-editable]").innerHTML).toContain("<p>正文内容</p>");
  });

  it("已有标题时不重复创建 doc-head", () => {
    const realDoc = document.createElement("div");
    realDoc.innerHTML = '<div class="doc-page"><div class="doc-head">旧</div></div>';
    applyRestoredEdits("<h2>新标题</h2><p>x</p>", realDoc);
    expect(realDoc.querySelectorAll(".doc-head").length).toBe(1);
    expect(realDoc.querySelector(".doc-head").innerHTML).toContain("<h2>新标题</h2>");
  });
});
