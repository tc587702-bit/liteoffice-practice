/**
 * `p:txBody` 文本解析：段落、run、项目符号、域。
 *
 * 与 docx 的三个关键差异（pptx 读取最容易踩的坑）：
 *   1. 字号 `a:rPr sz="1800"` 是 **1/100 pt**（docx 的 `w:sz` 是半磅）。差 50 倍。
 *      若误用 `halfPtToPt`，18pt 的正文会变成 9pt —— 看着「能打开」但整篇都错，
 *      而且「标题比正文大」这种相对关系仍然成立，肉眼很难发现。
 *   2. 字体不是 `a:rFonts ascii/eastAsia`，而是 `a:latin` / `a:ea` 两个**独立元素**。
 *   3. 项目符号/编号直接写在 `a:pPr` 上（`a:buChar` / `a:buAutoNum`），
 *      没有 docx 那样的 numbering 部件需要跨部件解析。
 *
 * 因此 `readRunProps`/`readParaProps`（packages/ooxml/src/styles.ts）**不能**直接复用：
 * 它们的 switch 认的是 `w:b`/`w:sz`/`w:rFonts`/`w:jc` 这些 docx 本地名，
 * 而且同名元素 `sz` 在两边的单位、语义都不同。这里写一份 pptx 专用读取器，
 * 只复用 ooxml 层的属性访问（attr/onOff）与主题色（theme.ts / color.ts）。
 *
 * 参数约定：`body` / `para` / `rPr` 等以「可重放工厂」或「已拿到的 start 事件」
 * 形式传入（见 scan.ts 的 defer() 与 eachChild()）。遍历一律不自己调
 * `skipElement()` —— 由 walker 按返回值决定，见 scan.ts 顶部关于
 * 「跳过根元素会终止遍历」的说明。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import type { ParaStyle, Paragraph, Run, RunStyle } from '../../core/src/model.ts';
import { attr, onOff } from '../../ooxml/src/xmlUtil.ts';
import type { Theme } from '../../ooxml/src/theme.ts';
import { readColorElement, themeOrDefault } from './color.ts';
import { EMPTY_THEME_FONTS, resolveThemeFont } from './fonts.ts';
import type { ThemeFonts } from './fonts.ts';
import { emuToPt, hundredthPtToPt, num } from './units.ts';
import { eachChild, skipDeep } from './scan.ts';
import type { ParserFactory } from './scan.ts';

/** 一个形状上「直接格式 + slide/layout/master 继承」累积出来的默认样式。 */
export interface TextStyle {
  sizePt?: number;
  font?: string;
  fontEastAsia?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface TextContext {
  theme: Theme;
  /** 主题字体表：把 +mj-lt / +mn-ea 之类的主题引用换成真实字体名 */
  fonts?: ThemeFonts;
  /** 形状级的默认样式（继承链合并结果） */
  base: TextStyle;
  /** 组链累计缩放：组合形状按比例缩放时，组内文字也跟着缩放 */
  fontScale: number;
  /** 降级信息汇总入口（同一类只报一次） */
  warn: (msg: string) => void;
}

export function makeTextContext(theme: Theme, warn: (m: string) => void, base: TextStyle = {}, fontScale = 1, fonts?: ThemeFonts): TextContext {
  return { theme: themeOrDefault(theme), fonts, base, fontScale, warn };
}

/**
 * 把模型里的主题字体引用（`+mj-lt` / `+mn-ea`）换成真实字体名。
 * 在形状解析完成后统一做一次，避免每个 run 上都写一遍主题表。
 *
 * 只用「有 blocks / shapes 的结构」做参数类型，避免 text.ts 反向依赖 model.Shape
 * 而让形状模块与文本模块互相引用。
 */
export function resolveShapeFonts(
  shape: { blocks?: Array<{ kind: string; runs?: Array<{ style?: RunStyle }>; rows?: Array<{ cells: Array<{ blocks: unknown[] }> }> }>; shapes?: unknown[] },
  fonts?: ThemeFonts,
): void {
  const f = fonts ?? EMPTY_THEME_FONTS;
  const blocks = shape.blocks;
  if (blocks) {
    for (const b of blocks) {
      if (b.kind === 'para' && b.runs) {
        for (const r of b.runs) {
          if (!r.style) continue;
          if (r.style.font) r.style.font = resolveThemeFont(r.style.font, f);
          if (r.style.fontEastAsia) r.style.fontEastAsia = resolveThemeFont(r.style.fontEastAsia, f);
        }
      } else if (b.kind === 'table' && b.rows) {
        for (const row of b.rows) {
          for (const cell of row.cells) {
            resolveShapeFonts({ blocks: cell.blocks as typeof blocks }, fonts);
          }
        }
      }
    }
  }
  if (shape.shapes) {
    for (const s of shape.shapes) resolveShapeFonts(s as Parameters<typeof resolveShapeFonts>[0], fonts);
  }
}

/** 进入某个容器元素：返回停在它 start 事件上的解析器与该事件。 */
function begin(make: ParserFactory): { p: XmlPullParser; e: XmlEvent } {
  const p = make();
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') return { p, e };
  }
  // 空片段：给一个自闭合的假元素，让后续逻辑自然退化
  return { p, e: fakeStart() };
}

