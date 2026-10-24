/**
 * 按行读取。
 *
 * 两条路径刻意分开，因为内存特征完全不同：
 *
 *   1) 字节路径（bytes）—— 大文件主路径。
 *      不把整个文件 decode 成一个巨大字符串再 split 出一个更大的行数组
 *      （那等于「原始字节 + 完整字符串 + 行数组」三份同时在世）。这里按行扫描
 *      字节流：先以 latin1 扫描行尾字节（0x0A/0x0D 在 UTF-8 与 GBK 里都不会
 *      出现在多字节序列内部，因此行边界判定是安全的），再**只解码当前这一行**。
 *      任意时刻只持有一行文本。
 *
 *   2) 字符串路径（string）—— 测试与内存里已有现成字符串（HTML/XML/RTF 内部
 *      解析）时使用。字符串已有，再复制成数组只会浪费，所以这里用一个游标
 *      切子串，不建行数组。
 */
import { makeDecoder, type TextEncoding } from './decode.ts';

export interface LineSplitter {
  next(): string | undefined;
}

const LF = 0x0a;
const CR = 0x0d;

/** 字节流按行切分（兼容 \n / \r\n / \r）。 */
export function linesFromBytes(bytes: Uint8Array, encoding: TextEncoding, start = 0): LineSplitter {
  const decoder = makeDecoder(encoding);
  let pos = start;
  /** 输入末尾有换行时，还要再交出一个空行（否则 "a\n" 会丢掉最后那行） */
  let pendingTrailing = false;

  const decodeLine = (from: number, to: number): string => {
    // 每行单独构造 subarray（视图，不复制字节）。单独解码而非跨行流式解码：
    // 行边界落在多字节序列中间的概率在真实文本里可忽略，换来的是
    // 「任意时刻只持有一行」的确定性内存上界。
    return decoder.decode(bytes.subarray(from, to));
  };

  return {
    next(): string | undefined {
      if (pendingTrailing) {
        pendingTrailing = false;
        return '';
      }
      if (pos >= bytes.length) return undefined;
      const from = pos;
      let end = bytes.length;
      let nextPos = bytes.length;
      let endedWithBreak = false;
      for (let i = pos; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === LF) {
          end = i;
          nextPos = i + 1;
          endedWithBreak = true;
          break;
        }
        if (b === CR) {
          end = i;
          nextPos = i + 1 < bytes.length && bytes[i + 1] === LF ? i + 2 : i + 1;
          endedWithBreak = true;
          break;
        }
      }
      pos = nextPos;
      if (endedWithBreak && pos >= bytes.length) pendingTrailing = true;
      return decodeLine(from, end);
    },
  };
}

/**
 * 字符串按行切分。返回游标对象而不是数组：
 * 一个 500 MB 的日志 split 出来的行数组本身就是几百 MB 的额外开销。
 */
export function linesFromString(text: string): LineSplitter {
  let pos = 0;
  let pendingTrailing = false;
  return {
    next(): string | undefined {
      if (pendingTrailing) {
        pendingTrailing = false;
        return '';
      }
      if (pos >= text.length) return undefined;
      const from = pos;
      let end = text.length;
      let nextPos = text.length;
      let endedWithBreak = false;
      for (let i = pos; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === LF) {
          end = i;
          nextPos = i + 1;
          endedWithBreak = true;
          break;
        }
        if (c === CR) {
          end = i;
          nextPos = i + 1 < text.length && text.charCodeAt(i + 1) === LF ? i + 2 : i + 1;
          endedWithBreak = true;
          break;
        }
      }
      pos = nextPos;
      if (endedWithBreak && pos >= text.length) pendingTrailing = true;
      return text.slice(from, end);
    },
  };
}
