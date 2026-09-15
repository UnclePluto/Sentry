import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    watch: {
      useFsEvents: false,
      usePolling: true,
      ignored: ['**/data/**', '**/public/maps/**'],
    },
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  plugins: [
    vinext(),
    ...(process.env.SENTRY_CONTAINER_BUILD === '1' ? [] : [sites()]),
  ],
});
