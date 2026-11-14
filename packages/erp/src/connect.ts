// Getting a connect ticket from the ERP client (INTEGRATIONS.md, "A user's session"). On the web
// the ERP client's connect page opens in a pop-up and posts the ticket back to its opener; on the
// desktop it opens in the system browser and comes back by deep link. Either way the ticket is
// taken once, only with the state sent (128 random bits, kept in memory), and only from the ERP
// client: its origin and the pop-up's own window on the web.

import { DEEP_LINK_PREFIX, ErpError, isState, isTicket, readConnectMessage } from './contract';
import type { ConnectRequest } from './session';

/** The pop-up as `window.open` returns it. */
export interface PopupWindow {
  readonly closed: boolean;
  close(): void;
}

/** What hears the pop-up's message: the window. */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** 128 random bits in base64url, 22 characters. */
export function connectState(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The ERP client's origin as configured: an http or https origin, nothing after it. */
function checkOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError('The ERP client is not an address.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) {
    throw new TypeError('The ERP client must be an origin, such as https://erp.example.com.');
  }
  return url.origin;
}

/**
 * The ERP client's connect page:
 * `{client}/workspace-connect?workspace=<id>&link=<erpLinkId>&state=<state>&return=web|desktop`.
 */
export function connectUrl(
  clientOrigin: string,
  params: {
    readonly workspaceId: string;
    readonly erpLinkId: string;
    readonly state: string;
    readonly return: 'web' | 'desktop';
  },
): string {
  const query = new URLSearchParams({
    workspace: params.workspaceId,
    link: params.erpLinkId,
    state: params.state,
    return: params.return,
  });
  return `${checkOrigin(clientOrigin)}/workspace-connect?${query}`;
}

export interface PopupConnectOptions {
  /** The ERP client's origin, from the build (`VITE_CGW_ERP_CLIENT`), never from a link. */
  readonly clientOrigin: string;
  readonly workspaceId: string;
  readonly erpLinkId: string;
  /**
   * Opens the pop-up at `url`, at once, inside the person's click:
   * `(url) => window.open(url, 'cgw-erp-connect', 'popup,width=520,height=720')`. Null when it
   * was blocked. It must keep its opener: no `noopener`.
   */
  readonly open: (url: string) => PopupWindow | null;
  /** Where the pop-up's message arrives; the window by default. */
  readonly messages?: MessageTarget;
  readonly signal?: AbortSignal;
  /** How often to look whether the person closed the pop-up. */
  readonly pollMs?: number;
  /** How long a closed pop-up's message may still take to arrive. */
  readonly closeGraceMs?: number;
}

/**
 * Opens the ERP client's connect page in a pop-up and resolves with the ticket it posts back:
 * a `cgw-erp-connect` message from `clientOrigin`, from that pop-up's window, with the state
 * sent, taken once. Fails with `connect.blocked` when the pop-up did not open,
 * `connect.cancelled` when the person closed it, `aborted` when `signal` stopped it.
 */
export function popupConnect(options: PopupConnectOptions): Promise<string> {
  let origin: string;
  try {
    origin = checkOrigin(options.clientOrigin);
  } catch (error) {
    return Promise.reject(error);
  }
  if (options.signal?.aborted) return Promise.reject(new ErpError('aborted'));
  const state = connectState();
  const url = connectUrl(origin, {
    workspaceId: options.workspaceId,
    erpLinkId: options.erpLinkId,
    state,
    return: 'web',
  });
  const messages =
    options.messages ?? (globalThis as { window?: MessageTarget }).window ?? undefined;
  if (!messages) return Promise.reject(new ErpError('connect.blocked', { detail: 'no window' }));
  let popup: PopupWindow | null;
  try {
    popup = options.open(url);
  } catch {
    popup = null;
  }
  if (!popup) return Promise.reject(new ErpError('connect.blocked'));
  const opened = popup;
  const pollMs = options.pollMs ?? 500;
  const closeGraceMs = options.closeGraceMs ?? 1000;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: { ticket: string } | { error: ErpError }) => {
      if (settled) return;
      settled = true;
      messages.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      clearInterval(poll);
      if (grace !== undefined) clearTimeout(grace);
      try {
        if (!opened.closed) opened.close();
      } catch {
        // A pop-up that went elsewhere may refuse; it is the person's window now.
      }
      if ('ticket' in outcome) resolve(outcome.ticket);
      else reject(outcome.error);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== opened) return;
      const ticket = readConnectMessage(event.data, state);
      if (ticket !== null) finish({ ticket });
    };

    const onAbort = () => finish({ error: new ErpError('aborted') });

    const poll = setInterval(() => {
      if (!opened.closed || grace !== undefined) return;
      grace = setTimeout(() => finish({ error: new ErpError('connect.cancelled') }), closeGraceMs);
    }, pollMs);

    messages.addEventListener('message', onMessage);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A connect flow for `ErpSessions` from `popupConnect`'s settings. */
