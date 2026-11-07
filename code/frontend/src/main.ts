import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './index.css'
import { installGlobalErrorHandlers } from './lib/errors'
import { dumpLogs, logger } from './lib/logger'

const app = createApp(App)

// 必须在 mount 之前安装：否则首屏渲染阶段的异常没人接。
installGlobalErrorHandlers(app, router)

app.use(createPinia()).use(router).mount('#app')

logger.info('LiteOffice 已启动', {
  mode: import.meta.env.MODE,
  href: window.location.href,
})

if (import.meta.env.DEV) {
  // 开发期在控制台手动导出日志：__liteofficeLogs()
  Object.assign(window, { __liteofficeLogs: () => dumpLogs() })
}
