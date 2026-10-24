/**
 * 编辑器独立页面。
 *
 * 为什么要有这个页面：onlyoffice-web-local 是按「整页应用」设计的
 * （它的容器高度写死 100vh、路由带 ?url=）。把它直接塞进主界面的一个子区域，
 * 会出现坐标错乱 —— 实测症状是「文字渲染正常，但光标永远在文字上方一行」。
 * 同一个库在官方 demo（整页环境）里光标完全正常，所以问题出在封装方式。
 *
 * 解决办法：让它独占一个页面，我们外面用 iframe 套住。
 * 在这个页面里 100vh 就等于 iframe 的高度，正是它期望的环境。
 *
 * 与父页面的通信（postMessage）：
 *   子 → 父：
 *     { source: 'liteoffice-editor', type: 'ready' }
 *     { source: 'liteoffice-editor', type: 'error', message }
 *     { source: 'liteoffice-editor', type: 'save-ready', fileName, buffer }   buffer 为 ArrayBuffer
 *     { source: 'liteoffice-editor', type: 'save-error', message }
 *   父 → 子：
 *     { type: 'save' }
 */
import { mountDocumentHandler } from 'onlyoffice-web-local';

const SOURCE = 'liteoffice-editor';

const params = new URLSearchParams(location.search);
const fileUrl = params.get('file') ?? '';
const fileName = params.get('name') ?? '';
const resourcePath = params.get('path') ?? '/onlyoffice';

/** 捕获到的导出产物（编辑器导出时会产生 Blob） */
let captured: Blob | null = null;
/** 被替换前的 createObjectURL，用于捕获 */
let originalCreate: typeof URL.createObjectURL | null = null;

function post(msg: Record<string, unknown>, transfer?: Transferable[]): void {
  parent.postMessage({ source: SOURCE, ...msg }, location.origin, transfer ?? []);
}

function showError(message: string): void {
  const el = document.getElementById('editor-error');
  if (el) {
    el.textContent = message;
    el.classList.add('show');
  }
  post({ type: 'error', message });
}

/**
 * 挂钩 URL.createObjectURL，把编辑器导出的 Blob 抓下来。
 *
 * 为什么必须这样：这个包没有公开的保存 API（package.json 声明了
 * dist/index.d.ts 但没发布），真正的导出靠编辑器自己的按钮触发，
 * 产物通过 createObjectURL 变成下载链接。我们在这一步截获字节。
 * 只接受 ZIP 头（PK\x03\x04），避免误收图片等其它 Blob。
 */
function hookObjectUrl(): void {
  if (originalCreate) return;
  const original = URL.createObjectURL.bind(URL);
  originalCreate = URL.createObjectURL;
  URL.createObjectURL = function patched(obj: Blob | MediaSource): string {
    const url = original(obj);
    if (obj instanceof Blob && obj.size > 1024 && !captured) {
      void (async () => {
        try {
          const head = new Uint8Array(await obj.slice(0, 4).arrayBuffer());
          if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
            captured = obj;
          }
        } catch {
          /* 读不出来就放弃捕获 */
        }
      })();
    }
    return url;
  };
}

/** 在页面里找编辑器的导出按钮并点击 */
function clickExport(): boolean {
  const PATTERN = /导出|保存|下载|export|save|download/i;
  const all = document.querySelectorAll(
    'button, [role="button"], a, [class*="btn"], [class*="save"], [class*="export"], [class*="download"]',
  );
  const candidates: HTMLElement[] = [];
  for (const el of all) {
    if (!(el instanceof HTMLElement)) continue;
    const text = `${el.textContent ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
    if (PATTERN.test(text)) candidates.push(el);
  }
  const target =
    candidates.find((el) => el.tagName === 'BUTTON') ??
    candidates.find((el) => /save|export|download/i.test(el.className)) ??
    candidates[0];
  if (!target) return false;
  target.click();
  return true;
}

async function waitForCapture(timeoutMs: number): Promise<Blob | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (captured) return captured;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** 父页面要求保存时的处理 */
async function handleSave(): Promise<void> {
  try {
    // 已有产物直接用
    let blob = captured;
    if (!blob) {
      if (!clickExport()) {
        post({
          type: 'save-error',
          message: '没找到编辑器里的导出按钮，请直接在编辑器工具栏点「导出 / 保存」。',
        });
        return;
      }
      blob = await waitForCapture(12000);
    }
    if (!blob) {
      post({
        type: 'save-error',
        message: '已触发导出，但 12 秒内没拿到产物。若弹出过「另存为」对话框，请确认是否已保存。',
      });
      return;
    }
    const buffer = await blob.arrayBuffer();
    post({ type: 'save-ready', fileName, buffer }, [buffer]);
  } catch (err) {
    post({ type: 'save-error', message: err instanceof Error ? err.message : String(err) });
  }
}

async function boot(): Promise<void> {
  if (!fileUrl || !fileName) {
    showError('缺少 file 或 name 参数，无法打开文档。');
    return;
  }

  hookObjectUrl();

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data as { type?: string } | null;
    if (data?.type === 'save') void handleSave();
  });

  try {
    await mountDocumentHandler({
      container: '#editor-root',
      fileUrl,
      fileName,
      resourcePath,
    });
    post({ type: 'ready' });
  } catch (err) {
    showError(`编辑器装载失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

void boot();
