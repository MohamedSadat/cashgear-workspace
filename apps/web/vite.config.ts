import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// One version for the whole app, from the root package.json.
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// The API this build talks to (src/platform/web.ts reads the same variable), and so the
// Content Security Policy it is served with (ARCHITECTURE.md, Security): scripts and styles from
// the app itself, images from it or made in it (assets arrive as bytes by signed URL), network
// only to the API and Blob Storage, frames only from Sheet, no plugins, no forms. `vite preview`
// sends the same header, so every e2e run is under the policy that ships; the production build
// writes it into staticwebapp.config.json for Azure Static Web Apps (docs/OPERATIONS.md).
const api = process.env.VITE_CGW_API ?? 'http://127.0.0.1:5280';
const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api);
const blob = local ? 'http://127.0.0.1:10000' : 'https://*.blob.core.windows.net';
const sheet = 'https://sheet.cashgearerp.com https://proud-desert-008137810.4.azurestaticapps.net';
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  // Tiptap adds its own small stylesheet at run time.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${api} ${blob}`,
  `frame-src ${sheet}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const headers = {
  'Content-Security-Policy': csp,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** Azure Static Web Apps' configuration, with the headers above, beside the built app. */
function staticWebAppConfig(): Plugin {
  return {
    name: 'cgw-static-web-app-config',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'staticwebapp.config.json',
        source: `${JSON.stringify({ globalHeaders: headers }, null, 2)}\n`,
      });
    },
  };
}

// No Cross-Origin-Embedder-Policy: Workspace needs no SharedArrayBuffer, and COEP would block
// third-party embeds and remote images (DECISIONS.md, "Workspace does not send COEP").
export default defineConfig({
  plugins: [react(), staticWebAppConfig()],
  define: { __CGW_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 5273, strictPort: true },
  preview: { host: '127.0.0.1', port: 4273, strictPort: true, headers },
  build: { target: 'es2022' },
});
