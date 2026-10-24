/**
 * PowerPoint OOXML（pptx / pptm / potx）读取器：编排、部件解析、元数据。
 *
 * 设计主线：**任何部件路径都必须从关系表解析，绝不硬编码。**
 * 真实文件里 slide 的文件名顺序与展示顺序经常不一致（PowerPoint 删掉第 2 页后
 * 新建一页会得到 slide1/slide2/slide4，而展示顺序是 1,4,2；WPS 甚至会放到
 * `ppt/slides2/` 之类目录）。因此顺序只能来自
 * `ppt/presentation.xml` 的 `p:sldIdLst` → `r:id` → `presentation.xml.rels`。
 * 硬编码 `slide${i}.xml` 的实现在这类文件上会「顺序全乱」或「整页丢失」。
 *
 * 继承链覆盖范围（**诚实说明**，不粉饰）：
 *   已实现：
 *     slide → slideLayout → slideMaster 的
 *       - 占位符几何（slide 上的形状常不写 `a:xfrm`，位置由版式决定）
 *       - 填充 `a:solidFill`（含主题色）、描边 `a:ln`（颜色/线宽）
 *       - 占位符形状 `p:txBody` 里的默认字号/字体/颜色
 *     slideMaster `p:txStyles` 的 titleStyle/bodyStyle 第 1 级
 *       （`a:lvl1pPr/a:defRPr`）默认字号与字体
 *   未实现（遇到时记 warning 或用默认值，绝不假装完整）：
 *     - `p:clrMap` / `p:clrMapOvr` 的颜色映射重定向
 *     - `a:lvl2pPr`..`a:lvl9pPr` 的逐级项目符号/缩进/字号
 *     - 主题字体（`a:fontScheme`）：只认 `a:latin`/`a:ea` 显式字体
 *     - 效果（阴影/发光/3D）、图片裁剪、虚线线型、渐变方向
 *     - 图表 / SmartArt / OLE / 媒体 / 动画 / 切换
 */
import { XmlPullParser } from '../../xml/src/index.ts';import type { XmlEvent } from '../../xml/src/index.ts';
import { attr, attrInt } from '../../ooxml/src/xmlUtil.ts';
import { findRelByType, mimeOf, parseContentTypes, parseRels, relsPathFor } from '../../ooxml/src/package.ts';
import type { ContentTypes, Relationship } from '../../ooxml/src/package.ts';
import { DEFAULT_OFFICE_THEME, parseTheme } from '../../ooxml/src/theme.ts';
import type { Theme } from '../../ooxml/src/theme.ts';
import { emuToPt, estimateBytes, now } from '../../core/src/index.ts';
import type { DocMeta, InlineImage, LiteDocument, Shape, Slide } from '../../core/src/model.ts';
import { createDocument } from '../../core/src/model.ts';
import { registerReader, ReadError } from '../../core/src/registry.ts';
import type { ContainerAccess, ReadContext } from '../../core/src/registry.ts';
import { parseContainerColor, readColorElement } from './color.ts';
import { IDENTITY_MAP } from './geometry.ts';
import { EMPTY_THEME_FONTS, parseThemeFonts } from './fonts.ts';
import type { ThemeFonts } from './fonts.ts';
import { collectHolders, collectParts, loadPendingImages, readShapeTree } from './shapes.ts';
import type { Holder, ImageBudget, ImageSource, ShapeCtx } from './shapes.ts';
import { defer, eachChild, skipDeep, textDeep, walkXml } from './scan.ts';
import type { ParserFactory } from './scan.ts';
import { makeTextContext, mergeTextStyle, readBodyDefaults, readDefRunProps, readTextBody, resolveShapeFonts, styleFromRunProps } from './text.ts';
import type { TextStyle } from './text.ts';

/* ==================================================================== */
/* 常量                                                                  */
/* ==================================================================== */

/**
 * 诊断开关：设置 `PPTX_DIAG=1` 后，读取器会把关键决策写进 `pptxDiagLog`。
 * 用模块级数组而不是 console.log，是为了能直接在测试里断言，
 * 也避免浏览器侧留下 node:fs 依赖。
 */
import { pptxDbg as dbg } from './diag.ts';

/** 无 `p:sldSz` 时的默认幻灯片尺寸：10in × 7.5in = 720 × 540 pt（4:3）。 */
const DEFAULT_SLIDE_W = 720;
const DEFAULT_SLIDE_H = 540;

/** `p:txStyles` 缺失时的兜底字号（pt）：标题 44、正文 18。 */
const FALLBACK_TITLE_SIZE = 44;
const FALLBACK_BODY_SIZE = 18;

/* ==================================================================== */
/* 内部类型                                                              */
/* ==================================================================== */

interface SlideEntry {
  /** `p:sldId id` */
  id: string;
  /** `p:sldId r:id` */
  rId: string;
  /** 解析后的部件路径 */
  target: string;
}

/** `p:txStyles` 里的两类默认样式。 */
interface TxStyles extends TextStyle {
  __title?: TextStyle;
  __body?: TextStyle;
}

