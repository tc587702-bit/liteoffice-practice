/**
 * docx 读取器主流程（FormatId：docx / docm / dotx）。
 *
 * 顺序（每一步都可降级，任何一步失败都不会让整篇打不开）：
 *   容器 -> [Content_Types] -> 根关系 -> 主文档部件 -> 文档关系
 *        -> styles / numbering / theme（正文解析的前置）
 *        -> 元数据（core/app）
 *        -> 正文块（body）
 *        -> 页眉页脚、脚注尾注、批注
 *        -> 页面设置、大纲、统计
 *
 * 「不硬编码部件路径」是这里最重要的一条纪律：主文档、样式、编号、主题、图片
 * 全部通过 `.rels` 的关系类型解析。真实文件里主文档可能不叫 document.xml，
 * 图片也可能不在 word/media/。只有关系缺失时才回退到约定路径，并且**记录警告**。
 */
import {
  countWords,
  createDocument,
  estimateBytes,
  formatSpec,
  now,
  outlineFromBlocks,
  ReadError,
} from '../../core/src/index.ts';
import type { Block, DocMeta, FormatId, LiteDocument, Paragraph, Run } from '../../core/src/index.ts';
import type { ContainerAccess, FormatReader, ReadContext } from '../../core/src/registry.ts';
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import {
  DEFAULT_OFFICE_THEME,
  EMPTY_NUMBERING,
  EMPTY_WORD_STYLES,
  attr,
  findRelByType,
  findRelsByType,
  parseContentTypes,
  parseNumbering,
  parseTheme,
  parseWordStyles,
  relsPathFor,
  REL,
} from '../../ooxml/src/index.ts';
import type { ContentTypes, Relationship } from '../../ooxml/src/index.ts';
import { createEnv, errText, partText, relsOf, warn, withPart, type DocxEnv } from './env.ts';
import { blocksText, parseBlocksAt, parseBlockList, parseNotesPart, resolvePctTableWidths } from './body.ts';
import { parseAppProps, parseCoreProps } from './meta.ts';

/* ==================================================================== */
/* 读取器对象                                                            */
/* ==================================================================== */

export const docxReader: FormatReader = {
  id: 'format-docx',
  formats: ['docx', 'docm', 'dotx'],
  read: readDocx,
};

/* ==================================================================== */
/* 主流程                                                                */
/* ==================================================================== */

