// A person's ERP sessions in this tab (INTEGRATIONS.md, "A user's session"): one per link, kept
// in memory only. Tokens live in a private field and leave it only as `X-Connect-Session`, so
// they cannot be read off this object, serialised with it, logged or written to any store. A
// session is renewed at most every 5 minutes while the person works in the tab (a key, a click,
// a scroll), ended with a `keepalive` request on `pagehide`, and forgotten when the app closes.

import type { ErpClient, ErpQueryOptions, ErpRequestOptions } from './client';
import {
  ErpError,
  LIMITS,
  type ConnectSession,
  type ConnectorSchema,
  type ConnectorSummary,
  type QueryRequest,
  type QueryResponse,
} from './contract';

export type ErpSessionState = 'none' | 'connecting' | 'connected' | 'expired' | 'revoked' | 'error';

/** A Workspace link to an ERP company, as Workspace's API lists it. */
export interface ErpLinkRef {
  /** Workspace's `ErpLinks` id, which blocks name: sessions are kept by it. */
  readonly id: string;
  /** The ERP's own link id, which tickets and sessions are bound to. */
  readonly erpLinkId: string;
  readonly workspaceId: string;
}

export interface ConnectRequest {
  readonly workspaceId: string;
  readonly erpLinkId: string;
  /** Aborted when the person cancels or the tab closes. */
  readonly signal: AbortSignal;
}

/**
 * Gets a connect ticket from the ERP client: `popupConnect` on the web, `deepLinkConnect` on the
 * desktop. Called synchronously inside `connect`, so a pop-up opens within the click that asked.
 */
export type ConnectFlow = (request: ConnectRequest) => Promise<string>;

/** What a session may show of itself: Redeem's answer without the token. */
export type ErpSessionInfo = Omit<ConnectSession, 'token'>;

/** What sessions hear activity and the page closing on: the window. */
export interface ActivityTarget {
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: () => void, options?: EventListenerOptions): void;
}

export interface ErpSessionsOptions {
  readonly client: ErpClient;
  readonly flow: ConnectFlow;
  /**
   * Where activity and `pagehide` are heard; the window by default. Null hears nothing: the
   * caller calls `touch` and `endAll` itself.
   */
  readonly target?: ActivityTarget | null;
  /** The clock, for tests. */
  readonly now?: () => number;
}

/** Renew at most this often, however busy the person is (decisions, 2026-11-14). */
export const RENEW_EVERY_MS = 5 * 60_000;
/** After a Renew that got no answer, the next activity tries again this much later. */
export const RENEW_RETRY_MS = 30_000;
/** What counts as working in the tab. Heard in the capture phase, passively. */
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

interface Entry {
  link: ErpLinkRef;
  state: ErpSessionState;
  error: ErpError | null;
  /** Set while connected; null otherwise. */
  token: string | null;
  info: ErpSessionInfo | null;
  /** The ERP's clock minus this device's, from Redeem's answer. */
  offset: number;
  /** On this device's clock. */
  expiresAt: number;
  maxExpiresAt: number;
  renewAttemptAt: number;
  renewDelay: number;
  renewing: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  connecting: { controller: AbortController; promise: Promise<ErpSessionState> } | null;
  /** Rises with each session, so the answer to an older one's request changes nothing. */
  generation: number;
}

const noop = () => undefined;

function asErpError(error: unknown): ErpError {
  return error instanceof ErpError ? error : new ErpError('network', { detail: 'unexpected' });
}

export class ErpSessions {
  readonly #client: ErpClient;
  readonly #flow: ConnectFlow;
  readonly #now: () => number;
  readonly #target: ActivityTarget | null;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(linkId: string, state: ErpSessionState) => void>();
  #disposed = false;

  readonly #onActivity = () => this.touch();
  readonly #onPageHide = () => this.endAll({ keepalive: true });

  constructor(options: ErpSessionsOptions) {
    this.#client = options.client;
    this.#flow = options.flow;
    this.#now = options.now ?? Date.now;
    const fallback = (globalThis as { window?: ActivityTarget }).window ?? null;
    this.#target = options.target === undefined ? fallback : options.target;
    for (const type of ACTIVITY_EVENTS) {
      this.#target?.addEventListener(type, this.#onActivity, { capture: true, passive: true });
    }
    this.#target?.addEventListener('pagehide', this.#onPageHide);
  }

  /** The link's state; `none` for a link never connected here. */
  state(linkId: string): ErpSessionState {
    const entry = this.#entries.get(linkId);
    return entry ? this.#current(entry) : 'none';
  }

