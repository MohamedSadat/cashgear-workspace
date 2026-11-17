// @cgw/erp: Cash Gear ERP for Workspace (Phase 5, Level 1; Phase 7, Level 2): erp-connect.1's
// types and a guard for every answer, the client, one in-memory session per link, the connect
// flows, and the drafts that hold changes until a person reviews and commits them. Nothing here
// keeps an ERP answer, a change or a token anywhere but in memory: no store, no storage, no log
// (lint). AI code takes only `@cgw/erp/ai`'s types.
export * from './contract';
export {
  codeForStatus,
  createErpClient,
  retryAfterMs,
  type CommitOutcome,
  type ErpClient,
  type ErpClientOptions,
  type ErpCommitStatusOptions,
  type ErpQueryOptions,
  type ErpRequestOptions,
} from './client';
// Phase 7: pending changes per block, in memory, reviewed and committed through the sessions.
export {
  COMMIT_RETRIES,
  ErpDraft,
  ErpDrafts,
  localProblem,
  parseInput,
  sameValue,
  type CommitAuditOutcome,
  type DraftChange,
  type DraftCommitApi,
  type DraftOptions,
  type DraftPhase,
  type DraftPlace,
  type DraftRecord,
  type DraftSource,
  type ErpCommitAudit,
  type ParsedInput,
} from './drafts';
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
// What the shell gives the views (`./view` has the views themselves, React; `./i18n` their
// catalogues): no React here, so the app's frame can take these without the views.
export {
  RecordLinkError,
  type ErpAvailability,
  type ErpBlockAttrs,
  type ErpConnection,
  type ErpLinkInfo,
  type ErpLinkScreenHost,
  type ErpLinksState,
  type ErpSessionsApi,
  type ErpSettingsHost,
  type ErpViewHost,
  type LinkableWorkspace,
  type RecordLinkFailure,
} from './view/host';
