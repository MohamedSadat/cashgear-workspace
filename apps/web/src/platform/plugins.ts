/**
 * The one origin third-party plugins' frames are served from for this build (`VITE_CGW_PLUGINS`),
 * as `vite.config.ts` reads it for the CSP's `frame-src`: live `https://plugins.cashgearerp.com`;
 * a build against a local API defaults to the Sites process's second host on
 * `http://localhost:5291` (DECISIONS.md, 2026-11-18: Phase 10).
 */
export function pluginsOriginFor(apiBase: string): string {
  const named = import.meta.env.VITE_CGW_PLUGINS as string | undefined;
  if (named) return named;
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBase);
  return local ? 'http://localhost:5291' : 'https://plugins.cashgearerp.com';
}
