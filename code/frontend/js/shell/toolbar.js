/*
 * shell/toolbar.js —— 顶部工具栏
 * 谁调用：main.js（createToolbar）
 * 不负责：决定"能不能保存"（那是 state.doc.caps 决定的）
 *
 * 契约：render(state) 只读 state，不发请求、不弹框、不修改 state。
 * 需要做事时调用 handlers 里的回调，由 main.js 决定做什么。
 */

/**
 * @param {HTMLElement} root
 * @param {{open:()=>void, save:()=>void, print:()=>void, home:()=>void}} handlers
 */
export function createToolbar(root, handlers) {
  root.innerHTML = `
    <div class="lo-toolbar-left">
      <span class="lo-brand">LiteOffice</span>
      <button class="lo-btn lo-btn-ghost" data-act="home" type="button" hidden>返回首页</button>
      <span class="lo-docname" data-role="docname">未打开文件</span>
    </div>
    <div class="lo-toolbar-right">
      <button class="lo-btn" data-act="open" type="button">打开</button>
      <button class="lo-btn" data-act="save" type="button" disabled>保存</button>
      <button class="lo-btn" data-act="print" type="button" disabled>导出 PDF</button>
    </div>
  `

  const docname = root.querySelector('[data-role="docname"]')
  const btnHome = root.querySelector('[data-act="home"]')
  const btnSave = root.querySelector('[data-act="save"]')
  const btnPrint = root.querySelector('[data-act="print"]')

  // 事件委托：只绑一个监听器，以后加按钮不用改这里
  root.addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act
    if (act && typeof handlers[act] === 'function') handlers[act]()
  })

  return {
    /** @param {import('../state.js').state} s */
    render(s) {
      const { name, ext, dirty, caps } = s.doc
      const inEditor = s.view === 'editor'

      docname.textContent = s.session
        ? `${name}${dirty ? ' •' : ''}`
        : '未打开文件'

      btnHome.hidden = !inEditor
      // 按钮状态一律从 caps 推导，不写 if (ext === 'pdf') 这种散落判断
      btnSave.disabled = !caps.editable || !dirty || s.busy
      btnPrint.disabled = !caps.printable || !s.session

      root.dataset.ext = ext || ''
    },
  }
}
