/**
 * 最小 DOM 桩（**仅供测试**）。
 *
 * 为什么放在 packages/render-dom/testutil/ 而不是 src/：
 *   tools/build.mjs 只擦除各包 src 目录下的 .ts，放在 src/ 下会被一起
 *   构建进浏览器产物 —— 那是一个没人 import 的独立文件，功能上无害，
 *   但属于「测试代码混进发布产物」，不干净，而且测试辅助代码一旦有语法问题
 *   会把整个构建拖挂（这已经真实发生过一次）。
 *   放在 testutil/ 就完全不会进入构建。
 *   注意写这类注释时不要出现「星号紧跟斜杠」的序列（那会提前闭合块注释），
 *   tools/lint.mjs 里有专门一条检查盯着它。
 *
 * 为什么必须自己写：
 *   项目零依赖 —— 没有 jsdom、没有 happy-dom。但虚拟化渲染器最有价值的断言
 *   （「2000 段文档只创建了 N 个节点」）恰恰只有把渲染器真正跑起来才能得到。
 *   只测纯函数覆盖不到「有没有忘记回收节点」「重复渲染同一段」这类 bug。
 *
 * 设计取舍：
 *   1. **只实现渲染器真正用到的那部分 API**。多实现一个方法就多一处可能与
 *      真实浏览器行为不一致的地方，反而制造「测试通过但浏览器崩」的假安全感。
 *      这里刻意不实现 innerHTML —— 渲染器本来就被禁止用它。
 *   2. `style` 是普通对象（渲染器只 set 属性），另加 `cssText` 访问器。
 *   3. `getBoundingClientRect()` / `offsetHeight` 默认返回 0：Node 里没有排版
 *      引擎，渲染器必须自己处理「测不到尺寸」的情况（回填逻辑正是要防这个）。
 *      测试需要时手动设 `offsetHeight` / `clientHeight` 模拟。
 *   4. `textContent` 与真实 DOM 一致：**读取时递归拼接后代文本节点**。
 *      早期版本把它做成普通存储属性，导致「段落元素只有文本子节点时
 *      textContent === null」，写测试时取到 0 个字符。
 */

export interface StubEvent {
  type: string;
  target?: unknown;
  clientX?: number;
  clientY?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  key?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  [key: string]: unknown;
}

type Listener = (ev: StubEvent) => void;

class StubNode {
  nodeType = 1;
  nodeName = 'NODE';
  parentNode: StubElement | null = null;
  childNodes: StubNode[] = [];

  /** 真实 DOM 语义：递归拼接所有后代文本节点（见文件头说明 4） */
  get textContent(): string {
    let out = '';
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  set textContent(v: string) {
    this.childNodes.length = 0;
    if (v !== '' && v !== null && v !== undefined) {
      const t = new StubText(String(v));
      // 必须同时设 parentNode：真实 DOM 里子节点的 parentNode 一定指向父节点。
      // 早期版本只 push 进 childNodes，导致「给元素赋 textContent 后，
      // 它的文本子节点 parentNode 为 null」，于是任何依赖
      // child.parentNode 的代码（例如搜索高亮的插入逻辑）都会静默失效 ——
      // 测试表现为「功能明明写了却毫无效果」，极难定位。
      t.parentNode = this;
      this.childNodes.push(t);
    }
  }

  get firstChild(): StubNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): StubNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): StubNode | null {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes;
    const i = sibs.indexOf(this);
    return i >= 0 ? (sibs[i + 1] ?? null) : null;
  }
}

class StubText extends StubNode {
  private data_: string;

  constructor(text: string) {
    super();
    this.nodeType = 3;
    this.nodeName = '#text';
    this.data_ = text;
  }

  get textContent(): string {
    return this.data_;
  }

  set textContent(v: string) {
    this.data_ = v === null || v === undefined ? '' : String(v);
  }

  get nodeValue(): string {
    return this.data_;
  }

  set nodeValue(v: string) {
    this.data_ = v;
  }

  get data(): string {
    return this.data_;
  }

  set data(v: string) {
    this.data_ = v;
  }
}

export class StubClassList {
  private readonly el: StubElement;

  constructor(el: StubElement) {
    this.el = el;
  }

