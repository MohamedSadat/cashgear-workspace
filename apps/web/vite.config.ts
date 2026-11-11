import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One version for the whole app, from the root package.json.
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// No Cross-Origin-Embedder-Policy: Workspace needs no SharedArrayBuffer, and COEP would block
// third-party embeds and remote images (DECISIONS.md, "Workspace does not send COEP").
export default defineConfig({
  plugins: [react()],
  define: { __CGW_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 5273, strictPort: true },
  preview: { host: '127.0.0.1', port: 4273, strictPort: true },
  build: { target: 'es2022' },
});
