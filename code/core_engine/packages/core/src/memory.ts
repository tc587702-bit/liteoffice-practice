/**
 * 内存度量与记账。
 *
 * 为什么要有这个模块：
 * 「比 WPS 省内存」是本项目的核心主张，主张必须**可测**。所以：
 *   - estimateModelBytes() 给出文档模型的估算占用，可在测试里断言
 *   - memSnapshot() 读取真实进程/页面内存，可在基准里对比
 *   - 基准脚本据此输出「源文件 vs 模型」的比值
 *
 * 注意估算的诚实性：JS 字符串的实际占用取决于 V8 是否用了 Latin-1 表示
 * （纯 ASCII 时 1 字节/字符，含中日韩时 2 字节/字符）。这里按更保守的
 * 2 字节/字符估算并显式说明，避免给出虚低的数字。
 */

const STRING_BYTES_PER_CHAR = 2;

export function estimateStringBytes(s: string | undefined): number {
  if (!s) return 0;
  // 近似：V8 对纯 Latin-1 字符串可优化到 1 字节/字符，这里统一按 2 估，偏保守
  return s.length * STRING_BYTES_PER_CHAR + 16;
}

/** 深估算任意模型值的近似字节数。跳过不可枚举/函数/循环引用。 */
export function estimateBytes(value: unknown, seen = new WeakSet<object>(), depth = 0): number {
  if (value === null || value === undefined) return 0;
  const t = typeof value;
  if (t === 'string') return estimateStringBytes(value as string);
  if (t === 'number') return 8;
  if (t === 'boolean') return 4;
  if (t === 'bigint') return 16;
  if (t === 'function') return 0;
  if (depth > 24) return 0;

  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (value instanceof Date) return 24;
  if (value instanceof Map) {
    if (seen.has(value)) return 0;
    seen.add(value);
    let n = 48;
    for (const [k, v] of value) n += estimateBytes(k, seen, depth + 1) + estimateBytes(v, seen, depth + 1);
    return n;
  }
  if (value instanceof Set) {
    if (seen.has(value)) return 0;
    seen.add(value);
    let n = 48;
    for (const v of value) n += estimateBytes(v, seen, depth + 1);
    return n;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return 0;
    seen.add(value);
    let n = 32 + value.length * 8;
    for (const v of value) n += estimateBytes(v, seen, depth + 1);
    return n;
  }

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return 0;
  seen.add(obj);
  let n = 32;
  for (const k of Object.keys(obj)) {
    n += estimateStringBytes(k) + estimateBytes(obj[k], seen, depth + 1);
  }
  return n;
}

export interface MemSnapshot {
  /** V8 堆已用字节（浏览器下为 JS 堆近似值） */
  heapUsedBytes: number;
  /** 进程常驻内存（仅 Node 可用） */
  rssBytes?: number;
  /** 外部内存（ArrayBuffer 等，仅 Node 可用） */
  externalBytes?: number;
  /** 数据来源，便于在报告里标注可信度 */
  source: 'node' | 'performance.memory' | 'unavailable';
}

/**
 * 读取当前内存快照。
 * 浏览器下 performance.memory 是 Chrome 私有 API 且被降精度，
 * 因此这里如实标注 source，报告中不会把它当成精确值。
 */
export function memSnapshot(): MemSnapshot {
  const g = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number; rss: number; external: number } };
    performance?: { memory?: { usedJSHeapSize: number } };
  };
  if (typeof g.process?.memoryUsage === 'function') {
    const m = g.process.memoryUsage();
    return { heapUsedBytes: m.heapUsed, rssBytes: m.rss, externalBytes: m.external, source: 'node' };
  }
  const pm = g.performance?.memory;
  if (pm) {
    return { heapUsedBytes: pm.usedJSHeapSize, source: 'performance.memory' };
  }
  return { heapUsedBytes: 0, source: 'unavailable' };
}

/** 强制 GC（仅在 Node 且以 --expose-gc 启动时可用）。返回是否真的执行了。 */
export function forceGc(): boolean {
  const g = globalThis as unknown as { gc?: () => void };
  if (typeof g.gc === 'function') {
    g.gc();
    return true;
  }
  return false;
}

/**
 * 人类可读的字节数。
 *
 * 负值**不**显示成 n/a：内存增量/残留为负是**有意义的信息**
 * （说明该次测量期间 GC 回收的比分配的多，通常意味着「没有累积」）。
 * 把它藏成 n/a 会让泄漏检查表看起来像「测不出来」，反而误导。
 * 只有 NaN / Infinity 这类真正无效的值才显示 n/a。
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MiB`;
  return `${sign}${(abs / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * 在一个作用域内测量内存增量与耗时。
 * 用于基准脚本输出「解析一个文档需要多少内存」。
 */
