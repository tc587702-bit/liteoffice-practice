/**
 * 交叉引用表（xref）与对象查找。
 *
 * 这是「能不能打开一个真实 PDF」的核心。真实世界里 xref 的形态非常多：
 *   1. 经典 `xref` 表（PDF 1.0+）—— 纯 ASCII，200 字节一行
 *   2. 交叉引用**流**（PDF 1.5+，/Type /XRef）—— 二进制，通常被 Flate 压缩
 *   3. **混合**文件：尾部是经典 xref 表，但表里带 `/XRefStm` 指向一个 xref 流
 *   4. **增量更新**：`/Prev` 串起多个 xref 段，后写的覆盖先写的（加了水印、
 *      批注、签名的文件几乎都是这种）
 *   5. 偏移**全错**的 xref（第三方工具编辑过）—— 必须能退化到全文扫描
 *
 * 只支持第 1 种会打不开大量 WPS/Word 导出的文件；不支持第 4 种会把水印页
 * 解析成残缺版本；不支持第 5 种会让「损坏文件」直接打不开。
 * 因此这四种情况都实现了，第 5 种由 scanAllObjects() 兜底。
 */
import { indexOfAscii, isDigit, keywordAt, latin1, skipWs, parseNumberAt, isWhite, isDelimiter } from './byteutils.ts';
import {
  asDictObject,
  isStream,
  nameOf,
  numOf,
  parseIndirectObjectAt,
  parseObjectBytes,
  parseObjStmHeader,
  parseValueAt,
  sliceObjStmEntry,
} from './objects.ts';
import type { ObjectHost, PdfDict, PdfObject, PdfRef, PdfStream } from './objects.ts';
import { inflate, applyPredictor, decodeStream as decodeStreamFull } from './filters.ts';
import type { DecodeResult } from './filters.ts';

export interface XRefEntry {
  type: 1 | 2;
  /** type=1 时是对象偏移；type=2 时是对象流编号 */
  a: number;
  /** type=2 时是对象流内的序号 */
  b: number;
}

export interface XRefTable {
  entries: Map<number, XRefEntry>;
  /** 合并后的 trailer（后写覆盖先写） */
  trailer: PdfDict;
  /** 本次解析的降级说明 */
  notes: string[];
}

export interface XRefOptions {
  /** 单次解码结果的字节上限（防御解压炸弹） */
  maxDecodedBytes?: number;
}

const DEFAULT_MAX_DECODED = 64 * 1024 * 1024;

export class XRefState implements ObjectHost {
  readonly buf: Uint8Array;
  readonly entries = new Map<number, XRefEntry>();
  trailer: PdfDict = {};
  readonly notes: string[] = [];
  private readonly cache = new Map<number, PdfObject>();
  /** 已解析的对象流：objStm 的对象号 -> 数据字节 */
  private readonly objStmData = new Map<number, Uint8Array>();
  private readonly objStmIndex = new Map<number, Map<number, PdfObject>>();
  private readonly opts: XRefOptions;
  /** 解析过程中临时需要的「不记录警告」开关（例如探测流边界失败是正常的） */
  private quiet = false;

  constructor(buf: Uint8Array, opts: XRefOptions = {}) {
    this.buf = buf;
    this.opts = opts;
  }

  /* ---------------- ObjectHost ---------------- */

  note(message: string): void {
    if (this.quiet) return;
    if (this.notes.length < 200 && !this.notes.includes(message)) this.notes.push(message);
  }

  resolve(o: PdfObject, depth = 0): PdfObject {
    if (depth > 32) return null;
    if (isRefLike(o)) {
      const target = this.getObject(o.num);
      if (target === undefined) return null;
      return this.resolve(target, depth + 1);
    }
    return o;
  }

  /* ---------------- 构建 xref ---------------- */

  /**
   * 按 startxref -> /Prev 链构建。
   * 返回 false 表示「没能建立可用的 xref」，调用方应退化为全文扫描。
   */
  async build(): Promise<boolean> {
    const start = findStartXref(this.buf);
    if (start < 0) {
      this.note('文件里找不到 startxref，已改用全文扫描定位对象');
      return false;
    }
    try {
      await this.collectAt(start, new Set(), new Set());
    } catch (err) {
      this.note(`解析交叉引用时出错（${err instanceof Error ? err.message : String(err)}），已改用全文扫描`);
      return false;
    }
    if (this.entries.size === 0) return false;
    // 校验：能取到 /Root 或至少一个 /Type /Catalog 才算成功
    return this.hasUsableCatalog();
  }

