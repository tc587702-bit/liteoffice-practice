/**
 * RTF 解析器（够用版）。
 *
 * RTF 的语法很小，但有几个坑必须绕开，否则「打不开」或「乱码」：
 *
 * 1. **未知目标组必须整组跳过**
 *    `{\*\generator Riched20 10.0}` 这类组的第一个控制字是 `\*`，
 *    后面跟的是应用私有数据（里面可能包含看起来像控制字的字节）。
 *    同理 `{\fonttbl}`、`{\colortbl}`、`{\stylesheet}`、`{\pict}` 都不是正文。
 *    跳过的实现要按**组**记账（本文件的 skipDepth），不能只找配对的 `}`：
 *    组内可能还有嵌套组与 `\{` `\}` 转义。
 *
 * 2. **`\'hh` 是按「当前代码页」解释的字节，不是 Unicode 码点**
 *    中文 RTF 里 `\'c4\'e3` 在 \ansi + GBK 下是「你」。所以：
 *      - 词法层把**连续的** `\'hh` 攒成一段再交给 TextDecoder（逐个字节解码
 *        会把双字节汉字拆成两个替换字符 —— 这是最常见的乱码成因）
 *      - 代码页优先取 \ansicpgNNN，其次取字体表的 \fcharset134/136/…（中文
 *        RTF 经常只写 fcharset 而不写 ansicpg，只看 ansicpg 一样会乱码）
 *
 * 3. **`\uNNNN` 的负数与代理对**
 *    `\u` 后是带符号 16 位十进制，负数要加 65536；UTF-16 代理对要把连续两个
 *    `\u` 合并成一个码点，否则会出现孤立代理（显示成方块）。
 *    `\uN?` 里那个替代字符（通常 '?'）必须吃掉，不能输出。
 *
 * 4. **分组即样式作用域**
 *    `{...}` 内的样式改动在组结束时应回滚 —— 用组栈保存样式快照实现。
 *
 * 如实列出做不到的（一律降级 + warning，绝不抛错）：
 *   - 图片（\pict）：整组跳过
 *   - 表格（\trowd/\cellx/\intbl）：单元格文本按普通段落输出，不还原表格
 *   - 域（\field）、脚注、批注、书签、HTML 目标：跳过
 *   - 段落边框/底纹/制表位：不还原（\brdrb 简化为水平线）
 *   - 列表（\pn…）：不还原编号，仅保留文本
 */
import type { Block, FormatId, LiteDocument, Paragraph, ParaStyle, Run, RunStyle } from '../../core/src/model.ts';
import type { ReadContext } from '../../core/src/registry.ts';
import { makeDecoder } from './decode.ts';
import { DocBuilder } from './builder.ts';
import { twipToPt } from '../../core/src/units.ts';

/**
 * 需要整组跳过的目标名（都不是正文）。
 *
 * 踩过的坑（两次都踩在「目标名匹配」上，值得记下来）：
 *   - 表里不能放 `generator`。真实文件写作 `{\*\generator ...}`，`\*` 分支
 *     已经覆盖；一旦按裸名字匹配，文档头 `{\rtf1\ansi...}` 的目标名会被同一个
 *     正则误判成 "rtf"（`\rtf1` 里数字不属于字母），于是整篇正文被跳过，
 *     表现为「打开后一片空白」。
 *   - 表里也不能放 `fonttbl`。字体表是**要读**的（字体名与 \fcharset 决定
 *     \'hh 用哪个代码页解码，缺了中文必乱码），它由 inFontTable 模式处理。
 */
const SKIP_DESTINATIONS = new Set([
  'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata',
  'colorschememapping', 'latentstyles', 'datastore', 'listtable', 'listoverridetable',
  'rsidtbl', 'filetbl', 'revtbl', 'xmlnstbl', 'upr', 'mmathPr',
  'nonshppict', 'shppict', 'fldinst', 'bkmkstart', 'bkmkend',
]);

interface RtfState {
  bold: number;
  italic: number;
  underline: number;
  strike: number;
  hidden: boolean;
  /** 字号，半磅 */
  sizeHalfPt: number | undefined;
  colorIndex: number | undefined;
  fontIndex: number | undefined;
  vertAlign: 'baseline' | 'subscript' | 'superscript' | undefined;
  caps: 'none' | 'small' | 'all' | undefined;
  /** 字间距，pt */
  letterSpacing: number | undefined;
}

interface ParaState {
  align: ParaStyle['align'];
  indentStartTwip: number;
  indentEndTwip: number;
  indentFirstTwip: number;
  spaceBeforeTwip: number;
  spaceAfterTwip: number;
  lineHeight: number | undefined;
}

function newRtfState(): RtfState {
  return {
    bold: 0,
    italic: 0,
    underline: 0,
    strike: 0,
    hidden: false,
    sizeHalfPt: undefined,
    colorIndex: undefined,
    fontIndex: undefined,
    vertAlign: undefined,
    caps: undefined,
    letterSpacing: undefined,
  };
}

