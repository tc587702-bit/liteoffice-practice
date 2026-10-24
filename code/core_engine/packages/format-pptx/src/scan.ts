/**
 * 树遍历与子树延后重放。
 *
 * ## 一个必须记住的解析器语义（本读取器最大的坑）
 *
 * `XmlPullParser.skipElement()` 在跳过完成时会让**紧接着的 `next()` 返回 null**
 * （它的实现是 `while (this.next() !== null) { if (this.skipDepth === 0) return; }`）。
 * 因此在「自己 while(next()) { ... skipElement() ... }」的循环体里调它，
 * 循环会立刻结束。后果分两种：
 *
 *   - 对**子元素**调用：本次循环结束，但外层还会再调 next() —— 看起来正常，
 *     实际上已经悄悄丢掉了当前层级剩余的兄弟节点。
 *   - 对**根元素**调用：整次遍历直接终止。
 *     早期版本正是在 default 分支里对 `p:presentation` / `p:cSld` / `p:sldMaster`
 *     无差别 skipElement()，于是真实 pptx 全部解析成空页 ——
 *     而夹具里 `p:spTree` 直接挂在根下、`p:sldIdLst` 也恰好在根下，
 *     所以单元夹具完全测不出来，直到跑真实文件才暴露。
 *
 * 结论：**跳过必须由 walker 负责，而且要按「层级」跳，不能用裸的
 * `skipElement()`。** 本文件提供 `walkXml` / `eachChild` / `defer` 三件套，
 * 业务代码只表达「我要不要往下走」，永远不自己调 skipElement。
 */
import { XmlPullParser } from '../../xml/src/index.ts';
import type { XmlEvent } from '../../xml/src/index.ts';

/** 可重放的解析器工厂：每次调用返回一个停在根元素 start 上的新解析器。 */
export type ParserFactory = () => XmlPullParser;

/**
 * 按**层级**跳过一个元素的子树（含自身结束标签）。
 *
 * 与 `parser.skipElement()` 的区别：后者会让下一个 `next()` 返回 null，
 * 从而终止调用方的循环；本函数靠自维护的深度计数，只吃自己这一棵子树，
 * 返回后调用方可以继续读兄弟节点。
 *
 * 用法：调用方刚拿到某个 start 事件，且它**不是**当前层级的边界元素时调用。
 */
export function skipDeep(parser: XmlPullParser, e: XmlEvent): void {
  if (e.selfClosing) return;
  let depth = 0;
  let cur: XmlEvent | null;
  while ((cur = parser.next()) !== null) {
    if (cur.type === 'start') {
      if (!cur.selfClosing) depth++;
      continue;
    }
    if (cur.type !== 'end') continue;
    if (depth === 0) return;
    depth--;
  }
}

/**
 * 遍历一个部件（从根开始）或某个元素的子树，把每个 start 事件交给 visit。
 *
 * visit 返回 **true = 继续往里走**（walker 不碰这棵子树），
 *     返回 **false = 本次不处理**（walker 用 `skipDeep` 按层级跳过它）。
 *
 * 于是**根元素必须返回 true** —— 因为「跳过根元素」等于放弃整份文档。
 * 各调用点因此都把根 local 名列进「放行」清单。
 */
export function walkXml(xml: string, visit: (e: XmlEvent, p: XmlPullParser) => boolean): void {
  const p = new XmlPullParser(xml);
  let e: XmlEvent | null;
  while ((e = p.next()) !== null) {
    if (e.type !== 'start') continue;
    if (!visit(e, p)) skipDeep(p, e);
  }
}

/**
 * 遍历 `e` 的直接子元素（`e` 的 start 事件刚被产出，且非自闭合）。
 *
 * visit 返回 true = 继续深入该子元素；false = 由本函数按层级跳过它。
 * visit 若返回 true，**必须把该子元素的子树消费完**（否则解析器位置错乱）。
 */
export function eachChild(
  p: XmlPullParser,
  e: XmlEvent,
  visit: (child: XmlEvent, p: XmlPullParser) => boolean,
): void {
  if (e.selfClosing) return;
  let cur: XmlEvent | null;
  while ((cur = p.next()) !== null) {
    if (cur.type === 'end') return;
    if (cur.type !== 'start') continue;
    if (!visit(cur, p)) skipDeep(p, cur);
  }
}

/** 取元素下所有文本节点的拼接。消费整棵子树。 */
export function textOf(p: XmlPullParser, e: XmlEvent): string {
  if (e.selfClosing) return '';
  let out = '';
  let cur: XmlEvent | null;
  while ((cur = p.next()) !== null) {
    if (cur.type === 'end') break;
    if (cur.type === 'text' || cur.type === 'cdata') out += cur.text;
    else if (cur.type === 'start' && !cur.selfClosing) skipDeep(p, cur);
  }
  return out;
}

