/**
 * docProps/core.xml 与 docProps/app.xml。
 *
 * 为什么按「本地名」逐个事件匹配、而不是按固定元素顺序取第 N 个孩子：
 *   这两个部件虽然结构简单，但生成器差异极大（WPS / LibreOffice / python-docx /
 *   Word 各自写的属性集合与顺序都不同）。按名字取才不会因为少了某个属性就整体错位。
 *   命名空间前缀也无法固定（dc:title / title 都出现过），所以用 local 名匹配。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { readTextContent } from '../../ooxml/src/index.ts';
import type { DocMeta } from '../../core/src/model.ts';

/** core.xml：dc:title / dc:creator / dcterms:created … */
export function parseCoreProps(xml: string): DocMeta {
  const meta: DocMeta = {};
  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start') continue;
    const name = e.local;
    if (!KNOWN_CORE.has(name)) continue;
    const text = e.selfClosing ? '' : readTextContent(p).trim();
    if (!text) continue;
    switch (name) {
      case 'title':
        meta.title = text;
        break;
      case 'subject':
        meta.subject = text;
        break;
      case 'creator':
        // dc:creator 是「作者」，不要与 cp:lastModifiedBy 混起来
        meta.author ??= text;
        break;
      case 'lastModifiedBy':
        meta.lastModifiedBy = text;
        break;
      case 'keywords':
        meta.keywords = text;
        break;
      case 'description':
        meta.description = text;
        break;
      case 'category':
        meta.category = text;
        break;
      case 'language':
        meta.language = text;
        break;
      case 'created':
        meta.created = text;
        break;
      case 'modified':
        meta.modified = text;
        break;
      case 'revision':
        (meta.custom ??= {})['revision'] = text;
        break;
      case 'contentStatus':
        (meta.custom ??= {})['contentStatus'] = text;
        break;
      default:
        break;
    }
  }
  return meta;
}

const KNOWN_CORE = new Set([
  'title',
  'subject',
  'creator',
  'lastModifiedBy',
  'keywords',
  'description',
  'category',
  'language',
  'created',
  'modified',
  'revision',
  'contentStatus',
]);

/** app.xml：Application / Pages / Words / Characters / Company / TotalTime … */
export function parseAppProps(xml: string): DocMeta {
  const meta: DocMeta = {};
  const custom: Record<string, string> = {};
  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start') continue;
    const name = e.local;
    if (!KNOWN_APP.has(name)) continue;
    const text = e.selfClosing ? '' : readTextContent(p).trim();
    if (!text) continue;
    switch (name) {
      case 'Application':
        meta.application = text;
        break;
      case 'AppVersion':
        meta.appVersion = text;
        break;
      case 'Company':
        meta.company = text;
        break;
      case 'Manager':
        meta.manager = text;
        break;
      case 'Pages':
        meta.pageCount = toPosInt(text);
        break;
      case 'Words':
        meta.wordCount = toPosInt(text);
        break;
      case 'Characters':
        meta.charCount = toPosInt(text);
        break;
      case 'Paragraphs':
        meta.paragraphCount = toPosInt(text);
        break;
      case 'TotalTime':
        // Office 的 TotalTime 单位是分钟
        custom['totalTimeMinutes'] = text;
        break;
      case 'CharactersWithSpaces':
        custom['charactersWithSpaces'] = text;
        break;
      case 'Lines':
        custom['lines'] = text;
        break;
      case 'Template':
        custom['template'] = text;
        break;
      default:
        break;
    }
  }
  if (Object.keys(custom).length) meta.custom = { ...(meta.custom ?? {}), ...custom };
  return meta;
}

const KNOWN_APP = new Set([
  'Application',
  'AppVersion',
  'Company',
  'Manager',
  'Pages',
  'Words',
  'Characters',
  'CharactersWithSpaces',
  'Paragraphs',
  'Lines',
  'TotalTime',
  'Template',
]);

/**
 * 取正整数；0 与非法值都返回 undefined。
 *
 * 为什么把 0 当「未知」：Word for Mac 生成的 app.xml 里 Words/Characters/Paragraphs
 * 常常全是 0（它没算过）。照抄 0 会让用户看到「0 字」——比不显示更糟。
 * 于是交给读取器用真实解析结果兜底。
 */
function toPosInt(text: string): number | undefined {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