  private tokens(): string[] {
    const raw = this.el._attrs.get('class') ?? '';
    return raw.split(/\s+/).filter(Boolean);
  }

  private write(tokens: string[]): void {
    if (tokens.length === 0) this.el._attrs.delete('class');
    else this.el._attrs.set('class', tokens.join(' '));
  }

  add(...names: string[]): void {
    const t = this.tokens();
    for (const n of names) if (n && !t.includes(n)) t.push(n);
    this.write(t);
  }

  remove(...names: string[]): void {
    this.write(this.tokens().filter((x) => !names.includes(x)));
  }

  contains(name: string): boolean {
    return this.tokens().includes(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const want = force === undefined ? !has : force;
    if (want) this.add(name);
    else this.remove(name);
    return want;
  }

  get length(): number {
    return this.tokens().length;
  }

  item(i: number): string | null {
    return this.tokens()[i] ?? null;
  }

  /** 便于断言；真实 DOM 的 value 是只读字符串 */
  get value(): string {
    return this.tokens().join(' ');
  }
}

/** 极简 style：真实浏览器里是 CSSStyleDeclaration，渲染器只做属性赋值 */
export function createStubStyle(): Record<string, string> {
  const store: Record<string, string> = {};
  return new Proxy(store, {
    get(target, prop: string): unknown {
      if (prop === 'cssText') {
        return Object.keys(target)
          .map((k) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${target[k]}`)
          .join(';');
      }
      if (prop === 'setProperty') return (k: string, v: string): void => void (target[k] = v);
      if (prop === 'getPropertyValue') return (k: string): string => target[k] ?? '';
      if (prop === 'removeProperty') return (k: string): void => void delete target[k];
      return target[prop];
    },
    set(target, prop: string, value: unknown): boolean {
      const v = value === undefined || value === null ? '' : String(value);
      if (prop === 'cssText') {
        for (const k of Object.keys(target)) delete target[k];
        for (const decl of v.split(';')) {
          const i = decl.indexOf(':');
          if (i <= 0) continue;
          const k = decl.slice(0, i).trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
          target[k] = decl.slice(i + 1).trim();
        }
        return true;
      }
      target[prop] = v;
      return true;
    },
    has(target, prop: string): boolean {
      return prop in target;
    },
    ownKeys(target): string[] {
      return Object.keys(target);
    },
    getOwnPropertyDescriptor(target, prop: string): PropertyDescriptor | undefined {
      return Object.getOwnPropertyDescriptor(target, prop);
    },
  });
}

export class StubElement extends StubNode {
  readonly tagName: string;
  readonly localName: string;
  readonly style: Record<string, string>;
  readonly classList: StubClassList;
  /** 属性表；class 也存在这里，便于 querySelector('[attr=...]') */
  readonly _attrs = new Map<string, string>();
  readonly _listeners = new Map<string, Listener[]>();
  readonly dataset: Record<string, string> = {};

  /* --- 布局：普通可写字段，测试可自由伪造 --- */
  clientWidth = 0;
  clientHeight = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  offsetTop = 0;
  offsetLeft = 0;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  scrollWidth = 0;
  hidden = false;
  value = '';
  checked = false;
  disabled = false;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.nodeName = this.tagName;
    this.style = createStubStyle();
    this.classList = new StubClassList(this);
  }

  /**
   * className 与 classList / _attrs 共用同一份存储。
   *
   * 早期版本让 classList 写 _attrs、而 `el.className = 'x'` 只写一个普通字段，
   * 两者不同步 —— 于是渲染器用 className 设的 class 在 _attrs 里查不到，
   * 「按 class 统计渲染结果」的测试会莫名其妙地全为空。
   * 真实 DOM 里 className 与 classList 本来就是同一个属性的两个视图。
   */
  get className(): string {
    return this._attrs.get('class') ?? '';
  }

  set className(v: string) {
    const s = v === null || v === undefined ? '' : String(v);
    if (s) this._attrs.set('class', s);
    else this._attrs.delete('class');
  }

  /** id 同理：与 _attrs 保持同步，getAttribute('id') 才查得到 */
  get id(): string {
    return this._attrs.get('id') ?? '';
  }

  set id(v: string) {
    const s = v === null || v === undefined ? '' : String(v);
    if (s) this._attrs.set('id', s);
    else this._attrs.delete('id');
  }

  /* ------------------------------ 树操作 ------------------------------ */

  get children(): StubElement[] {
    return this.childNodes.filter((n): n is StubElement => n instanceof StubElement);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get parentElement(): StubElement | null {
    return this.parentNode;
  }

  get ownerDocument(): unknown {
    let n: StubNode = this;
    while (n.parentNode) n = n.parentNode;
    return (n as unknown as { _doc?: unknown })._doc ?? null;
  }

  appendChild<T extends StubNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  /** 真实 DOM 语义：可一次插入多个节点或字符串 */
  append(...nodes: (StubNode | string)[]): void {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new StubText(n) : n);
  }

  insertBefore<T extends StubNode>(child: T, ref: StubNode | null): T {
    if (!ref) return this.appendChild(child);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(i, 0, child);
    return child;
  }

  removeChild<T extends StubNode>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...nodes: (StubNode | string)[]): void {
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  contains(node: StubNode | null): boolean {
    if (!node) return false;
    if ((node as unknown) === this) return true;
    for (const c of this.childNodes) if (c === node || c.contains(node)) return true;
    return false;
  }

  /* ------------------------------ 属性 ------------------------------ */

  setAttribute(name: string, value: unknown): void {
    const v = value === undefined || value === null ? '' : String(value);
    this._attrs.set(name, v);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      this.dataset[key] = v;
    }
  }

  getAttribute(name: string): string | null {
    return this._attrs.has(name) ? this._attrs.get(name)! : null;
  }

  hasAttribute(name: string): boolean {
    return this._attrs.has(name);
  }

  removeAttribute(name: string): void {
    this._attrs.delete(name);
  }

  /** 设置元素自身文本（会清空子节点，与真实 DOM 赋值 textContent 一致） */
  setText(text: unknown): void {
    this.textContent = text === undefined || text === null ? '' : String(text);
  }

  /* ------------------------------ 查询 ------------------------------ */

  /**
   * 支持以逗号分隔的多种选择器：
   *   标签名（div）、.class、tag.class、[attr]、[attr="v"]、[attr^="v"]
   * 不支持后代/子选择器 —— 渲染器用不到，而写一个半吊子的组合选择器
   * 会让测试给出错误信心。
   */
  querySelectorAll(selector: string): StubElement[] {
    const out: StubElement[] = [];
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    collect(this, parts, out);
    return out;
  }

  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  matches(selector: string): boolean {
    return selector.split(',').some((s) => matchSimple(this, s.trim()));
  }

  closest(selector: string): StubElement | null {
    let n: StubElement | null = this;
    while (n) {
      if (n.matches(selector)) return n;
      n = n.parentNode;
    }
    return null;
  }

  /* ------------------------------ 事件 ------------------------------ */

  addEventListener(type: string, fn: Listener): void {
    const arr = this._listeners.get(type) ?? [];
    if (!arr.includes(fn)) arr.push(fn);
    this._listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: Listener): void {
    const arr = this._listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  /** 供测试触发事件；返回是否被 preventDefault 拦截 */
  dispatchEvent(ev: StubEvent | string): boolean {
    const e: StubEvent = typeof ev === 'string' ? { type: ev } : ev;
    e.target ??= this;
    let prevented = false;
    e.preventDefault ??= (): void => {
      prevented = true;
    };
    e.stopPropagation ??= (): void => undefined;
    for (const fn of this._listeners.get(e.type) ?? []) fn(e);
    return !prevented;
  }

  /* ------------------------------ 几何/杂项 ------------------------------ */

  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number } {
    return {
      left: this.offsetLeft,
      top: this.offsetTop,
      width: this.offsetWidth,
      height: this.offsetHeight,
      right: this.offsetLeft + this.offsetWidth,
      bottom: this.offsetTop + this.offsetHeight,
    };
  }

  focus(): void {}
  blur(): void {}
  click(): void {
    this.dispatchEvent({ type: 'click' });
  }

  get firstElementChild(): StubElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): StubElement | null {
    const c = this.children;
    return c[c.length - 1] ?? null;
  }

  /** 便于失败时打印，而不是看到 [object Object] */
  toString(): string {
    const cls = this._attrs.get('class');
    return `<${this.localName}${this.id ? ` id="${this.id}"` : ''}${cls ? ` class="${cls}"` : ''}>`;
  }
}

/* ==================================================================== */
/* 选择器匹配                                                            */
/* ==================================================================== */

function collect(root: StubElement, selectors: string[], out: StubElement[]): void {
  for (const child of root.childNodes) {
    if (!(child instanceof StubElement)) continue;
    if (selectors.some((s) => matchSimple(child, s))) out.push(child);
    collect(child, selectors, out);
  }
}

function matchSimple(el: StubElement, sel: string): boolean {
  if (!sel || sel === '*') return true;
  const attr = /^\[([\w-]+)(?:(\^?=)"?([^"\]]*)"?)?\]$/.exec(sel);
  if (attr) {
    const [, name, op, val] = attr;
    if (!el._attrs.has(name)) return false;
    if (!op) return true;
    const cur = el._attrs.get(name) ?? '';
    return op === '^=' ? cur.startsWith(val) : cur === val;
  }
  const dot = sel.indexOf('.');
  const tag = dot >= 0 ? sel.slice(0, dot) : sel;
  const cls = dot >= 0 ? sel.slice(dot + 1) : '';
  if (tag && tag !== '*' && el.localName !== tag.toLowerCase()) return false;
  if (cls) {
    const tokens = (el._attrs.get('class') ?? '').split(/\s+/);
    if (!tokens.includes(cls)) return false;
  }
  return true;
}

/* ==================================================================== */
/* document / window / 全局安装                                          */
/* ==================================================================== */

class StubDocument {
  readonly documentElement: StubElement;
  readonly head: StubElement;
  readonly body: StubElement;
  visibilityState = 'visible';
  title = '';
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    this.documentElement = new StubElement('html');
    this.head = new StubElement('head');
    this.body = new StubElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    (this.documentElement as unknown as { _doc: unknown })._doc = this;
  }

  createElement(tag: string): StubElement {
    return new StubElement(tag);
  }

  createElementNS(_ns: string, tag: string): StubElement {
    return new StubElement(tag);
  }

  createTextNode(text: string): StubText {
    return new StubText(text);
  }

  getElementById(id: string): StubElement | null {
    return this.documentElement.querySelectorAll(`[id="${id}"]`)[0] ?? null;
  }

  querySelector(sel: string): StubElement | null {
    return this.documentElement.querySelector(sel);
  }

  querySelectorAll(sel: string): StubElement[] {
    return this.documentElement.querySelectorAll(sel);
  }

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  dispatchEvent(ev: StubEvent | string): boolean {
    const e: StubEvent = typeof ev === 'string' ? { type: ev } : ev;
    e.preventDefault ??= (): void => undefined;
    for (const fn of this.listeners.get(e.type) ?? []) fn(e);
    return true;
  }
}

class StubWindow {
  readonly document: StubDocument;
  readonly listeners = new Map<string, Listener[]>();
  innerWidth = 1280;
  innerHeight = 800;
  devicePixelRatio = 1;

  constructor(doc: StubDocument) {
    this.document = doc;
  }

  /** 同步执行：测试里不需要真的等一帧，但行为与 rAF 一致 */
  requestAnimationFrame(fn: (t: number) => void): number {
    fn(0);
    return 0;
  }

  cancelAnimationFrame(): void {}
  matchMedia(query: string): { matches: boolean; media: string; addEventListener: () => void; removeEventListener: () => void } {
    return { matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined };
  }
  getComputedStyle(el: StubElement): Record<string, string> {
    return el.style;
  }
  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(ev: StubEvent | string): boolean {
    const e: StubEvent = typeof ev === 'string' ? { type: ev } : ev;
    e.preventDefault ??= (): void => undefined;
    for (const fn of this.listeners.get(e.type) ?? []) fn(e);
    return true;
  }
}

/**
 * IntersectionObserver 桩。
 * slides.ts / pdf.ts 用它做「只渲染可见页」；测试里需要能**手动驱动**回调，
 * 否则无法断言「离开视口的页节点被回收了」。所以把回调实例收集起来，
 * 由测试调用 trigger() 模拟浏览器通知。
 */
export class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];
  readonly callback: (entries: unknown[], observer: unknown) => void;
  readonly observed = new Set<StubElement>();
  readonly root: unknown;
  readonly rootMargin: string;
  readonly thresholds: number[];

  constructor(callback: (entries: unknown[], observer: unknown) => void, options?: { root?: unknown; rootMargin?: string; threshold?: number | number[] }) {
    this.callback = callback;
    this.root = options?.root;
    this.rootMargin = options?.rootMargin ?? '0px';
    const t = options?.threshold ?? 0;
    this.thresholds = Array.isArray(t) ? t : [t];
    StubIntersectionObserver.instances.push(this);
  }

  observe(el: StubElement): void {
    this.observed.add(el);
  }

  unobserve(el: StubElement): void {
    this.observed.delete(el);
  }

  disconnect(): void {
    this.observed.clear();
  }

  takeRecords(): unknown[] {
    return [];
  }

  /** 测试用：把指定元素标记为可见/不可见并触发回调 */
  trigger(entries: Array<{ target: StubElement; isIntersecting: boolean }>): void {
    this.callback(
      entries.map((e) => ({ target: e.target, isIntersecting: e.isIntersecting, intersectionRatio: e.isIntersecting ? 1 : 0 })),
      this,
    );
  }

  /** 便捷：让所有被观察元素都可见 */
  triggerAll(isIntersecting = true): void {
    this.trigger([...this.observed].map((target) => ({ target, isIntersecting })));
  }

  static reset(): void {
    StubIntersectionObserver.instances = [];
  }

  static latest(): StubIntersectionObserver | undefined {
    return StubIntersectionObserver.instances[StubIntersectionObserver.instances.length - 1];
  }
}

export interface DomStub {
  document: StubDocument;
  window: StubWindow;
  /** 卸载桩，恢复原先的全局（避免污染同一进程里的其他测试文件） */
  restore(): void;
  /** 便捷：造一个挂在 body 下的容器 */
  container(width?: number, height?: number): StubElement;
  /** 真实节点数（等价于 element.querySelectorAll('*').length） */
  countNodes(root: StubElement): number;
}

/**
 * 安装全局 document/window/IntersectionObserver，返回恢复句柄。
 * 调用方（测试文件）应当在**导入渲染器之前**安装：渲染器虽然不在模块顶层
 * 缓存 document（便于测试替换），但先装桩可以避免任何顶层副作用踩空。
 */
export function installDomStub(): DomStub {
  const doc = new StubDocument();
  const win = new StubWindow(doc);
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    document: g.document,
    window: g.window,
    IntersectionObserver: g.IntersectionObserver,
    HTMLElement: g.HTMLElement,
    Node: g.Node,
  };
  g.document = doc;
  g.window = win;
  g.IntersectionObserver = StubIntersectionObserver;
  g.HTMLElement = StubElement;
  g.Node = StubNode;
  doc.body.clientWidth = 1280;
  doc.body.clientHeight = 800;

  return {
    document: doc,
    window: win,
    restore(): void {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
    container(width = 1024, height = 720): StubElement {
      const el = doc.createElement('div');
      el.clientWidth = width;
      el.clientHeight = height;
      doc.body.appendChild(el);
      return el;
    },
    countNodes(root: StubElement): number {
      return root.querySelectorAll('*').length;
    },
  };
}

/**
 * 视口合成辅助：桩没有布局引擎，clientHeight 恒为 0。
 * 这个函数把一个渲染器的滚动容器标成「有视口尺寸」并触发一次滚动回调，
 * 让**真正按视口虚拟化**的那条路径（而不是「视口为 0」的兜底路径）被测试覆盖。
 *
 * @returns 被合成尺寸的滚动容器（找不到返回 null）
 */
export function synthesizeViewport(viewerRoot: StubElement, width = 1024, height = 720, scrollTop = 0): StubElement | null {
  const scroller = viewerRoot.querySelector('.lo-scroller');
  if (!scroller) return null;
  scroller.clientWidth = width;
  scroller.clientHeight = height;
  scroller.scrollTop = scrollTop;
  scroller.dispatchEvent({ type: 'scroll' });
  return scroller;
}
