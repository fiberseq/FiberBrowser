import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { writeManifest } from './scripts/build-inputs.mjs'

// The build records what it was made from (dist/build-inputs.json): packaging/check_frontend_dist.py recomputes the
// hashes to tell whether a tracked dist is this tree's build. Written into whichever folder the build went to.
function buildInputs(): Plugin {
  let root = ''
  let outDir = ''
  return {
    name: 'fiberbrowser-build-inputs',
    apply: 'build',
    configResolved(config) { root = config.root; outDir = config.build.outDir },
    closeBundle() { writeManifest(root, outDir) },
  }
}

export default defineConfig({
  // Relative asset URLs: lazy chunks load relative to the module that imports
  // them, so the app also works under a URL prefix (Open OnDemand's
  // /rnode/<host>/<port>/, a lab proxy's /fiberbrowser/). The server rewrites
  // index.html's own asset links to the prefix (services/frontend_mount.py).
  base: './',
  plugins: [react(), buildInputs()],
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
