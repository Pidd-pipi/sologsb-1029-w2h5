import { createApp } from 'vue';
import Varlet from '@varlet/ui';
import '@varlet/ui/es/style';
import './style.css';
import App from './App.vue';

createApp(App).use(Varlet).mount('#app');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // The app remains usable online when service-worker registration is unavailable.
    });
  });
}