/** 版式信息：名称 + 关系 + 主题 + 占位符表。 */
interface LayoutInfo {
  part: string;
  name?: string;
  rels: Map<string, Relationship>;
  theme: Theme;
  masterPart?: string;
  holders: Map<string, Holder>;
}

/** 降级信息的去重收集器：同一类问题只报一次，避免上千条淹没关键信息。 */
class WarningSink {
  private readonly keys = new Set<string>();
  readonly messages: string[] = [];

  add(key: string, message: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.messages.push(message);
  }
}

/* ==================================================================== */
/* 读取器主体                                                            */
/* ==================================================================== */

export class PptxReader {
  private readonly ctx: ReadContext;
  private readonly container: ContainerAccess;
  private readonly sink = new WarningSink();
  private readonly started = now();
  private readonly phases: Record<string, number> = {};

  private types: ContentTypes = { defaults: new Map(), overrides: new Map() };
  private theme: Theme = DEFAULT_OFFICE_THEME;
  private themeFonts: ThemeFonts = EMPTY_THEME_FONTS;
  private slideW = DEFAULT_SLIDE_W;
  private slideH = DEFAULT_SLIDE_H;

  private readonly statsSlot = { shapes: 0 };
  private readonly budget: ImageBudget = { count: 0, bytes: 0, exhausted: false };
  private readonly pendingImages: ShapeCtx['pendingImages'] = [];
  private readonly layoutCache = new Map<string, LayoutInfo>();

  constructor(ctx: ReadContext, container: ContainerAccess) {
    this.ctx = ctx;
    this.container = container;
  }

  private warn = (key: string, message: string): void => {
    this.sink.add(key, message);
  };

