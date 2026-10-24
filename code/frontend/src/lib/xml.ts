import { entryText, type ZipArchive } from './zip'

export type XmlNode = Element

const parser = new DOMParser()

/** 解析 XML 文本，失败返回 null（不抛错）。 */
export function parseXml(text: string, mime: DOMParserSupportedType = 'application/xml'): Document | null {
  try {
    const doc = parser.parseFromString(text, mime)
    if (doc.getElementsByTagName('parsererror').length > 0) return null
    return doc
  } catch {
    return null
  }
}

/** 从 zip 中读取并解析 XML；失败返回 null。 */
export function parseXmlFromZip(archive: ZipArchive | null, path: string): Document | null {
  try {
    const text = entryText(archive, path)
    if (!text) return null
    return parseXml(text)
  } catch {
    return null
  }
}

/** 所有元素后代（按 localName 匹配），可选命名空间本地名。 */
export function descendants(node: Node | null | undefined, localName: string): Element[] {
  if (!node) return []
  const out: Element[] = []
  const walk = (current: Node) => {
    const children = current.childNodes
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child.nodeType !== 1) continue
      const el = child as Element
      if (el.localName === localName) out.push(el)
      walk(el)
    }
  }
  walk(node)
  return out
}

/** 直接子元素（按 localName 过滤）。 */
export function childElements(node: Node | null | undefined, localName?: string): Element[] {
  if (!node) return []
  const out: Element[] = []
  const children = node.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.nodeType !== 1) continue
    const el = child as Element
    if (!localName || el.localName === localName) out.push(el)
  }
  return out
}

export function firstChild(node: Node | null | undefined, localName: string): Element | null {
  if (!node) return null
  return childElements(node, localName)[0] ?? null
}

/** 按 localName 找到第一个后代元素。 */
export function firstDescendant(node: Node | null | undefined, localName: string): Element | null {
  if (!node) return null
  if (node.nodeType === 1 && (node as Element).localName === localName) return node as Element
  return descendants(node, localName)[0] ?? null
}

export function elementChildren(node: Node | null | undefined): Element[] {
  return childElements(node)
}

/** 取属性：同时尝试命名空间限定名与 localName，兼容 r:embed / w:val 等写法。 */
export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null
  const direct = el.getAttribute(name)
  if (direct !== null) return direct
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]
    if (a.localName === name || a.name.endsWith(':' + name)) return a.value
  }
  return null
}

/** 按 localName 与属性值查找元素（深度优先首个）。 */
export function findByAttr(root: Node | null | undefined, localName: string, attrName: string, value: string) {
  return descendants(root, localName).find((el) => attr(el, attrName) === value) ?? null
}

/** XML 文本转义 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
