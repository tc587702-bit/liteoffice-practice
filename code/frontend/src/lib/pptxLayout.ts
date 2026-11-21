/**
 * PPTX 版式解析：把每页解析成「背景 + 形状」的结构，尽量还原 PowerPoint 的样子。
 *
 * 为什么需要这一层：
 *   只抽文字（getTextByTag a:t）会得到"纯文本长文"，而真实课件的观感来自
 *   ① 版式/母版里的装饰形状与背景图（本文件 120 页几乎都靠版式背景）
 *   ② 每个文本框自己的位置、字号、颜色、对齐
 *   ③ 表格与图片
 *   这些都写在 XML 的 a:xfrm / a:rPr / p:bg 里，必须按坐标画出来。
 *
 * 坐标系：统一换算成相对页面的百分比，渲染端按卡片宽度缩放即可。
 */
import { entryBytes, entryText, listByPrefix, unzip, type ZipArchive } from './zip'

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface PptRun {
  text: string
  sizePt?: number
  color?: string
  bold?: boolean
  italic?: boolean
  /** 字体族（已把 +mn-ea 这类主题引用换成真实字体名） */
  fontFamily?: string
}

export interface PptPara {
  runs: PptRun[]
  align?: 'ctr' | 'r' | 'l' | 'just'
  level?: number
  bullet?: boolean
}

export interface PptShapeBox {
  kind: 'text' | 'image' | 'table' | 'missing'
  left: number
  top: number
  width: number
  height: number
  /** 文本 */
  paras?: PptPara[]
  /** 图片 dataURL */
  src?: string
  /** 表格 */
  rows?: string[][]
  /** missing 类型的说明文字（如 wmf/emf 无法显示） */
  label?: string
}

export interface PptRichSlide {
  index: number
  /** 背景色（CSS 颜色） */
  background?: string
  /** 背景图 dataURL */
  backgroundImage?: string
  shapes: PptShapeBox[]
  /** 纯文本（供检查/检索用） */
  text: string
}

interface Size {
  cx: number
  cy: number
}

const EMU_DEFAULT: Size = { cx: 9144000, cy: 6858000 }

function num(v: string | null | undefined): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/* ---------------- 主题字体（+mj-lt / +mn-ea 等占位符） ---------------- */

/** 主题字体四大槽位 */
interface ThemeFonts {
  majorLatin: string
  majorEa: string
  minorLatin: string
  minorEa: string
}

/**
 * 解析 theme 里的字体定义。
 *
 * PPTX 正文里的 typeface 常写成 +mn-ea / +mj-lt 这类**占位符**，
 * 真实字体名在这里才给出。不解析的话，中文会全部回退到浏览器默认字体，
 * 观感和原稿差很远，也是「部分文字显示异常」的来源之一。
 */
function readThemeFonts(archive: ZipArchive): ThemeFonts {
  const out: ThemeFonts = { majorLatin: '', majorEa: '', minorLatin: '', minorEa: '' }
  const themePath = listByPrefix(archive, 'ppt/theme/').find((n) => /theme1?\.xml$/i.test(n))
  if (!themePath) return out
  const xml = entryText(archive, themePath) ?? ''
  const pick = (block: string, tag: string) =>
    new RegExp(`<a:${block}>[\\s\\S]*?<a:${tag}[^>]*typeface="([^"]*)"`).exec(xml)?.[1] ?? ''
  out.majorLatin = pick('majorFont', 'latin')
  out.majorEa = pick('majorFont', 'ea')
  out.minorLatin = pick('minorFont', 'latin')
  out.minorEa = pick('minorFont', 'ea')
  return out
}

/** 把 +mj-lt / +mn-ea 这类占位符换成真实字体名 */
function resolveThemeFace(face: string | null | undefined, theme: ThemeFonts): string | undefined {
  const f = (face ?? '').trim()
  if (!f) return undefined
  switch (f) {
    case '+mj-lt':
      return theme.majorLatin || undefined
    case '+mj-ea':
      return theme.majorEa || undefined
    case '+mn-lt':
      return theme.minorLatin || undefined
    case '+mn-ea':
      return theme.minorEa || undefined
    default:
      // +mj-cs / +mn-cs 等其余占位符没有对应真实名，交给浏览器回退
      return f.startsWith('+') ? undefined : f
  }
}

