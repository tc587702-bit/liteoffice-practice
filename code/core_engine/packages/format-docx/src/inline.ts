/**
 * 段内内容解析：run、字段、超链接、图片（DrawingML 与 VML）、文本框。
 *
 * 关于「域（field）」的取舍，这是 docx 保真度里最容易被忽略的一块：
 *   Word 的域名（PAGE / NUMPAGES / HYPERLINK / TOC …）以 w:instrText 存在正文流里。
 *   若把 instrText 当普通文本输出，用户会在正文里看到
 *   ` HYPERLINK "https://…" ` 这种域代码 —— 一眼就看出渲染器是假的。
 *   因此这里严格区分 begin / separate / end 三段：instrText 只用于解析语义，
 *   绝不进正文；结果段标记 Run.field = true；HYPERLINK 域还会把结果文字变成可点击链接
 *   （真实文件里的超链接绝大多数不是 w:hyperlink 而是 HYPERLINK 域）。
 */
import type { InlineImage, Run, RunStyle } from '../../core/src/model.ts';
import type { Relationship } from '../../ooxml/src/package.ts';
import type { RunProps } from '../../ooxml/src/styles.ts';
import { cssLengthToPt, emuToPt, pxToPt } from '../../core/src/units.ts';
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import {
  applyTheme,
  attr,
  attrNum,
  mergeDefined,
  mimeOf,
  readTextContent,
  resolveRunProps,
} from '../../ooxml/src/index.ts';
import {
  ensureParaStyle,
  errText,
  imageSizePx,
  mimeFromBytes,
  noteUnknown,
  parseAlternateContent,
  readParaPropsExt,
  readRunPropsExt,
  relTarget,
  toRunStyle,
  warnOnce,
  type DocxEnv,
  type FieldFrame,
  type RunPrExt,
  type RunState,
} from './env.ts';

/* ==================================================================== */
/* 段落级内容                                                            */
/* ==================================================================== */

/**
 * 解析 `w:p` 的子元素（也用于 w:hyperlink / w:fldSimple / w:ins / w:sdtContent 等
 * 段落级包装元素的内部）。返回时正好消费掉**当前元素**的结束标签。
 *
 * 关键约定：每个分支都必须把遇到的元素整棵消费掉（readTextContent / skipElement /
 * 递归调用），只有这样才能保证「第一个 end 事件 = 本元素的结束」，
 * 从而不需要额外的深度计数。这是 pull 解析里最容易写错的地方。
 */
export async function parseParagraphContent(p: XmlPullParser, env: DocxEnv, st: RunState): Promise<void> {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) return;
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'pPr':
        if (!e.selfClosing) {
          readParaPropsExt(p, st.ext, env);
          // pPr 一定在 w:p 最前面：顺手把样式与字符基线算出来，
          // 保证后面的 run 拿得到基线，也保证编号计数器只推进一次。
          ensureParaStyle(st, env);
        }
        continue;
      case 'r':
        if (e.selfClosing) continue;
        await parseRun(p, env, st);
        continue;
      case 'hyperlink':
        await parseHyperlink(p, env, st, e);
        continue;
      case 'fldSimple': {
        const instr = attr(e, 'instr') ?? '';
        if (e.selfClosing) {
          finalizeField({ instr, resultStart: st.runs.length, inResult: true }, st, env);
          continue;
        }
        const start = st.runs.length;
        await parseParagraphContent(p, env, st);
        finalizeField({ instr, resultStart: start, inResult: true }, st, env);
        continue;
      }
      case 'ins':
      case 'moveTo':
        warnOnce(env, 'revision-ins', '文档含修订标记（w:ins），已保留插入内容并忽略修订元数据');
        if (!e.selfClosing) await parseParagraphContent(p, env, st);
        continue;
      case 'del':
      case 'moveFrom':
        // 已删除的内容默认丢弃：否则用户会看到「被删掉的文字」而以为文件坏了。
        warnOnce(env, 'revision-del', '文档含修订删除（w:del），已丢弃删除内容（只保留最终稿）');
        if (!e.selfClosing) p.skipElement();
        continue;
      case 'smartTag':
      case 'customXml':
      case 'dir':
      case 'bdo':
      case 'sdt':
      case 'sdtContent':
        if (!e.selfClosing) await parseParagraphContent(p, env, st);
        continue;
      case 'bookmarkStart':
      case 'bookmarkEnd':
      case 'proofErr':
      case 'permStart':
      case 'permEnd':
      case 'lastRenderedPageBreak':
      case 'pPrChange':
      case 'rPrChange':
      case 'insRangeStart':
      case 'insRangeEnd':
      case 'delRangeStart':
      case 'delRangeEnd':
      case 'moveFromRangeStart':
      case 'moveFromRangeEnd':
      case 'moveToRangeStart':
      case 'moveToRangeEnd':
      case 'customXmlInsRangeStart':
      case 'customXmlInsRangeEnd':
      case 'commentRangeStart':
      case 'commentRangeEnd':
        continue; // 纯标记，无内容
      case 'commentReference':
        warnOnce(env, 'comments', '文档含批注（w:commentReference），批注正文见 meta.custom，未插入正文流');
        if (!e.selfClosing) p.skipElement();
        continue;
      default:
        noteUnknown(env, e.local);
        if (!e.selfClosing) p.skipElement();
        continue;
    }
  }
}