function fakeStart(): XmlEvent {
  return { type: 'start', name: '', local: '', prefix: '', attrs: null, selfClosing: true, text: '' };
}

/* ==================================================================== */
/* 正文                                                                  */
/* ==================================================================== */

/** 读 `a:txBody`，返回段落数组。消费整个 txBody 子树。 */
export function readTextBody(factory: ParserFactory, ctx: TextContext): Paragraph[] {
  const { p, e } = begin(factory);
  const out: Paragraph[] = [];
  // 自动编号计数器按层级计，作用域是整个 txBody
  const counters: number[] = [];
  eachChild(p, e, (child) => {
    if (child.local === 'p') {
      if (!child.selfClosing) {
        readParagraph(p, ctx, counters, out, child);
        return true; // readParagraph 已消费完整棵 a:p
      }
      return false;
    }
    return false; // bodyPr / lstStyle / 未知扩展：交给 walker 跳过
  });
  return out;
}

/**
 * 只读默认 run 属性（`a:lstStyle/a:lvl1pPr/a:defRPr` 或首个
 * `a:p/a:pPr/a:defRPr`）。用于从版式/母版继承占位符的默认字号与颜色。
 */
export function readBodyDefaults(factory: ParserFactory, ctx: TextContext): TextStyle {
  const { p, e } = begin(factory);
  let out: TextStyle = {};
  eachChild(p, e, (child) => {
    if (child.local === 'lstStyle' && !child.selfClosing) {
      eachChild(p, child, (lvl) => {
        if (lvl.local === 'lvl1pPr' && !lvl.selfClosing) {
          out = mergeTextStyle(out, readDefRPr(p, ctx, lvl));
          return true;
        }
        return false;
      });
      return true;
    }
    if (child.local === 'p' && !child.selfClosing) {
      // 没有 lstStyle 时用首个段落的 defRPr 兜底
      if (out.sizePt === undefined && out.color === undefined) {
        eachChild(p, child, (pc) => {
          if (pc.local === 'pPr' && !pc.selfClosing) {
            out = mergeTextStyle(out, readDefRPr(p, ctx, pc));
            return true;
          }
          return false;
        });
      }
      return true;
    }
    return false;
  });
  return out;
}

