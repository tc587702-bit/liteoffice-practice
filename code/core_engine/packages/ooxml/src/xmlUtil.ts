/**
 * OOXML 通用小工具。
 *
 * 存在的意义：OOXML 的属性访问有个反复出现的痛点 ——
 * 同一个逻辑属性可能写成 `w:val`、`val`，或者带前缀与否不一致（不同的
 * 生成器行为不同：Word 总是带前缀，某些第三方库会去掉）。
 * 如果每个读取器各写一遍 `e.attrs?.['w:val'] ?? e.attrs?.['val']`，
 * 迟早会出现某个读取器忘了兜底、于是某类文件打不开。
 *
 * 因此统一在这里提供「按本地名查属性」的访问器。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';

/** 按限定名或本地名取属性值。 */
export function attr(e: XmlEvent, name: string): string | undefined {
  const a = e.attrs;
  if (!a) return undefined;
  const direct = a[name];
  if (direct !== undefined) return direct;
  // 回退到本地名匹配（"val" 命中 "w:val"）
  for (const k of Object.keys(a)) {
    const c = k.indexOf(':');
    if (c >= 0 && k.slice(c + 1) === name) return a[k];
  }
  return undefined;
}

/** 取属性的本地名（去掉前缀）。 */
export function localOf(qname: string): string {
  const c = qname.indexOf(':');
  return c < 0 ? qname : qname.slice(c + 1);
}

export function attrNum(e: XmlEvent, name: string, fallback = 0): number {
  const v = attr(e, name);
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export function attrInt(e: XmlEvent, name: string, fallback = 0): number {
  const v = attr(e, name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * OOXML 布尔值。注意有三种写法并存：
 *   显式值 "1"/"0"/"true"/"false"/"on"/"off"
 *   仅存在性（如 `<w:b/>` 表示 true，`<w:b w:val="0"/>` 表示 false）
 */
export function attrBool(e: XmlEvent, name: string, fallback = true): boolean {
  const v = attr(e, name);
  if (v === undefined) return fallback;
  return parseOnOff(v);
}

export function parseOnOff(v: string | undefined): boolean {
  if (v === undefined || v === '') return true;
  const s = v.trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

/** `<w:b/>` 形式：元素存在且没有 val 属性即 true */
export function onOff(e: XmlEvent): boolean {
  return attrBool(e, 'val', true);
}

/** 取文本内容：假定 p 刚产出 start 事件，消费到匹配的 end，返回内部全部文本。 */
export function readTextContent(p: XmlPullParser): string {
  let out = '';
  let depth = 0;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') {
      if (!e.selfClosing) depth++;
    } else if (e.type === 'end') {
      if (depth === 0) break;
      depth--;
    } else if (e.type === 'text' || e.type === 'cdata') {
      out += e.text;
    }
  }
  return out;
}

/** 消费当前元素的整棵子树（假定 p 刚产出其 start 事件且非自闭合）。 */
export function consumeElement(p: XmlPullParser): void {
  p.skipElement();
}

/**
 * 解析 `#RRGGBB` / `RRGGBB` / `auto` 为主题无关的颜色。
 * 返回 undefined 表示「无颜色/自动」—— 让上层决定继承还是用默认值，
 * 而不是在这里硬编码一个黑色，否则样式继承链会被打断。
 */
export function parseColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (s === '' || s.toLowerCase() === 'auto') return undefined;
  if (/^#?[0-9a-fA-F]{6}$/.test(s)) return `#${s.replace('#', '').toLowerCase()}`;
  if (/^#?[0-9a-fA-F]{3}$/.test(s)) {
    const h = s.replace('#', '').toLowerCase();
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  return undefined;
}

/** 把 EMU/twip 等字符串长度安全转成数字 */
export function parseLen(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 合并对象：后者中已定义的键覆盖前者。用于样式继承。 */
export function mergeDefined<T extends object>(base: T | undefined, over: T | undefined): T | undefined {
  if (!base) return over;
  if (!over) return base;
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(over)) {
    const v = (over as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** 消费 `w:rPr` / `w:pPr` 之类只含空子元素的属性容器，把每个子元素交给回调。 */
export function readPropChildren(p: XmlPullParser, onChild: (e: XmlEvent) => void): void {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    onChild(e);
    if (!e.selfClosing) p.skipElement();
  }
}
