/**
 * 富文本（sharedStrings 的 `<si>` 与单元格内联字符串 `<is>`）解析。
 *
 * 两处都要用同一段逻辑，因为规范允许它们内容完全一样：
 *   <si><t>纯文本</t></si>
 *   <si><r><rPr><b/><sz val="14"/></rPr><t>粗</t></r><r><t>细</t></r></si>
 *   <is><r><rPr>…</rPr><t>…</t></r></is>
 *
 * 踩过的坑：`<rPh>` 是日文注音（furigana），里面**也有 `<t>`**。
 * 早期实现「见到 t 就拼接」，于是「東京」被拼成「東京トウキョウ」——
 * 文本看着不像坏，但完全是错的，比抛错更难发现。这里显式跳过 rPh。
 */
import { attr, attrBool, parseOnOff } from '../../ooxml/src/xmlUtil.ts';
import type { Run, RunStyle } from '../../core/src/model.ts';
import type { XmlEvent } from '../../xml/src/index.ts';
import { StreamXmlScanner } from './xmlStream.ts';
import { colorFromAttrs } from './color.ts';

/** 读取一个纯文本容器（`<t>` / `<v>` / `<f>`）的文本内容，消费到它的结束标签。 */
export async function readTextNode(scanner: StreamXmlScanner, start: XmlEvent): Promise<string> {
  if (start.selfClosing) return '';
  let out = '';
  const name = start.local;
  for (;;) {
    const e = await scanner.next();
    if (e === null) break;
    if (e.type === 'end') {
      if (e.local === name) break;
      continue;
    }
    if (e.type === 'text') {
      out += e.text;
      continue;
    }
    // 理论不会出现嵌套元素；真出现就整棵跳过，避免死循环
    await scanner.skipElement();
  }
  return out;
}

/** 读取 `<rPr>`（富文本片段属性）。sz 在 xlsx 里**已经是 pt**，不要再除以 2。 */
export async function readRunProps(scanner: StreamXmlScanner, start: XmlEvent): Promise<RunStyle> {
  const style: RunStyle = {};
  if (start.selfClosing) return style;
  for (;;) {
    const e = await scanner.next();
    if (e === null) break;
    if (e.type === 'end') {
      if (e.local === 'rPr') break;
      continue;
    }
    if (e.type === 'text') continue;
    switch (e.local) {
      case 'b':
        if (attrBool(e, 'val', true)) style.bold = true;
        break;
      case 'i':
        if (attrBool(e, 'val', true)) style.italic = true;
        break;
      case 'u': {
        // <u val="none"/> 表示取消下划线；<u/> 或 val="single"/"double" 表示有
        const v = attr(e, 'val');
        style.underline = v === undefined ? true : parseOnOff(v) && v.toLowerCase() !== 'none';
        break;
      }
      case 'strike':
        if (attrBool(e, 'val', true)) style.strike = true;
        break;
      case 'sz': {
        const v = Number.parseFloat(attr(e, 'val') ?? '');
        if (Number.isFinite(v) && v > 0) style.size = v;
        break;
      }
      case 'color': {
        const c = colorFromAttrs(e);
        if (c) style.color = c;
        break;
      }
      case 'rFont':
      case 'name': {
        const v = attr(e, 'val');
        if (v) style.font = v;
        break;
      }
      case 'vertAlign': {
        const v = attr(e, 'val');
        if (v === 'superscript' || v === 'subscript') style.vertAlign = v;
        break;
      }
      default:
        if (!e.selfClosing) await scanner.skipElement();
    }
  }
  return style;
}

function styleIsEmpty(s: RunStyle): boolean {
  for (const k of Object.keys(s)) if ((s as Record<string, unknown>)[k] !== undefined) return false;
  return true;
}

/** 读取一个 `<r>` 富文本片段（消费到 `</r>`）。 */
async function readRun(scanner: StreamXmlScanner, start: XmlEvent): Promise<Run> {
  const run: Run = { text: '' };
  if (start.selfClosing) return run;
  for (;;) {
    const e = await scanner.next();
    if (e === null) break;
    if (e.type === 'end') {
      if (e.local === 'r') break;
      continue;
    }
    if (e.type === 'text') continue;
    switch (e.local) {
      case 't':
        run.text += await readTextNode(scanner, e);
        break;
      case 'rPr': {
        const st = await readRunProps(scanner, e);
        if (!styleIsEmpty(st)) run.style = st;
        break;
      }
      default:
        if (!e.selfClosing) await scanner.skipElement();
    }
  }
  return run;
}

export interface RichTextResult {
  /** 纯文本拼接结果（所有 `<t>` 顺序拼接，跳过注音） */
  text: string;
  /** 仅当确实有格式信息时才有值 —— 非富文本时为 null，省内存 */
  runs: Run[] | null;
}

/**
 * 读取 `<si>` / `<is>` 的内容（假定 start 事件已被消费）。
 * 注意：`runs` 只在「有多个片段」或「单个片段带格式」时给出，
 * 纯文本 `<si><t>x</t></si>` 不会为每个字符串多分配一个数组 + Run 对象。
 */
export async function readRichText(scanner: StreamXmlScanner, start: XmlEvent): Promise<RichTextResult> {
  let text = '';
  const runs: Run[] = [];
  if (start.selfClosing) return { text: '', runs: null };

  const name = start.local;
  for (;;) {
    const e = await scanner.next();
    if (e === null) break;
    if (e.type === 'end') {
      if (e.local === name) break;
      continue;
    }
    if (e.type === 'text') continue;
    switch (e.local) {
      case 't':
        text += await readTextNode(scanner, e);
        break;
      case 'r': {
        const run = await readRun(scanner, e);
        runs.push(run);
        text += run.text;
        break;
      }
      default:
        // rPh（注音）/ phoneticPr / rPr 一类：跳过整棵子树
        if (!e.selfClosing) await scanner.skipElement();
    }
  }

  const hasFormatting = runs.some((r) => r.style !== undefined) || runs.length > 1;
  return { text, runs: hasFormatting ? runs : null };
}
