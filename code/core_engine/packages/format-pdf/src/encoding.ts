/**
 * 字符编码表与字形名 -> Unicode 映射。
 *
 * 为什么需要这些表：简单字体（Type1/TrueType）的内容流里存的是**单字节字符码**，
 * 想拿到可读文本必须知道码 -> Unicode 的对应关系。来源有三层，优先级从高到低：
 *   1. /ToUnicode CMap（最准确，子集化字体也能用）—— 见 font.ts
 *   2. /Encoding 的 /Differences 数组（按字形名覆盖）
 *   3. /Encoding 的基编码（WinAnsi / MacRoman / Standard / PDFDoc / Symbol）
 * 这一层负责 2 与 3，并在完全没有编码信息时给出 Latin-1 兜底。
 *
 * 表用「码点序列字符串」表达：JS 字符串本身就是一个 UTF-16 码元数组，
 * 用 '\u0000' 占位比写 256 项的稀疏对象更省内存，也比数组字面量更易校对。
 */

/** 标准 PDF 编码（StandardEncoding）0x20..0xFF。0 表示该码位在该编码里未定义。 */
export const STANDARD_ENCODING =
  ' ' +
  '!' +
  '"' +
  '#' +
  '$' +
  '%' +
  '&' +
  "'" +
  '(' +
  ')' +
  '*' +
  '+' +
  ',' +
  '-' +
  '.' +
  '/' +
  '0' +
  '1' +
  '2' +
  '3' +
  '4' +
  '5' +
  '6' +
  '7' +
  '8' +
  '9' +
  ':' +
  ';' +
  '<' +
  '=' +
  '>' +
  '?' +
  '@' +
  'A' +
  'B' +
  'C' +
  'D' +
  'E' +
  'F' +
  'G' +
  'H' +
  'I' +
  'J' +
  'K' +
  'L' +
  'M' +
  'N' +
  'O' +
  'P' +
  'Q' +
  'R' +
  'S' +
  'T' +
  'U' +
  'V' +
  'W' +
  'X' +
  'Y' +
  'Z' +
  '[' +
  '\\' +
  ']' +
  '^' +
  '_' +
  '`' +
  'a' +
  'b' +
  'c' +
  'd' +
  'e' +
  'f' +
  'g' +
  'h' +
  'i' +
  'j' +
  'k' +
  'l' +
  'm' +
  'n' +
  'o' +
  'p' +
  'q' +
  'r' +
  's' +
  't' +
  'u' +
  'v' +
  'w' +
  'x' +
  'y' +
  'z' +
  '{' +
  '|' +
  '}' +
  '~';

/**
 * 0x20..0x7F 段（所有简单字体编码共用；0x7F 规范里未定义，用 \u0000 占位）。
 *
 * 编码表用 `code - 0x20` 下标访问，所以「高半区从 0x80 开始」意味着
 * 低段必须是 **96** 个字符（0x20..0x7F）。早期版本在拼 MacRoman/PDFDoc 时
 * 用了 `slice(0, 128)`，把低段多算了 32 个字符，整个高半区偏移 0x20。
 */
const ASCII_LOW = STANDARD_ENCODING + '\u0000';

/**
 * WinAnsiEncoding：Windows 代码页 1252。PDF 里最常见的简单字体编码。
 *
 * ⚠ 0x7F 必须占一个槽位（`ASCII_LOW` 里的 \u0000）。早期版本直接把高区 128 位
 * 接在 STANDARD_ENCODING 后面 —— 于是 0x80 被当成 0x7F、0xE9（é）解成 0xEA（ê），
 * **高区整体偏移一位**。
 */
export const WIN_ANSI_ENCODING =
  ASCII_LOW +
  '\u20ac\u0000\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u0000\u017d\u0000' +
  '\u0000\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u0000\u017e\u0178' +
  '\u00a0\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u00aa\u00ab\u00ac\u00ad\u00ae\u00af' +
  '\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u00ba\u00bb\u00bc\u00bd\u00be\u00bf' +
  '\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf' +
  '\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d7\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de\u00df' +
  '\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef' +
  '\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f7\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff';

/**
 * MacRomanEncoding。
 * MacRoman 与 WinAnsi 只在 0x80..0xFF 不同（0x20..0x7E 一样），
 * 所以这里只写高 128 位，省一半表体积也少一次校对机会。
 */
