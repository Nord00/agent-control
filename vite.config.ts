import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, forward API + WebSocket traffic to the Node server (npm start).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/events': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
