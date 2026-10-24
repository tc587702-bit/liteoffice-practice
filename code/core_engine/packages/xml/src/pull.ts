/**
 * XmlPullParser —— 低分配、可流式喂料的 XML 拉取解析器。
 *
 * 为什么不用 DOMParser / xmldom：
 *   DOMParser 为每个节点建对象树。10 万行的 xlsx sheet.xml 展开后常驻内存可达
 *   上百 MB，且必须先把整个文档驻留成字符串。LiteOffice 的硬指标是「峰值内存不随
 *   文档体积线性增长」，所以这里做两件事：
 *     1) 只保留当前解码窗口，已消费部分随时丢弃
 *     2) 调用方按事件拉取，可 skipElement() 整棵子树跳过，压根不建节点
 *
 * 窗口模型（这是本文件最容易写错的地方，实现时已踩过坑）：
 *   - buf 是解码后的字符串窗口，pos 是窗口内游标
 *   - pump() 只**追加**解码数据，绝不位移已有索引 —— 因此扫描过程中可以安全补料
 *   - compact() 只在 next() 入口、且无活跃局部索引时调用，用于丢弃已消费前缀
 *   早期版本在标签扫描中途重置 pos，导致跨块边界的标签解析错位；现已禁止。
 *
 * 名字空间策略：保留 qname（"w:p"）并拆出 prefix/local 便于匹配。不做事先的
 * 名字空间解析 —— OOXML/ODF 解析几乎总是按 qname 或 local 直查，维护前缀表
 * 只增加内存与出错面。
 */
import { decodeEntities } from './entities.ts';

export type XmlEventType = 'start' | 'end' | 'text' | 'cdata' | 'pi' | 'comment' | 'doctype';

export interface XmlEvent {
  type: XmlEventType;
  /** 限定名，如 "w:p"。text/comment/pi 事件下为 "" */
  name: string;
  /** 本地名，如 "p" */
  local: string;
  /** 前缀，如 "w"；无前缀为 "" */
  prefix: string;
  /** start 事件的属性（已实体解码）。无属性时为 null */
  attrs: Record<string, string> | null;
  /** start 事件是否为自闭合 <x/> */
  selfClosing: boolean;
  /** text / cdata / comment / pi 的内容 */
  text: string;
}

export interface XmlParserOptions {
  /**
   * 是否保留纯空白文本节点。默认 false（丢弃）：OOXML 的格式化缩进会产生大量
   * 无意义空白节点。只有「整段皆为空白」的文本才会被丢弃，
   * w:t / text:p 等承载内容的文本不受影响。
   */
  keepWhitespace?: boolean;
  /** 每次解码的字节数，默认 64 KiB。越小峰值内存越低、解码调用越频繁。 */
  chunkSize?: number;
  /** 触发窗口压缩的已消费字符数阈值，默认 8192。 */
  compactThreshold?: number;
}

export class XmlError extends Error {
  readonly pos: number;

  constructor(message: string, pos: number) {
    super(`${message}（缓冲区偏移 ${pos}）`);
    this.name = 'XmlError';
    this.pos = pos;
  }
}

const utf8 = new TextDecoder('utf-8');

function blankEvent(): XmlEvent {
  return { type: 'text', name: '', local: '', prefix: '', attrs: null, selfClosing: false, text: '' };
}

export class XmlPullParser {
  private buf: string;
  private pos = 0;
  private readonly bytes: Uint8Array | null;
  private bytePos = 0;
  private readonly opts: Required<XmlParserOptions>;
  private skipDepth = 0;
  /** 已消费字符数，用于报错定位与诊断 */
  private consumed = 0;
  /**
   * 上一次 next() 返回的 start 事件是否为自闭合。
   *
   * 存在理由：`skipElement()` 的契约是「在非自闭合 start 之后调用」，但对
   * **自闭合**元素调用它是个致命陷阱 —— 自闭合元素没有结束标签，深度计数永远
   * 回不到 0，于是它会一路吞掉后面所有兄弟与祖先内容，表现为「文档后半部分凭空消失」。
   *
   * 真实案例：HTML 读取器对 `<img/>` 调用 skipElement，
   * `<p>a<img1><img2></p>` 里 img1 之后的内容全部消失。
   * 这类错误极难从症状反推原因，所以在解析器里直接消灭它：见 skipElement()。
   */
  private lastStartSelfClosing = false;

