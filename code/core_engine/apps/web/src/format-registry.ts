/**
 * 格式读取器的注册与「格式支持」视图模型。
 *
 * ## 为什么格式读取器要「动态」导入
 * 并行开发中，`packages/format-docx` 这类包可能还没有 `src/index.ts`。
 * 若在模块顶层静态 import，浏览器在解析阶段直接 404 → **整个应用白屏**，
 * 一个模块缺失拖垮全部功能。用 `import()` + try/catch 则退化成
 * 「那个格式显示未安装读取器」，其余功能完全不受影响 ——
 * 这也把「格式支持是模块化的」这条主张变成了代码里可验证的行为。
 *
 * ## 为什么不用 `import(variable)`
 * 构建器（零打包器、原生 ESM）无法处理变量路径的静态分析，
 * 而且写死字符串能让浏览器/HTTP 缓存精确命中。所以这里用一张
 * 「包名 -> 固定 import 表达式」的表。
 *
 * 约束：零依赖、可擦除 TS 语法、相对路径带 .ts 后缀。
 */
import { FORMATS, coveredFormats, explainReadError, formatsByKind } from '../../../packages/core/src/index.ts';
import type { DocKind, FormatId, FormatSpec } from '../../../packages/core/src/index.ts';

/** 已存在的读取器包目录名（对应 packages/<名字>/src/index.ts） */
export type ReaderPackageName = 'format-text' | 'format-odf' | 'format-pptx' | 'format-docx' | 'format-xlsx' | 'format-pdf';

export interface ReaderInstall {
  /** 包名，用于提示用户「安装哪个包」 */
  pkg: ReaderPackageName;
  /** 人类可读的说明 */
  label: string;
  ok: boolean;
  /** 该包注册的格式（成功时才有） */
  formats?: FormatId[];
  /** 失败原因（不抛给用户看，只用于诊断与状态栏） */
  error?: string;
}

/**
 * 尝试注册所有读取器。
 *
 * 注意这里**逐个 try/catch**：一个包内部报错不应该阻止其他包注册。
 * 目录不存在时浏览器抛的 TypeError 会被捕到，记录成 installed:false。
 */