/** 在 `a:pPr` 或 `a:lvl1pPr` 里找 `a:defRPr`。消费整个子树。 */
function readDefRPr(p: XmlPullParser, ctx: TextContext, pPr: XmlEvent): TextStyle {
  let out: TextStyle = {};
  eachChild(p, pPr, (child) => {
    if (child.local !== 'defRPr') return false;
    // 必须用 readDefRunProps：a:defRPr 的 sz/b/i 是**属性**，
    // 用 readRunProps 只会读到颜色/字体，字号永远是空的。
    // 另外 `a:defRPr` 常常是**自闭合**（`<a:defRPr sz="2400"/>`），
    // 早期版本对自闭合元素直接 return false，于是字号/字体整块丢失。
    if (child.selfClosing) {
      out = mergeTextStyle(out, styleFromRunProps(applyRunAttrsOnly(child, ctx)));
      return false;
    }
    out = mergeTextStyle(out, styleFromRunProps(readDefRunProps(p, ctx, child)));
    return true;
  });
  return out;
}

/* ------------------------------ 段落 ------------------------------ */

function readParagraph(p: XmlPullParser, ctx: TextContext, counters: number[], out: Paragraph[], para: XmlEvent): void {
  const model: Paragraph = { kind: 'para', runs: [] };
  let base = ctx.base;
  eachChild(p, para, (child) => {
    switch (child.local) {
      case 'pPr': {
        if (child.selfClosing) return false;
        const style = readParaStyle(p, ctx, child);
        // 段落自带的 defRPr 是该段所有 run 的默认值（优先级高于形状级继承）
        if (style.__defRun) {
          base = mergeTextStyle(ctx.base, style.__defRun);
          delete style.__defRun;
        }
        if (style.__autoNum !== undefined) {
          applyAutoNumber(style, style.__autoNum, counters);
          delete style.__autoNum;
        } else if (style.listOrdered) {
          const lvl = style.listLevel ?? 0;
          counters[lvl] = (counters[lvl] ?? 0) + 1;
        } else {
          // 有层级但没有符号：视为「列表结构、符号来自版式」
          if (style.listLevel !== undefined && !style.listMarker && style.listOrdered !== false) {
            style.listMarker = defaultBulletForLevel(style.listLevel);
          }
          // 编号列表被打断时计数器重新开始（PowerPoint 的列表语义）
          for (let i = 0; i < counters.length; i++) counters[i] = 0;
        }
        model.style = style;
        return true;
      }
      case 'r': {
        if (child.selfClosing) return false;
        const run = readRun(p, ctx, base, child);
        if (run) model.runs.push(run);
        return true;
      }
      case 'br': {
        // 段内换行：UDM 用「run 前强制换行」表达，避免引入空 run
        model.runs.push({ text: '', breakBefore: true });
        return false;
      }
      case 'fld': {
        if (child.selfClosing) return false;
        const run = readField(p, ctx, base, child);
        if (run) model.runs.push(run);
        return true;
      }
      default:
        return false;
    }
  });
  out.push(model);
}

function readRun(p: XmlPullParser, ctx: TextContext, base: TextStyle, r: XmlEvent): Run | undefined {
  const run: Run = { text: '' };
  eachChild(p, r, (child) => {
    if (child.local === 't') {
      run.text += textOfElement(p, child);
      return true;
    }
    if (child.local === 'rPr') {
      // `<a:rPr sz="1800"/>` 自闭合情况极常见（只有字号/加粗时 PowerPoint 就这么写），
      // 对自闭合元素也要读属性，否则「只设了字号的 run」会被完全忽略
      const style = (child.selfClosing
        ? applyRunAttrsOnly(child, ctx)
        : readRunProps(p, ctx, child)) as RunStyleInternal;
      const hlink = style.__hlinkId;
      delete style.__hlinkId;
      const merged = mergeRunStyle(base, style, ctx.fontScale);
      // UDM 的链接放在 RunStyle.link 上（模型里没有独立的超链接对象）
      if (hlink) merged.link = hlink;
      if (Object.keys(merged).length) run.style = merged;
      if (child.selfClosing) return false;
      return true;
    }
    return false;
  });
  return run;
}

/**
 * `a:fld`（页码、日期等域）。UDM 只有 `Run.field` 布尔位，
 * 因此取域**当前显示的文本**并标记 field=true。
 */
