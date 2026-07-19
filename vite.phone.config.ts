import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the phone-facing static page served by the in-app HTTPS server.
export default defineConfig({
  root: 'phone',
  base: './',
  build: {
    outDir: resolve(__dirname, 'out/phone'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2020'
  },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
})
