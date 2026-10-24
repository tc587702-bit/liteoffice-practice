/**
 * 打开编排：字节 -> 嗅探 -> 派发读取器 -> UDM 文档。
 *
 * 设计要点：
 *   - 字节与容器都是**惰性**的：嗅探只需要文件头，非 zip 格式永不付解压代价
 *   - 阶段计时直接落进 stats.phases，让「慢在哪」可被观测而不是靠猜
 *   - 任何读取器抛错都被包成 ReadError 并附带人话解释，UI 不需要认识底层异常
 */
import { ZipReader, ZipError } from '../../zip/src/index.ts';
import {
  LimitGuard,
  estimateDocumentBytes,
  formatSpec,
  now,
  readerForFormat,
  ReadError,
  withLimits,
} from '../../core/src/index.ts';
import type { FormatId, LiteDocument, Limits } from '../../core/src/index.ts';
import type { ContainerAccess, ReadContext, ReadProgress } from '../../core/src/registry.ts';
import { sniffFormat } from './sniff.ts';
import type { SniffResult } from './sniff.ts';

export interface OpenInput {
  /** 文件名（含扩展名），用于嗅探兜底与元数据展示 */
  name: string;
  /** 已知字节。与 blob 二选一。 */
  bytes?: Uint8Array | ArrayBuffer;
  /** 惰性字节来源（浏览器 File/Blob）。与 bytes 二选一。 */
  blob?: Blob;
  /** 外部提供的 MIME（File.type） */
  mime?: string;
}

export interface OpenOptions {
  limits?: Partial<Limits>;
  signal?: AbortSignal;
  onProgress?: (p: ReadProgress) => void;
  /** 跳过嗅探并强制使用指定格式（高级用法，例如用户手动指定） */
  forceFormat?: FormatId;
}

export interface OpenResult {
  document: LiteDocument;
  sniff: SniffResult;
  /** 从字节到模型的墙钟耗时 */
  totalMs: number;
}

async function toBytes(input: OpenInput): Promise<Uint8Array> {
  if (input.bytes) return input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  if (input.blob) return new Uint8Array(await input.blob.arrayBuffer());
  throw new ReadError('未提供文件内容', 'NO_BYTES');
}

/**
 * 打开一份文档。
 *
 * 契约：
 *   - 支持上限保护（limits），超限时读取器应降级并写 warnings/truncated
 *   - 未安装对应读取器时抛 ReadError('NO_READER')，附上格式名，
 *     UI 可以据此提示「安装 XXX 读取器」而不是笼统地说打不开
 */
