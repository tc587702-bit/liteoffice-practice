/**
 * 页面树遍历与属性继承。
 *
 * 为什么要单独一层：/MediaBox、/Resources、/CropBox、/Rotate 都**可以写在
 * 祖先 /Pages 节点上**由子页继承。真实 PDF（尤其 Word/LibreOffice 导出的）
 * 极常见「整篇只有根 Pages 上写了一个 MediaBox」，如果只读页对象本身，
 * 所有页的尺寸都会是 undefined 然后退化成默认 A4 —— 表面上「能打开」，
 * 实际上每一页尺寸都是错的。
 *
 * 同时必须做环检测：畸形文件里 /Kids 可能指回祖先，盲目递归会栈溢出。
 */
import { arrayOf, dictName, isStream, numOf } from './objects.ts';
import type { PdfDict, PdfObject } from './objects.ts';

export interface PageInfo {
  /** 页面对象的对象号 */
  num: number;
  /** 页对象本身（条目解析用） */
  dict: PdfDict;
  /** 已解析继承后的 /MediaBox（pt，[x0 y0 x1 y1]） */
  mediaBox: number[] | undefined;
  /** 已解析继承后的 /CropBox */
  cropBox: number[] | undefined;
  /** 已解析继承后的 /Rotate（归一化到 0/90/180/270） */
  rotate: number;
  /** 已解析继承后的 /Resources（可能是间接引用，已解） */
  resources: PdfDict | undefined;
}

export interface PageTreeResult {
  pages: PageInfo[];
  /** 因 /Kids 畸形而放弃的分支数 */
  brokenBranches: number;
  /** 是否因为 maxPages 被截断 */
  truncated: boolean;
}

export interface PageTreeOptions {
  maxPages: number;
  /** 解析间接引用 */
  resolve(o: PdfObject): PdfObject;
  /** 记录降级说明 */
  note(message: string): void;
  /** 每个节点的对象号（用于取页面对象号，/Annots 之类会用到） */
  numOfRef(o: PdfObject): number;
}

const DEFAULT_MEDIA_BOX = [0, 0, 612, 792]; // 美国 Letter，PDF 规范给缺失 MediaBox 时的默认

/**
 * 遍历页面树。
 *
 * 注意：这里用**显式栈**而不是递归 —— 有些畸形文件的页面树深度上万，
 * 递归会直接爆栈（真实案例：某扫描软件把每页都挂在前一页下面）。
 */
export function walkPageTree(root: PdfDict, opts: PageTreeOptions): PageTreeResult {
  const pages: PageInfo[] = [];
  let brokenBranches = 0;
  let truncated = false;

  interface Frame {
    node: PdfDict;
    num: number;
    inherited: Inherited;
    visiting: Set<PdfDict>;
  }
  interface Inherited {
    mediaBox?: number[];
    cropBox?: number[];
    rotate?: number;
    resources?: PdfDict;
  }

  const seenNodes = new Set<PdfDict>();
  const stack: Frame[] = [{ node: root, num: opts.numOfRef(root), inherited: {}, visiting: new Set() }];

  while (stack.length) {
    const frame = stack.pop() as Frame;
    const node = frame.node;
    if (frame.visiting.has(node)) {
      brokenBranches++;
      opts.note('页面树里存在自引用（/Kids 指回祖先），已跳过该分支');
      continue;
    }
    if (seenNodes.has(node)) {
      // 同一个节点被两个父节点引用：只处理一次，避免重复出页
      brokenBranches++;
      continue;
    }
    seenNodes.add(node);

    const inherited = mergeInherited(frame.inherited, node, opts);
    const type = dictName(node, 'Type');
    const kids = arrayOf(node.Kids);

    // 判定叶子：有 /Kids 且不是 /Type /Page 就是中间节点。
    // 为什么还要看 /Type：有些文件在 /Page 上也留了空 /Kids 数组。
    if (kids && kids.length > 0 && type !== 'Page') {
      if (stack.length > 100_000) {
        brokenBranches++;
        opts.note('页面树节点数超过 10 万，已停止遍历（畸形文件保护）');
        break;
      }
      const visiting = new Set(frame.visiting);
      visiting.add(node);
      // 逆序入栈，保证出栈顺序与 /Kids 顺序一致（阅读顺序不能乱）
      for (let i = kids.length - 1; i >= 0; i--) {
        const kidRaw = opts.resolve(kids[i]);
        const kid = asDict(kidRaw);
        if (!kid) {
          brokenBranches++;
          continue;
        }
        stack.push({ node: kid, num: opts.numOfRef(kidRaw), inherited, visiting });
      }
      continue;
    }

    if (type === 'Pages' && (!kids || kids.length === 0)) {
      // /Type /Pages 但没有 /Kids：结构损坏，跳过
      brokenBranches++;
      continue;
    }
    if (pages.length >= opts.maxPages) {
      truncated = true;
      continue;
    }
    pages.push({
      num: frame.num,
      dict: node,
      mediaBox: inherited.mediaBox,
      cropBox: inherited.cropBox,
      rotate: inherited.rotate ?? 0,
      resources: inherited.resources,
    });
  }

  return { pages, brokenBranches, truncated };
}