async function parseHyperlink(p: XmlPullParser, env: DocxEnv, st: RunState, e: XmlEvent): Promise<void> {
  if (e.selfClosing) return;
  const id = attr(e, 'id');
  const anchor = attr(e, 'anchor');
  const prev = st.link;
  if (id) {
    const rel = env.rels.get(id);
    if (rel) {
      // 外部关系必须用原始 Target（parseRels 会把 URL 当包内路径解析坏掉）
      st.link = relTarget(env, rel);
    } else {
      warnOnce(env, `hl:${id}`, `超链接关系 ${id} 未找到，该链接不可点击`);
      st.link = undefined;
    }
  } else if (anchor) {
    // 内部锚点（跳到书签）：用 #anchor 表达，渲染器按文档内跳转处理
    st.link = `#${anchor}`;
  }
  await parseParagraphContent(p, env, st);
  st.link = prev;
}

/* ==================================================================== */
/* run                                                                   */
/* ==================================================================== */

async function parseRun(p: XmlPullParser, env: DocxEnv, st: RunState): Promise<void> {
  const rp: RunPrExt = {};
  await parseRunContent(p, env, st, rp);
}

/**
 * 解析 run 的**叶子内容**（w:t / w:br / w:drawing / w:fldChar / mc:Choice 内部 ……）。
 * 之所以独立成函数：mc:Choice 里的 `w:drawing` 是直接挂在 Choice 下的，
 * 若用段落级解析器处理 Choice 就会把它当成未知元素跳掉 —— 图片会整批消失。
 */
