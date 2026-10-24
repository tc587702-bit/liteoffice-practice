/**
 * xlsx 的颜色写法归一。
 *
 * xlsx 里同一个颜色有三种写法，任何一种漏掉都会让「有颜色的格子变成没颜色」：
 *   - `rgb="FFFF0000"`  —— 带 alpha 前缀的 ARGB。模型里要的是 `#rrggbb`，
 *     直接丢给 CSS 会得到 8 位十六进制（浏览器当无效值丢弃）→ 颜色全丢。
 *   - `theme="4"`       —— 指向 theme1.xml 的 clrScheme 槽位。这里用 Office
 *     默认主题的近似值（与 theme.ts 的 DEFAULT_OFFICE_THEME 同源），
 *     这是**降级**：真正精确需要解析 theme 部件并对 tint 做明暗变换。
 *   - `indexed="10"`    —— 56 色传统调色板 + 系统色。
 *
 * 特别注意 indexed 64/65：规范里是「系统前景/背景」，实际用法等价于
 * “没有设置颜色”（bgColor indexed="64" 到处都是）。把它们映射成具体颜色
 * 会让整片单元格突然出现黑色/白色底纹，因此这里返回 undefined。
 * tint 一律忽略（需要 HSL 往返，收益远小于复杂度），已在注释里声明为降级。
 */
import { attr, parseColor } from '../../ooxml/src/xmlUtil.ts';
import type { XmlEvent } from '../../xml/src/index.ts';

/** 传统 indexed 调色板（ECMA-376 §18.8.27），下标即 indexed 值。64/65 见文件头注释。 */
const INDEXED_COLORS: (string | undefined)[] = [
  '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff',
  '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff',
  '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#c0c0c0', '#808080',
  '#9999ff', '#993366', '#ffffcc', '#ccffff', '#660066', '#ff8080', '#0066cc', '#ccccff',
  '#000080', '#ff00ff', '#ffff00', '#00ffff', '#800080', '#800000', '#008080', '#0000ff',
  '#00ccff', '#ccffff', '#ccffcc', '#ffff99', '#99ccff', '#ff99cc', '#cc99ff', '#ffcc99',
  '#3366ff', '#33cccc', '#99cc00', '#ffcc00', '#ff9900', '#ff6600', '#666699', '#969696',
  '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333',
  undefined, undefined,
];

/**
 * 主题槽位顺序 = theme1.xml 里 clrScheme 的子元素顺序（ECMA-376 §18.8.30）：
 * lt1, dk1, lt2, dk2, accent1..6, hlink, folHlink。
 * 常见错误是按「dk1, lt1, ...」排（那是 Word 的别名顺序），于是主题色整体偏一格。
 */
export const THEME_COLORS: string[] = [
  '#ffffff', '#000000', '#e7e6e6', '#44546a',
  '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47',
  '#0563c1', '#954f72',
];

/** `FFRRGGBB` / `RRGGBB` / `RGB` -> `#rrggbb`。无法理解时返回 undefined。 */
export function argbToHex(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{8}$/.test(s)) return parseColor(s.slice(2));
  return parseColor(s);
}

/**
 * 从 `<fgColor>` / `<bgColor>` / `<color>` / `<rPr><color>` 这类元素上取颜色。
 * 判定顺序 rgb -> theme -> indexed -> auto：写入器通常只写一个，但按特异性排更稳。
 */
export function colorFromAttrs(e: XmlEvent): string | undefined {
  const rgb = attr(e, 'rgb');
  if (rgb !== undefined) return argbToHex(rgb);

  const theme = attr(e, 'theme');
  if (theme !== undefined) {
    const n = Number.parseInt(theme, 10);
    if (Number.isFinite(n) && n >= 0 && n < THEME_COLORS.length) return THEME_COLORS[n];
    return undefined;
  }

  const indexed = attr(e, 'indexed');
  if (indexed !== undefined) {
    const n = Number.parseInt(indexed, 10);
    if (Number.isFinite(n) && n >= 0 && n < INDEXED_COLORS.length) return INDEXED_COLORS[n];
    return undefined;
  }

  // auto="1"：让上层用默认色（前景黑 / 无底纹），不要在这里硬编码黑色
  return undefined;
}
