// `@cgw/erp/view`: the ERP views, React, each given a host by the shell: the ERP view block, the
// link screen (`#/erp-link/{ticket}`) and the settings section. They keep what the ERP answers in
// React state only.
export { ErpView, type ErpViewProps } from './ErpView';
export { ErpLinkScreen } from './ErpLinkScreen';
export { ErpSettings } from './ErpSettings';
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
} from './host';
export {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  filterText,
  fieldsText,
  planQuery,
  readSettings,
  sortText,
  type QueryPlan,
  type ViewSettings,
} from './settings';
export { cellText, formatDate, formatDateTime, formatDecimal } from './format';
export { createErpI18n, useErpT, type ErpKey } from '../i18n';
