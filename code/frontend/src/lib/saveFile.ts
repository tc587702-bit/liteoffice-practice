import type { DocFormat } from './types';

/**
 * 本地文件层：保存。
 *
 * 编辑器（ONLYOFFICE）编辑完会产出一份新内容，这里负责把它变回一次浏览器下载。
 * 全程在本地：不经过任何服务器。
 */

/** docx/xlsx/pptx/md 的标准 MIME，下载时用对，否则某些系统会用错程序打开 */
export const MIME: Record<Exclude<DocFormat, 'unknown'>, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown;charset=utf-8',
};

/** 统一成「无扩展名的基名」，保存时再按格式补后缀，避免出现 a.docx.docx */
export function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 触发一次浏览器下载。
 *
 * 注意 `URL.revokeObjectURL` 的时机：必须等下载**真正开始**之后。
 * 同步 revoke 会让部分浏览器取消下载（Chrome 里表现为"下载失败"）。
 * 这里用 setTimeout 给 1 秒缓冲 —— 对几百 KB 的文档足够。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 保存成功的统一出口：补后缀 + 下载 */
export function saveAs(doc: { name: string; format: DocFormat }, blob: Blob): string {
  const ext = doc.format === 'unknown' ? '' : `.${doc.format}`;
  const filename = `${baseName(doc.name)}${ext}`;
  downloadBlob(blob, filename);
  return filename;
}
