import { defineConfig } from 'vite';

// base './' so the built page works when Electron serves it from its own app:// protocol.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
