/**
 * 资源上限。
 *
 * 这是 LiteOffice 与「网页版 Office」最关键的工程差异之一：
 * 打开任何文件都必须**先有上限**，否则一个构造出来的畸形文件就能让标签页 OOM。
 *
 * 原则：
 *   1. 超限时**降级并记录警告**，而不是抛错让整篇打不开
 *   2. 「截断」必须显式记录在 stats.truncated，让用户知道看到的不完整
 *   3. 上限可被调用方覆盖（服务器端可以调得更保守）
 */

export interface Limits {
  /** 源文件字节上限 */
  maxFileBytes: number;
  /** ZIP 单个条目解压后上限 */
  maxEntryBytes: number;
  /** 单个 XML 部件整块读取上限；超过则应走流式扫描路径 */
  maxPartBytes: number;
  /** 工作表单元格总数上限 */
  maxCells: number;
  maxRows: number;
  maxCols: number;
  /** 文本类文档的块（段落/表格）总数上限 */
  maxBlocks: number;
  /** 演示文稿形状总数上限 */
  maxShapes: number;
  maxSlides: number;
  /** 图片数量与累计字节上限 */
  maxImages: number;
  maxImageBytes: number;
  /** sharedStrings.xml 累计字符串字节上限 */
  maxStringBytes: number;
  /** PDF 页数上限 */
  maxPages: number;
  /** 达到上限多少比例时开始记录警告（0..1） */
  warnRatio: number;
  /** 单次布局的行窗口大小（虚拟化用） */
  rowWindow: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: 512 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxPartBytes: 64 * 1024 * 1024,
  maxCells: 2_000_000,
  maxRows: 1_048_576,
  maxCols: 16_384,
  maxBlocks: 300_000,
  maxShapes: 50_000,
  maxSlides: 2_000,
  maxImages: 5_000,
  maxImageBytes: 64 * 1024 * 1024,
  maxStringBytes: 32 * 1024 * 1024,
  maxPages: 5_000,
  warnRatio: 0.8,
  rowWindow: 200,
};

/** 低内存档：适合嵌入式/移动端/服务端批量转换。 */
export const CONSERVATIVE_LIMITS: Limits = {
  ...DEFAULT_LIMITS,
  maxFileBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxPartBytes: 8 * 1024 * 1024,
  maxCells: 200_000,
  maxBlocks: 30_000,
  maxShapes: 5_000,
  maxImages: 500,
  maxImageBytes: 8 * 1024 * 1024,
  maxStringBytes: 4 * 1024 * 1024,
  rowWindow: 100,
};

export function withLimits(overrides: Partial<Limits> | undefined): Limits {
  return overrides ? { ...DEFAULT_LIMITS, ...overrides } : { ...DEFAULT_LIMITS };
}

/**
 * 限额计数器：把「是否超限」的判断集中到一处，避免每个读取器各写一套。
 * 读取器在消费资源时 probe()，超限即返回 false 并由读取器决定如何降级。
 */
export class LimitGuard {
  readonly limits: Limits;
  readonly warnings: string[] = [];
  readonly truncated: string[] = [];
  private readonly used = new Map<string, number>();
  /**
   * 「接近上限」与「已达上限」必须用**两组独立**的标记。
   *
   * 早期版本共用一组，结果是：80% 时接近告警占用了名额，真正超限时
   * `if (!warned.has(name))` 为假 → 整个分支被跳过 → `truncated` 永远为空。
   * 后果是 UI 永远不会告诉用户「内容被截断了」，也就是本项目明确要避免的
   * **静默截断**。这不是提示文案问题，是正确性问题。
   */
  private readonly warnedNear = new Set<string>();
  private readonly warnedFull = new Set<string>();

  constructor(limits: Limits) {
    this.limits = limits;
  }

  /** 取某类资源的上限；未登记的类别返回 Infinity（不限制）。 */
  cap(name: keyof Limits): number {
    const v = this.limits[name];
    return typeof v === 'number' ? v : Number.POSITIVE_INFINITY;
  }

  /** 尝试消耗 amount；返回 false 表示已达上限（本次不计入）。 */
  probe(name: keyof Limits, amount = 1): boolean {
    const cap = this.cap(name);
    const now = (this.used.get(name) ?? 0) + amount;
    if (now > cap) {
      if (!this.warnedFull.has(name)) {
        this.warnedFull.add(name);
        this.warnings.push(`${name} 达到上限 ${cap.toLocaleString('en-US')}，后续内容已忽略`);
      }
      // 无条件记录截断（只记一次），不依赖任何告警状态
      if (!this.truncated.includes(name)) this.truncated.push(name);
      return false;
    }
    this.used.set(name, now);
    // 达到 warnRatio 的比例即告警（用 >= 而不是 >）。
    // 用 > 会让「80% 告警」实际变成「81% 告警」，与档位参数的字面含义不符。
    const warnAt = cap * this.limits.warnRatio;
    if (now >= warnAt && !this.warnedNear.has(name)) {
      this.warnedNear.add(name);
      this.warnings.push(`${name} 已用 ${now.toLocaleString('en-US')}，接近上限 ${cap.toLocaleString('en-US')}`);
    }
    return true;
  }

  /** 取某类资源已消耗量。 */
  count(name: keyof Limits): number {
    return this.used.get(name) ?? 0;
  }

  /** 是否已经发生过截断。 */
  get hasTruncation(): boolean {
    return this.truncated.length > 0;
  }

  warn(message: string): void {
    if (this.warnings.length < 200) this.warnings.push(message);
  }

  snapshot(): { warnings: string[]; truncated: string[]; used: Record<string, number> } {
    return { warnings: [...this.warnings], truncated: [...this.truncated], used: Object.fromEntries(this.used) };
  }
}
