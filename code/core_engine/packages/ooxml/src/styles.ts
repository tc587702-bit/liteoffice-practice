/**
 * Word（OOXML 文字处理）的样式与编号解析。
 *
 * 为什么独立成文件：docx 的样式体系是**继承链**，而不是「段落上写了什么就是什么」。
 * 一个 `<w:p>` 可能只写了 `<w:pStyle w:val="Heading1"/>`，真正的字号/颜色/间距
 * 藏在 `styles.xml` 里 Heading1 -> basedOn -> Normal -> docDefaults 的某一层。
 * 不去解析这条链，渲染出来的文档会全部是默认 10pt 黑字 —— 看起来「能打开」，
 * 但用户一眼就知道是假的。所以样式解析是 docx 保真度的关键路径。
 *
 * 编号同理：`<w:numPr><w:numId w:val="3"/></w:numPr>` 只是引用，
 * 项目符号字符/编号格式要到 `numbering.xml` 里 numId -> abstractNumId -> lvl 才能拿到。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { attr, attrBool, attrInt, attrNum, mergeDefined, onOff, parseColor, readPropChildren } from './xmlUtil.ts';
import { halfPtToPt, twipToPt } from '../../core/src/units.ts';

/* ---------------------------- 属性模型 ---------------------------- */

export interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  /** 字号，pt */
  sizePt?: number;
  font?: string;
  fontEastAsia?: string;
  vertAlign?: 'baseline' | 'subscript' | 'superscript';
  /** 字间距，pt */
  letterSpacingPt?: number;
  caps?: 'none' | 'small' | 'all';
  hidden?: boolean;
  /** 主题色键（如 accent1），用于在缺少 theme 时给出可解释的降级 */
  themeColor?: string;
  themeFill?: string;
}

export interface ParaProps {
  align?: 'left' | 'center' | 'right' | 'justify' | 'start' | 'end';
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineHeight?: number;
  lineHeightExactPt?: number;
  indentStartPt?: number;
  indentEndPt?: number;
  indentFirstPt?: number;
  outlineLevel?: number;
  pageBreakBefore?: boolean;
  shading?: string;
  numId?: string;
  ilvl?: number;
  tabsPt?: number[];
  keepNext?: boolean;
  keepLines?: boolean;
  /** 段落边框（简化：记录底/顶/左/右的线与色） */
  borders?: {
    top?: { widthPt: number; color?: string; style?: string };
    bottom?: { widthPt: number; color?: string; style?: string };
    left?: { widthPt: number; color?: string; style?: string };
    right?: { widthPt: number; color?: string; style?: string };
  };
  /** 段落整体默认字号（用于解析 em 之类的相对值） */
  runDefaults?: RunProps;
}

/* ---------------------------- 属性读取 ---------------------------- */

const VERT_ALIGN: Record<string, 'baseline' | 'subscript' | 'superscript'> = {
  baseline: 'baseline',
  subscript: 'subscript',
  superscript: 'superscript',
};

/**
 * 读取 `<w:rPr>` 子树。
 * 调用前提：p 刚产出 `<w:rPr>` 的 start 事件。
 */
export function readRunProps(p: XmlPullParser, out: RunProps = {}): RunProps {
  readPropChildren(p, (e) => applyRunProp(out, e));
  return out;
}

