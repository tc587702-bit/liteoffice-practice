/**
 * @liteoffice/ooxml —— OOXML（docx / xlsx / pptx）共用层。
 *
 * 只放**跨格式真正共享**的东西：OPC 包结构、属性访问、Word 样式/编号、主题色。
 * 各格式特有的逻辑留在各自的 format-* 包里，避免这里变成杂物间。
 */
export * from './xmlUtil.ts';
export * from './package.ts';
export * from './styles.ts';
export * from './theme.ts';
