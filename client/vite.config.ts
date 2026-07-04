import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API + terminal WebSocket to the Node backend on 6880.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:6880', changeOrigin: true },
      '/ws': { target: 'ws://localhost:6880', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