export async function readDocx(ctx: ReadContext): Promise<LiteDocument> {
  const t0 = now();
  if (!ctx.container) throw new ReadError('docx 需要 ZIP 容器，但读取上下文未提供', 'CORRUPT', 'docx');

  let container: ContainerAccess;
  try {
    // 契约要求：只调用一次并复用（重复 open 会重复解析中央目录）
    container = await ctx.container();
  } catch (err) {
    throw new ReadError(`无法打开 docx 容器（文件可能已损坏或不是 ZIP 包）：${errText(err)}`, 'CORRUPT', 'docx');
  }

  const types = await loadContentTypes(container);
  const env = createEnv({
    container,
    types,
    styles: EMPTY_WORD_STYLES,
    numbering: EMPTY_NUMBERING,
    theme: DEFAULT_OFFICE_THEME,
    limits: ctx.limits,
    guard: ctx.guard,
  });

  /* ---- 1. 主文档部件：一律走关系解析 ---- */
  const rootRels = await ctx.phase('docx:rels', () => relsOf(env, '', '_rels/.rels'));
  const mainPart = await resolveMainPart(env, rootRels);
  const format = detectFormat(ctx.name, types, mainPart);
  if (!mainPart || !container.has(mainPart)) {
    throw new ReadError(`docx 包内找不到主文档部件（关系声明为 ${mainPart ?? '无'}）`, 'CORRUPT', format);
  }
  const docRels = await relsOf(env, mainPart, relsPathFor(mainPart));
  if (!docRels.size) warn(env, '主文档没有任何关系（.rels 缺失），样式/图片/超链接可能全部取不到');
  env.rels = docRels;
  ctx.onProgress?.({ phase: 'docx:parts', done: 1, total: 4 });

  /* ---- 2. 样式 / 编号 / 主题：正文解析的前置 ---- */
  await ctx.phase('docx:styles', async () => {
    env.styles = await loadStyles(env, docRels);
    env.numbering = await loadNumbering(env, docRels);
    env.theme = await loadTheme(env, docRels);
  });
  ctx.onProgress?.({ phase: 'docx:parts', done: 2, total: 4 });

  /* ---- 3. 元数据 ---- */
  const meta = await ctx.phase('docx:meta', () => loadMeta(env, rootRels));

  /* ---- 4. 正文 ---- */
  const blocks: Block[] = [];
  await ctx.phase('docx:body', async () => {
    const xml = await partText(env, mainPart);
    if (xml === null) {
      warn(env, `主文档部件 ${mainPart} 读取失败，文档将为空`);
      return;
    }
    try {
      await parseBlocksAt(xml, env, ['body'], blocks);
    } catch (err) {
      // 畸形 XML 不能让整篇打不开：保留已解析出的块，记警告继续
      warn(env, `正文解析在第 ${blocks.length} 个块处中断（文件可能被截断）：${errText(err)}`);
    }
    // 页面尺寸（来自正文末尾的 sectPr）此时才齐，回填百分比表格宽度
    resolvePctTableWidths(env);
  });
  ctx.onProgress?.({ phase: 'docx:parts', done: 3, total: 4 });

  /* ---- 5. 页眉页脚 / 脚注尾注 / 批注 ---- */
  await ctx.phase('docx:extras', async () => {
    await loadHeadersFooters(env, docRels, meta);
    await loadNotes(env, docRels, blocks, meta);
    await loadComments(env, docRels, meta);
  });
  ctx.onProgress?.({ phase: 'docx:parts', done: 4, total: 4 });

  /* ---- 6. 页面设置 / 大纲 / 统计 ---- */
  if (env.page.widthPt) meta.pageWidth = env.page.widthPt;
  if (env.page.heightPt) meta.pageHeight = env.page.heightPt;
  if (env.page.margin) meta.margin = env.page.margin;
  if (env.sectionCount > 1) warn(env, `文档含 ${env.sectionCount} 个节，页面设置只反映最后一节`);

  // app.xml 的统计值常常是 0（Word for Mac 就不算），因此统一用「本地解析结果」兜底：
  // 宁可给出我们真实数出来的数字，也不要照抄一个错误的 0。
  const counted = countWords(blocks);
  if (!meta.paragraphCount) meta.paragraphCount = countParagraphs(blocks);
  if (!meta.wordCount) meta.wordCount = counted.words;
  if (!meta.charCount) meta.charCount = counted.chars;

  const outline = outlineFromBlocks(blocks);
  const guardSnap = ctx.guard.snapshot();
  const unknownList = env.unknown.size ? [`跳过了不认识的元素：${[...env.unknown].slice(0, 30).join(', ')}`] : [];
  const parseMs = now() - t0;

  return createDocument({
    kind: 'text',
    format,
    formatLabel: formatSpec(format).label,
    name: ctx.name,
    meta,
    outline,
    stats: {
      parseMs,
      modelBytes: estimateBytes({ meta, outline, blocks }),
      sourceBytes: ctx.size,
      blockCount: blocks.length,
      cellCount: env.cellCount,
      shapeCount: 0,
      imageCount: env.imageCount,
      imageBytes: env.imageBytes,
      warnings: [...env.warnings, ...unknownList, ...guardSnap.warnings],
      truncated: [...guardSnap.truncated],
      phases: { 'docx:total': parseMs },
    },
    blocks,
  });
}

/* ==================================================================== */
/* 部件定位                                                              */
/* ==================================================================== */

async function loadContentTypes(container: ContainerAccess): Promise<ContentTypes | undefined> {
  if (!container.has('[Content_Types].xml')) return undefined;
  try {
    return parseContentTypes(await container.text('[Content_Types].xml'));
  } catch {
    return undefined;
  }
}

/** 通过根关系找主文档部件；关系缺失时才回退到约定路径（并记警告）。 */
async function resolveMainPart(env: DocxEnv, rootRels: Map<string, Relationship>): Promise<string | undefined> {
  const rel = findRelByType(rootRels, REL.officeDocument) ?? findRelByType(rootRels, REL.package);
  if (rel && env.container.has(rel.target)) return rel.target;
  if (rel) warn(env, `根关系指向的主文档 ${rel.target} 不在包内`);
  for (const candidate of ['word/document.xml', 'word/document2.xml']) {
    if (env.container.has(candidate)) {
      warn(env, `未通过关系找到主文档部件，回退到约定路径 ${candidate}`);
      return candidate;
    }
  }
  return rel?.target;
}

