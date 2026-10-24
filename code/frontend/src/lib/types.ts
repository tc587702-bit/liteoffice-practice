/**
 * 共享类型。
 *
 * 设计原则：这些类型是**边界类型** —— 它们出现在 Vue 组件、文件层、编辑器适配层之间。
 * 适配层（editorAdapter）只依赖这里的类型，不依赖任何具体编辑器实现，
 * 这样「换编辑器」只需要换一个 adapter，UI 一行都不用改。
 */

/** 目前支持的格式。加格式时这里和 detectFormat.ts 一起改。 */
export type DocFormat = 'docx' | 'xlsx' | 'pptx' | 'md' | 'unknown';

/** 一次会话里的一个文件。注意：文件内容始终在内存里，不上传。 */
export interface OpenDoc {
  /** 会话内唯一 id（用递增数字，不用文件名 —— 同名文件可能同时打开两个） */
  id: number;
  /** 原始文件名，保存时沿用它 */
  name: string;
  format: DocFormat;
  /** 原始字节数，用于状态栏显示 */
  size: number;
  /** 原始内容。Blob 而不是 ArrayBuffer：Blob 可以传给 createObjectURL，不占额外内存 */
  blob: Blob;
  /** 打开时间 */
  openedAt: number;
}

/** 保存结果：编辑器产出新内容后交给我们下载 */
export interface SaveResult {
  ok: boolean;
  /** 成功时是被编辑器改写后的内容 */
  blob?: Blob;
  /** 建议的文件名（通常沿用原名） */
  filename?: string;
  /** 失败原因，直接显示给用户 */
  message?: string;
}

/** 状态栏消息级别 */
export type StatusLevel = 'info' | 'ok' | 'warn' | 'error';

export interface StatusMessage {
  level: StatusLevel;
  text: string;
  /** 毫秒时间戳，用于判断是否要自动消失 */
  at: number;
}