interface InheritedBoxes {
  mediaBox?: number[];
  cropBox?: number[];
  rotate?: number;
  resources?: PdfDict;
}

function mergeInherited(parent: InheritedBoxes, node: PdfDict, opts: PageTreeOptions): InheritedBoxes {
  const out: InheritedBoxes = { ...parent };
  const mb = readBox(opts.resolve(node.MediaBox));
  if (mb) out.mediaBox = mb;
  const cb = readBox(opts.resolve(node.CropBox));
  if (cb) out.cropBox = cb;
  const rot = numOf(opts.resolve(node.Rotate));
  if (rot !== undefined) out.rotate = normalizeRotate(rot);
  if (node.Resources !== undefined) {
    const res = asDict(opts.resolve(node.Resources));
    if (res) out.resources = res;
  }
  return out;
}

/** 把 /Rotate 归一化到 0/90/180/270。负数与超过 360 的值都合法（要取模）。 */
export function normalizeRotate(v: number): number {
  let r = Math.round(v / 90) * 90;
  r %= 360;
  if (r < 0) r += 360;
  return r;
}

/** 读一个「4 个数字」的矩形数组；容错：允许间接引用元素与缺项。 */
export function readBox(o: PdfObject): number[] | undefined {
  const arr = arrayOf(o);
  if (!arr || arr.length < 4) return undefined;
  const vals: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = numOf(arr[i]);
    if (n === undefined) return undefined;
    vals.push(n);
  }
  // 归一化：MediaBox 允许写成 [x1 y1 x0 y0]（规范允许任意两个对角点）
  const x0 = Math.min(vals[0], vals[2]);
  const y0 = Math.min(vals[1], vals[3]);
  const x1 = Math.max(vals[0], vals[2]);
  const y1 = Math.max(vals[1], vals[3]);
  return [x0, y0, x1, y1];
}

/** 取页面尺寸（pt）。/CropBox 优先于 /MediaBox —— 这是「打印可见区域」的语义。 */
export function pageSize(info: PageInfo): { width: number; height: number; box: number[] } {
  const box = info.cropBox ?? info.mediaBox ?? DEFAULT_MEDIA_BOX;
  const w = Math.abs(box[2] - box[0]);
  const h = Math.abs(box[3] - box[1]);
  // 防御：0 或 NaN 尺寸会让视图完全不可用，退回 A4
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return { width: 595.276, height: 841.89, box: [0, 0, 595.276, 841.89] };
  }
  return { width: w, height: h, box };
}

export function asDict(o: PdfObject): PdfDict | undefined {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined;
  if (isStream(o)) return o.dict;
  if ('name' in o || 'bytes' in o || 'num' in o) return undefined;
  return o as PdfDict;
}
