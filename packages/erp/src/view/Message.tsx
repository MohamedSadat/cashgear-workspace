// A state of an ERP block with nothing to show: its own text, what can be done, and never data.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ErpError } from '../contract';
import { useErpT, type ErpT } from '../i18n';

export function Message({
  text,
  busy,
  error,
  children,
  testId,
}: {
  text: string;
  busy?: boolean;
  /** The refusal, for its correlation id (what finds the request in the ERP's log). */
  error?: ErpError | null;
  children?: ReactNode;
  testId?: string;
}) {
  const { t } = useErpT();
  return (
    <div
      className="cgw-erp-message"
      role="status"
      aria-busy={busy || undefined}
      data-testid={testId}
      data-code={error?.code}
    >
      <p className="cgw-erp-message-text">{text}</p>
      {error?.correlationId && (
        <p className="cgw-erp-muted cgw-erp-reference">
          {t('reference', { id: error.correlationId })}
        </p>
      )}
      {children && <div className="cgw-erp-actions">{children}</div>}
    </div>
  );
}

/** What a refusal or failure says, by its code (the ERP's own message is never shown). */
export function errorText(
  t: ErpT,
  error: ErpError | null,
  options: {
    readonly context: 'connect' | 'read';
    readonly connectKind?: 'popup' | 'browser';
    readonly company?: string;
    /** Seconds still to wait after a 429, or 0 once the wait is over. */
    readonly waitSeconds?: number;
  },
): string {
  switch (error?.code) {
    case 'connect.blocked':
      return t(options.connectKind === 'browser' ? 'browserFailed' : 'popupBlocked');
    case 'connect.cancelled':
      return t('popupClosed');
    case 'ticket.invalid':
      return t('ticketInvalid');
    case 'origin.denied':
      return t('originDenied');
    case 'privilege.denied':
      return t('noAccess');
    case 'connector.notFound':
      return t('connectorNotFound');
    case 'rate.limited':
      return options.waitSeconds
        ? t('rateLimited', { seconds: options.waitSeconds })
        : t('rateLimitedNow');
    case 'network':
    case 'server':
      return t('notAnswering');
    case 'response.invalid':
      return t('badAnswer');
    case 'request.invalid':
    case 'schema.changed':
      return t('requestInvalid');
    case 'session.none':
    case 'session.expired':
      return t('expired');
    case 'link.revoked':
      return t('linkRevoked', { company: options.company ?? '' });
    default:
      return t(options.context === 'connect' ? 'connectFailed' : 'failed');
  }
}

/**
 * The seconds left of a `Retry-After` wait, counting down to 0; 0 for anything but a 429 that
 * named a wait.
 */
export function useWait(error: ErpError | null): number {
  // A new error is a new wait; the same error keeps its deadline.
  const until = useMemo(
    () =>
      error?.code === 'rate.limited' && error.retryAfterMs ? Date.now() + error.retryAfterMs : 0,
    [error],
  );
  const [left, setLeft] = useState(() => seconds(until));
  useEffect(() => {
    setLeft(seconds(until));
    if (!until) return;
    const timer = setInterval(() => {
      const next = seconds(until);
      setLeft(next);
      if (!next) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return left;
}

const seconds = (until: number) =>
  until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