/**
 * 格式判定：先看主部件的内容类型（权威），再看扩展名。
 * docm / dotx 的解析流程与 docx 完全一致，只是声明的格式不同 ——
 * 用户在标题栏看到的标签与「另存为」行为需要区分，所以这里如实判定。
 * 注意顺序：先判 template 再判 macroEnabled，否则 .dotm（模板+宏）会被误判成 docm。
 */
function detectFormat(name: string, types: ContentTypes | undefined, mainPart: string | undefined): FormatId {
  if (types && mainPart) {
    const ct = types.overrides.get(mainPart)?.toLowerCase() ?? '';
    if (ct.includes('template')) return 'dotx';
    if (ct.includes('macroenabled')) return 'docm';
    if (ct.includes('wordprocessingml.document')) return 'docx';
  }
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'dotx' || ext === 'dotm') return 'dotx';
  if (ext === 'docm') return 'docm';
  return 'docx';
}

/** 按关系取部件文本；关系缺失时尝试约定路径并记警告。 */
async function partViaRel(
  env: DocxEnv,
  rels: Map<string, Relationship>,
  shortType: string,
  fallbacks: readonly string[],
): Promise<{ path: string; xml: string } | null> {
  const rel = findRelByType(rels, shortType);
  if (rel && env.container.has(rel.target)) {
    const xml = await partText(env, rel.target);
    if (xml !== null) return { path: rel.target, xml };
    warn(env, `部件 ${rel.target}（关系类型 ${shortType}）读取失败`);
    return null;
  }
  for (const path of fallbacks) {
    if (!env.container.has(path)) continue;
    warn(env, `未通过关系找到 ${shortType} 部件，回退到约定路径 ${path}`);
    const xml = await partText(env, path);
    if (xml !== null) return { path, xml };
  }
  return null;
}

/* ==================================================================== */
/* 样式 / 编号 / 主题                                                     */
/* ==================================================================== */

async function loadStyles(env: DocxEnv, docRels: Map<string, Relationship>) {
  const part = await partViaRel(env, docRels, REL.styles, ['word/styles.xml']);
  if (!part) {
    warn(env, '未找到 styles.xml，所有段落将按 docDefaults 默认格式渲染');
    return EMPTY_WORD_STYLES;
  }
  try {
    const styles = parseWordStyles(part.xml);
    if (!styles.styles.size && !Object.keys(styles.defaultRun).length) {
      warn(env, `styles.xml（${part.path}）没有解析出任何样式`);
    }
    return styles;
  } catch (err) {
    warn(env, `styles.xml 解析失败，改用默认样式：${errText(err)}`);
    return EMPTY_WORD_STYLES;
  }
}

async function loadNumbering(env: DocxEnv, docRels: Map<string, Relationship>) {
  const part = await partViaRel(env, docRels, REL.numbering, ['word/numbering.xml']);
  if (!part) return EMPTY_NUMBERING;
  try {
    return parseNumbering(part.xml);
  } catch (err) {
    warn(env, `numbering.xml 解析失败，列表标记将省略：${errText(err)}`);
    return EMPTY_NUMBERING;
  }
}

async function loadTheme(env: DocxEnv, docRels: Map<string, Relationship>) {
  let part = await partViaRel(env, docRels, REL.theme, []);
  if (!part) {
    // 有些生成器不写主题关系，但部件确实存在：按路径形状找一次
    const guess = env.container.entryNames.find((n) => /(^|\/)theme\/[^/]*\.xml$/i.test(n));
    if (guess) {
      const xml = await partText(env, guess);
      if (xml !== null) {
        warn(env, `未通过关系找到主题部件，按路径 ${guess} 猜测`);
        part = { path: guess, xml };
      }
    }
  }
  if (!part) {
    warn(env, '文档没有主题部件（theme1.xml），主题色（w:themeColor）已用 Office 默认主题近似');
    return DEFAULT_OFFICE_THEME;
  }
  try {
    const theme = parseTheme(part.xml);
    if (theme.size < 8) {
      warn(env, `主题部件 ${part.path} 只解析出 ${theme.size} 个颜色槽位，缺失部分用默认主题填充`);
      for (const [k, v] of DEFAULT_OFFICE_THEME) if (!theme.has(k)) theme.set(k, v);
    }
    return theme;
  } catch (err) {
    warn(env, `主题解析失败，改用默认主题：${errText(err)}`);
    return DEFAULT_OFFICE_THEME;
  }
}

