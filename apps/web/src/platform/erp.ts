/**
 * Cash Gear ERP's two origins for this build, as `vite.config.ts` reads them for the CSP's
 * `connect-src` (decisions, 2026-11-14: Phase 5): the ERP's API (`VITE_CGW_ERP_API`, live
 * `https://api.cashgearerp.com`) and its client, whose connect page opens in a pop-up or the
 * system browser (`VITE_CGW_ERP_CLIENT`, live `https://erp.cashgearerp.com`). A build against a
 * local API defaults to the mock ERP (`tests/mocks/erp`): `http://127.0.0.1:4282` and
 * `http://127.0.0.1:4284`. No ERP address is ever read from anywhere else.
 */
export function erpFor(apiBase: string): { apiBase: string; clientOrigin: string } {
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBase);
  const api = import.meta.env.VITE_CGW_ERP_API as string | undefined;
  const client = import.meta.env.VITE_CGW_ERP_CLIENT as string | undefined;
  return {
    apiBase: api || (local ? 'http://127.0.0.1:4282' : 'https://api.cashgearerp.com'),
    clientOrigin: client || (local ? 'http://127.0.0.1:4284' : 'https://erp.cashgearerp.com'),
  };
}
