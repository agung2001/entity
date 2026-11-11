import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// `base: './'` keeps asset paths relative so the built app also loads from
// the `file://` protocol inside Electron.
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Deliberately not Vite's default 5173, which other projects tend to hold.
    // strictPort is off: with a port clash Vite moves to the next free one, and
    // `scripts/dev-desktop.mjs` reads the port that was actually bound.
    port: Number(process.env.VITE_DEV_PORT) || 5183,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