  constructor(input: Uint8Array | string, options: XmlParserOptions = {}) {
    this.opts = {
      keepWhitespace: options.keepWhitespace ?? false,
      chunkSize: options.chunkSize ?? 65536,
      compactThreshold: options.compactThreshold ?? 8192,
    };
    if (typeof input === 'string') {
      this.buf = input;
      this.bytes = null;
    } else {
      this.bytes = input;
      this.buf = '';
      this.pump();
    }
  }

  get offset(): number {
    return this.consumed + this.pos;
  }

  /** 解码下一块字节并**追加**到窗口。返回是否有数据被追加。 */
  private pump(): boolean {
    if (!this.bytes || this.bytePos >= this.bytes.length) return false;
    const end = Math.min(this.bytePos + this.opts.chunkSize, this.bytes.length);
    this.buf += utf8.decode(this.bytes.subarray(this.bytePos, end), { stream: end < this.bytes.length });
    this.bytePos = end;
    return true;
  }

  /** 丢弃窗口内已消费的前缀。只能在无活跃局部索引时调用（即 next() 入口）。 */
  private compact(): void {
    if (this.pos >= this.opts.compactThreshold) {
      this.buf = this.buf.slice(this.pos);
      this.consumed += this.pos;
      this.pos = 0;
    }
  }

  /** 保证窗口内至少有 pos + n 个字符可用。 */
  private ensure(n: number): boolean {
    while (this.buf.length - this.pos < n) {
      if (!this.pump()) return false;
    }
    return true;
  }

  /** 在 pos 之后查找字符，必要时补料。返回 -1 表示直到文档结束都没找到。 */
  private findFrom(ch: string, from: number): number {
    for (;;) {
      const idx = this.buf.indexOf(ch, from);
      if (idx >= 0) return idx;
      if (!this.pump()) return -1;
    }
  }

  private findSeq(seq: string, from: number): number {
    for (;;) {
      const idx = this.buf.indexOf(seq, from);
      if (idx >= 0) return idx;
      if (!this.pump()) return -1;
    }
  }

