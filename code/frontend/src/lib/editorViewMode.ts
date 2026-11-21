import { ref } from 'vue'

/**
 * 编辑器视图模式（md 源码 / 预览）的共享状态。
 *
 * 说明：千问的 1041dcf 提交里 Editor.vue 引用了本模块，但文件本身没提交上来，
 * 合并后会编译失败。这里补一个最小实现，保证 md 源码编辑可用；
 * 他那边的完整版（含 Worker 渲染、回退逻辑）可以随时覆盖本文件。
 */
export const mdSourceActive = ref(false)

type PreviewFallback = (() => boolean) | null

let fallback: PreviewFallback = null

/** 注册「切回预览」的回调；传 null 注销 */
export function registerPreviewFallback(fn: PreviewFallback): void {
  fallback = fn
}

/**
 * 请求切回预览视图（定位、引用、问题标注需要真实的 .lo-editor DOM）。
 * 返回 true 表示确实做了切换。
 */
export function requestPreviewView(): boolean {
  if (!fallback) return false
  const changed = fallback()
  if (changed) mdSourceActive.value = false
  return changed
}
