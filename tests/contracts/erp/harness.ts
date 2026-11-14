// The contract suite's HTTP and flow helpers (README.md). It speaks raw HTTP, so it tests the
// wire, not the client, and runs against the mock (started here) or any server at ERP_BASE_URL.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  CORRELATION_HEADER,
  ROUTES,
  SESSION_HEADER,
  connectorRoute,
  isServerErrorCode,
  parseConnectCreateTicket,
  parseConnectSession,
  parseErrorBody,
  parseLinkCreateTicket,
  parseLinkRedeem,
  parseSchema,
  type ConnectSession,
  type ConnectorSchema,
  type Language,
  type LinkRedeemResponse,
  type QueryRequest,
} from '../../../packages/erp/src/index';
import { startMockErp, type MockState } from '../../mocks/erp/server.mjs';

const env = process.env;
export const external = env.ERP_BASE_URL?.replace(/\/+$/, '') || undefined;
/** The mock: started here, or by hand at ERP_BASE_URL with ERP_BASE_IS_MOCK=1. */
export const onMock = !external || env.ERP_BASE_IS_MOCK === '1';
export const ORIGIN = env.ERP_TEST_ORIGIN ?? 'http://127.0.0.1:5273';
/** The cases that drive a server to its rate limits: always on the mock, else when asked. */
export const rateLimits = onMock || env.ERP_TEST_RATE_LIMITS === '1';

export type Role = 'full' | 'limited' | 'none' | 'admin' | 'other';

/**
 * The ERP users the suite acts as, by their API keys: on the mock its seeded users (alice, bob,
 * carol, dan, erin), else the ERP_TEST_KEY_* variables.
 */
export const KEYS: Record<Role, string | undefined> = onMock
  ? {
      full: 'mock-alice',
      limited: 'mock-bob',
      none: 'mock-carol',
      admin: 'mock-dan',
      other: 'mock-erin',
    }
  : {
      full: env.ERP_TEST_KEY_FULL,
      limited: env.ERP_TEST_KEY_LIMITED,
      none: env.ERP_TEST_KEY_NONE,
      admin: env.ERP_TEST_KEY_ADMIN,
      other: env.ERP_TEST_KEY_OTHER,
    };

export const lacks = (...roles: Role[]) => roles.some((role) => !KEYS[role]);

/** The connectors the server has, in the order Track E builds them. */
export const CONNECTORS = (env.ERP_TEST_CONNECTORS ?? 'vendors,customers,itemsOnHand')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
export const has = (id: string) => CONNECTORS.includes(id);

/** The workspace the suite links; revocation cases link workspaces of their own. */
export const WORKSPACE = env.ERP_TEST_WORKSPACE_ID ?? '01930000-0000-7000-8000-00000000c0de';
export const WORKSPACE_NAME = 'Contract suite';

let base = external ?? '';
let stopMock: (() => Promise<void>) | undefined;
let clientUrl: string | undefined;
/** Rises with each mock reset: what the suite remembers of the server is dropped then. */
let epoch = 0;

export const baseUrl = () => base;
export const mockClientUrl = () => clientUrl;

export async function startServer(): Promise<void> {
  if (!external) {
    const server = await startMockErp();
    base = server.apiUrl;
    clientUrl = server.clientUrl;
    stopMock = server.close;
  } else if (
    !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(base) &&
    env.ERP_ALLOW_WRITES !== '1'
  ) {
    throw new Error(
      `The contract suite makes and revokes links at ${base}. Set ERP_ALLOW_WRITES=1 if it is a test server.`,
    );
  }
}

export async function stopServer(): Promise<void> {
  if (!onMock) await revokeMade();
  await stopMock?.();
}

export async function resetMock(): Promise<void> {
  if (!onMock) return;
  await control('reset');
  epoch++;
}

// ---------------------------------------------------------------------------------------------
// HTTP

export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
}

export interface SendOptions {
  readonly body?: unknown;
  /** A raw body, sent as it is. */
  readonly raw?: string;
  readonly session?: string;
  readonly apiKey?: string;
  /** The Origin sent: Workspace's by default, none with null. */
  readonly origin?: string | null;
  readonly headers?: Record<string, string>;
  /** Take a 429 as the answer rather than waiting it out, for the cases that test it. */
  readonly limited?: boolean;
}