  /**
   * 找到起始标签的结束 '>'，跳过引号内的内容。
   * 这样属性值里出现 '>'（完全合法）不会被误判为标签结束。
   */
  private findTagEnd(from: number): number {
    let i = from;
    let quote = -1;
    for (;;) {
      if (i >= this.buf.length) {
        if (!this.pump()) return -1;
        continue;
      }
      const c = this.buf.charCodeAt(i);
      if (quote >= 0) {
        if (c === quote) quote = -1;
      } else if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 62 /* > */) {
        return i;
      }
      i++;
    }
  }

  /** 在 pos 处匹配一个固定前缀，必要时补料。 */
  private hasPrefix(seq: string): boolean {
    if (!this.ensure(seq.length)) return false;
    return this.buf.startsWith(seq, this.pos);
  }

  next(): XmlEvent | null {
    this.compact();

    for (;;) {
      if (this.pos >= this.buf.length && !this.pump()) return null;

      const lt = this.findFrom('<', this.pos);
      if (lt < 0) {
        // 到文档结束都没有 '<'：剩余全是文本
        const text = this.buf.slice(this.pos);
        this.pos = this.buf.length;
        if (!text) return null;
        if (!this.opts.keepWhitespace && text.trim() === '') continue;
        return { ...blankEvent(), type: 'text', text: decodeEntities(text) };
      }
      if (lt > this.pos) {
        const text = this.buf.slice(this.pos, lt);
        this.pos = lt;
        if (!this.opts.keepWhitespace && text.trim() === '') continue;
        return { ...blankEvent(), type: 'text', text: decodeEntities(text) };
      }

      // 此处 buf[this.pos] === '<'
      if (!this.ensure(2)) throw new XmlError('文档在标签中途结束', this.pos);
      const c1 = this.buf.charCodeAt(this.pos + 1);

      if (c1 === 33 /* ! */) {
        if (this.hasPrefix('<!--')) {
          const end = this.findSeq('-->', this.pos + 4);
          if (end < 0) throw new XmlError('注释未闭合', this.pos);
          const text = this.buf.slice(this.pos + 4, end);
          this.pos = end + 3;
          if (this.skipDepth > 0) continue;
          return { ...blankEvent(), type: 'comment', text };
        }
        if (this.hasPrefix('<![CDATA[')) {
          const end = this.findSeq(']]>', this.pos + 9);
          if (end < 0) throw new XmlError('CDATA 未闭合', this.pos);
          const text = this.buf.slice(this.pos + 9, end);
          this.pos = end + 3;
          if (this.skipDepth > 0) continue;
          return { ...blankEvent(), type: 'cdata', text };
        }
        // <!DOCTYPE ...>：按方括号嵌套深度跳过，支持内部子集
        let depth = 0;
        let j = this.pos + 2;
        for (;;) {
          if (j >= this.buf.length) {
            if (!this.pump()) throw new XmlError('DOCTYPE 未闭合', this.pos);
            continue;
          }
          const ch = this.buf.charCodeAt(j);
          if (ch === 91 /* [ */) depth++;
          else if (ch === 93 /* ] */) depth--;
          else if (ch === 62 /* > */ && depth <= 0) break;
          j++;
        }
        const text = this.buf.slice(this.pos + 2, j);
        this.pos = j + 1;
        if (this.skipDepth > 0) continue;
        return { ...blankEvent(), type: 'doctype', text };
      }

      if (c1 === 63 /* ? */) {
        const end = this.findSeq('?>', this.pos + 2);
        if (end < 0) throw new XmlError('处理指令未闭合', this.pos);
        const text = this.buf.slice(this.pos + 2, end);
        this.pos = end + 2;
        if (this.skipDepth > 0) continue;
        return { ...blankEvent(), type: 'pi', text };
      }

      if (c1 === 47 /* / */) {
        const gt = this.findFrom('>', this.pos + 2);
        if (gt < 0) throw new XmlError('结束标签未闭合', this.pos);
        const name = this.buf.slice(this.pos + 2, gt).trim();
        this.pos = gt + 1;
        if (this.skipDepth > 0) {
          this.skipDepth--;
          // 跳过完成时立刻交回控制权，**绝不再读下一个事件**。
          //
          // 这里曾经是 `continue`，会导致 skipElement() 多吞掉紧随其后的一个事件
          // （例如跳过 <w:rPr> 时把 </w:lvl> 也吃掉），从而让调用方的层级计数错乱、
          // 后续兄弟元素被整棵跳过。真实 docx 的 numbering.xml 就因此丢了 4/9 个编号定义。
          if (this.skipDepth === 0) return null;
          continue;
        }
        const { prefix, local } = splitName(name);
        return { ...blankEvent(), type: 'end', name, prefix, local };
      }

      // <start ...> / <start .../>
      const gt = this.findTagEnd(this.pos + 1);
      if (gt < 0) throw new XmlError('起始标签未闭合', this.pos);
      const tag = this.scanStartTag(this.pos + 1, gt);
      this.pos = gt + 1;
      if (this.skipDepth > 0) {
        if (!tag.selfClosing) this.skipDepth++;
        continue;
      }
      const { prefix, local } = splitName(tag.name);
      this.lastStartSelfClosing = tag.selfClosing;
      return {
        ...blankEvent(),
        type: 'start',
        name: tag.name,
        prefix,
        local,
        attrs: tag.attrs,
        selfClosing: tag.selfClosing,
      };
    }

    // 文档在跳过过程中结束（畸形文件）：静默收尾而不是抛错。
    // 本项目「能打开优先于严格校验」，一个未闭合的标签不应让整篇文档打不开。
    if (this.skipDepth > 0) this.skipDepth = 0;
    return null;
  }

  /**
   * 跳过当前元素的整棵子树（含自身结束标签）。
   *
   * 必须在 next() 返回 start 且 selfClosing === false 之后调用。
   * 这是低内存的关键 API：跳过期间 next() 不产出事件、不分配事件对象，
   * 因此整棵子树（可能上千个节点）的代价只是线性扫描字符。
   *
   * 返回值语义的坑（踩过，且很难从现象反推）：
   *   **循环里最后那次 next() 会返回 null** —— 这正是「跳过完成」的信号。
   *   因此调用方若在 `while ((e = next()) !== null) { ... skipElement() ... }`
   *   里跳过了**根元素**，外层循环会立刻结束（真实 pptx 就是这样全变成空页的）。
   *   同一层级里连续跳过多个兄弟元素不受影响：每次 skipElement() 之后
   *   调用方再调一次 next() 就能拿到下一个兄弟。
   *
   * 另一个坑：`skipDepth` 必须在**每次调用开头**清零。它此前只在正常返回时
   *   被置 0；如果上一次跳过是「文档提前结束」而收尾，残留的深度会让下一次
   *   跳过立刻认为已经跳完，表现为「同一层里第二个兄弟元素读不到」。
   */
  skipElement(): void {
    // 自闭合元素：没有子树也没有结束标签，照常进入跳过模式会吞掉文档剩余部分。
    // 这里做成安全 no-op，让「不小心对 <img/> 调用 skipElement」不再有破坏性。
    if (this.lastStartSelfClosing) {
      this.lastStartSelfClosing = false;
      return;
    }
    this.skipDepth = 1;
    // next() 在跳过完成时返回 null，所以循环退出即表示跳过结束（或文档结束）。
    while (this.next() !== null) {
      /* 空转 */
    }
    this.skipDepth = 0;
  }

  /** 在 [start, gt) 区间内解析起始标签。调用方保证整段已在窗口内。 */
  private scanStartTag(start: number, gt: number): { name: string; attrs: Record<string, string> | null; selfClosing: boolean } {
    // 名字一直读到空白或 '/' 为止。
    // 早期版本把 nameEnd 取成了整个标签末尾，导致带属性的元素名字里混进属性文本
    // （例如 "w:t xml:space=\"preserve\""），进而让名字匹配全部失效。
    let nameEnd = start;
    while (nameEnd < gt) {
      const c = this.buf.charCodeAt(nameEnd);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47 /* / */) break;
      nameEnd++;
    }
    const name = this.buf.slice(start, nameEnd);

    const selfClosing = this.buf.charCodeAt(gt - 1) === 47 /* / */;
    let attrs: Record<string, string> | null = null;
    let p = nameEnd;
    const limit = selfClosing ? gt - 1 : gt;

    while (p < limit) {
      while (p < limit) {
        const c = this.buf.charCodeAt(p);
        if (c === 32 || c === 9 || c === 10 || c === 13) p++;
        else break;
      }
      if (p >= limit) break;
      const aStart = p;
      while (p < limit) {
        const c = this.buf.charCodeAt(p);
        if (c === 61 || c === 32 || c === 9 || c === 10 || c === 13) break;
        p++;
      }
      const aName = this.buf.slice(aStart, p);
      while (p < limit) {
        const c = this.buf.charCodeAt(p);
        if (c === 32 || c === 9 || c === 10 || c === 13) p++;
        else break;
      }
      if (!aName) {
        p++;
        continue;
      }
      if (p < limit && this.buf.charCodeAt(p) === 61 /* = */) {
        p++;
        while (p < limit) {
          const c = this.buf.charCodeAt(p);
          if (c === 32 || c === 9 || c === 10 || c === 13) p++;
          else break;
        }
        const q = p < limit ? this.buf.charCodeAt(p) : -1;
        let value: string;
        if (q === 34 || q === 39) {
          const close = this.buf.indexOf(String.fromCharCode(q), p + 1);
          const end = close >= 0 && close <= limit ? close : limit;
          value = this.buf.slice(p + 1, end);
          p = end + 1;
        } else {
          const vStart = p;
          while (p < limit) {
            const c = this.buf.charCodeAt(p);
            if (c === 32 || c === 9 || c === 10 || c === 13) break;
            p++;
          }
          value = this.buf.slice(vStart, p);
        }
        attrs ??= {};
        attrs[aName] = decodeEntities(value);
      } else {
        attrs ??= {};
        attrs[aName] = '';
      }
    }
    return { name, attrs, selfClosing };
  }

  private trimEnd(end: number): number {
    let i = end;
    while (i > 0) {
      const c = this.buf.charCodeAt(i - 1);
      if (c === 32 || c === 9 || c === 10 || c === 13) i--;
      else break;
    }
    return i;
  }
}
export function splitName(name: string): { prefix: string; local: string } {
  const c = name.indexOf(':');
  return c < 0 ? { prefix: '', local: name } : { prefix: name.slice(0, c), local: name.slice(c + 1) };
}

