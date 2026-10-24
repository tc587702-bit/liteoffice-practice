/**
 * StreamXmlScanner —— 面向「字符串分块流」的异步 XML 拉取解析器。
 *
 * 为什么不能直接用 `@liteoffice/xml` 的 XmlPullParser：
 * 它是同步的，输入必须是**整个部件的字节/字符串**。而本包的核心主张是
 * 「打开几十万行的表也不把整表物化」—— 也就是必须能对
 * `container.streamText(path)`（逐块产出）做事件流解析。
 *
 * 性能设计（这是本文件最重要的一件事）：
 *   解析器内部有一个**纯同步**的 `tryNextSync()`：只要所需字符已经在缓冲窗口里，
 *   它同步产出事件、一个 Promise 都不建；只有窗口里确实没有完整事件时才去
 *   `await` 下一块。这样每个事件的成本是「1 个 Promise」而不是「一串 Promise」。
 *
 *   为什么必须这么做：await 并不便宜。实测在 `node:test` 的 async hooks 下，
 *   一次 await 的往返约 14 µs（普通进程里约 1 µs）。早期版本每个事件要做
 *   4~6 次 await（ensure / findFrom / findTagEnd 各一次），于是同一个 5 万行
 *   工作表在测试里要 49 秒、在普通进程里只要 2.4 秒 —— 整整 20 倍。
 *   把 await 数目压到每个事件一次之后，差距缩到可接受范围。
 *
 *   同理，`skipElement()` 不复用 next()，而是自己做**字符级**深度扫描：
 *   跳过一整行 20 个 `<c>` 只需要 1 次 await（还可能一个都不需要），
 *   而不是 100 次。元数据扫描（跳过整张表的数据区）因此从 2.5 秒降到几百毫秒。
 *
 * 与 pull.ts 的两处刻意差异：
 *   1) **保留纯空白文本节点**。pull.ts 默认丢弃 `text.trim()===''` 的节点，
 *      但 `<t xml:space="preserve"> </t>` 是合法且有意义的共享字符串内容，
 *      丢了会静默给出错误文本。这里一律保留，由消费方自己 trim。
 *   2) **绝不抛错**。标签没闭合、流被截断时一律降级收尾（把剩余当文本、返回 null）。
 *
 * 产出的事件对象**结构上就是 `XmlEvent`**，所以 `@liteoffice/ooxml` 的
 * `attr` / `attrInt` / `attrBool` / `parseColor` 可以直接用在它上面。
 *
 * 内存：已消费前缀在 `next()` 入口被裁掉（compact），因此缓冲区上界是
 * 「一个块 + compactThreshold + 当前正在扫的那个标签/文本节点」，
 * **与部件总大小无关**。
 */
import { decodeEntities, splitName } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';

export interface ScannerOptions {
  /** 已消费字符数超过它就裁剪缓冲，默认 8192。越小峰值内存越低、切片越频繁。 */
  compactThreshold?: number;
}

function event(type: 'start' | 'end' | 'text', name: string, local: string, prefix: string, attrs: Record<string, string> | null, selfClosing: boolean, text: string): XmlEvent {
  return { type, name, local, prefix, attrs, selfClosing, text };
}

function textEvent(text: string): XmlEvent {
  return event('text', '', '', '', null, false, text);
}

export class StreamXmlScanner {
  private buf = '';
  private pos = 0;
  private readonly reader: ReadableStreamDefaultReader<string>;
  private readonly compactThreshold: number;
  private eof = false;
  /** 上一个返回的 start 事件是否自闭合 —— 让 skipElement() 对自闭合元素变成空操作 */
  private lastSelfClosing = false;
  private consumed = 0;
  private charsRead = 0;

  constructor(stream: ReadableStream<string>, options: ScannerOptions = {}) {
    this.reader = stream.getReader();
    this.compactThreshold = Math.max(64, options.compactThreshold ?? 8192);
  }

  /** 已消费字符数（近似），用于统计与诊断。 */
  get offset(): number {
    return this.consumed + this.pos;
  }

  /** 从流里实际读到的字符数 —— 提前取消时它远小于部件大小。 */
  get readChars(): number {
    return this.charsRead;
  }

