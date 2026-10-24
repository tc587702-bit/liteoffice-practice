import { describe, it, expect } from "vitest";
function extractTableRowsCurrent(tableEl) {
  return Array.from(tableEl.querySelectorAll("tr")).map((row) =>
    Array.from(row.children).map((cell) => cell)
  );
}
function normalizeRows(rows) {
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => {
    const out = r.slice();
    while (out.length < maxCols) out.push(document.createElement("td"));
    return out;
  });
}
function parseTable(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.querySelector("table");
}
const irregularHtml = `<table><tbody>
    <tr><th>姓名</th><th>成绩</th></tr>
    <tr><td>张三</td><td>90</td><td>备注</td></tr>
    <tr><td>李四</td></tr>
  </tbody></table>`;
describe("表格错误回归（WPS 表格报错根因）", () => {
  it("修复契约：保存前抽取必须让所有行列数一致（否则 WPS 报错）", () => {
    const rows = extractTableRowsCurrent(parseTable(irregularHtml));
    const counts = rows.map((r) => r.length);
    expect(new Set(counts).size).toBe(1);
  });
  it("normalizeRows 能让不规则表格所有行列数一致（即为修复目标）", () => {
    const rows = extractTableRowsCurrent(parseTable(irregularHtml));
    const fixed = normalizeRows(rows);
    expect(new Set(fixed.map((r) => r.length)).size).toBe(1);
    expect(fixed[0].length).toBe(3);
  });
  it("规整表格归一后依然一致（不引入回归）", () => {
    const html = `<table><tbody>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </tbody></table>`;
    const fixed = normalizeRows(extractTableRowsCurrent(parseTable(html)));
    expect(new Set(fixed.map((r) => r.length)).size).toBe(1);
  });
});