/** How many times a real server's 429 is waited out before the suite takes it as the answer. */
const MAX_LIMIT_WAITS = 3;

/** Routes whose answers must carry `no-store` on every server (the mock sends it on all). */
const noStore = (route: string) =>
  onMock || route.startsWith('api/connect/') || route === ROUTES.linkRedeem;

/**
 * Sends one request and checks what every answer must carry: a correlation id, `no-store`,
 * never a redirect, and on an error an error body repeating the id, with known codes.
 */
export async function send(
  method: 'GET' | 'POST' | 'OPTIONS',
  route: string,
  options: SendOptions = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined || options.raw !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.session !== undefined) headers[SESSION_HEADER] = options.session;
  if (options.apiKey !== undefined) headers['X-API-Key'] = options.apiKey;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.Origin = origin;
  let response: Response;
  for (let waits = 0; ; waits++) {
    response = await fetch(`${base}/${route}`, {
      method,
      headers,
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      redirect: 'manual',
    });
    // A real server's limits count every request this machine makes, and the suite opens many
    // sessions: it waits as the 429 asks, as Workspace would, rather than failing the case.
    if (onMock || response.status !== 429 || options.limited || waits >= MAX_LIMIT_WAITS) break;
    const seconds = Number(response.headers.get('Retry-After'));
    await response.arrayBuffer();
    await new Promise((done) => setTimeout(done, (seconds > 0 ? seconds : 5) * 1000));
  }
  const raw = await response.text();
  let json: unknown = null;
  if (raw !== '') {
    try {
      json = JSON.parse(raw);
    } catch {
      json = raw;
    }
  }
  if (method !== 'OPTIONS') {
    expect(response.status < 300 || response.status >= 400, `${route} never redirects`).toBe(true);
    const correlationId = response.headers.get(CORRELATION_HEADER);
    expect(correlationId, `${route} sends ${CORRELATION_HEADER}`).toBeTruthy();
    if (noStore(route)) {
      expect(response.headers.get('Cache-Control') ?? '', `${route} is no-store`).toContain(
        'no-store',
      );
    }
    if (response.status >= 400 && json !== null) {
      const body = parseErrorBody(json);
      expect(body.correlationId, `${route}: the body repeats the correlation id`).toBe(
        correlationId,
      );
      for (const error of body.errors) {
        expect(isServerErrorCode(error.code), `${route}: known code ${error.code}`).toBe(true);
      }
    }
  }
  return { status: response.status, headers: response.headers, json };
}

/** The first error code of an error answer. */
export function code(answer: Answer): string | undefined {
  return parseErrorBody(answer.json).errors[0]?.code;
}

/** Expects a refusal with this status and code. */
export function refused(answer: Answer, status: number, errorCode: string): void {
  expect(answer.status, `status for ${errorCode}`).toBe(status);
  expect(code(answer)).toBe(errorCode);
}