function readField(p: XmlPullParser, ctx: TextContext, base: TextStyle, fld: XmlEvent): Run | undefined {
  const run: Run = { text: '', field: true };
  eachChild(p, fld, (child) => {
    if (child.local === 't') {
      run.text += textOfElement(p, child);
      return true;
    }
    if (child.local === 'rPr' && !child.selfClosing) {
      const style = readRunProps(p, ctx, child) as RunStyleInternal;
      delete style.__hlinkId;
      run.style = mergeRunStyle(base, style, ctx.fontScale);
      return true;
    }
    return false;
  });
  return run;
}

/** `a:t` 的文本内容。消费该元素。 */
function textOfElement(p: XmlPullParser, e: XmlEvent): string {
  if (e.selfClosing) return '';
  let out = '';
  let cur: XmlEvent | null;
  while ((cur = p.next()) !== null) {
    if (cur.type === 'end') break;
    if (cur.type === 'text' || cur.type === 'cdata') out += cur.text;
    else if (cur.type === 'start' && !cur.selfClosing) skipDeep(p, cur);
  }
  return out;
}

/* ------------------------------ run 属性 ------------------------------ */

/**
 * `a:rPr`（字符属性）。消费整个子树。
 *
 * **pptx 里最容易踩的一处不一致**：同一批属性在两种元素上的写法不同 ——
 *
 *   `<a:rPr sz="1800" b="1">…</a:rPr>`            ← sz/b/i/u 是**属性**
 *   `<a:rPr><a:sz val="1800"/><a:b/></a:rPr>`     ← 也可能是**子元素**
 *   `<a:defRPr sz="4400" b="1">…</a:defRPr>`      ← 默认字符属性用属性形式
 *
 * PowerPoint 自己写的是属性形式，某些第三方生成器（以及部分 WPS 版本）会写成
 * 子元素形式，两种在真实文件里都存在。因此这里**两边都读**：
 * 先取元素属性，再由 readRunPropsInto 里的子元素覆盖。
 * 早期版本只读子元素，结果是「所有文字都变成继承来的字号」——
 * `<a:rPr sz="1800">` 被完全忽略，18pt 的正文显示成 44pt。
 */
export function readRunProps(p: XmlPullParser, ctx: TextContext, rPr: XmlEvent): RunStyle {
  const style: RunStyle = {};
  applyRunAttrs(rPr, style, ctx);
  readRunPropsInto(p, ctx, rPr, style);
  return style;
}

/**
 * 读 `a:defRPr`（默认字符属性，出现在 `a:pPr` / `a:lvl1pPr` / `a:endParaRPr` 下）。
 * 与 `a:rPr` 用同一套解析（属性 + 子元素都读）。
 */
export function readDefRunProps(p: XmlPullParser, ctx: TextContext, defRPr: XmlEvent): RunStyle {
  const style: RunStyle = {};
  applyRunAttrs(defRPr, style, ctx);
  readRunPropsInto(p, ctx, defRPr, style);
  return style;
}

/** 从元素**属性**上取 run 属性（sz / b / i / u / strike）。 */
function applyRunAttrs(e: XmlEvent, style: RunStyle, ctx: TextContext): void {
  const sz = attr(e, 'sz');
  if (sz !== undefined) {
    const v = num(sz, NaN);
    // 1/100 pt！不是半磅。
    if (Number.isFinite(v)) style.size = hundredthPtToPt(v) * ctx.fontScale;
  }
  const b = attr(e, 'b');
  if (b !== undefined) style.bold = b !== '0' && b !== 'false';
  const i = attr(e, 'i');
  if (i !== undefined) style.italic = i !== '0' && i !== 'false';
  const u = attr(e, 'u');
  if (u !== undefined) style.underline = u !== 'none';
  const strike = attr(e, 'strike');
  if (strike !== undefined) style.strike = strike !== 'noStrike';
}

/** 只读属性部分（自闭合的 `a:defRPr` / `a:rPr` 用；不消费任何事件）。 */
function applyRunAttrsOnly(e: XmlEvent, ctx: TextContext): RunStyle {
  const style: RunStyle = {};
  applyRunAttrs(e, style, ctx);
  return style;
}

