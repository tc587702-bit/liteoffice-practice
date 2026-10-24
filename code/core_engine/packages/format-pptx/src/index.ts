/**
 * @liteoffice/format-pptx —— PowerPoint OOXML 读取器。
 *
 * 导入本模块即完成自注册（见 reader.ts 顶层的 registerReader 调用），
 * 于是「支持哪些格式」由「导入/打包了什么」决定，而不是靠一张中心化清单：
 * 不用 pptx 的构建就不会带上 pptx 的解析代码与内存开销。
 */
export { pptxReader, PPTX_READER_ID } from './reader.ts';
export { pptxDiagLog, pptxDbg } from './diag.ts';
export { applyColorMods, presetColor, themeOrDefault, parseFillColor, parseColorChild, readColorElement, schemeColorAt } from './color.ts';
export type { ResolvedColor, ColorMods } from './color.ts';
export { parseThemeFonts, resolveThemeFont } from './fonts.ts';
export type { ThemeFonts } from './fonts.ts';
export { emuToPt, rotToDegrees, hundredthPtToPt, ROT_PER_DEGREE } from './units.ts';
export { kindFromPreset, groupMap, transformShapeXfrm, xfrmFrom, readOffExt } from './geometry.ts';
export type { Xfrm, GroupMap } from './geometry.ts';
export { readTextBody, readBodyDefaults, mergeRunStyle, applyAutoNumber, makeTextContext } from './text.ts';
export type { TextStyle, ParaStyleExt, TextContext } from './text.ts';
export { readShapeTree, collectHolders, loadPendingImages } from './shapes.ts';
export type { Holder, ShapeCtx, ImageBudget, ImageSource } from './shapes.ts';
export { walkXml, eachChild, skipDeep, captureXml, defer, textOf, textDeep } from './scan.ts';
export type { ParserFactory } from './scan.ts';