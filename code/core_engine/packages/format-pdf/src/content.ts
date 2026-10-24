/**
 * 内容流解释器 —— 把 PDF 的绘制算子翻译成 UDM 的 PdfItem。
 *
 * 定位（务必按此理解本文件的能力边界）：
 *   目标是「读出页面上有什么 + 给出可读的近似版面」，**不是像素级还原**。
 *   因此这里实现的是：
 *     - 文本：完整的位置计算（Tm、Td、TD、T*、Tf、Tz、Ts、Tc、Tw、TL、Tr 与 CTM 复合）
 *     - 图形：矩形优先、直线次之，其它路径退化为包围盒
 *     - 图片：按 CTM 得到显示矩形，字节按 /Filter 抽取
 *   不实现：裁剪路径（W/W* 只记 warning 并忽略）、阴影/混合模式、图案填充、
 *   软掩码（/SMask 只记 warning）、Type3 字形轮廓、Form XObject 的递归展开。
 *
 * 为什么矩阵栈是必须的：真实 PDF 里「一个 cm + q/Q 包裹的坐标变换」是版式的基础，
 * 少了它旋转/缩放的页面会整体错位（WPS 导出的横向页面几乎都用 90° 旋转矩阵实现）。
 */
import { OPERATOR_ARITY } from './operators.ts';
import { isWhite } from './byteutils.ts';
import {
  Lexer,
  TOK_ARRAY_CLOSE,
  TOK_ARRAY_OPEN,
  TOK_DICT_CLOSE,
  TOK_DICT_OPEN,
  TOK_EOF,
  TOK_NAME,
  TOK_NUMBER,
  TOK_STRING,
  TOK_WORD,
} from './lexer.ts';
import type { Token } from './lexer.ts';
import { filterNames, imageMimeOf } from './filters.ts';
import { rawToBmp } from './rawimage.ts';
import { dictName, isArray, isName, isRef, isStream, numOf, parseValue } from './objects.ts';
import type { ObjectHost } from './objects.ts';
import type { PdfDict, PdfObject } from './objects.ts';
import type { Font } from './font.ts';
import type { PdfImageItem, PdfItem, PdfLineItem, PdfRectItem, PdfTextItem } from '../../core/src/model.ts';

/* ==================================================================== */
/* 2D 仿射矩阵（PDF 惯例：[a b c d e f]，x' = a·x + c·y + e）             */
/* ==================================================================== */

export type Mat = [number, number, number, number, number, number];

/**
 * 浏览器能直接解码的图片 MIME。
 *
 * 只有落在白名单里的才保留字节；其余（CCITT 传真、JBIG2 位流、转 BMP 失败的裸像素）
 * 一律丢字节 + 显示占位。理由见 emitImage 里的注释：留着会渲染成破图，
 * 用户会以为文件坏了 —— 占位块 + 说明才是诚实降级。
 *
 * `image/jp2` 保留：它是完整的 JPEG-2000 容器，部分浏览器（Safari）能显示；
 * 不能显示的浏览器会走 onerror，但至少字节是真格式。
 */
const DISPLAYABLE_IMAGE_MIME = /^image\/(jpeg|png|bmp|gif|webp|jp2|avif)$/;

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m1 × m2（先应用 m2，再应用 m1），与 PDF 的 cm/Tm 复合语义一致。 */
export function matMul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function matApply(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/* ==================================================================== */
/* 图形/文本状态                                                        */
/* ==================================================================== */

interface GState {
  ctm: Mat;
  lw: number;
  fill: string | undefined;
  stroke: string | undefined;
}

interface TextState {
  font: Font | undefined;
  fontName: string;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  horizScale: number;
  leading: number;
  rise: number;
  renderMode: number;
}

export interface ContentContext {
  resolve(o: PdfObject): PdfObject;
  note(message: string): void;
  /** 解码一条流（含 Filters 与 Predictor） */
  decode(dict: PdfDict, raw: Uint8Array): Promise<Uint8Array | undefined>;
  /** 图片字节上限检查（由 reader 对接 LimitGuard） */
  acceptImage(bytes: number): boolean;
}

export interface ContentItems {
  items: PdfItem[];
  /** 内容流里的字符数（含空白），用于统计提取量 */
  charCount: number;
}

interface FontSource {
  /** 异步：字体可能带压缩的 /ToUnicode CMap，必须先解压（见 FontLoader 的注释） */
  load(fontDict: PdfDict | undefined, name: string): Promise<Font | undefined>;
}

/** Form XObject 递归深度上限：真实文件里 Form 互相引用会成环，必须有硬上限。 */
const MAX_FORM_DEPTH = 8;

/** 判断字符是否为 CJK（汉字/假名/韩文/全角标点）。用于词间空格启发式。 */
function isCjk(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xff00 && c <= 0xffef)
  );
}

/** 内容流里的操作数。数组只可能来自 TJ。 */
type Operand = number | string | Uint8Array | Array<number | Uint8Array>;

/** 单页内容流解释器。每页一个实例，避免状态串页。 */
export class ContentInterpreter {
  private readonly ctx: ContentContext;
  private readonly fontLoader: FontSource;
  private readonly out: PdfItem[] = [];
  private gs: GState;
  private readonly gsStack: GState[] = [];
  private ts: TextState;
  private tm: Mat = [1, 0, 0, 1, 0, 0];
  private tlm: Mat = [1, 0, 0, 1, 0, 0];
  private path: Array<{ x: number; y: number }> = [];
  private subPathStart: { x: number; y: number } | undefined;
  private rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private charCount = 0;
  private readonly warned = new Set<string>();
  /** 图片资源名 -> 已解码结果，避免同一个 logo 在 50 页里重复解码 */
  private readonly imageCache = new Map<string, { data?: Uint8Array; mime?: string }>();
  private specialColorSpace: string | undefined;
  private sawCurve = false;
  private pendingSpace = false;

  constructor(ctx: ContentContext, fontLoader: FontSource) {
    this.ctx = ctx;
    this.fontLoader = fontLoader;
    this.gs = { ctm: [1, 0, 0, 1, 0, 0], lw: 1, fill: undefined, stroke: undefined };
    this.ts = {
      font: undefined,
      fontName: '',
      size: 0,
      charSpacing: 0,
      wordSpacing: 0,
      horizScale: 1,
      leading: 0,
      rise: 0,
      renderMode: 0,
    };
  }

