/*
 * main.js —— 入口，也是唯一的"指挥中心"
 * 谁调用：index.html 的 <script type="module">
 * 不负责：具体业务细节（读文件、解析、渲染都交给下面各模块）
 *
 * 单向数据流（整个架构只有这一条规矩）：
 *   用户操作 → 改 state → refresh() → 各视图重画
 *   任何人都不能反向调用 main.js；需要通知就用 handlers 回调或 session.on()
 */

import { state } from './state.js'
import { assertSession, assertFileProvider } from './core/types.js'
import { extOf, createSessionFor } from './core/registry.js'
import { createWebFileProvider } from './core/file/web.js'
import * as recents from './core/recents.js'
import { createToolbar } from './shell/toolbar.js'
import { createStatusbar } from './shell/statusbar.js'
import { createHomeView } from './views/home.js'
import { createEditorView } from './views/editor.js'

// ------------------------------------------------------------------ 依赖装配
const fileInput = document.querySelector('#file-input')
const fileProvider = assertFileProvider(createWebFileProvider({ input: fileInput }), 'webProvider')

const toolbar = createToolbar(document.querySelector('#toolbar'), {
  open: pickFile,
  save: saveDocument,
  print: printDocument,
  home: goHome,
})

const statusbar = createStatusbar(document.querySelector('#statusbar'))
const homeView = createHomeView(document.querySelector('#view-home'), {
  onPickFile: pickFile,
  onOpenRecent: openRecent,
})
const editorView = createEditorView(document.querySelector('#view-editor'))

// ------------------------------------------------------------------ 渲染
/** 唯一重画入口。任何改完 state 的地方都必须调它一次 */
function refresh() {
  document.body.dataset.view = state.view
  toolbar.render(state)
  statusbar.render(state)
  homeView.render(state)
  editorView.render(state)
}

/** @param {string} text @param {'normal'|'warn'|'error'} [tone] */
function setStatus(text, tone = 'normal') {
  state.status = { text, tone }
  refresh()
}

// ------------------------------------------------------------------ 打开
async function pickFile() {
  try {
    const opened = await fileProvider.open()
    if (!opened) return            // 用户取消：静默返回，不当成错误
    await openFileObject(opened)
  } catch (err) {
    setStatus(`打开失败：${err.message}`, 'error')
  }
}

/**
 * Web 端无法根据路径重开，只能提示重新选择。
 * @param {string} id
 */
function openRecent(id) {
  const item = state.recents.find((r) => r.id === id)
  if (!item) return
  setStatus(`${item.name}：Web 版请重新选择文件（桌面版会直接打开）`, 'warn')
}

/**
 * 核心链路：字节 → 会话 → 挂载 → 切视图
 * @param {{name:string, data:Uint8Array}} opened
 */
async function openFileObject({ name, data }) {
  const ext = extOf(name)
  const factory = createSessionFor(ext)

  if (!factory) {
    setStatus(`暂不支持 .${ext || '未知'} 格式`, 'warn')
    return
  }

  // 打开新文件前，先销毁旧会话（否则 iframe / 监听器会泄漏）
  if (state.session) {
    state.session.destroy()
    state.session = null
  }

  let session
  try {
    session = assertSession(factory())
  } catch (err) {
    setStatus(`内核初始化失败：${err.message}`, 'error')
    return
  }

  state.session = session
  state.doc = {
    name,
    ext,
    dirty: false,
    caps: { ...session.caps },
  }
  state.busy = true
  setStatus('正在打开…')

  session.on('change', ({ dirty }) => {
    state.doc.dirty = dirty
    refresh()
  })
  session.on('error', ({ message }) => setStatus(message, 'error'))

  try {
    await session.open(data, name)
    editorView.setSession(session)
    state.view = 'editor'
    state.recents = recents.list()
    setStatus('已打开')
  } catch (err) {
    setStatus(`打开失败：${err.message}`, 'error')
    session.destroy()
    state.session = null
    editorView.setSession(null)
  } finally {
    state.busy = false
    refresh()
  }
}

// ------------------------------------------------------------------ 保存
async function saveDocument() {
  if (!state.session || !state.doc.caps.exportable) return
  state.busy = true
  setStatus('正在保存…')
  try {
    const bytes = await state.session.export()
    const result = await fileProvider.save(state.doc.name, bytes)

    if (result === 'downloaded') {
      state.session.markClean?.()
      state.doc.dirty = false
      state.recents = recents.list()
      setStatus('已保存到下载目录')
    } else if (result === 'saved') {
      state.session.markClean?.()
      state.doc.dirty = false
      setStatus('已写回原文件')
    } else {
      setStatus('保存已取消', 'warn')
    }
  } catch (err) {
    setStatus(`保存失败：${err.message}`, 'error')
  } finally {
    state.busy = false
    refresh()
  }
}

async function printDocument() {
  if (!state.session || !state.doc.caps.printable) return
  try {
    await state.session.print()
    setStatus('已在打印对话框中输出')
  } catch (err) {
    setStatus(`导出失败：${err.message}`, 'error')
  }
}

function goHome() {
  // 注意：这里不 destroy 会话，切回首页后内容仍在
  state.view = 'home'
  refresh()
}

// ------------------------------------------------------------------ 拖拽
let dragDepth = 0

window.addEventListener('dragenter', (event) => {
  event.preventDefault()
  dragDepth += 1
  document.body.classList.add('lo-dragging')
})

window.addEventListener('dragover', (event) => {
  event.preventDefault()   // 不阻止默认行为，drop 事件不会触发
})

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) document.body.classList.remove('lo-dragging')
})

window.addEventListener('drop', async (event) => {
  event.preventDefault()
  dragDepth = 0
  document.body.classList.remove('lo-dragging')

  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  try {
    const buffer = await file.arrayBuffer()
    await openFileObject({ name: file.name, data: new Uint8Array(buffer) })
  } catch (err) {
    setStatus(`打开失败：${err.message}`, 'error')
  }
})

// ------------------------------------------------------------------ 快捷键
// 快捷键绑在壳里，不绑在内核里 —— 这样所有格式行为一致
window.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey
  if (!mod) return

  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveDocument()
  }
  if (event.key.toLowerCase() === 'o') {
    event.preventDefault()
    pickFile()
  }
})

// ------------------------------------------------------------------ 启动
state.recents = recents.list()
refresh()
setStatus('就绪')

// 方便在控制台做验收：state.view = 'editor'; __lo.refresh()
window.__lo = { state, refresh, openFileObject, saveDocument }