async function parseRunContent(p: XmlPullParser, env: DocxEnv, st: RunState, rp: RunPrExt): Promise<void> {
  let text = '';
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) break;
    if (e.type === 'end') break;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'rPr':
        if (!e.selfClosing) readRunPropsExt(p, rp);
        continue;
      case 't':
        // xml:space="preserve" 的空格必须在解析器层面保留：
        // XmlPullParser 默认丢弃「全空白文本节点」，而 <w:t xml:space="preserve"> </w:t>
        // 正好就是一个全空白文本节点 —— 用默认选项会让中英之间的空格全部消失。
        // reader.ts 因此以 { keepWhitespace: true } 构造解析器。
        if (!e.selfClosing) text += readTextContent(p);
        continue;
      case 'delText':
        // w:del 的子树在段落层就被丢掉了；万一这里遇到，同样按「已删除」处理
        if (!e.selfClosing) readTextContent(p);
        warnOnce(env, 'deltext', '发现 w:delText（修订删除文本），已丢弃');
        continue;
      case 'br':
      case 'cr': {
        if (attr(e, 'type') === 'page') {
          pushText(st, env, text, rp);
          text = '';
          st.pendingBreak = false;
          // 在事件发生的**这一刻**切段，保证分页符前后的块顺序与原文一致
          st.onPageBreak?.();
        } else {
          pushText(st, env, text, rp);
          text = '';
          st.pendingBreak = true;
        }
        continue;
      }
      case 'tab':
        text += '\t';
        continue;
      case 'noBreakHyphen':
        text += '\u2011';
        continue;
      case 'softHyphen':
        text += '\u00ad';
        continue;
      case 'sym': {
        const cp = Number.parseInt(attr(e, 'char') ?? '', 16);
        if (Number.isFinite(cp)) {
          const mapped = SYMBOL_MAP[cp];
          // 符号字体的字形落在私用区，直接显示会是豆腐块：常见符号做等价映射，
          // 其余按原码位保留（宁可显示异常字符，也不要丢字符）
          if (!mapped) warnOnce(env, 'sym', '符号字体（w:sym）字符无法映射为通用字符，已按原码位保留');
          text += mapped ?? String.fromCodePoint(cp);
        }
        continue;
      }
      case 'drawing':
        pushText(st, env, text, rp);
        text = '';
        if (!e.selfClosing) await parseDrawing(p, env, st);
        continue;
      case 'pict':
        pushText(st, env, text, rp);
        text = '';
        if (!e.selfClosing) await parseVmlChildren(p, env, st, undefined);
        continue;
      case 'object':
        pushText(st, env, text, rp);
        text = '';
        warnOnce(env, 'ole', '文档含嵌入式 OLE 对象（w:object），仅取其预览图/文本框');
        if (!e.selfClosing) await parseVmlChildren(p, env, st, undefined);
        continue;
      case 'fldChar': {
        const type = attr(e, 'fldCharType');
        if (type === 'begin') st.fieldStack.push({ instr: '', resultStart: st.runs.length, inResult: false });
        else if (type === 'separate') {
          const f = topField(st);
          if (f) {
            f.inResult = true;
            f.resultStart = st.runs.length;
          }
        } else if (type === 'end') {
          const f = st.fieldStack.pop();
          if (f) finalizeField(f, st, env);
        }
        continue;
      }
      case 'instrText': {
        const instr = e.selfClosing ? '' : readTextContent(p);
        const f = topField(st);
        if (f) f.instr += instr;
        continue;
      }
      case 'footnoteReference':
      case 'endnoteReference': {
        const id = attr(e, 'id');
        pushText(st, env, text, rp);
        text = '';
        if (id !== undefined) {
          st.runs.push({
            text: '',
            noteRef: { kind: e.local === 'footnoteReference' ? 'footnote' : 'endnote', id },
          });
        }
        continue;
      }
      case 'footnoteRef':
      case 'endnoteRef':
      case 'annotationRef':
      case 'separator':
      case 'continuationSeparator':
        continue; // 脚注正文里的自引用标记，正文流里不渲染
      case 'commentReference':
        warnOnce(env, 'comments', '文档含批注（w:commentReference），批注正文见 meta.custom，未插入正文流');
        if (!e.selfClosing) p.skipElement();
        continue;
      case 'AlternateContent': {
        // Choice（DrawingML）与 Fallback（VML）描述同一个对象，只取其一
        if (e.selfClosing) continue;
        const produced = st.runs.length + st.extraBlocks.length;
        await parseAlternateContent(
          p,
          produced,
          () => st.runs.length + st.extraBlocks.length,
          (pp) => parseRunContent(pp, env, st, rp),
        );
        continue;
      }
      default:
        noteUnknown(env, e.local);
        if (!e.selfClosing) p.skipElement();
        continue;
    }
  }
  pushText(st, env, text, rp);
}

/** 私用区符号的可读等价映射（与 ooxml 的 bullet 映射保持一致的思路）。 */
const SYMBOL_MAP: Record<number, string> = {
  0xf0b7: '\u2022',
  0xf0a7: '\u25aa',
  0xf0fc: '\u2713',
  0xf0fe: '\u2611',
  0xf0a8: '\u25a1',
  0xf075: '\u25c6',
  0xf0e0: '\u2190',
  0xf0e8: '\u2192',
};

/* ==================================================================== */
/* run 拼接、样式、域收尾                                                 */
/* ==================================================================== */

function topField(st: RunState): FieldFrame | undefined {
  return st.fieldStack.length ? st.fieldStack[st.fieldStack.length - 1] : undefined;
}

/** 把一段文本变成 Run 推入当前段落（应用字符样式 + 待处理换行）。 */
function pushText(st: RunState, env: DocxEnv, text: string, rp: RunPrExt): void {
  if (!text) return;
  const run: Run = { text };
  const style = runStyleOf(st, env, rp);
  if (style) run.style = style;
  if (st.pendingBreak) {
    run.breakBefore = true;
    st.pendingBreak = false;
  }
  st.runs.push(run);
}

