import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs, so the build runs from any path (including as a claude.ai artifact).
  base: './',
  plugins: [react()],
  server: { port: 5199, strictPort: true, watch: { usePolling: true, interval: 150 } },
})