function newParaState(): ParaState {
  return { align: undefined, indentStartTwip: 0, indentEndTwip: 0, indentFirstTwip: 0, spaceBeforeTwip: 0, spaceAfterTwip: 0, lineHeight: undefined };
}

export interface RtfParseResult {
  blocks: Block[];
  warnings: string[];
  truncated: boolean;
  /** 探测到的字符集代码页（0 表示未声明） */
  ansicpg: number;
}

export interface RtfOptions {
  maxBlocks?: number;
  onWarning?: (m: string) => void;
}

/**
 * 解析 RTF 文本为块序列。
 *
 * 单遍字符扫描 + 显式组栈。不对输入做完整性假设：未闭合的组、孤立的 `}`、
 * 截断在 `\` 中间的输入都能正常收尾（被截断的 RTF 是最常见的输入）。
 */
export function parseRtf(input: string, options: RtfOptions = {}): RtfParseResult {
  const blocks: Block[] = [];
  const warnings: string[] = [];
  const maxBlocks = options.maxBlocks ?? Number.POSITIVE_INFINITY;
  let truncated = false;
  /** 是否曾经有内容因为超出块数上限而被丢掉 */
  let overflowed = false;

  const warn = (m: string): void => {
    if (warnings.length < 100 && !warnings.includes(m)) warnings.push(m);
    options.onWarning?.(m);
  };

  const p = new RtfParser(input, warn);
  let st = newRtfState();
  let ps = newParaState();
  const groupStack: { st: RtfState; ps: ParaState; wasSkipping: boolean; wasDrop: boolean }[] = [];
  let runs: Run[] = [];
  let paraStarted = false;
  /**
   * 字符预算。
   *
   * 为什么要它：RTF 里一个「段落块」可能承载几万个字符（整篇正文只用
   * `\line` 换行、几乎不写 `\par` 的文件很常见，生成器导出的更是如此），
   * 只按块数上限判断完全拦不住。maxBlocks 换算成字符预算（每块约 4096 字符）
   * 才能在「块数少但总量巨大」时不失控 —— 这也是上限存在的意义。
   */
  const charBudget = maxBlocks === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : maxBlocks * 4096;
  let charsEmitted = 0;

  const flush = (force = false): void => {
    if (!paraStarted && !force) return;
    const style = paraStyleOf(ps);
    const paragraph: Paragraph = { kind: 'para', runs: runs.length ? runs : [{ text: '' }] };
    if (style) paragraph.style = style;
    runs = [];
    paraStarted = false;
    ps = newParaState();
    if (blocks.length >= maxBlocks) {
      // 已经满了：这一段以及后续内容都被丢掉。true 要落进 truncated，
      // 让用户知道「看到的不完整」而不是以为文件就这么长。
      overflowed = true;
      return;
    }
    blocks.push(paragraph);
  };

  const addText = (text: string): void => {
    if (!text) return;
    // 注意：要按「加上这一段之后是否超预算」判断。只看已发量的话，
    // RTF 里一整篇正文常常是**一个**巨型文本块，第一块就能把预算一次打穿。
    if (charsEmitted + text.length > charBudget) {
      overflowed = true;
      return;
    }
    charsEmitted += text.length;
    const style = runStyleOf(st, p);
    runs.push(style ? { text, style } : { text });
    paraStarted = true;
  };

  for (;;) {
    const tok = p.nextToken();
    if (tok === null) break;
    const skipping = p.skipping;
    switch (tok.type) {
      case 'groupOpen':
        groupStack.push({ st: { ...st }, ps: { ...ps }, wasSkipping: skipping, wasDrop: p.dropContent });
        break;
      case 'groupClose': {
        const saved = groupStack.pop();
        if (!saved) {
          warn('RTF 中存在多余的 }，已忽略');
          break;
        }
        if (p.skipDepth > 0) {
          // 仍在跳过中：继续丢内容
          break;
        }
        st = saved.st;
        ps = saved.ps;
        break;
      }
      case 'control': {
        if (skipping) break;
        const r = handleControl(tok.word, tok.param, st, ps, p);
        if (r.kind === 'style') st = r.st;
        else if (r.kind === 'para') ps = r.ps;
        else if (r.kind === 'par') flush(true);
        else if (r.kind === 'pagebreak') {
          flush(true);
          if (blocks.length < maxBlocks) blocks.push({ kind: 'pagebreak' });
        } else if (r.kind === 'tab') addText('\t');
        else if (r.kind === 'rule') {
          flush();
          if (blocks.length < maxBlocks) blocks.push({ kind: 'rule', thickness: 0.75 });
        }
        break;
      }
      case 'text':
        if (!skipping) addText(tok.text);
        break;
      case 'bytes':
        if (!skipping) addText(p.decodeHexBytes(tok.bytes));
        break;
      case 'unicode':
        if (!skipping) addText(p.decodeUnicode(tok.code));
        break;
      case 'warning':
        warn(tok.message);
        break;
      default:
        break;
    }
  }
  flush(true);
  // 收尾：清掉尾部纯空的段落（RTF 文件几乎总以 "}}" 结尾，会多出一个空段落）
  while (blocks.length > 0 && blocks[blocks.length - 1].kind === 'para') {
    const last = blocks[blocks.length - 1] as Paragraph;
    if (last.runs.length > 0 && last.runs.every((r) => r.text === '')) blocks.pop();
    else break;
  }
  if (!blocks.length) blocks.push({ kind: 'para', runs: [{ text: '' }] });
  return { blocks, warnings, truncated: truncated || overflowed, ansicpg: p.ansicpg };
}

