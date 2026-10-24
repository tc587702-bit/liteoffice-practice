import { describe, it, expect } from "vitest";
import { getExtension, formatSize } from "../src/liteoffice-core.js";
describe("示例：文件扩展名识别（故事 4）", () => {
  it("中文文件名应返回小写扩展名", () => {
    const name = "我的报告.docx";
    const result = getExtension(name);
    expect(result).toBe("docx");
  });
  it("无扩展名的文件应返回空字符串", () => {
    expect(getExtension("README")).toBe("");
  });
});
describe("示例：文件大小格式化", () => {
  it("0 与负数应归零显示为 0 KB", () => {
    expect(formatSize(0)).toBe("0 KB");
    expect(formatSize(-5)).toBe("0 KB");
  });
  it("超过 1MB 应切换为 MB 并保留一位小数", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
  });
});