/* ---------------- 符号字体（Wingdings 私有区 → Unicode） ---------------- */

/**
 * Wingdings 等符号字体的私有区编码在浏览器里没有对应字形，直接输出就是方块/乱码。
 *
 * 实测「1章 命题逻辑.pptx」6097 段文本中有 424 段是 U+F09F（Wingdings 的 ✓）。
 * 这些字符在 XML 里带 <a:latin typeface="Wingdings"/>，据此识别后替换成等效 Unicode。
 *
 * 只收录高频、语义明确的映射；认不出的保持原样（宁可显示原字符也不乱猜）。
 */
/**
 * 私有区码点 → Unicode 符号。
 *
 * 实测「1章 命题逻辑.pptx」的 447 个私有区字符里，Top 7 全部是
 * **Symbol 字体**编码（虽然 rPr 声明 Times New Roman/Tahoma，但码点落在
 * U+F0DB、U+F0DE、U+F0D8 这些 Symbol 私用区位置）。按出现频次排序补全：
 *   U+F0DB ×183  U+F0DE ×67  U+F0D8 ×57  U+F0AB ×44
 *   U+F0D9 ×43   U+F0DA ×29  U+F0AE ×17
 * 其余为 Wingdings（U+F09F 等）。
 *
 * 只收高频且语义明确的；认不出的保持原样，不乱猜。
 */
const SYMBOL_MAP: Record<string, string> = {
  // —— Symbol 字体私用区（实测最高频）——
  '\uF0DB': '⇒', // 双箭头右
  '\uF0DE': '⇑', // 双箭头上
  '\uF0D8': '⇓', // 双箭头下
  '\uF0D9': '⇐', // 双箭头左
  '\uF0DA': '→', // 单箭头右
  '\uF0AB': '↔', // 双向箭头
  '\uF0AE': '→', // 箭头
  '\uF0AC': '←',
  '\uF0AD': '↑',
  '\uF0AF': '↓',
  '\uF0A3': '≤',
  '\uF0B3': '≥',
  '\uF0B9': '≠',
  '\uF0BB': '≈',
  '\uF0B1': '±',
  '\uF0B4': '×',
  '\uF0B8': '÷',
  '\uF0A5': '∞',
  '\uF0D6': '√', // 根号（数学课件高频）
  '\uF0E5': '∑',
  '\uF0F2': '∫',
  '\uF0B0': '°',
  '\uF0B6': '∂',
  '\uF0C4': '⊗',
  '\uF0C5': '⊕',
  '\uF0CE': '∈',
  '\uF0CF': '∉',
  '\uF0C8': '∪',
  '\uF0C7': '∩',
  '\uF0CC': '⊂',
  '\uF0C9': '⊃',
  '\uF0D1': '∇',
  '\uF0B2': '∝',
  '\uF0A2': '′',
  // —— Wingdings ——
  '\uF0FC': '✓',
  '\uF0FB': '✗',
  '\uF0A1': '○',
  '\uF06C': '●',
  '\uF075': '◆',
  '\uF0A7': '■',
  '\uF0E0': '→',
  '\uF0E8': '↑',
  '\uF0EA': '↓',
  '\uF0E9': '←',
  '\uF0B7': '•',
  '\uF09F': '•', // 实测「黑体」下的项目符
}

const SYMBOL_FONTS = /^(wingdings|wingdings\s*[23]|webdings|symbol|marlett|monotype\s*sorts)$/i

function mapSymbolText(text: string, face: string | undefined): string {
  if (!text) return text
  const isSymbolFont = face ? SYMBOL_FONTS.test(face.trim()) : false
  // 私有区字符在任何普通字体下都没有字形，必须映射，否则显示为方块
  const hasPrivate = /[\uE000-\uF8FF]/.test(text)
  if (!isSymbolFont && !hasPrivate) return text
  return [...text].map((ch) => SYMBOL_MAP[ch] ?? ch).join('')
}