  /**
   * 解释一条内容流。
   *
   * resources 是页面的 /Resources（继承已解析）。返回本页产出的条目与字符数。
   *
   * `depth` 用于 Form XObject 递归：真实 PDF 里表格/代码块/水印常常整块塞进
   * Form，若不递归展开就会**整段文字消失**（本项目实测：一份准考证的文字
   * 全在 Form 里，不展开时提取字符数为 0）。
   */
  async run(data: Uint8Array, resources: PdfDict | undefined, depth = 0): Promise<ContentItems> {
    // /Font 与 /XObject 本身可能是间接引用，必须解引用后再按名字查表（否则整页乱码）
    const fonts = dictOfRes(resources, 'Font', (o) => this.ctx.resolve(o));
    const xobjects = dictOfRes(resources, 'XObject', (o) => this.ctx.resolve(o));
    const lex = new Lexer(data, 0);
    const stack: Operand[] = [];

    for (;;) {
      const t: Token = lex.peek(0);
      if (t.type === TOK_EOF) break;
      if (t.type === TOK_NUMBER) {
        lex.next();
        stack.push(t.num);
        this.limitStack(stack);
        continue;
      }
      if (t.type === TOK_STRING) {
        lex.next();
        stack.push(t.bytes);
        this.limitStack(stack);
        continue;
      }
      if (t.type === TOK_NAME) {
        lex.next();
        stack.push(`/${t.text}`);
        this.limitStack(stack);
        continue;
      }
      if (t.type === TOK_ARRAY_OPEN) {
        // 内容流里唯一合法的数组就是 TJ 的操作数；内联解析避免造通用对象表示
        stack.push(this.readArray(lex));
        this.limitStack(stack);
        continue;
      }
      if (t.type === TOK_DICT_OPEN) {
        // BDC 的属性字典：整体跳到匹配的 >>
        lex.next();
        this.skipDict(lex);
        continue;
      }
      if (t.type === TOK_DICT_CLOSE || t.type === TOK_ARRAY_CLOSE) {
        lex.next();
        continue;
      }

      // TOK_WORD：算子或关键字
      lex.next();
      const op = t.text;

      if (op === 'BI') {
        stack.length = 0;
        await this.inlineImage(lex);
        continue;
      }
      // 标记内容算子：它们没有操作数，出现在内容里很常见，必须静默通过
      if (op === 'BDC' || op === 'BMC' || op === 'EMC' || op === 'MP' || op === 'DP') {
        stack.length = 0;
        continue;
      }
      const arity = OPERATOR_ARITY[op];
      if (arity === undefined) {
        // 未知关键字：清空操作数继续。为什么清空：栈上的残留会让后续算子
        // 取到错误的操作数，从而画出幽灵图元；清空是更安全的降级。
        stack.length = 0;
        this.warnOnce(`op:${op}`, `内容流里出现未支持的算子 "${op}"，已忽略该算子（不影响后续解析）`);
        continue;
      }
      const args = arity === 0 ? [] : arity < 0 ? stack.splice(0, stack.length) : stack.splice(Math.max(0, stack.length - arity), arity);
      await this.exec(op, args, fonts, xobjects, resources, depth);
    }
    return { items: this.out, charCount: this.charCount };
  }

  /** 收尾：把同一行被拆开的文本片段合并（只在最外层调用一次，避免重复合并）。 */
  finish(): PdfItem[] {
    return mergeTextItems(this.out);
  }

  private limitStack(stack: Operand[]): void {
    // 畸形内容流可能堆几百万个操作数而不出现算子。保留最后 64 个足够
    // （最长操作数序列是 cm/Tm 的 6 个），既不误伤也不会吃光内存。
    if (stack.length > 4096) stack.splice(0, stack.length - 64);
  }

  private readArray(lex: Lexer): Array<number | Uint8Array> {
    const parts: Array<number | Uint8Array> = [];
    lex.next(); // [
    for (;;) {
      const p = lex.peek(0);
      if (p.type === TOK_EOF || p.type === TOK_ARRAY_CLOSE) {
        if (p.type === TOK_ARRAY_CLOSE) lex.next();
        break;
      }
      if (p.type === TOK_NUMBER) {
        lex.next();
        parts.push(p.num);
        continue;
      }
      if (p.type === TOK_STRING) {
        lex.next();
        parts.push(p.bytes);
        continue;
      }
      lex.next(); // 数组里不该出现的 token
      if (parts.length > 100_000) break;
    }
    return parts;
  }

