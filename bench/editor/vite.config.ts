import { defineConfig } from 'vite';

// The spike page (S5, S6), served by `vite preview` on 4290 for Chrome and WebView2.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5290, strictPort: true },
  preview: { host: '127.0.0.1', port: 4290, strictPort: true },
  build: { target: 'es2022' },
});
