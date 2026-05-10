import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      'Content-Security-Policy': [
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        "worker-src 'self' blob:",
        "connect-src 'self' blob: ws://localhost:* wss://localhost:* http://localhost:*",
        "media-src 'self' blob: mediastream:",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
      ].join('; '),
    },
  },
  base: './'
})