export function applyRunProp(out: RunProps, e: XmlEvent): void {
  switch (e.local) {
    case 'b':
      out.bold = onOff(e);
      break;
    case 'i':
      out.italic = onOff(e);
      break;
    case 'u': {
      const v = attr(e, 'val');
      // w:u val="none" 表示显式取消下划线（不是「有下划线」）
      out.underline = v === undefined ? true : v !== 'none';
      break;
    }
    case 'strike':
    case 'dstrike':
      out.strike = onOff(e);
      break;
    case 'color': {
      const c = parseColor(attr(e, 'val'));
      if (c) out.color = c;
      const theme = attr(e, 'themeColor');
      if (theme) out.themeColor = theme;
      break;
    }
    case 'highlight': {
      const c = parseColor(attr(e, 'val'));
      // w:highlight 用的是命名色（yellow/green/cyan/…），不是十六进制
      if (c) out.highlight = c;
      else {
        const named = attr(e, 'val');
        if (named && named !== 'none') out.highlight = NAMED_HIGHLIGHT[named.toLowerCase()] ?? named;
      }
      break;
    }
    case 'shd': {
      const c = parseColor(attr(e, 'fill'));
      if (c) out.highlight = c;
      break;
    }
    case 'sz': {
      const v = attrNum(e, 'val', NaN);
      if (Number.isFinite(v)) out.sizePt = halfPtToPt(v);
      break;
    }
    case 'szCs': {
      // 复杂文种字号：只在还没有 sz 时兜底
      if (out.sizePt === undefined) {
        const v = attrNum(e, 'val', NaN);
        if (Number.isFinite(v)) out.sizePt = halfPtToPt(v);
      }
      break;
    }
    case 'rFonts': {
      const ascii = attr(e, 'ascii') ?? attr(e, 'hAnsi');
      if (ascii) out.font = ascii;
      // Word 的中文字体是独立的（eastAsia），不取就会把中文渲染成西文字体
      const ea = attr(e, 'eastAsia');
      if (ea) out.fontEastAsia = ea;
      break;
    }
    case 'vertAlign': {
      const v = attr(e, 'val');
      if (v) out.vertAlign = VERT_ALIGN[v] ?? 'baseline';
    }
    break;
    case 'spacing': {
      const v = attrNum(e, 'val', NaN);
      if (Number.isFinite(v)) out.letterSpacingPt = twipToPt(v);
      break;
    }
    case 'caps':
      out.caps = onOff(e) ? 'all' : 'none';
      break;
    case 'smallCaps':
      if (onOff(e)) out.caps = 'small';
      break;
    case 'vanish':
      out.hidden = onOff(e);
      break;
    case 'rStyle':
      // 字符样式引用：记录在 themeColor 之外的字段会污染语义，这里忽略。
      // 真实的字符样式继承由上层在解析 run 时按 styleId 再解析一次。
      break;
    default:
      break;
  }
}

const NAMED_HIGHLIGHT: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  darkblue: '#000080',
  darkcyan: '#008080',
  darkgray: '#808080',
  darkgreen: '#008000',
  darkmagenta: '#800080',
  darkred: '#800000',
  darkyellow: '#808000',
  green: '#00ff00',
  lightgray: '#c0c0c0',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
};

const ALIGN: Record<string, ParaProps['align']> = {
  left: 'left',
  center: 'center',
  right: 'right',
  both: 'justify',
  justify: 'justify',
  distribute: 'justify',
  start: 'start',
  end: 'end',
};

/**
 * 读取 `<w:pPr>` 子树。
 * 注意：`<w:rPr>` 也可以出现在 pPr 内部（段落标记的字符格式），
 * 它是**段落默认字符格式**，需要单独处理而不是混进段落属性。
 */
export function readParaProps(p: XmlPullParser, out: ParaProps = {}): ParaProps {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'rPr': {
        if (e.selfClosing) break;
        out.runDefaults = mergeDefined(out.runDefaults, readRunProps(p, {}));
        continue; // readRunProps 已消费到 </w:rPr>
      }
      case 'numPr': {
        if (e.selfClosing) break;
        let ne: XmlEvent | null;
        while ((ne = p.next()) !== null) {
          if (ne.type === 'end') break;
          if (ne.type !== 'start') continue;
          if (ne.local === 'numId') out.numId = attr(ne, 'val');
          else if (ne.local === 'ilvl') out.ilvl = attrInt(ne, 'val', 0);
        }
        continue;
      }
      case 'tabs': {
        if (e.selfClosing) break;
        const tabs: number[] = [];
        let te: XmlEvent | null;
        while ((te = p.next()) !== null) {
          if (te.type === 'end') break;
          if (te.type !== 'start') continue;
          if (te.local === 'tab') {
            const pos = attrNum(te, 'pos', NaN);
            if (Number.isFinite(pos)) tabs.push(twp(pos));
          }
        }
        if (tabs.length) out.tabsPt = tabs;
        continue;
      }
      case 'pBdr': {
        if (e.selfClosing) break;
        const b: NonNullable<ParaProps['borders']> = {};
        let be: XmlEvent | null;
        while ((be = p.next()) !== null) {
          if (be.type === 'end') break;
          if (be.type !== 'start') continue;
          const line = {
            widthPt: eighthPt(be),
            color: parseColor(attr(be, 'color')),
            style: attr(be, 'val'),
          };
          if (be.local === 'top') b.top = line;
          else if (be.local === 'bottom') b.bottom = line;
          else if (be.local === 'left') b.left = line;
          else if (be.local === 'right') b.right = line;
        }
        out.borders = b;
        continue;
      }
      default:
        applyParaProp(out, e);
        break;
    }
    if (!e.selfClosing) p.skipElement();
  }
  return out;
}

