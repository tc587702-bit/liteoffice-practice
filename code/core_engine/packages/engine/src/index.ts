/**
 * @liteoffice/engine —— 嗅探与打开编排。
 *
 * 依赖 core（模型/接口）与 zip（容器），本身不含任何具体格式的解析逻辑。
 * 具体格式由各自的 format-* 包自注册进 core 的注册表。
 */
export { sniffFormat, sniffZipContainer, sniffDelimiter, looksBinary, declaredFormats } from './sniff.ts';
export type { SniffResult, SniffOptions } from './sniff.ts';
export { openDocument, openFile, openBlob } from './open.ts';
export type { OpenInput, OpenOptions, OpenResult } from './open.ts';
