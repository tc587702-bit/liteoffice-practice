/**
 * ODF 样式解析：命名样式、自动样式、默认样式、列表样式、数字格式。
 *
 * 为什么这块必须做对：ODF 的正文里通常只写 `text:style-name="P1"`，
 * 真正的字号/颜色/缩进/项目符号全在 `office:automatic-styles` 或 `styles.xml` 里。
 * 不解析这层间接，打开的 odt 会全部是 12pt 黑字、列表全变成普通段落 ——
 * 「能打开」但一眼假。这与 docx 的样式继承重要性完全等价。
 *
 * ODF 与 OOXML 在样式模型上的关键差异（实现时必须记住）：
 *   1) **只有单亲**：`style:parent-style-name` 一条链，没有 basedOn + link 双链。
 *   2) **样式按「样式族」命名空间隔离**：paragraph / text / table-cell 各自一片。
 *      同一个名字在不同 family 下是两个样式，所以 key 是 `family:name`。
 *   3) **默认值来自 style:default-style**，它是隐式的链尾；命名样式没写 parent 时
 *      要回退到对应 family 的 default-style，否则会丢掉整篇的基础字号与字体。
 *   4) 自动样式（automatic-styles）优先于命名样式 —— LibreOffice 把直接格式
 *      全部导出成自动样式。搜索顺序必须是：content.xml 的自动样式 ->
 *      styles.xml 的自动样式 -> styles.xml 的命名样式。
 *
 * 属性读取上还有两个坑：
 *   - `style:font-size-rel` / `style:font-size-asian` 等变体要一起兜底；
 *   - 很多数值带 `%` 或长度单位（`0.5in` / `12pt` / `1.5cm`），
 *     一律走 cssLengthToPt 统一到 pt（模型内只有 pt）。
 */
import { XmlPullParser, splitName } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { cssLengthToPt } from '../../core/src/units.ts';
import {
  attr,
  attrBool,
  attrInt,
  attrNum,
  mergeDefined,
  parseColor,
} from './xmlUtil.ts';
import { emptyStyles } from './types.ts';
import type {
  OdCellProps,
  OdListLevel,
  OdListStyle,
  OdPageLayout,
  OdParaProps,
  OdRunProps,
  OdStyleDef,
  OdStyles,
} from './types.ts';

/* ==================================================================== */
/* 字符属性                                                              */
/* ==================================================================== */

