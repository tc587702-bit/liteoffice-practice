/**
 * 格式注册表。
 *
 * 设计目标：把「支持哪些格式」变成一张**数据表**而不是散落各处的 if/else。
 * 新增一种格式 = 表里加一行 + 写一个读取器，UI / 嗅探 / 文件对话框 / 统计全部自动跟上。
 *
 * 这也是「支持多种文档格式」这个产品主张的落地点：格式是一等公民。
 */
import type { DocKind, FormatId, FormatSpec } from './model.ts';

function spec(s: FormatSpec): FormatSpec {
  return s;
}

const OOXML_MIME_BASE = 'application/vnd.openxmlformats-officedocument';

export const FORMATS: readonly FormatSpec[] = [
  /* ---------------- OOXML：文字处理 ---------------- */
  spec({
    id: 'docx',
    kind: 'text',
    label: 'Word 文档',
    family: 'ooxml',
    container: 'zip',
    extensions: ['docx'],
    mimes: [`${OOXML_MIME_BASE}.wordprocessingml.document`],
    markers: ['word/document.xml'],
  }),
  spec({
    id: 'docm',
    kind: 'text',
    label: 'Word 文档（含宏）',
    family: 'ooxml',
    container: 'zip',
    extensions: ['docm'],
    mimes: [`${OOXML_MIME_BASE}.wordprocessingml.document.macroEnabled.12`],
    markers: ['word/document.xml'],
  }),
  spec({
    id: 'dotx',
    kind: 'text',
    label: 'Word 模板',
    family: 'ooxml',
    container: 'zip',
    extensions: ['dotx', 'dotm'],
    mimes: [`${OOXML_MIME_BASE}.wordprocessingml.template`],
    markers: ['word/document.xml'],
  }),

  /* ---------------- OOXML：表格 ---------------- */
  spec({
    id: 'xlsx',
    kind: 'sheet',
    label: 'Excel 工作簿',
    family: 'ooxml',
    container: 'zip',
    extensions: ['xlsx'],
    mimes: [`${OOXML_MIME_BASE}.spreadsheetml.sheet`],
    markers: ['xl/workbook.xml'],
  }),
  spec({
    id: 'xlsm',
    kind: 'sheet',
    label: 'Excel 工作簿（含宏）',
    family: 'ooxml',
    container: 'zip',
    extensions: ['xlsm'],
    mimes: [`${OOXML_MIME_BASE}.spreadsheetml.sheet.macroEnabled.12`],
    markers: ['xl/workbook.xml'],
  }),
  spec({
    // 模板是**独立格式**，而不是 xlsm 的一个扩展名。
    // 早期版本把 xltx/xltm 挂在 xlsm 的 extensions 里，同时又在 FormatId 联合类型里
    // 留了 xltx，于是「读取器可以声明 xltx，但格式表里查不到它」，
    // 表现为「已支持 + 未安装 > 声明总数」这种自相矛盾的统计。
    id: 'xltx',
    kind: 'sheet',
    label: 'Excel 模板',
    family: 'ooxml',
    container: 'zip',
    extensions: ['xltx', 'xltm'],
    mimes: [`${OOXML_MIME_BASE}.spreadsheetml.template`],
    markers: ['xl/workbook.xml'],
  }),

  /* ---------------- OOXML：演示 ---------------- */
  spec({
    id: 'pptx',
    kind: 'slides',
    label: 'PowerPoint 演示文稿',
    family: 'ooxml',
    container: 'zip',
    extensions: ['pptx'],
    mimes: [`${OOXML_MIME_BASE}.presentationml.presentation`],
    markers: ['ppt/presentation.xml'],
  }),
  spec({
    id: 'pptm',
    kind: 'slides',
    label: 'PowerPoint 演示文稿（含宏）',
    family: 'ooxml',
    container: 'zip',
    extensions: ['pptm', 'potm', 'ppsx', 'ppsm'],
    mimes: [`${OOXML_MIME_BASE}.presentationml.presentation.macroEnabled.12`],
    markers: ['ppt/presentation.xml'],
  }),
  spec({
    // 同 xltx 的理由：模板是独立格式，不该只作为 pptm 的扩展名存在。
    id: 'potx',
    kind: 'slides',
    label: 'PowerPoint 模板',
    family: 'ooxml',
    container: 'zip',
    extensions: ['potx', 'potm'],
    mimes: [`${OOXML_MIME_BASE}.presentationml.template`],
    markers: ['ppt/presentation.xml'],
  }),

  /* ---------------- ODF：文字处理 ---------------- */
  spec({
    id: 'odt',
    kind: 'text',
    label: 'OpenDocument 文本文档',
    family: 'odf',
    container: 'zip',
    extensions: ['odt'],
    mimes: ['application/vnd.oasis.opendocument.text'],
    markers: ['content.xml'],
  }),
  spec({
    id: 'ott',
    kind: 'text',
    label: 'OpenDocument 文本模板',
    family: 'odf',
    container: 'zip',
    extensions: ['ott'],
    mimes: ['application/vnd.oasis.opendocument.text-template'],
    markers: ['content.xml'],
  }),
  spec({
    id: 'fodt',
    kind: 'text',
    label: 'OpenDocument 文本（扁平 XML）',
    family: 'odf',
    container: 'plain',
    extensions: ['fodt'],
    mimes: ['application/vnd.oasis.opendocument.text-flat-xml'],
  }),

  /* ---------------- ODF：表格 ---------------- */
  spec({
    id: 'ods',
    kind: 'sheet',
    label: 'OpenDocument 电子表格',
    family: 'odf',
    container: 'zip',
    extensions: ['ods'],
    mimes: ['application/vnd.oasis.opendocument.spreadsheet'],
    markers: ['content.xml'],
  }),
  spec({
    id: 'ots',
    kind: 'sheet',
    label: 'OpenDocument 表格模板',
    family: 'odf',
    container: 'zip',
    extensions: ['ots'],
    mimes: ['application/vnd.oasis.opendocument.spreadsheet-template'],
    markers: ['content.xml'],
  }),
  spec({
    id: 'fods',
    kind: 'sheet',
    label: 'OpenDocument 表格（扁平 XML）',
    family: 'odf',
    container: 'plain',
    extensions: ['fods'],
    mimes: ['application/vnd.oasis.opendocument.spreadsheet-flat-xml'],
  }),

  /* ---------------- ODF：演示 ---------------- */
  spec({
    id: 'odp',
    kind: 'slides',
    label: 'OpenDocument 演示文稿',
    family: 'odf',
    container: 'zip',
    extensions: ['odp'],
    mimes: ['application/vnd.oasis.opendocument.presentation'],
    markers: ['content.xml'],
  }),
  spec({
    id: 'otp',
    kind: 'slides',
    label: 'OpenDocument 演示模板',
    family: 'odf',
    container: 'zip',
    extensions: ['otp'],
    mimes: ['application/vnd.oasis.opendocument.presentation-template'],
    markers: ['content.xml'],
  }),
  spec({
    id: 'fodp',
    kind: 'slides',
    label: 'OpenDocument 演示（扁平 XML）',
    family: 'odf',
    container: 'plain',
    extensions: ['fodp'],
    mimes: ['application/vnd.oasis.opendocument.presentation-flat-xml'],
  }),

  /* ---------------- ODF：图形 ---------------- */
  spec({
    id: 'odg',
    kind: 'slides',
    label: 'OpenDocument 图形',
    family: 'odf',
    container: 'zip',
    extensions: ['odg', 'otg'],
    mimes: ['application/vnd.oasis.opendocument.graphics'],
    markers: ['content.xml'],
  }),

  /* ---------------- 固定版式 ---------------- */
  spec({
    id: 'pdf',
    kind: 'pdf',
    label: 'PDF 文档',
    family: 'pdf',
    container: 'pdf',
    extensions: ['pdf'],
    mimes: ['application/pdf'],
  }),

  /* ---------------- 纯文本家族 ---------------- */
  spec({
    id: 'md',
    kind: 'text',
    label: 'Markdown',
    family: 'text',
    container: 'plain',
    extensions: ['md', 'markdown', 'mdown', 'mkd'],
    mimes: ['text/markdown'],
  }),
  spec({
    id: 'txt',
    kind: 'text',
    label: '纯文本',
    family: 'text',
    container: 'plain',
    extensions: ['txt', 'text'],
    mimes: ['text/plain'],
  }),
  spec({
    id: 'log',
    kind: 'text',
    label: '日志文本',
    family: 'text',
    container: 'plain',
    extensions: ['log'],
    mimes: ['text/plain'],
  }),
  spec({
    id: 'csv',
    kind: 'sheet',
    label: 'CSV 表格',
    family: 'text',
    container: 'plain',
    extensions: ['csv'],
    mimes: ['text/csv'],
  }),
  spec({
    id: 'tsv',
    kind: 'sheet',
    label: 'TSV 表格',
    family: 'text',
    container: 'plain',
    extensions: ['tsv', 'tab'],
    mimes: ['text/tab-separated-values'],
  }),
  spec({
    id: 'json',
    kind: 'text',
    label: 'JSON',
    family: 'text',
    container: 'plain',
    extensions: ['json', 'jsonc', 'json5'],
    mimes: ['application/json'],
  }),

  /* ---------------- 标记/结构化 ---------------- */
  spec({
    id: 'html',
    kind: 'text',
    label: 'HTML 网页',
    family: 'markup',
    container: 'plain',
    extensions: ['html', 'htm', 'xhtml'],
    mimes: ['text/html'],
  }),
  spec({
    id: 'xml',
    kind: 'text',
    label: 'XML 文档',
    family: 'markup',
    container: 'plain',
    extensions: ['xml'],
    mimes: ['application/xml', 'text/xml'],
  }),
  spec({
    id: 'svg',
    kind: 'slides',
    label: 'SVG 矢量图',
    family: 'markup',
    container: 'plain',
    extensions: ['svg'],
    mimes: ['image/svg+xml'],
  }),
  spec({
    id: 'rtf',
    kind: 'text',
    label: 'RTF 富文本',
    family: 'text',
    container: 'plain',
    extensions: ['rtf'],
    mimes: ['application/rtf'],
  }),
  spec({
    id: 'epub',
    kind: 'text',
    label: 'EPUB 电子书',
    family: 'markup',
    container: 'epub',
    extensions: ['epub'],
    mimes: ['application/epub+zip'],
    markers: ['META-INF/container.xml'],
  }),

  /* ---------------- 旧版二进制：明确识别但不支持 ---------------- */
  spec({
    id: 'ole2-doc',
    kind: 'text',
    label: 'Word 97-2003 文档（旧版二进制）',
    family: 'legacy',
    container: 'ole2',
    extensions: ['doc'],
    mimes: ['application/msword'],
  }),
  spec({
    id: 'ole2-xls',
    kind: 'sheet',
    label: 'Excel 97-2003 工作簿（旧版二进制）',
    family: 'legacy',
    container: 'ole2',
    extensions: ['xls'],
    mimes: ['application/vnd.ms-excel'],
  }),
  spec({
    id: 'ole2-ppt',
    kind: 'slides',
    label: 'PowerPoint 97-2003 演示文稿（旧版二进制）',
    family: 'legacy',
    container: 'ole2',
    extensions: ['ppt'],
    mimes: ['application/vnd.ms-powerpoint'],
  }),

  spec({
    id: 'unknown',
    kind: 'raw',
    label: '未知格式',
    family: 'text',
    container: 'plain',
    extensions: [],
    mimes: ['application/octet-stream'],
  }),
];