/** `a:rPr` / `a:defRPr` 共用的子元素部分（子元素形式优先于属性形式）。 */
function readRunPropsInto(p: XmlPullParser, ctx: TextContext, rPr: XmlEvent, style: RunStyle): void {
  eachChild(p, rPr, (child) => {
    switch (child.local) {
      case 'b':
        style.bold = onOff(child);
        return false;
      case 'i':
        style.italic = onOff(child);
        return false;
      case 'u': {
        const v = attr(child, 'val');
        style.underline = v === undefined ? true : v !== 'none';
        return false;
      }
      case 'strike': {
        const v = attr(child, 'val');
        style.strike = v === undefined ? true : v !== 'noStrike';
        return false;
      }
      case 'sz': {
        const v = num(attr(child, 'val'), NaN);
        // 1/100 pt！不是半磅。组内缩放由 ctx.fontScale 承担。
        if (Number.isFinite(v)) style.size = hundredthPtToPt(v) * ctx.fontScale;
        return false;
      }
      case 'latin': {
        // typeface 可能是主题引用（+mj-lt / +mn-ea），这里就换掉：
        // 留着 `+mj-lt` 会让渲染器找不到字体而退回默认，中文全变宋体。
        const tf = resolveThemeFont(attr(child, 'typeface'), ctx.fonts ?? EMPTY_THEME_FONTS);
        if (tf) style.font = tf;
        return false;
      }
      case 'ea': {
        const tf = resolveThemeFont(attr(child, 'typeface'), ctx.fonts ?? EMPTY_THEME_FONTS);
        if (tf) style.fontEastAsia = tf;
        return false;
      }
      case 'cs': {
        // 复杂文种字体：只在没有 latin/ea 时兜底，否则会把西文渲染成阿拉伯字体
        const tf = resolveThemeFont(attr(child, 'typeface'), ctx.fonts ?? EMPTY_THEME_FONTS);
        if (tf && !style.font) style.font = tf;
        return false;
      }
      case 'solidFill': {
        if (child.selfClosing) return false;
        const c = readColorChild(p, ctx, child);
        if (c) {
          style.color = c.color;
          if (c.unsupported) ctx.warn('文字颜色带有不支持的变换（hueMod/comp/inv 等），已按基色近似');
        }
        return true;
      }
      case 'highlight': {
        if (child.selfClosing) return false;
        const c = readColorChild(p, ctx, child);
        if (c) style.highlight = c.color;
        return true;
      }
      case 'hlinkClick': {
        // 链接目标在 slide 的 .rels 里（r:id）。UDM 的 link 要的是 URL，
        // 所以先记 r:id，由 shapes.readRun 回填，reader 再解析成真实目标。
        const rid = attr(child, 'id');
        if (rid) (style as RunStyleInternal).__hlinkId = rid;
        return false;
      }
      default:
        return false;
    }
  });
}

/** 读一个颜色元素（`a:solidFill` 的直接子元素就是颜色元素）。消费之。 */
function readColorChild(p: XmlPullParser, ctx: TextContext, container: XmlEvent): ReturnType<typeof readColorElement> {
  let out: ReturnType<typeof readColorElement>;
  eachChild(p, container, (colorEl) => {
    if (!out) {
      // 必须传 colorEl：它已经拿到了 start 事件，不能再用「自己 next()」的变体
      out = readColorElement(p, colorEl, ctx.theme);
      return true;
    }
    return false;
  });
  return out;
}

/** 把 RunStyle 收窄成继承用的 TextStyle。 */
export function styleFromRunProps(style: RunStyle): TextStyle {
  const out: TextStyle = {};
  if (style.size !== undefined) out.sizePt = style.size;
  if (style.font) out.font = style.font;
  if (style.fontEastAsia) out.fontEastAsia = style.fontEastAsia;
  if (style.color) out.color = style.color;
  if (style.bold !== undefined) out.bold = style.bold;
  if (style.italic !== undefined) out.italic = style.italic;
  return out;
}

