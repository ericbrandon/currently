import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { currentlyServiceWorker } from './scripts/vite-plugin-sw'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [preact(), currentlyServiceWorker()],
  server: { host: true, port: 5173 },
})