function relsPathFor(part: string): string {
  const dir = part.slice(0, part.lastIndexOf('/'))
  const file = part.slice(part.lastIndexOf('/') + 1)
  return `${dir}/_rels/${file}.rels`
}

function readRels(archive: ZipArchive, part: string): Map<string, string> {
  const xml = entryText(archive, relsPathFor(part))
  const map = new Map<string, string>()
  if (!xml) return map
  const re = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) map.set(m[1], m[2])
  return map
}

function resolveTarget(part: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const dir = part.slice(0, part.lastIndexOf('/'))
  const parts = (dir + '/' + target).split('/')
  const stack: string[] = []
  for (const seg of parts) {
    if (!seg || seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}

const imageCache = new Map<string, string>()

function imageDataUrl(archive: ZipArchive, path: string): string | undefined {
  const cached = imageCache.get(path)
  if (cached) return cached
  const bytes = entryBytes(archive, path)
  if (!bytes || !bytes.length) return undefined
  const ext = (path.split('.').pop() ?? 'png').toLowerCase()
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'gif'
        ? 'image/gif'
        : ext === 'svg'
          ? 'image/svg+xml'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/png'
  // wmf/emf 浏览器不认，直接跳过（不内联，避免 28MB base64）
  if (mime === 'image/png' && ext !== 'png' && ext !== 'bmp') return undefined
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[])
  }
  const url = `data:${mime};base64,${btoa(binary)}`
  imageCache.set(path, url)
  return url
}

/** 从 XML 里取形状的坐标；没有 xfrm 时返回 null（占位符需要继承版式） */

/** 取形状里的图片：优先 a:blip 的 r:embed；返回 dataURL 或 null（wmf/emf） */
function shapeImageSrc(
  archive: ZipArchive,
  part: string,
  rels: Map<string, string>,
  el: Element,
): { src?: string; missing?: string } {
  const blip = el.getElementsByTagName('a:blip')[0]
  if (!blip) return {}
  const rid = blip.getAttributeNS(R_NS, 'embed') ?? blip.getAttribute('r:embed')
  if (!rid) {
    const link = blip.getAttributeNS(R_NS, 'link') ?? blip.getAttribute('r:link')
    if (link) return { missing: '外链图片（未随文件打包）' }
    return {}
  }
  const target = rels.get(rid)
  if (!target) return { missing: '图片关系缺失' }
  const path = resolveTarget(part, target)
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (ext === 'wmf' || ext === 'emf') {
    return { missing: `${ext.toUpperCase()} 矢量图（浏览器无法直接显示）` }
  }
  const src = imageDataUrl(archive, path)
  return src ? { src } : { missing: '图片数据无法读取' }
}

function readXfrm(el: Element | null): { x: number; y: number; cx: number; cy: number } | null {
  if (!el) return null
  const xfrm = el.getElementsByTagName('a:xfrm')[0] ?? el.getElementsByTagName('xfrm')[0]
  if (!xfrm) return null
  const off = xfrm.getElementsByTagName('a:off')[0] ?? xfrm.getElementsByTagName('off')[0]
  const ext = xfrm.getElementsByTagName('a:ext')[0] ?? xfrm.getElementsByTagName('ext')[0]
  if (!off || !ext) return null
  return { x: num(off.getAttribute('x')), y: num(off.getAttribute('y')), cx: num(ext.getAttribute('cx')), cy: num(ext.getAttribute('cy')) }
}

function textOf(el: Element): string {
  const out: string[] = []
  Array.from(el.getElementsByTagName('a:t')).forEach((t) => out.push(t.textContent ?? ''))
  return out.join('')
}

/**
 * 段落样式来源（母版/版式继承）。
 *
 * 为什么要它：实测「1章 命题逻辑.pptx」6096 个 run 里 **3563 个（58%）没有显式 sz**，
 * 真实字号继承自母版的 titleStyle/bodyStyle（实测分别是 40pt / 24pt）。
 * 之前一律退回硬编码 18pt，标题变小、正文变大，文字溢出文本框被裁掉 ——
 * 用户看到的就是「文字加载不出来」。
 */
