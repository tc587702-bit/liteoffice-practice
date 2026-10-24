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
