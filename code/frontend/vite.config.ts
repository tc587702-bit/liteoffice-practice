import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    /*
     * 端口用 5188 而不是默认的 5180：
     * 上午那套 LiteOffice 的静态服务器默认也占 5180，而且它可能是在别的窗口里
     * 启动的（本进程无权结束它）。固定用 5188 可以两套并存，不用互相等。
     * strictPort: false —— 万一 5188 也被占，自动往后找，不要启动失败。
     */
    port: 5190,
    strictPort: false,
    /*
     * 绑定所有网卡，让同一 WiFi 下的手机/别的电脑能打开。
     * 只绑 127.0.0.1 时，外部设备连不上。
     * 注意：开放后同一局域网任何人都能访问，仅用于演示。
     */
    host: true,
    /*
     * 忽略原子写入留下的临时目录。
     *
     * 为什么需要：编辑工具在替换文件时会先在目标旁边建一个
     * `.<name>.<pid>.<uuid>.tmpdir/` 再原子改名。Vite 的文件监听会跟进这个临时目录，
     * 而 Windows 上那个 .tmp 文件仍被占用 —— `fs.watch` 直接抛 EBUSY，
     * 整个 dev server 进程退出（不是 HMR 报错，是进程没了）。
     * 加进 ignored 后，临时目录不进监听，改动照常触发 HMR。
     */
    watch: {
      ignored: ['**/*.tmpdir/**', '**/.*.tmpdir/**', '**/.git/**'],
    },
  },
  /*
   * 三个入口，各有明确用途：
   *   index.html   主工作台（三栏界面）
   *   editor.html  编辑器独立页面 —— 由 iframe 加载，让 ONLYOFFICE 跑在整页环境里
   *   demo.html    纯 vue-office 演示页（不含 ONLYOFFICE）
   *
   * 不声明 input 的话，`npm run build` 只会产出 index.html，
   * 主界面里的 iframe 到线上就会 404。
   *
   * 这里用相对路径而不是 path.resolve(__dirname, ...)：
   * 项目没装 @types/node，且配置文件本身是 ESM（没有 __dirname），
   * 用相对路径 Vite 会按 root 解析，效果一样还少两个依赖。
   */
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        editor: 'editor.html',
        demo: 'demo.html',
      },
    },
    // ONLYOFFICE 的 WASM 和字体在 public/ 里原样复制，不要内联
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    // 这个包自己管理静态资源加载，不要预构建
    exclude: ['onlyoffice-web-local'],
  },
});