function runStyleOf(st: RtfState, p: RtfParser): RunStyle | undefined {
  const out: RunStyle = {};
  let any = false;
  if (st.bold > 0) {
    out.bold = true;
    any = true;
  }
  if (st.italic > 0) {
    out.italic = true;
    any = true;
  }
  if (st.underline > 0) {
    out.underline = true;
    any = true;
  }
  if (st.strike > 0) {
    out.strike = true;
    any = true;
  }
  if (st.hidden) {
    out.hidden = true;
    any = true;
  }
  if (st.sizeHalfPt !== undefined && st.sizeHalfPt > 0) {
    out.size = st.sizeHalfPt / 2; // RTF 字号是半磅
    any = true;
  }
  const color = p.colorAt(st.colorIndex);
  if (color) {
    out.color = color;
    any = true;
  }
  const font = p.fontAt(st.fontIndex);
  if (font) {
    out.font = font;
    any = true;
  }
  if (st.vertAlign && st.vertAlign !== 'baseline') {
    out.vertAlign = st.vertAlign;
    any = true;
  }
  if (st.caps && st.caps !== 'none') {
    out.caps = st.caps;
    any = true;
  }
  if (st.letterSpacing !== undefined && st.letterSpacing !== 0) {
    out.letterSpacing = st.letterSpacing;
    any = true;
  }
  return any ? out : undefined;
}

/** 段落状态 -> ParaStyle。twip 必须在这里换算成 pt（模型内唯一长度单位）。 */
function paraStyleOf(ps: ParaState): ParaStyle | undefined {
  const out: ParaStyle = {};
  let any = false;
  if (ps.align) {
    out.align = ps.align;
    any = true;
  }
  if (ps.indentStartTwip) {
    out.indentStart = twipToPt(ps.indentStartTwip);
    any = true;
  }
  if (ps.indentEndTwip) {
    out.indentEnd = twipToPt(ps.indentEndTwip);
    any = true;
  }
  if (ps.indentFirstTwip) {
    out.indentFirst = twipToPt(ps.indentFirstTwip);
    any = true;
  }
  if (ps.spaceBeforeTwip) {
    out.spaceBefore = twipToPt(ps.spaceBeforeTwip);
    any = true;
  }
  if (ps.spaceAfterTwip) {
    out.spaceAfter = twipToPt(ps.spaceAfterTwip);
    any = true;
  }
  if (ps.lineHeight !== undefined) {
    out.lineHeight = ps.lineHeight;
    any = true;
  }
  return any ? out : undefined;
}

type ControlResult =
  | { kind: 'none' }
  | { kind: 'style'; st: RtfState }
  | { kind: 'para'; ps: ParaState }
  | { kind: 'par' }
  | { kind: 'pagebreak' }
  | { kind: 'tab' }
  | { kind: 'rule' };

/**
 * 处理一个控制字，返回新状态（不可变更新，便于组栈快照回滚）。
 * 不认识的控制字一律 none —— RTF 里未知控制字极多，跳过它们才是正确行为，
 * 「遇到不认识的就报错」会让绝大多数真实文件打不开。
 */
