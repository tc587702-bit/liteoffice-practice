import type { OpenDoc, SaveResult } from './types';
import { features } from './features';

/**
 * 编辑器适配层。
 *
 * 这是整个项目**唯一**允许知道"用的是哪个编辑器"的地方。
 * UI（Workbench / EditorHost / TopBar）只认这个接口，不认 ONLYOFFICE。
 */

export interface EditorAdapter {
  /** 实现名，用于状态栏显示 */
  readonly kind: string;
  /** 把文档装载到 host 元素里 */
  open(doc: OpenDoc, host: HTMLElement): Promise<void>;
  /** 取回编辑后的内容 */
  save(): Promise<SaveResult>;
  /** 释放资源 */
  dispose(): void;
  /** 给用户的一句话提示（没有可提示的内容时返回 undefined） */
  hint?(): string | undefined;
}

/* ==================================================================== */
/* 实现一：占位（未接入编辑器时使用）                                    */
/* ==================================================================== */

class PlaceholderAdapter implements EditorAdapter {
  readonly kind = 'placeholder';
  private host: HTMLElement | null = null;
  private doc: OpenDoc | null = null;

  async open(doc: OpenDoc, host: HTMLElement): Promise<void> {
    this.doc = doc;
    this.host = host;
    this.render();
  }

  async save(): Promise<SaveResult> {
    // 没有编辑器时，「保存」就是把原始文件原样下载一次 —— 语义上等于「另存为」
    if (!this.doc) return { ok: false, message: '当前没有打开的文档' };
    return { ok: true, blob: this.doc.blob, filename: this.doc.name };
  }

  dispose(): void {
    this.host?.replaceChildren();
    this.host = null;
    this.doc = null;
  }

  private render(): void {
    const host = this.host;
    const doc = this.doc;
    if (!host || !doc) return;
    host.replaceChildren();

    const box = document.createElement('div');
    box.style.cssText =
      'height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'gap:12px;color:#5b6472;font-size:14px;line-height:1.9;text-align:center;padding:24px;';

    const title = document.createElement('div');
    title.textContent = `已就绪：${doc.name}`;
    title.style.cssText = 'font-size:18px;font-weight:600;color:#1f2733;';

    const meta = document.createElement('div');
    meta.textContent = `格式 ${doc.format.toUpperCase()} · ${(doc.size / 1024).toFixed(1)} KiB`;

    const hint = document.createElement('div');
    hint.textContent = '编辑器未启用（features.editorEnabled = false），当前仅演示文件流。';

    box.append(title, meta, hint);
    host.appendChild(box);
  }
}

/* ==================================================================== */
/* 实现二：iframe 隔离的 ONLYOFFICE                                      */
/* ==================================================================== */

/** 子页面消息来源标识，和 src/editor/main-editor.ts 里的一致 */
const FRAME_SOURCE = 'liteoffice-editor';

interface FrameMessage {
  source?: string;
  type?: string;
  message?: string;
  fileName?: string;
  buffer?: ArrayBuffer;
}

/**
 * ONLYOFFICE 适配器（iframe 隔离方案）。
 *
 * ## 为什么不直接挂载到子区域
 * `onlyoffice-web-local` 是按「整页应用」设计的：容器高度写死 100vh，
 * 路由带 `?url=`。直接塞进主界面的一块区域会出现坐标错乱 ——
 * 实测症状是「文字渲染完全正常，但光标永远停在文字上方约一行」。
 *
 * 同一个库在官方 demo（整页环境）里光标完全正常，所以问题出在封装方式，
 * 不是库本身或浏览器。让编辑器独占一个页面（iframe）后，
 * 那个页面里 100vh 就等于 iframe 高度，正是它期望的环境。
 *
 * ## 保存怎么跨 iframe
 * 子页面没有公开保存 API，只能触发编辑器自己的导出按钮，然后从
 * `URL.createObjectURL` 截获产物（ZIP 头校验）。拿到字节后通过
 * postMessage 把 ArrayBuffer **转移**回父页面，由父页面用我们的
 * 文件名触发下载 —— 这样文件名和提示都在我们控制之下。
 */
class OnlyOfficeAdapter implements EditorAdapter {
  readonly kind = 'onlyoffice';
  private host: HTMLElement | null = null;
  private doc: OpenDoc | null = null;
  private frame: HTMLIFrameElement | null = null;
  /** 传给编辑器的 blob URL，dispose 时撤销 */
  private objectUrl: string | null = null;
  /** 等待中的保存请求 */
  private pendingSave: {
    resolve: (r: SaveResult) => void;
    timer: number;
  } | null = null;
  /** ready 之前收到的错误，open() 里要能看到 */
  private bootError: string | null = null;
  private messageHandler: ((e: MessageEvent) => void) | null = null;

