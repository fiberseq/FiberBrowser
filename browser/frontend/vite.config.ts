import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset URLs: lazy chunks load relative to the module that imports
  // them, so the app also works under a URL prefix (Open OnDemand's
  // /rnode/<host>/<port>/, a lab proxy's /fiberbrowser/). The server rewrites
  // index.html's own asset links to the prefix (services/frontend_mount.py).
  base: './',
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          zustand: ['zustand'],
        },
      },
    },
  },
})