export const MAC_ROMAN_HIGH =
  '\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8' +
  '\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc' +
  '\u2020\u00b0\u00a2\u00a3\u00a7\u2022\u00b6\u00df\u00ae\u00a9\u2122\u00b4\u00a8\u2260\u00c6\u00d8' +
  '\u221e\u00b1\u2264\u2265\u00a5\u00b5\u2202\u2211\u220f\u03c0\u222b\u00aa\u00ba\u03a9\u00e6\u00f8' +
  '\u00bf\u00a1\u00ac\u221a\u0192\u2248\u2206\u00ab\u00bb\u2026\u00a0\u00c0\u00c3\u00d5\u0152\u0153' +
  '\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u25ca\u00ff\u0178\u2044\u20ac\u2039\u203a\ufb01\ufb02' +
  '\u2021\u00b7\u201a\u201e\u2030\u00c2\u00ca\u00c1\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u00d3\u00d4' +
  '\uf8ff\u00d2\u00da\u00db\u00d9\u0131\u02c6\u02dc\u00af\u02d8\u02d9\u02da\u00b8\u02dd\u02db\u02c7';

/**
 * PDFDocEncoding 的高半区（0x80..0xFF，用于文档信息字典里的字符串）。
 *
 * ⚠ 这里必须按 ISO 32000-1 附录 D 的表 D.2 写：0x80..0x9F 是标点/符号区
 * （0x80 = •、0x81 = † … 0xA0 = €），0xA0 之后才与 Latin-1 相同。
 * 早期版本这段表是从 0x18 起的「特殊字符区」拼出来的，整体错位，
 * 于是 /Info 里一个 0x80 会解成 ˘ 而不是 •。0x9F 在规范里未定义，用 \u0000 占位。
 */
export const PDF_DOC_HIGH =
  '\u2022\u2020\u2021\u2026\u2014\u2013\u0192\u2044' +
  '\u2039\u203a\u2212\u2030\u201e\u201c\u201d\u2018' +
  '\u2019\u201a\u2122\ufb01\ufb02\u0141\u0152\u0160' +
  '\u0178\u017d\u0131\u0142\u0153\u0161\u017e\u0000' +
  '\u20ac\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9' +
  '\u00aa\u00ab\u00ac\u00ad\u00ae\u00af\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9' +
  '\u00ba\u00bb\u00bc\u00bd\u00be\u00bf\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9' +
  '\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d7\u00d8\u00d9' +
  '\u00da\u00db\u00dc\u00dd\u00de\u00df\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9' +
  '\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f7\u00f8\u00f9' +
  '\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff';

/** PDFDocEncoding 在 0x18..0x1F 的特殊字符（其余低区与 ASCII 相同）。 */
const PDF_DOC_LOW = '\u02d8\u02c7\u02c6\u02d9\u02dd\u02db\u02da\u02dc';

/**
 * 按 PDFDocEncoding 解一段字节（文档信息字典的默认编码）。
 *
 * 注意：/Info 的字符串也可能是 UTF-16BE（带 BOM），那条路在调用方判断。
 * 这里只负责「没有 BOM」的情形 —— 0x80..0x9F 不能直接当 Latin-1，
 * 那一段是 PDFDocEncoding 自己的标点区。
 */
