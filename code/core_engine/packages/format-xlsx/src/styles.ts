/**
 * styles.xml 解析。
 *
 * 输出是一个**按 cellXfs 下标排列的 `CellStyle[]`**：`Cell.s` 存下标而不是对象，
 * 这是 xlsx 省内存的关键 —— 100 万格的表通常只有几十种格式，
 * 每格存一个对象引用（甚至拷贝）会让模型体积翻几倍。
 *
 * 部件结构（顺序是规范固定的，实现依赖这一点来判定「当前处于哪一段」）：
 *   numFmts -> fonts -> fills -> borders -> cellStyleXfs -> cellXfs -> cellStyles -> dxfs
 * 其中：
 *   - `cellXfs` 才是**单元格格式表**，`cellStyleXfs` 是命名样式的母版。
 *     把两者的 `<xf>` 混在一起收集会让所有样式索引整体错位（看起来「颜色都差一格」），
 *     所以这里严格按所在容器分段收集。
 *   - `<xf>` 里的 numFmtId 指向 numFmts 或内置表；fontId/fillId/borderId 分别指向
 *     上面几段数组的下标。
 *   - `<border><left style="thin"><color/></left>`：style 名决定线宽与线型；
 *     没有 style（或 style="none"）表示这一边没有边框。
 *
 * 不支持（已降级，写进 warnings）：渐变填充按第一个 stop 的颜色近似、
 * tint（明暗变换）忽略、`applyNumberFormat="0"` 仍按 numFmtId 取格式。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { attr, attrBool, attrInt, parseOnOff } from '../../ooxml/src/xmlUtil.ts';
import type { BorderLine, BorderStyle, CellStyle } from '../../core/src/model.ts';
import { colorFromAttrs } from './color.ts';
import { isDateFormat, resolveNumFmt } from './numFmt.ts';

/** 边框线型 -> 线宽（pt）与模型里的简化线型。 */
const LINE_WIDTH: Record<string, number> = {
  hair: 0.25,
  thin: 0.75,
  medium: 1.5,
  thick: 2.25,
  dashed: 0.75,
  dotted: 0.75,
  double: 1.5,
  mediumDashed: 1.5,
  dashDot: 0.75,
  mediumDashDot: 1.5,
  dashDotDot: 0.75,
  mediumDashDotDot: 1.5,
  slantDashDot: 1.5,
};

const LINE_STYLE: Record<string, BorderLine['style']> = {
  hair: 'solid',
  thin: 'solid',
  medium: 'solid',
  thick: 'solid',
  double: 'double',
  dashed: 'dashed',
  mediumDashed: 'dashed',
  dashDot: 'dashed',
  mediumDashDot: 'dashed',
  slantDashDot: 'dashed',
  dotted: 'dotted',
  dashDotDot: 'dotted',
  mediumDashDotDot: 'dotted',
};

interface FontRec {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  color?: string;
  name?: string;
  vertAlign?: string;
}

interface XfRec {
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  align?: CellStyle['align'];
  vAlign?: CellStyle['vAlign'];
  wrap?: boolean;
}

export interface StyleTable {
  /** 下标 = Cell.s */
  styles: CellStyle[];
  /** 每个 xf 的数字格式串（已解析内置表与自定义表） */
  numFmtCodes: string[];
  /** 每个 xf 是否为日期/时间格式 —— 决定单元格要不要把序列号转成日期 */
  isDate: boolean[];
}

export const EMPTY_STYLE_TABLE: StyleTable = { styles: [], numFmtCodes: [], isDate: [] };

/**
 * 遍历 `parent` 的直接子元素，并消费它们的子树。
 * `onChild` 返回 true 表示它自己已经把子树消费完了（此时不再 skip）。
 *
 * **自闭合的 parent 必须直接返回**：`<patternFill/>`、`<left/>`、`<xf/>` 都没有子元素，
 * 若仍进入遍历循环，它会把父元素的结束标签或下一个兄弟当成自己的子元素消费掉。
 * 早期版本因此把 `<fill>` 的第二个兄弟整棵吞掉，结果是**填充和边框全部丢失** ——
 * 而且只在「某一段的最后一个元素是空元素」时出现，看上去像随机丢样式。
 * 把守卫放进 eachChild（而不是靠每个调用点记得写）才是安全的做法。
 *
 * 为什么不用 ooxml 的 readPropChildren：那个函数在回调后**无条件** skipElement()，
 * 回调若自己消费了子树，多出来的 skipElement() 会吞掉下一个兄弟 —— 这正是
 * pull.ts 里修过的那个坑。styles.xml 的 fill/border 需要读孙节点，所以必须自己控制。
 */
