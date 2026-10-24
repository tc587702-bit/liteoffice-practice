/**
 * OPC 包结构：内容类型、关系、部件路径解析。
 *
 * OPC（Open Packaging Conventions）是 OOXML 的容器规范：
 *   一个 zip，里面是若干「部件（part）」，部件之间靠 `.rels` 文件里的关系连接。
 * 关键点：**任何部件路径都不能硬编码**。真实文件里图片可能在
 * `word/media/`，也可能在 `word/embeddings/`，甚至被第三方工具重命名。
 * 因此必须走「关系 -> 目标」的解析，否则大量文件会「图片全丢」。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { attr, localOf } from './xmlUtil.ts';

export interface Relationship {
  id: string;
  type: string;
  /** 关系类型短名，如 "image" / "styles" / "slide" */
  shortType: string;
  /**
   * 关系目标。
   * - 内部关系（默认）：**已解析为包内部件路径**（相对包根，不含前导斜杠）
   * - 外部关系（`TargetMode="External"`）：**原始 URL 或文件路径，未做任何路径解析**
   *
   * 用 `external` 区分这两种含义再取值，不要假设它一定是包内部件路径。
   */
  target: string;
  /**
   * 是否为外部关系。
   *
   * 为什么必须有这个字段：外部关系与内部关系的 Target **语义完全不同** ——
   * 前者是 URL / 外部文件，后者是包内部件路径。早期版本一律按包内相对路径解析，
   * 于是 `Target="https://example.com" TargetMode="External"` 被解析成
   * `word/https:/example.com`（normalizePart 还会把 `//` 合并成 `/`），
   * 结果**所有超链接与外链图片全部失效**，而且失效得很隐蔽：链接还在，
   * 只是点到 404。docx/xlsx/pptx 三种格式都受影响。
   */
  external: boolean;
  /** 原始的 TargetMode 属性值（未归一化），便于诊断 */
  mode?: string;
}

export interface ContentTypes {
  /** 扩展名（小写，不含点）-> MIME */
  defaults: Map<string, string>;
  /** 部件路径 -> MIME */
  overrides: Map<string, string>;
}

/**
 * 这个字符串看起来是不是「带 scheme 的绝对引用」（URL 或绝对文件路径）？
 * 判据：冒号之前只出现 scheme 允许的字符，且出现过冒号。
 * 注意 `word/foo:bar.xml` 不会被误判 —— 冒号前出现了 `/`，不满足。
 */
export function looksAbsoluteReference(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
}

/**
 * 把关系目标解析为包内部件路径。
 *
 * OPC 规则：以 '/' 开头的是包内绝对路径；否则相对于**源部件所在目录**。
 * 注意是「源部件所在目录」而不是「_rels 目录」—— 这是最常见的实现错误，
 * 会导致 `word/_rels/document.xml.rels` 里的 `media/image1.png` 被解析成
 * `word/_rels/media/image1.png`。
 *
 * 外部引用（URL）会原样返回：它们不是部件路径，任何「规范化」都是破坏。
 */
export function resolveTarget(sourcePart: string, target: string): string {
  if (looksAbsoluteReference(target)) return target;
  if (target.startsWith('/')) return normalizePart(target.slice(1));
  const slash = sourcePart.lastIndexOf('/');
  const baseDir = slash < 0 ? '' : sourcePart.slice(0, slash + 1);
  return normalizePart(baseDir + target);
}