  /** The open session's details, without its token; null unless connected. */
  session(linkId: string): ErpSessionInfo | null {
    return this.state(linkId) === 'connected' ? (this.#entries.get(linkId)?.info ?? null) : null;
  }

  /** Why the link is in `error` (or, after a refused request, `expired` or `revoked`). */
  error(linkId: string): ErpError | null {
    return this.#entries.get(linkId)?.error ?? null;
  }

  /** Hears every link's state change. Returns what stops it. */
  subscribe(listener: (linkId: string, state: ErpSessionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Gets a ticket through the flow and redeems it. Resolves with the state it ends in, never
   * rejects: the reason for `error` is `error(linkId)`. A second call while one runs gets the
   * same promise; a link already connected stays as it is.
   */
  connect(link: ErpLinkRef): Promise<ErpSessionState> {
    if (this.#disposed) return Promise.resolve<ErpSessionState>('none');
    let entry = this.#entries.get(link.id);
    if (!entry) {
      entry = {
        link,
        state: 'none',
        error: null,
        token: null,
        info: null,
        offset: 0,
        expiresAt: 0,
        maxExpiresAt: 0,
        renewAttemptAt: 0,
        renewDelay: RENEW_EVERY_MS,
        renewing: false,
        timer: undefined,
        connecting: null,
        generation: 0,
      };
      this.#entries.set(link.id, entry);
    }
    if (entry.connecting) return entry.connecting.promise;
    if (this.#current(entry) === 'connected') return Promise.resolve<ErpSessionState>('connected');
    entry.link = link;
    const target = entry;
    const controller = new AbortController();
    this.#set(target, 'connecting', null);
    let ticket: Promise<string>;
    try {
      // Synchronously, so the pop-up opens inside the person's click.
      ticket = this.#flow({
        workspaceId: link.workspaceId,
        erpLinkId: link.erpLinkId,
        signal: controller.signal,
      });
    } catch (error) {
      ticket = Promise.reject(error);
    }
    const promise = this.#finishConnect(target, link, ticket, controller);
    target.connecting = { controller, promise };
    return promise;
  }

  async #finishConnect(
    entry: Entry,
    link: ErpLinkRef,
    ticket: Promise<string>,
    controller: AbortController,
  ): Promise<ErpSessionState> {
    try {
      const session = await this.#client.redeem(await ticket, link.workspaceId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.#disposed || session.linkId !== link.erpLinkId) {
        // Not this link's session, or no one wants it now: it is ended at once.
        this.#client.end(session.token, { keepalive: true }).catch(noop);
        if (session.linkId !== link.erpLinkId) {
          throw new ErpError('response.invalid', { detail: 'a session for another link' });
        }
        throw new ErpError('aborted');
      }
      this.#open(entry, session);
      return 'connected';
    } catch (error) {
      const e = asErpError(error);
      if (e.code === 'aborted' || e.code === 'connect.cancelled') this.#set(entry, 'none', null);
      else if (e.code === 'link.revoked') this.#set(entry, 'revoked', e);
      else this.#set(entry, 'error', e);
      return entry.state;
    } finally {
      entry.connecting = null;
    }
  }

  /** Stops a connect that is waiting for the ERP client. */
  cancel(linkId: string): void {
    this.#entries.get(linkId)?.connecting?.controller.abort();
  }

  /** The person ends the link's session: End is sent, and the link is back to `none`. */
  disconnect(linkId: string): void {
    const entry = this.#entries.get(linkId);
    if (!entry) return;
    entry.connecting?.controller.abort();
    this.#close(entry, 'none', null, false);
  }

  /**
   * Ends every session, as the page closes (`pagehide`) or the app quits: End goes with
   * `keepalive`, and the tokens are forgotten.
   */
  endAll(options: { readonly keepalive?: boolean } = {}): void {
    for (const entry of this.#entries.values()) {
      entry.connecting?.controller.abort();
      this.#close(entry, 'none', null, options.keepalive ?? true);
    }
  }

  /** Ends every session and stops listening. */
  dispose(): void {
    if (this.#disposed) return;
    this.endAll({ keepalive: true });
    this.#disposed = true;
    for (const type of ACTIVITY_EVENTS) {
      this.#target?.removeEventListener(type, this.#onActivity, { capture: true });
    }
    this.#target?.removeEventListener('pagehide', this.#onPageHide);
    this.#listeners.clear();
  }

  /**
   * The person did something in the tab: each open session last renewed 5 minutes ago or more
   * is renewed, so it stays open while they work, whether or not anything is sent.
   */
  touch(): void {
    const now = this.#now();
    for (const entry of this.#entries.values()) {
      if (entry.state !== 'connected' || entry.renewing) continue;
      if (now >= this.#deadline(entry)) {
        this.#expire(entry);
        continue;
      }
      if (now - entry.renewAttemptAt >= entry.renewDelay) void this.#renew(entry);
    }
  }

  connectors(linkId: string, options?: ErpRequestOptions): Promise<readonly ConnectorSummary[]> {
    return this.#use(linkId, (token) => this.#client.connectors(token, options));
  }

  schema(
    linkId: string,
    connectorId: string,
    options?: ErpRequestOptions,
  ): Promise<ConnectorSchema> {
    return this.#use(linkId, (token) => this.#client.schema(token, connectorId, options));
  }

  query(
    linkId: string,
    connectorId: string,
    request: QueryRequest,
    options?: ErpQueryOptions,
  ): Promise<QueryResponse> {
    return this.#use(linkId, (token) => this.#client.query(token, connectorId, request, options));
  }

  /** The states only: what serialising this object shows. */
  toJSON(): Record<string, ErpSessionState> {
    return Object.fromEntries([...this.#entries.keys()].map((id) => [id, this.state(id)]));
  }

  // -------------------------------------------------------------------------------------------

  async #use<T>(linkId: string, send: (token: string) => Promise<T>): Promise<T> {
    const entry = this.#entries.get(linkId);
    if (entry?.state === 'connected' && this.#current(entry) === 'expired') this.#expire(entry);
    const state = entry?.state ?? 'none';
    if (!entry || state !== 'connected' || entry.token === null) {
      throw new ErpError(
        state === 'expired'
          ? 'session.expired'
          : state === 'revoked'
            ? 'link.revoked'
            : 'session.none',
      );
    }
    const generation = entry.generation;
    try {
      return await send(entry.token);
    } catch (error) {
      if (error instanceof ErpError && entry.generation === generation) this.#refused(entry, error);
      throw error;
    }
  }

  /** A refusal that ends the session here too. */
  #refused(entry: Entry, error: ErpError): void {
    if (error.code === 'session.expired') this.#close(entry, 'expired', error, false, false);
    else if (error.code === 'link.revoked') this.#close(entry, 'revoked', error, false, false);
  }

  #open(entry: Entry, session: ConnectSession): void {
    const { token, ...info } = session;
    const now = this.#now();
    // The ERP's times are read on its own clock: Redeem answered at `maxExpiresAt` less the
    // contract's ten hours. A device whose clock is wrong still keeps the session as long as
    // the ERP does.
    entry.offset = Date.parse(session.maxExpiresAt) - LIMITS.sessionMaxMs - now;
    entry.maxExpiresAt = Date.parse(session.maxExpiresAt) - entry.offset;
    entry.expiresAt = Math.min(Date.parse(session.expiresAt) - entry.offset, entry.maxExpiresAt);
    entry.token = token;
    entry.info = Object.freeze({ ...info, user: Object.freeze({ ...info.user }) });
    entry.renewAttemptAt = now;
    entry.renewDelay = RENEW_EVERY_MS;
    entry.renewing = false;
    entry.generation++;
    this.#schedule(entry);
    this.#set(entry, 'connected', null);
  }

  async #renew(entry: Entry): Promise<void> {
    const token = entry.token;
    if (token === null) return;
    const generation = entry.generation;
    entry.renewing = true;
    entry.renewAttemptAt = this.#now();
    try {
      const { expiresAt } = await this.#client.renew(token);
      if (entry.generation !== generation || entry.token === null) return;
      entry.expiresAt = Math.min(Date.parse(expiresAt) - entry.offset, entry.maxExpiresAt);
      entry.renewDelay = RENEW_EVERY_MS;
      if (entry.info) entry.info = Object.freeze({ ...entry.info, expiresAt });
      this.#schedule(entry);
    } catch (error) {
      if (entry.generation !== generation) return;
      const e = asErpError(error);
      entry.renewDelay = RENEW_RETRY_MS;
      this.#refused(entry, e);
    } finally {
      if (entry.generation === generation) entry.renewing = false;
    }
  }

  /** The state, with a session past its time read as expired; changes nothing. */
  #current(entry: Entry): ErpSessionState {
    return entry.state === 'connected' && this.#now() >= this.#deadline(entry)
      ? 'expired'
      : entry.state;
  }