/**
 * 事件驱动遍历。访问器可以对 start 事件调用 parser.skipElement() 跳过整棵子树
 * —— 这是恒定额外内存的遍历方式，也是格式读取器的主要工作模式。
 */
export function walkXml(
  input: Uint8Array | string,
  visit: (e: XmlEvent, parser: XmlPullParser) => void,
  options?: XmlParserOptions,
): void {
  const p = new XmlPullParser(input, options);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) visit(e, p);
}

/**
 * 取第一个按路径匹配的元素的文本内容；找不到返回 null。
 *
 * 匹配语义是**祖先链**而非严格直系子节点：路径段依次对应祖先链上的名字即可。
 * 例如 `document/body/p/t` 能匹配 `<w:document><w:body><w:p><w:r><w:t>…`，
 * 中间的 `w:r` 被忽略。这是解析 OOXML/ODF 时真正需要的语义 —— 层级里总有
 * 大量可选包装元素（pPr/rPr/proofErr/…），严格直系匹配会几乎全部落空。
 *
 * 路径段可以是 qname（"w:p"）或本地名（"p"）。
 */
export function xmlTextAt(input: Uint8Array | string, path: string): string | null {
  const segs = path.split('/').filter(Boolean);
  const p = new XmlPullParser(input);
  const stack: boolean[] = [];
  let matched = 0;
  let collectFrom = -1; // 目标元素所在的栈深度（1-based）
  let acc = '';

  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') {
      const onPath = matched < segs.length && matchesSeg(e, segs[matched]);
      if (onPath) matched++;
      if (e.selfClosing) {
        if (onPath && matched === segs.length) return '';
        if (onPath) matched--;
        continue;
      }
      stack.push(onPath);
      if (onPath && matched === segs.length && collectFrom < 0) collectFrom = stack.length;
    } else if (e.type === 'end') {
      const top = stack.pop();
      if (top) matched--;
      if (collectFrom >= 0 && stack.length < collectFrom) return acc;
    } else if (collectFrom >= 0 && (e.type === 'text' || e.type === 'cdata')) {
      acc += e.text;
    }
  }
  return null;
}

function matchesSeg(e: XmlEvent, seg: string): boolean {
  return seg.indexOf(':') < 0 ? e.local === seg : e.name === seg;
}

/**
 * 生成器：产出所有匹配元素的 **start 事件**。
 * 注意：生成器恢复执行时 parser 会继续前进，因此不要在下游再调用 skipElement；
 * 需要控制子树请改用 walkXml。
 */
export function* eachElement(
  input: Uint8Array | string,
  matcher: string | ((e: XmlEvent) => boolean),
  options?: XmlParserOptions,
): Generator<XmlEvent> {
  const p = new XmlPullParser(input, options);
  const match = typeof matcher === 'string' ? (e: XmlEvent) => e.local === matcher || e.name === matcher : matcher;
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'start' && match(e) && !e.selfClosing) {
      yield e;
      p.skipElement();
    }
  }
}