  /** 读下一块并追加。返回 false 表示流已结束。 */
  private async pump(): Promise<boolean> {
    if (this.eof) return false;
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.eof = true;
        return false;
      }
      // TextDecoderStream 在多字节字符被块边界切开时会产出空串，必须继续读
      if (value !== undefined && value.length > 0) {
        this.buf += value;
        this.charsRead += value.length;
        return true;
      }
    }
  }

  /** 丢弃窗口内已消费的前缀。只能在无活跃局部索引时调用（next() 入口）。 */
  private compact(): void {
    if (this.pos >= this.compactThreshold) {
      this.buf = this.buf.slice(this.pos);
      this.consumed += this.pos;
      this.pos = 0;
    }
  }

  /**
   * 在缓冲区内找起始标签的结束 '>'，**跳过引号内的内容**。
   * 属性值里出现 '>' 是合法的（如 `formatCode="a>b"`），不处理引号会把标签截断在
   * 属性中间。找不到返回 -1（需要补料）。
   */
  private findTagEndSync(from: number): number {
    let i = from;
    let quote = -1;
    while (i < this.buf.length) {
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
    return -1;
  }

  /**
   * 纯同步地尝试产出下一个事件。
   * 返回 null 表示「缓冲区里没有完整事件，需要补料」；此时**绝不消费半个标签**，
   * 调用方补料后可以安全重试（文本节点已在跳过模式下被消费，见下面的注释）。
   */
  private tryNextSync(): XmlEvent | null {
    for (;;) {
      if (this.pos >= this.buf.length) return null;
      const lt = this.buf.indexOf('<', this.pos);
      if (lt < 0) {
        // 缓冲里没有 '<'：尾部可能是一个被切断的实体引用（如 "&am" + "p;"），
        // 因此不能现在就把尾巴当文本发出去 —— 等补料或真正的流尾（flushTail）。
        return null;
      }
      if (lt > this.pos) {
        const text = this.buf.slice(this.pos, lt);
        this.pos = lt;
        // 文本必然完整：它止于一个已经看到的 '<'
        return textEvent(decodeEntities(text));
      }
      if (this.pos + 1 >= this.buf.length) return null;
      const c1 = this.buf.charCodeAt(this.pos + 1);

      if (c1 === 33 /* ! */) {
        if (this.buf.startsWith('<!--', this.pos)) {
          const end = this.buf.indexOf('-->', this.pos + 4);
          if (end < 0) return null;
          this.pos = end + 3;
          continue; // 注释不产出事件（消费方不需要）
        }
        if (this.buf.startsWith('<![CDATA[', this.pos)) {
          const end = this.buf.indexOf(']]>', this.pos + 9);
          if (end < 0) return null;
          const text = this.buf.slice(this.pos + 9, end);
          this.pos = end + 3;
          return textEvent(text); // CDATA 就是文本内容
        }
        // <!DOCTYPE ...>：按方括号嵌套跳过内部子集
        let depth = 0;
        let j = this.pos + 2;
        for (;;) {
          if (j >= this.buf.length) return null;
          const ch = this.buf.charCodeAt(j);
          if (ch === 91 /* [ */) depth++;
          else if (ch === 93 /* ] */) depth--;
          else if (ch === 62 /* > */ && depth <= 0) break;
          j++;
        }
        this.pos = j + 1;
        continue;
      }

      if (c1 === 63 /* ? */) {
        const end = this.buf.indexOf('?>', this.pos + 2);
        if (end < 0) return null;
        this.pos = end + 2;
        continue; // 处理指令（XML 声明）不产出事件
      }

      if (c1 === 47 /* / */) {
        const gt = this.buf.indexOf('>', this.pos + 2);
        if (gt < 0) return null;
        const name = this.buf.slice(this.pos + 2, gt).trim();
        this.pos = gt + 1;
        const { prefix, local } = splitName(name);
        this.lastSelfClosing = false;
        return event('end', name, local, prefix, null, false, '');
      }

      // <start ...> / <start .../>
      const gt = this.findTagEndSync(this.pos + 1);
      if (gt < 0) return null;
      const tag = this.scanStartTag(this.pos + 1, gt);
      this.pos = gt + 1;
      const { prefix, local } = splitName(tag.name);
      this.lastSelfClosing = tag.selfClosing;
      return event('start', tag.name, local, prefix, tag.attrs ?? null, tag.selfClosing, '');
    }
  }

  /** 流尾收尾：把剩下的内容当文本交出去（畸形文件也绝不抛错）。 */
  private flushTail(): XmlEvent | null {
    const rest = this.buf.slice(this.pos);
    this.pos = this.buf.length;
    if (!rest) return null;
    return textEvent(decodeEntities(rest));
  }

  async next(): Promise<XmlEvent | null> {
    for (;;) {
      this.compact();
      const ev = this.tryNextSync();
      if (ev !== null) return ev;
      if (this.eof) return this.flushTail();
      if (!(await this.pump())) return this.flushTail();
    }
  }

  /**
   * 跳过当前元素的整棵子树（含自身结束标签）。
   * 必须在上一次 next() 返回 start 之后调用；对**自闭合**元素是空操作
   * （否则会吞掉父元素的结束标签，进而让后续兄弟元素全部消失）。
   *
   * 这里刻意不复用 next()：跳过一个含 20 个 `<c>` 的行如果走事件流，
   * 要建 100+ 个临时事件对象、做 100+ 次 await；字符级扫描则一次都不建。
   */
  async skipElement(): Promise<void> {
    if (this.lastSelfClosing) return;
    let depth = 1;
    for (;;) {
      depth = this.scanSkipSync(depth);
      if (depth <= 0) {
        this.lastSelfClosing = false;
        return;
      }
      // 补料前顺手压缩缓冲：否则跳过一个巨大的子树（例如超大的 extLst）时
      // 缓冲会一直涨到子树大小 —— 那就不是「低内存」了
      this.compact();
      if (!(await this.pump())) return; // 流尾：畸形文件，静默收尾
    }
  }

  /**
   * 从 this.pos 开始做字符级深度扫描，返回**剩余深度**（0 表示已跳过整棵子树）。
   * 返回 >0 时 this.pos 一定停在某个标签的起点或缓冲末尾，因此可以压缩缓冲、
   * 补料后带着同一个深度续扫。
   *
   * 关键：绝不消费半个标签。早期版本在需要补料时直接把 pos 推到缓冲末尾，
   * 于是被切断的 `<c r="A` 前半段被丢掉、后半段被当成一个新标签，深度计数错乱 ——
   * 这类 bug 只在「块边界正好落在标签中间」时出现，用 chunkSize=1 才逼得出来。
   */
  private scanSkipSync(depth: number): number {
    for (;;) {
      const lt = this.buf.indexOf('<', this.pos);
      if (lt < 0) {
        this.pos = this.buf.length; // 纯文本，跳过模式下可直接丢
        return depth;
      }
      this.pos = lt; // 标签之前的文本可以安全丢弃
      if (lt + 1 >= this.buf.length) return depth;
      const c1 = this.buf.charCodeAt(lt + 1);

      if (c1 === 33) {
        if (this.buf.startsWith('<!--', lt)) {
          const end = this.buf.indexOf('-->', lt + 4);
          if (end < 0) return depth;
          this.pos = end + 3;
          continue;
        }
        if (this.buf.startsWith('<![CDATA[', lt)) {
          const end = this.buf.indexOf(']]>', lt + 9);
          if (end < 0) return depth;
          this.pos = end + 3;
          continue;
        }
        let d = 0;
        let j = lt + 2;
        for (;;) {
          if (j >= this.buf.length) return depth;
          const ch = this.buf.charCodeAt(j);
          if (ch === 91) d++;
          else if (ch === 93) d--;
          else if (ch === 62 && d <= 0) break;
          j++;
        }
        this.pos = j + 1;
        continue;
      }

      if (c1 === 63) {
        const end = this.buf.indexOf('?>', lt + 2);
        if (end < 0) return depth;
        this.pos = end + 2;
        continue;
      }

      const gt = this.findTagEndSync(lt + 1);
      if (gt < 0) return depth;
      this.pos = gt + 1;
      if (c1 === 47 /* / */) {
        depth--;
        if (depth === 0) return 0;
      } else if (this.buf.charCodeAt(gt - 1) !== 47 /* 非自闭合 */) {
        depth++;
      }
    }
  }

  /** 提前中止：取消上游流（停止解压），后续 next() 一律返回 null。 */
  async cancel(): Promise<void> {
    this.eof = true;
    this.buf = '';
    this.pos = 0;
    try {
      await this.reader.cancel();
    } catch {
      /* 已关闭/已取消：忽略 */
    }
  }

  /** 在 [start, gt) 内解析起始标签（与 pull.ts 的 scanStartTag 同语义）。 */
  private scanStartTag(start: number, gt: number): { name: string; attrs: Record<string, string> | null; selfClosing: boolean } {
    let nameEnd = start;
    while (nameEnd < gt) {
      const c = this.buf.charCodeAt(nameEnd);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47) break;
      nameEnd++;
    }
    const name = this.buf.slice(start, nameEnd);

    const selfClosing = this.buf.charCodeAt(gt - 1) === 47;
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
}

/**
 * 把一个字符串按固定块大小切成 `ReadableStream<string>`。
 * 用途：测试跨块边界（把块边界故意落在 `<row`、属性、`<c>` 中间），
 * 以及在没有 zip 的情况下单测扫描器。
 */
export function chunkedStream(text: string, chunkSize: number): ReadableStream<string> {
  let i = 0;
  const size = Math.max(1, Math.floor(chunkSize));
  return new ReadableStream<string>({
    pull(controller) {
      if (i >= text.length) {
        controller.close();
        return;
      }
      controller.enqueue(text.slice(i, i + size));
      i += size;
    },
  });
}