export function applyRunProp(out: OdRunProps, e: XmlEvent): void {
  switch (e.local) {
    case 'font-weight': {
      // ODF 允许数字权重（600/700）与命名权重（bold/normal）混用
      const v = attr(e, 'font-weight');
      if (v === undefined) break;
      const s = v.trim().toLowerCase();
      if (s === 'bold' || s === 'bolder') out.bold = true;
      else if (s === 'normal' || s === 'lighter') out.bold = false;
      else {
        const n = Number.parseInt(s, 10);
        if (Number.isFinite(n)) out.bold = n >= 600;
      }
      break;
    }
    case 'font-style': {
      const v = attr(e, 'font-style');
      if (v === 'italic' || v === 'oblique') out.italic = true;
      else if (v === 'normal') out.italic = false;
      break;
    }
    case 'text-underline-style': {
      // 值有 solid/dotted/dash/dot-dash/wave/none；除 none 之外都算有下划线。
      // 注意：不能只认 "solid"，LibreOffice 对拼写检查线之外的常规下划线写 solid，
      // 但第三方生成器会写 "single"，所以这里用「非 none 即有」的反向判断。
      const v = attr(e, 'text-underline-style');
      if (v !== undefined) out.underline = v !== 'none';
      break;
    }
    case 'text-line-through-style': {
      const v = attr(e, 'text-line-through-style');
      if (v !== undefined) out.strike = v !== 'none';
      break;
    }
    case 'color': {
      const c = parseColor(attr(e, 'color'));
      if (c) out.color = c;
      break;
    }
    case 'background-color': {
      // fo:background-color 在 text-properties 里是「字符底纹」，
      // 与段落底纹、单元格底色同名不同义，必须按所在容器区分。
      const c = parseColor(attr(e, 'background-color'));
      if (c) out.highlight = c;
      break;
    }
    case 'font-size': {
      // style:font-size-asian / complex 与 fo:font-size 同义：
      // 中文文档常常只写 asian 分量，只读 fo:font-size 会拿不到字号。
      const raw = attr(e, 'font-size') ?? attr(e, 'font-size-asian') ?? attr(e, 'font-size-complex');
      if (raw !== undefined) {
        const pt = cssLengthToPt(stripRel(raw), NaN);
        if (Number.isFinite(pt) && pt > 0) out.sizePt = pt;
      }
      break;
    }
    case 'font-name': {
      const f = attr(e, 'font-name') ?? attr(e, 'font-name-asian');
      if (f) out.font = f;
      break;
    }
    case 'font-name-asian':
    case 'font-name-complex': {
      const f = attr(e, e.local);
      if (f) out.fontAsian = f;
      break;
    }
    case 'font-family': {
      // style:font-family 是 CSS 风格的候选列表："'宋体', SimSun, serif"
      if (!out.font) {
        const fam = attr(e, 'font-family');
        if (fam) out.font = fam.split(',')[0].replace(/^['"]|['"]$/g, '').trim();
      }
      break;
    }
    case 'text-position': {
      // 值形如 "58% 33%"（上标）/"-33% 58%"（下标）/"100% 0%"（正常）。
      // 第一个数是字号缩放，第二个是基线偏移百分比；偏移**正数表示上升**。
      const v = attr(e, 'text-position');
      if (v === undefined) break;
      const m = /^\s*(-?[\d.]+)%\s+(-?[\d.]+)%/.exec(v);
      if (!m) {
        out.vertAlign = 'baseline';
        break;
      }
      const shift = Number.parseFloat(m[2]);
      out.vertAlign = !Number.isFinite(shift) || shift === 0 ? 'baseline' : shift > 0 ? 'superscript' : 'subscript';
      break;
    }
    case 'letter-spacing': {
      const v = attr(e, 'letter-spacing');
      if (v === undefined) break;
      const pt = cssLengthToPt(stripRel(v), NaN);
      if (Number.isFinite(pt)) out.letterSpacingPt = pt;
      break;
    }
    case 'text-transform': {
      const v = attr(e, 'text-transform');
      if (v === 'uppercase' || v === 'lowercase' || v === 'capitalize') out.caps = 'all';
      else if (v === 'none') out.caps = 'none';
      break;
    }
    case 'text-display': {
      const v = attr(e, 'text-display');
      if (v !== undefined) out.hidden = v === 'none';
      break;
    }
    default:
      break;
  }
}

/** `style:font-size-rel="0.8*"` 这类「相对值」无法在单点解析，退化成不设值。 */
function stripRel(v: string): string {
  return v.endsWith('*') ? '' : v;
}

/* ==================================================================== */
/* 段落属性                                                              */
/* ==================================================================== */

const PARAGRAPH_ALIGN: Record<string, OdParaProps['align']> = {
  start: 'start',
  end: 'end',
  left: 'left',
  right: 'right',
  center: 'center',
  justify: 'justify',
};

export function applyParaProp(out: OdParaProps, e: XmlEvent): void {
  switch (e.local) {
    case 'text-align': {
      const v = attr(e, 'text-align');
      if (v && PARAGRAPH_ALIGN[v]) out.align = PARAGRAPH_ALIGN[v];
      break;
    }
    case 'margin-top': {
      const v = attr(e, 'margin-top');
      if (v !== undefined) out.spaceBeforePt = cssLengthToPt(v, 0);
      break;
    }
    case 'margin-bottom': {
      const v = attr(e, 'margin-bottom');
      if (v !== undefined) out.spaceAfterPt = cssLengthToPt(v, 0);
      break;
    }
    case 'line-height': {
      const v = attr(e, 'line-height');
      if (v === undefined) break;
      const s = v.trim();
      // 百分比是「相对单倍行距的倍率」；长度是精确值。
      if (s.endsWith('%')) {
        const n = Number.parseFloat(s);
        if (Number.isFinite(n) && n > 0) out.lineHeight = n / 100;
      } else {
        const pt = cssLengthToPt(s, NaN);
        if (Number.isFinite(pt) && pt > 0) out.lineHeightExactPt = pt;
      }
      break;
    }
    case 'text-indent': {
      const v = attr(e, 'text-indent');
      if (v !== undefined) out.indentFirstPt = cssLengthToPt(v, 0);
      break;
    }
    case 'margin-left': {
      const v = attr(e, 'margin-left');
      if (v !== undefined) out.indentStartPt = cssLengthToPt(v, 0);
      break;
    }
    case 'margin-right': {
      const v = attr(e, 'margin-right');
      if (v !== undefined) out.indentEndPt = cssLengthToPt(v, 0);
      break;
    }
    case 'page-break-before': {
      const v = attr(e, 'page-break-before');
      if (v !== undefined) out.pageBreakBefore = v === 'page' || v === 'always';
      break;
    }
    case 'background-color': {
      const c = parseColor(attr(e, 'background-color'));
      if (c) out.shading = c;
      break;
    }
    case 'outline-level': {
      // ODF 的 text:outline-level 是 1 起，模型里是 0 起
      const v = attrInt(e, 'outline-level', -1);
      if (v > 0) out.outlineLevel = v - 1;
      break;
    }
    case 'writing-mode': {
      // 目前模型没有竖排字段，记录 warn 由上层决定；这里只保证不崩。
      break;
    }
    default:
      break;
  }
}

/**
 * 遍历当前元素的子节点，对每个 start 事件调用 onStart，
 * 然后跳过其子树（除非它是需要继续下钻的容器）。
 *
 * 为什么会写这个而不是 parser.skipElement() 一把梭：
 * `style:text-properties` / `style:paragraph-properties` 里既有
 * **属性**（fo:font-weight 在元素自身上）又有**子元素**
 * （style:background-image、style:tab-stops、style:tab-stop）。
 * 既要读到属性又不能漏掉嵌套结构，只能逐层走。
 */
function consume(p: XmlPullParser, onStart: (e: XmlEvent) => void, skipSubtree?: (e: XmlEvent) => boolean): void {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    if (skipSubtree?.(e)) {
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    onStart(e);
    if (!e.selfClosing) p.skipElement();
  }
}

/** `style:font-face-decls` 会与属性容器并列出现，跳过它以免误读。 */
function isFontFaceDecl(e: XmlEvent): boolean {
  return e.local === 'font-face-decls';
}

/* ==================================================================== */
/* 属性容器 -> 逐属性读取                                                */
/* ==================================================================== */

/**
 * ODF 的属性容器（`style:text-properties` / `style:paragraph-properties` /
 * `style:table-cell-properties` / `style:page-layout-properties`）把真正的属性
 * 写成**元素自身的属性**：
 *
 *   <style:text-properties fo:font-weight="bold" fo:font-size="12pt"/>
 *
 * 这是 ODF 与 OOXML 最大的结构差异：OOXML 里 `<w:b/>` 是元素，ODF 里
 * `fo:font-weight` 是属性。因此「按元素本地名 switch」的写法永远匹配不上
 * —— 早期版本就是这样，结果所有样式解析出来都是空对象，整篇文档退回默认
 * 12pt 黑字（能打开，但一眼假）。
 *
 * 正确做法是把每个属性**伪装成一个元素事件**，与真正的子元素一起交给同一个
 * applyXxxProp，这样两种写法（属性 / 子元素）共用同一套语义。
 */
function forEachAttr(e: XmlEvent, fn: (name: string, value: string) => void): void {
  const a = e.attrs;
  if (!a) return;
  for (const k of Object.keys(a)) {
    const value = a[k];
    if (value !== undefined) fn(k, value);
  }
}

/** 构造一个只带单个属性的伪事件，供 applyXxxProp 读取。 */
function attrEvent(name: string, value: string, local: string): XmlEvent {
  const attrs: Record<string, string> = {};
  attrs[name] = value;
  return { type: 'start', name, local, prefix: '', attrs, selfClosing: true, text: '' };
}

/**
 * 遍历属性容器：先把它**自身的属性**逐个喂给 apply，再把每个**子元素**
 * （含子元素自身的属性）喂给 apply，最后把容器元素本身也交给 apply 兜底。
 *
 * 为什么子元素也要走 attrEvent：`style:table-cell-properties` 内部可能有
 * `<style:paragraph-properties fo:text-align="right"/>` 这类**只带属性**的空元素。
 * 只调用 `apply(child)` 会因为 child.local 是 'paragraph-properties' 而什么都不做。
 */
function consumePropContainer(p: XmlPullParser, e: XmlEvent, apply: (ev: XmlEvent) => void, skipSubtree?: (ev: XmlEvent) => boolean): void {
  forEachAttr(e, (name, value) => apply(attrEvent(name, value, splitName(name).local)));
  apply(e);
  if (e.selfClosing) return;
  let c: XmlEvent | null;
  while ((c = p.next()) !== null) {
    if (c.type === 'end') return;
    if (c.type !== 'start') continue;
    if (skipSubtree?.(c)) {
      if (!c.selfClosing) p.skipElement();
      continue;
    }
    forEachAttr(c, (name, value) => apply(attrEvent(name, value, splitName(name).local)));
    apply(c);
    if (!c.selfClosing) p.skipElement();
  }
}

/** 读 `style:text-properties`。 */
function readTextProperties(p: XmlPullParser, e: XmlEvent, out: OdRunProps): void {
  consumePropContainer(p, e, (ev) => applyRunProp(out, ev), isFontFaceDecl);
}

/** 读 `style:paragraph-properties`。 */
function readParaProperties(p: XmlPullParser, e: XmlEvent, out: OdParaProps): void {
  consumePropContainer(p, e, (ev) => applyParaProp(out, ev), (child) => child.local === 'tab-stops');
}

/** 读 `style:table-cell-properties`。 */
function readCellProperties(p: XmlPullParser, e: XmlEvent, out: OdCellProps): void {
  consumePropContainer(p, e, (ev) => applyCellProp(out, ev), (child) => child.local === 'background-image');
}

/** 读 `style:page-layout-properties`。 */
function readPageProperties(e: XmlEvent, out: OdPageLayout): void {
  forEachAttr(e, (name, value) => applyPageProp(out, attrEvent(name, value, splitName(name).local)));
  applyPageProp(out, e);
}

/* ==================================================================== */
/* 单元格属性                                                            */
/* ==================================================================== */

const CELL_VALIGN: Record<string, OdCellProps['vAlign']> = {
  top: 'top',
  middle: 'middle',
  bottom: 'bottom',
  automatic: 'middle',
};

export function applyCellProp(out: OdCellProps, e: XmlEvent): void {
  switch (e.local) {
    case 'background-color': {
      const c = parseColor(attr(e, 'background-color'));
      if (c) out.bg = c;
      break;
    }
    case 'vertical-align': {
      const v = attr(e, 'vertical-align');
      if (v && CELL_VALIGN[v]) out.vAlign = CELL_VALIGN[v];
      break;
    }
    case 'wrap-option': {
      const v = attr(e, 'wrap-option');
      if (v !== undefined) out.wrap = v !== 'none';
      break;
    }
    case 'border': {
      // style:border 是四条边的简写，值形如 "0.5pt solid #000000" 或 "none"
      const v = attr(e, 'border');
      if (v !== undefined) applyBorderShorthand(out, v);
      break;
    }
    case 'border-top':
    case 'border-bottom':
    case 'border-left':
    case 'border-right': {
      // 逐边定义时，任一非 none 的边都够我们给出「有边框」的结论；
      // 模型里的 BorderStyle 支持逐边，但导入时简化为统一边框更省内存。
      const v = attr(e, e.local);
      if (v !== undefined && !/^\s*none/i.test(v)) applyBorderShorthand(out, v);
      break;
    }
    case 'border-line-width': {
      // ODF 1.2 的「双线」写法：style:border-line-width="0.5pt 1pt 0.5pt"
      const v = attr(e, 'border-line-width');
      if (v !== undefined) {
        const first = Number.parseFloat(v);
        if (Number.isFinite(first) && first > 0) out.borderWidthPt = cssLengthToPt(v.split(/\s+/)[0], first);
      }
      break;
    }
    case 'text-align': {
      // 单元格样式的对齐可以来自两处：style:table-cell-properties 自身，
      // 或它内部的 style:paragraph-properties（LibreOffice 走后者）。
      // 两处都要认，否则设置过对齐的单元格会全部左对齐。
      applyCellAlign(out, attr(e, 'text-align'));
      break;
    }
    case 'paragraph-properties': {
      // 关键：`style:paragraph-properties` 的**本地名**就是这个 case。
      // consumePropContainer 会把每个子元素本身也交给 apply（不只是它的属性），
      // 因此必须在 label 上显式取 text-align —— 早期版本只处理了子元素的
      // **属性**（把段落属性伪装成 fo:text-align 事件），于是「对齐写在
      // paragraph-properties 元素上」这种最常见的写法完全读不到。
      applyCellAlign(out, attr(e, 'text-align'));
      break;
    }
    case 'text-properties':
      break;
    case 'font-weight':
    case 'font-style':
    case 'font-size':
    case 'color':
    case 'text-underline-style':
    case 'text-line-through-style':
    case 'font-name': {
      // 单元格的字符格式与 run 共用同一批属性名，
      // 这里复用 applyRunProp 再映射到 CellStyle，避免两套解析逻辑漂移。
      const r: OdRunProps = {};
      applyRunProp(r, e);
      if (r.bold !== undefined) out.bold = r.bold;
      if (r.italic !== undefined) out.italic = r.italic;
      if (r.underline !== undefined) out.underline = r.underline;
      if (r.strike !== undefined) out.strike = r.strike;
      if (r.color) out.color = r.color;
      if (r.sizePt !== undefined) out.sizePt = r.sizePt;
      if (r.font) out.font = r.font;
      break;
    }
    default:
      break;
  }
}

/**
 * 单元格的水平对齐。
 * ODF 的 `start`/`end` 是「书写方向相关」的（竖排时含义会翻转），
 * 这里按绝大多数文件的实际情况映射成 left/right。
 */
function applyCellAlign(out: OdCellProps, v: string | undefined): void {
  switch (v) {
    case 'start':
    case 'left':
      out.align = 'left';
      break;
    case 'end':
    case 'right':
      out.align = 'right';
      break;
    case 'center':
      out.align = 'center';
      break;
    case 'justify':
      // 模型里单元格没有 justify，按左对齐处理
      out.align = 'left';
      break;
    default:
      break;
  }
}

/** 解析 `0.5pt solid #ff0000` / `none` / `1pt dashed` */
function applyBorderShorthand(out: OdCellProps, raw: string): void {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const color = /^#/.test(part) ? parseColor(part) : undefined;
    if (color) {
      out.borderColor = color;
      continue;
    }
    if (/^(solid|dashed|dotted|double|none|groove|ridge|inset|outset)$/i.test(part)) {
      const s = part.toLowerCase();
      out.borderStyle = s === 'groove' || s === 'ridge' || s === 'inset' || s === 'outset' ? 'solid' : (s as OdCellProps['borderStyle']);
      continue;
    }
    const pt = cssLengthToPt(part, NaN);
    if (Number.isFinite(pt) && pt > 0) out.borderWidthPt = pt;
  }
}

/* ==================================================================== */
/* 页面 / 绘图属性                                                       */
/* ==================================================================== */

export function applyPageProp(out: OdPageLayout, e: XmlEvent): void {
  switch (e.local) {
    case 'page-width': {
      const v = attr(e, 'page-width');
      if (v !== undefined) out.widthPt = cssLengthToPt(v, NaN);
      break;
    }
    case 'page-height': {
      const v = attr(e, 'page-height');
      if (v !== undefined) out.heightPt = cssLengthToPt(v, NaN);
      break;
    }
    case 'margin-top':
    case 'margin-right':
    case 'margin-bottom':
    case 'margin-left': {
      const v = attr(e, e.local);
      if (v === undefined) break;
      const m = (out.margin ??= { top: 0, right: 0, bottom: 0, left: 0 });
      const key = e.local.slice('margin-'.length) as 'top' | 'right' | 'bottom' | 'left';
      m[key] = cssLengthToPt(v, 0);
      break;
    }
    case 'writing-mode': {
      const v = attr(e, 'writing-mode');
      if (v) out.writingMode = v;
      break;
    }
    default:
      break;
  }
}

/* ==================================================================== */
/* 主解析入口                                                            */
/* ==================================================================== */

export interface ParsedStyleSources {
  /** content.xml 的样式（自动样式优先） */
  content?: string;
  /** styles.xml 的样式（命名样式） */
  styles?: string;
}

/**
 * 解析样式。**content.xml 必须先于 styles.xml 注册**，
 * 这样 `resolveStyleDef` 里「后注册覆盖先注册」的语义正好等价于
 * 「自动样式优先于命名样式」（ODF 规范：直接格式导出为自动样式，优先级更高）。
 */
export function parseOdStyles(sources: ParsedStyleSources): OdStyles {
  const out = emptyStyles();
  if (sources.styles) parseStyleXml(sources.styles, out, out.defs);
  if (sources.content) parseStyleXml(sources.content, out, out.defs);
  return out;
}

/** 元素处理结果：整棵子树已被解析函数吃掉 / 需要继续下钻 */
const CONSUMED = 1;
const DESCEND = 2;

/**
 * 从一个 XML 文档里提取全部样式定义，合并进 out。
 *
 * 为什么用「返回三态码」而不是在 switch 里写 `continue`：
 *   `continue` 在 switch 内部作用于外层循环，**但它与「switch 结束后继续往下执行」
 *   在阅读上完全无法区分**。早期版本在 switch 末尾统一收尾
 *   `if (!e.selfClosing) p.skipElement()`，于是那些 `continue` 形同虚设，
 *   每个已解析完的样式又被多跳过一棵子树 —— 结果是 office:styles 里只要有一个
 *   非自闭合的 style，紧随其后的 page-layout 就整棵消失，页面尺寸只能退回默认。
 *   同一个坑在本包里出现过多处（另有正文分派、单元格属性两处），
 *   所以这里统一成显式三态。
 */
export function parseStyleXml(xml: string, out: OdStyles, defs: Map<string, OdStyleDef>): void {
  let p: XmlPullParser;
  try {
    p = new XmlPullParser(xml, { chunkSize: 1 << 18 });
  } catch {
    return;
  }
  let e: XmlEvent | null;
  try {
    while ((e = p.next()) !== null) {
      if (e.type !== 'start') continue;
      const action = dispatchStyleElement(p, e, out, defs);
      if (action === DESCEND && !e.selfClosing) {
        // 容器：继续下钻找子元素，**不能 skipElement**（否则子样式全丢）
        continue;
      }
    }
  } catch {
    // 样式 XML 损坏：降级为「没有样式」，正文仍应能打开。
    // 这是刻意的：宁可全用默认格式，也不要因为 styles.xml 有问题就整篇打不开。
  }
}

/** 分派一个样式相关元素。 */
function dispatchStyleElement(p: XmlPullParser, e: XmlEvent, out: OdStyles, defs: Map<string, OdStyleDef>): number {
  switch (e.local) {
    case 'style': {
      // `text:list-style` 与 `style:style` 的**本地名都是 "style"**！
      // 早期版本在这里一律按 style:style 处理，于是所有列表样式都被
      // 当成 family 为空的普通样式，列表符号/编号全部解析不到，
      // 整篇文档的列表退化成普通段落。必须靠属性区分：
      //   style:style      -> style:name + style:family
      //   text:list-style  -> text:name，没有 style:family
      if (attr(e, 'family') === undefined) {
        readListStyle(p, e, out, attr(e, 'name'));
        return CONSUMED;
      }
      readStyle(p, e, out, defs);
      return CONSUMED;
    }
    case 'default-style':
      readDefaultStyle(p, e, out);
      return CONSUMED;
    case 'page-layout':
      // `style:page-layout` 是页面尺寸/页边距的载体，**没有** style:family 属性
      // （family 隐含为 page-layout）。早期版本把它当作未知容器下钻，
      // 于是尺寸信息从未登记，幻灯片/文档页面永远退回默认值。
      readStyle(p, e, out, defs);
      return CONSUMED;
    case 'list-style':
      readListStyle(p, e, out, attr(e, 'name'));
      return CONSUMED;
    case 'master-page':
      readMasterPage(p, e, out);
      return CONSUMED;
    case 'percentage-style':
    case 'currency-style':
    case 'date-style':
    case 'time-style':
    case 'boolean-style':
    case 'text-style':
    case 'number-style':
      readDataStyle(p, e, out);
      return CONSUMED;
    default:
      // 其余元素一律**下钻**：office:styles 下还有 page-layout、
      // text:outline-style、font-face-decls 等容器，它们的子元素才是样式定义。
      // 早期版本在这里 skipElement()，结果连 <office:document-styles> 都被跳过，
      // 一个样式都解析不出来。
      return DESCEND;
  }
}

function styleKey(family: string, name: string): string {
  return `${family}\u0000${name}`;
}

/**
 * 把「单元格样式里的段落对齐」同步到 `cell.align`。
 *
 * 为什么需要这一步：单元格的水平对齐在 ODF 里写成
 * `<style:paragraph-properties fo:text-align="right"/>`，它可能是
 * `style:table-cell-properties` 的子元素，也可能是它的**兄弟**（当
 * table-cell-properties 自闭合时）。前者由 readCellProperties 处理，
 * 后者由 readStyleBody 的 paragraph-properties 分支处理。
 * 统一在样式读完后做一次同步，两条路径就都覆盖到了 —— 比在每个分支里
 * 各写一遍映射更不容易漏。
 */
function syncCellAlign(def: OdStyleDef): void {
  if (def.family !== 'table-cell' || !def.cell) return;
  const a = def.para?.align;
  if (!a || def.cell.align !== undefined) return;
  switch (a) {
    case 'start':
    case 'left':
    case 'justify':
      def.cell.align = 'left';
      break;
    case 'end':
    case 'right':
      def.cell.align = 'right';
      break;
    case 'center':
      def.cell.align = 'center';
      break;
    default:
      break;
  }
}

function readStyle(p: XmlPullParser, e: XmlEvent, out: OdStyles, defs: Map<string, OdStyleDef>): void {
  // style:page-layout 没有 style:family，但它属于 page-layout 家族；
  // 其余样式元素（style:style / style:default-style）都显式带 family。
  const family = attr(e, 'family') ?? (e.local === 'page-layout' ? 'page-layout' : 'unknown');
  const name = attr(e, 'name') ?? '';
  const def: OdStyleDef = {
    name,
    family,
    parent: attr(e, 'parent-style-name'),
    displayName: attr(e, 'display-name'),
  };
  if (!e.selfClosing) readStyleBody(p, def);
  syncCellAlign(def);
  if (!name) return;
  // 自动样式与命名样式**同名时自动样式胜出**：两个来源合并到同一个 Map，
  // 后写入的覆盖先写入的，调用方保证 content.xml 后注册。
  defs.set(styleKey(family, name), def);
  // 同时用「裸名」登记一份，便于 table:style-name 之类不带 family 的引用兜底命中。
  // 只在没被占用时写，避免家族之间互相覆盖。
  if (!defs.has(name)) defs.set(name, def);
}

function readDefaultStyle(p: XmlPullParser, e: XmlEvent, out: OdStyles): void {
  const family = attr(e, 'family') ?? 'unknown';
  const def: OdStyleDef = { name: `__default_${family}`, family, isDefault: true };
  if (!e.selfClosing) readStyleBody(p, def);
  out.defaults.set(family, def);
}

/**
 * 读 `style:style` / `style:default-style` / `style:page-layout` 等元素的体。
 *
 * **这里绝对不能在 switch 之后写收尾语句**（例如 `if (!e.selfClosing) p.skipElement()`）：
 * case 里的 `continue` 只作用于外层 while 循环，但读者会误以为它是「跳出 switch」，
 * 于是每个已解析完的属性容器又被多跳过一棵子树，把**紧随其后的属性容器**吃掉。
 * 早期版本就是这样丢掉 page-layout 的尺寸（幻灯片永远 720×540）以及
 * 表格单元格样式后面的所有属性。
 * 因此这里每个分支都自己负责消费，switch 后不留任何语句。
 */
function readStyleBody(p: XmlPullParser, def: OdStyleDef): void {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'text-properties':
        readTextProperties(p, e, (def.run ??= {}));
        continue;
      case 'paragraph-properties':
        // 单元格样式里的 paragraph-properties 描述的是**单元格内容**的段落属性，
        // 其中最有用的一项是 fo:text-align —— 它需要落到 CellStyle.align 上。
        // 为什么不能只在 readCellProperties 里处理：`style:table-cell-properties`
        // 常常是**自闭合**的（`<... fo:border="..."/>`），此时它的兄弟节点
        // `style:paragraph-properties` 是由**这里**处理的，那条路径根本不会经过
        // readCellProperties。两条路径都要把对齐映射进 cell（见 syncCellAlign）。
        readParaProperties(p, e, (def.para ??= {}));
        continue;
      case 'table-cell-properties':
        readCellProperties(p, e, (def.cell ??= {}));
        continue;
      case 'table-column-properties': {
        const w = attr(e, 'column-width');
        if (w !== undefined) def.columnWidthPt = cssLengthToPt(w, NaN);
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      case 'table-row-properties': {
        const h = attr(e, 'row-height');
        if (h !== undefined) def.rowHeightPt = cssLengthToPt(h, NaN);
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      case 'graphic-properties': {
        const fill = parseColor(attr(e, 'fill-color'));
        if (fill) def.fill = fill;
        const stroke = attr(e, 'stroke');
        if (stroke === 'none') def.stroke = 'none';
        else {
          const sc = parseColor(attr(e, 'stroke-color'));
          if (sc) def.stroke = sc;
        }
        const sw = attr(e, 'stroke-width');
        if (sw !== undefined) {
          const pt = cssLengthToPt(sw, NaN);
          if (Number.isFinite(pt)) def.strokeWidthPt = pt;
        }
        const op = attr(e, 'opacity');
        if (op !== undefined) {
          const n = Number.parseFloat(op);
          if (Number.isFinite(n)) def.opacity = n >= 0 && n <= 1 ? n : n / 100;
        }
        const dataStyle = attr(e, 'data-style-name');
        if (dataStyle) (def.cell ??= {}).dataStyle = dataStyle;
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      case 'data-style-name':
      case 'properties': {
        // <style:properties style:data-style-name="NPercent"/>：
        // 数字格式的引用可能挂在一个独立的 style:properties 上，也可能直接写在
        // table-cell-properties 上。两种都要认，否则百分比单元格会显示成裸数字。
        const ds = attr(e, 'data-style-name');
        if (ds) (def.cell ??= {}).dataStyle = ds;
        if (!e.selfClosing) p.skipElement();
        continue;
      }
      case 'page-layout-properties':
        readPageProperties(e, (def.page ??= {}));
        if (!e.selfClosing) p.skipElement();
        continue;
      default:
        // 未知属性容器：整棵跳过（它的属性没有我们认识的语义）。
        // 注意这里**不能**在 switch 外统一收尾，原因见函数注释。
        if (!e.selfClosing) p.skipElement();
        continue;
    }
  }
}

function readMasterPage(p: XmlPullParser, e: XmlEvent, out: OdStyles): void {
  const name = attr(e, 'name') ?? '';
  const entry: { pageLayoutName?: string; displayName?: string } = {
    pageLayoutName: attr(e, 'page-layout-name'),
    displayName: attr(e, 'display-name'),
  };
  // presentation:notes 在 master-page 里（ODF 的备注母版），正文解析不需要，
  // 但必须消费掉子树否则层级会错乱。
  if (!e.selfClosing) p.skipElement();
  if (name) out.masterPages.set(name, entry);
}

/* ==================================================================== */
/* 列表样式                                                              */
/* ==================================================================== */

function readListStyle(p: XmlPullParser, e: XmlEvent, out: OdStyles, nameAttr: string | undefined): void {
  const name = nameAttr ?? attr(e, 'name') ?? '';
  const style: OdListStyle = { name, levels: new Map() };
  if (!e.selfClosing) {
    let c: XmlEvent | null;
    while ((c = p.next()) !== null) {
      if (c.type === 'end') break;
      if (c.type !== 'start') continue;
      if (c.local !== 'list-level-style-bullet' && c.local !== 'list-level-style-number' && c.local !== 'list-level-style-image') {
        if (!c.selfClosing) p.skipElement();
        continue;
      }
      const level = attrInt(c, 'level', style.levels.size + 1);
      const kind: OdListLevel['kind'] =
        c.local === 'list-level-style-bullet' ? 'bullet' : c.local === 'list-level-style-number' ? 'number' : 'none';
      const lvl: OdListLevel = {
        level,
        kind,
        bulletChar: attr(c, 'bullet-char'),
        numFormat: attr(c, 'num-format'),
        prefix: attr(c, 'num-prefix'),
        suffix: attr(c, 'num-suffix'),
        startValue: attr(c, 'start-value') !== undefined ? attrInt(c, 'start-value', 1) : undefined,
      };
      if (!c.selfClosing) readListLevelBody(p, lvl);
      style.levels.set(level, lvl);
    }
  }
  if (name) out.lists.set(name, style);
}

function readListLevelBody(p: XmlPullParser, lvl: OdListLevel): void {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    if (e.local === 'list-level-properties') {
      // 这两项是唯一对「列表看起来对不对」有影响的：
      // 没有缩进，所有级别的项目符号都会贴在左边界叠在一起。
      const sp = attr(e, 'space-before');
      if (sp !== undefined) {
        const pt = cssLengthToPt(sp, NaN);
        if (Number.isFinite(pt)) lvl.spaceBeforePt = pt;
      }
      const ml = attr(e, 'text-indent') ?? attr(e, 'min-label-width');
      if (ml !== undefined) {
        const pt = cssLengthToPt(ml, NaN);
        if (Number.isFinite(pt)) lvl.indentPt = pt;
      }
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    if (!e.selfClosing) p.skipElement();
  }
}

/* ==================================================================== */
/* 数字格式（number:*-style）                                            */
/* ==================================================================== */

/**
 * 数字格式串的最小可读化。
 *
 * 「尽可能转成可读形式」而不是完整实现 ODF 的 number:*-style 语法：
 * 模型里 CellStyle.numFmt 的用途是显示与对齐（是否百分比、几位小数），
 * 不是做真正的格式化引擎。完整实现会引入一个几百行的格式化器，
 * 与「轻量」的目标冲突。
 */
function readDataStyle(p: XmlPullParser, e: XmlEvent, out: OdStyles): void {
  const name = attr(e, 'name');
  const kind = e.local;
  if (!name) {
    if (!e.selfClosing) p.skipElement();
    return;
  }
  let decimals = 0;
  let grouping = false;
  let currency: string | undefined;
  let minInt = 1;
  const dateParts: string[] = [];
  const percTokens: string[] = [];

  if (!e.selfClosing) {
    let c: XmlEvent | null;
    while ((c = p.next()) !== null) {
      if (c.type === 'end') break;
      if (c.type !== 'start') continue;
      let consumedByCase = false;
      switch (c.local) {
        case 'decimal-places': {
          const n = attrInt(c, 'decimal-places', 0);
          if (n > 0) decimals = Math.min(n, 10);
          break;
        }
        case 'number': {
          // 坑：小数位数**不在** number:number 元素本身的 local 名下。
          // `<number:number number:decimal-places="2" number:min-integer-digits="1"/>`
          // 的本地名是 "number"，而 decimal-places / min-integer-digits 是它的**属性**。
          // 早期版本在这里只 case 'decimal-places'，于是所有 percentage/currency
          // 格式都被渲染成 "0%"（丢了小数位）。
          const dp = attr(c, 'decimal-places');
          if (dp !== undefined) {
            const n = Number.parseInt(dp, 10);
            if (Number.isFinite(n) && n > 0) decimals = Math.min(n, 10);
          }
          const mi = attr(c, 'min-integer-digits');
          if (mi !== undefined) {
            const n = Number.parseInt(mi, 10);
            if (Number.isFinite(n) && n > 0) minInt = Math.max(1, n);
          }
          break;
        }
        case 'grouping': {
          grouping = attrBool(c, 'grouping', false);
          break;
        }
        case 'min-integer-digits':
          minInt = Math.max(1, attrInt(c, 'min-integer-digits', 1));
          break;
        case 'currency-symbol': {
          if (currency === undefined) currency = collectText(p, c);
          consumedByCase = true;
          break;
        }
        case 'year':
          dateParts.push('yyyy');
          break;
        case 'month':
          dateParts.push(attr(c, 'textual') === 'true' ? 'mmm' : 'mm');
          break;
        case 'day':
          dateParts.push('dd');
          break;
        case 'hours':
          dateParts.push('hh');
          break;
        case 'minutes':
          dateParts.push('mm');
          break;
        case 'seconds':
          dateParts.push('ss');
          break;
        case 'am-pm':
          dateParts.push('AM/PM');
          break;
        case 'text': {
          // number:text 是字面量（如 "%"、空格、货币单位）
          const t = collectText(p, c);
          if (t) percTokens.push(t);
          consumedByCase = true;
          break;
        }
        default:
          break;
      }
      // 关键：**自己消费过结束标签的 case 绝不能再 skipElement()**。
      // collectText 已经推进到 </number:text> 之后；此时再 skipElement 会把
      // **下一个兄弟元素**（也就是紧随其后的 `style:style`！
      // 即百分比/货币格式后面的单元格样式）整棵吃掉。
      // 早期版本就因为这个多跳一步，导致 ods 里紧跟在 number:*-style 之后的
      // 所有 table-cell 样式全部丢失，单元格底色/字体全无。
      if (!c.selfClosing && !consumedByCase) p.skipElement();
    }
  }

  let fmt: string;
  switch (kind) {
    case 'percentage-style':
      fmt = `${'0'.repeat(minInt)}${decimals ? `.${'0'.repeat(decimals)}` : ''}%`;
      break;
    case 'currency-style':
      fmt = `${currency ?? ''}${'0'.repeat(minInt)}${decimals ? `.${'0'.repeat(decimals)}` : ''}`;
      break;
    case 'date-style':
    case 'time-style':
      fmt = dateParts.join('/') || 'date';
      break;
    case 'boolean-style':
      fmt = 'BOOLEAN';
      break;
    case 'text-style':
      fmt = '@';
      break;
    default:
      fmt = `${'0'.repeat(minInt)}${grouping ? ',' : ''}${decimals ? `.${'0'.repeat(decimals)}` : ''}`;
      if (percTokens.length) fmt += percTokens.join('');
      break;
  }
  out.dataStyles.set(name, fmt);
}

/** 读一个元素的纯文本内容（number:text / number:currency-symbol）。 */
function collectText(p: XmlPullParser, start: XmlEvent): string {
  let acc = '';
  if (start.selfClosing) return acc;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type === 'text' || e.type === 'cdata') acc += e.text;
  }
  return acc;
}