export interface PptStyleSource {
  theme: ThemeFonts
  /** lvl1..lvl9 → 默认字号（pt） */
  titleSizes?: Map<number, number>
  bodySizes?: Map<number, number>
}

const DEFAULT_TITLE_PT = 40
const DEFAULT_BODY_PT = 24

/** 从母版/版式 XML 提取 titleStyle 与 bodyStyle 的各级默认字号 */
function readTxStyleSizes(xml: string): { title: Map<number, number>; body: Map<number, number> } {
  const title = new Map<number, number>()
  const body = new Map<number, number>()
  if (!xml) return { title, body }
  const grab = (blockName: string, target: Map<number, number>) => {
    const start = xml.indexOf(`<p:${blockName}>`)
    if (start < 0) return
    const end = xml.indexOf(`</p:${blockName}>`, start)
    const block = xml.slice(start, end > start ? end : undefined)
    // 逐级取 lvl{N}pPr 内的 defRPr/@sz（单位是 1/100 pt）
    for (const m of block.matchAll(/<a:lvl(\d)pPr[\s\S]*?<a:defRPr[^>]*\bsz="(\d+)"/g)) {
      const lvl = Number(m[1])
      const pt = Number(m[2]) / 100
      if (lvl >= 1 && pt > 0) target.set(lvl, pt)
    }
  }
  grab('titleStyle', title)
  grab('bodyStyle', body)
  return { title, body }
}

function parseParas(
  spEl: Element,
  source?: PptStyleSource,
  /** 该形状是否为标题占位符（决定继承 titleStyle 还是 bodyStyle） */
  isTitle = false,
): { paras: PptPara[]; text: string } {
  const paras: PptPara[] = []
  const texts: string[] = []
  Array.from(spEl.getElementsByTagName('a:p')).forEach((p) => {
    const runs: PptRun[] = []
    const pPr = p.getElementsByTagName('a:pPr')[0] ?? p.getElementsByTagName('pPr')[0]
    const paraLevel = Math.max(1, num(pPr?.getAttribute('lvl')) + 1)
    // 段落级 lstStyle 优先于母版样式
    const lstSz = num(
      pPr?.getElementsByTagName('a:defRPr')[0]?.getAttribute('sz') ??
        p.getElementsByTagName('a:lstStyle')[0]?.getElementsByTagName('a:defRPr')[0]?.getAttribute('sz'),
    )
    const inheritPt =
      (lstSz > 0 ? lstSz / 100 : 0) ||
      (isTitle
        ? (source?.titleSizes?.get(paraLevel) ?? DEFAULT_TITLE_PT)
        : (source?.bodySizes?.get(paraLevel) ?? DEFAULT_BODY_PT))

    Array.from(p.getElementsByTagName('a:r')).forEach((r) => {
      const t = r.getElementsByTagName('a:t')[0]?.textContent ?? ''
      if (!t) return
      const rPr = r.getElementsByTagName('a:rPr')[0] ?? r.getElementsByTagName('rPr')[0]
      const shape = r.getElementsByTagName('a:solidFill')[0]
      const color = shape?.getElementsByTagName('a:srgbClr')[0]?.getAttribute('val') ?? undefined
      const face =
        rPr?.getElementsByTagName('a:ea')[0]?.getAttribute('typeface') ??
        rPr?.getElementsByTagName('a:latin')[0]?.getAttribute('typeface') ??
        undefined
      const symbolFace = rPr?.getElementsByTagName('a:latin')[0]?.getAttribute('typeface') ?? face
      runs.push({
        // 符号字体（Wingdings 等）的私有区编码换成语义等效的 Unicode
        text: mapSymbolText(t, symbolFace ?? undefined),
        // 显式 sz 优先；没有就用继承值，而不是硬编码 18pt
        sizePt: rPr?.getAttribute('sz') ? num(rPr.getAttribute('sz')) / 100 : inheritPt,
        bold: rPr?.getAttribute('b') === '1',
        italic: rPr?.getAttribute('i') === '1',
        color: color ? `#${color}` : undefined,
        fontFamily: source ? resolveThemeFace(face, source.theme) : undefined,
      })
    })
    if (!runs.length) {
      // 有些文本是 a:fld（页码/日期），也当普通文字
      const fld = p.getElementsByTagName('a:fld')[0]?.getElementsByTagName('a:t')[0]?.textContent
      if (fld) runs.push({ text: fld, sizePt: inheritPt })
    }
    if (!runs.length) return
    const align = pPr?.getAttribute('algn') as PptPara['align'] | undefined
    const hasBullet = Boolean(pPr?.getElementsByTagName('a:buChar')[0] ?? pPr?.getElementsByTagName('buChar')[0])
    paras.push({
      runs,
      align: align ?? undefined,
      level: num(pPr?.getAttribute('lvl')),
      bullet: hasBullet,
    })
    texts.push(runs.map((r) => r.text).join(''))
  })
  return { paras, text: texts.join('\n') }
}

