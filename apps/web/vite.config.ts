import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webPort = Number.parseInt(process.env.VITE_AGENTHUB_WEB_PORT || '43073', 10);
const apiProxyUrl = process.env.VITE_AGENTHUB_API_PROXY_URL || 'http://127.0.0.1:43080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    proxy: {
      '/api': apiProxyUrl,
      '/healthz': apiProxyUrl,
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
  },
});

