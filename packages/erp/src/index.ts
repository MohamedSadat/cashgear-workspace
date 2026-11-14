// @cgw/erp: Cash Gear ERP for Workspace (Phase 5, Level 1): erp-connect.1's types and a guard for
// every answer, the client, one in-memory session per link, and the connect flows. Nothing here
// keeps an ERP answer or a token anywhere but in memory: no store, no storage, no log (lint).
export * from './contract';
export {
  codeForStatus,
  createErpClient,
  retryAfterMs,
  type ErpClient,
  type ErpClientOptions,
  type ErpQueryOptions,
  type ErpRequestOptions,
} from './client';
export {
  ACTIVITY_EVENTS,
  ErpSessions,
  RENEW_EVERY_MS,
  RENEW_RETRY_MS,
  type ActivityTarget,
  type ConnectFlow,
  type ConnectRequest,
  type ErpLinkRef,
  type ErpSessionInfo,
  type ErpSessionState,
  type ErpSessionsOptions,
} from './session';
export {
  connectState,
  connectUrl,
  deepLinkConnect,
  deepLinkFlow,
  isErpDeepLink,
  parseErpDeepLink,
  popupConnect,
  popupFlow,
  type DeepLinkConnectOptions,
  type MessageTarget,
  type PopupConnectOptions,
  type PopupWindow,
} from './connect';