/* ==================================================================== */
/* 继承解析                                                              */
/* ==================================================================== */

/**
 * 沿 parent 链收集样式，返回顺序为 [根 … 自身]。
 * ODF 只有单亲链，但真实文件里出现过 parent 指向自身/互相引用的畸形数据，
 * 所以必须有环保护 —— 否则 resolve 会死循环把标签页挂住。
 */
function styleChain(out: OdStyles, family: string, name: string | undefined): OdStyleDef[] {
  const chain: OdStyleDef[] = [];
  const seen = new Set<string>();
  let cur = name;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const def = lookup(out, family, cur);
    if (!def) break;
    chain.unshift(def);
    cur = def.parent;
  }
  return chain;
}

/** 按 family 精确查找，找不到再退回裸名（兼容 family 缺失的畸形文件）。 */
export function lookup(out: OdStyles, family: string, name: string): OdStyleDef | undefined {
  return out.defs.get(styleKey(family, name)) ?? out.defs.get(name);
}

/**
 * 解析出最终的字符属性。
 * @param family 段落里的 run 用 'text'，段落自身用 'paragraph'
 */
export function resolveRun(
  out: OdStyles,
  family: 'text' | 'paragraph',
  styleName: string | undefined,
  direct?: OdRunProps,
  base?: OdRunProps,
): OdRunProps {
  // 显式传入的 base（例如所在段落的字符格式）优先级**低于**样式链，
  // 但高于全局默认：调用方按 [默认, 段落, 字符样式, 直接格式] 的顺序合并。
  let acc: OdRunProps = { ...(out.defaults.get('text')?.run ?? {}) };
  acc = mergeDefined(acc, base) ?? acc;
  for (const def of styleChain(out, family, styleName)) {
    acc = mergeDefined(acc, def.run) ?? acc;
  }
  return mergeDefined(acc, direct) ?? acc;
}

