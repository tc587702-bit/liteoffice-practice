import { ref } from 'vue';

/**
 * 全局错误上报。
 *
 * 为什么需要：点「编辑」时整页白屏，说明有未捕获异常把 Vue 应用打崩了。
 * 白屏是最差的失败方式 —— 用户看不到任何信息，开发者也只能靠 F12。
 * 这里把错误收拢到一个 ref 上，由状态栏/横幅显示出来，做到「失败也要说人话」。
 *
 * 同时保留 console.error，方便在 F12 里看完整堆栈。
 */
export const lastError = ref<string | null>(null);

/** 记录一条致命错误（只保留最近一条，避免刷屏） */
export function reportFatal(input: unknown, where = '应用'): void {
  const err = input instanceof Error ? input : new Error(String(input));
  const message = `${where}出错：${err.message || err.name}`;
  lastError.value = message;
  // 保留堆栈给控制台
  console.error(`[LiteOffice] ${message}`, err);
}

/** 清空错误（用户关闭横幅时调用） */
export function clearFatal(): void {
  lastError.value = null;
}

/**
 * 安装全局兜底：
 *   - window.onerror          同步异常
 *   - unhandledrejection      未处理的 Promise 拒绝（动态 import 失败走这条）
 *   - Vue app.config.errorHandler  组件内异常
 *
 * 注意：这不能"修复"错误，只是把白屏变成一条可读的信息。
 */
export function installGlobalHandlers(): void {
  window.addEventListener('error', (event) => {
    // 资源加载失败（img/script）不冒泡到 window.onerror 的 message，这里过滤掉
    if (event.error) reportFatal(event.error, '运行时');
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportFatal(event.reason, '异步任务');
  });
}