function runStyleOf(st: RunState, env: DocxEnv, rp: RunPrExt): RunStyle | undefined {
  ensureParaStyle(st, env);
  let merged: RunProps | undefined = st.baseRun ?? {};
  if (rp.styleId) merged = mergeDefined(merged, resolveRunProps(env.styles, rp.styleId));
  merged = mergeDefined(merged, rp);
  if (!merged) merged = {};
  // 主题色补全：Word 里大量颜色只写 themeColor，不补就会全黑
  applyTheme(env.theme, merged);
  return toRunStyle(merged, st.link, env);
}

/**
 * 域结束时的收尾。
 * 注意：st.runs 里的 RunStyle 是**共享实例**（见 env.ts 的 styleCache），
 * 所以给某个 run 加链接时必须克隆样式对象，否则链接会串到所有同款样式的 run 上。
 */
function finalizeField(f: FieldFrame, st: RunState, env: DocxEnv): void {
  const instr = f.instr.replace(/\s+/g, ' ').trim();
  const end = st.runs.length;
  const start = Math.min(f.resultStart, end);
  for (let i = start; i < end; i++) st.runs[i].field = true;
  const link = hyperlinkTargetOf(instr);
  if (link) {
    for (let i = start; i < end; i++) linkRun(st.runs[i], link);
    return;
  }
  if (start === end) {
    // 没有域结果（很多生成器只写 begin/instrText/end）：给可读占位，
    // 既不能让用户看到 "PAGE" 这样的域代码，也不能让页码处一片空白。
    const ph = fieldPlaceholder(instr);
    if (ph) {
      const run: Run = { text: ph, field: true };
      if (st.pendingBreak) {
        run.breakBefore = true;
        st.pendingBreak = false;
      }
      st.runs.push(run);
    } else if (instr) {
      warnOnce(env, 'field-noph', `域 ${instr.split(' ')[0]} 没有结果文本，已跳过（不显示域代码）`);
    }
  }
}

function linkRun(run: Run, link: string): void {
  run.style = run.style ? { ...run.style, link } : { link };
}

/** `HYPERLINK "url"` / `HYPERLINK \l "anchor"` -> 目标（容忍首尾空白） */
export function hyperlinkTargetOf(instr: string): string | undefined {
  const s = instr.trim();
  if (!/^HYPERLINK\b/i.test(s)) return undefined;
  const anchor = /\\l\s+"?([^"\s]+)"?/i.exec(s);
  if (anchor) return `#${anchor[1]}`;
  const quoted = /"([^"]*)"/.exec(s);
  if (quoted) return quoted[1];
  const bare = /^HYPERLINK\s+(\S+)/i.exec(s);
  return bare ? bare[1] : undefined;
}

/** 页码类域给一个可读占位（UDM 是流式模型，不做真实分页计算）。 */
export function fieldPlaceholder(instr: string): string {
  const name = instr.trim().split(/[\s\\]/)[0]?.toUpperCase() ?? '';
  switch (name) {
    case 'PAGE':
    case 'NUMPAGES':
    case 'SECTION':
    case 'SECTIONPAGES':
    case 'PAGEREF':
      return '1';
    default:
      return '';
  }
}

/* ==================================================================== */
/* 图片（DrawingML）                                                      */
/* ==================================================================== */

interface DrawState {
  size?: { w: number; h: number };
  alt?: string;
}

/** `<w:drawing>` 的通用下钻：任何一层里出现 a:blip 或 w:txbxContent 都要处理。 */
async function parseDrawing(p: XmlPullParser, env: DocxEnv, st: RunState): Promise<void> {
  await parseDrawingChildren(p, env, st, {});
}

