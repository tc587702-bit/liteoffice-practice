/**
 * 格式嗅探。
 *
 * 为什么不能只看扩展名：用户会把 .docx 改名成 .zip、把 CSV 存成 .txt、
 * 把 ODF 存成 .docx（LibreOffice 的「另存为 Word」偶尔会这样）。
 * 靠扩展名派发读取器会直接读错格式并给出莫名其妙的错误。
 *
 * 因此判定顺序是「内容优先，扩展名兜底」：
 *   1. 魔数（PDF / OLE2 / RTF / ZIP）
 *   2. ZIP 内部结构（mimetype 条目、特征部件）—— 权威判据
 *   3. 文本启发式（HTML / SVG / JSON / CSV / Markdown）
 *   4. 扩展名（最后的兜底）
 */
import { FORMATS, formatSpec, formatByExtension, formatByMime, extensionOf } from '../../core/src/formats.ts';
import type { FormatId, FormatSpec } from '../../core/src/model.ts';
import type { ContainerAccess } from '../../core/src/registry.ts';

export interface SniffResult {
  format: FormatId;
  spec: FormatSpec;
  /** 0..1，仅用于诊断与 tie-break，不参与业务判断 */
  confidence: number;
  /** 判定依据的人话说明，显示在 UI 的格式徽标 tooltip 里 */
  reason: string;
}

