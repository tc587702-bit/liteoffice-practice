/*
 * views/home.js —— 首页视图
 * 谁调用：main.js
 * 不负责：真正读取文件（交给 core/file/web.js）
 *
 * 只做三件事：拖拽区、最近打开列表、空态。
 */

/**
 * @param {HTMLElement} root
 * @param {{ onPickFile:()=>void, onOpenRecent:(id:string)=>void }} handlers
 */
export function createHomeView(root, handlers) {
  const list = root.querySelector('[data-role="recent"]')
  const empty = root.querySelector('[data-role="recent-empty"]')

  root.querySelector('[data-act="pick"]').addEventListener('click', () => handlers.onPickFile())

  // 事件委托：列表是动态渲染的，不能逐个绑
  list.addEventListener('click', (event) => {
    const item = event.target.closest('[data-recent-id]')
    if (item) handlers.onOpenRecent(item.dataset.recentId)
  })

  return {
    render(s) {
      const items = s.recents || []
      empty.hidden = items.length > 0
      list.replaceChildren(...items.map(renderItem))
    },
  }
}

/** @param {{id:string,name:string,ext:string,openedAt:number}} item */
function renderItem(item) {
  const li = document.createElement('li')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'lo-recent-item'
  button.dataset.recentId = item.id

  const name = document.createElement('span')
  name.className = 'lo-recent-name'
  name.textContent = item.name

  const meta = document.createElement('span')
  meta.className = 'lo-recent-meta'
  meta.textContent = `${item.ext} · ${formatTime(item.openedAt)}`

  button.append(name, meta)
  li.append(button)
  return li
}

/** 时间戳 → "14:05" 或 "10-23" */
function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const pad = (n) => String(n).padStart(2, '0')
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