export function decodePdfDocEncoding(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0x18 && b <= 0x1f) out += PDF_DOC_LOW[b - 0x18];
    else if (b >= 0x80 && b <= 0x9f) {
      const ch = PDF_DOC_HIGH[b - 0x80];
      if (ch !== '\u0000') out += ch;
    } else if (b === 0x7f) {
      // 规范里 0x7F 未定义，跳过
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

/** Symbol 字体私用区（0x20..0xFF 中 0xF0xx 段）常用映射。 */
export const SYMBOL_GLYPHS: Record<string, string> = {
  alpha: '\u03b1', beta: '\u03b2', chi: '\u03c7', delta: '\u03b4', epsilon: '\u03b5',
  eta: '\u03b7', gamma: '\u03b3', iota: '\u03b9', kappa: '\u03ba', lambda: '\u03bb',
  mu: '\u03bc', nu: '\u03bd', omega: '\u03c9', phi: '\u03c6', pi: '\u03c0',
  psi: '\u03c8', rho: '\u03c1', sigma: '\u03c3', tau: '\u03c4', theta: '\u03b8',
  upsilon: '\u03c5', xi: '\u03be', zeta: '\u03b6', Delta: '\u0394', Omega: '\u03a9',
  Phi: '\u03a6', Pi: '\u03a0', Sigma: '\u03a3', Theta: '\u0398', Lambda: '\u039b',
  Xi: '\u039e', Psi: '\u03a8', infinity: '\u221e', integral: '\u222b',
  summation: '\u2211', product: '\u220f', radical: '\u221a', approxequal: '\u2248',
  lessequal: '\u2264', greaterequal: '\u2265', notequal: '\u2260', partialdiff: '\u2202',
  degree: '\u00b0', plusminus: '\u00b1', multiply: '\u00d7', divide: '\u00f7',
  element: '\u2208', notelement: '\u2209', intersection: '\u2229', union: '\u222a',
  arrowright: '\u2192', arrowleft: '\u2190', arrowup: '\u2191', arrowdown: '\u2193',
  arrowboth: '\u2194', percent: '%', period: '.', comma: ',', space: ' ',
  minus: '\u2212', bullet: '\u2022', logicalnot: '\u00ac', logicaland: '\u2227',
  logicalor: '\u2228', existential: '\u2203', universal: '\u2200', emptyset: '\u2205',
  congruent: '\u2245', equivalence: '\u2261', proportional: '\u221d', therefore: '\u2234',
  openbullet: '\u25e6', club: '\u2663', diamond: '\u2666', heart: '\u2665', spade: '\u2660',
  circleplus: '\u2295', circleminus: '\u2296', circlemultiply: '\u2297', circledivide: '\u2298',
  angle: '\u2220', perpendicular: '\u22a5', parallel: '\u2225', filesystem: '\u25a0',
};

/** 标准字形名 -> Unicode（Differences 数组用）。覆盖 Latin/标点/常用符号。 */
export const GLYPH_NAMES: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1',
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~',
  exclamdown: '\u00a1', cent: '\u00a2', sterling: '\u00a3', currency: '\u00a4',
  yen: '\u00a5', brokenbar: '\u00a6', section: '\u00a7', dieresis: '\u00a8',
  copyright: '\u00a9', ordfeminine: '\u00aa', guillemotleft: '\u00ab', logicalnot: '\u00ac',
  registered: '\u00ae', macron: '\u00af', degree: '\u00b0', plusminus: '\u00b1',
  twosuperior: '\u00b2', threesuperior: '\u00b3', acute: '\u00b4', mu: '\u00b5',
  paragraph: '\u00b6', periodcentered: '\u00b7', cedilla: '\u00b8', onesuperior: '\u00b9',
  ordmasculine: '\u00ba', guillemotright: '\u00bb', onequarter: '\u00bc',
  onehalf: '\u00bd', threequarters: '\u00be', questiondown: '\u00bf',
  Agrave: '\u00c0', Aacute: '\u00c1', Acircumflex: '\u00c2', Atilde: '\u00c3',
  Adieresis: '\u00c4', Aring: '\u00c5', AE: '\u00c6', Ccedilla: '\u00c7',
  Egrave: '\u00c8', Eacute: '\u00c9', Ecircumflex: '\u00ca', Edieresis: '\u00cb',
  Igrave: '\u00cc', Iacute: '\u00cd', Icircumflex: '\u00ce', Idieresis: '\u00cf',
  Eth: '\u00d0', Ntilde: '\u00d1', Ograve: '\u00d2', Oacute: '\u00d3',
  Ocircumflex: '\u00d4', Otilde: '\u00d5', Odieresis: '\u00d6', multiply: '\u00d7',
  Oslash: '\u00d8', Ugrave: '\u00d9', Uacute: '\u00da', Ucircumflex: '\u00db',
  Udieresis: '\u00dc', Yacute: '\u00dd', Thorn: '\u00de', germandbls: '\u00df',
  agrave: '\u00e0', aacute: '\u00e1', acircumflex: '\u00e2', atilde: '\u00e3',
  adieresis: '\u00e4', aring: '\u00e5', ae: '\u00e6', ccedilla: '\u00e7',
  egrave: '\u00e8', eacute: '\u00e9', ecircumflex: '\u00ea', edieresis: '\u00eb',
  igrave: '\u00ec', iacute: '\u00ed', icircumflex: '\u00ee', idieresis: '\u00ef',
  eth: '\u00f0', ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3',
  ocircumflex: '\u00f4', otilde: '\u00f5', odieresis: '\u00f6', divide: '\u00f7',
  oslash: '\u00f8', ugrave: '\u00f9', uacute: '\u00fa', ucircumflex: '\u00fb',
  udieresis: '\u00fc', yacute: '\u00fd', thorn: '\u00fe', ydieresis: '\u00ff',
  dotlessi: '\u0131', Lslash: '\u0141', lslash: '\u0142', OE: '\u0152', oe: '\u0153',
  Scaron: '\u0160', scaron: '\u0161', Zcaron: '\u017d', zcaron: '\u017e',
  Ydieresis: '\u0178', florin: '\u0192', circumflex: '\u02c6', caron: '\u02c7',
  breve: '\u02d8', dotaccent: '\u02d9', ring: '\u02da', ogonek: '\u02db',
  tilde: '\u02dc', hungarumlaut: '\u02dd', endash: '\u2013', emdash: '\u2014',
  quoteleft: '\u2018', quoteright: '\u2019', quotesinglbase: '\u201a',
  quotedblleft: '\u201c', quotedblright: '\u201d', quotedblbase: '\u201e',
  dagger: '\u2020', daggerdbl: '\u2021', bullet: '\u2022', ellipsis: '\u2026',
  perthousand: '\u2030', guilsinglleft: '\u2039', guilsinglright: '\u203a',
  fraction: '\u2044', Euro: '\u20ac', trademark: '\u2122', minus: '\u2212',
  fi: '\ufb01', fl: '\ufb02', ff: '\ufb00', ffi: '\ufb03', ffl: '\ufb04',
  'nbspace': '\u00a0', 'nonbreakingspace': '\u00a0', 'apple': '\uf8ff',
  'SF100000': '\u2500', 'SF110000': '\u2502',
  // 未映射字形（.notdef 等）：显式给出不可见占位，避免误判为字母
  '.notdef': '',
  'controlNULL': '', 'Lslash_': '',
};

