// The calls Workspace makes to Cash Gear ERP (erp-connect.1). Every answer is checked by the
// contract's guards before anyone sees it, and every failure becomes an `ErpError` with a code.
// The session token travels only in `X-Connect-Session`: never in a URL, a body, an error or a
// log. No cookie goes (`credentials: 'omit'`), no redirect is followed (one would carry the
// header wherever it points), no referrer is sent, and nothing is cached.

import {
  CORRELATION_HEADER,
  ErpContractError,
  ErpError,
  RETRY_AFTER_HEADER,
  ROUTES,
  SESSION_HEADER,
  connectorRoute,
  isServerErrorCode,
  isToken,
  parseConnectSession,
  parseConnectors,
  parseErrorBody,
  parseLinkRedeem,
  parseQueryResponse,
  parseRenew,
  parseSchema,
  type ConnectSession,
  type ConnectorSchema,
  type ConnectorSummary,
  type ErpErrorCode,
  type LinkRedeemResponse,
  type QueryRequest,
  type QueryResponse,
  type RenewResponse,
} from './contract';

export interface ErpRequestOptions {
  /** Cancels the call; it then fails with `aborted`. */
  readonly signal?: AbortSignal;
}

export interface ErpQueryOptions extends ErpRequestOptions {
  /** The connector's schema, so every record is checked against it. */
  readonly schema?: ConnectorSchema;
}

export interface ErpClient {
  /** The ERP API's base, without a trailing slash. */
  readonly apiBase: string;
  /** `WorkspaceLink/Redeem`: the link a ticket from `#/erp-link/{ticket}` names. */
  redeemLink(
    ticket: string,
    workspaceId: string,
    workspaceName: string,
    options?: ErpRequestOptions,
  ): Promise<LinkRedeemResponse>;
  /** `Session/Redeem`: sent once per ticket, never again, since a lost answer may have used it. */
  redeem(ticket: string, workspaceId: string, options?: ErpRequestOptions): Promise<ConnectSession>;
  renew(token: string, options?: ErpRequestOptions): Promise<RenewResponse>;
  /** `Session/End`; `keepalive` lets it go as the page closes. */
  end(token: string, options?: ErpRequestOptions & { readonly keepalive?: boolean }): Promise<void>;
  /** The connectors this user may view. */
  connectors(token: string, options?: ErpRequestOptions): Promise<readonly ConnectorSummary[]>;
  schema(token: string, id: string, options?: ErpRequestOptions): Promise<ConnectorSchema>;
  query(
    token: string,
    id: string,
    request: QueryRequest,
    options?: ErpQueryOptions,
  ): Promise<QueryResponse>;
}