function handleControl(word: string, param: number | undefined, st: RtfState, ps: ParaState, p: RtfParser): ControlResult {
  const on = param === undefined || param !== 0;
  switch (word) {
    /* ---- 字符样式 ---- */
    case 'b':
      return { kind: 'style', st: { ...st, bold: on ? st.bold + 1 : 0 } };
    case 'i':
      return { kind: 'style', st: { ...st, italic: on ? st.italic + 1 : 0 } };
    case 'ul':
      return { kind: 'style', st: { ...st, underline: on ? st.underline + 1 : 0 } };
    case 'ulnone':
      return { kind: 'style', st: { ...st, underline: 0 } };
    case 'strike':
      return { kind: 'style', st: { ...st, strike: on ? st.strike + 1 : 0 } };
    case 'v':
      return { kind: 'style', st: { ...st, hidden: on } };
    case 'plain': {
      // \plain 是「回到无格式」：保留字体/颜色索引（它们由 \f/\cf 单独管理）
      const fresh = newRtfState();
      fresh.fontIndex = st.fontIndex;
      fresh.colorIndex = st.colorIndex;
      fresh.sizeHalfPt = st.sizeHalfPt;
      return { kind: 'style', st: fresh };
    }
    case 'fs':
      if (param === undefined) return { kind: 'none' };
      return { kind: 'style', st: { ...st, sizeHalfPt: Math.abs(param) } };
    case 'f':
      if (param === undefined) return { kind: 'none' };
      // \fN 同时决定后续 \'hh 用哪个代码页（见 RtfParser#codepage）
      p.setActiveFont(param);
      return { kind: 'style', st: { ...st, fontIndex: param } };
    case 'cf':
      if (param === undefined) return { kind: 'none' };
      return { kind: 'style', st: { ...st, colorIndex: param } };
    case 'super':
      return { kind: 'style', st: { ...st, vertAlign: 'superscript' } };
    case 'sub':
      return { kind: 'style', st: { ...st, vertAlign: 'subscript' } };
    case 'nosupersub':
      return { kind: 'style', st: { ...st, vertAlign: 'baseline' } };
    case 'caps':
      return { kind: 'style', st: { ...st, caps: 'all' } };
    case 'scaps':
      return { kind: 'style', st: { ...st, caps: 'small' } };
    case 'expnd':
      // \expndN 的单位是 1/4 pt
      if (param === undefined) return { kind: 'none' };
      return { kind: 'style', st: { ...st, letterSpacing: param / 4 } };

    /* ---- 段落样式 ---- */
    case 'ql':
      return { kind: 'para', ps: { ...ps, align: 'left' } };
    case 'qc':
      return { kind: 'para', ps: { ...ps, align: 'center' } };
    case 'qr':
      return { kind: 'para', ps: { ...ps, align: 'right' } };
    case 'qj':
      return { kind: 'para', ps: { ...ps, align: 'justify' } };
    case 'li':
      return { kind: 'para', ps: { ...ps, indentStartTwip: param ?? 0 } };
    case 'ri':
      return { kind: 'para', ps: { ...ps, indentEndTwip: param ?? 0 } };
    case 'fi':
      return { kind: 'para', ps: { ...ps, indentFirstTwip: param ?? 0 } };
    case 'sb':
      return { kind: 'para', ps: { ...ps, spaceBeforeTwip: param ?? 0 } };
    case 'sa':
      return { kind: 'para', ps: { ...ps, spaceAfterTwip: param ?? 0 } };
    case 'sl':
      // \slN：N/240 英寸的精确行距；\slmult1 时 N/240 是倍数
      if (param === undefined) return { kind: 'none' };
      return { kind: 'para', ps: { ...ps, lineHeight: param / 240 } };
    case 'pard':
      return { kind: 'para', ps: newParaState() };

    /* ---- 结构 ---- */
    case 'par':
    case 'line':
      return { kind: 'par' };
    case 'page':
      return { kind: 'pagebreak' };
    case 'tab':
      return { kind: 'tab' };
    case 'sect':
    case 'sectd':
      return { kind: 'par' };
    case 'brdrb':
    case 'brdrt':
      return { kind: 'rule' };

    /* ---- 文档头 ----
       \ansicpg 必须记住：它决定 \'hh 字节怎么解码（见 decodeHexBytes） */
    case 'ansicpg':
      if (param !== undefined && param > 0) p.ansicpg = param;
      return { kind: 'none' };
    case 'deff':
      if (param === undefined) return { kind: 'none' };
      p.defaultFont = param;
      // 默认字体必须**同时**落到正文样式上，否则
      // `\deff0 ... {\fonttbl{\f0 Arial;}}正文` 里的正文永远拿不到字体
      // （真实 RTF 很少为每段都写 \fN，只靠 \deff 声明默认字体）。
      p.setActiveFont(param);
      return { kind: 'style', st: { ...st, fontIndex: param } };
    case 'uc':
      if (param !== undefined) p.ucSkip = Math.max(0, Math.min(4, param));
      return { kind: 'none' };
    case 'rtlch':
    case 'ltrch':
    case 'loch':
    case 'hich':
    case 'dbch':
    case 'upr':
    case 'ud':
    case 'lang':
    case 'langfe':
    case 'langnp':
    case 'insrsid':
    case 'charrsid':
    case 'rtlpar':
    case 'ltrpar':
      return { kind: 'none' };
    default:
      // 未知控制字：跳过即可（RTF 的可扩展性正是靠这条实现的）
      return { kind: 'none' };
  }
}

/* ==================================================================== */
/* 词法层                                                               */
/* ==================================================================== */

type Token =
  | { type: 'groupOpen' }
  | { type: 'groupClose' }
  | { type: 'control'; word: string; param: number | undefined }
  | { type: 'text'; text: string }
  | { type: 'bytes'; bytes: number[] }
  | { type: 'unicode'; code: number }
  | { type: 'warning'; message: string };

/**
 * RTF 词法分析器。
 *
 * 跳过的责任放在词法层（skipDepth），因为 `{\*\...}` 组内的内容必须先被正确
 * 切分成 token 才能保证边界正确 —— 不能简单「找配对的 }」，组内可能含
 * 嵌套组以及 `\{` `\}` 转义。
 */
