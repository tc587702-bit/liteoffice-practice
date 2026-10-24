/**
 * @liteoffice/format-xlsx —— Excel OOXML 读取器（xlsx / xlsm / xltx）。
 *
 * 本模块在**顶层自注册**：只要 import 了这个包，`openDocument()` 就能打开 xlsx。
 * 这是「格式支持是模块化的」这一架构约定的落点 —— 不 import 就不付出代价。
 *
 * 对外最有价值的两个额外导出（供 UI/基准使用）：
 *   - `scanSheet` / `StreamXmlScanner`：跨块安全的流式扫描，可单独测；
 *   - `parseCellRef` / `formatExcelSerial` 等纯函数：渲染器与编辑功能都要用同一套口径。
 */
import { registerReader } from '../../core/src/index.ts';
import { xlsxReader } from './reader.ts';

// ---- 自注册（模块顶层，幂等：registerReader 按 id 去重）----
registerReader(xlsxReader);

export { xlsxReader };

export { colIndexOfLetters, lettersOfColIndex, parseCellRef, colOfRef, rowOfRef, parseRangeRef, formatRangeRef } from './refs.ts';

export {
  BUILTIN_NUM_FMTS,
  builtinNumFmt,
  resolveNumFmt,
  stripFormatLiterals,
  analyzeFormat,
  isDateFormat,
  serialToParts,
  formatExcelSerial,
  normalizeIsoDate,
} from './numFmt.ts';
export type { FormatFields } from './numFmt.ts';

export { StreamXmlScanner, chunkedStream } from './xmlStream.ts';
export type { ScannerOptions } from './xmlStream.ts';

export { argbToHex, colorFromAttrs, THEME_COLORS } from './color.ts';

export { readTextNode, readRunProps, readRichText } from './richtext.ts';
export type { RichTextResult } from './richtext.ts';

export { loadSharedStrings, emptySharedStrings } from './sharedStrings.ts';
export type { SharedStrings } from './sharedStrings.ts';

export { parseStyles, EMPTY_STYLE_TABLE } from './styles.ts';
export type { StyleTable } from './styles.ts';

export {
  SMALL_TABLE_CELLS,
  scanSheet,
  parseWorksheet,
  readRow,
  makeCursorFetcher,
  attachSheet,
} from './worksheet.ts';
export type {
  WorksheetMeta,
  ScanOptions,
  ScanResult,
  SheetCounters,
  CellReadContext,
  WorksheetParseOptions,
  WorksheetParseResult,
} from './worksheet.ts';