function eighthPt(e: XmlEvent): number {
  return (attrNum(e, 'sz', 4) || 4) / 8;
}

export function applyParaProp(out: ParaProps, e: XmlEvent): void {
  switch (e.local) {
    case 'jc': {
      const v = attr(e, 'val');
      if (v && ALIGN[v]) out.align = ALIGN[v];
      break;
    }
    case 'spacing': {
      // 同时携带 before/after/line/lineRule，需要一次性读全
      const before = attrNum(e, 'before', NaN);
      const after = attrNum(e, 'after', NaN);
      const line = attrNum(e, 'line', NaN);
      const rule = attr(e, 'lineRule');
      if (Number.isFinite(before)) out.spaceBeforePt = twp(before);
      if (Number.isFinite(after)) out.spaceAfterPt = twp(after);
      if (Number.isFinite(line)) {
        if (rule === 'exact' || rule === 'atLeast') out.lineHeightExactPt = twp(line);
        else out.lineHeight = line / 240; // auto：240 = 单倍行距
      }
      break;
    }
    case 'ind': {
      const start = attrNum(e, 'start', NaN) || attrNum(e, 'left', NaN);
      const end = attrNum(e, 'end', NaN) || attrNum(e, 'right', NaN);
      const first = attrNum(e, 'firstLine', NaN);
      const hanging = attrNum(e, 'hanging', NaN);
      if (Number.isFinite(start)) out.indentStartPt = twp(start);
      if (Number.isFinite(end)) out.indentEndPt = twp(end);
      if (Number.isFinite(first)) out.indentFirstPt = twp(first);
      // 悬挂缩进在视觉上等价于「首行负缩进」，统一成同一个字段，避免渲染器分叉
      else if (Number.isFinite(hanging)) out.indentFirstPt = -twp(hanging);
      break;
    }
    case 'outlineLvl': {
      const v = attrInt(e, 'val', -1);
      if (v >= 0) out.outlineLevel = v;
      break;
    }
    case 'pageBreakBefore':
      out.pageBreakBefore = onOff(e);
      break;
    case 'shd': {
      const c = parseColor(attr(e, 'fill'));
      if (c) out.shading = c;
      break;
    }
    case 'keepNext':
      out.keepNext = onOff(e);
      break;
    case 'keepLines':
      out.keepLines = onOff(e);
      break;
    default:
      break;
  }
}

function twp(v: number): number {
  return twipToPt(v);
}

/* ---------------------------- 样式表 ---------------------------- */

export interface StyleDef {
  id: string;
  type: 'paragraph' | 'character' | 'table' | 'numbering' | 'unknown';
  name?: string;
  basedOn?: string;
  link?: string;
  /** 默认段落样式（w:default="1"） */
  isDefault?: boolean;
  rPr?: RunProps;
  pPr?: ParaProps;
}

export interface WordStyles {
  /** docDefaults 里的默认字符属性 */
  defaultRun: RunProps;
  /** docDefaults 里的默认段落属性 */
  defaultPara: ParaProps;
  styles: Map<string, StyleDef>;
  /** 样式名（小写）-> styleId，用于把 "heading 1" 之类的中文/本地化名对上 */
  byName: Map<string, string>;
}

export const EMPTY_WORD_STYLES: WordStyles = {
  defaultRun: {},
  defaultPara: {},
  styles: new Map(),
  byName: new Map(),
};