/** 解析出最终的段落属性（含段落的隐含字符格式，挂在 run 字段上）。 */
export function resolvePara(out: OdStyles, styleName: string | undefined, direct?: OdParaProps): OdParaProps {
  let acc: OdParaProps = { ...(out.defaults.get('paragraph')?.para ?? {}) };
  // 顺序至关重要：全局 text 默认 < 全局 paragraph 默认 < 样式链 < 直接格式。
  // 早期版本把全局 text 默认放在最后合并，于是 `style:default-style family="text"`
  // 里的字号会**覆盖**段落样式显式写的字号（本末倒置）。
  acc.run = mergeDefined({ ...(out.defaults.get('text')?.run ?? {}) }, out.defaults.get('paragraph')?.run);
  for (const def of styleChain(out, 'paragraph', styleName)) {
    acc = mergeDefined(acc, def.para) ?? acc;
    acc.run = mergeDefined(acc.run, def.run);
  }
  const merged = mergeDefined(acc, direct) ?? acc;
  if (direct?.run) merged.run = mergeDefined(acc.run, direct.run);
  return merged;
}

/** 解析出最终的单元格属性（沿 table-cell 链，含链上的字符格式）。 */
export function resolveCell(out: OdStyles, styleName: string | undefined, direct?: OdCellProps): OdCellProps {
  let acc: OdCellProps = { ...(out.defaults.get('table-cell')?.cell ?? {}) };
  for (const def of styleChain(out, 'table-cell', styleName)) {
    acc = mergeDefined(acc, def.cell) ?? acc;
    // 单元格样式里的 text-properties 描述的是「这一格文字的格式」，
    // 必须并进 CellStyle，否则设置过字体的单元格会渲染成默认字体。
    if (def.run) {
      if (def.run.bold !== undefined) acc.bold = def.run.bold;
      if (def.run.italic !== undefined) acc.italic = def.run.italic;
      if (def.run.underline !== undefined) acc.underline = def.run.underline;
      if (def.run.strike !== undefined) acc.strike = def.run.strike;
      if (def.run.color) acc.color = def.run.color;
      if (def.run.sizePt !== undefined) acc.sizePt = def.run.sizePt;
      if (def.run.font) acc.font = def.run.font;
    }
  }
  const merged = mergeDefined(acc, direct) ?? acc;
  if (merged.dataStyle) {
    const fmt = out.dataStyles.get(merged.dataStyle);
    if (fmt) merged.numFmt = fmt;
  }
  return merged;
}

