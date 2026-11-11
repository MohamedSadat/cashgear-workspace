// The Workspace API client (D12): typed from the server's OpenAPI document, so a route or a shape
// the server changes fails the typecheck here. The web app authenticates with the API's cookie and
// an antiforgery header on writes; the desktop app with a bearer token it gets from its native side.
// No credential is ever stored by this package.
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

export type { components, paths };
export type Schemas = components['schemas'];

/** How requests are authenticated. */
export type ApiAuth =
  /** The browser's cookie for the API's host (web): credentials included, CSRF header on writes. */
  | { kind: 'cookie' }
  /** A bearer token, asked for before each request (desktop: from the keychain-backed native side). */
  | { kind: 'bearer'; token: () => Promise<string | null> };

/** A problem the server answered with (RFC 9457), with its stable code (ARCHITECTURE.md). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly correlationId: string | null,
    readonly body: unknown = null,
  ) {
    super(`${status} ${code}: ${title}`);
    this.name = 'ApiError';
  }
}

/** The server cannot be reached: offline, DNS, CORS refused. Never a reason to drop local work. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('The server could not be reached', { cause });
    this.name = 'NetworkError';
  }
}

export interface ApiOptions {
  baseUrl: string;
  auth: ApiAuth;
  /** For tests: a fetch of their own. */
  fetch?: typeof fetch;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export type ApiClient = Client<paths> & {
  readonly baseUrl: string;
  readonly auth: ApiAuth;
  /** Drops the cached antiforgery token (after signing in or out). */
  resetCsrf(): void;
};

export async function problemOf(response: Response): Promise<ApiError> {
  type Problem = { code?: string; title?: string; correlationId?: string };
  let body: Problem | null = null;
  try {
    body = (await response.clone().json()) as Problem;
  } catch {
    // Not a problem body: the status says enough.
  }
  return new ApiError(
    response.status,
    body?.code ?? (response.status === 401 ? 'auth.required' : 'server.error'),
    body?.title ?? response.statusText,
    body?.correlationId ?? response.headers.get('X-Correlation-Id'),
    body,
  );
}

export function createApi(options: ApiOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let csrf: Promise<string> | null = null;

  const antiforgery = () =>
    (csrf ??= fetcher(`${baseUrl}/api/v1/account/antiforgery`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw await problemOf(response);
        return ((await response.json()) as { token: string }).token;
      })
      .catch((error: unknown) => {
        csrf = null;
        throw error;
      }));

  const auth: Middleware = {
    async onRequest({ request }) {
      if (options.auth.kind === 'bearer') {
        const token = await options.auth.token();
        if (token) request.headers.set('Authorization', `Bearer ${token}`);
      } else if (!SAFE.has(request.method)) {
        request.headers.set('X-CSRF-TOKEN', await antiforgery());
      }
      return request;
    },
  };

  const client = createClient<paths>({
    baseUrl,
    credentials: options.auth.kind === 'cookie' ? 'include' : 'omit',
    fetch: async (request: Request) => {
      try {
        return await fetcher(request);
      } catch (error) {
        throw new NetworkError(error);
      }
    },
  });
  client.use(auth);
  return Object.assign(client, {
    baseUrl,
    auth: options.auth,
    resetCsrf: () => {
      csrf = null;
    },
  });
}

/**
 * The data of an answer, or its problem thrown as ApiError: callers write `ok(await api.GET(...))`
 * and handle failures by code.
 */
export async function ok<T>(result: { data?: T; error?: unknown; response: Response }): Promise<T> {
  if (result.response.ok) return result.data as T;
  throw await problemOf(result.response);
}

/**
 * Bytes from a signed URL (a snapshot, an asset): no credentials are sent, as the signature is
 * the whole of the permission. Throws NetworkError when the host cannot be reached.
 */
export async function getSigned(url: string): Promise<Response> {
  try {
    return await fetch(url, { credentials: 'omit' });
  } catch (error) {
    throw new NetworkError(error);
  }
}

/** Uploads bytes to a signed URL, with the headers the upload ticket names. */
export async function putSigned(
  url: string,
  headers: Record<string, string>,
  bytes: Uint8Array,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'PUT',
      headers,
      body: bytes as unknown as Blob,
      credentials: 'omit',
    });
  } catch (error) {
    throw new NetworkError(error);
  }
}
