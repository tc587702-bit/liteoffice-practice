/*
 * core/file/web.js —— FileProvider 的 Web 实现
 * 谁调用：main.js
 * 不负责：解析文件内容（那是 session 的事）
 *
 * 两个方法的契约（对应 core/types.js）：
 *   open()  用户取消 → 返回 null，不要抛异常
 *   save()  浏览器不能静默写盘，所以永远是 'downloaded'
 *
 * 桌面版会换成 core/file/tauri.js，外壳代码完全不用改。
 */

/**
 * @param {{ input: HTMLInputElement }} deps 复用一个隐藏的 input，避免每次新建 DOM
 * @returns {import('../types.js').FileProvider}
 */
export function createWebFileProvider({ input }) {
  return {
    async open() {
      return new Promise((resolve, reject) => {
        // 用户取消时（Chrome 113+ 有 cancel 事件）必须 resolve(null)
        const onCancel = () => { cleanup(); resolve(null) }
        const onChange = async () => {
          const file = input.files?.[0]
          cleanup()
          if (!file) { resolve(null); return }
          try {
            const buffer = await file.arrayBuffer()
            resolve({ name: file.name, data: new Uint8Array(buffer) })
          } catch (err) {
            reject(err)
          }
        }
        const cleanup = () => {
          input.removeEventListener('change', onChange)
          input.removeEventListener('cancel', onCancel)
          // 清空 value，否则再次选同一个文件不会触发 change
          input.value = ''
        }

        input.addEventListener('change', onChange)
        input.addEventListener('cancel', onCancel)
        input.click()
      })
    },

    /**
     * @param {string} name
     * @param {Uint8Array} data
     * @returns {Promise<'saved'|'downloaded'|'cancelled'>}
     */
    async save(name, data) {
      const blob = new Blob([data], { type: mimeOf(name) })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.append(a)
      a.click()
      a.remove()
      // 立刻 revoke 会让部分浏览器下载失败，延后释放
      setTimeout(() => URL.revokeObjectURL(url), 1500)
      return 'downloaded'
    },
  }
}

/** @param {string} name */
function mimeOf(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return {
    md: 'text/markdown;charset=utf-8',
    markdown: 'text/markdown;charset=utf-8',
    txt: 'text/plain;charset=utf-8',
  }[ext] || 'application/octet-stream'
}
