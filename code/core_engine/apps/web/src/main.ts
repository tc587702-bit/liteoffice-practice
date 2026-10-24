/**
 * 应用入口。
 *
 * 这里的职责只有三件事：
 *   1. 动态、逐个地注册格式读取器（缺一个包不影响其他功能，见 format-registry.ts）
 *   2. 启动壳（标签页/侧栏/搜索/缩放/内存 HUD/格式支持面板）
 *   3. 兜底：任何未捕获错误都用人话显示在状态栏，绝不留白屏
 *
 * 注意：**读取器的 import 不写在这里，而在 format-registry.ts**。
 * 原因见那个文件的注释：静态 import 一个还不存在的包会让整个模块图解析失败，
 * 应用直接白屏。
 */
import { LiteOfficeApp } from './app.ts';

function reportFatal(err: unknown): void {
  const bar = document.getElementById('status-message');
  const message = err instanceof Error ? err.message : String(err);
  if (bar) {
    bar.textContent = `启动失败：${message}（详情见浏览器控制台）`;
    bar.classList.add('is-error');
  }
  // 保留原始错误对象在控制台里，便于排查；
  // 但界面上只给人话，不把堆栈丢给用户。
  console.error('[LiteOffice] 启动失败', err);
}

function bootstrap(): void {
  const app = new LiteOfficeApp();
  // 暴露到 window 便于手工验证与自动化测试（不是内部依赖）
  (globalThis as unknown as { __liteoffice?: unknown }).__liteoffice = app;
  app.start().catch(reportFatal);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

window.addEventListener('error', (ev) => {
  if (ev.error) console.error('[LiteOffice] 未捕获错误', ev.error);
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[LiteOffice] 未处理的 Promise 拒绝', ev.reason);
});
