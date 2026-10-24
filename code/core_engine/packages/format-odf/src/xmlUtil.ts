/**
 * ODF 解析用的小工具：属性访问、颜色、相对路径解析。
 *
 * 为什么不用 packages/ooxml 的 xmlUtil：
 *   ODF 读取器应当可以**独立安装**（不装 OOXML 支持也能打开 odt）。
 *   这几十行是纯函数，复制一份比让 format-odf 反向依赖 ooxml 更符合本项目的
 *   「按需付费」分层。两者的语义刻意保持一致（本地名兜底、auto -> undefined）。
 *
 * 与 OOXML 不同的两处坑（都是 ODF 独有的）：
 *   1) ODF 的属性几乎总带前缀（`text:style-name` / `office:value-type`），
 *      但第三方生成器（部分 Java/.NET 库、某些导出器）会退化成无前缀写法。
 *   2) `xlink:href` 的前缀在不同文件里可能是 `xlink:`、`xlink1:` 甚至省略。
 *      因此取 href 必须按**本地名**匹配，不能写死 "xlink:href"。
 */
import type { XmlEvent } from '../../xml/src/index.ts';

/** 按限定名或本地名取属性值（"style-name" 能命中 "text:style-name"）。 */
export function attr(e: XmlEvent, name: string): string | undefined {
  const a = e.attrs;
  if (!a) return undefined;
  const direct = a[name];
  if (direct !== undefined) return direct;
  for (const k of Object.keys(a)) {
    const c = k.indexOf(':');
    if (c >= 0 && k.slice(c + 1) === name) return a[k];
  }
  return undefined;
}

/** 同时按多个候选本地名取属性，返回第一个命中的。 */
export function attrAny(e: XmlEvent, names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = attr(e, n);
    if (v !== undefined) return v;
  }
  return undefined;
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
 * ODF 布尔：`true` / `false`（XML Schema boolean，规范写法），
 * 但实际文件里也出现 `1` / `0`。缺省值由调用方给。
 */
export function parseOdfBool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return fallback;
}

export function attrBool(e: XmlEvent, name: string, fallback = false): boolean {
  return parseOdfBool(attr(e, name), fallback);
}

/**
 * 解析 ODF 颜色：`#RRGGBB` / `#RGB`。
 * 返回 undefined 表示「无颜色 / 自动」—— 刻意不返回黑色，否则会打断样式继承链
 * （`fo:color="auto"` 在 ODF 里表示「跟随系统」，不是显式黑）。
 */
export function parseColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s || s.toLowerCase() === 'auto' || s.toLowerCase() === 'transparent') return undefined;
  if (/^#?[0-9a-fA-F]{6}$/.test(s)) return `#${s.replace('#', '').toLowerCase()}`;
  if (/^#?[0-9a-fA-F]{3}$/.test(s)) {
    const h = s.replace('#', '').toLowerCase();
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  return undefined;
}

/**
 * 解析 `style:num-format` 里的「一位数字倍数」写法。
 * ODF 允许 `style:num-format="1"` 这类（每层用一个 1），
 * 也允许 `"A"` / `"a"` / `"I"` / `"i"`。
 */
export function numFormatKind(fmt: string | undefined): string {
  const f = (fmt ?? '').trim();
  if (!f) return '1';
  return f;
}

/**
 * 把 `xlink:href`（可能是相对路径）解析为**包内绝对条目路径**。
 *
 * 坑：ODF 的 href 相对于 **content.xml 所在目录**（通常是包根），
 * 且常写成 `./Pictures/1000000000000123456789.png`。
 * 早期实现直接拿 href 去 zip 里查，于是所有带 `./` 的图片都取不到。
 */
export function resolvePartPath(href: string): string {
  const cleaned = href.replace(/\\/g, '/').split('#')[0];
  const parts: string[] = [];
  for (const seg of cleaned.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/** 是否为外部链接（http/https/ftp/mailto 等），外部链接不加载字节。 */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href.trim());
}

/** 由文件扩展名猜 MIME（ODF 包内图片可能没有 manifest 声明）。 */
export function mimeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
    case 'jpe':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'webp':
      return 'image/webp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'emf':
      return 'image/emf';
    case 'wmf':
      return 'image/wmf';
    default:
      return 'application/octet-stream';
  }
}

/** 合并对象：后者中**已定义**的键覆盖前者。用于样式继承。 */
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
