/**
 * @liteoffice/render-dom —— 把统一文档模型（UDM）渲染到 DOM。
 *
 * 四种渲染器，一个入口：
 *   - reflow.ts  文字文档（虚拟滚动 + 重流式高度回填 + 搜索高亮）
 *   - grid.ts    表格文档（行列双向虚拟化 + 异步读取竞态保护 + 合并单元格）
 *   - slides.ts  演示文档（按 pt 绝对定位形状 + IntersectionObserver 只渲染可见页）
 *   - pdf.ts     PDF（每页定尺寸容器 + 文本项绝对定位）
 *   - viewer.ts  统一 Viewer 接口与按 doc.kind 分派的工厂
 *
 * 分层原则（本包最重要的约定）：
 *   **纯布局数学在 layout.ts，DOM 操作在其余文件。**
 *   零依赖环境没有 jsdom，纯函数才能在 Node 里被 node:test 断言；
 *   而虚拟化最容易出错的地方（可见区间、偏移表、合并跨越、y 翻转）恰好都是纯数学。
 *
 * 安全约定：全程 createElement + textContent，**从不拼 innerHTML**。
 * 文档内容来自不可信文件，链接也只写 data-link 并由白名单协议代理跳转。
 */
export * from './layout.ts';
export { ReflowViewer, renderTable, paraSearchText } from './reflow.ts';
export { GridViewer } from './grid.ts';
export { SlidesViewer } from './slides.ts';
export { PdfViewer } from './pdf.ts';
export { createViewer, viewerKindFor, canRender } from './viewer.ts';
export type { Viewer } from './viewer.ts';
export type { Viewable } from './viewer-types.ts';
export { MediaUrls, createAnchor, isSafeUrl, attachLinkHandler, imagePlaceholder } from './domhelpers.ts';