  /**
   * 递归解析一个 xref 段。
   * 关键点：**先用 seen 集合登记，再递归 /Prev**，否则相互引用的
   * /Prev 与 /XRefStm 会造成无限递归（真实畸形文件里有）。
   */
  private async collectAt(offset: number, seenTable: Set<number>, seenStream: Set<number>): Promise<void> {
    if (offset <= 0 || offset >= this.buf.length) {
      this.note(`xref 偏移 ${offset} 越界，已忽略该段`);
      return;
    }
    if (seenTable.has(offset) || seenStream.has(offset)) return;
    seenTable.add(offset);

    const at = skipWs(this.buf, offset);
    if (matchesAt(this.buf, at, 'xref')) {
      await this.collectClassic(at, seenTable, seenStream);
      return;
    }
    // 不是经典表：当作交叉引用流
    seenStream.add(offset);
    await this.collectStream(offset, seenTable, seenStream);
  }

  private async collectClassic(at: number, seenTable: Set<number>, seenStream: Set<number>): Promise<void> {
    let i = at + 4;
    for (;;) {
      i = skipWs(this.buf, i);
      if (matchesAt(this.buf, i, 'trailer')) break;
      const first = parseNumberAt(this.buf, i);
      if (Number.isNaN(first.value)) break;
      i = skipWs(this.buf, first.next);
      const count = parseNumberAt(this.buf, i);
      if (Number.isNaN(count.value)) break;
      i = skipWs(this.buf, count.next);

      const n = Math.max(0, Math.min(count.value, 5_000_000));
      for (let k = 0; k < n; k++) {
        i = skipWs(this.buf, i);
        const off = parseNumberAt(this.buf, i);
        if (Number.isNaN(off.value)) break;
        i = skipWs(this.buf, off.next);
        const gen = parseNumberAt(this.buf, i);
        if (Number.isNaN(gen.value)) break;
        i = skipWs(this.buf, gen.next);
        const kind = this.buf[i];
        i = skipWs(this.buf, i + 1);
        if (kind === 0x6e) {
          // 先到先得：后写的段（更晚的增量更新）已经填过的条目不被覆盖
          const num = first.value + k;
          if (!this.entries.has(num)) this.entries.set(num, { type: 1, a: off.value, b: gen.value });
        } else if (kind === 0x66) {
          const num = first.value + k;
          if (!this.entries.has(num)) this.entries.set(num, { type: 1, a: 0, b: gen.value });
        }
        // 其它字母：格式坏了，尽力继续
      }
      if (matchesAt(this.buf, skipWs(this.buf, i), 'trailer')) break;
    }

    i = skipWs(this.buf, i);
    const trailer = this.parseTrailerDictAt(i);
    if (trailer) this.mergeTrailer(trailer);

    const xrefStm = numOf(this.trailer.XRefStm);
    if (xrefStm !== undefined && !seenStream.has(xrefStm)) {
      seenStream.add(xrefStm);
      await this.collectStream(xrefStm, seenTable, seenStream);
    }
    const prev = numOf(this.trailer.Prev) ?? numOf(trailer?.Prev);
    if (prev !== undefined) await this.collectAt(prev, seenTable, seenStream);
  }

  /** 从 `trailer` 关键字处解析字典（容错：解析失败返回 undefined）。 */
  private parseTrailerDictAt(i: number): PdfDict | undefined {
    if (!matchesAt(this.buf, i, 'trailer')) return undefined;
    // 只解析紧跟其后的那个 `<< ... >>`，绝不能把它之后的内容一起吃进来
    const parsed = parseValueAt(this.buf, i + 7, this);
    return asDictObject(parsed.value);
  }

  private async collectStream(offset: number, seenTable: Set<number>, seenStream: Set<number>): Promise<void> {
    const parsed = parseIndirectObjectAt(this.buf, offset, this);
    if (!parsed || !isStream(parsed.obj)) {
      this.note(`偏移 ${offset} 处的交叉引用流无法解析，已忽略该段`);
      return;
    }
    const dict = parsed.obj.dict;
    const data = await this.decodeXRefStream(parsed.obj);
    if (!data) {
      this.note('交叉引用流解压失败，已忽略该段（可能丢失部分对象）');
      return;
    }
    this.mergeTrailer(dict);
    this.readXRefStreamEntries(dict, data);

    const xrefStm = numOf(dict.XRefStm);
    if (xrefStm !== undefined && !seenStream.has(xrefStm)) {
      seenStream.add(xrefStm);
      await this.collectStream(xrefStm, seenTable, seenStream);
    }
    const prev = numOf(dict.Prev);
    if (prev !== undefined) await this.collectAt(prev, seenTable, seenStream);
  }

