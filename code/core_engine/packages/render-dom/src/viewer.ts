/**
 * 统一 Viewer 接口 + 按 doc.kind 分派的工厂。
 *
 * 这是「M 种格式 × N 种视图」被压成「M + N」之后，N 这一侧的唯一入口：
 * Web 壳（以及将来的桌面/移动壳）只认识 Viewer，不认识 reflow/grid/slides/pdf。
 * 于是新增一种文档类别（例如 .numbers）时，壳代码一行都不用改。
 */
import type { DocKind, LiteDocument, OutlineTarget } from '../../core/src/model.ts';
import type { Viewable } from './viewer-types.ts';
import { ReflowViewer } from './reflow.ts';
import { GridViewer } from './grid.ts';
import { SlidesViewer } from './slides.ts';
import { PdfViewer } from './pdf.ts';

export interface Viewer {
  /** 渲染器根元素，宿主 append 到容器即可 */
  readonly element: HTMLElement;
  mount(container: HTMLElement): void;
  /** 从容器上摘下来但不销毁（标签页切换用） */
  unmount(): void;
  setDocument(doc: LiteDocument): void;
  setZoom(zoom: number): void;
  scrollTo(target: OutlineTarget): void;
  /** 返回「当前命中序号 / 总数」，无命中返回 null */
  search(query: string, from?: number): { index: number; total: number } | null;
  /** 当前实际创建的 DOM 节点数，供内存 HUD 展示虚拟化效果 */
  readonly renderedNodes: number;
  dispose(): void;
  /** 可用宽度变化（侧栏开合/窗口缩放）时通知渲染器 */
  setAvailableWidth(widthPx: number): void;
}

/** 每种文档类别对应的渲染器构造器。新增类别只需在这里加一行。 */
const FACTORIES: Record<DocKind, () => Viewable> = {
  text: () => new ReflowViewer(),
  // raw 文档（未知格式）没有结构化模型，用文字渲染器兜底展示 doc.text
  raw: () => new ReflowViewer(),
  sheet: () => new GridViewer(),
  slides: () => new SlidesViewer(),
  pdf: () => new PdfViewer(),
};

export function viewerKindFor(doc: LiteDocument): DocKind {
  return doc.kind in FACTORIES ? doc.kind : 'raw';
}

/**
 * 创建渲染器。
 *
 * 注意这里**必须立刻 setDocument(doc)**：工厂只负责按类别挑渲染器，
 * 而每个渲染器的构造函数都把 doc 置为 null，只有 setDocument() 才会赋值。
 * 早期版本漏了这一步，`createViewer(doc).mount(el)` 会渲染出 0 个块
 * （DOM 里只有 lo-viewer/lo-scroller/lo-content/lo-spacer 几个包装节点），
 * 也就是整页白屏 —— 而调用方写的是 API 字面意思，完全无从察觉。
 * 回归测试见 test/render-dom.test.ts 的「createViewer 必须交出文档」。
 *
 * setAvailableWidth 的默认实现：文字渲染器需要重算版心（影响换行与高度估算），
 * 其余三种视图的尺寸由 CSS 宽度自适应，不需要参与，所以默认是空实现。
 */
export function createViewer(doc: LiteDocument): Viewer {
  const kind = viewerKindFor(doc);
  const inner = FACTORIES[kind]();
  inner.setDocument(doc);

  const viewer: Viewer = {
    get element(): HTMLElement {
      return inner.element;
    },
    mount(container: HTMLElement): void {
      inner.mount(container);
    },
    unmount(): void {
      inner.unmount?.();
      // 不销毁：把根元素从宿主里摘下来即可（切回时状态还在）
      inner.element.remove();
    },
    setDocument(next: LiteDocument): void {
      inner.setDocument(next);
    },
    setZoom(zoom: number): void {
      inner.setZoom(zoom);
    },
    scrollTo(target: OutlineTarget): void {
      inner.scrollTo(target);
    },
    search(query: string, from = 0): { index: number; total: number } | null {
      return inner.search(query, from);
    },
    get renderedNodes(): number {
      return inner.renderedNodes;
    },
    dispose(): void {
      inner.dispose();
    },
    setAvailableWidth(widthPx: number): void {
      inner.setAvailableWidth?.(widthPx);
    },
  };
  return viewer;
}

/** 该文档类别是否已有渲染器（供 UI 提前判断，避免创建后再失败） */
export function canRender(kind: DocKind): boolean {
  return kind in FACTORIES;
}