/** 规范化部件路径：处理 ../ 与 ./，去掉重复斜杠。 */
export function normalizePart(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/** 某个部件的 `.rels` 部件路径。`word/document.xml` -> `word/_rels/document.xml.rels` */
export function relsPathFor(part: string): string {
  const slash = part.lastIndexOf('/');
  const dir = slash < 0 ? '' : part.slice(0, slash + 1);
  const name = slash < 0 ? part : part.slice(slash + 1);
  return `${dir}_rels/${name}.rels`;
}

/** 关系类型短名：`http://.../officeDocument/2006/relationships/image` -> "image" */
export function shortRelType(type: string): string {
  const slash = type.lastIndexOf('/');
  return slash < 0 ? type : type.slice(slash + 1);
}

/** 解析一个 `.rels` 部件。sourcePart 是**拥有该关系的部件**（不是 rels 文件本身）。 */
export function parseRels(xml: string, sourcePart: string): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start' || e.local !== 'Relationship') continue;
    const id = attr(e, 'Id');
    const type = attr(e, 'Type') ?? '';
    const target = attr(e, 'Target');
    if (!id || target === undefined) continue;
    const mode = attr(e, 'TargetMode');
    // 外部关系：既看显式 TargetMode，也看目标本身是否像 URL。
    // 只信 TargetMode 是不够的 —— 真实文件里偶尔漏写 TargetMode 却直接给 URL。
    const external = (mode ?? '').toLowerCase() === 'external' || looksAbsoluteReference(target);
    out.set(id, {
      id,
      type,
      shortType: shortRelType(type),
      target: external ? target : resolveTarget(sourcePart, target),
      external,
      mode,
    });
  }
  return out;
}

export function parseContentTypes(xml: string): ContentTypes {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start') continue;
    if (e.local === 'Default') {
      const ext = attr(e, 'Extension');
      const ct = attr(e, 'ContentType');
      if (ext && ct) defaults.set(ext.toLowerCase(), ct);
    } else if (e.local === 'Override') {
      const part = attr(e, 'PartName');
      const ct = attr(e, 'ContentType');
      if (part && ct) overrides.set(normalizePart(part), ct);
    }
  }
  return { defaults, overrides };
}

const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  emf: 'image/emf',
  wmf: 'image/wmf',
};

/** 按部件路径推断 MIME；优先查内容类型，再按扩展名兜底。 */
export function mimeOf(part: string, types?: ContentTypes): string {
  const hit = types?.overrides.get(normalizePart(part));
  if (hit) return hit;
  const ext = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
  const byExt = types?.defaults.get(ext);
  if (byExt) return byExt;
  return IMAGE_EXT_MIME[ext] ?? 'application/octet-stream';
}

/**
 * 关系类型里出现的「命名空间年代」问题：Word 2007 用 2006 版命名空间，
 * 后续版本混用。这里只比对短名，避免被年份差异绊住。
 */
export function findRelByType(rels: Map<string, Relationship>, shortType: string): Relationship | undefined {
  for (const r of rels.values()) if (r.shortType === shortType) return r;
  return undefined;
}

export function findRelsByType(rels: Map<string, Relationship>, shortType: string): Relationship[] {
  const out: Relationship[] = [];
  for (const r of rels.values()) if (r.shortType === shortType) out.push(r);
  return out;
}

/**
 * 关系短名与常见部件的对照，便于按语义而非路径取部件。
 * 这是「不硬编码路径」的落地方式。
 */
export const REL = {
  officeDocument: 'officeDocument',
  styles: 'styles',
  stylesWithEffects: 'stylesWithEffects',
  numbering: 'numbering',
  theme: 'theme',
  fontTable: 'fontTable',
  settings: 'settings',
  webSettings: 'webSettings',
  footnotes: 'footnotes',
  endnotes: 'endnotes',
  comments: 'comments',
  header: 'header',
  footer: 'footer',
  image: 'image',
  hyperlink: 'hyperlink',
  chart: 'chart',
  diagramData: 'diagramData',
  oleObject: 'oleObject',
  package: 'package',
  sharedStrings: 'sharedStrings',
  worksheet: 'worksheet',
  slide: 'slide',
  slideLayout: 'slideLayout',
  slideMaster: 'slideMaster',
  notesSlide: 'notesSlide',
  presentation: 'presentation',
  workbook: 'workbook',
  coreProperties: 'core-properties',
  extendedProperties: 'extended-properties',
  customProperties: 'custom-properties',
} as const;

/** 本地名快速判断：`<w:Relationship>` 和 `<Relationship>` 都要认。 */
export function isLocal(e: XmlEvent, name: string): boolean {
  return e.local === name || localOf(e.name) === name;
}
