/**
 * ODF 包结构：mimetype 判定、META-INF/manifest.xml、加密检测。
 *
 * 为什么要专门做这三件事：
 *   1) `mimetype` 是 ODF 规范的**权威判据**。扩展名会骗人（用户把 odt 改名成 .docx、
 *      或者 LibreOffice 的「另存为」写错后缀），而 mimetype 条目是规范强制存在的。
 *      它还必须排在 ZIP 首位且**不压缩存储** —— 这样 `file(1)` 之类工具
 *      只看前几十字节就能判定格式，也是我们需要 `{ store: true }` 写夹具的原因。
 *   2) `META-INF/manifest.xml` 是包内条目的索引。缺了它包仍可能可读，
 *      但有了它我们能知道哪些条目是加密的。
 *   3) **加密必须显式拒绝**：加密条目的字节是乱码，硬解压只会得到一堆
 *      乱码 XML 并抛出莫名其妙的解析错误。抛 ReadError('ENCRYPTED')
 *      才能让 UI 给出「该文档已加密，当前版本不支持」这句人话。
 */
import type { FormatId } from '../../core/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { XmlPullParser } from '../../xml/src/index.ts';
import { attr } from './xmlUtil.ts';
import type { OdManifest } from './types.ts';

/** ODF 的 mimetype 字符串 -> LiteOffice 的 FormatId（含模板变体）。 */
const MIMETYPE_TO_FORMAT: Record<string, FormatId> = {
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.text-template': 'ott',
  'application/vnd.oasis.opendocument.text-master': 'odt',
  'application/vnd.oasis.opendocument.text-web': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.spreadsheet-template': 'ots',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.presentation-template': 'otp',
  'application/vnd.oasis.opendocument.graphics': 'odg',
  'application/vnd.oasis.opendocument.graphics-template': 'odg',
};

/** 扁平变体的 office:mimetype -> FormatId（flat-* 后缀映射到 fodt/fods/fodp）。 */
const FLAT_MIMETYPE_TO_FORMAT: Record<string, FormatId> = {
  'application/vnd.oasis.opendocument.text': 'fodt',
  'application/vnd.oasis.opendocument.text-template': 'fodt',
  'application/vnd.oasis.opendocument.spreadsheet': 'fods',
  'application/vnd.oasis.opendocument.spreadsheet-template': 'fods',
  'application/vnd.oasis.opendocument.presentation': 'fodp',
  'application/vnd.oasis.opendocument.presentation-template': 'fodp',
  'application/vnd.oasis.opendocument.graphics': 'odg',
  'application/vnd.oasis.opendocument.text-flat-xml': 'fodt',
  'application/vnd.oasis.opendocument.spreadsheet-flat-xml': 'fods',
  'application/vnd.oasis.opendocument.presentation-flat-xml': 'fodp',
};

/** mimetype -> 格式。未登记返回 undefined（调用方回退到根元素判定）。 */
export function formatFromMimetype(mime: string, flat: boolean): FormatId | undefined {
  const m = mime.trim();
  const table = flat ? FLAT_MIMETYPE_TO_FORMAT : MIMETYPE_TO_FORMAT;
  return table[m];
}

/** 由 mimetype 推容器类别（三类文档在 UDM 里的形状不同）。 */
export type OdFamily = 'text' | 'sheet' | 'slides';

export function familyFromMimetype(mime: string): OdFamily | undefined {
  const m = mime.trim();
  if (m.includes('.text')) return 'text';
  if (m.includes('.spreadsheet')) return 'sheet';
  if (m.includes('.presentation') || m.includes('.graphics')) return 'slides';
  return undefined;
}

/** 由 FormatId 推容器类别，用于 mimetype 缺失时的兜底。 */
export function familyFromFormat(id: FormatId): OdFamily {
  switch (id) {
    case 'ods':
    case 'ots':
    case 'fods':
      return 'sheet';
    case 'odp':
    case 'otp':
    case 'odg':
    case 'fodp':
      return 'slides';
    default:
      return 'text';
  }
}

/** 由根元素名推容器类别。 */
export function familyFromRoot(local: string): OdFamily | undefined {
  switch (local) {
    case 'text':
      return 'text';
    case 'spreadsheet':
      return 'sheet';
    case 'presentation':
    case 'drawing':
      return 'slides';
    default:
      return undefined;
  }
}

/* ==================================================================== */
/* manifest                                                              */
/* ==================================================================== */

/**
 * 解析 `META-INF/manifest.xml`。
 *
 * 关注两件事：
 *   - `manifest:file-entry` 的 `manifest:full-path` -> `manifest:media-type`
 *     （图片的 MIME 靠它，比按扩展名猜准）
 *   - **加密标记** `manifest:encryption-data`：出现在 file-entry 内部，
 *     也可能被写在 manifest 根上（部分生成器）。两者都要看。
 */
export function parseManifest(xml: string): OdManifest {
  const entries = new Map<string, string>();
  const encryptedEntries: string[] = [];
  let encrypted = false;

  let p: XmlPullParser;
  try {
    p = new XmlPullParser(xml);
  } catch {
    return { entries, encrypted: false, encryptedEntries };
  }

  try {
    let e: XmlEvent | null;
    while ((e = p.next()) !== null) {
      if (e.type !== 'start') continue;
      if (e.local === 'encryption-data') {
        encrypted = true;
        continue;
      }
      if (e.local !== 'file-entry') continue;
      const path = attr(e, 'full-path');
      const mediaType = attr(e, 'media-type');
      if (path !== undefined && mediaType) entries.set(normalizeEntryPath(path), mediaType);
      if (e.selfClosing) continue;
      // file-entry 的子树：查 encryption-data / encryption-data 下的算法
      let c: XmlEvent | null;
      while ((c = p.next()) !== null) {
        if (c.type === 'end') break;
        if (c.type !== 'start') continue;
        if (c.local === 'encryption-data') {
          encrypted = true;
          if (path) encryptedEntries.push(path);
        }
        if (!c.selfClosing) p.skipElement();
      }
    }
  } catch {
    // manifest 损坏：不影响正文解析（除了加密检测会失效，但那时解压本身就会失败）
  }

  return { entries, encrypted, encryptedEntries };
}

function normalizeEntryPath(path: string): string {
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

/** 空 manifest，用于缺 META-INF/manifest.xml 的降级路径。 */
export function emptyManifest(): OdManifest {
  return { entries: new Map(), encrypted: false, encryptedEntries: [] };
}
