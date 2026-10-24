/*
 * core/registry.js —— 扩展名 → 会话工厂
 * 谁调用：main.js 的 openFileObject()
 * 不负责：读写文件、操作 DOM
 *
 * 加一个新格式 = 在这里加一行映射，外壳一行都不用改。
 * 这正是 DocumentSession 接口存在的意义。
 */

import { createMarkdownSession } from '../session/markdown.js'

/** 扩展名 → 工厂函数。工厂每次调用必须返回一个新会话。 */
const FACTORIES = {
  md: createMarkdownSession,
  markdown: createMarkdownSession,
  // TODO(Day 2)：docx / xlsx / pptx → createOfficeSession，pdf → createPdfSession
}

/**
 * 从文件名取小写扩展名。
 * @param {string} fileName
 * @returns {string}
 */
export function extOf(fileName) {
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase()
}

/**
 * 取会话工厂；没有对应格式时返回 null（由调用方给出友好提示，不要抛异常）。
 * @param {string} ext
 * @returns {(() => import('./types.js').DocumentSession) | null}
 */
export function createSessionFor(ext) {
  const factory = FACTORIES[ext]
  return factory || null
}

/** 首页展示用：当前支持的扩展名列表 */
export function supportedExts() {
  return [...new Set(Object.keys(FACTORIES))]
}
