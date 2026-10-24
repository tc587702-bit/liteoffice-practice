/**
 * `meta.xml` 元数据解析。
 *
 * 契约要点：
 *   - 日期是 ISO 8601 字符串（`2024-05-06T07:08:09.123456789`），直接放进 DocMeta
 *     的对应字段，**不做时区转换**：模型里存的就是文档自己声明的时间。
 *   - `meta:document-statistic` 是**作者机器上的统计结果**，与我们解析出来的
 *     真实值可能不一致（对方可能只统计了可见部分）。因此统计值只在我们的
 *     解析拿不到时兜底使用，且文档写入者的统计优先显示原始值。
 *
 * 与 OOXML 的差别：ODF 的元数据元素都是**本地名直查**即可
 * （dc:title / meta:initial-creator / meta:keyword …），没有 core.xml 那种
 * 属性值承载的结构，因此这里比 docx 的元数据解析简单得多。
 */
import { XmlPullParser, splitName } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import type { DocMeta } from '../../core/src/index.ts';

/** 解析 `meta.xml`（或扁平 ODF 里的 `office:meta`）为 DocMeta。 */
export function parseMetaXml(xml: string): DocMeta {
  const meta: DocMeta = {};
  const custom: Record<string, string> = {};
  /** 见下方 initial-creator 分支的说明：它的优先级高于 dc:creator */
  let initialCreator: string | undefined;

  let p: XmlPullParser;
  try {
    p = new XmlPullParser(xml);
  } catch {
    return meta;
  }

  let e: XmlEvent | null;
  try {
    while ((e = p.next()) !== null) {
      if (e.type !== 'start') continue;
      const local = e.local;
      if (local === 'title' || local === 'creator' || local === 'subject' || local === 'description') {
        const text = readText(p, e);
        applyDc(meta, local, text);
        continue;
      }
      switch (local) {
        case 'initial-creator': {
          // meta:initial-creator 是**第一个**保存者（作者），dc:creator 是最后修改者。
          // 两者语义不同：把 initial-creator 覆盖到 author 上会显示错人。
          // 注意 dc:creator 在文档里通常出现在 initial-creator **之前**，
          // 因此不能靠「author 已存在就跳过」——那样 author 永远是最后修改者。
          // 正确做法是先记下来，循环结束后统一以 initial-creator 为准。
          const t = readText(p, e);
          if (t) {
            initialCreator = t;
            custom['initialCreator'] = t;
          }
          break;
        }
        case 'creation-date': {
          const t = readText(p, e);
          if (t) meta.created = t;
          break;
        }
        case 'date': {
          const t = readText(p, e);
          if (t) meta.modified = t;
          break;
        }
        case 'printed-by':
        case 'print-date':
        case 'editing-duration': {
          const t = readText(p, e);
          if (t) custom[local] = t;
          break;
        }
        case 'editing-cycles': {
          const t = readText(p, e);
          if (t) custom['editingCycles'] = t;
          break;
        }
        case 'generator': {
          const t = readText(p, e);
          if (t) meta.application = t;
          break;
        }
        case 'keyword': {
          const t = readText(p, e);
          if (t) meta.keywords = meta.keywords ? `${meta.keywords}, ${t}` : t;
          break;
        }
        case 'initial-creator-2':
        case 'user-defined': {
          readUserDefined(p, e, custom);
          break;
        }
        case 'document-statistic': {
          applyStatistic(meta, custom, e);
          if (!e.selfClosing) p.skipElement();
          break;
        }
        case 'template': {
          if (!e.selfClosing) p.skipElement();
          break;
        }
        case 'language': {
          const t = readText(p, e);
          if (t) meta.language = t;
          break;
        }
        default:
          // 其它 meta:* 一律不跳过（可能含我们要的子元素），但也不解析。
          break;
      }
    }
  } catch {
    // meta.xml 损坏：元数据是可以全部缺失的，绝不能因此让文档打不开
  }

  if (initialCreator) meta.author = initialCreator;
  if (Object.keys(custom).length) meta.custom = custom;
  return meta;
}

function applyDc(meta: DocMeta, local: string, text: string): void {
  if (!text) return;
  switch (local) {
    case 'title':
      meta.title = text;
      break;
    case 'creator':
      meta.lastModifiedBy = text;
      // dc:creator 通常是作者本人 —— 在 initial-creator 缺失时兜底为 author
      if (!meta.author) meta.author = text;
      break;
    case 'subject':
      meta.subject = text;
      break;
    case 'description':
      meta.description = text;
      break;
    default:
      break;
  }
}

function readUserDefined(p: XmlPullParser, start: XmlEvent, custom: Record<string, string>): void {
  const name = attrLocal(start, 'name');
  const valueType = attrLocal(start, 'value-type');
  const value = attrLocal(start, valueType ? valueType : 'value');
  let text = '';
  if (!start.selfClosing) text = readText(p, start);
  const key = name ?? 'userDefined';
  const v = value ?? text;
  if (v) custom[key] = v;
}

function applyStatistic(meta: DocMeta, custom: Record<string, string>, e: XmlEvent): void {
  const pageCount = numAttr(e, 'page-count');
  const wordCount = numAttr(e, 'word-count');
  const charCount = numAttr(e, 'character-count');
  const tableCount = numAttr(e, 'table-count');
  const imageCount = numAttr(e, 'image-count');
  const paragraphCount = numAttr(e, 'paragraph-count');
  if (pageCount !== undefined) meta.pageCount = pageCount;
  if (wordCount !== undefined) meta.wordCount = wordCount;
  if (charCount !== undefined) meta.charCount = charCount;
  if (paragraphCount !== undefined) meta.paragraphCount = paragraphCount;
  // sheetCount 由读取器按实际解析出的工作表数填写，这里不猜
  if (tableCount !== undefined) custom['tableCount'] = String(tableCount);
  if (imageCount !== undefined) custom['imageCount'] = String(imageCount);
}

function numAttr(e: XmlEvent, local: string): number | undefined {
  const raw = attrLocal(e, local);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** 按本地名取属性：ODF 的属性前缀在不同生成器下可能不同。 */
function attrLocal(e: XmlEvent, local: string): string | undefined {
  const a = e.attrs;
  if (!a) return undefined;
  const direct = a[local];
  if (direct !== undefined) return direct;
  for (const k of Object.keys(a)) {
    const { local: l } = splitName(k);
    if (l === local) return a[k];
  }
  return undefined;
}

/** 读一个元素的文本内容（假定 p 刚产出 start，且非自闭合）。 */
function readText(p: XmlPullParser, start: XmlEvent): string {
  if (start.selfClosing) return '';
  let acc = '';
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type === 'text' || e.type === 'cdata') acc += e.text;
  }
  return acc.trim();
}

/**
 * 从扁平 ODF 的单文件里抓 `office:meta` 子树文本。
 *
 * 为什么不用 XmlPullParser 直接遍历：
 *   扁平 ODF 的根是 `office:document`，`office:meta` 是它的子元素，
 *   而文档主体（几十 MB 的 content）也在同一棵树里。为了元数据而遍历整棵树
 *   是浪费，所以这里定位到 office:meta 的**区间**再交给 parseMetaXml。
 */
export function extractMetaSection(xml: string): string | undefined {
  const start = xml.indexOf('<office:meta');
  if (start < 0) return undefined;
  const end = xml.indexOf('</office:meta>', start);
  if (end < 0) return undefined;
  return xml.slice(start, end + '</office:meta>'.length);
}
