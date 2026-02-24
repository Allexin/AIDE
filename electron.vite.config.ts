import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          picker: resolve(__dirname, 'src/preload/picker.ts'),
          editor: resolve(__dirname, 'src/preload/editor.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()]
  }
})