function parseTable(tblEl: Element): string[][] {
  const rows: string[][] = []
  Array.from(tblEl.getElementsByTagName('a:tr')).forEach((tr) => {
    const cells: string[] = []
    Array.from(tr.getElementsByTagName('a:tc')).forEach((tc) => cells.push(textOf(tc).trim()))
    if (cells.length) rows.push(cells)
  })
  return rows
}

function placeholderKey(el: Element): string | null {
  const ph = el.getElementsByTagName('p:ph')[0] ?? el.getElementsByTagName('ph')[0]
  if (!ph) return null
  return `${ph.getAttribute('type') ?? 'body'}:${ph.getAttribute('idx') ?? '0'}`
}

/** 从版式/母版收集「占位符坐标」（供幻灯片里的占位符继承） */
function collectPlaceholderRects(xml: string): Map<string, { x: number; y: number; cx: number; cy: number }> {
  const map = new Map<string, { x: number; y: number; cx: number; cy: number }>()
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  Array.from(doc.getElementsByTagName('p:sp')).forEach((sp) => {
    const key = placeholderKey(sp)
    if (!key) return
    const rect = readXfrm(sp)
    if (rect) map.set(key, rect)
  })
  return map
}

/** 版式/母版里非占位符的装饰形状（背景条、页码框、logo 图等） */
function decorativeShapes(
  archive: ZipArchive,
  part: string,
  xml: string,
  size: Size,
  styleSource?: PptStyleSource,
): PptShapeBox[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const rels = readRels(archive, part)
  const out: PptShapeBox[] = []

  const pushPic = (pic: Element) => {
    const rect = readXfrm(pic)
    const blip = pic.getElementsByTagName('a:blip')[0]
    const rid = blip?.getAttributeNS(R_NS, 'embed') ?? blip?.getAttribute('r:embed')
    if (!rect || !rid) return
    const target = rels.get(rid)
    if (!target) return
    const picPath = resolveTarget(part, target)
    const picExt = (picPath.split('.').pop() ?? '').toLowerCase()
    const src = imageDataUrl(archive, picPath)
    const box = {
      left: (rect.x / size.cx) * 100,
      top: (rect.y / size.cy) * 100,
      width: (rect.cx / size.cx) * 100,
      height: (rect.cy / size.cy) * 100,
    }
    if (src) {
      out.push({ kind: 'image', ...box, src })
      return
    }
    // 原来这里直接 return，导致版式里的 wmf/emf（常是整页背景或 logo）
    // 静默消失、连提示都没有。改为给占位框，至少让用户知道缺了什么。
    out.push({ kind: 'missing', ...box, label: `${picExt.toUpperCase() || '图片'} 无法显示` })
  }

  Array.from(doc.getElementsByTagName('p:pic')).forEach(pushPic)
  Array.from(doc.getElementsByTagName('p:sp')).forEach((sp) => {
    if (placeholderKey(sp)) return
    const rect = readXfrm(sp)
    if (!rect) return
    // 标题占位符在母版里是 title 类型；装饰层这里统一按正文样式继承
    const { paras, text } = parseParas(sp, styleSource, false)
    // 装饰形状也可能内含图片（背景图常放在 sp 里）
    const blip = sp.getElementsByTagName('a:blip')[0]
    if (blip) {
      const rid = blip.getAttributeNS(R_NS, 'embed') ?? blip.getAttribute('r:embed')
      const target = rid ? rels.get(rid) : undefined
      const picPath = target ? resolveTarget(part, target) : ''
      const src = picPath ? imageDataUrl(archive, picPath) : undefined
      const box = {
        left: (rect.x / size.cx) * 100,
        top: (rect.y / size.cy) * 100,
        width: (rect.cx / size.cx) * 100,
        height: (rect.cy / size.cy) * 100,
      }
      if (src) {
        out.push({ kind: 'image', ...box, src })
        return
      }
      if (picPath) {
        const ext = (picPath.split('.').pop() ?? '').toLowerCase()
        out.push({ kind: 'missing', ...box, label: `${ext.toUpperCase() || '图片'} 无法显示` })
      }
    }
    if (text.trim()) {
      out.push({
        kind: 'text',
        left: (rect.x / size.cx) * 100,
        top: (rect.y / size.cy) * 100,
        width: (rect.cx / size.cx) * 100,
        height: (rect.cy / size.cy) * 100,
        paras,
      })
    }
  })
  return out
}