async function parseDrawingChildren(p: XmlPullParser, env: DocxEnv, st: RunState, ds: DrawState): Promise<void> {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) return;
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'extent': {
        // wp:extent（EMU）是显示尺寸的权威来源
        const cx = attrNum(e, 'cx', NaN);
        const cy = attrNum(e, 'cy', NaN);
        if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) ds.size = { w: emuToPt(cx), h: emuToPt(cy) };
        continue;
      }
      case 'ext': {
        // a:ext 出现在图形内部（组合形状里每个子图各有一份）；只在还没有尺寸时兜底
        if (!ds.size) {
          const cx = attrNum(e, 'cx', NaN);
          const cy = attrNum(e, 'cy', NaN);
          if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) ds.size = { w: emuToPt(cx), h: emuToPt(cy) };
        }
        continue;
      }
      case 'docPr':
      case 'cNvPr': {
        const descr = attr(e, 'descr');
        const name = attr(e, 'name');
        if (descr) ds.alt = descr;
        else if (!ds.alt && name) ds.alt = name;
        continue;
      }
      case 'blip': {
        const embed = attr(e, 'embed');
        const link = attr(e, 'link');
        if (embed) await addImageFromRel(env, st, embed, ds.size, ds.alt);
        else if (link) warnOnce(env, 'blip-link', '图片为外部链接（a:blip r:link），未加载字节，仅保留占位');
        continue;
      }
      case 'txbxContent': {
        if (e.selfClosing) continue;
        // UDM 里没有「浮动文本框」这一概念：按文档顺序展开成普通段落，
        // 保证文字不丢失（宁可位置不精确，也不要静默丢内容）。
        warnOnce(env, 'txbx', '文本框（w:txbxContent）内容已按文档顺序展开为普通段落，浮动位置未保留');
        if (st.blockParser) await st.blockParser(p, st.extraBlocks);
        else p.skipElement();
        continue;
      }
      case 'chart':
        warnOnce(env, 'chart', '文档含图表（c:chart），当前版本不渲染图表');
        if (!e.selfClosing) p.skipElement();
        continue;
      case 'graphic':
      case 'graphicData':
      case 'pic':
      case 'sp':
      case 'wsp':
      case 'grpSp':
      case 'wgp':
      case 'inline':
      case 'anchor':
      case 'blipFill':
      case 'spPr':
      case 'grpSpPr':
      case 'txbx':
      case 'nvPicPr':
      case 'nvGraphicFramePr':
      case 'cNvGraphicFramePr':
      case 'picLocks':
      case 'style':
      case 'bodyPr':
        if (!e.selfClosing) await parseDrawingChildren(p, env, st, ds);
        continue;
      default:
        if (!e.selfClosing) p.skipElement();
        continue;
    }
  }
}

/* ==================================================================== */
/* 图片（VML，旧式 w:pict）                                               */
/* ==================================================================== */

/** `w:pict` 与 `w:object` 共用：都是 VML 子树，靠 v:imagedata / v:textbox 找内容。 */
async function parseVmlChildren(
  p: XmlPullParser,
  env: DocxEnv,
  st: RunState,
  size: { w: number; h: number } | undefined,
): Promise<void> {
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (env.stopped) return;
    if (e.type === 'end') return;
    if (e.type !== 'start') continue;
    switch (e.local) {
      case 'imagedata': {
        // VML 用 r:id（少数生成器写 o:relid）
        const id = attr(e, 'id') ?? attr(e, 'relid');
        await addImageFromRel(env, st, id, size, undefined);
        continue;
      }
      case 'txbxContent': {
        if (e.selfClosing) continue;
        warnOnce(env, 'txbx', '文本框（w:txbxContent）内容已按文档顺序展开为普通段落，浮动位置未保留');
        if (st.blockParser) await st.blockParser(p, st.extraBlocks);
        else p.skipElement();
        continue;
      }
      case 'shape':
      case 'rect':
      case 'roundrect':
      case 'oval':
      case 'image':
      case 'line':
      case 'polyline':
      case 'arc':
      case 'curve':
      case 'group':
      case 'shapetype':
      case 'textbox':
      case 'textpath': {
        if (e.selfClosing) continue;
        // VML 的尺寸直接写在 style="width:464.25pt;height:38.25pt" 里（已经是 pt）
        await parseVmlChildren(p, env, st, sizeFromStyle(e) ?? size);
        continue;
      }
      default:
        if (!e.selfClosing) p.skipElement();
        continue;
    }
  }
}

