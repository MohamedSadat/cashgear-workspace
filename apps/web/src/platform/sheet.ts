/**
 * Cash Gear Sheet's one origin for this build (`VITE_CGW_SHEET`), as `vite.config.ts` reads it
 * for the CSP's `frame-src`: live `https://sheet.cashgearerp.com`; a build against a local API
 * defaults to the mock Sheet on `http://127.0.0.1:4283` (decisions, 2026-11-14: Phase 5).
 */
export function sheetOriginFor(apiBase: string): string {
  const named = import.meta.env.VITE_CGW_SHEET as string | undefined;
  if (named) return named;
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBase);
  return local ? 'http://127.0.0.1:4283' : 'https://sheet.cashgearerp.com';
}