export async function openDocument(input: OpenInput, options: OpenOptions = {}): Promise<OpenResult> {
  const started = now();
  const limits = withLimits(options.limits);
  const guard = new LimitGuard(limits);

  // 惰性单次求值
  let bytesPromise: Promise<Uint8Array> | null = null;
  const getBytes = (): Promise<Uint8Array> => (bytesPromise ??= toBytes(input));

  let containerPromise: Promise<ContainerAccess> | null = null;
  const getContainer = (): Promise<ContainerAccess> => {
    containerPromise ??= (async () => {
      const bytes = await getBytes();
      try {
        const zip = ZipReader.open(bytes, {
          maxEntryBytes: limits.maxEntryBytes,
          maxEntries: 200_000,
        });
        // 刻意**不**把「N 个条目 / 解压后 X 字节」写进 warnings。
        // warnings 的语义是「用户需要知道的降级」，把它当诊断日志用会让降级清单
        // 被噪音淹没 —— 实测 119 个真实文件里有 103 个被标成「有降级」，
        // 而其中绝大多数只是这条容器信息。真正的降级（丢了页眉版式、脚注挪到末尾）
        // 因此完全看不见。需要容器信息请用 stats.phases 或专门的诊断通道。
        void zip;
        return zip;
      } catch (err) {
        if (err instanceof ZipError) throw new ReadError(err.message, 'CORRUPT');
        throw err;
      }
    })();
    return containerPromise;
  };

  const phases: Record<string, number> = {};
  const phase = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const t0 = now();
    try {
      return await fn();
    } finally {
      phases[name] = (phases[name] ?? 0) + (now() - t0);
    }
  };

  // ---- 1. 尺寸与上限检查 ----
  const head = await phase('read', async () => {
    if (input.blob) {
      const size = input.blob.size;
      if (size > limits.maxFileBytes) {
        throw new ReadError(
          `文件 ${size} 字节超过上限 ${limits.maxFileBytes} 字节`,
          'TOO_LARGE',
        );
      }
      // 只需要头部做嗅探；ZIP 判定另行打开容器
      const slice = input.blob.slice(0, 65536);
      return new Uint8Array(await slice.arrayBuffer());
    }
    const bytes = await getBytes();
    if (bytes.length > limits.maxFileBytes) {
      throw new ReadError(`文件 ${bytes.length} 字节超过上限 ${limits.maxFileBytes} 字节`, 'TOO_LARGE');
    }
    return bytes.subarray(0, Math.min(bytes.length, 65536));
  });

  const size = input.blob ? input.blob.size : (await getBytes()).length;

  // ---- 2. 嗅探 ----
  const sniff = await phase('sniff', async (): Promise<SniffResult> => {
    if (options.forceFormat) {
      const spec = formatSpec(options.forceFormat);
      return { format: options.forceFormat, spec, confidence: 1, reason: '调用方强制指定' };
    }
    // ZIP 家族需要容器才能权威判定；先看魔数，避免为非 zip 文件白开容器
    const isZip =
      head.length >= 4 &&
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
    let container: ContainerAccess | undefined;
    if (isZip) {
      try {
        container = await getContainer();
      } catch {
        /* 容器打开失败交给后续读取器报错，这里先按扩展名判定 */
      }
    }
    return sniffFormat(head, input.name, { mime: input.mime, container });
  });

  // ---- 3. 派发 ----
  const reader = readerForFormat(sniff.format);
  if (!reader) {
    if (sniff.spec.family === 'legacy') {
      throw new ReadError(sniff.spec.label, 'LEGACY_BINARY', sniff.format);
    }
    throw new ReadError(`没有可用的 ${sniff.spec.label} 读取器`, 'NO_READER', sniff.format);
  }

  const ctx: ReadContext = {
    name: input.name,
    size,
    // 把嗅探结论交给读取器。声明了多格式的读取器（如 csv|tsv）必须用它来落定
    // 具体格式，而不是从文件名反推 —— 嗅探是内容优先的，两者可能不一致。
    format: sniff.format,
    bytes: getBytes,
    container: getContainer,
    limits,
    guard,
    signal: options.signal,
    onProgress: options.onProgress,
    phase,
  };

  let document: LiteDocument;
  try {
    document = await reader.read(ctx);
  } catch (err) {
    if (err instanceof ReadError) throw err;
    throw new ReadError(
      `读取 ${sniff.spec.label} 失败：${err instanceof Error ? err.message : String(err)}`,
      'CORRUPT',
      sniff.format,
    );
  }

  // ---- 4. 收尾统计 ----
  // 就地补全 stats，而不是 {...document} 重建对象：
  // 展开会丢掉 dispose() 方法，并把 truncated 这个 getter 固化成快照值。
  const snap = guard.snapshot();
  const stats = document.stats;
  stats.sourceBytes = size;
  stats.parseMs = now() - started;

  /*
   * `modelBytes` 由**框架**统一计算，不信任读取器自报的值。
   *
   * 理由（都是实测出来的）：
   *   - CSV 读取器自报 **278 字节**，而 core 的下界估算是 **576 KiB** —— 差 2000 倍。
   *     它只估了正文结构，漏掉了表格数据。
   *   - PDF 读取器自报 **38 MiB**，恰好等于该文档 38,905 KiB 的图片字节 ——
   *     它把像素数据算进了模型体积，而 `stats.imageBytes` 已经单独统计过，成了重复计入。
   *
   * 两个读取器朝相反方向错，说明「让每个读取器自己算」这条路不可靠：
   * 同一个指标在不同格式之间不可比，也就失去了意义。
   * 因此改为框架统一计算（`estimateDocumentBytes` 会通过 Grid.estimateBytes() 看到表格数据，
   * 并在估算幻灯片/PDF 时剥离图片字节）。读取器若自报了差异悬殊的值，
   * 记一条 warning 让作者去修，但**不用它**。
   */
  const measured = estimateDocumentBytes(document);
  const claimed = stats.modelBytes;
  stats.modelBytes = measured;
  if (typeof claimed === 'number' && claimed > 0) {
    const ratio = measured / claimed;
    if (ratio > 5 || ratio < 0.2) {
      stats.warnings.push(
        `读取器自报的 modelBytes=${claimed} 与框架估算=${measured} 相差 ${ratio > 1 ? `${ratio.toFixed(1)}×` : `1/${(1 / ratio).toFixed(1)}`}；` +
          `已采用框架估算（读取器可能漏算表格数据，或把图片字节算进了模型体积 —— 图片体积应只记在 imageBytes）`,
      );
    }
  }

  stats.warnings = [...new Set([...stats.warnings, ...snap.warnings])];
  stats.truncated = [...new Set([...stats.truncated, ...snap.truncated])];
  stats.phases = { ...phases, ...(stats.phases ?? {}) };

  return { document, sniff, totalMs: now() - started };
}

/** 便利：从本地路径读取（仅 Node）。浏览器下请用 openBlob。 */
export async function openFile(path: string, options: OpenOptions = {}): Promise<OpenResult> {
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const bytes = new Uint8Array(await readFile(path));
  return openDocument({ name: basename(path), bytes }, options);
}

/** 便利：从 Blob/File 读取（浏览器）。 */
export function openBlob(file: Blob & { name?: string }, options: OpenOptions = {}): Promise<OpenResult> {
  return openDocument({ name: file.name ?? 'untitled', blob: file, mime: file.type || undefined }, options);
}
