import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

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
          editor: resolve(__dirname, 'src/preload/editor.ts'),
          sessionPicker: resolve(__dirname, 'src/preload/sessionPicker.ts'),
          accountManager: resolve(__dirname, 'src/preload/accountManager.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts'),
          cliTools: resolve(__dirname, 'src/preload/cliTools.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    }
  }
})
