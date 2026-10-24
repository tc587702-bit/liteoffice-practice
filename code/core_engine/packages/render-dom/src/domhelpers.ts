/**
 * 渲染器共用的 DOM 小工具。
 *
 * 存在的唯一理由：四个渲染器（文字/表格/幻灯片/PDF）都要处理链接、图片 URL
 * 与「按 pt 绝对定位」这三件事。集中在这里可以保证：
 *   - 链接一律**不用 innerHTML**，并且不真实写入 href（见 createAnchor 的说明）
 *   - object URL 的创建与回收对称，避免幻灯片/PDF 反复渲染时泄漏 blob
 */
import { ptToPx } from '../../core/src/units.ts';
import type { InlineImage } from '../../core/src/model.ts';

/** 取 document（不缓存，测试可在任意时刻替换桩）。 */
export function doc(): Document {
  return globalThis.document;
}

export function create<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = globalThis.document.createElement(tag);
  if (className) el.className = className;
  return el;
}

export function div(className?: string): HTMLDivElement {
  return create('div', className);
}

export function span(className?: string): HTMLSpanElement {
  return create('span', className);
}

/** 一次性写多个 style 属性（比 Object.assign(el.style, …) 在类型上更安全） */
export function setStyle(el: HTMLElement, style: Record<string, string | number | undefined>): void {
  for (const [k, v] of Object.entries(style)) {
    if (v === undefined) continue;
    const key = k as keyof CSSStyleDeclaration;
    // 数字自动补 px；但 lineHeight/opacity/zIndex 等无单位属性必须显式传字符串
    (el.style as unknown as Record<string, string>)[key as string] = typeof v === 'number' ? `${v}px` : v;
  }
}

/** pt -> CSS px 字符串（渲染器里唯一的单位出口） */
export function px(pt: number): string {
  return `${ptToPx(pt)}px`;
}

/**
 * 创建超链接元素。
 *
 * **安全决定**：不把 URL 写进 href 属性，只放进 data-link。
 * 原因：`<a href="javascript:...">` 即使配合 textContent（无 innerHTML）依然可点击执行，
 * 而文档里的链接来自不可信文件内容 —— 这是比 innerHTML 更隐蔽的一条注入路径。
 * 真实跳转由 viewer 统一代理（见 domhelpers.attachLinkHandler），
 * 那里可以只放行 http/https/mailto 协议，把 javascript:/data: 挡掉。
 */
export function createAnchor(url: string, text: string, className = 'lo-link'): HTMLAnchorElement {
  const a = globalThis.document.createElement('a');
  a.className = className;
  a.textContent = text;
  a.setAttribute('data-link', url);
  a.setAttribute('rel', 'noopener noreferrer');
  a.setAttribute('title', url);
  return a;
}

/** 只放行常见安全协议，其余（javascript:/data:/vbscript:）一律不跳转 */
export function isSafeUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (u.startsWith('#')) return true;
  return /^(https?:|mailto:|tel:|ftp:)/.test(u);
}

/**
 * 给一个作用域挂上链接代理。返回卸载函数。
 *
 * 用**事件委托**而不是给每个 <a> 单独挂监听：虚拟列表会不停地
 * 创建/销毁节点，逐个挂监听既慢又容易漏掉回收，委托只有一个监听器。
 */
export function attachLinkHandler(scope: HTMLElement, onOpen?: (url: string) => void): () => void {
  const handler = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    const a = target?.closest?.('a[data-link]') as HTMLAnchorElement | null;
    if (!a) return;
    const url = a.getAttribute('data-link') ?? '';
    ev.preventDefault?.();
    if (!isSafeUrl(url)) {
      // 不安全协议：不跳转，交给调用方提示（默认静默忽略）
      return;
    }
    // globalThis.open 在 Node 里是 fs.open 的重导出，不能直接调用；
    // 只有浏览器（window.open 存在）才自动开新标签，否则交给调用方处理。
    const opener = (globalThis as unknown as { open?: (u: string, t: string, f: string) => unknown }).open;
    if (onOpen) onOpen(url);
    else if (typeof opener === 'function') opener(url, '_blank', 'noopener,noreferrer');
  };
  scope.addEventListener('click', handler);
  return () => scope.removeEventListener('click', handler);
}

/**
 * 图片 URL 管理器。
 *
 * 为什么需要它：InlineImage.data 是 Uint8Array，转成 <img src> 需要 Blob URL；
 * 而 Blob URL 不显式 revoke 会一直占住内存 ——
 * 在一个以「低内存」为主张的产品里，这是最不该犯的泄漏。
 * 虚拟滚动会反复创建同一张图的 URL，所以按 partPath 缓存，dispose 时统一回收。
 */
export class MediaUrls {
  private readonly urls = new Map<string, string>();
  private readonly created = new Set<string>();
  private counter = 0;

  /** 返回可直接用的 src；无法创建时返回 null（调用方降级为占位块） */
  srcFor(image: InlineImage | undefined, key: string): string | null {
    if (!image) return null;
    const cacheKey = image.partPath ?? key;
    const hit = this.urls.get(cacheKey);
    if (hit) return hit;
    const data = image.data;
    if (!data || data.byteLength === 0) return null;
    const createObjectURL = (globalThis as unknown as { URL?: { createObjectURL?: (b: Blob) => string } }).URL?.createObjectURL;
    const BlobCtor = (globalThis as unknown as { Blob?: new (parts: unknown[], opts: { type: string }) => Blob }).Blob;
    if (typeof createObjectURL !== 'function' || typeof BlobCtor !== 'function') {
      // 环境不支持（例如 Node 测试桩）——降级为占位，不抛错
      return null;
    }
    let url: string;
    try {
      url = createObjectURL(new BlobCtor([data], { type: image.mime || 'application/octet-stream' }));
    } catch {
      return null;
    }
    this.urls.set(cacheKey, url);
    this.created.add(url);
    this.counter++;
    return url;
  }

  get count(): number {
    return this.urls.size;
  }

  dispose(): void {
    const revoke = (globalThis as unknown as { URL?: { revokeObjectURL?: (u: string) => void } }).URL?.revokeObjectURL;
    if (typeof revoke === 'function') {
      for (const u of this.created) {
        try {
          revoke(u);
        } catch {
          /* 已回收或环境不支持，忽略 */
        }
      }
    }
    this.created.clear();
    this.urls.clear();
  }
}

/** 图片缺字节时的占位（不能留白，否则用户以为文档坏了） */
export function imagePlaceholder(image: InlineImage | undefined): string {
  if (!image) return '[图片]';
  const w = Math.round(ptToPx(image.width || 0));
  const h = Math.round(ptToPx(image.height || 0));
  const alt = image.alt ? ` ${image.alt}` : '';
  return `[图片${alt} ${w}×${h}px]`;
}

/** 可见性判断（不依赖 IntersectionObserver 的兜底路径） */
export function isVerticallyVisible(el: HTMLElement, scrollTop: number, viewportHeight: number, margin = 0): boolean {
  const top = el.offsetTop;
  const bottom = top + (el.offsetHeight || 0);
  return bottom >= scrollTop - margin && top <= scrollTop + viewportHeight + margin;
}

/** 用 rAF 合并高频事件（scroll 每帧触发多次会做重复的重排） */
export function rafThrottle(fn: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    const raf = (globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    const run = (): void => {
      pending = false;
      fn();
    };
    if (typeof raf === 'function') raf(run);
    else run();
  };
}