function readBackground(archive: ZipArchive, part: string, xml: string): { color?: string; image?: string } {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const bg = doc.getElementsByTagName('p:bg')[0] ?? doc.getElementsByTagName('bg')[0]
  if (!bg) return {}
  const color = bg.getElementsByTagName('a:srgbClr')[0]?.getAttribute('val')
  const blip = bg.getElementsByTagName('a:blip')[0]
  if (blip) {
    const rid = blip.getAttributeNS(R_NS, 'embed') ?? blip.getAttribute('r:embed')
    const target = rid ? readRels(archive, part).get(rid) : undefined
    const src = target ? imageDataUrl(archive, resolveTarget(part, target)) : undefined
    if (src) return { image: src }
  }
  return color ? { color: `#${color}` } : {}
}

export async function parsePptxRich(
  buffer: ArrayBuffer,
): Promise<{ slides: PptRichSlide[]; warnings: string[]; aspect: number; widthPt: number }> {
  const archive = await unzip(buffer)
  const warnings: string[] = []

  const presXml = entryText(archive, 'ppt/presentation.xml') ?? ''
  const szMatch = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presXml)
  const size: Size = szMatch ? { cx: Number(szMatch[1]), cy: Number(szMatch[2]) } : EMU_DEFAULT

  // 主题字体只解析一次，供所有页把 +mn-ea 之类的占位符换成真实字体名
  const themeFonts = readThemeFonts(archive)

  const slideParts = listByPrefix(archive, 'ppt/slides/')
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => Number(/slide(\d+)/.exec(a)?.[1] ?? 0) - Number(/slide(\d+)/.exec(b)?.[1] ?? 0))

  const slides: PptRichSlide[] = []
  const warnSeen = new Set<string>()
  const warn = (m: string) => {
    if (!warnSeen.has(m)) {
      warnSeen.add(m)
      warnings.push(m)
    }
  }

  for (const part of slideParts) {
    const xml = entryText(archive, part) ?? ''
    if (!xml) continue
    const rels = readRels(archive, part)

    // 版式与母版：装饰形状与占位符坐标
    let decor: PptShapeBox[] = []
    let phRects = new Map<string, { x: number; y: number; cx: number; cy: number }>()
    const bg: { color?: string; image?: string } = {}
    // 样式来源：字号与字体从母版/版式继承（58% 的 run 没有显式字号，靠这个补）
    const styleSource: PptStyleSource = { theme: themeFonts }
    const layoutTarget = Array.from(rels.entries()).find(([, t]) => /slideLayout\d+\.xml$/i.test(t))?.[1]
    if (layoutTarget) {
      const layoutPart = resolveTarget(part, layoutTarget)
      const layoutXml = entryText(archive, layoutPart) ?? ''
      decor = decor.concat(decorativeShapes(archive, layoutPart, layoutXml, size, styleSource))
      phRects = collectPlaceholderRects(layoutXml)
      Object.assign(bg, readBackground(archive, layoutPart, layoutXml))
      const layoutStyles = readTxStyleSizes(layoutXml)
      if (layoutStyles.title.size) styleSource.titleSizes = layoutStyles.title
      if (layoutStyles.body.size) styleSource.bodySizes = layoutStyles.body

      const layoutRels = readRels(archive, layoutPart)
      const masterTarget = Array.from(layoutRels.entries()).find(([, t]) => /slideMaster\d+\.xml$/i.test(t))?.[1]
      if (masterTarget) {
        const masterPart = resolveTarget(layoutPart, masterTarget)
        const masterXml = entryText(archive, masterPart) ?? ''
        decor = decor.concat(decorativeShapes(archive, masterPart, masterXml, size, styleSource))
        for (const [k, v] of collectPlaceholderRects(masterXml)) if (!phRects.has(k)) phRects.set(k, v)
        const masterBg = readBackground(archive, masterPart, masterXml)
        if (!bg.color && !bg.image) Object.assign(bg, masterBg)
        // 母版优先级最低：只在版式没定义时补
        const masterStyles = readTxStyleSizes(masterXml)
        if (!styleSource.titleSizes?.size && masterStyles.title.size) styleSource.titleSizes = masterStyles.title
        if (!styleSource.bodySizes?.size && masterStyles.body.size) styleSource.bodySizes = masterStyles.body
      }
    }
    Object.assign(bg, readBackground(archive, part, xml))
    const slideBg = readBackground(archive, part, xml)
    if (slideBg.color || slideBg.image) Object.assign(bg, slideBg)

    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const shapes: PptShapeBox[] = []
    const texts: string[] = []

    // 图片
    Array.from(doc.getElementsByTagName('p:pic')).forEach((pic) => {
      const rect = readXfrm(pic)
      const blip = pic.getElementsByTagName('a:blip')[0]
      const rid = blip?.getAttributeNS(R_NS, 'embed') ?? blip?.getAttribute('r:embed')
      if (!rect || !rid) return
      const target = rels.get(rid)
      if (!target) return
      const picPath = resolveTarget(part, target)
      const picExt = (picPath.split('.').pop() ?? '').toLowerCase()
      const src = picExt === 'wmf' || picExt === 'emf' ? undefined : imageDataUrl(archive, picPath)
      if (!src) {
        // 不再静默跳过：画一个带说明的占位框，用户至少知道这里有图、为什么看不到
        shapes.push({
          kind: 'missing',
          left: (rect.x / size.cx) * 100,
          top: (rect.y / size.cy) * 100,
          width: (rect.cx / size.cx) * 100,
          height: (rect.cy / size.cy) * 100,
          label: `${picExt.toUpperCase() || '图片'} 格式浏览器不支持`,
        })
        warn('有 wmf/emf 矢量图无法显示，已用占位框标出（另存为 PNG 后即可正常显示）')
        return
      }
      shapes.push({
        kind: 'image',
        left: (rect.x / size.cx) * 100,
        top: (rect.y / size.cy) * 100,
        width: (rect.cx / size.cx) * 100,
        height: (rect.cy / size.cy) * 100,
        src,
      })
    })

    // 表格
    Array.from(doc.getElementsByTagName('a:tbl')).forEach((tbl) => {
      const rows = parseTable(tbl)
      if (!rows.length) return
      // 不能用 closest('p:graphicFrame')：带冒号的标签名不是合法 CSS 选择器，
      // 会抛 "not a valid selector" 并导致整份文件解析失败。手写向上查找。
      let host: Element | null = tbl.parentElement
      while (host && host.localName !== 'graphicFrame') host = host.parentElement
      const rect = readXfrm(host) ?? { x: 0, y: 0, cx: size.cx * 0.8, cy: size.cy * 0.4 }
      shapes.push({
        kind: 'table',
        left: (rect.x / size.cx) * 100,
        top: (rect.y / size.cy) * 100,
        width: (rect.cx / size.cx) * 100,
        height: (rect.cy / size.cy) * 100,
        rows,
      })
      texts.push(rows.map((r) => r.join('\t')).join('\n'))
    })

    // 形状：图片填充 + 文本（占位符坐标从版式继承）
    Array.from(doc.getElementsByTagName('p:sp')).forEach((sp) => {
      // 标题占位符继承 titleStyle 的字号，正文继承 bodyStyle —— 两者差 16pt，
      // 混用会让标题缩水、正文撑破文本框（实测 58% 的 run 没有显式字号）
      const phType = sp.getElementsByTagName('p:ph')[0]?.getAttribute('type') ?? ''
      const isTitle = phType === 'title' || phType === 'ctrTitle'
      const { paras, text } = parseParas(sp, styleSource, isTitle)
      let rect0 = readXfrm(sp)
      if (!rect0) {
        const key = placeholderKey(sp)
        if (key) rect0 = phRects.get(key) ?? null
      }
      // 图片填充（a:blipFill）：装饰条、背景块、图形里嵌的图都走这里
      if (rect0 && sp.getElementsByTagName('a:blipFill').length) {
        const got = shapeImageSrc(archive, part, rels, sp)
        const box = {
          left: (rect0.x / size.cx) * 100,
          top: (rect0.y / size.cy) * 100,
          width: (rect0.cx / size.cx) * 100,
          height: (rect0.cy / size.cy) * 100,
        }
        if (got.src) shapes.push({ kind: 'image', ...box, src: got.src })
        else if (got.missing) shapes.push({ kind: 'missing', ...box, label: got.missing })
      }
      if (!text.trim()) return
      let rect = readXfrm(sp)
      if (!rect) {
        const key = placeholderKey(sp)
        if (key) rect = phRects.get(key) ?? null
      }
      if (!rect) return
      shapes.push({
        kind: 'text',
        left: (rect.x / size.cx) * 100,
        top: (rect.y / size.cy) * 100,
        width: (rect.cx / size.cx) * 100,
        height: (rect.cy / size.cy) * 100,
        paras,
      })
      texts.push(text)
    })

    slides.push({
      index: slides.length + 1,
      background: bg.color,
      backgroundImage: bg.image,
      shapes: decor.concat(shapes),
      text: texts.join('\n'),
    })
  }

  // 页宽高比：4:3 与 16:9 差别很大，写死会让每页留白或压扁。
  // 页宽 pt 一并返回：渲染端把 pt 字号换成像素时必须用真实页宽，
  // 否则 16:9（960pt）的稿子会被按 4:3（720pt）放大三分之一而撑破文本框。
  return { slides, warnings, aspect: size.cx / size.cy, widthPt: slideWidthPtOf(size.cx) }
}

