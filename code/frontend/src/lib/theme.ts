import { computed, ref } from 'vue'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'liteoffice-theme'

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  let saved: string | null = null
  try {
    saved = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    saved = null
  }
  if (saved === 'light' || saved === 'dark') return saved
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

const theme = ref<Theme>(readInitialTheme())

function applyTheme(next: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = next
  document.documentElement.style.colorScheme = next
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', next === 'light' ? '#f5f5f7' : '#000000')
}

/** 在 mount 前调用：把 index.html 里的首屏主题标记同步到响应式状态 */
export function initTheme() {
  applyTheme(theme.value)
}

export function useTheme() {
  const isLight = computed(() => theme.value === 'light')

  function setTheme(next: Theme) {
    theme.value = next
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 隐私模式下 localStorage 可能不可写，主题仍对当前页面生效 */
    }
    applyTheme(next)
  }

  function toggleTheme() {
    setTheme(theme.value === 'light' ? 'dark' : 'light')
  }

  return { theme, isLight, setTheme, toggleTheme }
}

/* 多标签页同步：一个标签切换后，其它标签跟着变 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    if (event.newValue !== 'light' && event.newValue !== 'dark') return
    theme.value = event.newValue
    applyTheme(event.newValue)
  })
}