/** 别名：名字更直观的同一功能（reader 里读 `defRPr` 时用）。 */
export const runStyleToTextStyle = styleFromRunProps;

/** 把形状级默认样式（继承链）与 run 直接样式合并。直接样式优先。 */
export function mergeRunStyle(base: TextStyle, direct: RunStyle, fontScale: number): RunStyle {
  const out: RunStyle = { ...direct };
  if (out.bold === undefined && base.bold !== undefined) out.bold = base.bold;
  if (out.italic === undefined && base.italic !== undefined) out.italic = base.italic;
  if (out.color === undefined && base.color !== undefined) out.color = base.color;
  if (out.size === undefined && base.sizePt !== undefined) out.size = base.sizePt * fontScale;
  if (!out.font && base.font) out.font = base.font;
  if (!out.fontEastAsia && base.fontEastAsia) out.fontEastAsia = base.fontEastAsia;
  return out;
}

export function mergeTextStyle(base: TextStyle, over: TextStyle | undefined): TextStyle {
  if (!over) return base;
  const out: TextStyle = { ...base };
  if (over.sizePt !== undefined) out.sizePt = over.sizePt;
  if (over.font) out.font = over.font;
  if (over.fontEastAsia) out.fontEastAsia = over.fontEastAsia;
  if (over.color) out.color = over.color;
  if (over.bold !== undefined) out.bold = over.bold;
  if (over.italic !== undefined) out.italic = over.italic;
  return out;
}

/* ------------------------------ 段落属性 ------------------------------ */

/** 供调用方读取的段落属性内部扩展字段（下划线前缀＝不是 UDM 契约的一部分）。 */
export interface ParaStyleExt extends ParaStyle {
  /** `a:buAutoNum type` 的原始值，由 readParagraph 展开成 listMarker */
  __autoNum?: string;
  /** 段落默认行内属性（来自 `a:pPr/a:defRPr`） */
  __defRun?: TextStyle;
}

/**
 * `a:pPr`。注意 `a:marL`/`a:indent` 的单位是 **EMU**（不是 docx 的 twip！），
 * 必须走 emuToPt：用 twipToPt 会让缩进差 635 倍。
 *
 * **与 run 属性同一类坑**：`algn` / `lvl` / `marL` / `marR` / `indent` / `rtl`
 * 在 PowerPoint 写出的文件里是 `a:pPr` 的**属性**
 * （`<a:pPr marL="228600" indent="-228600" algn="l" lvl="0">`），
 * 而 `a:buChar` / `a:buAutoNum` / `a:defRPr` / `a:spcBef` 是**子元素**。
 * 只读子元素会让缩进、对齐、列表层级全部丢失 —— 而段落文字仍然在、仍然有项目符号，
 * 所以肉眼看上去「基本正常」，只有缩进和层级不对。两种形式这里都读。
 */