export function popupFlow(
  options: Omit<PopupConnectOptions, 'workspaceId' | 'erpLinkId' | 'signal'>,
): (request: ConnectRequest) => Promise<string> {
  return (request) => popupConnect({ ...options, ...request });
}

/** The ticket and state of `cashgear-workspace://erp#ticket=…&state=…`, or null. */
export function parseErpDeepLink(url: string): { ticket: string; state: string } | null {
  if (url.slice(0, DEEP_LINK_PREFIX.length).toLowerCase() !== DEEP_LINK_PREFIX) return null;
  const m = /^\/?#(.*)$/.exec(url.slice(DEEP_LINK_PREFIX.length));
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const ticket = params.get('ticket');
  const state = params.get('state');
  return isTicket(ticket) && isState(state) ? { ticket, state } : null;
}

/** Whether a deep link is the ERP's return, which the app hands here and never routes. */
export function isErpDeepLink(url: string): boolean {
  const rest = url.slice(DEEP_LINK_PREFIX.length);
  return (
    url.slice(0, DEEP_LINK_PREFIX.length).toLowerCase() === DEEP_LINK_PREFIX &&
    (rest === '' || /^[/#?]/.test(rest))
  );
}

export interface DeepLinkConnectOptions {
  /** The ERP client's origin, from the build. */
  readonly clientUrl: string;
  readonly workspaceId: string;
  readonly erpLinkId: string;
  /** Opens the connect page in the system browser. */
  readonly openExternal: (url: string) => void | Promise<void>;
  /** Hears the app's deep links (`cashgear-workspace://…`); returns what stops it. */
  readonly onDeepLink: (listener: (url: string) => void) => () => void;
  readonly signal?: AbortSignal;
}

/**
 * The desktop's flow: the connect page opens in the system browser with `return=desktop`, and
 * the ticket comes back as `cashgear-workspace://erp#ticket=…&state=…` with the state sent,
 * taken once. Fails with `connect.blocked` when the browser could not be opened and `aborted`
 * when `signal` stopped it.
 */
export function deepLinkConnect(options: DeepLinkConnectOptions): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new ErpError('aborted'));
  const state = connectState();
  let url: string;
  try {
    url = connectUrl(options.clientUrl, {
      workspaceId: options.workspaceId,
      erpLinkId: options.erpLinkId,
      state,
      return: 'desktop',
    });
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { ticket: string } | { error: ErpError }) => {
      if (settled) return;
      settled = true;
      stop();
      options.signal?.removeEventListener('abort', onAbort);
      if ('ticket' in outcome) resolve(outcome.ticket);
      else reject(outcome.error);
    };
    const onAbort = () => finish({ error: new ErpError('aborted') });
    // Listening first, so a quick return is not missed.
    const stop = options.onDeepLink((link) => {
      const read = parseErpDeepLink(link);
      if (read && read.state === state) finish({ ticket: read.ticket });
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => options.openExternal(url))
      .catch(() => finish({ error: new ErpError('connect.blocked') }));
  });
}

/** A connect flow for `ErpSessions` from `deepLinkConnect`'s settings. */
export function deepLinkFlow(
  options: Omit<DeepLinkConnectOptions, 'workspaceId' | 'erpLinkId' | 'signal'>,
): (request: ConnectRequest) => Promise<string> {
  return (request) => deepLinkConnect({ ...options, ...request });
}