/**
 * 取元素下**所有层级**的文本拼接。消费整棵子树。
 *
 * 与 `textOf` 的区别：`textOf` 只取直接文本（遇到子元素整棵跳过），
 * 适合 `<a:t>文本</a:t>`；本函数把嵌套结构的文本也拼起来，适合
 * `docProps/app.xml` 的 `<TitlesOfParts><vt:vector><vt:lpstr>…` 这类容器 ——
 * 用 `textOf` 去读它只会得到空串（内容全在子元素里）。
 */
export function textDeep(p: XmlPullParser, e: XmlEvent): string {
  if (e.selfClosing) return '';
  let out = '';
  let cur: XmlEvent | null;
  while ((cur = p.next()) !== null) {
    if (cur.type === 'end') break;
    if (cur.type === 'text' || cur.type === 'cdata') out += cur.text;
    else if (cur.type === 'start' && !cur.selfClosing) out += textDeepFrom(p);
  }
  return out;
}

/** `textDeep` 的续读版本：解析器已进入该子元素内部。 */
function textDeepFrom(p: XmlPullParser): string {
  let out = '';
  let depth = 0;
  let cur: XmlEvent | null;
  while ((cur = p.next()) !== null) {
    if (cur.type === 'start') {
      if (!cur.selfClosing) depth++;
      continue;
    }
    if (cur.type === 'text' || cur.type === 'cdata') {
      out += cur.text;
      continue;
    }
    if (cur.type !== 'end') continue;
    if (depth === 0) return out;
    depth--;
  }
  return out;
}

/**
 * 把一棵已经读过 start 事件的子树**重新序列化成 XML 文本**，并消费原子树。
 *
 * 为什么需要它：`mc:AlternateContent` 要求只取 `mc:Fallback` 的内容，
 * 而 `mc:Fallback` 里装的是一批**与父级同构的形状元素**（`p:sp` / `p:pic` / …）。
 * 用一个新解析器解析这段片段是最干净的做法，否则就要让形状解析器支持
 * 「在 Fallback 的局部空间里当兄弟节点」，复杂度反而更高。
 * 片段本身只有几个形状，序列化的开销可以忽略。
 */
export function captureXml(p: XmlPullParser, e: XmlEvent): string {
  if (e.selfClosing) return `<${e.name}/>`;
  let out = `<${e.name}${attrsToText(e)}>`;
  let depth = 0;
  let cur: XmlEvent | null;
  while ((cur = p.next()) !== null) {
    if (cur.type === 'end') {
      out += `</${cur.name}>`;
      if (depth === 0) return out;
      depth--;
      continue;
    }
    if (cur.type === 'start') {
      if (cur.selfClosing) out += `<${cur.name}${attrsToText(cur)}/>`;
      else {
        depth++;
        out += `<${cur.name}${attrsToText(cur)}>`;
      }
      continue;
    }
    if (cur.type === 'text') out += escapeXmlText(cur.text);
    else if (cur.type === 'cdata') out += `<![CDATA[${cur.text}]]>`;
  }
  return out;
}

/**
 * 把一棵子树「消费掉」并留下可重新解析的 XML。
 *
 * 为什么需要这种「先消费、再重放」的模式：
 *   形状解析天然分两段 —— 先从 `p:spPr`/`p:nvSpPr` 收集几何与占位符类型，
 *   再从 layout/master 解析出继承样式，最后才解析 `p:txBody`（文字要继承字号）。
 *   而 `p:txBody` 在文档里排在几何之后，持有它的 `XmlEvent` 引用等到后面再解析
 *   是**错的**：那时事件流已经走过去了，表现为文字全丢或串到别的形状上。
 *   统一改为「立刻 capture 成字符串 + 重放」，位置信息就变成显式参数了。
 */
export function defer(p: XmlPullParser, e: XmlEvent): ParserFactory {
  if (e.selfClosing) {
    const name = e.name;
    const attrs = attrsToText(e);
    return () => new XmlPullParser(`<${name}${attrs}/>`);
  }
  const xml = captureXml(p, e);
  return () => new XmlPullParser(xml);
}

function attrsToText(e: XmlEvent): string {
  if (!e.attrs) return '';
  let out = '';
  for (const k of Object.keys(e.attrs)) out += ` ${k}="${escapeXmlAttr(e.attrs[k])}"`;
  return out;
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;');
}