  private async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = now();
    try {
      return await fn();
    } finally {
      this.phases[name] = (this.phases[name] ?? 0) + (now() - t0);
    }
  }

  /* ---------------------------- 主流程 ---------------------------- */

  async read(): Promise<LiteDocument> {
    const c = this.container;

    if (!c.has('ppt/presentation.xml') && !c.has('_rels/.rels')) {
      throw new ReadError('包内既没有 ppt/presentation.xml 也没有 _rels/.rels，不是 PowerPoint 文件', 'CORRUPT', 'pptx');
    }

    if (c.has('[Content_Types].xml')) {
      this.types = parseContentTypes(await c.text('[Content_Types].xml'));
    } else {
      this.warn('no-content-types', '[Content_Types].xml 缺失，MIME 只能按扩展名推断');
    }

    const rootRels = await this.loadRels('');
    const presPart = this.findPresentationPart(rootRels);
    if (!presPart) {
      throw new ReadError('找不到演示文稿主部件（ppt/presentation.xml）', 'CORRUPT', this.formatOfMain());
    }
    const presRels = await this.loadRels(presPart);

    // 主题：presentation 级，作为最终兜底
    const themeRel = findRelByType(presRels, 'theme');
    if (themeRel && c.has(themeRel.target)) {
      const themeXml = await c.text(themeRel.target);
      const t = parseTheme(themeXml);
      if (t.size > 0) this.theme = t;
      else this.warn('theme-empty', '主题部件的 clrScheme 为空，已回退 Office 默认主题');
      // 主题字体（+mj-lt / +mn-ea）必须一起拿，否则真实文件里的字体名会原样带进模型
      this.themeFonts = parseThemeFonts(themeXml);
    } else {
      this.warn('theme-missing', '演示文稿未引用主题部件，颜色按 Office 默认主题近似');
    }

    // 母版：占位符几何 + txStyles
    let masterHolders = new Map<string, Holder>();
    let txStyles: TxStyles = {};
    const masterRel = findRelByType(presRels, 'slideMaster');
    if (masterRel && c.has(masterRel.target)) {
      const info = await this.phase('master', () => this.loadMaster(masterRel.target));
      masterHolders = info.holders;
      txStyles = info.txStyles;
    } else {
      this.warn('master-missing', '找不到 slideMaster 部件，版式继承与占位符几何将不可用');
    }

    // 幻灯片顺序：p:sldIdLst -> r:id -> rels
    const entries = await this.phase('presentation', () => this.readPresentation(presPart, presRels));

    const slides: Slide[] = [];
    const maxSlides = this.ctx.limits.maxSlides;
    for (let i = 0; i < entries.length; i++) {
      if (i >= maxSlides) {
        this.warn('max-slides', `幻灯片数超过 limits.maxSlides=${maxSlides}，其余页已忽略`);
        break;
      }
      if (this.ctx.signal?.aborted) break;
      this.ctx.onProgress?.({ phase: 'slides', done: i, total: entries.length });
      slides.push(await this.readSlide(entries[i], i, masterHolders, txStyles));
    }

    // 图片字节统一在解析完成后加载（避免异步与形状遍历交织，结果确定）
    await this.phase('images', () =>
      loadPendingImages(this.imageCtx(), this.ctx.limits.maxImages, this.ctx.limits.maxImageBytes),
    );

    const meta = await this.readDocProps(slides.length);

    const truncated = [...this.ctx.guard.truncated];
    // 截断必须如实进 stats.truncated（CONVENTIONS §5.2 要求「绝不静默丢内容」）。
    // 这两处是我们自己用 warn()/计数判断的，不会经过 LimitGuard.probe，
    // 所以要显式补记 —— 否则用户看到页数/形状数变少却没有任何「被截断」提示。
    if (this.statsSlot.shapes >= this.ctx.limits.maxShapes && !truncated.includes('maxShapes')) {
      truncated.push('maxShapes');
    }
    if (entries.length > slides.length && !truncated.includes('maxSlides')) {
      truncated.push('maxSlides');
    }
    const warnings = [...this.sink.messages, ...this.ctx.guard.warnings];

    const doc = createDocument({
      kind: 'slides',
      format: this.formatOfMain(),
      formatLabel: this.labelOfMain(),
      name: this.ctx.name,
      meta,
      slides,
      stats: {
        parseMs: now() - this.started,
        modelBytes: 0,
        sourceBytes: this.ctx.size,
        blockCount: countShapes(slides),
        cellCount: countTableCells(slides),
        shapeCount: this.statsSlot.shapes,
        imageCount: this.budget.count,
        imageBytes: this.budget.bytes,
        warnings,
        truncated,
        phases: this.phases,
      },
    });
    // modelBytes 覆盖 slides；图片字节已单独计入 imageBytes，估算时剔除 data
    doc.stats.modelBytes = estimateBytes(slides.map(stripImageBytes));
    return doc;
  }

  /** 找出主部件（走关系解析，缺 rels 时才回退到规范默认路径）。 */
  private findPresentationPart(rootRels: Map<string, Relationship>): string | undefined {
    const rel = findRelByType(rootRels, 'officeDocument');
    if (rel && this.container.has(rel.target)) return rel.target;
    if (this.container.has('ppt/presentation.xml')) {
      if (rootRels.size > 0) {
        this.warn('pres-rel-missing', '_rels/.rels 未指向 presentation 主部件，已回退到 ppt/presentation.xml');
      }
      return 'ppt/presentation.xml';
    }
    return undefined;
  }

  /** 解析 `p:sldSz` / `p:sldIdLst`。 */
  async readPresentation(presPart: string, presRels: Map<string, Relationship>): Promise<SlideEntry[]> {
    const c = this.container;
    if (!c.has(presPart)) return [];
    const xml = await c.text(presPart);
    const raw: Array<{ id: string; rId: string }> = [];
    let sawIds = false;

    // 用 walkElements：跳过由 walker 负责，业务代码只回答「要不要往下走」。
    // 早先手写 while + skipElement 的版本把根元素 p:presentation 也跳过了，
    // 于是整个演示文稿读成 0 页（skipElement 结束时 next() 会返回 null）。
    walkXml(xml, (e, p) => {
      switch (e.local) {
        case 'presentation':
          return true; // 根元素：必须下钻
        case 'sldSz': {
          const cx = Number.parseFloat(attr(e, 'cx') ?? '');
          const cy = Number.parseFloat(attr(e, 'cy') ?? '');
          if (cx > 0) this.slideW = emuToPt(cx);
          if (cy > 0) this.slideH = emuToPt(cy);
          if (!(cx > 0) || !(cy > 0)) this.warn('sldsz-bad', 'p:sldSz 尺寸非法，已按默认 720×540pt 处理');
          return false;
        }
        case 'sldIdLst':
          sawIds = true;
          if (!e.selfClosing) {
            eachChild(p, e, (child) => {
              if (child.local === 'sldId') {
                // 顺序即展示顺序：按出现顺序 push
                const id = attr(child, 'id') ?? '';
                const rId = attr(child, 'id2') ?? attr(child, 'r:id') ?? '';
                if (rId) raw.push({ id, rId });
              }
              return false; // sldId 是自闭合元素，walker 无需跳过
            });
          }
          return true;
        default:
          return false;
      }
    });
    if (!sawIds) this.warn('no-sldidlst', 'p:presentation.xml 没有 p:sldIdLst，演示文稿为空');

    const entries: SlideEntry[] = [];
    for (const item of raw) {
      const rel = presRels.get(item.rId);
      if (!rel || !c.has(rel.target)) {
        this.warn(`sldid-${item.rId}`, `p:sldIdLst 引用的关系 ${item.rId} 无对应部件，已跳过该页`);
        continue;
      }
      entries.push({ id: item.id, rId: item.rId, target: rel.target });
    }
    return entries;
  }

  /* ---------------------------- 母版与版式 ---------------------------- */

  private async loadRels(part: string): Promise<Map<string, Relationship>> {
    const path = relsPathFor(part);
    if (!this.container.has(path)) {
      dbg(`[loadRels] missing ${path}`);
      return new Map();
    }
    try {
      return parseRels(await this.container.text(path), part);
    } catch (err) {
      dbg(`[loadRels] FAIL ${path}: ${err instanceof Error ? err.message : String(err)}`);
      this.warn(`rels-bad-${path}`, `关系部件 ${path} 解析失败，相关引用将不可用`);
      return new Map();
    }
  }

  private async themeFor(part: string, rels: Map<string, Relationship>): Promise<Theme> {
    const rel = findRelByType(rels, 'theme');
    if (rel && this.container.has(rel.target)) {
      const t = parseTheme(await this.container.text(rel.target));
      if (t.size > 0) return t;
    }
    return this.theme.size > 0 ? this.theme : DEFAULT_OFFICE_THEME;
  }

  /** slideMaster：占位符表 + `p:txStyles` 默认样式。 */
  async loadMaster(part: string): Promise<{ holders: Map<string, Holder>; txStyles: TxStyles }> {
    const holders = new Map<string, Holder>();
    const txStyles: TxStyles = {};
    if (!this.container.has(part)) {
      this.warn('master-part-missing', `母版部件 ${part} 不存在`);
      return { holders, txStyles };
    }
    const rels = await this.loadRels(part);
    const theme = await this.themeFor(part, rels);
    const xml = await this.container.text(part);

    let tree: ParserFactory | undefined;
    walkXml(xml, (e, p) => {
      if (e.local === 'spTree') {
        if (!e.selfClosing) tree = defer(p, e);
        return true;
      }
      if (e.local === 'txStyles') {
        if (!e.selfClosing) this.readTxStyles(p, e, txStyles);
        return true;
      }
      // 根元素 p:sldMaster 与容器 p:cSld 必须下钻：
      // walker 的「跳过」是按层级跳过当前元素，跳过根就等于放弃整份母版。
      return e.local === 'cSld' || e.local === 'sldMaster';
    });
    if (tree) {
      // 母版形状不进模型（用丢弃数组），但占位符定义必须收集
      const { p: tp, e: te } = beginAt(tree);
      const ctx = this.makeShapeCtx(tp, theme, this.themeFonts, rels, holders, [], { shapes: 0 });
      collectHolders(tp, te, ctx, holders, (phType) => this.txStyleFor(txStyles, phType));
    }
    return { holders, txStyles };
  }

  /** `p:txStyles`：只取每类样式的第 1 级默认（见文件头「未实现」清单）。 */
  private readTxStyles(p: XmlPullParser, txStylesEl: XmlEvent, out: TxStyles): void {
    eachChild(p, txStylesEl, (child) => {
      const isTitle = child.local === 'titleStyle';
      const isBody = child.local === 'bodyStyle';
      if ((isTitle || isBody) && !child.selfClosing) {
        const style = this.readLvl1(p, child);
        if (isTitle) out.__title = style;
        else out.__body = style;
        return true;
      }
      return false;
    });
  }

  /** 取 `a:lvl1pPr/a:defRPr`（`p:txStyles` 的默认字号/字体）。 */
  private readLvl1(p: XmlPullParser, styleEl: XmlEvent): TextStyle {
    let out: TextStyle = {};
    eachChild(p, styleEl, (child) => {
      const isLevel = /^lvl[1-9]pPr$/.test(child.local);
      if (isLevel && !child.selfClosing) {
        // 只取第 1 级（PowerPoint 的「按占位符层级细化」见文件头「未实现」清单）
        if (child.local === 'lvl1pPr') out = mergeTextStyle(out, this.readDefRPr(p, child));
        return true;
      }
      return false;
    });
    return out;
  }

  /**
   * 读 `a:lvlXpPr` 或 `a:pPr` 上的 `a:defRPr`。
   *
   * 注意不能复用 text.readBodyDefaults：那个函数是给 `a:txBody` 用的
   * （它找 `a:lstStyle/a:lvl1pPr` 或首个 `a:p`），而 `p:txStyles` 里
   * `titleStyle` 的子元素**直接就是** `a:lvl1pPr`，层级不同。
   * 早期版本误用它，结果母版默认字号永远是空的（标题在真实文件里只能靠兜底 44pt）。
   */
  private readDefRPr(p: XmlPullParser, levelEl: XmlEvent): TextStyle {
    let out: TextStyle = {};
    eachChild(p, levelEl, (child) => {
      if (child.local === 'defRPr' && !child.selfClosing) {
        // 必须用 readDefRunProps：a:defRPr 的 sz/b/i 是**属性**，
        // 而 a:rPr 里它们是子元素，两者不能共用一段读取代码
        const rs = readDefRunProps(p, makeTextContext(this.theme, this.warn, {}, 1, this.themeFonts), child);
        out = mergeTextStyle(out, styleFromRunProps(rs));
        return true;
      }
      return false;
    });
    return out;
  }

  private txStyleFor(txStyles: TxStyles, phType: string | undefined): TextStyle | undefined {
    if (phType === 'title' || phType === 'ctrTitle') {
      return txStyles.__title ?? { sizePt: FALLBACK_TITLE_SIZE };
    }
    if (phType !== undefined) {
      return txStyles.__body ?? { sizePt: FALLBACK_BODY_SIZE };
    }
    return undefined;
  }

  private async loadLayout(part: string, masterHolders: Map<string, Holder>, txStyles: TxStyles): Promise<LayoutInfo> {
    const cached = this.layoutCache.get(part);    if (cached) return cached;
    const rels = await this.loadRels(part);
    const theme = await this.themeFor(part, rels);
    const info: LayoutInfo = {
      part,
      rels,
      theme,
      masterPart: findRelByType(rels, 'slideMaster')?.target,
      // 版式占位符覆盖母版；未定义的字段自然继承（合并时 undefined 不覆盖）
      holders: cloneHolders(masterHolders),
    };
    if (!this.container.has(part)) {
      this.warn(`layout-missing-${part}`, `版式部件 ${part} 不存在，占位符几何回退到母版`);
      this.layoutCache.set(part, info);
      return info;
    }
    const xml = await this.container.text(part);
    let tree: ParserFactory | undefined;
    let name: string | undefined;
    walkXml(xml, (e, p) => {
      // 版式名写在 `p:cSld` 的 name 属性上（不是子元素），很容易找错地方
      if (e.local === 'cSld') {
        const v = attr(e, 'name');
        if (v) name = v;
        return true;
      }
      if (e.local === 'spTree') {
        if (!e.selfClosing) tree = defer(p, e);
        return true;
      }
      return e.local === 'sldLayout';
    });
    if (name) info.name = name;
    if (tree) {
      const { p: tp, e: te } = beginAt(tree);
      const ctx = this.makeShapeCtx(tp, theme, this.themeFonts, rels, info.holders, [], { shapes: 0 });
      collectHolders(tp, te, ctx, info.holders, (phType) => this.txStyleFor(txStyles, phType));
    }
    this.layoutCache.set(part, info);
    return info;
  }

  /* ---------------------------- 单页 ---------------------------- */

  private async readSlide(entry: SlideEntry, index: number, masterHolders: Map<string, Holder>, txStyles: TxStyles): Promise<Slide> {
    const slide: Slide = { index, width: this.slideW, height: this.slideH, shapes: [] };
    if (!this.container.has(entry.target)) {
      this.warn(`slide-missing-${entry.target}`, `幻灯片部件 ${entry.target} 不存在，该页显示为空`);
      return slide;
    }
    const rels = await this.loadRels(entry.target);

    const layoutRel = findRelByType(rels, 'slideLayout');
    let layout: LayoutInfo | undefined;
    if (layoutRel) {
      layout = await this.loadLayout(layoutRel.target, masterHolders, txStyles);
      // 版式名优先取 p:cSld name；很多版式没有 name，则退回部件文件名
      slide.layout = layout.name ?? layoutRel.target.split('/').pop();
    } else {
      this.warn(`layout-none-${entry.target}`, `幻灯片 ${entry.target} 未引用版式，占位符几何回退到母版`);
    }
    const theme = layout?.theme ?? this.theme;
    const holders = layout?.holders ?? masterHolders;

    const xml = await this.container.text(entry.target);
    let sawTree = false;

    // 用 walkXml：跳过由 walker 按层级负责，业务代码只回答「要不要往下走」。
    // 早先手写 while + 自行 skipElement 的版本把根元素 p:sld 与容器 p:cSld 也跳过了，
    // 于是真实 pptx 全部变成空页 —— skipElement 结束时 next() 返回 null，
    // 「跳过根元素」等于直接结束整次遍历。夹具里 spTree 挂在根下，测不出这个坑。
    walkXml(xml, (e, parser) => {
      if (e.local === 'spTree') {
        if (e.selfClosing) return false;
        sawTree = true;
        const ctx = this.makeShapeCtx(parser, theme, this.themeFonts, rels, holders, slide.shapes, this.statsSlot);
        readShapeTree(parser, e, ctx);
        return true;
      }
      if (e.local === 'bg') {
        if (e.selfClosing) return false;
        const bg = this.readBackground(parser, e, theme);
        dbg(`[bg] part=${entry.target} themeSize=${theme.size} result=${bg ?? 'undefined'}`);
        if (bg) slide.background = bg;
        return true;
      }
      if (e.local === 'clrMapOvr') {
        this.warn('clrmapovr', 'p:clrMapOvr 颜色映射未实现，主题色按标准映射解析');
        return false;
      }
      // 只对「必须下钻才能到达 spTree」的容器放行，其余交给 walker 跳过
      return e.local === 'cSld' || e.local === 'sld';
    });
    if (!sawTree) this.warn(`no-sptree-${entry.target}`, `幻灯片 ${entry.target} 没有 p:spTree（空页）`);

    // 备注页只能通过 slide 的 .rels 里的 notesSlide 关系找到
    const notesRel = findRelByType(rels, 'notesSlide');
    if (notesRel && this.container.has(notesRel.target)) {
      const notes = await this.readNotes(notesRel.target);
      if (notes) slide.notes = notes;
    } else if (notesRel) {
      this.warn(`notes-missing-${notesRel.target}`, `备注页部件 ${notesRel.target} 不存在，已忽略备注`);
    }
    return slide;
  }

  /* ---------------------------- 背景 ---------------------------- */

  private readBackground(p: XmlPullParser, bg: XmlEvent, theme: Theme): string | undefined {
    let out: string | undefined;
    eachChild(p, bg, (child) => {
      dbg(`  [readBackground] child=${child.local} self=${child.selfClosing}`);
      if (child.local === 'bgPr') {
        if (child.selfClosing) return false;
        out = this.readBgPr(p, child, theme);
        dbg(`  [readBackground] bgPr -> ${out ?? 'undefined'}`);
        return true;
      }
      if (child.local === 'bgRef') {
        if (child.selfClosing) return false;
        out = this.readBgRef(p, child, theme);
        return true;
      }
      return false;
    });
    return out;
  }

  /**
   * `p:bgPr` 里的填充。
   *
   * 注意 `a:effectLst` 之类的**空元素**：它们可能出现在 `a:solidFill` 之后，
   * 而 `eachChild` 要求「返回 true 就必须消费完子树」。对自闭合元素返回 true
   * 会让解析器位置错位（调用方以为已经处理完，实际只跳过了标签本身），
   * 于是下一个兄弟被当成「已经读过」而整块丢给别人 —— 早期版本就是因此
   * 让 `p:bg` 后面的内容错位、幻灯片背景永远是空的。
   */
  private readBgPr(p: XmlPullParser, bgPr: XmlEvent, theme: Theme): string | undefined {
    let out: string | undefined;
    eachChild(p, bgPr, (child) => {
      dbg(`    [readBgPr] child=${child.local} self=${child.selfClosing}`);
      if (child.local === 'solidFill') {
        if (child.selfClosing) return false;
        const c = parseContainerColor(p, child, theme);
        dbg(`    [readBgPr] solidFill -> ${JSON.stringify(c) ?? 'undefined'}`);
        if (c) out = c.color;
        return true;
      }
      if (child.local === 'gradFill' || child.local === 'blipFill' || child.local === 'pattFill') {
        this.warn('bg-complex', '幻灯片背景是渐变/图片/图案填充，已忽略（无法还原）');
        return false;
      }
      return false;
    });
    return out;
  }

  /**
   * `p:bgRef idx="1001"` 走主题。idx >= 1000 表示「真的引用这个颜色填充」；
   * idx < 1000 表示引用主题里的**背景填充样式**（渐变/纹理），
   * 不解析 theme 的 fmtScheme 就无法还原 —— 明确降级而不是猜一个颜色。
   */
  private readBgRef(p: XmlPullParser, bgRef: XmlEvent, theme: Theme): string | undefined {
    const idx = attrInt(bgRef, 'idx', 0);
    let out: string | undefined;
    eachChild(p, bgRef, (child) => {
      if (!out) {
        out = readColorElement(p, child, theme)?.color;
        return true;
      }
      return false;
    });
    if (out) return out;
    if (idx > 0 && idx < 1000) {
      this.warn('bgref-theme', `p:bgRef idx=${idx} 引用主题背景填充样式（渐变/纹理），未实现还原，已忽略背景`);
    }
    return undefined;
  }

  /* ---------------------------- 备注 ---------------------------- */

  /** 备注页：只取 `p:ph type="body"`（或没有 `p:ph` 且名字像备注）的文本。 */
  private async readNotes(part: string): Promise<string | undefined> {
    const xml = await this.container.text(part);
    dbg(`[readNotes] part=${part} len=${xml.length}`);
    const lines: string[] = [];
    walkXml(xml, (e, p) => {
      dbg(`[readNotes-walk] ${e.local} self=${e.selfClosing}`);
      if (e.local === 'sp') {
        if (e.selfClosing) return false;
        const info = this.probeNoteShape(p, e);
        if (info) lines.push(info);
        return true;
      }
      // 根元素 p:notes、容器 p:cSld、形状容器 p:spTree 都必须下钻 ——
      // walkXml 的「跳过」是按层级跳过当前元素，跳过其中任何一个都等于放弃整份备注。
      return e.local === 'cSld' || e.local === 'notes' || e.local === 'spTree';
    });
    const out = lines.join('\n').trim();
    return out || undefined;
  }

  /**
   * 判断一个 `p:sp` 是否是备注正文，是则返回其纯文本。消费该元素。
   *
   * 直接复用 shapes 的 collectParts：备注页的 `p:sp` 结构与幻灯片完全一致，
   * 手写一份只取 name/ph/txBody 的瘦版本不但重复，还会漏掉 `phPresent`
   * 这类判断依据 —— 早期版本就因为拿不到 `phPresent`，把页码/日期占位符
   * 也当成备注正文，备注文本里混进了「1」和日期。
   */
  private probeNoteShape(p: XmlPullParser, sp: XmlEvent): string | undefined {
    const parts = collectParts(p, sp, this.theme);
    dbg(`[probeNote] name=${parts.name} ph=${parts.phType} present=${parts.phPresent} txBody=${!!parts.txBody}`);
    // 备注页里 body 占位符才是备注正文；幻灯片缩略图/页码/日期占位符要忽略
    const isBodyPh = parts.phPresent && (parts.phType === 'body' || parts.phType === undefined);
    const looksLikeNote = !parts.phPresent && /备注|notes?/i.test(parts.name ?? '');
    dbg(`[probeNote] isBodyPh=${isBodyPh} looksLikeNote=${looksLikeNote}`);
    if (!isBodyPh && !looksLikeNote) return undefined;
    if (!parts.txBody) return undefined;
    const paras = readTextBody(parts.txBody, makeTextContext(this.theme, this.warn, {}, 1, this.themeFonts));
    const text = paras
      .map((para) => para.runs.map((r) => r.text).join(''))
      .filter((t) => t.trim())
      .join('\n');
    return text || undefined;
  }

  /* ---------------------------- 元数据 ---------------------------- */

  private async readDocProps(slideCount: number): Promise<DocMeta> {
    const meta: DocMeta = { slideCount, pageWidth: this.slideW, pageHeight: this.slideH };
    const c = this.container;
    const rootRels = await this.loadRels('');

    const coreRel = findRelByType(rootRels, 'core-properties');
    dbg(`[docProps] rootRels=${rootRels.size} coreRel=${coreRel?.target ?? 'none'}`);
    const corePart = coreRel?.target ?? (c.has('docProps/core.xml') ? 'docProps/core.xml' : undefined);
    if (corePart && c.has(corePart)) {
      const f = await this.simpleXmlFields(corePart);
      dbg(`[docProps] core=${JSON.stringify(f).slice(0, 200)}`);
      dbg(`[docProps] core fields=${JSON.stringify(Object.keys(f))}`);
      meta.title = f['dc:title'] ?? f['title'] ?? meta.title;
      meta.subject = f['dc:subject'] ?? f['subject'] ?? meta.subject;
      meta.author = f['dc:creator'] ?? f['creator'] ?? meta.author;
      meta.lastModifiedBy = f['cp:lastModifiedBy'] ?? f['lastModifiedBy'] ?? meta.lastModifiedBy;
      meta.created = f['dcterms:created'] ?? f['created'] ?? meta.created;
      meta.modified = f['dcterms:modified'] ?? f['modified'] ?? meta.modified;
      meta.keywords = f['cp:keywords'] ?? f['keywords'] ?? meta.keywords;
      meta.description = f['dc:description'] ?? f['description'] ?? meta.description;
      meta.category = f['cp:category'] ?? f['category'] ?? meta.category;
      meta.language = f['dc:language'] ?? f['language'] ?? meta.language;
    } else {
      this.warn('no-core-props', '缺少 docProps/core.xml，标题/作者等元数据不可用');
    }

    const appRel = findRelByType(rootRels, 'extended-properties');
    const appPart = appRel?.target ?? (c.has('docProps/app.xml') ? 'docProps/app.xml' : undefined);
    if (appPart && c.has(appPart)) {
      const f = await this.simpleXmlFields(appPart);
      meta.application = f['Application'] ?? meta.application;
      meta.appVersion = f['AppVersion'] ?? meta.appVersion;
      meta.company = f['Company'] ?? meta.company;
      meta.manager = f['Manager'] ?? meta.manager;
      const slideTitles = f['TitlesOfParts'];
      if (slideTitles) meta.custom = { ...(meta.custom ?? {}), titlesOfParts: slideTitles };
      // app.xml 的 TitlesOfParts 是按页顺序列出的标题，是最可靠的页数旁证
      if (slideTitles) {
        const parts = slideTitles.split(/[;\u000b]/).filter((s) => s.trim());
        if (parts.length > 0 && !meta.title) meta.title = parts[0];
      }
    }
    return meta;
  }

  /**
   * 把「元素 -> 文本」读成表，用于 core.xml / app.xml 这类浅层 XML。
   *
   * 只处理**两层**：根的子元素作为字段名，取它的全部文本（含更深层拼接）。
   * 为什么不用 `p.skipElement()` 收集文本：它会一路吞到文档末尾
   * （跳过完成时下一个 `next()` 返回 null），于是除了根元素什么也读不到 ——
   * 元数据「看起来就是文件里没写」。这里全部用 scan.ts 的深度安全原语。
   */
  private async simpleXmlFields(part: string): Promise<Record<string, string>> {
    const xml = await this.container.text(part);
    const out: Record<string, string> = {};
    const p = new XmlPullParser(xml);
    // 进入根元素
    let root: XmlEvent | null = null;
    let e: XmlEvent | null;
    while ((e = p.next()) !== null) {
      if (e.type === 'start') {
        root = e;
        break;
      }
    }
    if (!root || root.selfClosing) return out;
    eachChild(p, root, (child) => {
      const name = child.name || child.local;
      const text = textDeep(p, child);
      if (text && out[name] === undefined) out[name] = text;
      if (text && out[child.local] === undefined) out[child.local] = text;
      return true; // textOf 已消费整棵子树
    });
    return out;
  }

  /* ---------------------------- 上下文构造 ---------------------------- */

  private makeShapeCtx(
    p: XmlPullParser,
    theme: Theme,
    fonts: ThemeFonts,
    rels: Map<string, Relationship>,
    holders: Map<string, Holder>,
    shapes: Shape[],
    statsSlot: { shapes: number },
  ): ShapeCtx {
    return {
      p,
      theme,
      fonts,
      rels,
      holders,
      map: IDENTITY_MAP,
      fontScale: 1,
      budget: this.budget,
      source: this.imageSource(),
      pendingImages: this.pendingImages,
      shapes,
      // layout/master 解析用独立的 slot，避免母版形状占用页面配额
      statsSlot,
      maxShapes: this.ctx.limits.maxShapes,
      warn: this.warn,
    };
  }

  /** 图片加载专用上下文（只用到预算、图片来源与待加载队列）。 */
  private imageCtx(): ShapeCtx {
    return this.makeShapeCtx(new XmlPullParser('<x/>'), this.theme, this.themeFonts, new Map(), new Map(), [], { shapes: 0 });
  }

  private imageSource(): ImageSource {
    const c = this.container;
    return {
      has: (part) => c.has(part),
      mime: (part) => mimeOf(part, this.types),
      size: (part) => c.entrySize(part),
      load: async (part): Promise<Uint8Array | undefined> => {
        try {
          if (c.entrySize(part) > this.ctx.limits.maxEntryBytes) return undefined;
          return await c.read(part);
        } catch {
          return undefined;
        }
      },
    };
  }

  /* ---------------------------- 输出格式 ---------------------------- */

  private formatOfMain(): 'pptx' | 'pptm' | 'potx' {
    const base = this.ctx.name.replace(/\\/g, '/').split('/').pop() ?? '';
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
    if (ext === 'pptm' || ext === 'ppsm' || ext === 'potm') return 'pptm';
    if (ext === 'potx') return 'potx';
    // 扩展名不可信时按内容判断（含宏工程则视为 pptm）
    if (this.container.has('ppt/vbaProject.bin')) return 'pptm';
    return 'pptx';
  }

  private labelOfMain(): string {
    const f = this.formatOfMain();
    if (f === 'pptm') return 'PowerPoint 演示文稿（含宏）';
    if (f === 'potx') return 'PowerPoint 模板';
    return 'PowerPoint 演示文稿';
  }
}