export async function measure<T>(fn: () => Promise<T> | T): Promise<{ result: T; ms: number; heapDeltaBytes: number; peakHeapBytes: number }> {
  forceGc();
  const before = memSnapshot().heapUsedBytes;
  const t0 = now();
  let peak = before;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (typeof setInterval === 'function') {
    timer = setInterval(() => {
      const cur = memSnapshot().heapUsedBytes;
      if (cur > peak) peak = cur;
    }, 5);
    // 不阻止进程退出
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  try {
    const result = await fn();
    const after = memSnapshot().heapUsedBytes;
    if (after > peak) peak = after;
    return { result, ms: now() - t0, heapDeltaBytes: after - before, peakHeapBytes: peak - before };
  } finally {
    if (timer) clearInterval(timer);
  }
}

export function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/* ================================================================== */
/* 文档模型的体积估算                                                   */
/* ================================================================== */

/** 表格单元格的兜底估值（当 Grid 未实现 estimateBytes 时使用） */
const FALLBACK_BYTES_PER_CELL = 24;

/**
 * 估算整个文档模型**当前驻留**的字节数。
 *
 * 为什么不能简单地 deep-walk 文档对象：
 *   表格数据不在 `Sheet` 对象上，而在 `Grid` 实现内部（物化实现把行放在私有数组里）。
 *   任何从外部遍历文档对象的估算都**完全看不到表格数据**。
 *   实测踩过：一个 2 万行 × 8 列的 CSV 被报成 **278 字节**，而真实堆增量是 **60 MiB** ——
 *   差了 20 万倍。这会直接毁掉「模型 ÷ 源文件」这个核心指标的可信度。
 *
 * 因此表格体积由 `Grid.estimateBytes()` 自报（语义是「驻留量」而非「逻辑表大小」，
 * 于是惰性实现报的只是它的小缓存）。拿不到时按行列数兜底，并**宁可高估也不报 0**。
 *
 * 图片字节按 `imageBytes` 单独统计过（见 stats），因此这里只算结构开销，不重复计入像素数据。
 */
export function estimateDocumentBytes(doc: {
  meta?: unknown;
  outline?: unknown;
  blocks?: unknown;
  text?: string;
  sheets?: readonly { name?: string; styles?: unknown; colWidths?: unknown; merges?: unknown; freeze?: unknown; rowCount: number; colCount: number; estimateBytes?: () => number }[];
  slides?: unknown;
  pages?: unknown;
  blocks2?: never;
}): number {
  let total = 0;

  total += estimateBytes(doc.meta);
  total += estimateBytes(doc.outline);
  if (doc.blocks) total += estimateBytes(doc.blocks);
  if (doc.text) total += estimateStringBytes(doc.text);

  if (doc.sheets) {
    for (const s of doc.sheets) {
      // 样式表 / 列宽 / 合并范围等元信息仍然走深估算
      total += estimateBytes({
        name: s.name,
        styles: s.styles,
        colWidths: s.colWidths,
        merges: s.merges,
        freeze: s.freeze,
      });
      const reported = s.estimateBytes?.();
      total +=
        typeof reported === 'number' && Number.isFinite(reported) && reported > 0
          ? reported
          : s.rowCount * s.colCount * FALLBACK_BYTES_PER_CELL;
    }
  }

  // 幻灯片与 PDF 页面：形状/文本项是普通对象，可安全深估算。
  // 其中的图片字节被跳过（已在 stats.imageBytes 单独统计），且**不做任何拷贝**。
  if (doc.slides) total += estimateBytesSkippingBinary(doc.slides);
  if (doc.pages) total += estimateBytesSkippingBinary(doc.pages);

  return total;
}

/**
 * 估算体积时**跳过二进制负载**的深估算：遇到 Uint8Array / ArrayBuffer 记 0。
 *
 * 用途：幻灯片与 PDF 页面里的图片字节已经由 `stats.imageBytes` 单独统计，
 * 这里不能再计入，否则重复计算。
 *
 * 为什么不用「先深拷贝一份、把 data 换成 0、再估算」那种写法：
 * 实测过，那是**真的**在复制——一个 200 页、每页 40 个文本项的 PDF 会因此
 * 分配数万个临时对象，把「大文件压力测试」直接拖红。估算必须是只读遍历，不能有分配。
 */
export function estimateBytesSkippingBinary(value: unknown, seen = new WeakSet<object>(), depth = 0): number {
  if (value === null || value === undefined) return 0;
  const t = typeof value;
  if (t === 'string') return estimateStringBytes(value as string);
  if (t === 'number') return 8;
  if (t === 'boolean') return 4;
  if (t === 'function') return 0;
  if (depth > 24) return 0;

  // 二进制负载：不计入（已由 imageBytes 单独统计）
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return 0;

  if (Array.isArray(value)) {
    if (seen.has(value)) return 0;
    seen.add(value);
    let n = 32 + value.length * 8;
    for (const v of value) n += estimateBytesSkippingBinary(v, seen, depth + 1);
    return n;
  }
  if (value instanceof Map) {
    if (seen.has(value)) return 0;
    seen.add(value);
    let n = 48;
    for (const [k, v] of value) n += estimateBytesSkippingBinary(k, seen, depth + 1) + estimateBytesSkippingBinary(v, seen, depth + 1);
    return n;
  }

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return 0;
  seen.add(obj);
  let n = 32;
  for (const k of Object.keys(obj)) {
    n += estimateStringBytes(k) + estimateBytesSkippingBinary(obj[k], seen, depth + 1);
  }
  return n;
}