class RtfParser {
  private readonly src: string;
  private readonly warn: (m: string) => void;
  private pos = 0;
  ansicpg = 0;
  defaultFont = 0;
  /** `\uN` 后要跳过的替代字符个数，由 \ucN 决定，默认 1 */
  ucSkip = 1;
  /** >0 表示正在跳过的目标组 */
  skipDepth = 0;
  /** 当前组是否是完全丢弃内容（如 colortbl） */
  dropContent = false;
  /** 是否在字体表里（字体表要读，不能丢） */
  private inFontTable = false;
  /** 进入字体表时的组深度，用于判断何时推出 */
  private fontTableDepth = 0;
  /**
   * 「丢弃内容」组的结束深度。
   * 用 stack.length 记录而不是布尔栈：跳过组内部的嵌套组也会改动深度，
   * 只有深度回到进入时的值才算这个组结束（否则 colortbl 的丢字状态会提前
   * 被内层 `;` 之后的 `}` 解除，把颜色表当正文渲染出来）。
   */
  private readonly dropDepth = new Map<number, { drop: boolean; inFont: boolean }>();
  private groupDepth = 0;
  /** 字体表：index -> 字体名 / 字符集号 */
  private readonly fonts: string[] = [];
  private readonly fontCharsets: number[] = [];
  private readonly colors: string[] = [];
  private pendingFontName: string | null = null;
  private pendingCharset: number | null = null;
  private pendingColor: [number, number, number] | null = null;
  private inFontTable = false;
  private tableField = 0;
  private warnedPict = false;
  private warnedTable = false;
  /** 待配对的高代理 */
  private pendingHighSurrogate = 0;

  constructor(src: string, warn: (m: string) => void) {
    this.src = src;
    this.warn = warn;
  }

  /** 当前是否应当丢弃内容（跳过目标组，或在字体表/颜色表里） */
  get skipping(): boolean {
    return this.skipDepth > 0;
  }

  colorAt(index: number | undefined): string | undefined {
    if (index === undefined || index === 0) return undefined;
    return this.colors[index];
  }

  fontAt(index: number | undefined): string | undefined {
    if (index === undefined) return undefined;
    return this.fonts[index];
  }

  /**
   * 该用哪个代码页解释 `\'hh`。
   *
   * 优先级：**当前字体的字符集** > \ansicpgNNN > 默认 1252。
   *
   * 为什么字体优先：`\fcharset65001` 表示该字体承载的是 UTF-8 字节，此时
   * `\'e4\'bd\'a0` 应该按 UTF-8 解成「你」；而 `\fcharset134` 表示 GBK。
   * 只看 \ansicpg 会把 UTF-8 的 `\'hh` 解成三个拉丁乱码字符
   * （这是真实存在的写法：一些导出器会把非 ASCII 文本全部转成 \'hh）。
   * 踩过的坑：早期版本用 `for (const cs of this.fontCharsets)` 遍历整个表，
   * 会让**任意一个**字体的 charset 影响全篇，与当前字体无关。
   */
  private codepage(): number {
    // 1) 显式代码页最权威
    if (this.ansicpg && this.ansicpg !== 1252) return this.ansicpg;
    // 2) 当前字体的字符集
    const charset = this.fontCharsetOf(this.activeFont);
    if (charset !== undefined) {
      if (charset === 134 || charset === 936) return 936;
      if (charset === 136) return 950;
      if (charset === 129) return 949;
      if (charset === 128) return 932;
      if (charset === 65001) return 65001;
    }
    // 3) 字体表里出现过的非零字符集（中文 RTF 常只写 \fcharset136 之类）
    if (this.fontTableCharset !== 0) return this.fontTableCharset;
    if (this.ansicpg) return this.ansicpg;
    return 1252;
  }

  /** 字体索引 -> 字符集号（字体表里读到的） */
  private fontCharsetOf(index: number | undefined): number | undefined {
    if (index === undefined) return undefined;
    const cs = this.fontCharsets[index];
    return cs === 0 ? undefined : cs;
  }

  /** 正文当前生效的字体索引：没写 \fN 时用 \deff 指定的默认字体。 */
  private activeFont: number | undefined;

  /** 由 handleControl 的 'f' 分支与 deff 分支调用 */
  setActiveFont(index: number | undefined): void {
    this.activeFont = index;
  }

  /**
   * 解码一段连续的 `\'hh` 字节。
   * 必须成段解码：GBK 汉字是两个字节，逐字节解码会得到两个替换字符。
   */
  decodeHexBytes(bytes: readonly number[]): string {
    const cp = this.codepage();
    const label = cp === 936 || cp === 134 ? 'gb18030' : cp === 950 ? 'big5' : cp === 949 ? 'euc-kr' : cp === 932 ? 'shift_jis' : cp === 65001 ? 'utf-8' : 'windows-1252';
    try {
      return new TextDecoder(label).decode(new Uint8Array(bytes));
    } catch {
      return makeDecoder('latin1').decode(new Uint8Array(bytes));
    }
  }