  async open(doc: OpenDoc, host: HTMLElement): Promise<void> {
    this.doc = doc;
    this.host = host;
    this.bootError = null;
    host.replaceChildren();

    const objectUrl = URL.createObjectURL(doc.blob);
    this.objectUrl = objectUrl;

    const src =
      `/editor.html?file=${encodeURIComponent(objectUrl)}` +
      `&name=${encodeURIComponent(doc.name)}` +
      `&path=${encodeURIComponent('/onlyoffice')}`;

    const frame = document.createElement('iframe');
    frame.className = 'lo-editor-frame';
    frame.setAttribute('title', `编辑器：${doc.name}`);
    frame.src = src;
    this.frame = frame;

    this.messageHandler = (event: MessageEvent) => this.onMessage(event);
    window.addEventListener('message', this.messageHandler);

    host.appendChild(frame);

    // 等子页面的 ready（或错误）。编辑器初始化要加载脚本和 WASM，给足时间。
    /*
     * 超时给到 3 分钟。
     *
     * 编辑模式首次要下约 199 MB（sdkjs + web-apps + 56 MB 的 x2t.wasm）。
     * 在局域网里另一台电脑上，这个量级 1～3 分钟很正常；
     * 早先设 60 秒会把「还在正常下载」误判成失败，用户以为坏了。
     */
    await this.waitForReady(180000);

    const err = this.bootError;
    this.bootError = null;
    if (err) throw new Error(err);
  }

  async save(): Promise<SaveResult> {
    if (!this.doc) return { ok: false, message: '当前没有打开的文档' };
    if (!this.frame?.contentWindow) return { ok: false, message: '编辑器还没准备好' };

    return new Promise<SaveResult>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pendingSave = null;
        resolve({
          ok: false,
          message: '保存超时：已触发编辑器导出但 20 秒内没拿到文件。若弹出过「另存为」对话框，请确认是否已保存。',
        });
      }, 20000);

      this.pendingSave = { resolve, timer };
      this.frame?.contentWindow?.postMessage({ type: 'save' }, location.origin);
    });
  }

  hint(): string | undefined {
    return '保存会触发编辑器导出，部分格式可能弹出「另存为」对话框';
  }

  dispose(): void {
    if (this.pendingSave) {
      window.clearTimeout(this.pendingSave.timer);
      this.pendingSave.resolve({ ok: false, message: '文档已关闭，保存取消' });
      this.pendingSave = null;
    }
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.frame?.remove();
    this.frame = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.host?.replaceChildren();
    this.host = null;
    this.doc = null;
  }

  /* ---------------- 内部：消息处理 ---------------- */

  private onMessage(event: MessageEvent): void {
    // 只接受同源、且来自我们自己那个 iframe 的消息
    if (event.origin !== location.origin) return;
    if (this.frame && event.source !== this.frame.contentWindow) return;

    const data = event.data as FrameMessage | null;
    if (!data || data.source !== FRAME_SOURCE) return;

    switch (data.type) {
      case 'error':
        this.bootError = data.message ?? '编辑器报告了一个错误';
        this.rejectPending(data.message ?? '编辑器出错');
        break;
      case 'save-ready': {
        const pending = this.pendingSave;
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pendingSave = null;
        if (!data.buffer) {
          pending.resolve({ ok: false, message: '编辑器没有返回文件内容' });
          return;
        }
        const blob = new Blob([data.buffer]);
        pending.resolve({ ok: true, blob, filename: data.fileName ?? this.doc?.name ?? 'document' });
        break;
      }
      case 'save-error':
        this.rejectPending(data.message ?? '保存失败');
        break;
      default:
        break;
    }
  }

  private rejectPending(message: string): void {
    const pending = this.pendingSave;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pendingSave = null;
    pending.resolve({ ok: false, message });
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = (): void => {
        // 错误会通过 onMessage 写进 bootError；ready 之后 open 直接返回
        if (this.bootError) {
          resolve();
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          this.bootError = '编辑器初始化超时（3 分钟）。可能是这台电脑网络太慢、内存不足，或浏览器不支持 WebAssembly。';
          resolve();
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }
}

/**
 * 工厂：决定用哪个实现。
 * 换编辑器的唯一改动点就是这里。
 */
export function createEditorAdapter(): EditorAdapter {
  return features.editorEnabled ? new OnlyOfficeAdapter() : new PlaceholderAdapter();
}
