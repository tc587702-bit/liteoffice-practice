/**
 * @liteoffice/format-odf —— OpenDocument（ODF）读取器。
 *
 * 覆盖的格式：
 *   zip 容器：odt / ott / ods / ots / odp / otp / odg
 *   扁平单文件：fodt / fods / fodp
 *
 * 一个读取器同时处理 ODF 的三种文档类别，按**正文根元素**分派：
 *   office:text        -> UDM blocks（文字处理）
 *   office:spreadsheet -> UDM sheets（表格）
 *   office:presentation / office:drawing -> UDM slides（演示 / 图形）
 *
 * 导入本模块即完成注册（见文件末尾的 registerReader 调用）——
 * 「支持哪些格式」由导入图决定，不用装 ODF 支持就不必付它的体积。
 */
export { odfReader } from './reader.ts';
export {
  familyFromFormat,
  familyFromMimetype,
  familyFromRoot,
  formatFromMimetype,
  parseManifest,
  emptyManifest,
} from './package.ts';
export type { OdFamily } from './package.ts';
export { parseMetaXml, extractMetaSection } from './meta.ts';
export {
  applyCellProp,
  applyParaProp,
  applyRunProp,
  columnWidthPt,
  formatListNumber,
  lookup,
  parseOdStyles,
  parseStyleXml,
  renderListMarker,
  resolveCell,
  resolvePageLayout,
  resolvePara,
  resolveRun,
  rowHeightPt,
} from './styles.ts';
export { clampRepeat, mergeRunStyle, parseInline, parseTable, parseTextBody, toRunProps, toRunStyle } from './content.ts';
export { normalizeFormula, parseSpreadsheetBody } from './sheets.ts';
export { DEFAULT_SLIDE_HEIGHT_PT, DEFAULT_SLIDE_WIDTH_PT, ensureShapeSize, parseShape, parseSlidesBody } from './slides.ts';
export { parseTransformRotate, parseTransformScale, ptFrom, ptOrUndefined } from './geometry.ts';
export { emptyStyles, newContext } from './types.ts';
export type {
  OdCellProps,
  OdContext,
  OdListLevel,
  OdListStyle,
  OdManifest,
  OdPageLayout,
  OdParaProps,
  OdRunProps,
  OdStyleDef,
  OdStyles,
} from './types.ts';