/* ==================================================================== */
/* 注册                                                                  */
/* ==================================================================== */

export const PPTX_READER_ID = 'format-pptx';

export const pptxReader = {
  id: PPTX_READER_ID,
  formats: ['pptx', 'pptm', 'potx'] as const,
  async read(ctx: ReadContext): Promise<LiteDocument> {
    if (!ctx.container) throw new ReadError('pptx 需要 ZIP 容器支持', 'CORRUPT', 'pptx');
    // 契约：容器只打开一次并复用
    const container = await ctx.container();
    return new PptxReader(ctx, container).read();
  },
};

registerReader(pptxReader);

/* ==================================================================== */
/* 工具函数                                                              */
/* ==================================================================== */

function countShapes(slides: readonly Slide[]): number {
  let n = 0;
  const walk = (shapes: readonly Shape[]): void => {
    for (const s of shapes) {
      n++;
      if (s.shapes) walk(s.shapes);
    }
  };
  for (const s of slides) walk(s.shapes);
  return n;
}

function countTableCells(slides: readonly Slide[]): number {
  let n = 0;
  const walk = (shapes: readonly Shape[]): void => {
    for (const s of shapes) {
      if (s.blocks) {
        for (const b of s.blocks) {
          if (b.kind === 'table') n += b.rows.reduce((m, r) => m + r.cells.length, 0);
        }
      }
      if (s.shapes) walk(s.shapes);
    }
  };
  for (const s of slides) walk(s.shapes);
  return n;
}

