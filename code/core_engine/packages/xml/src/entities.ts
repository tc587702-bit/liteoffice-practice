/**
 * XML 实体解码。
 *
 * 设计取舍：不做通用命名字典（HTML 有 2000+ 实体，XML 只预定义 5 个）。
 * 遇到未知实体保持原样输出，而不是抛错 —— 真实世界的 OOXML/ODF 里
 * 偶尔会出现未声明实体，报错会让整个文档打不开，这不符合「能打开」的优先级。
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/**
 * 解码字符串中的实体引用。
 * 只有在确实存在 '&' 时才有额外开销，因此对绝大多数文本块是零成本。
 */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const amp = s.indexOf('&', i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    const semi = s.indexOf(';', amp + 1);
    // 实体最长形如 &#x10FFFF; （10 字符）；超出范围视为普通文本
    if (semi < 0 || semi - amp > 12) {
      out += s.slice(i, amp + 1);
      i = amp + 1;
      continue;
    }
    const body = s.slice(amp + 1, semi);
    out += s.slice(i, amp);
    if (body.charCodeAt(0) === 35 /* # */) {
      const isHex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88; /* x | X */
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      out += Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : `&${body};`;
    } else {
      const named = NAMED[body];
      out += named !== undefined ? named : `&${body};`;
    }
    i = semi + 1;
  }
  return out;
}

/** 转义为 XML 文本节点内容。 */
export function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** 转义为 XML 属性值。 */
export function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
