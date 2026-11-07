import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './index.css'
import { collectDiagnostics, installGlobalErrorHandlers } from './lib/errors'
import { dumpLogs, logger } from './lib/logger'

const app = createApp(App)

// 必须在 mount 之前安装：否则首屏渲染阶段的异常没人接。
installGlobalErrorHandlers(app, router)

app.use(createPinia()).use(router).mount('#app')

logger.info('LiteOffice 已启动', {
  mode: import.meta.env.MODE,
  href: window.location.href,
})

/**
 * 浏览器无法直接写硬盘，日志只能「按需导出成文件」。
 * 控制台可用：
 *   __liteofficeLogs()      → 打印纯文本日志（可全选复制）
 *   __liteofficeDiagnose()  → 直接下载诊断文件（含 UA / 视口 / 最近 300 条日志）
 */
Object.assign(window, {
  __liteofficeLogs: () => dumpLogs(),
  __liteofficeDiagnose: () => {
    const text = collectDiagnostics()
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `liteoffice-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return text
  },
})
