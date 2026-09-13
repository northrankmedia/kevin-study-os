import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // shared/contract.js is plain CommonJS (module.exports = {...}), not an
    // ES module — Rollup's default production-build pipeline only applies
    // CJS interop to dependencies under node_modules, so a relative import
    // of this local file (../../shared/contract.js) needs its own explicit
    // include here or the build fails with "X is not exported by
    // contract.js". Vite's dev server (esbuild-based, per-file transform)
    // doesn't hit this — it's a build-only gap.
    commonjsOptions: {
      include: [/shared[/\\]contract\.js$/, /node_modules/],
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
    },
  },
})