  /** 解压 xref 流。注意 /Length 也可能是间接引用（这里已由解析器处理）。 */
  private async decodeXRefStream(stream: PdfStream): Promise<Uint8Array | undefined> {
    const dict = stream.dict;
    const filters = dict.Filter;
    if (filters === undefined) return stream.raw;
    try {
      const r: DecodeResult = await decodeStreamLocal(dict, stream.raw, this);
      if (r.data.length === 0) return undefined;
      return r.data;
    } catch {
      return undefined;
    }
  }

  /**
   * 读取 xref 流的条目。
   *
   * /W [w1 w2 w3] 给出每个字段的字节数；/Index [start count ...] 给出区段，
   * 缺省 Index 为 [0 Size]。字段含义：
   *   type 0 = 空闲, 1 = 普通对象（f2 是偏移）, 2 = 对象流内对象（f2 是流号，f3 是序号）
   */
  private readXRefStreamEntries(dict: PdfDict, data: Uint8Array): void {
    const w = dict.W;
    if (!Array.isArray(w) || w.length < 3) {
      this.note('交叉引用流缺少 /W 数组，已忽略该段');
      return;
    }
    const w0 = Math.max(0, Math.min(8, numOf(w[0]) ?? 0));
    const w1 = Math.max(0, Math.min(8, numOf(w[1]) ?? 0));
    const w2 = Math.max(0, Math.min(8, numOf(w[2]) ?? 0));
    const rowLen = w0 + w1 + w2;
    if (rowLen <= 0) return;

    let index: number[] = [];
    const idx = dict.Index;
    if (Array.isArray(idx)) {
      for (const v of idx) {
        const n = numOf(v);
        if (n !== undefined) index.push(n);
      }
    }
    if (index.length === 0) {
      const size = numOf(dict.Size) ?? 0;
      index = [0, size];
    }

    let pos = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const start = index[s];
      const count = index[s + 1];
      for (let k = 0; k < count; k++) {
        if (pos + rowLen > data.length) return;
        // type 字段宽度为 0 时按 1 处理（规范：默认 type=1）
        const type = w0 === 0 ? 1 : readField(data, pos, w0);
        const f2 = w1 === 0 ? 0 : readField(data, pos + w0, w1);
        const f3 = w2 === 0 ? 0 : readField(data, pos + w0 + w1, w2);
        pos += rowLen;
        const num = start + k;
        if (this.entries.has(num)) continue; // 先到先得（后写的段优先）
        if (type === 1) this.entries.set(num, { type: 1, a: f2, b: f3 });
        else if (type === 2) this.entries.set(num, { type: 2, a: f2, b: f3 });
        // type 0（空闲）不登记
      }
    }
  }

  private mergeTrailer(dict: PdfDict): void {
    for (const key of Object.keys(dict)) {
      if (key === 'Type' || key === 'W' || key === 'Index' || key === 'Filter' || key === 'Length' || key === 'DecodeParms') continue;
      // 后写的段（更新的增量更新）优先：只在目标键缺失时写入
      if (this.trailer[key] === undefined) this.trailer[key] = dict[key];
    }
  }

  private hasUsableCatalog(): boolean {
    const rootRaw = this.trailer.Root;
    if (rootRaw !== undefined) {
      const root = this.resolve(rootRaw);
      if (root) return true;
    }
    // 没有可用 /Root：扫描 xref 指向的对象里有没有 /Type /Catalog
    for (const [num, e] of this.entries) {
      if (e.type !== 1 || e.a <= 0) continue;
      if (num > 5000) break;
      const o = this.getObject(num);
      if (o && typeof o === 'object' && !Array.isArray(o) && !isStream(o) && !('num' in o)) {
        const d = o as PdfDict;
        const t = d.Type;
        if (t && typeof t === 'object' && !Array.isArray(t) && (t as { name?: string }).name === 'Catalog') {
          this.trailer.Root = { num, gen: 0 };
          this.note('trailer 里没有可用的 /Root，已通过扫描对象找到 /Type /Catalog');
          return true;
        }
      }
    }
    return false;
  }

  /* ---------------- 对象读取 ---------------- */

  getObject(num: number): PdfObject | undefined {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
    const e = this.entries.get(num);
    if (!e) return undefined;
    let result: PdfObject | undefined;
    if (e.type === 1) {
      if (e.a <= 0) return undefined;
      result = this.parseAt(e.a);
      if (result === undefined) {
        // xref 偏移错了：用「按对象号全文扫描」修正。这是让损坏文件能打开的关键。
        const fixed = scanForObject(this.buf, num);
        if (fixed >= 0) {
          if (!this.quiet) this.note(`对象 ${num} 在 xref 记录的偏移 ${e.a} 处不存在，已通过全文扫描修正到 ${fixed}`);
          result = this.parseAt(fixed);
        }
      }
    } else {
      result = this.getFromObjectStream(e.a, e.b, num);
    }
    if (result !== undefined) this.cache.set(num, result);
    return result;
  }

  private parseAt(offset: number): PdfObject | undefined {
    // 解析流时会为 /Length 调用 resolve()，可能触发其它对象解析 —— 这是正常的
    const r = parseIndirectObjectAt(this.buf, offset, this);
    return r ? r.obj : undefined;
  }

  /**
   * 从对象流里取对象。
   *
   * 对象流的头部是 `N1 off1 N2 off2 …`（偏移相对于 /First 之后的数据区），
   * 必须先解压并解析头部，才能定位到第 k 个对象。
   */
  private getFromObjectStream(stmNum: number, idx: number, wantNum: number): PdfObject | undefined {
    let parsed = this.objStmIndex.get(stmNum);
    if (!parsed) {
      const stm = this.getObject(stmNum);
      if (!stm || !isStream(stm)) return undefined;
      const data = this.objStmData.get(stmNum);
      if (!data) return undefined;
      const count = numOf(stm.dict.N) ?? 0;
      const first = numOf(stm.dict.First) ?? 0;
      const entries = parseObjStmHeader(data.subarray(0, Math.max(0, first)), count);
      parsed = new Map<number, PdfObject>();
      for (let i = 0; i < entries.length; i++) {
        const slice = sliceObjStmEntry(data.subarray(first), entries, i);
        const obj = parseObjectBytes(slice, this);
        parsed.set(entries[i].num, obj);
      }
      this.objStmIndex.set(stmNum, parsed);
    }
    const hit = parsed.get(wantNum);
    if (hit !== undefined) return hit;
    // 头部信息不可靠时按序号取（很多文件 N/First 是对的，但序号推断更保险）
    const values = [...parsed.values()];
    return values[idx];
  }

  /** 对象流的数据区在第一次遇到 type=2 条目时按需解压并缓存。 */
  async prepare(): Promise<void> {
    this.quiet = true;
    try {
      const stmNums = new Set<number>();
      let hasType2 = false;
      let hasFreeEntry = false;
      for (const e of this.entries.values()) {
        if (e.type === 2 && e.a > 0) {
          hasType2 = true;
          stmNums.add(e.a);
        } else if (e.type === 1 && e.a <= 0 && e.b !== 65535) {
          // 非 0 号对象的空闲条目：压缩对象被写成 free 时就是这种形态
          hasFreeEntry = true;
        }
      }
      /*
       * 兜底：xref 里一条 type=2 都没有、却又存在「空闲条目」时，对象流里的对象
       * 等于「不存在」。真实文件里出现过的两种写法都会让这里中招：
       *   - 第三方「修复」工具把压缩对象写成空闲条目（0 偏移）
       *   - xref 流丢了 type=2 段，只剩对象流本体
       * 表现是页数正常、字体/内容流全部解析不出来（整页没有文字）。
       *
       * 为什么要加 hasFreeEntry 这个前置条件：正常的经典 xref 文件（PDF 1.4）
       * 根本没有对象流，若每次都全文扫 /ObjStm，等于给所有老文件加一遍 O(n) 扫描。
       * 只有「xref 里明明有空闲条目」时才值得付这笔钱。
       *
       * 且只在**一条 type=2 都没有**时才补登记：增量更新里被 /Prev 覆盖掉的
       * 空闲条目也可能是「已删除对象」，无条件复活旧对象流里的版本会把旧内容
       * 当成新内容，这比读不到更糟。
       */
      if (!hasType2 && hasFreeEntry) {
        for (const stm of this.findObjectStreams()) {
          const cur = this.entries.get(stm.num);
          // 用扫描到的偏移修正这条（原本是空闲/缺失）条目
          if (!cur || cur.type !== 1 || cur.a <= 0) this.entries.set(stm.num, { type: 1, a: stm.offset, b: 0 });
          stmNums.add(stm.num);
        }
      }
      for (const n of stmNums) {
        const stm = this.getObject(n);
        if (!stm || !isStream(stm)) continue;
        const decoded = await decodeStreamLocal(stm.dict, stm.raw, this);
        if (!decoded.data.length) continue;
        this.objStmData.set(n, decoded.data);
        if (!hasType2) this.registerObjectStreamEntries(n, stm.dict, decoded.data);
      }
    } finally {
      this.quiet = false;
    }
  }

  /**
   * 把对象流里的对象号补登记成 type=2 条目。
   * 只填空缺/空闲的条目，已有真实偏移（type=1 且 a>0）或已有 type=2 的不动，
   * 避免覆盖正确的 xref 信息。
   */
  private registerObjectStreamEntries(stmNum: number, dict: PdfDict, data: Uint8Array): void {
    const count = numOf(dict.N) ?? 0;
    const first = numOf(dict.First) ?? 0;
    const header = parseObjStmHeader(data.subarray(0, Math.max(0, Math.min(first, data.length))), count);
    for (let k = 0; k < header.length; k++) {
      const num = header[k].num;
      if (!Number.isInteger(num) || num <= 0) continue;
      const cur = this.entries.get(num);
      if (cur && (cur.type === 2 || (cur.type === 1 && cur.a > 0))) continue;
      this.entries.set(num, { type: 2, a: stmNum, b: k });
    }
  }

  /**
   * 全文查找 `/Type /ObjStm` 对象，返回对象号与对象起始偏移。
   *
   * 为什么要扫：「对象流里的对象」正常由 xref 的 type=2 条目登记；
   * 一旦这些条目丢了（损坏/被工具重写），只有从文件本体找回对象流才有救。
   * 这里只按 `/ObjStm` 关键字定位，再向前找到 `N G obj` 头并校验 /Type，
   * 不会把二进制流里的巧合字节当成对象。
   */
  private findObjectStreams(): Array<{ num: number; offset: number }> {
    const found: Array<{ num: number; offset: number }> = [];
    let from = 0;
    for (;;) {
      const at = indexOfAscii(this.buf, '/ObjStm', from);
      if (at < 0) break;
      from = at + 7;
      const offset = objectStartBefore(this.buf, at);
      if (offset < 0) continue;
      const numRes = parseNumberAt(this.buf, offset);
      if (Number.isNaN(numRes.value) || !Number.isInteger(numRes.value) || numRes.value <= 0) continue;
      if (found.some((f) => f.num === numRes.value)) continue;
      const parsed = parseIndirectObjectAt(this.buf, offset, this);
      if (!parsed || !isStream(parsed.obj) || nameOf(parsed.obj.dict.Type) !== 'ObjStm') continue;
      found.push({ num: numRes.value, offset });
    }
    return found;
  }

  /* ---------------- 兜底：全文扫描 ---------------- */

  /**
   * 全文扫描 `N G obj`。
   *
   * 为什么必须有这条路：第三方工具（尤其是「PDF 压缩/加水印」小工具）经常
   * 重写了文件却留下错误的 xref 偏移；Adobe 自己的线性化输出在网络传输被
   * 截断后也会偏移全错。此时 xref 完全不可信，唯一可靠的办法是扫描文件本体。
   *
   * 扫描规则（必须严格，否则二进制流里的巧合字节会造出假对象）：
   *   - `obj` 前后必须是空白/分隔符
   *   - `obj` 前面必须是「数字 空白 数字」，且数字串长度合理
   *   - 每个对象号只取**第一次**出现（增量更新里后写的对象通常在文件后面，
   *     但 xref 正确时根本不会走这条路；扫描路径下取第一次更接近原始定义）
   */
  scanAllObjects(): number {
    const buf = this.buf;
    const found = new Map<number, number>();
    let i = 0;
    const limit = buf.length;
    while (i < limit) {
      const at = indexOfAscii(buf, 'obj', i, limit);
      if (at < 0) break;
      i = at + 3;
      if (!keywordAt(buf, at, 'obj')) continue;
      // 往回找 "数字 空白 数字"
      let j = at - 1;
      while (j >= 0 && isWhite(buf[j])) j--;
      const genEnd = j + 1;
      while (j >= 0 && buf[j] >= 0x30 && buf[j] <= 0x39) j--;
      const genStart = j + 1;
      if (genStart === genEnd) continue;
      while (j >= 0 && isWhite(buf[j])) j--;
      if (j < 0 || !(buf[j] >= 0x30 && buf[j] <= 0x39)) continue;
      const numEnd = j + 1;
      while (j >= 0 && buf[j] >= 0x30 && buf[j] <= 0x39) j--;
      const numStart = j + 1;
      const digits = numEnd - numStart;
      if (digits === 0 || digits > 10) continue;
      const num = Number.parseInt(latin1(buf, numStart, numEnd), 10);
      if (!Number.isFinite(num) || num <= 0 || found.has(num)) continue;
      found.set(num, numStart);
    }
    for (const [num, off] of found) this.entries.set(num, { type: 1, a: off, b: 0 });
    if (found.size) {
      this.note(`xref 不可用，已全文扫描定位到 ${found.size} 个对象`);
    }
    this.cache.clear();
    this.findTrailerByScan();
    return found.size;
  }

  /** 扫描模式下也要能拿到 /Root：找任意 /Type /Catalog。 */
  findTrailerByScan(): void {
    if (this.hasUsableCatalog()) return;
    for (const [num, e] of this.entries) {
      const o = this.getObject(num);
      if (!o || Array.isArray(o) || isStream(o) || typeof o !== 'object' || 'bytes' in o || 'name' in o || 'num' in o) continue;
      const d = o as PdfDict;
      const type = d.Type;
      if (type && typeof type === 'object' && !Array.isArray(type) && (type as { name?: string }).name === 'Catalog') {
        this.trailer.Root = { num, gen: 0 };
        this.note(`通过全文扫描找到文档目录对象 ${num} 0 R`);
        return;
      }
    }
    // 再退一步：有些文件把 /Encrypt 放在 trailer 里（这里只做探测，不实现解密）
    const encAt = indexOfAscii(this.buf, '/Encrypt', 0, Math.min(this.buf.length, 1 << 20));
    if (encAt >= 0 && this.trailer.Encrypt === undefined) this.trailer.Encrypt = true;
  }

  /* ---------------- 便捷取值 ---------------- */

  getStream(num: number): PdfStream | undefined {
    const o = this.getObject(num);
    return isStream(o) ? o : undefined;
  }

  root(): PdfDict | undefined {
    const r = this.resolve(this.trailer.Root);
    if (r && !Array.isArray(r) && !isStream(r) && typeof r === 'object' && !('name' in r) && !('bytes' in r) && !('num' in r)) {
      return r as PdfDict;
    }
    return undefined;
  }
}

