/*
 * shell/statusbar.js —— 底部状态栏
 * 谁调用：main.js
 * 不负责：业务逻辑
 *
 * 显示：左 = 状态文案（按 tone 上色），右 = 格式 · 保存状态
 */

/**
 * @param {HTMLElement} root
 */
export function createStatusbar(root) {
  root.innerHTML = `
    <span class="lo-status-text" data-role="text" data-tone="normal">就绪</span>
    <span class="lo-status-info" data-role="info"></span>
  `

  const text = root.querySelector('[data-role="text"]')
  const info = root.querySelector('[data-role="info"]')

  return {
    render(s) {
      text.textContent = s.status.text
      text.dataset.tone = s.status.tone

      if (!s.session) {
        info.textContent = ''
        return
      }
      const mark = s.doc.dirty ? '未保存' : '已保存'
      info.textContent = `${s.doc.ext} · ${mark}`
    },
  }
}