/** 估算 modelBytes 时剔除图片原始字节（已单独计入 imageBytes）。 */
function stripImageBytes(s: Slide): unknown {
  return {
    index: s.index,
    width: s.width,
    height: s.height,
    background: s.background,
    notes: s.notes,
    layout: s.layout,
    shapes: s.shapes.map(stripShape),
  };
}

function stripShape(sh: Shape): unknown {
  const image: Partial<InlineImage> | undefined = sh.image
    ? { mime: sh.image.mime, width: sh.image.width, height: sh.image.height, partPath: sh.image.partPath }
    : undefined;
  return { ...sh, image, shapes: sh.shapes?.map(stripShape) };
}

/** 拷贝占位符表（版式要基于母版表做局部覆盖，不能污染母版缓存）。 */
function cloneHolders(src: Map<string, Holder>): Map<string, Holder> {
  const out = new Map<string, Holder>();
  for (const [k, v] of src) out.set(k, v);
  return out;
}

/** 进入一个「可重放工厂」指向的元素，返回停在它 start 上的解析器。 */
function beginAt(factory: ParserFactory): { p: XmlPullParser; e: XmlEvent } {
  const p = factory();
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') return { p, e };
  }
  return {
    p,
    e: { type: 'start', name: '', local: '', prefix: '', attrs: null, selfClosing: true, text: '' },
  };
}