export function readParaStyle(p: XmlPullParser, ctx: TextContext, pPr: XmlEvent): ParaStyleExt {
  const out: ParaStyleExt = {};
  applyParaAttrs(pPr, out);
  eachChild(p, pPr, (child) => {
    switch (child.local) {
      case 'algn': {
        // 子元素形式（少数生成器）：`<a:algn val="ctr"/>`
        const m = ALIGN[attr(child, 'val') ?? ''];
        if (m) out.align = m;
        return false;
      }
      case 'marL': {
        const v = num(attr(child, 'val'), NaN);
        if (Number.isFinite(v)) out.indentStart = emuToPt(v);
        return false;
      }
      case 'marR': {
        const v = num(attr(child, 'val'), NaN);
        if (Number.isFinite(v)) out.indentEnd = emuToPt(v);
        return false;
      }
      case 'indent': {
        const v = num(attr(child, 'val'), NaN);
        // 负数即悬挂缩进，UDM 用 indentFirst 的负值表达，语义正好一致
        if (Number.isFinite(v)) out.indentFirst = emuToPt(v);
        return false;
      }
      case 'lvl': {
        const v = num(attr(child, 'val'), NaN);
        if (Number.isFinite(v) && v >= 0) out.listLevel = Math.min(8, Math.floor(v));
        return false;
      }
      case 'buChar': {
        const ch = attr(child, 'char');
        if (ch) {
          out.listMarker = ch;
          out.listOrdered = false;
        }
        return false;
      }
      case 'buAutoNum':
        out.__autoNum = attr(child, 'type');
        out.listOrdered = true;
        return false;
      case 'buNone':
        // 显式取消项目符号：清掉符号与「有序」判断，但**保留层级**——
        // 层级管的是缩进，取消符号不应该顺带把缩进也丢了
        // （早期版本连 listLevel 一起清空，于是「无符号但仍有层级缩进」的段落缩进归零）
        out.listMarker = undefined;
        out.listOrdered = false;
        return false;
      case 'spcBef':
      case 'spcAft': {
        const pts = child.selfClosing ? undefined : readSpcPoints(p, child);
        if (pts !== undefined) {
          if (child.local === 'spcBef') out.spaceBefore = pts;
          else out.spaceAfter = pts;
        }
        return true;
      }
      case 'lnSpc': {
        const v = child.selfClosing ? undefined : readSpcPercent(p, child);
        if (v !== undefined) out.lineHeight = v;
        return true;
      }
      case 'defRPr': {
        if (child.selfClosing) return false;
        out.__defRun = styleFromRunProps(readRunProps(p, ctx, child));
        return true;
      }
      default:
        return false;
    }
  });
  return out;
}

/** 从 `a:pPr` 的**属性**上取段落属性（PowerPoint 写出的就是这种形式）。 */
function applyParaAttrs(pPr: XmlEvent, out: ParaStyleExt): void {
  const algn = attr(pPr, 'algn');
  if (algn) {
    const m = ALIGN[algn];
    if (m) out.align = m;
  }
  const lvl = attr(pPr, 'lvl');
  if (lvl !== undefined) {
    const v = num(lvl, NaN);
    if (Number.isFinite(v) && v >= 0) out.listLevel = Math.min(8, Math.floor(v));
  }
  const marL = attr(pPr, 'marL');
  if (marL !== undefined) {
    const v = num(marL, NaN);
    if (Number.isFinite(v)) out.indentStart = emuToPt(v);
  }
  const marR = attr(pPr, 'marR');
  if (marR !== undefined) {
    const v = num(marR, NaN);
    if (Number.isFinite(v)) out.indentEnd = emuToPt(v);
  }
  const indent = attr(pPr, 'indent');
  if (indent !== undefined) {
    const v = num(indent, NaN);
    if (Number.isFinite(v)) out.indentFirst = emuToPt(v);
  }
}

/** `<a:spcBef><a:spcPts val="1200"/></a:spcBef>`：1/100 pt -> pt。 */
function readSpcPoints(p: XmlPullParser, e: XmlEvent): number | undefined {
  let out: number | undefined;
  eachChild(p, e, (child) => {
    if (child.local === 'spcPts') {
      const v = num(attr(child, 'val'), NaN);
      if (Number.isFinite(v)) out = hundredthPtToPt(v);
      return false;
    }
    if (child.local === 'spcPct') {
      const v = num(attr(child, 'val'), NaN);
      // 百分比间距转 pt 需要字号上下文，这里按 12pt 近似
      if (Number.isFinite(v)) out = (v / 100000) * 12;
      return false;
    }
    return false;
  });
  return out;
}

