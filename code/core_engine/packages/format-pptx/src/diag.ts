/**
 * pptx 读取器的可选诊断日志。
 *
 * 用途：pptx 的失败模式大多是「静默降级」（颜色丢失、形状被跳过），
 * 光看结果很难判断是哪一层出的问题。设置环境变量 `PPTX_DIAG=1` 后，
 * 读取器的关键决策（背景解析、备注探测、关系加载、文档属性）会写进这个数组。
 *
 * 为什么用模块级数组而不是 `console.log`：
 *   - 测试里可以直接断言内容，不必解析 stdout
 *   - 不在浏览器控制台留下调试噪音
 *   - 不引入 `node:fs` 这类平台依赖（浏览器侧会被静态分析挡住）
 */
export const pptxDiagLog: string[] = [];

export function pptxDbg(message: string): void {
  const on = typeof process !== 'undefined' && !!process.env?.PPTX_DIAG;
  // 上限只是防止畸形文件把日志数组撑爆
  if (on && pptxDiagLog.length < 2000) pptxDiagLog.push(message);
}