function eachChild(p: XmlPullParser, parent: XmlEvent, onChild: (e: XmlEvent) => boolean): void {
  if (parent.selfClosing) return;
  for (;;) {
    const e = p.next();
    if (e === null) return;
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    const consumed = onChild(e);
    if (!consumed && !e.selfClosing) p.skipElement();
  }
}

function readFont(p: XmlPullParser, start: XmlEvent): FontRec {
  const f: FontRec = {};
  if (start.selfClosing) return f;
  eachChild(p, start, (e) => {
    switch (e.local) {
      case 'b':
        f.bold = attrBool(e, 'val', true);
        break;
      case 'i':
        f.italic = attrBool(e, 'val', true);
        break;
      case 'u': {
        const v = attr(e, 'val');
        f.underline = v === undefined ? true : parseOnOff(v) && v.toLowerCase() !== 'none';
        break;
      }
      case 'strike':
        f.strike = attrBool(e, 'val', true);
        break;
      case 'sz': {
        const v = Number.parseFloat(attr(e, 'val') ?? '');
        // 注意：xlsx 的 sz 单位**就是 pt**（与 Word 的半磅不同），不要再除以 2
        if (Number.isFinite(v) && v > 0) f.size = v;
        break;
      }
      case 'color': {
        const c = colorFromAttrs(e);
        if (c) f.color = c;
        break;
      }
      case 'name':
      case 'rFont': {
        const v = attr(e, 'val');
        if (v) f.name = v;
        break;
      }
      case 'vertAlign': {
        const v = attr(e, 'val');
        if (v) f.vertAlign = v;
        break;
      }
      default:
        break;
    }
    return false;
  });
  return f;
}

function readFill(p: XmlPullParser, start: XmlEvent, warn: (m: string) => void): string | undefined {
  let fg: string | undefined;
  let bg: string | undefined;
  let patternType = '';
  if (start.selfClosing) return undefined;

  eachChild(p, start, (e) => {
    if (e.local === 'patternFill') {
      patternType = attr(e, 'patternType') ?? '';
      eachChild(p, e, (c) => {
        if (c.local === 'fgColor') fg = colorFromAttrs(c) ?? fg;
        else if (c.local === 'bgColor') bg = colorFromAttrs(c) ?? bg;
        return false;
      });
      return true;
    }
    if (e.local === 'gradientFill') {
      warn('渐变填充暂按第一个色标近似处理');
      eachChild(p, e, (s) => {
        if (s.local === 'stop' && fg === undefined) {
          eachChild(p, s, (c) => {
            if (c.local === 'color' && fg === undefined) fg = colorFromAttrs(c);
            return false;
          });
          return true;
        }
        return false;
      });
      return true;
    }
    return false;
  });

  // patternType 为空或 none 表示无填充；gray125 之类没有 fgColor，自然也没有底色
  if (patternType === '' || patternType === 'none') return undefined;
  if (patternType === 'solid') {
    // 已知怪癖：部分写入器把 solid 的颜色写在 bgColor 上，兜一下
    return fg ?? bg;
  }
  return fg;
}

function readBorder(p: XmlPullParser, start: XmlEvent): BorderStyle | undefined {
  const border: BorderStyle = {};
  let any = false;
  if (start.selfClosing) return undefined;

  const readSide = (e: XmlEvent, key: 'left' | 'right' | 'top' | 'bottom'): void => {
    const styleName = attr(e, 'style');
    let color: string | undefined;
    eachChild(p, e, (c) => {
      if (c.local === 'color') color = colorFromAttrs(c) ?? color;
      return false;
    });
    if (!styleName || styleName === 'none') return;
    const line: BorderLine = {
      width: LINE_WIDTH[styleName] ?? 0.75,
      style: LINE_STYLE[styleName] ?? 'solid',
    };
    if (color) line.color = color;
    border[key] = line;
    any = true;
  };

  eachChild(p, start, (e) => {
    switch (e.local) {
      case 'left':
        readSide(e, 'left');
        return true;
      case 'right':
        readSide(e, 'right');
        return true;
      case 'top':
        readSide(e, 'top');
        return true;
      case 'bottom':
        readSide(e, 'bottom');
        return true;
      default:
        // diagonal / outline / start / end 等暂不支持
        return false;
    }
  });

  return any ? border : undefined;
}

const H_ALIGN: Record<string, CellStyle['align']> = {
  center: 'center',
  centerContinuous: 'center',
  right: 'right',
  left: 'left',
  justify: 'left',
  distributed: 'left',
  fill: 'left',
};

