/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/**
 * onlyoffice-web-local 在 package.json 里声明了 `"types": "dist/index.d.ts"`，
 * 但发布包里**没有这个文件**（unpkg 与本地 node_modules 均确认）。
 * 所以必须手写声明，否则 vue-tsc 会报「找不到类型声明」。
 *
 * 下面的形状是**从 dist/onlyoffice-web-local.es.js 里读出来的**，不是猜的：
 *
 *   export { u as DocumentHandler, wA as default, gA as mountDocumentHandler }
 *
 *   async function gA(o) {
 *     const { container, fileUrl, fileName, resourcePath } = o;
 *     ...
 *     if (!w) throw new Error("container not found");
 *     A && (P = await AA(A, Q));     // 对 fileUrl 做 fetch，包成 File
 *     return { app, vm, unmount };
 *   }
 *
 * 两个容易写错的点（都实际踩过）：
 *   1. **只接受一个对象参数**，不是 (container, options)
 *   2. **没有 file 参数**，只有 fileUrl（我们传 blob: URL）
 */
declare module 'onlyoffice-web-local' {
  export interface MountOptions {
    /** 容器元素或 CSS 选择器 */
    container: HTMLElement | string;
    /** 文档地址。可以传 blob: URL —— 同源可 fetch，文件不上传 */
    fileUrl?: string;
    /**
     * 文件名。必须传：内部会用它判断文件类型，
     * 而 blob URL 的末段是一串 UUID、没有扩展名。
     */
    fileName?: string;
    /** 静态资源根路径（sdkjs / web-apps / wasm / fonts 所在处） */
    resourcePath?: string;
  }

  export interface MountHandle {
    app?: unknown;
    vm?: unknown;
    unmount?: () => void;
  }

  /** 注意返回的是 Promise —— 忘了 await 会变成未处理的拒绝，症状是「异步任务出错」 */
  export function mountDocumentHandler(options: MountOptions): Promise<MountHandle>;

  /** 底层 bin ↔ 文档格式转换器（未导出实例，仅供类型参考） */
  export class DocumentHandler {
    constructor(...args: unknown[]);
  }

  const _default: unknown;
  export default _default;
}
