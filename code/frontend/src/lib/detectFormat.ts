import type { DocFormat } from './types';

/**
 * 格式识别。
 *
 * 为什么不只看扩展名：扩展名是**用户可改的**，改错了就会把 xlsx 当 docx 塞给编辑器，
 * 报错信息会非常难懂（"文件损坏"而不是"你改错了后缀"）。
 * 所以这里做两层：
 *   1. 看扩展名 → 得到"声称的格式"
 *   2. 看文件头 → docx/xlsx/pptx 都是 ZIP，必须 PK\x03\x04 开头
 * 两者冲突时以**文件头**为准，并把提示交给调用方去显示。
 *
 * 局限（已知）：真正的 docx/xlsx/pptx 区分需要读 ZIP 里的
 * `word/`、`xl/`、`ppt/` 目录，那要一个 ZIP 解析器。本项目 5 天内不做，
 * 因此"扩展名说是 docx 但其实是 xlsx"这种情况识别不出来 —— 但至少能拦住
 * "把 PDF 改成 docx"这种改后缀的误操作。
 */

const KNOWN: Record<string, DocFormat> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  // md 的常见后缀：GitHub 用 .md，有的编辑器存 .markdown / .mdown / .mkd
  md: 'md',
  markdown: 'md',
  mdown: 'md',
  mkd: 'md',
};

/**
 * 文本类格式：它们**不是** ZIP，所以不能套用 Office 的「必须是 PK 头」校验，
 * 而要反过来检查「不能是二进制」。
 */
const TEXT_FORMATS: ReadonlySet<DocFormat> = new Set<DocFormat>(['md']);

export function extensionOf(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 只按扩展名判断（快速路径，用于列表展示） */
export function detectByExtension(name: string): DocFormat {
  return KNOWN[extensionOf(name)] ?? 'unknown';
}

/** ZIP 文件头：PK\x03\x04 */
async function isZip(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * 文本文件的粗筛：前 8 KiB 里出现 NUL 字节就认为不是纯文本。
 *
 * 为什么用 NUL 而不是「试解码」：UTF-8 / GBK / UTF-16 三种编码解出来的字节都不含
 * 0x00（UTF-16 除外，但它有 BOM，解码器自己会认）。所以 NUL 是「这是二进制」的
 * 高置信信号，且不需要猜编码。真正的编码判定留给 decodeText.ts。
 */
async function hasNulByte(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0x00) return true;
  }
  return false;
}

export interface DetectResult {
  format: DocFormat;
  /** 需要告诉用户的异常情况（例如扩名与内容不符） */
  warning?: string;
}

export async function detectFormat(file: File): Promise<DetectResult> {
  const claimed = detectByExtension(file.name);
  const ext = extensionOf(file.name);

  if (claimed === 'unknown') {
    const zip = await isZip(file);
    return {
      format: 'unknown',
      warning: zip
        ? '这是一个 ZIP 容器，但扩展名不认识。若它是 Office 文档，请把后缀改成 .docx / .xlsx / .pptx'
        : `不支持的格式：.${ext || '(无扩展名)'}，目前只支持 .docx / .xlsx / .pptx / .md`,
    };
  }

  // 文本类格式：反向检查「是不是二进制」
  if (TEXT_FORMATS.has(claimed)) {
    if (await isZip(file)) {
      return {
        format: 'unknown',
        warning: `文件扩展名是 .${ext}，但内容是 ZIP 容器（其实是 Office 文档）。请把后缀改成 .docx / .xlsx / .pptx`,
      };
    }
    if (await hasNulByte(file)) {
      return {
        format: 'unknown',
        warning: `文件扩展名是 .${ext}，但内容含二进制字节，不是纯文本。可能是改了后缀的其它文件`,
      };
    }
    return { format: claimed };
  }

  // 声称是 Office 格式，就必须真的是 ZIP
  if (!(await isZip(file))) {
    return {
      format: 'unknown',
      warning: `文件扩展名是 .${ext}，但内容不是有效的 Office 文档（不是 ZIP 容器）。可能是改了后缀的其它文件，或者文件已损坏`,
    };
  }

  return { format: claimed };
}
