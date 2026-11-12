import { createApp } from 'vue'
import App from './App.vue'
import { initTheme } from './lib/theme'
import router from './router'
import './styles/app.css'

initTheme()
createApp(App).use(router).mount('#app')
