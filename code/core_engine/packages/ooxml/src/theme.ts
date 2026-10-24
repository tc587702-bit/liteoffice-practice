/**
 * 主题色解析。
 *
 * 为什么必须做：Word 里绝大多数彩色文本写的是 `w:color w:themeColor="accent1"`，
 * 而不是十六进制值。不解析主题，这些文字会全部变成默认黑色 —— 用户会觉得
 * 「颜色全丢了」。而主题色本身又可能是 `a:sysClr`（系统色，只有 lastClr 是真实值），
 * 只读 srgbClr 会漏掉一半。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { attr, parseColor } from './xmlUtil.ts';

export type Theme = Map<string, string>;

export const EMPTY_THEME: Theme = new Map();

/** OOXML 的 clrScheme 槽位名 */
const SCHEME_SLOTS = new Set([
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
]);

/** 把 w:color 的 themeColor 取值映射到 clrScheme 槽位。 */
const THEME_ALIAS: Record<string, string> = {
  dark1: 'dk1',
  light1: 'lt1',
  dark2: 'dk2',
  light2: 'lt2',
  text1: 'dk1',
  background1: 'lt1',
  text2: 'dk2',
  background2: 'lt2',
  hyperlink: 'hlink',
  followedHyperlink: 'folHlink',
};

export function parseTheme(xml: string): Theme {
  const theme: Theme = new Map();
  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start' || e.local !== 'clrScheme') continue;
    if (e.selfClosing) continue;
    let se: XmlEvent | null;
    while ((se = p.next()) !== null) {
      if (se.type === 'end') break;
      if (se.type !== 'start') continue;
      const slot = se.local;
      if (!SCHEME_SLOTS.has(slot)) {
        if (!se.selfClosing) p.skipElement();
        continue;
      }
      // 槽位里是 srgbClr 或 sysClr（系统色），二者都可能
      let ce: XmlEvent | null;
      while ((ce = p.next()) !== null) {
        if (ce.type === 'end') break;
        if (ce.type !== 'start') continue;
        if (ce.local === 'srgbClr') {
          const c = parseColor(attr(ce, 'val'));
          if (c) theme.set(slot, c);
        } else if (ce.local === 'sysClr') {
          // 系统色只有 lastClr 是稳定可用的真实值
          const c = parseColor(attr(ce, 'lastClr'));
          if (c) theme.set(slot, c);
        }
        if (!ce.selfClosing) p.skipElement();
      }
    }
  }
  return theme;
}

/** 解析 themeColor / themeFill 之类的引用。 */
export function themeColorAt(theme: Theme, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = THEME_ALIAS[name] ?? name;
  return theme.get(key);
}

/**
 * Word 默认主题的近似值（Office 主题）。
 * 用途：docx 不带 theme1.xml 时（第三方生成器常省略）用一套合理默认，
 * 好过整篇变黑。注意这是**降级**，调用方应记录 warning。
 */
export const DEFAULT_OFFICE_THEME: Theme = new Map([
  ['dk1', '#000000'],
  ['lt1', '#ffffff'],
  ['dk2', '#44546a'],
  ['lt2', '#e7e6e6'],
  ['accent1', '#4472c4'],
  ['accent2', '#ed7d31'],
  ['accent3', '#a5a5a5'],
  ['accent4', '#ffc000'],
  ['accent5', '#5b9bd5'],
  ['accent6', '#70ad47'],
  ['hlink', '#0563c1'],
  ['folHlink', '#954f72'],
]);

/**
 * 应用主题色修正：把只带主题引用的颜色补成真实十六进制。
 * 就地修改传入的属性对象（读取器在边界处调用一次）。
 */
export function applyTheme(
  theme: Theme,
  props: { color?: string; themeColor?: string; highlight?: string; themeFill?: string },
): void {
  if (!props.color && props.themeColor) {
    const c = themeColorAt(theme, props.themeColor);
    if (c) props.color = c;
  }
  if (!props.highlight && props.themeFill) {
    const c = themeColorAt(theme, props.themeFill);
    if (c) props.highlight = c;
  }
}