/* ---------------- 测试入口（仅供 tests/ 使用，业务代码不要调） ---------------- */

/**
 * pt → 随卡片宽度缩放的字号（CSS 容器单位 cqw，1cqw = 卡片宽度的 1%）。
 *
 * 两处都必须用真实值，否则文字会撑破文本框被裁掉（用户报的「文字加载不出来」）：
 *   ① slideWidthPt 用文件真实页宽：4:3=720，16:9=960。写死 720 会放大 33%。
 *   ② 基准宽度用卡片**实际**宽度，而不是写死 900px：编辑器里卡片只有 640px 时，
 *      按 900 算出来的字号又大了 40%。cqw 让字号永远跟着卡片走，无需测量。
 *
 * 使用方必须给卡片设 container-type: inline-size，否则 cqw 会退化为视口单位。
 */
export function ptToCardFont(pt: number | undefined, slideWidthPt: number): string {
  const size = pt ?? 18
  const width = slideWidthPt > 0 ? slideWidthPt : 720
  // 纯比例，不设 px 下限：一旦设了下限，窄卡片上小字会被抬大，
  // 相对文本框变大反而溢出（实测 517px 卡片下 48/64 个文本框被裁切）。
  // 保真优先——PowerPoint 里本来就是多大就多大。
  return `${((size / width) * 100).toFixed(4)}cqw`
}

/** EMU → pt（PowerPoint 固定 12700 EMU = 1pt） */
export function slideWidthPtOf(cxEmu: number): number {
  return cxEmu > 0 ? cxEmu / 12700 : 720
}

export const mapSymbolTextForTest = mapSymbolText
export const resolveThemeFaceForTest = resolveThemeFace
export function readTxStyleSizesForTest(xml: string) {
  return readTxStyleSizes(xml)
}