export function parseWordStyles(xml: string): WordStyles {
  const styles = new Map<string, StyleDef>();
  const byName = new Map<string, string>();
  const out: WordStyles = { defaultRun: {}, defaultPara: {}, styles, byName };

  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start') continue;

    if (e.local === 'docDefaults') {
      if (e.selfClosing) continue;
      let de: XmlEvent | null;
      while ((de = p.next()) !== null) {
        if (de.type === 'end') break;
        if (de.type !== 'start' || de.selfClosing) continue;
        if (de.local === 'rPrDefault') {
          let re: XmlEvent | null;
          while ((re = p.next()) !== null) {
            if (re.type === 'end') break;
            if (re.type !== 'start') continue;
            if (re.local === 'rPr' && !re.selfClosing) readRunProps(p, out.defaultRun);
            else if (!re.selfClosing) p.skipElement();
          }
        } else if (de.local === 'pPrDefault') {
          let pe: XmlEvent | null;
          while ((pe = p.next()) !== null) {
            if (pe.type === 'end') break;
            if (pe.type !== 'start') continue;
            if (pe.local === 'pPr' && !pe.selfClosing) readParaProps(p, out.defaultPara);
            else if (!pe.selfClosing) p.skipElement();
          }
        } else {
          p.skipElement();
        }
      }
      continue;
    }

    if (e.local !== 'style') continue;
    if (e.selfClosing) continue;

    const typeRaw = attr(e, 'type') ?? '';
    const def: StyleDef = {
      id: attr(e, 'styleId') ?? '',
      type: (['paragraph', 'character', 'table', 'numbering'].includes(typeRaw) ? typeRaw : 'unknown') as StyleDef['type'],
      isDefault: attrBool(e, 'default', false),
    };

    let se: XmlEvent | null;
    while ((se = p.next()) !== null) {
      if (se.type === 'end') break;
      if (se.type !== 'start') continue;
      if (se.selfClosing) {
        if (se.local === 'name') def.name = attr(se, 'val');
        else if (se.local === 'basedOn') def.basedOn = attr(se, 'val');
        else if (se.local === 'link') def.link = attr(se, 'val');
        continue;
      }
      if (se.local === 'rPr') def.rPr = readRunProps(p, {});
      else if (se.local === 'pPr') def.pPr = readParaProps(p, {});
      else p.skipElement();
    }

    if (!def.id) continue;
    styles.set(def.id, def);
    // 样式名可能被本地化（中文 Word 里 "heading 1" 会变成 "标题 1"），
    // 因此两种键都登记，让大纲提取不必猜语言。
    const name = (def.name ?? '').trim().toLowerCase();
    if (name && !byName.has(name)) byName.set(name, def.id);
    // 同时用 styleId 的小写形式登记，覆盖 "Heading1" 这类
    const idLower = def.id.toLowerCase();
    if (!byName.has(idLower)) byName.set(idLower, def.id);
  }

  return out;
}

/** 沿 basedOn 链解析出最终的字符属性。 */
export function resolveRunProps(styles: WordStyles, styleId: string | undefined, direct?: RunProps): RunProps {
  let acc: RunProps = { ...styles.defaultRun };
  if (styleId) {
    const chain = styleChain(styles, styleId, 'character').concat(styleChain(styles, styleId, 'paragraph'));
    // 从最基础的一层开始合并，越靠后优先级越高
    for (const def of chain) acc = mergeDefined(acc, def.rPr) ?? acc;
  }
  return mergeDefined(acc, direct) ?? acc;
}

/** 沿 basedOn 链解析出最终的段落属性。 */
export function resolveParaProps(styles: WordStyles, styleId: string | undefined, direct?: ParaProps): ParaProps {
  let acc: ParaProps = { ...styles.defaultPara };
  if (styleId) {
    const chain = styleChain(styles, styleId, 'paragraph');
    for (const def of chain) {
      acc = mergeDefined(acc, def.pPr) ?? acc;
      if (def.pPr?.runDefaults) acc.runDefaults = mergeDefined(acc.runDefaults, def.pPr.runDefaults);
    }
  }
  const merged = mergeDefined(acc, direct) ?? acc;
  // 段落默认字符格式也要并进段落默认里，保证「段落字号」可被解析
  if (direct?.runDefaults) merged.runDefaults = mergeDefined(acc.runDefaults, direct.runDefaults);
  return merged;
}

/**
 * 取样式继承链，返回顺序为 [根 … 自身]，便于从低优先级往高优先级合并。
 * 带环保护：真实文件里出现过样式互相 basedOn 的畸形情况。
 */