/** 解析 VML 的 style 属性里的 width/height（pt / cm / mm / in / px 都能吃）。 */
function sizeFromStyle(e: XmlEvent): { w: number; h: number } | undefined {
  const style = attr(e, 'style');
  if (!style) return undefined;
  const wm = /(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style);
  const hm = /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(style);
  if (!wm || !hm) return undefined;
  const w = cssLengthToPt(wm[1].trim(), 0);
  const h = cssLengthToPt(hm[1].trim(), 0);
  return w > 0 && h > 0 ? { w, h } : undefined;
}

/* ==================================================================== */
/* 图片加载                                                              */
/* ==================================================================== */

/**
 * 把一次图片引用变成 InlineImage。
 *
 * 内存策略：
 *   - 同一个部件被引用多次时只解压一份，多个 run 共享同一个 Uint8Array
 *     （真实文档里同一张图被引用 20 次很常见，逐次 read() 会直接复制 20 份）
 *   - 超过 maxImages / maxImageBytes 时**不加载字节**，只留尺寸与 MIME + warning
 *   - 页眉/页脚/脚注走 textOnly，同样不加载字节
 */
async function addImageFromRel(
  env: DocxEnv,
  st: RunState,
  relId: string | undefined,
  size: { w: number; h: number } | undefined,
  alt: string | undefined,
): Promise<void> {
  env.imageCount++; // 统计「图片出现次数」，与「加载了几个部件」是两件事
  if (!relId) {
    warnOnce(env, 'img-norel', '发现没有关系 id 的图片引用（可能是 VML 预览），已跳过');
    return;
  }
  const rel: Relationship | undefined = env.rels.get(relId);
  if (!rel) {
    warnOnce(env, `img:${relId}`, `图片关系 ${relId} 不存在，该图片已跳过（部件可能被第三方工具改名）`);
    return;
  }
  if (rel.mode === 'External') {
    warnOnce(env, `imgext:${relId}`, `图片是外部链接（${relTarget(env, rel)}），未加载字节，仅保留占位`);
    return;
  }

  const part = rel.target;
  let data: Uint8Array | undefined;
  if (!env.container.has(part)) {
    warnOnce(env, `imgpart:${part}`, `图片部件 ${part} 不在包内，该图片已跳过`);
  } else if (env.textOnly) {
    warnOnce(env, 'img-textonly', '页眉/页脚/脚注中的图片只保留尺寸与 MIME，未加载字节');
  } else {
    const cached = env.imageParts.get(part);
    if (cached !== undefined) {
      data = cached ?? undefined; // null = 之前尝试过但未加载成功，不重复尝试
    } else if (!env.guard.probe('maxImages', 1)) {
      env.imageParts.set(part, null);
      warnOnce(env, 'maxImages', `图片数量超过 maxImages=${env.limits.maxImages}，后续图片只保留尺寸与 MIME`);
    } else if (!env.guard.probe('maxImageBytes', env.container.entrySize(part))) {
      env.imageParts.set(part, null);
      warnOnce(env, 'maxImageBytes', `图片累计字节超过 maxImageBytes=${env.limits.maxImageBytes}，后续图片只保留尺寸与 MIME`);
    } else {
      try {
        data = await env.container.read(part);
      } catch (err) {
        warnOnce(env, `imgread:${part}`, `图片部件 ${part} 读取失败：${errText(err)}`);
      }
      env.imageParts.set(part, data ?? null);
      if (data) env.imageBytes += data.length;
    }
  }

  let mime = mimeOf(part, env.types);
  // 部件被改名（.bin/.dat）时按魔数纠正
  if (data && mime === 'application/octet-stream') mime = mimeFromBytes(data) ?? mime;

  let dim = size;
  if (!dim && data) {
    const px = imageSizePx(data);
    if (px) dim = { w: pxToPt(px.w), h: pxToPt(px.h) };
  }
  if (!dim) {
    warnOnce(env, 'imgsize', '部分图片既没有 wp:extent 也没有可读字节，已按 200x150pt 兜底显示');
    dim = { w: 200, h: 150 };
  }

  const image: InlineImage = { mime, width: dim.w, height: dim.h };
  if (data) image.data = data;
  if (env.container.has(part)) image.partPath = part;
  if (alt) image.alt = alt;

  const run: Run = { text: '', image };
  if (st.pendingBreak) {
    run.breakBefore = true;
    st.pendingBreak = false;
  }
  st.runs.push(run);
}
