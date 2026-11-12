import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// One version for the whole app, from the root package.json.
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// The API this build talks to (src/platform/web.ts reads the same variable), and so the
// Content Security Policy it is served with (ARCHITECTURE.md, Security): scripts and styles from
// the app itself, images from it or made in it (assets arrive as bytes by signed URL), network
// only to the API and Blob Storage, frames only from Sheet, no plugins, no forms; workers, the
// service worker among them, only from the app itself. `vite preview` sends the same header, so
// every e2e run is under the policy that ships; the production build writes it into
// staticwebapp.config.json for Azure Static Web Apps (docs/OPERATIONS.md).
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

/**
 * Azure Static Web Apps' configuration, with the headers above, beside the built app. The service
 * worker's script is checked with the server on every start, never kept by the HTTP cache.
 */
function staticWebAppConfig(): Plugin {
  return {
    name: 'cgw-static-web-app-config',
    apply: 'build',
    generateBundle() {
      const config = {
        globalHeaders: headers,
        routes: [{ route: '/sw.js', headers: { 'Cache-Control': 'no-cache' } }],
      };
      this.emitFile({
        type: 'asset',
        fileName: 'staticwebapp.config.json',
        source: `${JSON.stringify(config, null, 2)}\n`,
      });
    },
  };
}

/** Every file under a folder, as a path relative to it with forward slashes. */
function filesUnder(root: string, folder = root): string[] {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(root, join(folder, entry.name))
      : [relative(root, join(folder, entry.name)).split(sep).join('/')],
  );
}

/**
 * The service worker (sw/service-worker.js, whose comment has its rules), written beside the
 * build as `sw.js` with the build's own files to precache and a cache named by a hash of them, so
 * each build's worker is new to the browser and the last one's cache goes when it takes over.
 */
function serviceWorker(): Plugin {
  let publicDir = '';
  return {
    name: 'cgw-service-worker',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const skip = new Set(['sw.js', 'staticwebapp.config.json']);
      const files = [...new Set([...Object.keys(bundle), ...filesUnder(publicDir)])]
        .filter((name) => !skip.has(name) && !name.endsWith('.map'))
        .sort();
      const page = bundle['index.html'];
      if (!page || page.type !== 'asset') throw new Error('The service worker needs index.html');
      const version = createHash('sha256')
        .update(files.join('\n'))
        .update(page.source)
        .digest('hex')
        .slice(0, 16);
      const template = readFileSync(new URL('./sw/service-worker.js', import.meta.url), 'utf8');
      const source = template
        .replace("'cgw-shell-dev'", JSON.stringify(`cgw-shell-${version}`))
        .replace('/* precache */ []', JSON.stringify(files));
      if (source.includes("'cgw-shell-dev'") || source.includes('/* precache */'))
        throw new Error('sw/service-worker.js lost its placeholders');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// No Cross-Origin-Embedder-Policy: Workspace needs no SharedArrayBuffer, and COEP would block
// third-party embeds and remote images (DECISIONS.md, "Workspace does not send COEP").
export default defineConfig({
  plugins: [react(), staticWebAppConfig(), serviceWorker()],
  define: { __CGW_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 5273, strictPort: true },
  preview: { host: '127.0.0.1', port: 4273, strictPort: true, headers },
  build: { target: 'es2022' },
});
