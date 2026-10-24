import { detectFormat } from './detectFormat';
import type { OpenDoc } from './types';

/**
 * 本地文件层：打开。
 *
 * 关键约束（产品定位的核心）：**文件永远不上传**。
 * 这里只在浏览器里做三件事 —— 读进 Blob、识别格式、交给编辑器。
 * 没有任何 fetch/XMLHttpRequest 发往服务器。
 */

let nextId = 1;

/** 用隐藏的 <input type=file> 让用户选文件。返回空数组表示用户取消。 */
export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.docx,.xlsx,.pptx,.md,.markdown';
    input.style.display = 'none';

    let settled = false;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    // 用户直接关掉对话框时不会触发 change，靠窗口重新获得焦点兜底
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => finish(Array.from(input.files ?? [])), 300);
      },
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}

export interface OpenOutcome {
  doc?: OpenDoc;
  warning?: string;
  error?: string;
}

/** 把 File 变成会话里的 OpenDoc（含格式校验） */
export async function toOpenDoc(file: File): Promise<OpenOutcome> {
  if (file.size === 0) {
    return { error: `「${file.name}」是空文件（0 字节）` };
  }

  const detected = await detectFormat(file);
  if (detected.format === 'unknown') {
    return { error: detected.warning ?? `无法识别「${file.name}」的格式` };
  }

  return {
    doc: {
      id: nextId++,
      name: file.name,
      format: detected.format,
      size: file.size,
      blob: file,
      openedAt: Date.now(),
    },
    warning: detected.warning,
  };
}

/** 人类可读的文件大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

// 支持拖放：把拖进来的文件规整成 File[]（只取文件，忽略目录）
export function filesFromDrop(event: DragEvent): File[] {
  const dt = event.dataTransfer;
  if (!dt) return [];
  return Array.from(dt.files ?? []).filter((f) => f.size > 0 || f.type !== '');
}
