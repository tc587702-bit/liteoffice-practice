import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './index.css'
import './polish.css'
import './theme.css'
import { initTheme } from './lib/theme'

initTheme()

createApp(App).use(createPinia()).use(router).mount('#app')
