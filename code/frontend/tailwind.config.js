/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        /* 冻结深色令牌 */
        ink: '#000000',
        card: '#303032',
        secondary: '#3A3A3C',
        accent: '#0A84FF',
        t1: '#F5F5F7',
        t2: '#98989D',
        t3: '#A1A1A6',
        t4: '#636366',

        /* 语义主题令牌：深色 / 浅色由 CSS 变量切换 */
        'lo-bg': 'var(--lo-bg)',
        'lo-surface': 'var(--lo-surface)',
        'lo-surface-2': 'var(--lo-surface-2)',
        'lo-surface-3': 'var(--lo-surface-3)',
        'lo-surface-4': 'var(--lo-surface-4)',
        'lo-surface-hover': 'var(--lo-surface-hover)',
        'lo-elevated': 'var(--lo-elevated)',
        'lo-elevated-2': 'var(--lo-elevated-2)',
        'lo-code': 'var(--lo-code)',
        'lo-inset': 'var(--lo-inset)',
        'lo-fill-1': 'var(--lo-fill-1)',
        'lo-fill-2': 'var(--lo-fill-2)',
        'lo-fill-3': 'var(--lo-fill-3)',
        'lo-text-1': 'var(--lo-text-1)',
        'lo-text-2': 'var(--lo-text-2)',
        'lo-text-3': 'var(--lo-text-3)',
        'lo-text-4': 'var(--lo-text-4)',
        'lo-text-5': 'var(--lo-text-5)',
        'lo-border': 'var(--lo-border)',
        'lo-border-soft': 'var(--lo-border-soft)',
        'lo-border-strong': 'var(--lo-border-strong)',
        'lo-accent-text': 'var(--lo-accent-text)',
        'lo-accent-hover': 'var(--lo-accent-hover)',
        'lo-success-text': 'var(--lo-success-text)',
        'lo-warning-text': 'var(--lo-warning-text)',
        'lo-danger-text': 'var(--lo-danger-text)',
        'lo-scrim': 'var(--lo-scrim)',
      },
      borderRadius: {
        card: '24px',
      },
      boxShadow: {
        primary: '0 4px 16px rgba(10,132,255,0.3)',
      },
    },
  },
  plugins: [],
}