export async function registerAllReaders(): Promise<ReaderInstall[]> {
  const results: ReaderInstall[] = [];
  for (const entry of READER_TABLE) {
    try {
      const mod = (await entry.load()) as { formats?: readonly FormatId[] } | undefined;
      // 读取器在模块顶层调用 registerReader() 自注册，所以这里只需要
      // 「导入成功」就算注册成功；formats 只是用来展示它负责哪些格式。
      results.push({ pkg: entry.pkg, label: entry.label, ok: true, formats: mod?.formats ? [...mod.formats] : undefined });
    } catch (err) {
      results.push({
        pkg: entry.pkg,
        label: entry.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

const READER_TABLE: Array<{ pkg: ReaderPackageName; label: string; load: () => Promise<unknown> }> = [
  { pkg: 'format-text', label: '纯文本/Markdown/CSV/JSON/HTML', load: () => import('../../../packages/format-text/src/index.ts') },
  { pkg: 'format-odf', label: 'OpenDocument（odt/ods/odp）', load: () => import('../../../packages/format-odf/src/index.ts') },
  { pkg: 'format-pptx', label: 'PowerPoint（pptx）', load: () => import('../../../packages/format-pptx/src/index.ts') },
  { pkg: 'format-docx', label: 'Word（docx）', load: () => import('../../../packages/format-docx/src/index.ts') },
  { pkg: 'format-xlsx', label: 'Excel（xlsx）', load: () => import('../../../packages/format-xlsx/src/index.ts') },
  { pkg: 'format-pdf', label: 'PDF', load: () => import('../../../packages/format-pdf/src/index.ts') },
];

/* ==================================================================== */
/* 格式支持面板的视图模型                                                */
/* ==================================================================== */

export interface FormatSupportRow {
  spec: FormatSpec;
  /** 是否有读取器 */
  supported: boolean;
}

export interface FormatSupportGroup {
  kind: DocKind;
  title: string;
  rows: FormatSupportRow[];
}

const KIND_TITLES: Record<DocKind, string> = {
  text: '文字文档',
  sheet: '表格',
  slides: '演示 / 图形',
  pdf: '固定版式',
  raw: '其他',
};

/**
 * 生成格式支持面板的数据。
 *
 * 「已支持」的判定用 core 的 coveredFormats()（**运行时真实注册表**），
 * 而不是写死一份清单 —— 写死清单的典型后果是 UI 说支持、实际打不开。
 * 单元测试也据此断言 UI 与注册表一致（见 test/render-web.test.ts）。
 */
export function formatSupportGroups(): FormatSupportGroup[] {
  const covered = new Set<FormatId>(coveredFormats());
  const byKind = formatsByKind();
  const order: DocKind[] = ['text', 'sheet', 'slides', 'pdf', 'raw'];
  return order.map((kind) => ({
    kind,
    title: KIND_TITLES[kind],
    rows: (byKind[kind] ?? []).map((spec) => ({ spec, supported: covered.has(spec.id) })),
  }));
}

export interface FormatSupportSummary {
  total: number;
  supported: number;
  installedReaders: number;
  /** 未安装读取器的格式 id（用于状态栏与提示） */
  missing: FormatId[];
}

/**
 * 汇总「格式支持」情况。
 *
 * 关键点：supported / missing 都只在**声明表（FORMATS）这个全集**内计算。
 * 不能直接用 coveredFormats().length 当 supported —— 读取器声明的格式 id
 * 可能包含声明表里没有项的（实测中发现 format-pptx 声明了 potx、xltx，
 * 而这两者在 FORMATS 里只是别的条目的扩展名）。那样会出现
 * 「已支持 29 + 未安装 5 = 34 > 声明总数 32」这种自相矛盾的数字，
 * 用户一眼就会觉得统计不可信。
 * 另外，读取器声明了声明表之外的格式属于读取器侧的问题，
 * 这里不隐藏它：记进 extraReaderFormats 供诊断。
 */
export function formatSupportSummary(installs: readonly ReaderInstall[]): FormatSupportSummary {
  const declared = FORMATS.filter((f) => f.id !== 'unknown');
  const declaredIds = new Set<FormatId>(declared.map((f) => f.id));
  const covered = new Set<FormatId>(coveredFormats());
  let supported = 0;
  const missing: FormatId[] = [];
  for (const spec of declared) {
    if (covered.has(spec.id)) supported++;
    else missing.push(spec.id);
  }
  return {
    total: declared.length,
    supported,
    installedReaders: installs.filter((i) => i.ok).length,
    missing,
  };
}

/** 读取器声明了但不在 FORMATS 声明表里的格式 id（诊断用，说明读取器侧需要同步） */
export function extraReaderFormats(): FormatId[] {
  const declaredIds = new Set<FormatId>(FORMATS.map((f) => f.id));
  return coveredFormats().filter((id): id is FormatId => !declaredIds.has(id));
}

/** 状态栏一行：已安装 N 个格式读取器 / 支持 M 种格式 */
export function readersStatusText(installs: readonly ReaderInstall[]): string {
  const s = formatSupportSummary(installs);
  return `读取器 ${s.installedReaders} 个 · 支持 ${s.supported}/${s.total} 种格式`;
}

/**
 * 打开失败时的人话提示。
 *
 * 这里**先看 code 再看 instanceof**：真实路径上抛出的确实是 core 的 ReadError
 * 实例，但错误也可能经过 postMessage / 序列化 / 被包装后到达 UI（那时
 * instanceof 会失效）。按 code 判定更鲁棒，也不会漏掉人话解释。
 * 另外在「缺读取器」时补上安装建议 —— 这是产品差异点：
 * 别的查看器只会说「打不开」。
 */
export function friendlyOpenError(err: unknown, formatHint?: FormatId): string {
  const code = (err as { code?: string } | undefined)?.code;
  const format = formatHint ?? (err as { format?: FormatId } | undefined)?.format;
  const base = code ? explainByCode(code, err, format) : explainReadError(err);
  if (code === 'NO_READER' || code === 'LEGACY_BINARY') {
    const pkg = recommendReaderPackage(format);
    return pkg ? `${base} 建议安装读取器包：${pkg}` : base;
  }
  return base;
}

/** explainReadError 的 code 分支（与 core 保持同一套文案，避免两处漂移） */
function explainByCode(code: string, err: unknown, format: FormatId | undefined): string {
  switch (code) {
    case 'NO_READER':
      return `暂不支持打开该格式（${format ?? '未知'}）。LiteOffice 的格式支持是模块化的，安装对应的读取器包即可。`;
    case 'TOO_LARGE':
      return '文件超过当前内存上限。可调整上限或使用低内存模式后重试。';
    case 'ENCRYPTED':
      return '该文档已加密/受密码保护，当前版本不支持解密。';
    case 'CORRUPT':
      return '文件结构损坏或不是有效的文档。';
    case 'LEGACY_BINARY':
      return '这是 Office 97-2003 的旧版二进制格式，当前版本尚不支持。建议先用任意 Office 另存为 docx/xlsx/pptx 或 odt/ods/odp 后再打开。';
    default:
      return explainReadError(err);
  }
}

/** 按格式推荐读取器包名（用于「安装对应读取器」提示） */
export function recommendReaderPackage(format: FormatId | undefined): string | null {
  if (!format || format === 'unknown') return null;
  const spec = FORMATS.find((f) => f.id === format);
  if (!spec) return null;
  switch (spec.family) {
    case 'ooxml':
      if (format === 'pptx' || format === 'pptm' || format === 'potx') return 'format-pptx';
      if (format === 'xlsx' || format === 'xlsm' || format === 'xltx') return 'format-xlsx';
      return 'format-docx';
    case 'odf':
      return 'format-odf';
    case 'pdf':
      return 'format-pdf';
    case 'text':
    case 'markup':
      return 'format-text';
    default:
      return null;
  }
}

export { explainReadError };
