import { ref } from 'vue'

/**
 * AI 面板的共享开关：侧栏入口与右下角浮动按钮用同一份状态。
 * 只有显式 open() 才会触发面板 chunk 的懒加载与后端请求。
 */
export const aiPanelOpen = ref(false)

export function openAiPanel() {
  aiPanelOpen.value = true
}

export function closeAiPanel() {
  aiPanelOpen.value = false
}

export function toggleAiPanel() {
  aiPanelOpen.value = !aiPanelOpen.value
}