const V_ALIGN: Record<string, CellStyle['vAlign']> = {
  top: 'top',
  center: 'middle',
  bottom: 'bottom',
  justify: 'middle',
  distributed: 'middle',
};

function readXf(p: XmlPullParser, start: XmlEvent): XfRec {
  const rec: XfRec = {
    numFmtId: attrInt(start, 'numFmtId', 0),
    fontId: attrInt(start, 'fontId', 0),
    fillId: attrInt(start, 'fillId', 0),
    borderId: attrInt(start, 'borderId', 0),
  };
  if (start.selfClosing) return rec;
  eachChild(p, start, (e) => {
    if (e.local !== 'alignment') return false;
    const h = attr(e, 'horizontal');
    if (h && H_ALIGN[h]) rec.align = H_ALIGN[h];
    const v = attr(e, 'vertical');
    if (v && V_ALIGN[v]) rec.vAlign = V_ALIGN[v];
    if (attrBool(e, 'wrapText', false)) rec.wrap = true;
    return false;
  });
  return rec;
}

/**
 * 解析 styles.xml。
 * @param warn 降级说明的出口（调用方负责去重与截断）
 */
export function parseStyles(xml: string, warn: (msg: string) => void): StyleTable {
  const custom = new Map<number, string>();
  const fonts: FontRec[] = [];
  const fills: (string | undefined)[] = [];
  const borders: (BorderStyle | undefined)[] = [];
  const xfs: XfRec[] = [];

  let section = '';
  const p = new XmlPullParser(xml);
  for (;;) {
    const e = p.next();
    if (e === null) break;
    if (e.type === 'end') {
      if (e.local === section) section = '';
      continue;
    }
    if (e.type !== 'start') continue;

    switch (e.local) {
      // styleSheet 是根元素：必须下探，不能跳过（早期版本漏了这一条，
      // 于是整个样式表被当成无关元素跳过，所有单元格都变成无格式）
      case 'styleSheet':
      case 'numFmts':
      case 'fonts':
      case 'fills':
      case 'borders':
      case 'cellXfs':
        if (e.local !== 'styleSheet') section = e.selfClosing ? '' : e.local;
        continue;
      case 'numFmt':
        if (section === 'numFmts') {
          const id = attrInt(e, 'numFmtId', -1);
          const code = attr(e, 'formatCode');
          if (id >= 0 && code !== undefined) custom.set(id, code);
        }
        continue;
      case 'font':
        if (section === 'fonts') {
          fonts.push(readFont(p, e));
          continue;
        }
        break;
      case 'fill':
        if (section === 'fills') {
          fills.push(readFill(p, e, warn));
          continue;
        }
        break;
      case 'border':
        if (section === 'borders') {
          borders.push(readBorder(p, e));
          continue;
        }
        break;
      case 'xf':
        if (section === 'cellXfs') {
          xfs.push(readXf(p, e));
          continue;
        }
        break;
      default:
        break;
    }
    // 其余容器（cellStyleXfs / dxfs / tableStyles / extLst …）整棵跳过：
    // 它们的 <xf> / <font> / <fill> 不能混进单元格格式表
    if (!e.selfClosing) p.skipElement();
  }

  const styles: CellStyle[] = [];
  const numFmtCodes: string[] = [];
  const isDate: boolean[] = [];

  for (const xf of xfs) {
    const style: CellStyle = {};
    const font = fonts[xf.fontId];
    if (font) {
      if (font.bold) style.bold = true;
      if (font.italic) style.italic = true;
      if (font.underline) style.underline = true;
      if (font.strike) style.strike = true;
      if (font.size !== undefined) style.size = font.size;
      if (font.color !== undefined) style.color = font.color;
      if (font.name !== undefined) style.font = font.name;
    }
    const bg = fills[xf.fillId];
    if (bg !== undefined) style.bg = bg;
    const border = borders[xf.borderId];
    if (border) style.border = border;
    if (xf.align) style.align = xf.align;
    if (xf.vAlign) style.vAlign = xf.vAlign;
    if (xf.wrap) style.wrap = true;

    const code = resolveNumFmt(xf.numFmtId, custom);
    // 'General'（无格式）与 '@'（文本）是默认行为，写进模型只会让渲染器多一次判断
    if (code && code !== 'General' && code !== '@') style.numFmt = code;

    styles.push(style);
    numFmtCodes.push(code);
    isDate.push(isDateFormat(code));
  }

  return { styles, numFmtCodes, isDate };
}
