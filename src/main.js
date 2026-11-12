import { createApp } from 'vue'
import App from './App.vue'
import { initSfx } from './lib/sfx'
import { initTheme } from './lib/theme'
import router from './router'
import './styles/app.css'

initTheme()
initSfx()
createApp(App).use(router).mount('#app')
