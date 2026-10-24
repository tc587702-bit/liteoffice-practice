/**
 * Viewer 的公共类型。
 *
 * 单独成一个文件是为了**避免循环 import**：
 * viewer.ts 要知道四种渲染器的类型，而渲染器要实现 Viewable；
 * 如果 Viewable 定义在 viewer.ts 里就成环了（ESM 能容忍一部分，
 * 但模块顶层求值顺序会变得脆弱，例如 registerReader 这类副作用）。
 *
 * 对外契约见 viewer.ts 的 Viewer —— 这里只是内部实现约定：
 * 多两个可选方法（unmount / setAvailableWidth），供 Web 壳在
 * 标签页切换、侧栏折叠时调用。
 */
import type { LiteDocument, OutlineTarget } from '../../core/src/model.ts';

export interface Viewable {
  /** 渲染器的根元素；宿主只需把它 append 到容器里 */
  readonly element: HTMLElement;
  mount(container: HTMLElement): void;
  /** 从宿主容器上摘下来但**不销毁**（标签页切换时用，保留状态以便切回） */
  unmount?(): void;
  setDocument(doc: LiteDocument): void;
  setZoom(zoom: number): void;
  scrollTo(target: OutlineTarget): void;
  search(query: string, from?: number): { index: number; total: number } | null;
  /** 当前实际存在的 DOM 节点数（虚拟化的证据） */
  readonly renderedNodes: number;
  dispose(): void;
  /** 可用宽度变化（侧栏开合、窗口 resize）时通知渲染器重算版心 */
  setAvailableWidth?(widthPx: number): void;
}