  #deadline(entry: Entry): number {
    return Math.min(entry.expiresAt, entry.maxExpiresAt);
  }

  /** Marks the session expired when its time runs out, so the block says so unasked. */
  #schedule(entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const left = Math.max(0, this.#deadline(entry) - this.#now());
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entry.state !== 'connected') return;
      if (this.#now() >= this.#deadline(entry)) this.#expire(entry);
      else this.#schedule(entry);
    }, left + 1000);
    (entry.timer as { unref?: () => void }).unref?.();
  }

  #expire(entry: Entry): void {
    this.#close(entry, 'expired', null, false, false);
  }

  /** Forgets the session's token; sends End when asked and the session may still be open. */
  #close(
    entry: Entry,
    state: ErpSessionState,
    error: ErpError | null,
    keepalive: boolean,
    sendEnd = true,
  ): void {
    const token = entry.token;
    entry.token = null;
    entry.info = null;
    entry.renewing = false;
    entry.generation++;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (token !== null && sendEnd) this.#client.end(token, { keepalive }).catch(noop);
    if (entry.state !== state || entry.error !== error) this.#set(entry, state, error);
  }

  #set(entry: Entry, state: ErpSessionState, error: ErpError | null): void {
    const changed = entry.state !== state;
    entry.state = state;
    entry.error = error;
    if (!changed && error === null) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(entry.link.id, state);
      } catch {
        // A listener's failure is its own; the others still hear.
      }
    }
  }
}
