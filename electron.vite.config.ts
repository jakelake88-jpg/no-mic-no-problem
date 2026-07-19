import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // sandboxed preloads must be CJS, not ESM
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      sourcemap: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  }
})