export interface SniffOptions {
  /** 外部提供的 MIME（如 File.type），仅作弱线索 */
  mime?: string;
  /** 已打开的 ZIP 容器。提供时能给出权威判定。 */
  container?: ContainerAccess;
}

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGICS = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
  if (bytes.length < at + magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[at + i] !== magic[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, at: number, len: number): string {
  let s = '';
  const end = Math.min(bytes.length, at + len);
  for (let i = at; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** ODF 的 mimetype 条目内容 -> 格式 */
const ODF_MIMETYPES: Record<string, FormatId> = {
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

/**
 * ZIP 内部结构判定（权威）。
 * 顺序重要：先 ODF 的 mimetype（最明确），再 OOXML 的特征部件。
 */
export async function sniffZipContainer(container: ContainerAccess, name = ''): Promise<SniffResult | null> {
  const ext = extensionOf(name);
  const extSpec = formatByExtension(name);

  // --- ODF：mimetype 条目是规范强制的权威判据 ---
  if (container.has('mimetype')) {
    try {
      const mime = (await container.text('mimetype')).trim();
      const id = ODF_MIMETYPES[mime];
      if (id) {
        return {
          format: id,
          spec: formatSpec(id),
          confidence: 1,
          reason: `ZIP 内 mimetype 条目为 ${mime}`,
        };
      }
    } catch {
      /* mimetype 存在但读不出 —— 继续按其他线索判断 */
    }
  }
  // 没有 mimetype 但有 content.xml + META-INF/manifest.xml：仍是 ODF，靠扩展名细分
  if (!container.has('mimetype') && container.has('content.xml') && container.has('META-INF/manifest.xml')) {
    const id = extSpec && extSpec.family === 'odf' ? extSpec.id : 'odt';
    return {
      format: id,
      spec: formatSpec(id),
      confidence: 0.75,
      reason: `ZIP 内含 content.xml 与 META-INF/manifest.xml，按扩展名判定为 ${id}`,
    };
  }

  // --- OOXML：特征部件 ---
  const ooxmlMarkers: Array<{ marker: string; base: FormatId; macro: FormatId }> = [
    { marker: 'word/document.xml', base: 'docx', macro: 'docm' },
    { marker: 'xl/workbook.xml', base: 'xlsx', macro: 'xlsm' },
    { marker: 'ppt/presentation.xml', base: 'pptx', macro: 'pptm' },
  ];
  for (const m of ooxmlMarkers) {
    if (!container.has(m.marker)) continue;
    // 有 vbaProject.bin 说明含宏 —— 这与扩展名一致时优先用扩展名
    const hasMacro = container.entryNames.some((n) => /vbaProject\.bin$/i.test(n));
    let id: FormatId = m.base;
    if (hasMacro) id = m.macro;
    // 扩展名更具体时（模板/加载项）尊重扩展名
    if (extSpec && extSpec.family === 'ooxml' && extSpec.id !== m.base && extSpec.id !== m.macro) id = extSpec.id;
    else if (extSpec && (extSpec.id === m.base || extSpec.id === m.macro)) id = extSpec.id;
    return {
      format: id,
      spec: formatSpec(id),
      confidence: 1,
      reason: `ZIP 内含 ${m.marker}${hasMacro ? '，且含 vbaProject.bin（宏）' : ''}`,
    };
  }

  // --- EPUB ---
  if (container.has('META-INF/container.xml')) {
    return { format: 'epub', spec: formatSpec('epub'), confidence: 0.9, reason: 'ZIP 内含 META-INF/container.xml' };
  }

  // --- 是 ZIP 但不是已知文档格式 ---
  if (extSpec && extSpec.container === 'zip') {
    return { format: extSpec.id, spec: extSpec, confidence: 0.4, reason: `ZIP 结构未命中已知部件，按扩展名 .${ext} 判定` };
  }
  return null;
}

/** 文本启发式判定 */
function sniffTextHeuristic(head: Uint8Array, name: string): SniffResult | null {
  const text = decodeHead(head);
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  const lower = trimmed.slice(0, 2048).toLowerCase();

  if (/^<!doctype\s+html/.test(lower) || /^<html[\s>]/.test(lower)) {
    return { format: 'html', spec: formatSpec('html'), confidence: 0.9, reason: '内容以 HTML 文档类型或 <html> 开头' };
  }
  if (/^<svg[\s>]/.test(lower)) {
    return { format: 'svg', spec: formatSpec('svg'), confidence: 0.9, reason: '内容以 <svg> 开头' };
  }
  if (/^\{\\rtf/.test(trimmed)) {
    return { format: 'rtf', spec: formatSpec('rtf'), confidence: 0.99, reason: '内容以 RTF 头 {\\rtf 开头' };
  }
  if (/^<\?xml/.test(trimmed)) {
    // 可能是 fodt/fods/fodp（扁平 ODF），或 svg，或普通 xml
    const office = /<office:document[^>]*office:mimetype="([^"]+)"/.exec(trimmed.slice(0, 4096));
    if (office) {
      // 扁平 ODF 必须映射到 **flat** 变体（fodt/fods/fodp），不能复用 zip 版的表 ——
      // 那会把 .fodt 报成 .odt，用户看到的格式标签就是错的。
      const extSpec0 = formatByExtension(name);
      const flatMap: Record<string, FormatId> = {
        'application/vnd.oasis.opendocument.text': 'fodt',
        'application/vnd.oasis.opendocument.spreadsheet': 'fods',
        'application/vnd.oasis.opendocument.presentation': 'fodp',
        'application/vnd.oasis.opendocument.graphics': 'odg',
      };
      const id =
        extSpec0 && (extSpec0.id === 'fodt' || extSpec0.id === 'fods' || extSpec0.id === 'fodp')
          ? extSpec0.id
          : flatMap[office[1]];
      if (id) {
        return { format: id, spec: formatSpec(id), confidence: 0.95, reason: `扁平 ODF：office:mimetype=${office[1]}` };
      }
    }
    if (/<svg[\s>]/.test(trimmed.slice(0, 4096))) {
      return { format: 'svg', spec: formatSpec('svg'), confidence: 0.85, reason: 'XML 文档根为 <svg>' };
    }
    const extSpec = formatByExtension(name);
    if (extSpec && extSpec.container === 'plain' && extSpec.id !== 'unknown') {
      return { format: extSpec.id, spec: extSpec, confidence: 0.6, reason: `XML 文档，按扩展名 .${extensionOf(name)} 判定` };
    }
    return { format: 'xml', spec: formatSpec('xml'), confidence: 0.7, reason: '内容以 <?xml 开头' };
  }
  if (/^[[{]/.test(trimmed)) {
    // 只有在**完整解析成功**时才敢认定 JSON。
    // 早期版本只看「以 { 开头」就判 JSON，结果把 dump 出来的 .txt 也标成 JSON ——
    // 用户看到的格式徽标与实际不符，比不识别更糟。
    const sample = trimmed.slice(0, Math.min(trimmed.length, 256 * 1024));
    try {
      JSON.parse(sample);
      return { format: 'json', spec: formatSpec('json'), confidence: 0.85, reason: '内容完整解析为 JSON' };
    } catch {
      // 解析失败：若扩展名明确是 JSON 家族则尊重扩展名（可能只是我们只看到了文件头）
      const extSpec = formatByExtension(name);
      if (extSpec?.id === 'json') {
        return { format: 'json', spec: extSpec, confidence: 0.7, reason: `内容以 { 或 [ 开头，按扩展名 .${extensionOf(name)} 判定为 JSON` };
      }
    }
  }

  // CSV/TSV：分隔符在多数行里出现次数一致
  const delim = sniffDelimiter(text);
  if (delim) {
    const id: FormatId = delim.delimiter === '\t' ? 'tsv' : 'csv';
    return {
      format: id,
      spec: formatSpec(id),
      confidence: delim.confidence,
      reason: `检测到${delim.delimiter === '\t' ? '制表符' : '逗号'}分隔的表格结构（约 ${delim.columns} 列 / ${delim.rows} 行）`,
    };
  }

  // Markdown：标题/列表/围栏代码块等标记
  const mdHits = countMarkdownSignals(text);
  if (mdHits.score >= 2) {
    return { format: 'md', spec: formatSpec('md'), confidence: 0.6, reason: `检测到 Markdown 标记（${mdHits.detail}）` };
  }

  return null;
}

function decodeHead(head: Uint8Array): string {
  let start = 0;
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) start = 3;
  return new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(start));
}

/**
 * 分隔符探测。
 * 判据不是「有没有逗号」，而是「各项列数是否稳定」——
 * 否则一篇带逗号的散文会被误判成 CSV。
 */
export function sniffDelimiter(text: string): { delimiter: string; columns: number; rows: number; confidence: number } | null {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const sample = lines.slice(0, 20);

  let best: { delimiter: string; columns: number; rows: number; confidence: number } | null = null;
  for (const delimiter of [',', '\t', ';', '|']) {
    const counts = sample.map((l) => countOutsideQuotes(l, delimiter));
    const expected = counts[0];
    if (expected === 0) continue;
    const consistent = counts.filter((c) => c === expected).length;
    const ratio = consistent / sample.length;
    // 列数稳定性是核心判据；同时要求不是纯粹的「每行一个分隔符」的散文
    if (ratio < 0.8) continue;
    const confidence = Math.min(0.85, 0.35 + ratio * 0.4 + Math.min(expected, 8) * 0.03);
    if (!best || confidence > best.confidence) {
      best = { delimiter, columns: expected + 1, rows: lines.length, confidence };
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let n = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === delimiter && !inQuotes) n++;
  }
  return n;
}

function countMarkdownSignals(text: string): { score: number; detail: string } {
  const head = text.slice(0, 8192);
  const hits: string[] = [];
  if (/^#{1,6}\s+\S/m.test(head)) hits.push('标题');
  if (/^\s*[-*+]\s+\S/m.test(head)) hits.push('无序列表');
  if (/^\s*\d+\.\s+\S/m.test(head)) hits.push('有序列表');
  if (/```/.test(head)) hits.push('围栏代码块');
  if (/^\s*>\s+\S/m.test(head)) hits.push('引用');
  if (/\[[^\]]+\]\([^)]+\)/.test(head)) hits.push('链接');
  if (/^\s*\|.*\|\s*$/m.test(head)) hits.push('表格');
  return { score: hits.length, detail: hits.join('、') };
}

/** 二进制还是文本（用于未知格式的兜底显示） */
export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8192);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = head[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return n > 0 && control / n > 0.1;
}

/**
 * 主嗅探入口。head 通常只需要前若干字节，但 ZIP 判定需要容器，
 * 所以调用方若已打开容器应传入 options.container。
 */
export async function sniffFormat(bytes: Uint8Array, name = '', options: SniffOptions = {}): Promise<SniffResult> {
  const extSpec = formatByExtension(name);
  const mimeSpec = options.mime ? formatByMime(options.mime) : undefined;

  // 1. OLE2（Office 97-2003 二进制复合文档）
  if (startsWith(bytes, OLE2_MAGIC)) {
    const id = sniffOle2(bytes, extSpec?.id);
    return {
      format: id,
      spec: formatSpec(id),
      confidence: 0.95,
      reason: 'OLE2 复合文档魔数（Office 97-2003 旧版二进制格式）',
    };
  }

  // 2. PDF
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { format: 'pdf', spec: formatSpec('pdf'), confidence: 1, reason: `内容以 ${ascii(bytes, 0, 5)} 开头` };
  }

  // 3. ZIP 家族
  if (ZIP_MAGICS.some((m) => startsWith(bytes, m))) {
    if (options.container) {
      const hit = await sniffZipContainer(options.container, name);
      if (hit) return hit;
    }
    if (extSpec && extSpec.container === 'zip') {
      return { format: extSpec.id, spec: extSpec, confidence: 0.5, reason: `ZIP 结构，按扩展名 .${extensionOf(name)} 判定` };
    }
    // 未打开容器且扩展名无用：如果头部恰好能看到 [Content_Types].xml 就据此判定
    const probe = await sniffZipFromHead(bytes, name);
    if (probe) return probe;
  }

  // 4. 文本启发式
  const text = sniffTextHeuristic(bytes, name);
  if (text) return text;

  // 5. 扩展名兜底
  if (extSpec && extSpec.id !== 'unknown') {
    return { format: extSpec.id, spec: extSpec, confidence: 0.3, reason: `内容无明确特征，按扩展名 .${extensionOf(name)} 判定` };
  }
  if (mimeSpec && mimeSpec.id !== 'unknown') {
    return { format: mimeSpec.id, spec: mimeSpec, confidence: 0.3, reason: `按提供的 MIME 类型 ${options.mime} 判定` };
  }

  if (looksBinary(bytes)) {
    return { format: 'unknown', spec: formatSpec('unknown'), confidence: 0.5, reason: '未识别的二进制内容' };
  }
  return { format: 'txt', spec: formatSpec('txt'), confidence: 0.3, reason: '按纯文本处理' };
}

/**
 * 没有容器对象时，从文件头里粗暴找特征字符串。
 * ZIP 的 [Content_Types].xml 通常在最前面且未压缩或压缩率低，
 * 但压缩后字符串会消失 —— 因此只作尽力而为，不做承诺。
 */
async function sniffZipFromHead(bytes: Uint8Array, name: string): Promise<SniffResult | null> {
  const headText = ascii(bytes.subarray(0, Math.min(bytes.length, 65536)), 0, Math.min(bytes.length, 65536));
  const checks: Array<[string, FormatId]> = [
    ['word/document.xml', 'docx'],
    ['xl/workbook.xml', 'xlsx'],
    ['ppt/presentation.xml', 'pptx'],
  ];
  for (const [marker, id] of checks) {
    if (headText.includes(marker)) {
      return { format: id, spec: formatSpec(id), confidence: 0.6, reason: '文件头中出现 OOXML 特征部件名' };
    }
  }
  return null;
}

/** 在 OLE2 里按扩展名或内部流名区分 doc/xls/ppt */
function sniffOle2(bytes: Uint8Array, extId: FormatId | undefined): FormatId {
  if (extId === 'ole2-doc' || extId === 'ole2-xls' || extId === 'ole2-ppt') return extId;
  const headText = ascii(bytes.subarray(0, Math.min(bytes.length, 16384)), 0, Math.min(bytes.length, 16384));
  if (headText.includes('WordDocument')) return 'ole2-doc';
  if (headText.includes('Workbook') || headText.includes('Book')) return 'ole2-xls';
  if (headText.includes('PowerPoint')) return 'ole2-ppt';
  return 'ole2-doc';
}

/** 供 UI 展示：我们能打开的全部扩展名（含尚未安装读取器的） */
export function declaredFormats(): readonly FormatSpec[] {
  return FORMATS;
}