/** 列宽（pt）。style:family="table-column" */
export function columnWidthPt(out: OdStyles, styleName: string | undefined): number | undefined {
  for (const def of styleChain(out, 'table-column', styleName)) {
    if (def.columnWidthPt !== undefined && Number.isFinite(def.columnWidthPt)) return def.columnWidthPt;
  }
  return undefined;
}

/** 行高（pt）。style:family="table-row" */
export function rowHeightPt(out: OdStyles, styleName: string | undefined): number | undefined {
  for (const def of styleChain(out, 'table-row', styleName)) {
    if (def.rowHeightPt !== undefined && Number.isFinite(def.rowHeightPt)) return def.rowHeightPt;
  }
  return undefined;
}

/** 页面尺寸/页边距。style:family="page-layout" */
export function resolvePageLayout(out: OdStyles, styleName: string | undefined): OdPageLayout {
  let acc: OdPageLayout = {};
  for (const def of styleChain(out, 'page-layout', styleName)) {
    acc = mergeDefined(acc, def.page) ?? acc;
  }
  return acc;
}

/* ==================================================================== */
/* 项目符号 / 编号渲染                                                   */
/* ==================================================================== */

/**
 * 按 ODF 的 `style:num-format` 渲染编号值。
 *
 * ODF 的 num-format 与 OOXML 的 numFmt 是两套**不同的词表**：
 * ODF 用 "1" / "01" / "a" / "A" / "i" / "I" / "一" / "壹" / "①" 这样的字形，
 * OOXML 用 "decimal" / "lowerLetter" / "upperRoman" …
 * 直接照搬 OOXML 的格式化函数会全部落到 default 分支输出阿拉伯数字，
 * 于是「一、二、三」的章节编号会变成「1、2、3」。
 */
