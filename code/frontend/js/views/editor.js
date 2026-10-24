/*
 * views/editor.js —— 编辑器视图
 * 谁调用：main.js
 * 不负责：内容怎么显示（交给 DocumentSession.mount）
 *
 * 关键：切换视图时不销毁会话。
 * 这样从编辑器回首页再进来，内容还在（文件对象也还在内存里）。
 * 只有"打开另一个文件"时，main.js 才会显式 destroy 旧的 session。
 */

/**
 * @param {HTMLElement} root
 */
export function createEditorView(root) {
  const host = root.querySelector('[data-role="editor-host"]')
  const empty = root.querySelector('[data-role="editor-empty"]')
  /** @type {import('../core/types.js').DocumentSession|null} */
  let mounted = null

  return {
    /**
     * 把会话挂进容器。传 null 表示清空。
     * @param {import('../core/types.js').DocumentSession|null} session
     */
    setSession(session) {
      if (mounted && mounted !== session) {
        // 防御性：正常情况下 main.js 已经 destroy 过；这里兜一层
        mounted.destroy()
      }
      host.replaceChildren()
      mounted = session
      if (session) session.mount(host)
    },

    render(s) {
      const hasSession = Boolean(s.session)
      host.hidden = !hasSession
      empty.hidden = hasSession
      empty.textContent = s.busy ? '正在打开…' : '还没有打开文件'
    },
  }
}