/** 解码一条流（本地包装，避免 xref.ts 直接依赖 filters 的完整签名）。 */
async function decodeStreamLocal(dict: PdfDict, raw: Uint8Array, host: XRefState): Promise<DecodeResult> {
  const names = filterNamesOf(dict);
  if (names.length === 0) return { data: raw, failed: [], passthrough: false };
  // 只处理最常见的一层：Flate（+Predictor）。其余情况交给完整的 decodeStream。
  if (names.length === 1 && /^(FlateDecode|Fl)$/.test(names[0])) {
    const out = await inflate(raw);
    if (!out) return { data: new Uint8Array(0), failed: [names[0]], passthrough: false };
    const parms = dict.DecodeParms ?? dict.DP;
    const p = parms && typeof parms === 'object' && !Array.isArray(parms) && !('name' in parms) ? (parms as PdfDict) : undefined;
    void host;
    return { data: applyPredictor(out, p), failed: [], passthrough: false };
  }
  return decodeStreamFull(dict, raw);
}

function filterNamesOf(dict: PdfDict): string[] {
  const f = dict.Filter ?? dict.F;
  if (f === undefined) return [];
  if (typeof f === 'object' && f !== null && !Array.isArray(f) && typeof (f as { name?: string }).name === 'string') {
    return [(f as { name: string }).name];
  }
  if (Array.isArray(f)) {
    const out: string[] = [];
    for (const x of f) {
      if (x && typeof x === 'object' && !Array.isArray(x) && typeof (x as { name?: string }).name === 'string') out.push((x as { name: string }).name);
    }
    return out;
  }
  return [];
}