export async function control(route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}/__mock/${route}`, {
    method: body === undefined && route === 'state' ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, `/__mock/${route}`).toBeLessThan(300);
  const raw = await response.text();
  return raw === '' ? null : JSON.parse(raw);
}

export const advance = (ms: number) => control('clock', { advanceMs: ms });
export const mockState = () => control('state') as Promise<MockState>;

// ---------------------------------------------------------------------------------------------
// Links

/** Links the suite made on a real server, revoked when it ends. */
const made: { linkId: string; role: Role }[] = [];

async function revokeMade(): Promise<void> {
  for (const { linkId, role } of made) {
    await send('POST', ROUTES.linkRevoke, { apiKey: KEYS[role], body: { linkId } }).catch(
      () => undefined,
    );
  }
}

/** A link ticket from `WorkspaceLink/CreateTicket`, read from the address it answers. */
export async function linkTicket(role: Role = 'admin'): Promise<string> {
  const answer = await send('POST', ROUTES.linkCreateTicket, { apiKey: KEYS[role], body: {} });
  expect(answer.status, 'WorkspaceLink/CreateTicket').toBe(200);
  return parseLinkCreateTicket(answer.json).ticket;
}

/**
 * `WorkspaceLink/Redeem` for a ticket `role` made. On a real server every link it makes is
 * revoked when the suite ends.
 */
export async function redeemLink(
  ticket: string,
  workspaceId = WORKSPACE,
  origin?: string | null,
  role: Role = 'admin',
): Promise<Answer> {
  const answer = await send('POST', ROUTES.linkRedeem, {
    body: { ticket, workspaceId, workspaceName: WORKSPACE_NAME },
    origin,
  });
  if (!onMock && answer.status === 200) {
    const { linkId } = parseLinkRedeem(answer.json);
    if (!made.some((m) => m.linkId === linkId)) made.push({ linkId, role });
  }
  return answer;
}

/** A live link for `role`'s company and the workspace. */
export async function makeLink(
  role: Role = 'admin',
  workspaceId = WORKSPACE,
): Promise<LinkRedeemResponse> {
  const answer = await redeemLink(await linkTicket(role), workspaceId, undefined, role);
  expect(answer.status, 'WorkspaceLink/Redeem').toBe(200);
  return parseLinkRedeem(answer.json);
}

/** A workspace id no other case uses, for links a case revokes. */
export const freshWorkspace = () => `cgw-contract-${randomUUID()}`;

const links = new Map<string, { epoch: number; link: Promise<LinkRedeemResponse> }>();

/** The suite's link for the company of `admin` ('admin' for the main company, 'other'). */
export function sharedLink(admin: 'admin' | 'other' = 'admin'): Promise<LinkRedeemResponse> {
  const cached = links.get(admin);
  if (cached && cached.epoch === epoch) return cached.link;
  const link = makeLink(admin);
  links.set(admin, { epoch, link });
  return link;
}

// ---------------------------------------------------------------------------------------------
// Sessions

export interface TicketOptions {
  readonly workspaceId?: string;
  readonly language?: Language;
}

export function createConnectTicket(
  role: Role,
  linkId: string,
  options: TicketOptions = {},
): Promise<Answer> {
  return send('POST', ROUTES.connectCreateTicket, {
    apiKey: KEYS[role],
    body: {
      workspaceId: options.workspaceId ?? WORKSPACE,
      linkId,
      ...(options.language ? { language: options.language } : {}),
    },
  });
}

/** A connect ticket for `role` on a link. */
export async function connectTicket(
  role: Role,
  linkId: string,
  options: TicketOptions = {},
): Promise<string> {
  const answer = await createConnectTicket(role, linkId, options);
  expect(answer.status, 'WorkspaceConnect/CreateTicket').toBe(200);
  return parseConnectCreateTicket(answer.json).ticket;
}

export const redeem = (ticket: string, workspaceId = WORKSPACE, origin?: string | null) =>
  send('POST', ROUTES.redeem, { body: { ticket, workspaceId }, origin });

/** A new session for `role` on the link of its company (or the one given). */
export async function openSession(
  role: Role = 'full',
  options: TicketOptions & { readonly linkId?: string } = {},
): Promise<ConnectSession> {
  const linkId = options.linkId ?? (await sharedLink(role === 'other' ? 'other' : 'admin')).linkId;
  const answer = await redeem(await connectTicket(role, linkId, options), options.workspaceId);
  expect(answer.status, 'Session/Redeem').toBe(200);
  return parseConnectSession(answer.json);
}

const sessions = new Map<Role, { epoch: number; session: Promise<ConnectSession> }>();

/** A session the read-only cases share, so a real server's limits are not spent on them. */
export function sharedSession(role: Role = 'full'): Promise<ConnectSession> {
  const cached = sessions.get(role);
  if (cached && cached.epoch === epoch) return cached.session;
  const session = openSession(role);
  sessions.set(role, { epoch, session });
  return session;
}

// ---------------------------------------------------------------------------------------------
// Connectors

export async function schemaOf(token: string, id: string): Promise<ConnectorSchema> {
  const answer = await send('GET', connectorRoute(id, 'Schema'), { session: token });
  expect(answer.status, `${id}'s Schema`).toBe(200);
  return parseSchema(answer.json);
}

export function query(token: string, id: string, request: Partial<QueryRequest>): Promise<Answer> {
  return send('POST', connectorRoute(id, 'Query'), {
    session: token,
    body: { filter: {}, cursor: null, pageSize: 50, ...request },
  });
}
