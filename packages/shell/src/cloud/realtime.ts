// The app's real-time connection (Phase 6, `realtime.1`): the hub's transport the sync engine uses
// beside HTTP, and that presence listens to (`awareness`, `pagePresence`). Each attempt takes a
// fresh single-use ticket from `POST /api/v1/realtime/tickets` through the app's own API client
// (the cookie with its antiforgery header on the web, the bearer token on the desktop: the
// existing sign-in), then opens SignalR over WebSockets only, with no negotiation, at
// `{api}/api/v1/realtime?ticket=…`: the ticket is good for one connection within 60 seconds, so
// the address holds nothing that works once used, wherever it is logged. Nothing is stored. The
// reconnect loop, the answers and the frames are `HubTransport`'s (@cgw/workspace); SignalR's own
// automatic reconnect is not used, since every connection needs a new ticket. Only documents'
// updates and presence go through it: never ERP data, never an ERP session.
import { ApiError, NetworkError, type ApiClient } from '@cgw/api';
import {
  HubTransport,
  OfflineError,
  SyncHttpError,
  retryAfterMs,
  type HubSocket,
  type HubTransportOptions,
} from '@cgw/workspace';

/** A fresh ticket for one connection; OfflineError when the server cannot be reached. */
export async function realtimeTicket(api: ApiClient): Promise<string> {
  let result;
  try {
    result = await api.POST('/api/v1/realtime/tickets');
  } catch (error) {
    if (error instanceof NetworkError || error instanceof TypeError) throw new OfflineError(error);
    if (error instanceof ApiError) throw new SyncHttpError(error.status, error.code, error.title);
    throw error;
  }
  const { response } = result;
  if (!response.ok) {
    const body = result.error as { code?: string; title?: string } | undefined;
    throw new SyncHttpError(
      response.status,
      body?.code ?? (response.status === 401 ? 'auth.required' : 'server.error'),
      body?.title ?? response.statusText,
      response.status === 429 || response.status === 503
        ? retryAfterMs(response.headers.get('Retry-After'))
        : undefined,
    );
  }
  const ticket = result.data?.ticket;
  if (typeof ticket !== 'string' || !ticket)
    throw new SyncHttpError(500, 'server.error', 'The server gave no ticket');
  return ticket;
}

/** The hub's address for one connection. */
export function hubUrl(apiBase: string, ticket: string): string {
  return `${apiBase.replace(/\/$/, '')}/api/v1/realtime?ticket=${encodeURIComponent(ticket)}`;
}

export interface RealtimeOptions extends Omit<HubTransportOptions, 'open'> {
  /** Opens a socket at the hub's address (SignalR's; tests give their own). */
  connect?: (url: string) => Promise<HubSocket>;
}

/** The app's transport: a ticket per attempt, then the socket. Not started. */
export function createRealtime(api: ApiClient, options: RealtimeOptions = {}): HubTransport {
  const { connect = signalrSocket, ...rest } = options;
  return new HubTransport({
    ...rest,
    open: async () => connect(hubUrl(api.baseUrl, await realtimeTicket(api))),
  });
}

/**
 * A SignalR connection to the hub: WebSockets only, no negotiation (the hub takes nothing else),
 * the JSON protocol, the server's keep-alive (15 s) and timeout (30 s) mirrored. SignalR loads
 * with the first connection, not with the app.
 */
async function signalrSocket(url: string): Promise<HubSocket> {
  const signalr = await import('@microsoft/signalr');
  const connection = new signalr.HubConnectionBuilder()
    .withUrl(url, {
      skipNegotiation: true,
      transport: signalr.HttpTransportType.WebSockets,
    })
    .configureLogging({
      // Errors only, and as warnings: a dropped connection is expected and the loop handles it.
      log: (level, message) => {
        if (level >= signalr.LogLevel.Error) console.warn('Real-time:', message);
      },
    })
    .build();
  connection.keepAliveIntervalInMilliseconds = 15_000;
  connection.serverTimeoutInMilliseconds = 30_000;
  try {
    await connection.start();
  } catch (error) {
    throw new OfflineError(error);
  }
  return {
    invoke: (method, ...args) => connection.invoke(method, ...args),
    on: (event, handler) => connection.on(event, handler),
    onClose: (handler) => connection.onclose(handler),
    close: () => connection.stop(),
  };
}