/* ==================================================================== */
/* 字节级小工具                                                          */
/* ==================================================================== */

function matchesAt(buf: Uint8Array, at: number, word: string): boolean {
  if (at < 0 || at + word.length > buf.length) return false;
  for (let k = 0; k < word.length; k++) if (buf[at + k] !== word.charCodeAt(k)) return false;
  return true;
}

/** 找最后一个 startxref 后面的数字。为什么是最后一个：增量更新会写多个。 */
export function findStartXref(buf: Uint8Array): number {
  const at = lastIndexOfAsciiLocal(buf, 'startxref');
  if (at < 0) return -1;
  let i = skipWs(buf, at + 9);
  const r = parseNumberAt(buf, i);
  if (Number.isNaN(r.value)) return -1;
  i = r.next;
  return r.value;
}

function lastIndexOfAsciiLocal(buf: Uint8Array, needle: string): number {
  const n = needle.length;
  for (let i = buf.length - n; i >= 0; i--) {
    if (matchesAt(buf, i, needle)) return i;
  }
  return -1;
}

function readField(data: Uint8Array, at: number, width: number): number {
  let v = 0;
  for (let k = 0; k < width; k++) v = v * 256 + data[at + k];
  return v;
}

function isRefLike(o: PdfObject): o is PdfRef {
  return typeof o === 'object' && o !== null && typeof (o as PdfRef).num === 'number' && typeof (o as PdfRef).gen === 'number';
}