/** `<a:lnSpc><a:spcPct val="90000"/></a:lnSpc>` -> 0.9 倍行距。 */
function readSpcPercent(p: XmlPullParser, e: XmlEvent): number | undefined {
  let out: number | undefined;
  eachChild(p, e, (child) => {
    if (child.local === 'spcPct') {
      const v = num(attr(child, 'val'), NaN);
      if (Number.isFinite(v)) out = v / 100000;
      return false;
    }
    if (child.local === 'spcPts') {
      const v = num(attr(child, 'val'), NaN);
      if (Number.isFinite(v)) out = hundredthPtToPt(v);
      return false;
    }
    return false;
  });
  return out;
}

const ALIGN: Record<string, ParaStyle['align']> = {
  l: 'left',
  ctr: 'center',
  r: 'right',
  just: 'justify',
  justLow: 'justify',
  dist: 'justify',
  thaiDist: 'justify',
};

/* ------------------------- 自动编号 -> 可见标记 ------------------------- */

/**
 * `a:buAutoNum type="arabicPeriod"` -> 显示文本。
 *
 * 与 docx 不同，pptx 的编号状态（第几项）**不在文档里**，由渲染器按顺序算。
 * UDM 的 `ParaStyle.listMarker` 只是一个字符串，所以这里在读取时就按同层级
 * 计数器展开，并重置更深层计数 —— 于是缩略图/大纲视图能直接显示 "1." "2."，
 * 不必再实现一个编号状态机。
 */
export function applyAutoNumber(style: ParaStyle, type: string | undefined, counters: number[]): void {
  const lvl = style.listLevel ?? 0;
  counters[lvl] = (counters[lvl] ?? 0) + 1;
  for (let i = lvl + 1; i < counters.length; i++) counters[i] = 0;
  style.listOrdered = true;
  style.listMarker = formatAutoNum(type, counters[lvl]);
}

function formatAutoNum(type: string | undefined, n: number): string {
  switch (type) {
    case 'arabicPeriod':
      return `${n}.`;
    case 'arabicParenR':
      return `${n})`;
    case 'arabicParenBoth':
      return `(${n})`;
    case 'arabicPlain':
      return String(n);
    case 'romanUcPeriod':
      return `${roman(n).toUpperCase()}.`;
    case 'romanLcPeriod':
      return `${roman(n)}.`;
    case 'alphaUcPeriod':
      return `${alpha(n, true)}.`;
    case 'alphaLcPeriod':
      return `${alpha(n, false)}.`;
    case 'alphaLcParenR':
      return `${alpha(n, false)})`;
    case 'alphaUcParenR':
      return `${alpha(n, true)})`;
    case 'circleNumDbPlain':
    case 'circleNumWdBlackPlain':
    case 'circleNumWdWhitePlain':
      return circled(n);
    case 'ea1ChsPeriod':
      return `${chineseNum(n)}、`;
    case 'ea1ChsPlain':
      return chineseNum(n);
    default:
      // 未收录的编号格式：退回阿拉伯数字，而不是不显示编号
      return `${n}.`;
  }
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

function circled(n: number): string {
  return CIRCLED[n - 1] ?? `(${n})`;
}

const CN_DIGITS = '零一二三四五六七八九';

function chineseNum(n: number): string {
  if (n < 10) return CN_DIGITS[n];
  if (n < 20) return `十${n === 10 ? '' : CN_DIGITS[n % 10]}`;
  if (n < 100) {
    const t = Math.floor(n / 10);
    return `${CN_DIGITS[t]}十${n % 10 ? CN_DIGITS[n % 10] : ''}`;
  }
  return String(n);
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

/** 未指定 `a:buChar` 时按层级给出的默认圆点（PowerPoint 的默认项目符号）。 */
export function defaultBulletForLevel(lvl: number): string {
  const marks = ['•', '–', '▪'];
  return marks[lvl % marks.length];
}

/**
 * `a:rPr` 上除 UDM 字段外还需要**临时携带**的内部位。
 * 用「下划线前缀」而不是新字段，是为了不污染 UDM 的 RunStyle 契约。
 */
interface RunStyleInternal extends RunStyle {
  /** `a:hlinkClick r:id` 的原始关系 id（由 reader 解析成 URL） */
  __hlinkId?: string;
}
