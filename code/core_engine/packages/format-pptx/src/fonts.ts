/**
 * 主题字体（`a:fontScheme`）解析。
 *
 * 为什么必须做：PowerPoint 的默认文字样式几乎从不写真实字体名，而是写
 * **主题引用** —— `<a:latin typeface="+mj-lt"/>`（major latin）、
 * `<a:ea typeface="+mj-ea"/>`。不解析 fontScheme 的话，这些 `+mj-*` / `+mn-*`
 * 会原样进模型，渲染器找不到叫「+mj-lt」的字体，只能退回系统默认 ——
 * 现象是「所有中文都变成了宋体」，而用户明明在 PowerPoint 里设了微软雅黑。
 *
 * 本模块只在 pptx 包内使用（ooxml 层的 theme.ts 专注于颜色，不动它，
 * 避免影响并行开发中的其他格式包）。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { attr } from '../../ooxml/src/xmlUtil.ts';

export interface ThemeFonts {
  /** `+mj-lt` */
  majorLatin?: string;
  /** `+mj-ea` */
  majorEa?: string;
  /** `+mj-cs` */
  majorCs?: string;
  /** `+mn-lt` */
  minorLatin?: string;
  /** `+mn-ea` */
  minorEa?: string;
  /** `+mn-cs` */
  minorCs?: string;
}

export const EMPTY_THEME_FONTS: ThemeFonts = {};

/**
 * 解析 `a:themeElements/a:fontScheme`。
 * 解析失败或缺失时返回空对象（调用方把 `+xx` 原样留着，由渲染器兜底）。
 */
export function parseThemeFonts(xml: string): ThemeFonts {
  const out: ThemeFonts = {};
  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start' || e.local !== 'fontScheme' || e.selfClosing) continue;
    readChildren(p, e, (child) => {
      const major = child.local === 'majorFont';
      const minor = child.local === 'minorFont';
      if (!major && !minor) return false;
      if (child.selfClosing) return false;
      readChildren(p, child, (slot) => {
        if (slot.local === 'latin') {
          const tf = attr(slot, 'typeface');
          if (tf) setFont(out, major, 'latin', tf);
          return false;
        }
        if (slot.local === 'ea') {
          const tf = attr(slot, 'typeface');
          if (tf) setFont(out, major, 'ea', tf);
          return false;
        }
        if (slot.local === 'cs') {
          const tf = attr(slot, 'typeface');
          if (tf) setFont(out, major, 'cs', tf);
          return false;
        }
        // a:font script="Hans" typeface="宋体" 之类的补充字体表：留作后续
        return false;
      });
      return true;
    });
  }
  return out;
}

function setFont(out: ThemeFonts, major: boolean, kind: 'latin' | 'ea' | 'cs', typeface: string): void {
  if (major) {
    if (kind === 'latin') out.majorLatin = typeface;
    else if (kind === 'ea') out.majorEa = typeface;
    else out.majorCs = typeface;
    return;
  }
  if (kind === 'latin') out.minorLatin = typeface;
  else if (kind === 'ea') out.minorEa = typeface;
  else out.minorCs = typeface;
}

/**
 * 把 `+mj-lt` / `+mn-ea` 之类的主题引用换成真实字体名。
 * 遇到不是 `+` 开头的值原样返回（那就是普通字体名）。
 */
export function resolveThemeFont(typeface: string | undefined, fonts: ThemeFonts): string | undefined {
  if (!typeface) return undefined;
  if (!typeface.startsWith('+')) return typeface;
  const key = typeface.toLowerCase();
  const major = key.startsWith('+mj');
  switch (key) {
    case '+mj-lt':
      return fonts.majorLatin ?? fonts.majorEa;
    case '+mj-ea':
      return fonts.majorEa ?? fonts.majorLatin;
    case '+mj-cs':
      return fonts.majorCs ?? fonts.majorLatin;
    case '+mn-lt':
      return fonts.minorLatin ?? fonts.minorEa;
    case '+mn-ea':
      return fonts.minorEa ?? fonts.minorLatin;
    case '+mn-cs':
      return fonts.minorCs ?? fonts.minorLatin;
    default:
      // 未知的 +xx：major 系列退到 majorLatin，其余退到 minorLatin
      return major ? (fonts.majorLatin ?? fonts.minorLatin) : (fonts.minorLatin ?? fonts.majorLatin);
  }
}

/** 遍历子元素；visit 返回 true 表示已消费该子树，false 表示跳过。 */
function readChildren(p: XmlPullParser, e: XmlEvent, visit: (child: XmlEvent) => boolean): void {
  if (e.selfClosing) return;
  let cur: XmlEvent | null;
  while ((cur = p.next()) !== null) {
    if (cur.type === 'end') return;
    if (cur.type !== 'start') continue;
    if (!visit(cur) && !cur.selfClosing) skipSubtree(p, cur);
  }
}

/** 按层级跳过（不能用 parser.skipElement：它会让下一个 next() 返回 null）。 */
function skipSubtree(p: XmlPullParser, e: XmlEvent): void {
  let depth = 0;
  let cur: XmlEvent | null;
  while ((cur = p.next()) !== null) {
    if (cur.type === 'start') {
      if (!cur.selfClosing) depth++;
      continue;
    }
    if (cur.type !== 'end') continue;
    if (depth === 0) return;
    depth--;
  }
}