function styleChain(styles: WordStyles, styleId: string, preferType: 'paragraph' | 'character'): StyleDef[] {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = styleId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const def = styles.styles.get(cur);
    if (!def) break;
    if (def.type === preferType || def.type === 'unknown' || preferType === 'paragraph') chain.unshift(def);
    cur = def.basedOn;
  }
  return chain;
}

/** 用样式名（可能是本地化名）找 styleId */
export function styleIdByName(styles: WordStyles, name: string): string | undefined {
  return styles.byName.get(name.trim().toLowerCase());
}

/* ---------------------------- 编号 ---------------------------- */

export interface ListLevel {
  level: number;
  /** 编号格式：bullet / decimal / lowerLetter / upperRoman / chineseCounting … */
  numFmt: string;
  /** 编号模板，如 "%1." 或 "•" */
  lvlText: string;
  start: number;
  /** 缩进，twip 原值 */
  indentStartTwip?: number;
  hangingTwip?: number;
  /** 项目符号用的字体（如 Symbol / Wingdings），直接影响渲染出的符号字形 */
  font?: string;
  align?: string;
}

export interface Numbering {
  /** numId -> abstractNumId */
  numToAbstract: Map<string, string>;
  /** abstractNumId -> levels */
  abstract: Map<string, ListLevel[]>;
}

export const EMPTY_NUMBERING: Numbering = { numToAbstract: new Map(), abstract: new Map() };

export function parseNumbering(xml: string): Numbering {
  const numToAbstract = new Map<string, string>();
  const abstract = new Map<string, ListLevel[]>();

  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start') continue;

    if (e.local === 'num' && !e.selfClosing) {
      const numId = attr(e, 'numId');
      let ne: XmlEvent | null;
      while ((ne = p.next()) !== null) {
        if (ne.type === 'end') break;
        if (ne.type !== 'start') continue;
        if (ne.local === 'abstractNumId') {
          const a = attr(ne, 'val');
          if (numId && a !== undefined) numToAbstract.set(numId, a);
        }
        if (!ne.selfClosing) p.skipElement();
      }
      continue;
    }

    if (e.local === 'abstractNum' && !e.selfClosing) {
      const aId = attr(e, 'abstractNumId');
      const levels: ListLevel[] = [];
      let ae: XmlEvent | null;
      while ((ae = p.next()) !== null) {
        if (ae.type === 'end') break;
        if (ae.type !== 'start') continue;
        if (ae.local !== 'lvl' || ae.selfClosing) {
          if (!ae.selfClosing) p.skipElement();
          continue;
        }
        const lvl: ListLevel = {
          level: attrInt(ae, 'ilvl', levels.length),
          numFmt: 'decimal',
          lvlText: '',
          start: 1,
        };
        let le: XmlEvent | null;
        while ((le = p.next()) !== null) {
          if (le.type === 'end') break;
          if (le.type !== 'start') continue;
          if (le.selfClosing) {
            if (le.local === 'start') lvl.start = attrInt(le, 'val', 1);
            else if (le.local === 'numFmt') lvl.numFmt = attr(le, 'val') ?? 'decimal';
            else if (le.local === 'lvlText') lvl.lvlText = attr(le, 'val') ?? '';
            else if (le.local === 'lvlJc') lvl.align = attr(le, 'val');
            else if (le.local === 'rFonts') lvl.font = attr(le, 'ascii') ?? attr(le, 'hAnsi') ?? attr(le, 'eastAsia');
          } else if (le.local === 'pPr') {
            // lvl 内的 pPr 携带缩进
            let pe: XmlEvent | null;
            while ((pe = p.next()) !== null) {
              if (pe.type === 'end') break;
              if (pe.type !== 'start') continue;
              if (pe.local === 'ind') {
                const s = attrNum(pe, 'start', NaN) || attrNum(pe, 'left', NaN);
                const h = attrNum(pe, 'hanging', NaN);
                if (Number.isFinite(s)) lvl.indentStartTwip = s;
                if (Number.isFinite(h)) lvl.hangingTwip = h;
              }
              if (!pe.selfClosing) p.skipElement();
            }
          } else {
            p.skipElement();
          }
        }
        levels[lvl.level] = lvl;
      }
      if (aId !== undefined) abstract.set(aId, levels.filter(Boolean));
      continue;
    }

    // 其余元素一律**不跳过**，让拉取解析器自然向下遍历。
    // 早期版本在这里写 `p.skipElement()`，结果连根元素 <w:numbering> 都被整棵跳过，
    // 于是永远解析出 0 个编号 —— 是个只要跑真实文件就会暴露的错误。
  }

  return { numToAbstract, abstract };
}

