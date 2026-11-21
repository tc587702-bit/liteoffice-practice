import { defineConfig } from 'vitest/config'

// 独立配置：不改 vite.config.ts，回退时删掉本文件即可
// docx.ts 依赖 DOMParser / CSSStyleDeclaration，必须跑在 jsdom 里
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
})