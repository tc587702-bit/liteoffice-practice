/* ==================================================================== */
/* 来源与改动说明                                                        */
/*                                                                       */
/* 本文件移植自只读内核：                                                */
/*   liteoffice/packages/format-text/src/mdparse.ts                      */
/*   （2026-10-17 版本；当时由 AI 辅助生成，并随 19+ 条测试一起演进）     */
/*                                                                       */
/* 本副本的**唯一改动**：                                                */
/*   1. 第 21 行的 UDM 类型来源由 ../../core/src/model.ts 改为 ./udm；   */
/*   2. 修正下方「行内 HTML 标签直通」这一句旧注释 —— 实测是会映射成     */
/*      样式、未知标签被整段抹掉，不是直通。                              */
/* 解析逻辑一行未动。若与上游出现差异，以上游为准。                      */
/* ==================================================================== */

/**
 * 自研轻量 Markdown 解析器。
 *
 * 为什么自己写而不是引 marked / markdown-it：
 *   本项目零依赖是硬约束；而且通用 Markdown 库都会**先产出 HTML 字符串**，
 *   我们还得分词反解回 Run[]，粗体/斜体信息在往返中极易丢失。
 *   这里直接产出 UDM：行内解析一步到位给出 Run[]（带 RunStyle），
 *   块级解析直接给出 Paragraph / Table / RuleBlock。
 *
 * 覆盖范围（有意为之，不追求 CommonMark 全量）：
 *   ATX 标题、段落、无序/有序列表（含嵌套）、围栏代码块、缩进代码块、引用、
 *   水平线、管道表格、行内 **粗体** *斜体* `code` [链接](url) ~~删除线~~、
 *   硬换行（行尾两空格或反斜杠）、行内 HTML 标签直通。
 *   不支持（降级为纯文本）：引用式链接、脚注、内嵌 HTML 块、Setext 标题、
 *   任务列表、定义列表、数学公式。
 *
 * 行内解析用「活跃标记栈」而不是正则替换：正则会互相吃掉对方的分隔符
 * （`**a*b*c**` 这类），而栈式扫描能保证「找不到闭合标记就退化成普通文本」，
 * 绝不吞掉内容。
 */
import type { Block, ParaStyle, Run, RunStyle, Table, TableCell, TableRow } from './udm';

const MONO = 'Consolas';

/* ==================================================================== */
/* 行内解析                                                              */
/* ==================================================================== */

interface InlineState {
  style: RunStyle | undefined;
  link: string | undefined;
  bold: number;
  italic: number;
  strike: number;
  underline: number;
  code: boolean;
}

function newState(style: RunStyle | undefined): InlineState {
  return { style, link: undefined, bold: 0, italic: 0, strike: 0, underline: 0, code: false };
}

/** 一次行内解析内所有可能作为标记起点的位置。 */
function collectAnchors(src: string) {
  const tildes: number[] = [];
  const stars: number[] = [];
  const underscores: number[] = [];
  const backticks: number[] = [];
  const bangBrackets: number[] = [];
  const tags: { index: number; text: string }[] = [];
  const tagRe = /<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>/g;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '~') tildes.push(i);
    else if (c === '*') stars.push(i);
    else if (c === '_') underscores.push(i);
    else if (c === '`') backticks.push(i);
    else if (c === '!' && src[i + 1] === '[') bangBrackets.push(i);
  }
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) !== null) tags.push({ index: m.index, text: m[0] });
  return { tildes, stars, underscores, backticks, bangBrackets, tags };
}

export interface InlineOptions {
  /** 基准样式，解析过程中派生新对象而不是就地改写 */
  base?: RunStyle;
}

/**
 * 行内解析：Markdown 文本 -> Run[]。
 * 产出的 Run[] 保证至少有一个元素（即便内容为空），调用方不必处理空数组。
 */