  private skipDict(lex: Lexer): void {
    let depth = 1;
    for (;;) {
      const p = lex.next();
      if (p.type === TOK_EOF) break;
      if (p.type === TOK_DICT_OPEN) depth++;
      else if (p.type === TOK_DICT_CLOSE) {
        depth--;
        if (depth === 0) break;
      }
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.note(message);
  }

  /* ---------------------------------------------------------------- */
  /* 算子实现                                                          */
  /* ---------------------------------------------------------------- */

  private async exec(
    op: string,
    args: Operand[],
    fonts: PdfDict | undefined,
    xobjects: PdfDict | undefined,
    resources: PdfDict | undefined,
    depth: number,
  ): Promise<void> {
    switch (op) {
      /* ---- 图形状态 ---- */
      case 'q':
        this.gsStack.push({ ...this.gs, ctm: this.gs.ctm.slice() as Mat });
        if (this.gsStack.length > 4096) this.gsStack.shift(); // 不平衡的 q 防御
        return;
      case 'Q':
        this.gs = this.gsStack.pop() ?? this.gs;
        return;
      case 'cm': {
        const m = this.mat(args);
        if (m) {
          /*
           * `cm` 的复合顺序不能反：PDF 规范是 `CTM' = M × CTM`，
           * 即**新的 M 先作用、再经过已有的 CTM**。
           *
           * 写成 matMul(m, ctm) 会把已有 CTM 先作用、再套 M，于是嵌在页面翻转
           * （`1 0 0 -1 0 841.9 cm`）里的图片变换被算成：
           *   y = -160.32 × 841.9 + 711.96 ≈ **-134261**
           * ——图片被放到页面外 13 万点处，用户看到的就是「图片打不开」。
           *
           * 只影响**嵌套** cm：页面级的第一个 cm 是在单位矩阵上复合的，两种顺序等价，
           * 所以文本坐标一直是对的，这个 bug 只砸在图片（和 Form 内部）上。
           */
          this.gs.ctm = matMul(this.gs.ctm, m);
        }
        return;
      }
      case 'w': {
        const w = num(args[0]);
        if (w !== undefined) this.gs.lw = w;
        return;
      }
      case 'gs':
        // /ExtGState（透明度、混合模式、线型）不参与版面还原，静默接受
        return;
      case 'J':
      case 'j':
      case 'M':
      case 'd':
      case 'ri':
      case 'i':
        // 线帽/线接/斜接限制/虚线/渲染意图/平坦度：对近似版面无影响
        return;

      /* ---- 颜色 ---- */
      case 'g':
        this.gs.fill = grayToHex(args[0]);
        return;
      case 'G':
        this.gs.stroke = grayToHex(args[0]);
        return;
      case 'rg':
        this.gs.fill = rgbToHex(args);
        return;
      case 'RG':
        this.gs.stroke = rgbToHex(args);
        return;
      case 'k':
        this.gs.fill = cmykToHex(args);
        return;
      case 'K':
        this.gs.stroke = cmykToHex(args);
        return;
      case 'cs':
      case 'CS': {
        // 记录特殊色空间名字，供 scn 判断操作数个数（/Pattern 的 scn 还可能带
        // 图案名，若按 1/3/4 个数字去猜就会错）
        const n = typeof args[0] === 'string' ? args[0].slice(1).toLowerCase() : '';
        this.specialColorSpace = /pattern|shading|indexed|separation|device|iccbased|lab/.test(n) ? n : undefined;
        return;
      }
      case 'sc':
      case 'scn':
      case 'SC':
      case 'SCN': {
        if (this.specialColorSpace && /pattern|shading|indexed|separation/.test(this.specialColorSpace)) return;
        const nums = args.filter((a): a is number => typeof a === 'number');
        const hex = nums.length === 1 ? grayToHex(nums[0]) : nums.length === 3 ? rgbToHex(nums) : nums.length === 4 ? cmykToHex(nums) : undefined;
        if (hex === undefined) return;
        if (op === 'sc' || op === 'scn') this.gs.fill = hex;
        else this.gs.stroke = hex;
        return;
      }

      /* ---- 路径构造 ---- */
      case 'm': {
        const p = this.firstPoint(args);
        if (!p) return;
        this.path.push(p);
        this.subPathStart = p;
        return;
      }
      case 'l': {
        const p = this.firstPoint(args);
        if (!p) return;
        this.path.push(p);
        return;
      }
      case 'c': {
        // 三次贝塞尔：只取**终点**（最后两个操作数），控制点忽略
        const p = this.lastPoint(args);
        if (!p) return;
        this.path.push(p);
        this.sawCurve = true;
        return;
      }
      case 'v':
      case 'y': {
        const p = this.lastPoint(args);
        if (!p) return;
        this.path.push(p);
        this.sawCurve = true;
        return;
      }
      case 're': {
        const x = num(args[0]);
        const y = num(args[1]);
        const w = num(args[2]);
        const h = num(args[3]);
        if (x === undefined || y === undefined || w === undefined || h === undefined) return;
        this.rects.push({ x, y, w, h });
        return;
      }
      case 'h':
        if (this.path.length && this.subPathStart) this.path.push(this.subPathStart);
        return;

      /* ---- 路径绘制 ---- */
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
      case 'n':
        this.paintPath(op);
        return;

      /* ---- 文本状态 ---- */
      case 'BT':
        this.ts.renderMode = this.ts.renderMode; // 保持（BT 不清除文本状态，符合规范）
        this.tm = [1, 0, 0, 1, 0, 0];
        this.tlm = [1, 0, 0, 1, 0, 0];
        return;
      case 'ET':
        return;
      case 'Tf': {
        const name = typeof args[0] === 'string' ? args[0].replace(/^\//, '') : '';
        const size = num(args[1]);
        // 字号是**文本空间**单位（未乘 CTM）。若这里乘了 CTM 就会双重缩放 —— 常见坑。
        if (size !== undefined) this.ts.size = Math.abs(size);
        this.ts.fontName = name;
        // 字体加载是异步的（/ToUnicode 可能是压缩流）。FontLoader 内部缓存 Promise，
        // 因此同一字体重复 Tf 不会重复构建。
        this.ts.font = await this.fontLoader.load(fonts, name);
        return;
      }
      case 'Td': {
        const tx = num(args[0]) ?? 0;
        const ty = num(args[1]) ?? 0;
        /*
         * 顺序不能反。`matMul(m1, m2)` 的语义是「先应用 m2、再应用 m1」，
         * 而 PDF 的 Td 是**在文本空间里**平移，必须被当前行矩阵的线性部分（a b c d）缩放：
         *   e' = tx·a + ty·c + e
         *   f' = tx·b + ty·d + f
         *
         * 写成 matMul(translate, tlm) 会先把 tlm 的缩放用掉、再按**页面单位**平移，
         * 平移就跳过了缩放。实测症状：某 PDF 的 Tm 是 `0.05 0 0 -0.05 ...`（缩到 1/20），
         * 于是 `300 0 TD` 实际应推进 15pt，却被当成 300pt —— **放大 20 倍**，
         * 一行字被甩到页面外（x 一路涨到 3256，而页宽只有 595），看起来就是整页乱码。
         * Tm 缩放为 1 时两种写法等价，所以这个 bug 长期没被测试发现。
         */
        this.tlm = matMul(this.tlm, [1, 0, 0, 1, tx, ty]);
        this.tm = this.tlm.slice() as Mat;
        return;
      }
      case 'TD': {
        const tx = num(args[0]) ?? 0;
        const ty = num(args[1]) ?? 0;
        this.ts.leading = -ty;
        // 同 Td：平移必须经过行矩阵的线性部分缩放
        this.tlm = matMul(this.tlm, [1, 0, 0, 1, tx, ty]);
        this.tm = this.tlm.slice() as Mat;
        return;
      }
      case 'Tm': {
        const m = this.mat(args);
        if (!m) return;
        this.tm = m;
        this.tlm = m.slice() as Mat;
        return;
      }
      case 'T*':
        this.nextLine();
        return;
      case 'TL':
        this.ts.leading = num(args[0]) ?? this.ts.leading;
        return;
      case 'Tc':
        this.ts.charSpacing = num(args[0]) ?? 0;
        return;
      case 'Tw':
        this.ts.wordSpacing = num(args[0]) ?? 0;
        return;
      case 'Tz': {
        const z = num(args[0]);
        this.ts.horizScale = z === undefined ? 1 : z / 100;
        return;
      }
      case 'Ts':
        this.ts.rise = num(args[0]) ?? 0;
        return;
      case 'Tr': {
        const mode = num(args[0]) ?? 0;
        this.ts.renderMode = mode;
        if (mode === 3) {
          // 渲染模式 3 = 不可见文本（OCR 文本层、以及某些水印的底层）。
          // 仍然产出条目 —— 否则整页文字会消失；是否绘制交给视图决定。
          this.warnOnce('tr3', '页面含渲染模式 3（不可见文本，常见于 OCR 层/水印底层），条目已保留');
        }
        return;
      }

      /* ---- 文本绘制 ---- */
      case 'Tj':
      case "'":
      case '"': {
        if (op !== 'Tj') {
          // ' 与 " 隐含一次 T*；" 还先设置词/字间距
          if (op === '"') {
            this.ts.wordSpacing = num(args[0]) ?? this.ts.wordSpacing;
            this.ts.charSpacing = num(args[1]) ?? this.ts.charSpacing;
          }
          this.nextLine();
        }
        const s = op === 'Tj' ? args[0] : op === "'" ? args[0] : args[2];
        if (s instanceof Uint8Array) this.showText(s);
        return;
      }
      case 'TJ': {
        const a = args[0];
        if (Array.isArray(a)) this.showTextArray(a);
        return;
      }
      case 'Do':
        await this.doXObject(args, xobjects, resources, depth);
        return;

      /* ---- 明确忽略但要告知的算子 ---- */
      case 'W':
      case 'W*':
        this.warnOnce('clip', '页面使用了裁剪路径（W/W*），裁剪区域未参与还原（仅影响溢出内容是否可见）');
        return;
      case 'sh':
        this.warnOnce('shading', '页面使用了渐变填充（sh），渐变未还原（可能缺失背景色块）');
        return;
      default:
        this.warnOnce(`op:${op}`, `内容流里出现未处理的算子 "${op}"，已忽略`);
        return;
    }
  }

  private nextLine(): void {
    // 同 Td：行距（leading）也在文本空间里，必须被行矩阵的线性部分缩放
    this.tlm = matMul(this.tlm, [1, 0, 0, 1, 0, -this.ts.leading]);
    this.tm = this.tlm.slice() as Mat;
  }

  /* ---------------------------------------------------------------- */
  /* 路径绘制                                                          */
  /* ---------------------------------------------------------------- */

  private paintPath(op: string): void {
    if (op === 'n') {
      // n = 结束路径且不绘制（常用于裁剪）。什么都不产出。
      this.resetPath();
      return;
    }
    const stroke = op === 'S' || op === 's' || op === 'B' || op === 'B*' || op === 'b' || op === 'b*';
    const fill = op === 'f' || op === 'F' || op === 'f*' || op === 'B' || op === 'B*' || op === 'b' || op === 'b*';

    for (const r of this.rects) {
      const d = this.transformRect(r.x, r.y, r.w, r.h);
      const item: PdfRectItem = { kind: 'rect', x: round(d.x), y: round(d.y), w: round(d.w), h: round(d.h) };
      if (fill && this.gs.fill) item.fill = this.gs.fill;
      if (stroke && this.gs.stroke) {
        item.stroke = this.gs.stroke;
        item.lw = this.gs.lw;
      }
      this.out.push(item);
    }

    // 线段：只处理「一条子路径、恰好两个点」的常见情形（表格线、下划线、边框）
    if (this.rects.length === 0 && this.path.length === 2 && stroke) {
      const a = matApply(this.gs.ctm, this.path[0].x, this.path[0].y);
      const b = matApply(this.gs.ctm, this.path[1].x, this.path[1].y);
      const line: PdfLineItem = { kind: 'line', x1: round(a.x), y1: round(a.y), x2: round(b.x), y2: round(b.y), lw: this.gs.lw };
      if (this.gs.stroke) line.stroke = this.gs.stroke;
      this.out.push(line);
    } else if (this.rects.length === 0 && this.path.length > 2) {
      // 复杂路径：退化为包围盒矩形，并如实记一次 warning
      this.warnOnce(
        this.sawCurve ? 'curve' : 'poly',
        this.sawCurve
          ? '页面含贝塞尔曲线路径，已按包围盒矩形近似（曲线形状未还原）'
          : '页面含多边形/多段线路径，已按包围盒矩形近似（折线形状未逐段还原）',
      );
      const box = this.pathBox();
      if (box) {
        const item: PdfRectItem = { kind: 'rect', x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) };
        if (fill && this.gs.fill) item.fill = this.gs.fill;
        if (stroke && this.gs.stroke) {
          item.stroke = this.gs.stroke;
          item.lw = this.gs.lw;
        }
        this.out.push(item);
      }
    }
    this.resetPath();
  }

  private resetPath(): void {
    this.path = [];
    this.subPathStart = undefined;
    this.rects = [];
    this.sawCurve = false;
  }

  /**
   * 把用户空间的矩形变换到设备空间。
   *
   * 关键取舍：轴对齐变换（缩放/平移）时由对角点直接得出 x/y/w/h，精确；
   * 旋转/斜切时取**变换后四点的包围盒** —— 会放大面积，但 UDM 只支持轴对齐
   * 矩形，精确做法需要输出任意四边形，超出模型范围。这里如实记 warning。
   */
  private transformRect(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
    const [a, b, c, d] = this.gs.ctm;
    if (Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9) {
      const p1 = matApply(this.gs.ctm, x, y);
      const p2 = matApply(this.gs.ctm, x + w, y + h);
      return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
    }
    void a;
    void d;
    const corners = [
      matApply(this.gs.ctm, x, y),
      matApply(this.gs.ctm, x + w, y),
      matApply(this.gs.ctm, x, y + h),
      matApply(this.gs.ctm, x + w, y + h),
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of corners) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    this.warnOnce('rot-rect', '页面存在旋转/斜切变换下的矩形，已按变换后包围盒近似（旋转矩形的面积会偏大）');
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private pathBox(): { x: number; y: number; w: number; h: number } | undefined {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of this.path) {
      const q = matApply(this.gs.ctm, p.x, p.y);
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    if (!Number.isFinite(minX)) return undefined;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /* ---------------------------------------------------------------- */
  /* 文本                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 基线位置与有效字号。
   *
   * 依据规范，文本渲染矩阵 Trm = [Tfs·Th, 0, 0, Tfs, 0, Ts] × Tm × CTM。
   * 把原点做变换得到基线起点（PdfTextItem.x/y 的含义：pt，原点左下）；
   * 把 (1,0) 方向做变换后取长度得到有效字号 —— 旋转 90° 时它仍等于 Tfs，
   * 这正是「横向页面用旋转矩阵实现」也能得到正确字号的原因。
   */
  private textOrigin(): { x: number; y: number } {
    return matApply(this.gs.ctm, this.tm[4], this.tm[5]);
  }

  private effectiveSize(): number {
    const m = matMul(this.tm, this.gs.ctm);
    return Math.abs(Math.hypot(m[0], m[1]) * this.ts.size * this.ts.horizScale);
  }

  /** 文本空间 1 单位（未乘字号）在设备空间的长度，用于把 tx 换算成宽度。 */
  private unitLength(): number {
    const m = matMul(this.tm, this.gs.ctm);
    return Math.hypot(m[0], m[1]);
  }

  /**
   * 显示一段字符串（Tj / ' / "）。
   *
   * 实现要点：把连续可解码的字符攒成**一个** PdfTextItem，而不是每字符一条 ——
   * 否则一个段落会产生几百个条目，模型体积和渲染开销都会失控。
   */
  private showText(bytes: Uint8Array): void {
    const font = this.ts.font;
    if (!font || bytes.length === 0) return;
    if (this.ts.size <= 0) {
      // BT 后没有 Tf 是非法写法，但真实文件里有；字号 0 会让条目在视图里完全不可见
      this.ts.size = 12;
    }
    const origin = this.textOrigin();
    const size = this.effectiveSize();
    const unit = this.unitLength();

    let text = '';
    let width = 0;
    let i = 0;
    while (i < bytes.length) {
      const d = font.decoder(bytes, i);
      if (!d) break;
      const w = font.width(d.code) / 1000;
      if (d.text) {
        text += d.text;
        this.charCount += d.text.length;
      }
      // 推进：tx = (w0·Tfs + Tc + Tw[若空格]) · Th，Tw 只对码值 32 生效（规范定义）
      const isSpace = d.code === 32;
      const tx = (w * this.ts.size + this.ts.charSpacing + (isSpace ? this.ts.wordSpacing : 0)) * this.ts.horizScale;
      // 字形推进量也在文本空间里，必须经当前文本矩阵缩放（同 Td 的顺序问题）
      this.tm = matMul(this.tm, [1, 0, 0, 1, tx, 0]);
      width += Math.abs(tx) * unit;
      if (d.next <= i) break; // 防御：解码器没有前进
      i = d.next;
    }

    if (text.length === 0) return;
    const item: PdfTextItem = {
      kind: 'text',
      x: round(origin.x),
      y: round(origin.y),
      size: round(size),
      font: font.baseFont || this.ts.fontName,
      text,
    };
    // 模型默认黑色：只有非黑才写颜色，能显著减小大页面的模型体积
    if (this.gs.fill && this.gs.fill !== '#000000') item.color = this.gs.fill;
    if (width > 0) item.width = round(width);
    if (this.ts.charSpacing !== 0) item.charSpacing = this.ts.charSpacing;
    this.out.push(item);
  }

  /**
   * 显示 TJ 数组：数字是字间距调整（单位 1/1000 em，**负值向右**）。
   *
   * 关于自动补空格：这是文本提取里最影响可读性的启发式。规范里词间空白就是
   * 一个真实的空格字符，但很多生成器（尤其 Office 导出的 PDF）用「把字距拉开」
   * 来表达词间空白。经验阈值是调整量 < -100（即 0.1 em 以上）。
   *
   * ⚠ 但**中文排版不适用**：中文 PDF 会给每个汉字之间加一点间隙（这是排版
   * 常态，不是词边界），照搬阈值会得到「申 请 安 居 区」这种逐字带空格的文本，
   * 既难读也搜不到。所以这里额外要求「断点两侧不是 CJK」才补空格 ——
   * 中文之间的间隙只影响坐标，不影响文本。
   */
  private showTextArray(arr: Array<number | Uint8Array>): void {
    for (const part of arr) {
      if (typeof part === 'number') {
        const adjust = (-part / 1000) * this.ts.size * this.ts.horizScale;
        // 同 Td：TJ 的字距修正也在文本空间里，必须经文本矩阵缩放
        this.tm = matMul(this.tm, [1, 0, 0, 1, adjust, 0]);
        if (part < -100) this.pendingSpace = true;
        continue;
      }
      if (this.pendingSpace) {
        this.pendingSpace = false;
        const prev = this.out[this.out.length - 1];
        // 只有前面确实产出过文本、不以空格结尾、且两侧非 CJK 时才补空格
        if (prev && prev.kind === 'text' && !prev.text.endsWith(' ') && !this.isCjkBoundary(prev.text, part)) {
          this.showTextWithPrefix(' ', part);
          continue;
        }
      }
      this.showText(part);
    }
  }

  /**
   * 判断一段文本与新片段之间是否是 CJK 边界。
   *
   * 为什么需要：中文 PDF 常在每个汉字之间加字距（排版常态），若按拉丁文的
   * 「间隙大就是词边界」去补空格，会得到「申 请 安 居 区」这种逐字带空格的
   * 文本 —— 看起来像乱码，搜索也匹配不上（实测 70 KiB 的申请书全文都是这样）。
   *
   * 这里用字体解码器解出新片段的第一个字符再判断，而不是拿原始字节猜 ——
   * 因为 Identity-H 下 0x30 开头的字节既可能是 CJK 也可能是别的 CID。
   */
  private isCjkBoundary(prevText: string, nextBytes: Uint8Array): boolean {
    const lastChar = prevText[prevText.length - 1];
    if (!lastChar || !isCjk(lastChar)) return false;
    const font = this.ts.font;
    if (!font) return false;
    const d = font.decoder(nextBytes, 0);
    const first = d?.text?.[0];
    return first !== undefined && isCjk(first);
  }

  private showTextWithPrefix(prefix: string, bytes: Uint8Array): void {
    const before = this.out.length;
    this.showText(bytes);
    // showText 只产出 0 或 1 条，因此取最后一条加前缀是安全的
    if (this.out.length === before + 1) {
      const item = this.out[this.out.length - 1];
      if (item.kind === 'text') item.text = prefix + item.text;
    }
  }

  /* ---------------------------------------------------------------- */
  /* XObject（图片 / Form）                                             */
  /* ---------------------------------------------------------------- */

  private async doXObject(
    args: Operand[],
    xobjects: PdfDict | undefined,
    resources: PdfDict | undefined,
    depth: number,
  ): Promise<void> {
    const name = typeof args[0] === 'string' ? args[0].replace(/^\//, '') : '';
    if (!name || !xobjects) return;
    const raw = this.ctx.resolve(xobjects[name]);
    if (!isStream(raw)) return;
    const subtype = dictName(raw.dict, 'Subtype');
    if (subtype === 'Image') {
      await this.emitImage(name, raw.raw, raw.dict);
      return;
    }
    if (subtype === 'Form') {
      await this.emitForm(name, raw.dict, raw.raw, resources, depth);
      return;
    }
    // PS XObject 等：明确不支持，记一次 warning
    this.warnOnce(`xobj:${subtype ?? 'unknown'}`, `不支持的 XObject 子类型 /${subtype ?? '未知'}，已跳过`);
  }

  /**
   * 展开 Form XObject（/Subtype /Form）。
   *
   * 为什么必须做：真实 PDF（Word/WPS 导出的表格、代码块、整页背景、以及
   * 「先把内容做成 Form 再引用」的排版器）会把**正文文字**放进 Form。
   * 本项目实测：一份准考证的全部文字都在 Form 里，不展开时提取字符数为 0 ——
   * 这不是精度问题，而是「读不到页面上有什么」的功能缺失。
   *
   * 规范要点：
   *   - /Matrix 是 Form 空间的附加变换，必须与当前 CTM 复合
   *   - /Resources 缺省时**继承**调用方的 Resources（这条极易漏，漏了就会因为
   *     找不到字体而丢字）
   *   - /BBox 与裁剪有关，这里忽略（本包不做裁剪）
   */
  private async emitForm(
    name: string,
    dict: PdfDict,
    rawData: Uint8Array,
    callerResources: PdfDict | undefined,
    depth: number,
  ): Promise<void> {
    if (depth >= MAX_FORM_DEPTH) {
      this.warnOnce('form-depth', `Form XObject 嵌套超过 ${MAX_FORM_DEPTH} 层，已停止展开（防循环引用）`);
      return;
    }
    const content = await this.ctx.decode(dict, rawData);
    if (!content || content.length === 0) return;

    const formResources = dictOfRes(dict, 'Resources') ?? callerResources;
    const savedGs = this.gs;
    const savedTm = this.tm;
    const savedTlm = this.tlm;
    // 规范：Form 的内容流不继承调用方的文本状态
    this.gs = { ...this.gs, ctm: this.gs.ctm.slice() as Mat };

    const m = dict.Matrix;
    if (Array.isArray(m) && m.length >= 6) {
      const nums: number[] = [];
      for (let i = 0; i < 6; i++) {
        const n = typeof m[i] === 'number' ? (m[i] as number) : Number.NaN;
        if (!Number.isFinite(n)) return;
        nums.push(n);
      }
      const fm: Mat = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
      this.gs.ctm = matMul(fm, this.gs.ctm);
    }

    try {
      await this.run(content, formResources, depth + 1);
    } finally {
      // 恢复图形状态与文本矩阵：Form 内部的状态变化不得泄漏回调用方
      this.gs = savedGs;
      this.tm = savedTm;
      this.tlm = savedTlm;
    }
    void name;
  }

  private async emitImage(name: string, rawData: Uint8Array, dict: PdfDict): Promise<void> {
    const d = this.transformRect(0, 0, 1, 1);
    let cached = this.imageCache.get(name);
    if (!cached) {
      const filters = filterNames(dict);
      const decoded = await this.ctx.decode(dict, rawData);
      let mime = imageMimeOf(dict, filters);
      let data = decoded;
      /*
       * 「裸像素」图片（无过滤器 / 仅 FlateDecode）解出来的是 DeviceRGB/DeviceGray 采样，
       * 没有任何容器格式，浏览器**显示不出来**（用户看到的就是「图片打不开」）。
       * 这里包一层 BMP 让它变成真正能显示的照片。
       * 转不了（Indexed/CMYK/非 8 位等）就保持 image/x-raw，由渲染端显示占位。
       */
      if (data && mime && mime.startsWith('image/x-raw')) {
        const bmp = rawToBmp(dict, data);
        if (bmp) {
          data = bmp;
          mime = 'image/bmp';
        }
      }
      /*
       * 剩下的「浏览器根本无法解码」的编码（CCITT 传真、JBIG2 位流、转了也失败的裸像素）：
       * 一律**不保留字节**，让渲染端显示占位块。
       *
       * 为什么不留着字节：留着会生成一个 blob URL 塞进 <img>，
       * 浏览器解码失败 → 显示成破图图标，用户以为是文件坏了。
       * 占位块 + 一句说明才是诚实的降级。
       */
      if (data && mime && !DISPLAYABLE_IMAGE_MIME.test(mime)) {
        this.warnOnce(
          `imgfmt:${mime}`,
          `图片编码 ${mime.replace('image/', '')} 无法在浏览器中显示（需专用解码器），该图显示为占位`,
        );
        data = undefined;
      }
      // 超限时不保留字节，但仍然产出条目 —— 否则版面里会出现「凭空消失的图」。
      // 注意：acceptImage 会**扣减图片预算**，因此只能在最终字节上调用一次。
      // （曾经在「解码后」和「转 BMP 后」各调一次，预算被双倍扣减，
      //   表现为后面几张图提前变成占位。）
      if (data && !this.ctx.acceptImage(data.length)) data = undefined;
      cached = { data, mime };
      this.imageCache.set(name, cached);
    }
    const item: PdfImageItem = { kind: 'image', x: round(d.x), y: round(d.y), w: round(d.w), h: round(d.h) };
    if (cached.data) item.data = cached.data;
    if (cached.mime) item.mime = cached.mime;
    if (dict.SMask !== undefined) {
      this.warnOnce('smask', '图片含 /SMask 软掩码（透明度），当前未合成（图片会显示为不透明）');
    }
    this.out.push(item);
  }

  /**
   * 内联图片 `BI ... ID <二进制> EI`。
   *
   * 坑：ID 后面只有**一个**空白字符，紧接着就是二进制数据；数据里可能包含
   * "EI" 字样，因此必须优先用 /L（或 /Length）确定长度，只有在没有长度信息时
   * 才扫描「行首的 EI」。JPEG 数据尾部常有 0xFF 填充，扫错会导致后面整段
   * 内容流错位，所以对 DCTDecode 额外做 EOI(FFD9) 检测。
   */
  private async inlineImage(lex: Lexer): Promise<void> {
    const buf = lex.buf;
    // BI 与 ID 之间的键值对要用**对象解析器**读，不能用「下一个 token 当值」——
    // `/F /DCT`、`/W 1`、`/IM true` 等混合出现时，逐个 token 取值会错位
    // （本项目踩过：/F 的值被读成 null，图片 mime 退化成 image/x-raw）
    const dict = parseInlineImageDict(lex);
    // ID 之后必须有一个空白字符，数据从其后开始
    let start = lex.scannedPos;
    if (start < buf.length && isWhite(buf[start])) start++;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;

    const len = numOf(dict.L) ?? numOf(dict.Length);
    let end: number;
    if (len !== undefined && len > 0 && start + len <= buf.length) {
      end = start + len;
    } else {
      end = findInlineImageEnd(buf, start, dictName(dict, 'Filter') ?? '');
      if (end < 0) {
        this.warnOnce('inline-ei', '内联图片找不到 EI 结束标记，已跳过（后续内容可能错位）');
        lex.seekTo(Math.min(buf.length, start + 1));
        return;
      }
    }
    const data = buf.subarray(start, end);
    // 二进制数据里没有 token 结构：必须用绝对字节定位跳过，并丢弃缓冲
    lex.seekTo(end);
    if (!lex.eatKeyword('EI')) lex.skipToKeyword('EI', 64);

    const d = this.transformRect(0, 0, 1, 1);
    // 内联图片的过滤器键是 /F（也允许写成 /Filter），两者都要认
    const filter = dictName(dict, 'Filter') ?? dictName(dict, 'F');
    const mime = imageMimeOf(dict, filter ? [filter] : []);
    const item: PdfImageItem = { kind: 'image', x: round(d.x), y: round(d.y), w: round(d.w), h: round(d.h) };
    if (this.ctx.acceptImage(data.length)) item.data = data.slice();
    if (mime) item.mime = mime;
    this.out.push(item);
    this.warnOnce('inline-image', '页面使用内联图片（BI/ID/EI）：已提取原始字节，但仅支持可直接使用的编码（JPEG 等）');
  }

  /* ---------------------------------------------------------------- */
  /* 小工具                                                            */
  /* ---------------------------------------------------------------- */

  private mat(args: Operand[]): Mat | undefined {
    if (args.length < 6) return undefined;
    const v: number[] = [];
    for (let i = 0; i < 6; i++) {
      const n = num(args[i]);
      if (n === undefined) return undefined;
      v.push(n);
    }
    return [v[0], v[1], v[2], v[3], v[4], v[5]];
  }

  /**
   * m/l 的点是**前两个**操作数。
   * 早期版本统一取「最后两个」，于是 `0 0 5 0 m` 会被解成 (5,0) ——
   * 起点错位后整条线段都画歪了。
   */
  private firstPoint(args: Operand[]): { x: number; y: number } | undefined {
    const x = num(args[0]);
    const y = num(args[1]);
    if (x === undefined || y === undefined) return undefined;
    return { x, y };
  }

  /**
   * 贝塞尔（c/v/y）的终点是**最后两个**操作数。
   * c 有 6 个操作数（两个控制点 + 终点），v/y 有 4 个（一个控制点 + 终点）。
   */
  private lastPoint(args: Operand[]): { x: number; y: number } | undefined {
    const x = num(args[args.length - 2]);
    const y = num(args[args.length - 1]);
    if (x === undefined || y === undefined) return undefined;
    return { x, y };
  }
}

/**
 * 后处理：合并同一行上被拆成多条的文字，并按间隙恢复词间空格。
 *
 * 为什么必须做这一步：PDF 里一个句子常常被拆成大量独立的 Tj（尤其 Word/WPS
 * 导出的中文 PDF，几乎每几个字一次 Tj，用来做「两端对齐」）。
 * 结果是 UDM 里一页有几百个文本条目，而且：
 *   - 中文会变成「申 请 安 居 区」这种逐字带间隙的文本（既难读也搜不到）
 *   - 拉丁文词的间隙无法区分「词内」与「词间」，复制出来会粘连
 *
 * 判据（都用**近似**版面信息，因为本包定位就是近似还原）：
 *   - 两条基线 y 差 < 0.3em 且字号相同 → 同一行
 *   - 前一条的估算宽度与两条的 x 距离之差，就是它们之间的**空隙**
 *   - 空隙 < 0.25em → 同一词/同一串，直接拼接
 *   - 否则若两侧非 CJK 或空隙 >= 0.25em → 补一个空格
 * 这一步是纯模型操作，不影响图形条目。
 */
export function mergeTextItems(items: readonly PdfItem[]): PdfItem[] {
  const out: PdfItem[] = [];
  for (const it of items) {
    if (it.kind !== 'text') {
      out.push(it);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'text' && canMerge(prev, it)) {
      const gap = estimateGap(prev, it);
      const em = Math.max(1, it.size);
      const prevLast = prev.text[prev.text.length - 1];
      const nextFirst = it.text[0];
      // 两侧都是 CJK 时不要空格：中文的字距是排版常态，不是词边界
      const needSpace = gap >= 0.25 * em && !(isCjk(prevLast) && isCjk(nextFirst));
      prev.text += (needSpace ? ' ' : '') + it.text;
      if (it.width !== undefined) prev.width = round((prev.width ?? 0) + gap + it.width);
      continue;
    }
    out.push(it);
  }
  return out;
}

function canMerge(a: PdfTextItem, b: PdfTextItem): boolean {
  if (a.size <= 0 || b.size <= 0) return false;
  // 字号差超过 5% 视为不同文本块，不合并
  if (Math.abs(a.size - b.size) > 0.05 * a.size) return false;
  // 基线高度差超过 0.3em 视为不同行
  // 基线高度差超过 0.25em 视为不同行（单倍行距约 1.2em，阈值很安全；
  // 早期用 0.3em 会把只差 0.3em 的两行粘成一条，行结构就丢了）
  if (Math.abs(a.y - b.y) > 0.25 * Math.max(a.size, b.size)) return false;
  // b 必须在 a 之后（允许小幅重叠，真实文件里 kerning 会造成负间隙）
  const ax = a.x + (a.width ?? 0);
  return b.x >= a.x - 0.1 * a.size && b.x <= ax + 3 * a.size;
}

function estimateGap(a: PdfTextItem, b: PdfTextItem): number {
  const ax = a.x + (a.width ?? 0);
  return b.x - ax;
}

/* ==================================================================== */
/* 辅助函数                                                              */
/* ==================================================================== */

function dictOfRes(
  resources: PdfDict | undefined,
  key: string,
  resolve?: (o: PdfObject) => PdfObject,
): PdfDict | undefined {
  if (!resources) return undefined;
  let v = resources[key];
  if (v === undefined || v === null) return undefined;
  /*
   * `/Font`、`/XObject` 在真实文件里既可能是**内联字典**，也可能是**间接引用**：
   *
   *   /Font << /F1 115 0 R ... >>      ← 内联（本项目早期只见过这种）
   *   /Font 121 0 R                    ← 间接（WPS 导出的 PDF 就是这么写）
   *
   * 不解引用会把 ref 对象当成字典用，于是按字体名查表**永远落空**，
   * 落到「字体资源 /F1 无法解析 → 按 Latin-1 直译」这条兜底路径，
   * 把 CID 字节当控制字符原样吐出来 —— 实测整页文本变成
   * "\u0001 \u0002 \u0003\u0004\u0005 ..." 这样的乱码。
   *
   * 这个 bug 之所以长期没被发现：本机 8 个可读 PDF 里有 7 个用内联写法，
   * 只有 WPS 导出的那一类会触发。判据是「中文文档提取出 0 个汉字」。
   */
  if (resolve && isRef(v)) v = resolve(v);
  if (Array.isArray(v) || isName(v) || isStream(v)) return undefined;
  return typeof v === 'object' ? (v as PdfDict) : undefined;
}

function tokenToValue(t: Token): PdfObject {
  switch (t.type) {
    case TOK_NUMBER:
      return t.num;
    case TOK_NAME:
      return { name: t.text };
    case TOK_STRING:
      return { bytes: t.bytes };
    case TOK_WORD:
      if (t.text === 'true') return true;
      if (t.text === 'false') return false;
      return null;
    default:
      return null;
  }
}

/**
 * 解析内联图片 `BI` 与 `ID` 之间的键值对。
 *
 * 为什么要用对象解析器：内联图片字典的值类型很杂（`/F /DCT` 是名字、
 * `/W 1` 是数字、`/IM true` 是布尔、`/D [1 2]` 是数组）。早期用「下一个
 * token 就是值」的简化写法，遇到 `/F /DCTDecode` 会把 `/DCTDecode` 当值、
 * 然后在 `ID` 之前再次读键 —— 结果 /Filter 丢失，JPEG 被当成裸像素。
 */
function parseInlineImageDict(lex: Lexer): PdfDict {
  const dict: PdfDict = {};
  for (;;) {
    const t = lex.peek(0);
    if (t.type === TOK_EOF) return dict;
    if (t.type === TOK_WORD && t.text === 'ID') {
      lex.next();
      return dict;
    }
    if (t.type === TOK_NAME) {
      lex.next();
      const key = t.text;
      // 用 parseValue 读值：它会正确处理数字/名字/布尔/数组/字符串
      const v = parseValue(lex, INLINE_DICT_HOST, 0);
      dict[key] = v;
      continue;
    }
    lex.next(); // 畸形输入：跳过
  }
}

/** 内联图片字典里不会出现间接引用，用一个空 host 即可 */
const INLINE_DICT_HOST: ObjectHost = {
  resolve: () => null,
  note: () => {},
};

function num(v: Operand | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function grayToHex(v: Operand | undefined): string | undefined {
  if (typeof v !== 'number') return undefined;
  const g = clamp255(Math.round(v * 255));
  if (g === 0) return undefined; // 黑色是模型默认，省略以省体积
  return `#${hex2(g)}${hex2(g)}${hex2(g)}`;
}

function rgbToHex(args: Operand[]): string | undefined {
  const r = clamp255(Math.round((num(args[0]) ?? 0) * 255));
  const g = clamp255(Math.round((num(args[1]) ?? 0) * 255));
  const b = clamp255(Math.round((num(args[2]) ?? 0) * 255));
  if (r === 0 && g === 0 && b === 0) return undefined;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * CMYK -> RGB。
 * 用 Adobe 的朴素换算（R = 1 - min(1, C+K)），不做 ICC 色彩管理 ——
 * 后者需要解析嵌入的 ICC profile，属于「像素级还原」范畴，不在本包定位内。
 */
function cmykToHex(args: Operand[]): string | undefined {
  const c = num(args[0]) ?? 0;
  const m = num(args[1]) ?? 0;
  const y = num(args[2]) ?? 0;
  const k = num(args[3]) ?? 0;
  const r = clamp255(Math.round((1 - Math.min(1, c + k)) * 255));
  const g = clamp255(Math.round((1 - Math.min(1, m + k)) * 255));
  const b = clamp255(Math.round((1 - Math.min(1, y + k)) * 255));
  if (r === 0 && g === 0 && b === 0) return undefined;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function hex2(v: number): string {
  return v.toString(16).padStart(2, '0');
}

function round(v: number): number {
  // 保留 3 位小数：0.001pt 远低于任何显示精度，但能显著减小模型体积
  return Math.round(v * 1000) / 1000;
}

/** 找内联图片的 EI，返回数据结束位置（不含 EI 前的空白）。 */
function findInlineImageEnd(buf: Uint8Array, start: number, filter: string): number {
  // DCTDecode（JPEG）：以 FFD9(EOI) 结束，直接找它最可靠
  if (/dct/i.test(filter)) {
    for (let i = start; i + 1 < buf.length; i++) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) return i + 2;
    }
  }
  // 通用：找「前后是空白/边界」的 EI
  let from = start;
  for (;;) {
    const at = indexOfAsciiLocal(buf, 'EI', from);
    if (at < 0) return -1;
    const before = at > start ? buf[at - 1] : 0x0a;
    const after = at + 2 < buf.length ? buf[at + 2] : 0x0a;
    if ((before === 0x0a || before === 0x0d || before === 0x20) && (after === 0x0a || after === 0x0d || after === 0x20 || after === 0x5d)) {
      let e = at;
      while (e > start && isWhite(buf[e - 1])) e--;
      return e;
    }
    from = at + 2;
  }
}

function indexOfAsciiLocal(buf: Uint8Array, needle: string, from: number): number {
  const first = needle.charCodeAt(0);
  const second = needle.charCodeAt(1);
  for (let i = Math.max(0, from); i + 1 < buf.length; i++) {
    if (buf[i] === first && buf[i + 1] === second) return i;
  }
  return -1;
}

export { isArray };
