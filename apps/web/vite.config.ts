import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In production /mcp, /api, /oauth and /.well-known are served from the same domain; in dev the API runs on its own port
    proxy: {
      '/mcp': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/oauth': 'http://localhost:3000',
      '/.well-known': 'http://localhost:3000',
    },
  },
})