/**
 * 在文件里按对象号找一个对象的偏移（兜底路径用）。
 *
 * 为什么要单独写而不是复用 scanAllObjects：xref 只错了一两个对象时，
 * 全文重建表代价太大（4 MiB 文件要扫 400 万次比较），按需扫描更划算。
 */
export function scanForObject(buf: Uint8Array, wantNum: number): number {
  const needle = `${wantNum} `;
  const numLen = needle.length;
  let i = 0;
  while (i < buf.length) {
    const at = indexOfAscii(buf, needle, i);
    if (at < 0) return -1;
    i = at + 1;
    // 要求对象号出现在行首/空白/分隔符之后，避免匹配到「1234 」这种子串
    // （例如想找对象 5，却在 "125 0 obj" 里匹配到 "5 "）
    const before = at > 0 ? buf[at - 1] : 0x0a;
    if (!isWhite(before) && !isDelimiter(before)) continue;
    // 期望形如 "12 0 obj"
    let j = at + numLen;
    while (j < buf.length && isWhite(buf[j])) j++;
    const g = parseNumberAt(buf, j);
    if (Number.isNaN(g.value)) continue;
    j = skipWs(buf, g.next);
    if (keywordAt(buf, j, 'obj')) return at;
  }
  return -1;
}

/**
 * 从 `at` 往前找最近的 `N G obj`，返回对象号的起始偏移（找不到 -1）。
 *
 * 用途：按 `/Type /ObjStm` 关键字定位到字典内部后，反推它属于哪个间接对象。
 * 与 scanAllObjects() 的「向后解析 obj 头」逻辑对称；这里必须有 64 KiB 的
 * 回溯上限，避免在畸形文件上把整份文件倒扫到开头。
 */
function objectStartBefore(buf: Uint8Array, at: number): number {
  const floor = Math.max(0, at - 65536);
  for (let i = at - 3; i >= floor; i--) {
    if (buf[i] !== 0x6f || buf[i + 1] !== 0x62 || buf[i + 2] !== 0x6a) continue;
    const after = buf[i + 3];
    if (after !== undefined && !isWhite(after) && !isDelimiter(after)) continue;
    let j = i - 1;
    while (j >= floor && isWhite(buf[j])) j--;
    const genEnd = j + 1;
    while (j >= floor && isDigit(buf[j])) j--;
    if (j + 1 === genEnd) continue; // 没有 gen 数字
    while (j >= floor && isWhite(buf[j])) j--;
    const numEnd = j + 1;
    while (j >= floor && isDigit(buf[j])) j--;
    if (j + 1 === numEnd) continue; // 没有对象号
    return j + 1;
  }
  return -1;
}
