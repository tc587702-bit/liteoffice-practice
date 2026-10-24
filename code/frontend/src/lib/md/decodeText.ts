/**
 * 文本文件解码：UTF-8 优先，坏字节比例高时回退 GB18030。
 *
 * 为什么需要回退：旧版 Windows 记事本、不少中文工具的 `.md` 实际是 GBK/GB18030。
 * 直接按 UTF-8 解码会得到满屏 U+FFFD（�），用户会以为文件坏了 —— 这种情况在
 * 「同学发来的笔记」里非常常见。
 *
 * 判定方式不是「抛不抛错」，而是「替换字符更少的是哪个」：
 *   1. 先按 UTF-8 非致命解码，数 U+FFFD 的数量；
 *   2. 为 0 → 就是 UTF-8，直接用；
 *   3. 不为 0 → 再按 gb18030 解码，取替换字符更少的那个。
 *
 * 为什么不用 `fatal: true` 抛错判断：文件超过上限被截断时，末尾会切在多字节
 * 字符中间，fatal 解码必然失败 —— 于是整份 UTF-8 文件会被误判成 GBK。
 * 所以截断时统计坏字节要**排除末尾 4 个字符**。
 */

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface DecodedText {
  text: string;
  /** 实际采用的编码，显示在状态栏，便于排查「为什么是乱码」 */
  encoding: TextEncoding;
  /** 是否因超过字节上限被截断 */
  truncated: boolean;
}

/** 默认读取上限：4 MB 纯文本已经远超正常 md 笔记，再大多半是误拖了日志 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const UTF8 = new TextDecoder('utf-8');
const UTF16LE = new TextDecoder('utf-16le');
const UTF16BE = new TextDecoder('utf-16be');
/** gb18030 是 GBK 的超集，浏览器内置，不需要额外 CDN 或依赖 */
const GB18030 = new TextDecoder('gb18030');

/** 数替换字符。truncated 时忽略末尾 4 个字符（可能切在多字节中间） */
function badCount(text: string, truncated: boolean): number {
  const body = truncated ? text.slice(0, Math.max(0, text.length - 4)) : text;
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) === 0xfffd) n++;
  }
  return n;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 这一段字节是否**完整合法**的 UTF-8（严格模式，不产生 FFFD） */
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    UTF8_FATAL.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export async function decodeTextFile(blob: Blob, maxBytes = DEFAULT_MAX_BYTES): Promise<DecodedText> {
  const truncated = blob.size > maxBytes;
  const slice = truncated ? blob.slice(0, maxBytes) : blob;
  const bytes = new Uint8Array(await slice.arrayBuffer());

  // 有 BOM 就直接按 BOM 走，不做猜测
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: stripBom(UTF8.decode(bytes.subarray(3))), encoding: 'utf-8', truncated };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: UTF16LE.decode(bytes.subarray(2)), encoding: 'utf-16le', truncated };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: UTF16BE.decode(bytes.subarray(2)), encoding: 'utf-16be', truncated };
  }

  /*
   * 先做**严格**判断，避免「尾部被切」被误当成「不是 UTF-8」：
   *   1. 全量 fatal 解码成功 → 就是 UTF-8；
   *   2. 全量失败，但去掉末尾 1~4 字节后成功 → 只是末尾切在某个多字节字符中间，
   *      仍然是 UTF-8（UTF-8 一个字符最多 4 字节，所以最多试 4 次）；
   *   3. 全部失败 → 才考虑 GB18030。
   *
   * 为什么不能只减固定 4 字节：末尾若是 3 字节字符，减去 4 会连前一个字符也切掉一半，
   * 结果依然非法 —— 必须逐个长度试。
   * 为什么不能用 FFFD 计数：末尾切坏的 UTF-8 只产生 1 个 FFFD，
   * 而 gb18030 几乎不产生 FFFD，于是整份 UTF-8 会被"改进"成乱码。
   */
  if (isValidUtf8(bytes)) {
    return { text: stripBom(UTF8.decode(bytes)), encoding: 'utf-8', truncated };
  }
  for (let cut = 1; cut <= 4 && cut < bytes.length; cut++) {
    if (isValidUtf8(bytes.subarray(0, bytes.length - cut))) {
      return { text: stripBom(UTF8.decode(bytes)), encoding: 'utf-8', truncated };
    }
  }

  const asUtf8 = stripBom(UTF8.decode(bytes));
  try {
    const asGb = stripBom(GB18030.decode(bytes));
    // 走到这里已基本确定不是 UTF-8；再用坏字符数兜底，防止把好文件解坏
    if (badCount(asGb, truncated) < badCount(asUtf8, truncated)) {
      return { text: asGb, encoding: 'gb18030', truncated };
    }
  } catch {
    /* 浏览器不支持 gb18030 时保持 UTF-8 结果，不阻断打开 */
  }

  return { text: asUtf8, encoding: 'utf-8', truncated };
}
