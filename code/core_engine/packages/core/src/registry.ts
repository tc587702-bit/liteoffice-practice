/**
 * 读取器注册表。
 *
 * 分层意图：
 *   core 只定义**接口**，不 import 任何具体格式包。
 *   每个格式包在被 import 时调用 registerReader() 自注册。
 * 于是「支持哪些格式」由打包/导入什么决定 —— 不用 PDF 就不必付 PDF 解析器的
 * 体积与内存代价。这也是「轻量化」在架构上的体现，而不是靠裁剪功能列表。
 */
import type { FormatId, LiteDocument } from './model.ts';
import type { LimitGuard, Limits } from './limits.ts';

/**
 * 容器访问的窄接口。
 * 故意不 import @liteoffice/zip —— core 保持零依赖；
 * ZipReader 结构上直接满足这个接口，无需适配层。
 */
export interface ContainerAccess {
  readonly entryNames: readonly string[];
  has(name: string): boolean;
  entrySize(name: string): number;
  read(name: string): Promise<Uint8Array>;
  text(name: string): Promise<string>;
  stream(name: string): ReadableStream<Uint8Array>;
  streamText(name: string): ReadableStream<string>;
}

export interface ReadProgress {
  phase: string;
  done: number;
  total?: number;
}

export interface ReadContext {
  /** 文件名（含扩展名），用于元数据与降级推断 */
  readonly name: string;
  /** 字节数 */
  readonly size: number;
  /**
   * 嗅探器判定的格式。
   *
   * 为什么需要它：嗅探是**内容优先**的，因此可能与文件扩展名不一致
   * （把 CSV 存成 .txt、把 ODF 存成 .docx 都很常见）。
   * 如果一个读取器声明了多个格式（例如 `['csv','tsv']`），它若靠**文件名**
   * 反推具体格式，就会与嗅探结论打架 —— 表现是格式徽标显示错、元数据标错。
   * 因此读取器应当优先使用这个字段，只在它缺失时才退回按扩展名推断。
   *
   * 可选是为了保持向后兼容：老读取器不读它也能工作。
   */
  readonly format?: FormatId;
  /** 原始字节（惰性，可能只被读一次） */
  bytes(): Promise<Uint8Array>;
  /**
   * 打开 ZIP 容器。非 zip 类格式不调用，因此不会付出解压目录的代价。
   * zip 类格式应当**只调用一次**并复用。
   */
  container?(): Promise<ContainerAccess>;
  readonly limits: Limits;
  readonly guard: LimitGuard;
  readonly signal?: AbortSignal;
  onProgress?(p: ReadProgress): void;
  /** 读取阶段的计时器，用于 stats.phases */
  phase<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}

export interface FormatReader {
  /** 读取器标识，用于日志与诊断 */
  readonly id: string;
  /** 该读取器负责的格式 */
  readonly formats: readonly FormatId[];
  /**
   * 读取为统一文档模型。
   *
   * 契约要求：
   *   - 绝不因为某个不支持的子特性而抛错；降级处理并写入 stats.warnings
   *   - 超过 limits 时截断并写入 stats.truncated
   *   - 必须在 stats.parseMs / stats.modelBytes 中如实报告
   */
  read(ctx: ReadContext): Promise<LiteDocument>;
}

const REGISTRY: FormatReader[] = [];

export function registerReader(reader: FormatReader): void {
  if (REGISTRY.some((r) => r.id === reader.id)) return;
  REGISTRY.push(reader);
}

export function allReaders(): readonly FormatReader[] {
  return REGISTRY;
}

export function readerForFormat(id: FormatId): FormatReader | undefined {
  return REGISTRY.find((r) => r.formats.includes(id));
}

/** 已安装读取器覆盖的格式集合 */
export function coveredFormats(): FormatId[] {
  const set = new Set<FormatId>();
  for (const r of REGISTRY) for (const f of r.formats) set.add(f);
  return [...set];
}

/** 尚未安装读取器的格式（UI 可据此显示「暂不支持」而不是「打不开」） */
export function unreadableFormats(declared: readonly FormatId[]): FormatId[] {
  return declared.filter((f) => f !== 'unknown' && !readerForFormat(f));
}

/** 抛出的读取错误统一类型，便于 UI 给出人话提示 */
export class ReadError extends Error {
  readonly code: string;
  readonly format: FormatId | undefined;

  constructor(message: string, code: string, format?: FormatId) {
    super(message);
    this.name = 'ReadError';
    this.code = code;
    this.format = format;
  }
}

/** 常见错误的友好解释 */
export function explainReadError(err: unknown): string {
  if (err instanceof ReadError) {
    switch (err.code) {
      case 'NO_READER':
        return `暂不支持打开该格式（${err.format ?? '未知'}）。LiteOffice 的格式支持是模块化的，安装对应的读取器包即可。`;
      case 'TOO_LARGE':
        return '文件超过当前内存上限。可在设置中调整上限，或使用「低内存模式」后重试。';
      case 'ENCRYPTED':
        return '该文档已加密/受密码保护，当前版本不支持解密。';
      case 'CORRUPT':
        return '文件结构损坏或不是有效的文档。';
      case 'LEGACY_BINARY':
        return '这是 Office 97-2003 的旧版二进制格式，不是 ZIP 包结构，当前版本尚不支持。建议先用任意 Office 另存为 docx/xlsx/pptx 或 odt/ods/odp 后再打开。';
      default:
        return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
