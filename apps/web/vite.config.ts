import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const apiTarget = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000';
const proxy = { '/api': apiTarget, '/ical': apiTarget };

export default defineConfig({
  plugins: [vue()],
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
});
