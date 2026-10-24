/**
 * @liteoffice/format-docx —— Word OOXML 读取器（docx / docm / dotx）。
 *
 * 本包在**模块顶层自注册**：只要 import 了它，core 的格式表里
 * docx/docm/dotx 就有读取器了。这是「格式支持模块化」的落地方式 ——
 * 不用 docx 的场景不必付出这份解析代码的体积与内存代价。
 */
import { registerReader } from '../../core/src/registry.ts';
import { docxReader, readDocx } from './reader.ts';

registerReader(docxReader);

export { docxReader, readDocx };
export { hyperlinkTargetOf, fieldPlaceholder, parseParagraphContent } from './inline.ts';
export { parseBlockList, parseBlocksAt, parseNotesPart, blocksText } from './body.ts';
export { parseCoreProps, parseAppProps } from './meta.ts';
export { createEnv, partText, readParaPropsExt, readRunPropsExt, imageSizePx, mimeFromBytes } from './env.ts';
export type { DocxEnv } from './env.ts';
