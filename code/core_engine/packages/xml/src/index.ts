/**
 * @liteoffice/xml —— 低分配流式 XML 拉取解析器。
 *
 * 定位：为 OOXML / ODF / SVG 这类「巨型但结构规整」的 XML 服务。
 * 不追求 XML 规范全覆盖（不做 DTD 校验、不做名字空间解析、不建 DOM），
 * 追求「能打开、内存有界、不抛错」。
 */
export { XmlPullParser, XmlError, splitName, walkXml, xmlTextAt, eachElement } from './pull.ts';
export type { XmlEvent, XmlEventType, XmlParserOptions } from './pull.ts';
export { decodeEntities, escapeText, escapeAttr } from './entities.ts';
