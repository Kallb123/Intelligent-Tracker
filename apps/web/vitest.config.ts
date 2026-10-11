import vue from '@vitejs/plugin-vue';
import { defineProject } from 'vitest/config';
import { appVersionDefine } from './app-version.js';

export default defineProject({
  plugins: [vue()],
  define: appVersionDefine,
  test: {
    name: '@tracker/web',
    environment: 'happy-dom',
  },
});
