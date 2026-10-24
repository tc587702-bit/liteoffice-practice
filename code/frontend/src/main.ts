import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import { installGlobalHandlers, reportFatal } from './lib/errors';

installGlobalHandlers();

const app = createApp(App);

// 组件内异常：不要让它在控制台静默，也不要把页面打白
app.config.errorHandler = (err, _instance, info) => {
  reportFatal(err, `组件渲染（${info}）`);
};

app.mount('#app');