/* ==================================================================== */
/* 元数据                                                                */
/* ==================================================================== */

async function loadMeta(env: DocxEnv, rootRels: Map<string, Relationship>): Promise<DocMeta> {
  const meta: DocMeta = {};
  // 关系短名是 core-properties / extended-properties（见 ooxml/package.ts 的 REL）
  const core = await partViaRel(env, rootRels, REL.coreProperties, ['docProps/core.xml']);
  if (core) {
    try {
      Object.assign(meta, parseCoreProps(core.xml));
    } catch (err) {
      warn(env, `core.xml 解析失败：${errText(err)}`);
    }
  }
  const app = await partViaRel(env, rootRels, REL.extendedProperties, ['docProps/app.xml']);
  if (app) {
    try {
      const parsed = parseAppProps(app.xml);
      // app.xml 与 core.xml 的 custom 要合并而不是互相覆盖
      const custom = { ...(meta.custom ?? {}), ...(parsed.custom ?? {}) };
      Object.assign(meta, parsed);
      if (Object.keys(custom).length) meta.custom = custom;
    } catch (err) {
      warn(env, `app.xml 解析失败：${errText(err)}`);
    }
  }
  return meta;
}

/* ==================================================================== */
/* 页眉页脚 / 脚注尾注 / 批注                                             */
/* ==================================================================== */

/**
 * 页眉页脚：UDM 没有页面框模型，因此只把文字收进 meta.custom（键形如「页眉(default)」），
 * 不塞进 blocks —— 否则正文里会凭空多出几段，字数统计也会失真。
 * 这是**降级但可见**的：内容没丢，只是版式位置没有还原。
 */
async function loadHeadersFooters(env: DocxEnv, docRels: Map<string, Relationship>, meta: DocMeta): Promise<void> {
  const refs: Array<{ kind: 'header' | 'footer'; type: string; target: string }> = [];
  for (const ref of env.headerFooterRefs) {
    const rel = docRels.get(ref.id);
    if (rel && env.container.has(rel.target)) refs.push({ kind: ref.kind, type: ref.type, target: rel.target });
  }
  if (!refs.length) {
    // sectPr 没给引用（或正文里没有 sectPr）：退化为「取全部页眉页脚关系」
    for (const rel of findRelsByType(docRels, REL.header)) refs.push({ kind: 'header', type: 'default', target: rel.target });
    for (const rel of findRelsByType(docRels, REL.footer)) refs.push({ kind: 'footer', type: 'default', target: rel.target });
  }
  if (!refs.length) return;

  const custom: Record<string, string> = { ...(meta.custom ?? {}) };
  let seen = 0;
  for (const ref of refs) {
    const xml = await partText(env, ref.target);
    if (xml === null) continue;
    const rels = await relsOf(env, ref.target, relsPathFor(ref.target));
    const out: Block[] = [];
    await withPart(env, rels, true, async () => {
      try {
        await parseBlocksAt(xml, env, ['hdr', 'ftr'], out);
      } catch (err) {
        warn(env, `页眉/页脚 ${ref.target} 解析中断：${errText(err)}`);
      }
    });
    const text = blocksText(out);
    if (text) custom[`${ref.kind === 'header' ? '页眉' : '页脚'}(${ref.type})`] = text;
    seen++;
  }
  if (seen) {
    meta.custom = custom;
    warn(env, `已解析 ${seen} 个页眉/页脚部件，文字放在 meta.custom（页眉页脚版式未在正文流中还原）`);
  }
}

/**
 * 脚注 / 尾注：正文里已留下 Run.noteRef 引用，注释正文追加到文档末尾。
 * 选择「追加到末尾」而不是「丢弃 + 警告」：注释里常有参考文献编号，丢了就是内容损失。
 */
