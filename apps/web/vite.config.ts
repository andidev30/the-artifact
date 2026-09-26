import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Where the API runs in development; override to run several copies side by side
const api = process.env.API_URL ?? 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In production /mcp, /api, /oauth and /.well-known are served from the same domain; in dev the API runs on its own port
    proxy: {
      '/mcp': api,
      '/api': api,
      '/oauth': api,
      '/.well-known': api,
    },
  },
})