  /**
   * 解码 `\uNNNN`。负数加 65536；代理对的两个 \u 合并成一个码点。
   * 孤立代理（残缺文件）输出 U+FFFD 而不是抛错。
   */
  decodeUnicode(code: number): string {
    let cp = code < 0 ? code + 65536 : code;
    if (this.pendingHighSurrogate) {
      const high = this.pendingHighSurrogate;
      this.pendingHighSurrogate = 0;
      if (cp >= 0xdc00 && cp <= 0xdfff) {
        return String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + (cp - 0xdc00));
      }
      if (cp >= 0xd800 && cp <= 0xdbff) {
        this.pendingHighSurrogate = cp;
        return '\ufffd';
      }
      return `\ufffd${cp >= 0x20 ? String.fromCodePoint(cp) : ''}`;
    }
    if (cp >= 0xd800 && cp <= 0xdbff) {
      this.pendingHighSurrogate = cp;
      return '';
    }
    if (cp >= 0xdc00 && cp <= 0xdfff) return '\ufffd';
    return String.fromCodePoint(cp);
  }

  nextToken(): Token | null {
    for (;;) {
      if (this.pos >= this.src.length) return null;
      const c = this.src[this.pos];

      if (c === '{') {
        this.pos++;
        this.groupDepth++;
        // 先把 `{` 之后的目标名解析出来。
        //
        // 目标名的形态是 `\name` 或 `\*\name`：`{\*\generator ...}` 里 `*` 之后
        // **还有**一个反斜杠，所以解析完 `*` 后必须再跳过一个 `\`，否则名字会读成空
        // （踩过的坑：漏掉这一步，`{\*\...}` 会被当成普通组，书签/生成器私有数据
        //   就被渲染成正文了）。
        // 另外 `{` 与 `\` 之间可以有空格（`{\* \generator ...}`），也要先跳过。
        // 这里逐字符判断而不用正则：`\ansi{\*\generator` 这种写法下，
        // 从 `{` 之后取「第一个控制字」的正则会去匹配前一个反斜杠（`\ansi` 的），
        // 目标名被读成 "ansi*"，同样导致私有数据泄漏到正文。
        let q = this.pos;
        while (q < this.src.length && (this.src[q] === ' ' || this.src[q] === '\t' || this.src[q] === '\n' || this.src[q] === '\r')) q++;
        if (this.src[q] === '\\') {
          let r = q + 1;
          let star = false;
          if (this.src[r] === '*') {
            star = true;
            r++;
            // `*` 与名字之间还有一个反斜杠
            if (this.src[r] === '\\') r++;
          }
          const nameStart = r;
          while (r < this.src.length && /[a-zA-Z]/.test(this.src[r])) r++;
          const dest = this.src.slice(nameStart, r).toLowerCase();
          if (dest) {
            if (star || SKIP_DESTINATIONS.has(dest)) this.beginSkip(dest);
            else if (dest === 'fonttbl') this.enterFontTable();
          }
        }
        return { type: 'groupOpen' };
      }

      if (c === '}') {
        this.pos++;
        this.groupDepth = Math.max(0, this.groupDepth - 1);
        // 「丢弃内容」组的结束靠深度判定：只有回到进入时的深度才恢复，
        // 否则组内的嵌套组会提前解除丢弃状态（详见 dropDepth 的注释）
        const restore = this.dropDepth.get(this.groupDepth);
        if (restore) {
          this.dropDepth.delete(this.groupDepth);
          this.dropContent = restore.drop;
        }
        // 字体表的推出：只要当前深度已经小于「进入字体表时的深度」，就说明
        // {\fonttbl ...} 已经闭合。用显式深度判断而不是布尔开关 + 恢复栈 ——
        // 布尔开关一旦有一次没被复位，就会永久吞掉全部控制字（表现为整篇空白，
        // 这个坑实际踩过）。
        if (this.inFontTable && this.groupDepth < this.fontTableDepth) this.inFontTable = false;
        if (this.skipDepth > 0) this.skipDepth--;
        return { type: 'groupClose' };
      }

      if (c === '\\') {
        const t = this.readControl();
        if (t) return t;
        continue;
      }

      /* 普通文本：读到下一个 '{' '}' '\\' 为止 */
      let end = this.pos;
      while (end < this.src.length) {
        const ch = this.src[end];
        if (ch === '{' || ch === '}' || ch === '\\') break;
        end++;
      }
      const raw = this.src.slice(this.pos, end);
      this.pos = end;
      if (raw === '') continue;
      if (this.skipDepth > 0) continue;
      if (this.dropContent) {
        // 颜色表：文本形如 ";\\red0\\green0\\blue0;"（控制字部分已被消费）
        this.collectColorText(raw);
        continue;
      }
      if (this.inFontTable) {
        this.collectFontText(raw);
        continue;
      }
      return { type: 'text', text: raw.replace(/\r\n|\r|\n/g, '\n') };
    }
  }

  /**
   * 进入字体表。记下「字体表内部」的深度（= 当前深度 + 1）：
   * 一旦闭合导致深度回落到它之下，就地推出字体表模式。
   */
  private enterFontTable(): void {
    this.inFontTable = true;
    this.fontTableDepth = this.groupDepth + 1;
  }

  private beginSkip(dest: string): void {    this.skipDepth++;
    if (dest === 'pict' && !this.warnedPict) {
      this.warnedPict = true;
      this.warn('RTF 中的 \\pict 图片未渲染（本读取器不做图片解码），已跳过该组');
    }
    if ((dest === 'listtable' || dest === 'listoverridetable') && !this.warnedTable) {
      this.warnedTable = true;
      this.warn('RTF 列表定义未还原为编号，正文文本仍保留');
    }
    if (dest === 'colortbl') {
      // 颜色表要读（\cfN 需要 #rrggbb），但内容不能进正文
      this.colors.length = 0;
      this.dropDepth.set(this.groupDepth, { drop: this.dropContent, inFont: this.inFontTable });
      this.dropContent = true;
    }
  }

  private readControl(): Token | null {
    let i = this.pos + 1;
    if (i >= this.src.length) {
      this.pos = i;
      return { type: 'text', text: '\\' };
    }
    const c = this.src[i];

    /* 转义序列：\{ \} \\ 是**字面文本**，必须走正文通道。
       踩过的坑：早期版本把它们也丢进 maybeText()，而 maybeText 在字体表里
       会把内容当成字体名吃掉 —— 于是 `\{literal\}` 整段消失。 */
    if (c === '\\' || c === '{' || c === '}') {
      this.pos = i + 1;
      return this.literalText(c);
    }
    if (c === "'") {
      // \'hh：十六进制字节。把随后连续的 \'hh 一起攒起来成段解码。
      const hex = this.src.slice(i + 1, i + 3);
      const v = Number.parseInt(hex, 16);
      this.pos = i + 3;
      if (!Number.isFinite(v)) {
        this.warn(`RTF 中 \\'${hex} 不是合法十六进制，已忽略`);
        return null;
      }
      const bytes = [v];
      for (;;) {
        const m = /^\\'([0-9a-fA-F]{2})/.exec(this.src.slice(this.pos, this.pos + 4));
        if (!m) break;
        bytes.push(Number.parseInt(m[1], 16));
        this.pos += 4;
      }
      if (this.skipDepth > 0 || this.dropContent) return null;
      return { type: 'bytes', bytes };
    }
    if (c === '~') {
      this.pos = i + 1;
      return this.literalText('\u00a0'); // 不换行空格
    }
    if (c === '-') {
      this.pos = i + 1;
      return this.literalText('\u00ad'); // 可选连字符
    }
    if (c === '_') {
      this.pos = i + 1;
      return this.literalText('\u2011'); // 不换行连字符
    }
    if (!/[a-zA-Z]/.test(c)) {
      // \* \| \: 等单字符控制符号：跳过
      this.pos = i + 1;
      return null;
    }

    /* 控制字：字母 + 可选负号数字 + 可选一个分隔空格 */
    let j = i;
    while (j < this.src.length && /[a-zA-Z]/.test(this.src[j])) j++;
    const word = this.src.slice(i, j).toLowerCase();
    let neg = false;
    if (this.src[j] === '-') {
      neg = true;
      j++;
    }
    let digits = '';
    while (j < this.src.length && this.src[j] >= '0' && this.src[j] <= '9') {
      digits += this.src[j];
      j++;
    }
    let param: number | undefined;
    if (digits !== '') {
      const n = Number.parseInt(digits, 10);
      param = neg ? -n : n;
    }
    if (this.src[j] === ' ') j++;
    this.pos = j;

    if (word === 'u') {
      // \uN 后面有 ucSkip 个替代字符要吃掉（\uc1 时通常是 '?'）
      let k = 0;
      while (k < this.ucSkip && this.pos + k < this.src.length) {
        const ch = this.src[this.pos + k];
        if (ch === '\\' || ch === '{' || ch === '}') break;
        k++;
      }
      this.pos += k;
      if (this.skipDepth > 0 || this.dropContent) return null;
      return { type: 'unicode', code: param ?? 0 };
    }
    if (this.skipDepth > 0) {
      if (this.dropContent) {
        // 颜色表：借控制字收集 \red/\green/\blue（正文内容已被丢弃）
        if (word === 'red' && param !== undefined) this.noteColorComponent(0, param);
        else if (word === 'green' && param !== undefined) this.noteColorComponent(1, param);
        else if (word === 'blue' && param !== undefined) this.noteColorComponent(2, param);
      }
      return null;
    }
    if (this.inFontTable) {
      // 字体表：\fN 开一个新条目，\fcharsetN 决定代码页，条目名是紧随其后的文本
      if (word === 'f' && param !== undefined) {
        this.commitFontEntry();
        this.tableField = param;
      } else if (word === 'fcharset' && param !== undefined) {
        this.pendingCharset = param;
      }
      return null;
    }
    return { type: 'control', word, param };
  }

  /** 转义得到的字面文本（\{ \} \\ \~ \- \_）：永远属于正文，与所处目标组无关 */
  private literalText(text: string): Token | null {
    if (this.skipDepth > 0 || this.dropContent) return null;
    return { type: 'text', text };
  }

  /** 普通文本片段：在字体表里被当作字体名收集，否则交给正文 */
  private maybeText(text: string): Token | null {
    if (this.skipDepth > 0 || this.dropContent) return null;
    if (this.inFontTable) {
      this.pendingFontName = (this.pendingFontName ?? '') + text;
      return null;
    }
    return { type: 'text', text };
  }

  /** 字体表里读到过的「非零」字符集号，作为 code page 的最后兜底 */
  private fontTableCharset = 0;

  /** 字体条目收尾：`{\f0\fnil\fcharset134 宋体;}` -> fonts[0]='宋体' */
  private commitFontEntry(): void {
    const idx = this.tableField;
    if (this.pendingFontName !== null) {
      const name = this.pendingFontName.trim().replace(/;$/, '').trim();
      if (name) this.fonts[idx] = name;
    }
    if (this.pendingCharset !== null) {
      this.fontCharsets[idx] = this.pendingCharset;
      if (this.pendingCharset !== 0) this.fontTableCharset = this.pendingCharset;
    }
    this.pendingFontName = null;
    this.pendingCharset = null;
  }

  /** 字体表里的文本片段就是字体名（可能带分号结尾） */
  private collectFontText(raw: string): void {
    const parts = raw.split(';');
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i];
      if (piece !== '') this.pendingFontName = (this.pendingFontName ?? '') + piece;
      if (i < parts.length - 1) {
        // 分号是条目分隔符：提交当前条目
        this.commitFontEntry();
      }
    }
  }

  /** 颜色表：`;\red0\green0\blue0;\red255\green0\blue0;` 的文本片段 */
  private collectColorText(raw: string): void {
    for (const ch of raw) {
      if (ch === ';') {
        const rgb = this.pendingColor;
        // 第 0 项在 RTF 里是 "auto"（没有 \red\green\blue），用黑色占位
        this.colors.push(rgb ? `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}` : '#000000');
        this.pendingColor = null;
      }
    }
  }

  /** 由控制字分支在颜色表内调用 */
  noteColorComponent(which: 0 | 1 | 2, value: number): void {
    const cur = this.pendingColor ?? [0, 0, 0];
    cur[which] = value;
    this.pendingColor = cur;
  }
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/* ==================================================================== */
/* 读取器                                                               */
/* ==================================================================== */