export interface ErpClientOptions {
  /** Per call; past it the call fails with `network`. 30 seconds by default. */
  readonly timeoutMs?: number;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Which routes a bare status is read for, when an answer has no code of its own. */
type RouteKind = 'ticket' | 'session' | 'connector';

interface Call {
  readonly method: 'GET' | 'POST';
  readonly route: string;
  readonly kind: RouteKind;
  readonly token?: string;
  readonly body?: unknown;
  readonly keepalive?: boolean;
  readonly signal?: AbortSignal;
}

interface Answer {
  readonly status: number;
  readonly correlationId: string | null;
  readonly json: unknown;
}

/** The code a status means when the ERP sent none (or one this client does not know). */
export function codeForStatus(status: number, kind: RouteKind = 'connector'): ErpErrorCode {
  switch (status) {
    case 400:
      return 'request.invalid';
    case 401:
      return kind === 'ticket' ? 'ticket.invalid' : 'session.expired';
    case 403:
      return 'privilege.denied';
    case 404:
      return kind === 'connector' ? 'connector.notFound' : 'server';
    case 413:
      return 'batch.tooLarge';
    case 429:
      return 'rate.limited';
    default:
      return 'server';
  }
}

/** Seconds or an HTTP date, as `Retry-After` gives them. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** The ERP API's base as given: an http or https address with no query, fragment or password. */
function checkBase(apiBase: string): string {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new TypeError('The ERP API base is not an address.');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('The ERP API base must be an http or https address without a query.');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function createErpClient(
  apiBase: string,
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  options: ErpClientOptions = {},
): ErpClient {
  const base = checkBase(apiBase);
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function send(call: Call): Promise<Answer> {
    if (call.signal?.aborted) throw new ErpError('aborted');
    if (call.token !== undefined && !isToken(call.token)) {
      // Never handed to `Headers`, whose error would quote it.
      throw new ErpError('session.expired', { detail: 'not a session token' });
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (call.body !== undefined) headers['Content-Type'] = 'application/json';
    if (call.token !== undefined) headers[SESSION_HEADER] = call.token;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const stop = () => controller.abort();
    call.signal?.addEventListener('abort', stop, { once: true });
    try {
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(`${base}/${call.route}`, {
          method: call.method,
          headers,
          body: call.body === undefined ? undefined : JSON.stringify(call.body),
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          mode: 'cors',
          signal: controller.signal,
          ...(call.keepalive ? { keepalive: true } : {}),
        });
        text = await response.text();
      } catch {
        // The error itself is dropped: what a fetch failure says is not ours to pass on.
        if (call.signal?.aborted) throw new ErpError('aborted');
        throw new ErpError('network', { detail: timedOut ? 'no answer in time' : 'no answer' });
      }
      const correlationId = response.headers.get(CORRELATION_HEADER);
      let json: unknown = null;
      let unreadable = false;
      if (text !== '') {
        try {
          json = JSON.parse(text);
        } catch {
          unreadable = true;
        }
      }
      if (!response.ok) throw failure(response, json, correlationId, call.kind);
      if (unreadable) {
        throw new ErpError('response.invalid', {
          status: response.status,
          correlationId,
          detail: 'not JSON',
        });
      }
      return { status: response.status, correlationId, json };
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', stop);
    }
  }

  function failure(
    response: Response,
    json: unknown,
    headerId: string | null,
    kind: RouteKind,
  ): ErpError {
    let code: ErpErrorCode = codeForStatus(response.status, kind);
    let correlationId = headerId;
    try {
      const body = parseErrorBody(json);
      const first = body.errors[0]?.code;
      if (isServerErrorCode(first)) code = first;
      correlationId ??= body.correlationId;
    } catch {
      // An answer without the ERP's error body: its status says what it means.
    }
    return new ErpError(code, {
      status: response.status,
      correlationId,
      retryAfterMs: retryAfterMs(response.headers.get(RETRY_AFTER_HEADER)),
    });
  }

  /** Sends a call and checks its answer with `parse`. */
  async function json<T>(call: Call, parse: (value: unknown) => T): Promise<T> {
    const answer = await send(call);
    try {
      return parse(answer.json);
    } catch (error) {
      if (!(error instanceof ErpContractError) && !(error instanceof ErpError)) throw error;
      throw new ErpError('response.invalid', {
        status: answer.status,
        correlationId: answer.correlationId,
        detail: error instanceof ErpContractError ? `${error.path}: ${error.expected}` : undefined,
      });
    }
  }

  return {
    apiBase: base,

    redeemLink(ticket, workspaceId, workspaceName, options = {}) {
      return json(
        {
          method: 'POST',
          route: ROUTES.linkRedeem,
          kind: 'ticket',
          body: { ticket, workspaceId, workspaceName },
          signal: options.signal,
        },
        parseLinkRedeem,
      );
    },

    redeem(ticket, workspaceId, options = {}) {
      return json(
        {
          method: 'POST',
          route: ROUTES.redeem,
          kind: 'ticket',
          body: { ticket, workspaceId },
          signal: options.signal,
        },
        parseConnectSession,
      );
    },

    renew(token, options = {}) {
      return json(
        { method: 'POST', route: ROUTES.renew, kind: 'session', token, signal: options.signal },
        parseRenew,
      );
    },

    async end(token, options = {}) {
      await send({
        method: 'POST',
        route: ROUTES.end,
        kind: 'session',
        token,
        keepalive: options.keepalive,
        signal: options.signal,
      });
    },

    async connectors(token, options = {}) {
      const answer = await json(
        { method: 'GET', route: ROUTES.connectors, kind: 'session', token, signal: options.signal },
        parseConnectors,
      );
      return answer.connectors;
    },

    schema(token, id, options = {}) {
      return json(
        {
          method: 'GET',
          route: connectorRoute(id, 'Schema'),
          kind: 'connector',
          token,
          signal: options.signal,
        },
        (value) => {
          const schema = parseSchema(value);
          if (schema.id !== id) {
            throw new ErpContractError('$.id', 'the connector asked for', schema.id);
          }
          return schema;
        },
      );
    },

    query(token, id, request, options = {}) {
      return json(
        {
          method: 'POST',
          route: connectorRoute(id, 'Query'),
          kind: 'connector',
          token,
          body: request,
          signal: options.signal,
        },
        (value) =>
          parseQueryResponse(value, {
            schema: options.schema,
            fields: request.fields,
            pageSize: request.pageSize,
          }),
      );
    },
  };
}
