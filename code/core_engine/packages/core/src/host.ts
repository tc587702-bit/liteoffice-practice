/**
 * HostAdapter —— 外壳能力抽象。
 *
 * 存在理由：目标是「同一内核 + 两种壳」（Web 与 Tauri 桌面）。
 * 如果内核直接调用 `showOpenFilePicker` 或 `Blob`，桌面壳就无法复用；
 * 如果直接调用 `fs.readFile`，Web 壳就无法运行。
 * 因此内核只依赖这个接口 —— 它描述的是「外壳能提供什么能力」，
 * 而不是「某个平台有什么 API」。
 *
 * 注意：本包（core）保持零依赖，所以这里只有类型，没有实现。
 * Web 实现见 apps/web，桌面实现见 apps/desktop。
 * 详见 docs/DESKTOP.md。
 */

export interface HostFileRef {
  /** 外壳内部标识（Web 下是句柄或索引，桌面下是路径） */
  id: string;
  name: string;
  size: number;
  /** 最后修改时间，ISO 8601 */
  lastModified?: string;
  /** MIME（若外壳知道） */
  mime?: string;
}

export interface FontInfo {
  family: string;
  bold: boolean;
  italic: boolean;
}

export interface HostMemoryInfo {
  /** 进程/页面可用内存上限（字节），未知为 null */
  budgetBytes: number | null;
  /** 当前已用（字节），未知为 null */
  usedBytes: number | null;
}

/**
 * 外壳适配器。
 *
 * 设计原则：**最小化**。只放内核真的需要、且两种平台确实不同的能力。
 * 任何能由内核自己完成的事（解析、排版、渲染）都不应该出现在这里 ——
 * 一旦把逻辑分叉到壳里，就会出现「桌面版能开、网页版打不开」这类问题。
 */
export interface HostAdapter {
  /** 外壳名称，用于诊断与 UI 展示 */
  readonly name: 'web' | 'desktop' | string;

  /** 让用户选择文件。**只返回引用，不返回内容** —— 大文件的内容要按需读。 */
  pickFiles(options?: { multiple?: boolean; accept?: string }): Promise<HostFileRef[]>;

  /** 读取完整内容。 */
  readFile(ref: HostFileRef | string): Promise<Uint8Array>;

  /**
   * 读取字节区间。
   * 有它才能做到「只读 ZIP 中央目录」而不下载整个文件 ——
   * Web 下用 `Blob.slice`，桌面下用 `File::seek`。
   * 不支持时返回 null，内核会退化为整块读。
   */
  readRange?(ref: HostFileRef | string, start: number, length: number): Promise<Uint8Array | null>;

  /** 保存。返回用户是否真的保存了（取消时为 false）。 */
  saveFile(suggestedName: string, bytes: Uint8Array, mime?: string): Promise<boolean>;

  /** 系统字体清单。Web 下返回 null（浏览器沙箱不允许枚举）。 */
  listFonts?(): Promise<FontInfo[] | null>;

  /** 取字体文件字节，用于文档内嵌字体。 */
  loadFont?(family: string, bold: boolean, italic: boolean): Promise<Uint8Array | null>;

  /** 内存信息，用于自动选择上限档位。 */
  memoryInfo?(): HostMemoryInfo;
}

/** 由内核根据外壳能力推断的上限档位建议 */
export function suggestLimits(host: HostAdapter, base: { conservative: unknown; normal: unknown }): unknown {
  const mem = host.memoryInfo?.();
  // 拿不到内存信息时不猜，用标准档
  if (!mem || mem.budgetBytes === null) return base.normal;
  // 可用内存不足 512 MiB 时切保守档
  return mem.budgetBytes < 512 * 1024 * 1024 ? base.conservative : base.normal;
}