export async function readRtf(ctx: ReadContext): Promise<LiteDocument> {
  const b = new DocBuilder(ctx);
  const bytes = await ctx.bytes();
  const budget = ctx.limits.maxFileBytes;
  let view = bytes;
  if (bytes.length > budget) {
    view = bytes.subarray(0, budget);
    b.warn(`文件 ${bytes.length} 字节超过 maxFileBytes=${budget} 字节，已截断（尾部可能缺少 }，解析器会容错收尾）`);
    if (!ctx.guard.truncated.includes('maxFileBytes')) {
      ctx.guard.truncated.push('maxFileBytes');
      ctx.guard.warnings.push(`maxFileBytes 达到上限 ${budget.toLocaleString('en-US')}，后续内容已忽略`);
    }
  }
  if (!startsWithRtfHeader(view)) b.warn('文件头不是 {\\rtf，可能不是标准 RTF；仍按 RTF 语法尽力解析');
  // RTF 在语法上是 7-bit ASCII + \'hh 转义，因此按 latin1 读入**不丢字节**：
  // 每个字节恰好对应一个码点，之后 \'hh 才按代码页正确还原。
  // 早期版本用 UTF-8 解码，把合法的 RTF 转义串成替换字符，中文全乱。
  const text = makeDecoder('latin1').decode(view);

  const parsed = parseRtf(text, { maxBlocks: ctx.limits.maxBlocks });
  for (const w of parsed.warnings) b.warn(w);
  if (parsed.truncated) {
    b.warn(`块数达到 maxBlocks=${ctx.limits.maxBlocks.toLocaleString('en-US')}，后续内容未解析`);
    if (!ctx.guard.truncated.includes('maxBlocks')) {
      ctx.guard.truncated.push('maxBlocks');
      ctx.guard.warnings.push(`maxBlocks 达到上限 ${ctx.limits.maxBlocks.toLocaleString('en-US')}，后续内容已忽略`);
    }
  }
  for (const block of parsed.blocks) {
    if (!b.push(block)) break;
  }
  if (b.blocks.length === 0) b.push({ kind: 'para', runs: [{ text: '' }] });
  const doc = b.finish('rtf' as FormatId, 'text', { meta: { paragraphCount: b.blocks.length } });
  return doc;
}

function startsWithRtfHeader(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf || bytes[i] === 0x20 || bytes[i] === 0x0d || bytes[i] === 0x0a)) i++;
  return bytes[i] === 0x7b && bytes[i + 1] === 0x5c && (bytes[i + 2] === 0x72 || bytes[i + 2] === 0x52);
}