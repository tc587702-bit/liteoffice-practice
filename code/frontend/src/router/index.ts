import { createRouter, createWebHashHistory } from 'vue-router'
import Home from '../pages/Home.vue'
import Editor from '../pages/Editor.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/editor', name: 'editor', component: Editor },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

export default router
