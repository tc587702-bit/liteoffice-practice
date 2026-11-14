import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  cacheDir: 'C:/deepseekharness/.vite-cache-ai',
  server: { port: 5196, strictPort: true, fs: { strict: false } },
})
