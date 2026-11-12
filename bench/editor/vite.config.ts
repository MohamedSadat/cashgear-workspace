import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// Two pages, served by `vite preview` on 4290 for Chrome and WebView2: the spike page (S5, S6,
// S7, on the product's editor) and the whole app over a seeded store (Phase 1's budgets).
export default defineConfig({
  plugins: [react()],
  define: { __CGW_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 5290, strictPort: true },
  preview: { host: '127.0.0.1', port: 4290, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        spike: resolve(import.meta.dirname, 'index.html'),
        app: resolve(import.meta.dirname, 'app.html'),
        database: resolve(import.meta.dirname, 'database.html'),
      },
    },
  },
});