const TABLE_CACHE = new Map<string, string>();

/**
 * 取基编码表。
 * 表被缓存，因为一页里可能有几十个字体引用同一个编码名。
 */
export function baseEncodingTable(name: string): string {
  const cached = TABLE_CACHE.get(name);
  if (cached) return cached;
  let table: string;
  switch (name) {
    case 'WinAnsiEncoding':
      table = WIN_ANSI_ENCODING;
      break;
    case 'MacRomanEncoding':
      table = ASCII_LOW + MAC_ROMAN_HIGH;
      break;
    case 'PDFDocEncoding':
      table = ASCII_LOW + PDF_DOC_HIGH;
      break;
    case 'StandardEncoding':
    default:
      table = STANDARD_ENCODING;
      break;
  }
  TABLE_CACHE.set(name, table);
  return table;
}

/** 取编码表里某个字节对应的 Unicode；未定义返回 undefined。 */
export function lookupEncoding(table: string, code: number): string | undefined {
  if (code < 0x20) return undefined;
  const offset = code - 0x20;
  if (offset >= table.length) return undefined;
  const ch = table[offset];
  if (ch === '\u0000' || ch === undefined) return undefined;
  return ch;
}

/** 解析 `/Differences [ 65 /Aacute 66 /Bacute ]` 形式的名字列表 -> Unicode。 */
export function glyphNameToUnicode(name: string): string | undefined {
  const direct = GLYPH_NAMES[name];
  if (direct !== undefined) return direct === '' ? undefined : direct;
  const sym = SYMBOL_GLYPHS[name];
  if (sym !== undefined) return sym;
  // uniXXXX / uXXXX[XX] 形式（很多生成器用它表达 CJK 字形）
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uni) return String.fromCharCode(Number.parseInt(uni[1], 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(Number.parseInt(u[1], 16));
  // 形如 g23 / cid123 / index45 的子集化名字：没有可推导的 Unicode
  return undefined;
}
