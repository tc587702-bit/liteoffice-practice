/*
 * session/markdown.js —— Markdown 的 DocumentSession 实现
 * 谁调用：core/registry.js 的工厂
 * 不负责：文件读写（交给 FileProvider）、界面布局（交给 views/editor.js）
 *
 * 现状：内核是 <textarea>，够用且零依赖。
 * Day 2 换成 CodeMirror 时，只改这个文件，外壳一行都不用动
 * —— 这就是 DocumentSession 接口的价值。
 */

/**
 * @returns {import('../core/types.js').DocumentSession}
 */
export function createMarkdownSession() {
  const el = document.createElement('div')
  el.className = 'lo-md'

  const area = document.createElement('textarea')
  area.className = 'lo-md-input'
  area.spellcheck = false
  area.setAttribute('aria-label', '文档正文')
  el.append(area)

  let dirty = false
  let destroyed = false
  let name = ''

  /** @type {Record<string, Array<(payload:any)=>void>>} */
  const listeners = { change: [], ready: [], error: [], closed: [] }

  const emit = (event, payload) => {
    for (const cb of listeners[event] || []) cb(payload)
  }

  // 每次输入都 emit，让外壳自己决定"有没有变化"（外壳只按 payload 更新界面）
  area.addEventListener('input', () => {
    dirty = true
    emit('change', { dirty: true })
  })

  return {
    kind: 'md',

    // textarea 没有渲染视图，所以暂时不能导出 PDF（见 styles/print.css 的说明）
    caps: {
      editable: true,
      undoable: true,
      findable: false,
      exportable: true,
      printable: false,
    },

    get name() { return name },

    get dirty() { return dirty },

    async open(bytes) {
      // TextDecoder 默认 UTF-8，与浏览器下载的 md 一致
      area.value = new TextDecoder('utf-8').decode(bytes)
      dirty = false
      emit('ready', { kind: 'md' })
    },

    mount(container) {
      container.replaceChildren(el)
    },

    async command(cmd) {
      switch (cmd.type) {
        case 'zoom':
          // level 为倍数：1 → 13px
          area.style.fontSize = `${Math.round(13 * cmd.level)}px`
          break
        case 'undo':
        case 'redo':
          // 交给浏览器原生撤销栈；失败也不抛错（契约第 1 条）
          try {
            area.focus()
            document.execCommand(cmd.type)
          } catch { /* 忽略：不支持就当作无事发生 */ }
          break
        case 'find':
          // TODO(Day 2)：md 渲染视图接上后再实现查找（caps.findable 目前为 false）
          break
        default:
          break
      }
    },

    async export() {
      // 保存的永远是最新内容；编码必须和 open() 的解码方式对称
      return new TextEncoder().encode(area.value)
    },

    async print() {
      // caps.printable = false，外壳不会调用。
      // Day 3 接上渲染视图后在这里实现：dataset.printing → 等两帧 → window.print() → 复原
    },

    on(event, cb) {
      if (listeners[event]) listeners[event].push(cb)
    },

    /** 保存成功后由外壳调用，把 dirty 清零（否则标题上的 • 永远不消失） */
    markClean() {
      dirty = false
      emit('change', { dirty: false })
    },

    destroy() {
      if (destroyed) return   // 幂等：第二次调用什么都不做
      destroyed = true
      el.remove()
      for (const key of Object.keys(listeners)) listeners[key].length = 0
      emit('closed')
    },
  }
}
