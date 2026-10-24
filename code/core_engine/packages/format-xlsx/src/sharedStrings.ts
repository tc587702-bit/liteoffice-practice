/**
 * sharedStrings.xml 读取。
 *
 * 它是 xlsx 里第二大的部件（仅次于 worksheet），也是**每个字符串单元格都要查一次**的表，
 * 所以这里的取舍很关键：
 *
 *   方案 A（本实现）：流式扫描，顺序保留 `<si>`，累计到 `limits.maxStringBytes` 就**停止**，
 *     越界的索引一律返回 undefined（单元格 v 置空 + 记 truncated）。
 *   方案 B：只记每条 `<si>` 的偏移，用到时按需再解压 + 跳到该偏移。
 *     省内存（约 8 字节/条），但每次缺字符串都要重新解压整个部件；
 *     滚动浏览时表现为「越往下越卡」，而且实现复杂度高出一个量级。
 *
 * 选 A 的理由：上限本身就是「这个表还能不能正常浏览」的界线，超过它说明文件异常，
 * 此时**尽快给出可用的前半部分**比「后半部分按需慢慢补」更符合「先能打开」的目标。
 * 代价（已如实写在警告里）：越界的共享字符串在模型里是空串，不是错误文本 ——
 * 宁可显示空，也不能显示错的字符串。
 *
 * 顺带一提：`<si>` 的顺序就是 `t="s"` 单元格 `<v>` 里的索引，因此必须**严格按顺序**压入数组，
 * 中间跳过任何一个（例如遇到解析失败）都会让整表文案整体错位。
 */
import type { Run } from '../../core/src/model.ts';
import { StreamXmlScanner } from './xmlStream.ts';
import { readRichText } from './richtext.ts';

export interface SharedStrings {
  /** 实际保留下来的条目数 */
  readonly count: number;
  /** 是否因为超出字节上限而截断 */
  readonly truncated: boolean;
  /** 索引越界/被截断时返回 undefined —— 调用方必须把它当成「空」，不能当成错误文本 */
  get(index: number): string | undefined;
  rich(index: number): Run[] | undefined;
}

const EMPTY_SHARED_STRINGS: SharedStrings = {
  count: 0,
  truncated: false,
  get: () => undefined,
  rich: () => undefined,
};

export function emptySharedStrings(): SharedStrings {
  return EMPTY_SHARED_STRINGS;
}

/**
 * 流式读取共享字符串表。
 * @param open 每次调用产出一个新的部件文本流（读取器复用同一个 container）
 * @param byteBudget 累计字符串字节上限（limits.maxStringBytes）
 */
export async function loadSharedStrings(
  open: () => ReadableStream<string>,
  byteBudget: number,
  warn: (msg: string) => void,
): Promise<SharedStrings> {
  const strings: string[] = [];
  const rich: (Run[] | undefined)[] = [];
  let bytes = 0;
  let truncated = false;

  const scanner = new StreamXmlScanner(open());
  try {
    for (;;) {
      const e = await scanner.next();
      if (e === null) break;
      if (e.type !== 'start' || e.local !== 'si') continue;
      if (bytes >= byteBudget) {
        // 超限：立刻停手并取消解压，不再往下读（这是「不整块驻留」的落点）
        truncated = true;
        break;
      }
      const rt = await readRichText(scanner, e);
      strings.push(rt.text);
      rich.push(rt.runs ?? undefined);
      bytes += rt.text.length * 2 + 16; // 与 core/memory.ts 同口径的保守估算
    }
  } finally {
    await scanner.cancel();
  }

  if (truncated) {
    warn(`sharedStrings 超过 ${Math.round(byteBudget / 1048576)} MiB 上限，仅保留前 ${strings.length} 条，其余单元格文本为空`);
  }

  return {
    count: strings.length,
    truncated,
    get(index: number): string | undefined {
      if (!Number.isInteger(index) || index < 0 || index >= strings.length) return undefined;
      return strings[index];
    },
    rich(index: number): Run[] | undefined {
      if (!Number.isInteger(index) || index < 0 || index >= rich.length) return undefined;
      return rich[index];
    },
  };
}
