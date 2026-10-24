import type { Component } from 'vue';
import type { DocFormat } from './types';
import MarkdownPreview from '../components/MarkdownPreview.vue';

/**
 * 预览渲染器的按需加载。
 *
 * 为什么用动态 import：三个组件的体积差很大（docx 1.2 MB / excel 13.5 MB /
 * pptx 9.3 MB，均为解压后）。如果静态 import，打开一个 docx 也要下载 24 MB。
 * 动态 import 让 Vite 把它们拆成独立 chunk，打开什么格式才下什么。
 *
 * 这也对应产品定位里的「轻量」：内部文档只做预览时不应该付出编辑器的代价。
 */

const cache = new Map<DocFormat, Component>();

/**
 * 各格式对应的组件模块 + 样式。
 *
 * CSS 用 `lib/index.css` 而不是 `lib/v3/index.css`：这两个包用 postinstall 脚本
 * 按 Vue 版本把 `v3/index.*` 复制成 `lib/index.*`（见 lib/script/utils.js 的 switchVersion）。
 * 引用 `lib/index.css` 与包作者的约定一致，也避免写死版本目录。
 * pptx 包没有附带样式文件，所以不引。
 */
async function loadComponent(format: DocFormat): Promise<Component | null> {
  switch (format) {
    case 'docx': {
      const [mod] = await Promise.all([
        import('@vue-office/docx'),
        import('@vue-office/docx/lib/index.css'),
      ]);
      return mod.default as Component;
    }
    case 'xlsx': {
      const [mod] = await Promise.all([
        import('@vue-office/excel'),
        import('@vue-office/excel/lib/index.css'),
      ]);
      return mod.default as Component;
    }
    case 'pptx': {
      const mod = await import('@vue-office/pptx');
      return mod.default as Component;
    }
    case 'md':
      /*
       * md 用自建渲染器（解析器 + VNode 渲染，合计约 40 KB），
       * 比任何一个 @vue-office 包都小两个数量级，所以**静态引入**即可 ——
       * 再拆 chunk 只会多一次请求，省不下有意义的体积。
       */
      return MarkdownPreview;
    default:
      return null;
  }
}

/** 取某个格式的预览组件；不支持时返回 null（调用方显示提示） */
export async function getPreviewComponent(format: DocFormat): Promise<Component | null> {
  const hit = cache.get(format);
  if (hit) return hit;
  const comp = await loadComponent(format);
  if (comp) cache.set(format, comp);
  return comp;
}

/** 是否能预览这个格式 */
export function canPreview(format: DocFormat): boolean {
  return format === 'docx' || format === 'xlsx' || format === 'pptx' || format === 'md';
}