async function loadNotes(env: DocxEnv, docRels: Map<string, Relationship>, blocks: Block[], meta: DocMeta): Promise<void> {
  for (const kind of ['footnote', 'endnote'] as const) {
    const isFoot = kind === 'footnote';
    const rel = findRelByType(docRels, isFoot ? REL.footnotes : REL.endnotes);
    const fallbacks = isFoot ? ['word/footnotes.xml'] : ['word/endnotes.xml'];
    const path = rel && env.container.has(rel.target) ? rel.target : fallbacks.find((f) => env.container.has(f));
    if (!path) continue;
    const xml = await partText(env, path);
    if (xml === null) continue;
    let notes: Map<string, Block[]>;
    try {
      const rels = await relsOf(env, path, relsPathFor(path));
      notes = await withPart(env, rels, true, () => parseNotesPart(xml, env, isFoot ? 'footnotes' : 'endnotes'));
    } catch (err) {
      warn(env, `${kind} 部件解析失败：${errText(err)}`);
      continue;
    }
    if (!notes.size) continue;
    const label = isFoot ? '脚注' : '尾注';
    const ids = [...notes.keys()].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    for (const id of ids) {
      const text = blocksText(notes.get(id) ?? []);
      if (!text) continue;
      blocks.push(noteParagraph(`${label} ${id}`, text));
    }
    meta.custom = { ...(meta.custom ?? {}), [isFoot ? 'footnoteCount' : 'endnoteCount']: String(notes.size) };
    warn(env, `文档含 ${notes.size} 条${label}，其正文已追加到文档末尾（用 [${label} N] 前缀标记）`);
  }
}

function noteParagraph(label: string, text: string): Paragraph {
  const marker: Run = { text: `[${label}] `, style: { italic: true, color: '#808080', size: 9 } };
  return { kind: 'para', runs: [marker, { text }] };
}

/** 批注：正文里只有锚点，批注正文在 comments.xml。同样收进 meta.custom，不插进正文流。 */
async function loadComments(env: DocxEnv, docRels: Map<string, Relationship>, meta: DocMeta): Promise<void> {
  const part = await partViaRel(env, docRels, REL.comments, ['word/comments.xml']);
  if (!part) return;
  let notes: Map<string, Block[]>;
  try {
    notes = await parseComments(part.xml, env);
  } catch (err) {
    warn(env, `comments.xml 解析失败：${errText(err)}`);
    return;
  }
  if (!notes.size) return;
  const custom: Record<string, string> = { ...(meta.custom ?? {}) };
  for (const [id, noteBlocks] of notes) {
    const text = blocksText(noteBlocks);
    if (text) custom[`批注${id}`] = text;
  }
  meta.custom = custom;
  warn(env, `文档含 ${notes.size} 条批注，批注正文放在 meta.custom（未插入正文流）`);
}

/** comments.xml：结构同 footnotes.xml，根元素叫 comments、条目叫 comment。 */
async function parseComments(xml: string, env: DocxEnv): Promise<Map<string, Block[]>> {
  const out = new Map<string, Block[]>();
  const p = new XmlPullParser(xml, { keepWhitespace: true });
  // 先定位根元素（w:comments），再逐条读 comment
  let e: XmlEvent | null = p.next();
  let found = false;
  while (e !== null) {
    if (e.type === 'start' && e.local === 'comments') {
      if (e.selfClosing) return out;
      found = true;
      break;
    }
    e = p.next();
  }
  if (!found) return out;

  while ((e = p.next()) !== null) {
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    if (e.local !== 'comment') {
      if (!e.selfClosing) p.skipElement();
      continue;
    }
    const id = attr(e, 'id') ?? String(out.size + 1);
    if (e.selfClosing) continue;
    const commentBlocks: Block[] = [];
    await parseBlockList(p, env, commentBlocks);
    out.set(id, commentBlocks);
  }
  return out;
}

/* ==================================================================== */
/* 小工具                                                                */
/* ==================================================================== */

function countParagraphs(blocks: readonly Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.kind === 'para') n++;
    else if (b.kind === 'table') for (const row of b.rows) for (const c of row.cells) n += countParagraphs(c.blocks);
  }
  return n;
}