export function formatListNumber(value: number, numFormat: string | undefined): string {
  const f = (numFormat ?? '1').trim();
  if (f === '' || f === '1') return String(value);
  if (/^0+1$/.test(f)) return String(value).padStart(f.length - 1, '0');
  if (f === 'a') return alpha(value, false);
  if (f === 'A') return alpha(value, true);
  if (f === 'i') return roman(value);
  if (f === 'I') return roman(value).toUpperCase();
  if (f === '一' || f === '壹' || f === '一二三') return chinese(value);
  if (f === '①') return circled(value);
  return String(value);
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

const CN_DIGITS = '零一二三四五六七八九';

function chinese(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v === 0) return CN_DIGITS[0];
  if (v < 10) return CN_DIGITS[v];
  if (v === 10) return '十';
  if (v < 20) return `十${CN_DIGITS[v % 10]}`;
  if (v < 100) {
    const tens = Math.floor(v / 10);
    const ones = v % 10;
    return `${CN_DIGITS[tens]}十${ones ? CN_DIGITS[ones] : ''}`;
  }
  return String(v);
}

function circled(n: number): string {
  const v = Math.floor(n);
  // Unicode 的 ①..⑳ 是连号区，21 之后没有对应字符，退回括号写法
  if (v >= 1 && v <= 20) return String.fromCharCode(0x2460 + v - 1);
  return `(${v})`;
}

/**
 * 渲染某个列表级别的标记文本。
 *
 * 注意「两级间接」：段落上的 `text:style-name` 指的是**列表样式**名，
 * 而列表样式里每一级的真正的符号/编号格式在 list-level-style-* 里。
 * 少解析任何一层，列表都会退化成普通段落 —— 这是 ODF 读取最常见的失败点。
 */
export function renderListMarker(level: OdListLevel | undefined, counter: number): { marker: string; ordered: boolean } {
  if (!level) return { marker: '•', ordered: false };
  if (level.kind === 'bullet') {
    // text:bullet-char 可能写成 "<space>" 之类的 XML 名称引用；
    // 解析器已做实体解码，这里只兜底空值。
    return { marker: level.bulletChar && level.bulletChar.length > 0 ? level.bulletChar : '•', ordered: false };
  }
  if (level.kind === 'none') return { marker: '', ordered: false };
  const number = formatListNumber(counter, level.numFormat);
  return { marker: `${level.prefix ?? ''}${number}${level.suffix ?? ''}`, ordered: true };
}