/** 取某个 numId 在指定层级的编号定义 */
export function levelOf(numbering: Numbering, numId: string | undefined, ilvl: number): ListLevel | undefined {
  if (!numId) return undefined;
  const aId = numbering.numToAbstract.get(numId);
  if (aId === undefined) return undefined;
  const levels = numbering.abstract.get(aId);
  if (!levels) return undefined;
  return levels[ilvl] ?? levels[0];
}

/**
 * 把编号模板渲染成单体文本。
 * 多级编号如 "%1.%2." 在没有计数器上下文时无法正确展开，
 * 这里退化为「用起始值填充」并让上层在已有计数器时替换 —— 目标是给出可读的
 * 视觉近似，而不是假装能完整还原编号状态机。
 */
export function renderListMarker(level: ListLevel, counters?: readonly number[]): string {
  if (level.numFmt === 'bullet') {
    const t = level.lvlText || '•';
    // Word 里项目符号常用 Symbol/Wingdings 的私有字符，直接显示会是乱码，
    // 这里映射到视觉等价的通用字符。
    return mapBullet(t, level.font);
  }
  return level.lvlText.replace(/%(\d)/g, (_m, d) => {
    const idx = Number.parseInt(d, 10) - 1;
    const value = counters?.[idx] ?? level.start;
    return formatNumber(value, level.numFmt);
  });
}

const BULLET_MAP: Record<string, string> = {
  '\uf0b7': '•', // Symbol 的圆点
  '\uf0a7': '▪', // Wingdings 方块
  '\uf0d8': '➢',
  '\u25cf': '●',
  '\u25cb': '○',
  '\u25a0': '■',
  '\u25aa': '▪',
  o: '○',
  n: '■',
  l: '●',
  u: '▪',
  '\u00b7': '•',
};

function mapBullet(text: string, font?: string): string {
  const first = text[0];
  if (!first) return '•';
  const mapped = BULLET_MAP[first];
  if (mapped) return mapped;
  const code = first.codePointAt(0) ?? 0;
  // 私用区（Symbol/Wingdings 字形）无法直接显示，统一退回圆点而不是显示豆腐块
  if (code >= 0xe000 && code <= 0xf8ff) return font && /wingdings/i.test(font) ? '▪' : '•';
  return text;
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

const CN_DIGITS = '零一二三四五六七八九';

export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case 'decimal':
    case 'decimalZero':
      return fmt === 'decimalZero' ? String(n).padStart(2, '0') : String(n);
    case 'lowerLetter':
      return alpha(n, false);
    case 'upperLetter':
      return alpha(n, true);
    case 'lowerRoman':
      return roman(n);
    case 'upperRoman':
      return roman(n).toUpperCase();
    case 'chineseCounting':
    case 'chineseCountingThousand':
      return chinese(n);
    case 'japaneseCounting':
      return chinese(n);
    case 'ideographDigital':
      return chinese(n);
    case 'none':
      return '';
    default:
      return String(n);
  }
}

function alpha(n: number, upper: boolean): string {
  let s = '';
  let v = Math.max(1, Math.floor(n));
  while (v > 0) {
    const rem = (v - 1) % 26;
    s = String.fromCharCode((upper ? 65 : 97) + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

function roman(n: number): string {
  let v = Math.max(1, Math.floor(n));
  let s = '';
  for (const [value, sym] of ROMAN) {
    while (v >= value) {
      s += sym;
      v -= value;
    }
  }
  return s || 'i';
}

function chinese(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v === 0) return CN_DIGITS[0];
  if (v < 10) return CN_DIGITS[v];
  if (v < 20) return `十${v === 10 ? '' : CN_DIGITS[v % 10]}`;
  if (v < 100) {
    const tens = Math.floor(v / 10);
    const ones = v % 10;
    return `${CN_DIGITS[tens]}十${ones ? CN_DIGITS[ones] : ''}`;
  }
  return String(v);
}