export function parseInline(src: string, options: InlineOptions = {}): Run[] {
  const runs: Run[] = [];
  const anc = collectAnchors(src);
  const ti = new Map<number, string>();
  for (const t of anc.tags) ti.set(t.index, t.text);
  const bangSet = new Set(anc.bangBrackets);
  const st = newState(options.base);
  let buf = '';
  const L = src.length;

  /**
   * 落掉缓冲（普通情况，无换行语义）。
   * 若此前有人请求过换行，则把 breakBefore 补到这一个 run 上。
   */
  let pendingBreak = false;
  const flush = (): void => {
    if (!buf) return;
    const run = makeRun(buf, st, false, true);
    if (pendingBreak) {
      run.breakBefore = true;
      pendingBreak = false;
    }
    runs.push(run);
    buf = '';
  };

  /** 落掉缓冲，并让这个 run 带 breakBefore（用于硬换行）。 */
  const flushWithBreak = (): void => {
    if (!buf) {
      if (pendingBreak) return;
      pendingBreak = true;
      return;
    }
    const first = runs.length === 0;
    const run = makeRun(buf, st, !first, true);
    if (first) {
      // 段落里的第一个 run 之前没有可断的内容：把换行信息顺延给下一个 run，
      // 保证「硬换行」最终总能落到某个 run 的 breakBefore 上（否则标记会消失）。
      run.breakBefore = pendingBreak;
      pendingBreak = true;
    } else {
      pendingBreak = false;
    }
    runs.push(run);
    buf = '';
  };

  const findClose = (list: number[], from: number, text: string): number => {
    for (const i of list) if (i > from && src.startsWith(text, i)) return i;
    return -1;
  };

  const pushStyled = (text: string, mutate: (s: InlineState) => void, restore: (s: InlineState) => void): void => {
    flush();
    mutate(st);
    runs.push(makeRun(text, st, false, runs.length > 0));
    restore(st);
  };

  let i = 0;
  while (i < L) {
    const tagText = ti.get(i);
    if (tagText) {
      i += tagText.length;
      applyTag(tagText, st, runs, flush, flushWithBreak);
      continue;
    }

    const c = src[i];

    /* ---- 图片 ![alt](src) ---- */
    if (c === '!' && bangSet.has(i)) {
      const parsed = parseLinkTarget(src, i + 1);
      if (parsed) {
        flush();
        runs.push(imageRun(src.slice(i + 2, parsed.textEnd), parsed.target));
        i = parsed.end;
        continue;
      }
    }

    /* ---- 链接 [text](url) ---- */
    if (c === '[') {
      const parsed = parseLinkTarget(src, i);
      if (parsed) {
        flush();
        const label = src.slice(i + 1, parsed.textEnd);
        // 链接样式必须作为**内部解析的基准样式**传入。
        // 踩过的坑：早先版本改成外层的 st.link 再递归，但内层 parseInline 用的是
        // 自己的新状态，链接信息根本传不进去 —— 结果 URL 解析对了、
        // `style.link` 却是 undefined（点不动）。
        runs.push(...parseInline(label, { base: withLink(styleFromState(st), parsed.target) }));
        i = parsed.end;
        continue;
      }
    }

    /* ---- 代码段 `code` ---- */
    if (c === '`') {
      const close = findClose(anc.backticks, i, '`');
      if (close >= 0) {
        // 代码段内不做任何行内解析（CommonMark 语义），直接产出一个 run
        pushStyled(src.slice(i + 1, close), (s) => (s.code = true), (s) => (s.code = false));
        i = close + 1;
        continue;
      }
    }

    /* ---- 删除线 ~~text~~ ---- */
    if (c === '~' && src[i + 1] === '~') {
      const close = findClose(anc.tildes, i + 1, '~~');
      if (close >= 0) {
        pushStyled(src.slice(i + 2, close), (s) => s.strike++, (s) => s.strike--);
        i = close + 2;
        continue;
      }
    }

    /* ---- 强调 ** / * / __ / _ ---- */
    const emph = matchEmphasis(src, i, anc.stars, anc.underscores);
    if (emph) {
      pushStyled(
        emph.text,
        (s) => {
          if (emph.strong) s.bold++;
          else s.italic++;
        },
        (s) => {
          if (emph.strong) s.bold--;
          else s.italic--;
        },
      );
      i = emph.end;
      continue;
    }

    /* ---- 硬换行 ---- */
    if (c === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')) {
      i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2;
      flushWithBreak();
      continue;
    }
    if (c === '\n' || c === '\r') {
      const nl = c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      const hard = / {2,}$/.test(buf) || /\\$/.test(buf);
      buf = buf.replace(/[ \t]+$/, '');
      i += nl;
      // 软换行折叠成一个空格（块级段落内的换行不该改变文本流）。
      // 行尾两空格/反斜杠是硬换行，用 breakBefore 表达而不是插 '\n' 字符 ——
      // 这样渲染器能自行决定换行策略，也不会和「段落分隔」混淆。
      if (hard) flushWithBreak();
      else if (buf) buf += ' ';
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  // 空内容也要产出一个 run：调用方不必为「空段落」写特判。
  // 这里必须传行内状态 st 而不是 undefined —— 传 undefined 会让
  // styleFromState 直接崩（"Cannot read properties of undefined"）。
  if (runs.length === 0) runs.push(makeRun('', st, false, false));
  return runs;
}

/** 在已有样式上附加链接目标（不改动原对象）。 */
function withLink(style: RunStyle | undefined, link: string): RunStyle {
  return { ...(style ?? {}), link };
}

function makeRun(text: string, st: InlineState, breakBefore: boolean, hasPrev: boolean): Run {
  const style = styleFromState(st);
  const run: Run = { text };
  if (style) run.style = style;
  // 第一个 run 的 breakBefore 没有意义（前面没有 run 可断），留着会误导渲染层
  // 在段首多插一个换行 —— 这里就地清掉。
  if (breakBefore && hasPrev) run.breakBefore = true;
  return run;
}

function styleFromState(st: InlineState): RunStyle | undefined {
  const need = st.bold > 0 || st.italic > 0 || st.strike > 0 || st.underline > 0 || st.code || !!st.link;
  if (!need) return st.style;
  const out: RunStyle = st.style ? { ...st.style } : {};
  if (st.bold > 0) out.bold = true;
  if (st.italic > 0) out.italic = true;
  if (st.strike > 0) out.strike = true;
  // 下划线必须由计数控制并在 </u> 时清掉。踩过的坑：早期版本把 <u> 写成
  // 「往 st.style 里塞 underline: true」，而 </u> 什么都不做 ——
  // 于是文档里**剩下所有内容**都被划上了下划线。
  if (st.underline > 0) out.underline = true;
  else delete out.underline;
  if (st.code) out.font = MONO;
  if (st.link) out.link = st.link;
  return out;
}

/**
 * 处理行内 HTML 标签（Markdown 允许内嵌 HTML，这里只映射样式，不建 DOM）。
 *
 * 关键点：**样式变化的边界必须落成 run 边界**。所以进入/退出影响样式的标签时
 * 先把缓冲区落掉，否则样式会作用到整段文本上。
 * 踩过的坑：早期版本只在文本处 flush，导致 `<b>` 打开→立刻关闭→文本仍留在
 * 缓冲里，最后按「无样式」落成 run —— 粗体标签等于完全没生效。
 */
/**
 * 处理行内 HTML 标签（Markdown 允许内嵌 HTML，这里只映射样式，不建 DOM）。
 *
 * 关键点：**样式变化的边界必须落成 run 边界**。所以进入/退出影响样式的标签时
 * 先把缓冲区落掉，否则样式会作用到整段文本上。
 * 踩过的坑：早期版本只在文本处 flush，导致 `<b>` 打开→立刻关闭→文本仍留在
 * 缓冲里，最后按「无样式」落成 run —— 粗体标签等于完全没生效。
 *
 * `flush` / `flushBreak` 由调用方注入：它们闭包在 parseInline 的行内状态上。
 */
function applyTag(
  tag: string,
  st: InlineState,
  runs: Run[],
  flush: () => void,
  flushBreak: () => void,
): void {
  const isEnd = tag.startsWith('</');
  const end = tag.endsWith('>') ? tag.length - 1 : tag.length;
  const body = tag.slice(isEnd ? 2 : 1, end).trim();
  const name = body.split(/[\s/]/)[0].toLowerCase();
  if (name === 'br') {
    flushBreak();
    return;
  }
  if (isEnd || tag.endsWith('/>')) {
    // 先落掉「标签内部」的文本（此时样式仍生效），再撤销样式。
    // 顺序反了的话，<b>x</b> 里的 x 会被当成无样式 —— 实测踩过这个坑。
    flush();
    if (name === 'b' || name === 'strong') st.bold = Math.max(0, st.bold - 1);
    else if (name === 'i' || name === 'em') st.italic = Math.max(0, st.italic - 1);
    else if (name === 's' || name === 'del' || name === 'strike') st.strike = Math.max(0, st.strike - 1);
    else if (name === 'u' || name === 'ins') st.underline = Math.max(0, st.underline - 1);
    else if (name === 'code' || name === 'tt') st.code = false;
    else if (name === 'a') st.link = undefined;
    return;
  }
  // 开始标签：先把「标签之前」的文本按旧样式落成 run，再叠加新样式
  flush();
  if (name === 'b' || name === 'strong') st.bold++;
  else if (name === 'i' || name === 'em') st.italic++;
  else if (name === 's' || name === 'del' || name === 'strike') st.strike++;
  else if (name === 'u' || name === 'ins') st.underline++;
  else if (name === 'code' || name === 'tt') st.code = true;
  else if (name === 'a') {
    const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(body);
    st.link = sanitizeUrl(m ? (m[2] ?? m[3] ?? m[4]) : undefined);
  } else if (name === 'img') {
    const m = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(body);
    const a = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(body);
    runs.push(imageRun(a ? (a[2] ?? a[3] ?? a[4] ?? '') : '', m ? (m[2] ?? m[3] ?? m[4]) : undefined));
  }
  // 未知标签：抹掉标记本身即可，内容已经在文本流里
}

function imageRun(alt: string, src: string | undefined): Run {
  return {
    text: '',
    // 行内图片不在这里解码字节：Markdown 的图片多为外链，解码会把解析变成
    // 网络/IO 操作。字节解码只在 HTML 的 data: URI 场景做（那里是自包含的）。
    image: { mime: 'image/*', width: 200, height: 150, alt: alt || undefined, partPath: src },
  };
}

/** 只允许安全协议，避免 javascript: 变成可点击链接。 */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const t = url.trim();
  if (!t) return undefined;
  if (/^\s*(javascript|vbscript|data:text\/html)/i.test(t)) return undefined;
  return t;
}

interface Emphasis {
  text: string;
  strong: boolean;
  end: number;
}

/**
 * 匹配强调。返回 undefined 表示「这里不是合法的强调起点」。
 *
 * 两条关键规则：
 *   1. 分隔符内侧不能是空白（`a * b * c` 不是斜体）
 *   2. 找不到闭合分隔符必须退化成普通文本 —— 自研实现的经典坑：
 *      早先版本遇到未闭合的 `**` 会把余下全文都当粗体，整篇样式错乱。
 */
function matchEmphasis(src: string, i: number, stars: number[], underscores: number[]): Emphasis | undefined {
  const c = src[i];
  if (c !== '*' && c !== '_') return undefined;
  const strong = src[i + 1] === c;
  const afterIdx = i + (strong ? 2 : 1);
  const after = src[afterIdx];
  if (after === undefined || /\s/.test(after)) return undefined;
  if (c === '_' && /[A-Za-z0-9]/.test(src[i - 1] ?? '')) return undefined; // snake_case 不能变斜体
  const list = c === '*' ? stars : underscores;
  const needle = strong ? c + c : c;
  let close = -1;
  for (const idx of list) {
    if (idx <= i) continue;
    if (!src.startsWith(needle, idx)) continue;
    const before = src[idx - 1];
    if (before === undefined || /\s/.test(before)) continue;
    close = idx;
    break;
  }
  if (close < 0) return undefined;
  const text = src.slice(afterIdx, close);
  if (!text) return undefined;
  // 递归解析内部，支持 **粗 *斜* 体**
  return { text, strong, end: close + needle.length };
}

interface LinkTarget {
  target: string;
  textEnd: number;
  end: number;
}

/**
 * 从 `[` 开始尝试解析 `[label](url)`。
 * 用括号配对扫描而不是正则：URL 里合法地包含 `(` `)`（维基链接很常见），
 * 正则会截断，配对扫描能取到完整 URL。
 */
function parseLinkTarget(src: string, lbracket: number): LinkTarget | undefined {
  const textEnd = matchBracket(src, lbracket);
  if (textEnd < 0) return undefined;
  if (src[textEnd + 1] !== '(') return undefined;
  // 括号配对从**开括号本身**开始数（j 指向开括号），否则 URL 内部的 ( )
  // 会被少算一层，导致最后的 `)` 被当成 URL 的一部分而找不到链接结尾
  // —— `[x](a(b))` 会整段退化成纯文本。
  let depth = 0;
  let j = textEnd + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return undefined;
  // 支持 [a](url "title")
  const url = src.slice(textEnd + 2, j).trim().split(/\s+/)[0];
  const target = sanitizeUrl(url);
  if (!target) return undefined;
  return { target, textEnd, end: j + 1 };
}

/** 找到与 lbracket 配对的 ']'，支持嵌套方括号与转义。 */
function matchBracket(src: string, lbracket: number): number {
  let depth = 0;
  for (let i = lbracket; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ==================================================================== */
/* 块级解析                                                              */
/* ==================================================================== */

export interface MdOutlineItem {
  /** 1 起 */
  level: number;
  text: string;
  blockIndex: number;
}

export interface MdParseResult {
  blocks: Block[];
  outline: MdOutlineItem[];
  warnings: string[];
  /** 解析过程中达到块数上限 */
  truncated: boolean;
  /** 已被消费的行数（诊断用） */
  lines: number;
}

export interface MdOptions {
  /** 块数上限，达到即停止解析 */
  maxBlocks?: number;
  /** 引用递归深度上限，防止畸形输入造成深递归 */
  maxDepth?: number;
  onWarning?: (msg: string) => void;
}

const MAX_DEPTH_DEFAULT = 12;

/**
 * 解析 Markdown 文本为 UDM 块。
 *
 * 单遍扫描：每行只被看常数次，块级状态（列表层级、引用深度）用显式栈维护，
 * 不做正则回溯，因此对畸形输入也是线性的、不会爆栈。
 */
export function parseMarkdown(text: string, options: MdOptions = {}): MdParseResult {
  const blocks: Block[] = [];
  const outline: MdOutlineItem[] = [];
  const warnings: string[] = [];
  const maxBlocks = options.maxBlocks ?? Number.POSITIVE_INFINITY;
  const maxDepth = options.maxDepth ?? MAX_DEPTH_DEFAULT;
  const lines = splitLines(text);
  let truncated = false;
  let i = 0;

  const warn = (msg: string): void => {
    if (warnings.length < 100 && !warnings.includes(msg)) warnings.push(msg);
    options.onWarning?.(msg);
  };

  const push = (block: Block): boolean => {
    if (blocks.length >= maxBlocks) {
      truncated = true;
      return false;
    }
    blocks.push(block);
    return true;
  };

  /** 有序列表的层级计数：key 是层级 */
  const orderedCounters = new Map<number, number>();

  while (i < lines.length) {
    const line = lines[i].replace(/\t/g, '    ');

    /* ---- 空行：保留为段落，维持原文的呼吸感 ---- */
    if (line.trim() === '') {
      if (!push({ kind: 'para', runs: [{ text: '' }] })) break;
      i++;
      continue;
    }

    /* ---- 围栏代码块 ``` / ~~~ ---- */
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const info = fence[2].trim();
      const closer = new RegExp(`^ {0,3}\\${marker}{${len},}\\s*$`);
      i++;
      const collected: string[] = [];
      let closed = false;
      while (i < lines.length) {
        if (closer.test(lines[i].replace(/\t/g, '    '))) {
          closed = true;
          i++;
          break;
        }
        collected.push(lines[i]);
        i++;
      }
      if (!closed) warn('围栏代码块未闭合，已按到文末处理');
      if (collected.length === 0) collected.push('');
      // 代码块压成**一个**段落，用 breakBefore 表达换行：
      // 逐行建段落会让 5000 行的代码块产生 5000 个块，既费内存也难滚动。
      const runs: Run[] = collected.map((t, idx) => {
        const run: Run = { text: t, style: { font: MONO } };
        if (idx > 0) run.breakBefore = true;
        return run;
      });
      const style: ParaStyle = { styleName: info ? `Code ${info}` : 'Code' };
      if (!push({ kind: 'para', runs, style })) break;
      continue;
    }

    /* ---- ATX 标题 ---- */
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      const runs = parseInline(title, { base: { bold: true } });
      const style: ParaStyle = { outlineLevel: level - 1, styleName: `Heading ${level}` };
      outline.push({ level, text: title.replace(/[`*_~]/g, '').trim().slice(0, 200), blockIndex: blocks.length });
      if (!push({ kind: 'para', runs, style })) break;
      i++;
      continue;
    }

    /* ---- 水平线 ---- */
    if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      if (!push({ kind: 'rule', thickness: 0.75 })) break;
      i++;
      continue;
    }

    /* ---- 引用 ---- */
    if (/^ {0,3}>/.test(line)) {
      if (maxDepth <= 0) {
        warn('引用嵌套超过深度上限，仅保留一行文本');
        if (!push({ kind: 'para', runs: parseInline(line.replace(/^ {0,3}> ?/, '')) })) break;
        i++;
        continue;
      }
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i++;
        // 引用块内的懒惰续行（无 '>' 前缀的普通文本行）仍属于引用
        while (i < lines.length && lines[i].trim() !== '' && !/^ {0,3}>/.test(lines[i]) && !isBlockStart(lines[i], lines[i + 1])) {
          inner.push(lines[i]);
          i++;
        }
      }
      // 递归解析引用内容：引用里可以嵌列表/代码块/表格
      const sub = parseMarkdown(inner.join('\n'), { maxDepth: maxDepth - 1, maxBlocks: maxBlocks - blocks.length });
      for (const w of sub.warnings) warn(w);
      if (sub.truncated) truncated = true;
      for (const b of sub.blocks) {
        if (!push(applyQuote(b))) {
          truncated = true;
          break;
        }
      }
      if (blocks.length >= maxBlocks) break;
      continue;
    }

    /* ---- 管道表格 ---- */
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      i = parsePipeTable(lines, i, push, warn);
      continue;
    }

    /* ---- 缩进代码块 ---- */
    if (/^ {4,}\S/.test(line)) {
      const collected: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (/^ {4,}/.test(cur)) collected.push(cur.replace(/^ {4}/, ''));
        else if (cur.trim() === '') collected.push('');
        else break;
        i++;
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      if (collected.length === 0) collected.push('');
      const runs: Run[] = collected.map((t, idx) => {
        const run: Run = { text: t, style: { font: MONO } };
        if (idx > 0) run.breakBefore = true;
        return run;
      });
      if (!push({ kind: 'para', runs, style: { styleName: 'Code' } })) break;
      continue;
    }

    /* ---- 列表 ---- */
    const listItem = matchListItem(line);
    if (listItem) {
      i = parseList(lines, i, listItem, push, orderedCounters, warn);
      continue;
    }

    /* ---- 段落（连续非空行合并） ---- */
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === '') break;
      if (paraLines.length > 0 && isBlockStart(cur, lines[i + 1])) break;
      paraLines.push(cur.replace(/\t/g, '    '));
      i++;
    }
    const joined = paraLines
      .map((t, idx) => {
        const s = t.trim();
        if (idx === paraLines.length - 1) return s;
        return /( {2,}|\\)$/.test(t) ? `${s}\n` : `${s} `;
      })
      .join('');
    if (!push({ kind: 'para', runs: parseInline(joined) })) break;
  }

  return { blocks, outline, warnings, truncated, lines: lines.length };
}

/** 拆行。文本已整份在内存里，用一次正则扫描即可。 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 给引用块内的块加左侧视觉提示（缩进 + 灰边）。 */
function applyQuote(b: Block): Block {
  if (b.kind !== 'para') return b;
  const style: ParaStyle = {
    ...(b.style ?? {}),
    indentStart: (b.style?.indentStart ?? 0) + 18,
    border: { left: { width: 2, color: '#cccccc', style: 'solid' } },
  };
  return { kind: 'para', runs: b.runs, style };
}

interface ListItemMatch {
  ordered: boolean;
  marker: string;
  indent: number;
  content: string;
  /** 原始序号（有序列表用），无序为 0 */
  number: number;
}

function matchListItem(line: string): ListItemMatch | undefined {
  const m = /^( *)([-*+]|\d{1,9}[.)])(\s+(.*))?$/.exec(line);
  if (!m) return undefined;
  const tok = m[2];
  const ordered = /\d/.test(tok);
  const number = ordered ? Number.parseInt(tok, 10) : 0;
  return {
    ordered,
    marker: ordered ? `${Number.isFinite(number) ? number : 1}.` : '\u2022',
    indent: m[1].length,
    content: m[4] ?? '',
    number,
  };
}

/**
 * 解析一个列表（含嵌套）。
 *
 * 缩进宽度按「标记宽度 + 空格」推算层级：两空格/四空格都当作一层，用 2 的倍数
 * 取整而不是死认 2 或 4 —— 真实文档两种都有，死认一种会让层级全错。
 * 返回下一个未消费的行号。
 */
function parseList(
  lines: string[],
  start: number,
  first: ListItemMatch,
  push: (b: Block) => boolean,
  counters: Map<number, number>,
  warn: (m: string) => void,
): number {
  const baseIndent = first.indent;
  let i = start;
  let maxLevel = 0;
  counters.clear();

  while (i < lines.length) {
    const line = lines[i].replace(/\t/g, '    ');
    const item = matchListItem(line);
    if (!item) break;
    if (item.indent < baseIndent) break;
    const level = Math.min(8, Math.floor((item.indent - baseIndent) / 2));
    if (level > maxLevel) maxLevel = level;

    let markerText = item.marker;
    if (item.ordered) {
      const prev = counters.get(level) ?? 0;
      // 作者手写序号优先：`3.` 起头的列表第一项就该显示 3。
      const next = prev === 0 && item.number > 0 ? item.number : prev + 1;
      counters.set(level, next);
      markerText = `${next}.`;
      // 回到外层时清掉更深层的计数，否则会出现 "1. 1. 1." 不断递增的怪现象
      for (const k of [...counters.keys()]) if (k > level) counters.delete(k);
    }
    const style: ParaStyle = {
      listLevel: level,
      listMarker: markerText,
      listOrdered: item.ordered,
      indentStart: (level + 1) * 18,
      indentFirst: 0,
    };
    if (!push({ kind: 'para', runs: parseInline(item.content), style })) return i;
    i++;

    // 列表项的续行（缩进更深但不是新项）——按独立段落保留，避免丢文本
    while (i < lines.length) {
      const cont = lines[i].replace(/\t/g, '    ');
      if (cont.trim() === '') break;
      if (matchListItem(cont)) break;
      if (!/^ {2,}/.test(cont)) break;
      if (isBlockStart(cont, lines[i + 1])) break;
      if (!push({ kind: 'para', runs: parseInline(cont.trim()), style: { listLevel: level, indentStart: (level + 1) * 18 } })) return i;
      i++;
    }
  }
  if (maxLevel >= 8) warn('列表嵌套层级过深，已压到最多 8 层');
  return i;
}

/** 判断某行是否是「新块的开始」，用于决定段落在哪里断开。 */
function isBlockStart(line: string, next: string | undefined): boolean {
  if (/^ {0,3}#{1,6}\s/.test(line)) return true;
  if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) return true;
  if (matchListItem(line)) return true;
  if (/^ {4,}\S/.test(line)) return true;
  if (line.includes('|') && next !== undefined && isTableDelimiter(next)) return true;
  return false;
}

/** 表格分隔行：| --- | :---: | */
export function isTableDelimiter(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-')) return false;
  const cells = splitTableRow(t);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c.trim().replace(/\s+/g, '')));
}

/** 切分一行表格；自动去掉首尾空管道带来的空单元格。 */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (c === '`') {
      // 代码段里的 | 不是分隔符
      const close = s.indexOf('`', i + 1);
      if (close > 0) {
        buf += s.slice(i, close + 1);
        i = close;
        continue;
      }
    }
    if (c === '|') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

function parsePipeTable(lines: string[], start: number, push: (b: Block) => boolean, warn: (m: string) => void): number {
  const headCells = splitTableRow(lines[start]);
  const aligns = splitTableRow(lines[start + 1]).map((c) => {
    const t = c.trim().replace(/\s+/g, '');
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center' as const;
    if (right) return 'right' as const;
    return 'left' as const;
  });
  let i = start + 2;
  const rows: TableRow[] = [];
  const width = headCells.length;

  const toCells = (src: string[]): TableCell[] => {
    const cells: TableCell[] = [];
    for (let c = 0; c < width; c++) {
      const text = (src[c] ?? '').replace(/\\\|/g, '|').trim();
      const style: ParaStyle | undefined = aligns[c] ? { align: aligns[c] } : undefined;
      // 注意：对齐属于段落样式（ParaStyle.align），不能塞进 parseInline 的 base
      // —— base 是 RunStyle。踩过的坑：把 ParaStyle 当 base 传进去会让
      // styleFromState 拿到一个没有 bold/italic 字段的对象，直接抛
      // "Cannot read properties of undefined"。
      cells.push({ blocks: [{ kind: 'para', runs: parseInline(text), style }] });
    }
    return cells;
  };

  // 表头行：管道表格语法里分隔行**必须**紧跟标题行，所以第一行天然是表头
  // （这与 CSV 的「不许擅自认表头」不同 —— 那里没有语法信号）。
  rows.push({ cells: toCells(headCells), header: true });

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') break;
    if (!line.includes('|')) break;
    if (/^ {0,3}#{1,6}\s/.test(line) || /^ {0,3}>/.test(line) || /^ {0,3}(`{3,}|~{3,})/.test(line)) break;
    const cells = splitTableRow(line);
    if (cells.length === 1 && cells[0].trim() === '') break;
    if (cells.length !== width) warn(`表格某行列数与表头不一致（${cells.length} vs ${width}），已按表头列数补齐/截断`);
    rows.push({ cells: toCells(cells) });
    i++;
  }

  const table: Table = { kind: 'table', rows };
  push(table);
  return i;
}