const BY_ID = new Map<FormatId, FormatSpec>(FORMATS.map((f) => [f.id, f]));
const BY_EXT = new Map<string, FormatSpec>();
const BY_MIME = new Map<string, FormatSpec>();

for (const f of FORMATS) {
  for (const e of f.extensions) if (!BY_EXT.has(e)) BY_EXT.set(e, f);
  // MIME 必须小写化后入索引：真实 MIME 里含大写（例如 OOXML 的 "macroEnabled.12"），
  // 而查找时会先 toLowerCase；键不小写就会永远查不到，表现为「某些格式识别不出来」。
  for (const m of f.mimes) {
    const key = m.toLowerCase();
    if (!BY_MIME.has(key)) BY_MIME.set(key, f);
  }
}

export function formatSpec(id: FormatId): FormatSpec {
  return BY_ID.get(id) ?? BY_ID.get('unknown')!;
}

/** 取文件扩展名（小写，不含点） */
export function extensionOf(nameOrPath: string): string {
  const base = nameOrPath.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function formatByExtension(nameOrPath: string): FormatSpec | undefined {
  return BY_EXT.get(extensionOf(nameOrPath));
}

export function formatByMime(mime: string): FormatSpec | undefined {
  const m = mime.split(';')[0].trim().toLowerCase();
  return BY_MIME.get(m);
}

export function formatLabel(id: FormatId): string {
  return formatSpec(id).label;
}

export function kindOf(id: FormatId): DocKind {
  return formatSpec(id).kind;
}

/** 按类别分组，用于 UI 的「打开」对话框与文档说明 */
export function formatsByKind(): Record<DocKind, FormatSpec[]> {
  const out: Record<string, FormatSpec[]> = { text: [], sheet: [], slides: [], pdf: [], raw: [] };
  for (const f of FORMATS) {
    if (f.id === 'unknown') continue;
    out[f.kind].push(f);
  }
  return out as Record<DocKind, FormatSpec[]>;
}

/** 目前登记的全部扩展名 */
export function allExtensions(): string[] {
  const set = new Set<string>();
  for (const f of FORMATS) for (const e of f.extensions) set.add(e);
  return [...set].sort();
}

export function acceptAttribute(): string {
  const parts = new Set<string>();
  for (const f of FORMATS) {
    if (f.id === 'unknown') continue;
    for (const e of f.extensions) parts.add(`.${e}`);
  }
  for (const f of FORMATS) for (const m of f.mimes) parts.add(m);
  return [...parts].join(',');
}
