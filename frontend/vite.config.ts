import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Read the shared package straight from source, so `vite dev` doesn't depend on
      // shared/dist being built first. The backend consumes the compiled package instead,
      // since its NodeNext resolution needs real .d.ts files.
      '@threepio/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
})
