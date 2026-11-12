// The app's connection to the Workspace API (Phase 2): the typed client, signed in by the
// platform's own means (the API's cookie in a browser, a bearer token from the native side on the
// desktop), and the sync engine that keeps this device's store and the server in step. The
// workspace layer does the syncing; this wires it to the session and the interface.
//
// Phase 3: signed in while offline (the account last signed in here, kept by the engine, when the
// server cannot be reached at start), what is kept offline (offline.ts), recovered pages
// (recovery.ts), pages this device does not hold fetched when opened, and what an open document
// reports (a move conflict, updates still pending).
import type { DocEvent, DocJSON } from '@cgw/doc';
import { NetworkError, createApi, getSigned, type ApiClient } from '@cgw/api';
import {
  OfflineError,
  SyncEngine,
  SyncHttpError,
  httpSyncApi,
  type Account,
  type DocCodec,
  type Id,
  type SyncApi,
  type SyncEvent,
  type SyncStatus,
} from '@cgw/workspace';
import type { DatabaseSync } from '../database/host';
import type { CloudPlatform } from '../platform';
import { NotOnDeviceError, type WorkspaceSession } from '../session';
import { OfflineState } from './offline';
import { Recovery } from './recovery';

export type CloudNotice = {
  code: string;
  pageId?: Id;
  workspaceId?: Id;
  /** `doc.moveConflict`: the block, and `editLost` or `movedTwice`. */
  blockId?: string;
  reason?: string;
};

export interface CloudOptions {
  /** A recovered page's title from the original's, in the interface language. */
  recoveredTitle?: (title: string) => string;
}

/** How long the first "who is signed in" may take before the app goes on as offline. */
const ACCOUNT_CHECK_MS = 5000;

/** The server could not be reached, or could not answer now (the loop retries those). */
export const unreachable = (error: unknown) =>
  error instanceof OfflineError ||
  error instanceof NetworkError ||
  error instanceof TypeError ||
  (error instanceof SyncHttpError && (error.status >= 500 || error.status === 429));

/** The answer's data, or a SyncHttpError with the server's code. */
async function data<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const result = await request;
  if (result.response.ok) return result.data as T;
  const body = result.error as { code?: string; title?: string } | undefined;
  throw new SyncHttpError(
    result.response.status,
    body?.code ?? 'server.error',
    body?.title ?? result.response.statusText,
  );
}

export class Cloud {
  readonly api: ApiClient;
  readonly sync: SyncApi;
  readonly engine: SyncEngine;
  readonly offline: OfflineState;
  readonly recovery: Recovery;
  private account_: Account | null = null;
  private checked = false;
  /** The server said who is signed in, this session (else the account is the cached one). */
  private verified = false;
  private usingCached = false;
  private refreshing: Promise<Account | null> | null = null;
  private firstCheckDone!: () => void;
  /** Resolves once the first check has answered, or the app went on without it. */
  private readonly firstCheck = new Promise<void>((done) => (this.firstCheckDone = done));
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: CloudNotice) => void>();
  private readonly memberListeners = new Set<(workspaceId: Id) => void>();
  private offEngine: (() => void) | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    readonly platform: CloudPlatform,
    private readonly session: WorkspaceSession,
    codec: DocCodec,
    options: CloudOptions = {},
  ) {
    const auth = platform.auth;
    this.api = createApi({
      baseUrl: platform.apiBase,
      auth:
        auth.kind === 'cookie' ? { kind: 'cookie' } : { kind: 'bearer', token: () => auth.token() },
    });
    this.sync = httpSyncApi(this.api);
    this.engine = new SyncEngine(session.store, this.sync, codec);
    this.offEngine = this.engine.on((event) => this.onEngine(event));
    // A 401 pauses the engine (the session ended elsewhere): the app is signed out until the
    // person signs in again; nothing local is touched, and the status counts what waits.
    this.cleanups.push(
      this.engine.onStatus((status) => {
        if (status.state === 'signedOut' && this.account_ && !this.engine.signedIn) {
          this.account_ = null;
          this.emit();
        }
        // Started offline with the cached account, and the server answers now: who is signed in
        // is asked once, as at a start online.
        if (status.state === 'synced' && this.usingCached && !this.verified)
          void this.refreshAccount();
      }),
    );
    session.connect({
      clientIdFor: (workspaceId) => this.engine.clientIdFor(workspaceId),
      pullPage: (pageId) => (this.account_ ? this.engine.pullPage(pageId) : Promise.resolve()),
      changed: () => this.engine.changed(),
      // A workspace made while signed in goes to the account at once.
      created: (workspaceId) => {
        if (this.account_)
          void this.upload(workspaceId).catch((error: unknown) =>
            console.warn('Upload failed:', error),
          );
      },
      fetchMissing: (pageId) => this.fetchMissing(pageId),
      docEvent: (event) => this.onDocEvent(event),
    });
    this.session.remoteAssets = (assetId) => this.fetchAsset(assetId);
    this.session.remotePreview = (url) => this.preview(url);
    this.session.remoteSearch = (q, limit) => this.search(q, limit);
    this.offline = new OfflineState(this, session);
    this.recovery = new Recovery(
      session,
      options.recoveredTitle ?? ((title) => `Recovered: ${title}`),
    );
    this.cleanups.push(() => this.offline.dispose());
    void this.offline.reload();
    // Entries set aside in an earlier session become pages now, network or not.
    void this.recovery.run();
  }

  /** Who is signed in, or null; undefined until the first check has answered. */
  get account(): Account | null | undefined {
    return this.checked ? this.account_ : undefined;
  }

  get status(): SyncStatus {
    return this.engine.status;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const off = this.engine.onStatus(listener);
    return () => {
      this.listeners.delete(listener);
      off();
    };
  };

  onNotice(listener: (notice: CloudNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => void this.noticeListeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  notify(notice: CloudNotice) {
    for (const listener of this.noticeListeners) listener(notice);
  }

  private onEngine(event: SyncEvent) {
    switch (event.kind) {
      case 'mirror':
        void this.session.reloadMirror();
        break;
      case 'doc':
        this.session.applyRemoteDoc(event.pageId, event.updates);
        break;
      case 'docReset':
        this.session.resetDoc(event.pageId);
        break;
      case 'notice':
        this.notify({ code: event.code, pageId: event.pageId, workspaceId: event.workspaceId });
        break;
      case 'members':
        for (const listener of this.memberListeners) listener(event.workspaceId);
        this.emit();
        break;
      case 'rows':
        // A held database's rows (or its hold) changed: the mirror reads them again.
        this.session.rowsChanged(event.databaseId);
        break;
      case 'recover':
        void this.recovery.run();
        break;
      case 'offline':
        this.offline.changed(event.workspaceId);
        break;
    }
  }

  /** What an open page's document reports. */
  private onDocEvent(event: DocEvent) {
    const page = this.session.record(event.pageId);
    const syncs =
      !!page && this.session.mirror.workspaces.get(page.workspaceId)?.localOnly === false;
    switch (event.kind) {
      case 'stillPending':
        // Something is missing on this device: its state is checked against the server's soon.
        if (this.account_ && syncs) this.engine.suspect(event.pageId);
        break;
      case 'notice':
        this.notify({
          code: event.code,
          pageId: event.pageId,
          workspaceId: page?.workspaceId,
          blockId: event.blockId,
          reason: event.reason,
        });
        break;
      case 'quarantined':
        console.warn(`Updates of page ${event.pageId} did not decode and were set aside.`);
        break;
    }
  }

  /** Asks the server who is signed in, then starts (or pauses) the loop. */
  async start(): Promise<void> {
    // A network that neither answers nor fails holds only the check, not the loop.
    await Promise.race([this.refreshAccount(), this.firstCheck]);
    this.engine.start();
    // Back online after a start without the server: who is signed in is asked again first.
    const kick = () => (this.verified ? this.engine.kick(0) : void this.refreshAccount());
    const visible = () => document.visibilityState === 'visible' && kick();
    window.addEventListener('online', kick);
    window.addEventListener('focus', kick);
    document.addEventListener('visibilitychange', visible);
    this.cleanups.push(() => {
      window.removeEventListener('online', kick);
      window.removeEventListener('focus', kick);
      document.removeEventListener('visibilitychange', visible);
    });
  }

  /**
   * Who is signed in, from the server. With no network (or no answer within a few seconds, or a
   * server that cannot answer now), the app goes on signed in as the account last signed in on
   * this device, offline: its changes are kept and counted, and they sync when the server answers.
   * Only the server saying nobody is signed in (or a 401) signs the app out.
   */
  refreshAccount(): Promise<Account | null> {
    this.refreshing ??= this.checkAccount().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async checkAccount(): Promise<Account | null> {
    let answered = false;
    const fallback = setTimeout(() => {
      if (!answered) void this.useCached();
    }, ACCOUNT_CHECK_MS);
    try {
      let account: Account | null;
      try {
        account = await this.sync.me();
      } catch (error) {
        if (!(error instanceof SyncHttpError && error.status === 401)) throw error;
        account = null;
      }
      answered = true;
      this.verified = true;
      this.usingCached = false;
      this.account_ = account;
      this.checked = true;
      this.api.resetCsrf();
      this.engine.setAccount(account);
      this.emit();
      return account;
    } catch (error) {
      answered = true;
      if (!unreachable(error)) console.warn('The account check failed:', error);
      return await this.useCached();
    } finally {
      clearTimeout(fallback);
      this.firstCheckDone();
    }
  }

  /** Signed in as the cached account, offline (never `setAccount(null)`: that forgets it). */
  private async useCached(): Promise<Account | null> {
    if (this.verified) return this.account_;
    if (!this.usingCached) {
      const cached = await this.engine.cachedAccount().catch(() => null);
      if (this.verified) return this.account_;
      this.usingCached = true;
      this.account_ = cached;
      if (cached) this.engine.setAccount(cached, { offline: true });
    }
    this.checked = true;
    this.firstCheckDone();
    this.emit();
    return this.account_;
  }

  /**
   * A page this device holds nothing of, being opened: pulled now, while the opener waits. Throws
   * NotOnDeviceError when it cannot be: offline, or nobody signed in.
   */
  private async fetchMissing(pageId: Id): Promise<boolean> {
    const page = this.session.record(pageId);
    const workspace = page && this.session.mirror.workspaces.get(page.workspaceId);
    if (!page || !workspace || workspace.localOnly) return false;
    await this.firstCheck;
    if (!this.account_) throw new NotOnDeviceError(pageId, 'signedOut');
    const offline = () => this.engine.status.state === 'offline';
    // Known to be offline: no request the network cannot carry (its return opens the page).
    if (offline()) throw new NotOnDeviceError(pageId, 'offline');
    try {
      await this.engine.pullPage(pageId);
      if (!(await this.session.store.docCursor(pageId))) {
        // Before the first pass knows the workspace syncs, the engine pulls the page in a pass.
        await this.engine.syncNow();
        if (offline()) throw new NotOnDeviceError(pageId, 'offline');
      }
    } catch (error) {
      if (unreachable(error)) throw new NotOnDeviceError(pageId, 'offline');
      throw error;
    }
    return true;
  }

  /**
   * A page's document as the worker derived it (ProseMirror JSON), for a page saved by a newer
   * build that this device does not hold: shown read-only, never stored.
   */
  async docJson(pageId: Id): Promise<DocJSON> {
    const answer = await data(
      this.api.GET('/api/v1/pages/{pageId}/doc/json', { params: { path: { pageId } } }),
    );
    return JSON.parse(answer.json) as DocJSON;
  }

  /**
   * Signs in: in a browser, the API's sign-in page, which comes back here with the session
   * cookie; on the desktop, the system browser, back to the app's loopback listener.
   */
  async signIn(language: 'en' | 'ar'): Promise<void> {
    const auth = this.platform.auth;
    if (auth.kind === 'cookie') {
      const back = encodeURIComponent(location.href);
      location.assign(`${this.api.baseUrl}/account/signin?lang=${language}&returnUrl=${back}`);
      return;
    }
    if (await auth.signIn(language)) await this.refreshAccount();
  }

  /** Signs this device out at the server; what is on this device stays on it. */
  async signOut(): Promise<void> {
    const auth = this.platform.auth;
    try {
      if (auth.kind === 'cookie') await data(this.api.POST('/api/v1/account/signout'));
      else {
        const deviceId = this.account_?.deviceId;
        if (deviceId)
          await data(
            this.api.DELETE('/api/v1/account/devices/{id}', { params: { path: { id: deviceId } } }),
          ).catch(() => undefined);
        await auth.signOut();
      }
    } finally {
      this.account_ = null;
      this.verified = true;
      this.usingCached = false;
      this.engine.setAccount(null);
      this.api.resetCsrf();
      this.emit();
    }
  }

  /**
   * Deleting the account happens on the API's own page, which asks for the password again
   * (passwords are typed only there). In a browser the page comes back here signed out.
   */
  async deleteAccount(language: 'en' | 'ar'): Promise<void> {
    const back = encodeURIComponent(
      this.platform.kind === 'web' ? `${location.origin}${location.pathname}` : '',
    );
    const url = `${this.api.baseUrl}/account/delete?lang=${language}${back ? `&returnUrl=${back}` : ''}`;
    if (this.platform.kind === 'web') location.assign(url);
    else await this.platform.openExternal(url);
  }

  /** A local-only workspace goes to the account, intact (M2.3). */
  async upload(workspaceId: Id): Promise<void> {
    await this.session.flushAll();
    await this.engine.upload(workspaceId);
    await this.session.reloadMirror();
  }

  dispose() {
    this.engine.stop();
    this.offEngine?.();
    for (const cleanup of this.cleanups) cleanup();
  }

  // Databases (Phase 4) ------------------------------------------------------------------------------

  /** What the database views' host needs of the server (database/host.ts). */
  databaseSync(): DatabaseSync {
    return {
      online: () => {
        const state = this.engine.status.state;
        return !!this.account_ && state !== 'offline' && state !== 'signedOut';
      },
      account: () => this.account_,
      holdDatabase: (databaseId) => this.engine.holdDatabase(databaseId),
      queryDatabase: (databaseId, request) => this.engine.queryDatabase(databaseId, request),
      peekQuery: (databaseId, request) => this.sync.query(databaseId, request),
      members: async (workspaceId) =>
        (await this.members(workspaceId)).map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          email: m.email,
        })),
      syncNow: () => this.engine.syncNow(),
      importCsv: async (databaseId, request) => {
        const answer = await data(
          this.api.POST('/api/v1/databases/{databaseId}/import', {
            params: { path: { databaseId } },
            // A column not imported is null (contract section 4); the generated schema
            // writes the items as strings only.
            body: {
              csv: request.csv,
              columns: request.columns as string[],
              header: request.header,
            },
          }),
        );
        return {
          created: Number(answer.created),
          problems: answer.problems.map((p) => ({ line: Number(p.line), message: p.message })),
        };
      },
      exportCsv: async (databaseId, viewId, context) => {
        const answer = await this.api.GET('/api/v1/databases/{databaseId}/export', {
          params: {
            path: { databaseId },
            query: { viewId, today: context.today, offsetMinutes: context.offsetMinutes },
          },
          // The bytes as written (a BOM first, for spreadsheets), not decoded text.
          parseAs: 'arrayBuffer',
        });
        if (!answer.response.ok) {
          const body = answer.error as { code?: string; title?: string } | undefined;
          throw new SyncHttpError(
            answer.response.status,
            body?.code ?? 'server.error',
            body?.title ?? answer.response.statusText,
          );
        }
        return new Uint8Array(answer.data as unknown as ArrayBuffer);
      },
      subscribe: (listener) => this.subscribe(listener),
      onMembers: (listener) => {
        this.memberListeners.add(listener);
        return () => void this.memberListeners.delete(listener);
      },
    };
  }

  // Devices --------------------------------------------------------------------------------------

  devices() {
    return data(this.api.GET('/api/v1/account/devices'));
  }

  async revokeDevice(id: Id) {
    await data(this.api.DELETE('/api/v1/account/devices/{id}', { params: { path: { id } } }));
    if (id === this.account_?.deviceId) await this.refreshAccount();
  }

  // Members and invites ----------------------------------------------------------------------------

  members(workspaceId: Id) {
    return data(
      this.api.GET('/api/v1/workspaces/{workspaceId}/members', {
        params: { path: { workspaceId } },
      }),
    );
  }

  setRole(workspaceId: Id, userId: Id, role: string) {
    return data(
      this.api.PATCH('/api/v1/workspaces/{workspaceId}/members/{userId}', {
        params: { path: { workspaceId, userId } },
        body: { role },
      }),
    );
  }

  removeMember(workspaceId: Id, userId: Id) {
    return data(
      this.api.DELETE('/api/v1/workspaces/{workspaceId}/members/{userId}', {
        params: { path: { workspaceId, userId } },
      }),
    );
  }

  invite(workspaceId: Id, email: string, role: string) {
    return data(
      this.api.POST('/api/v1/workspaces/{workspaceId}/invites', {
        params: { path: { workspaceId } },
        body: { email, role },
      }),
    );
  }

  invites(workspaceId: Id) {
    return data(
      this.api.GET('/api/v1/workspaces/{workspaceId}/invites', {
        params: { path: { workspaceId } },
      }),
    );
  }

  revokeInvite(workspaceId: Id, inviteId: Id) {
    return data(
      this.api.DELETE('/api/v1/workspaces/{workspaceId}/invites/{inviteId}', {
        params: { path: { workspaceId, inviteId } },
      }),
    );
  }

  async acceptInvite(token: string) {
    // In the body: a path is written to request logs, a body is not.
    const workspace = await data(this.api.POST('/api/v1/invites/accept', { body: { token } }));
    this.engine.kick(0);
    return workspace;
  }

  // Sharing (M2.6) ----------------------------------------------------------------------------------

  permissions(pageId: Id) {
    return data(
      this.api.GET('/api/v1/pages/{pageId}/permissions', { params: { path: { pageId } } }),
    );
  }

  setPermissions(
    pageId: Id,
    body: {
      restricted: boolean;
      entries: { principalType: string; principalId: Id; level: string }[];
    },
  ) {
    return data(
      this.api.PUT('/api/v1/pages/{pageId}/permissions', { params: { path: { pageId } }, body }),
    );
  }

  shareLinks(pageId: Id) {
    return data(
      this.api.GET('/api/v1/pages/{pageId}/share-links', { params: { path: { pageId } } }),
    );
  }

  createShareLink(pageId: Id, expiresInDays = 30) {
    return data(
      this.api.POST('/api/v1/pages/{pageId}/share-links', {
        params: { path: { pageId } },
        body: { expiresInDays },
      }),
    );
  }

  revokeShareLink(pageId: Id, linkId: Id) {
    return data(
      this.api.DELETE('/api/v1/pages/{pageId}/share-links/{linkId}', {
        params: { path: { pageId, linkId } },
      }),
    );
  }

  /** The address a share link opens: the web app's, wherever this app runs. */
  shareUrl(token: string): string {
    const web =
      this.platform.kind === 'web'
        ? `${location.origin}${location.pathname}`
        : (this.platform.webBase ?? 'https://workspace.cashgearerp.com/');
    return `${web.replace(/\/?$/, '/')}#/s/${token}`;
  }

  // Versions (M2.7) ----------------------------------------------------------------------------------

  versions(pageId: Id) {
    return data(this.api.GET('/api/v1/pages/{pageId}/versions', { params: { path: { pageId } } }));
  }

  /** A version of the page as this device has it: its last edits are sent first. */
  async nameVersion(pageId: Id, name: string | null, kind: 'named' | 'preRestore' = 'named') {
    await this.engine.syncNow();
    return data(
      this.api.POST('/api/v1/pages/{pageId}/versions', {
        params: { path: { pageId } },
        body: { name, kind },
      }),
    );
  }

  /** A version's state, by its signed URL once the worker has written it. */
  async versionBytes(pageId: Id, versionId: Id): Promise<Uint8Array | null> {
    const version = await data(
      this.api.GET('/api/v1/pages/{pageId}/versions/{versionId}', {
        params: { path: { pageId, versionId } },
      }),
    );
    if (!version.url) return null;
    const response = await getSigned(version.url);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  }

  hardRestore(pageId: Id, versionId: Id) {
    return data(
      this.api.POST('/api/v1/pages/{pageId}/versions/{versionId}/restore', {
        params: { path: { pageId, versionId } },
        body: { mode: 'hard' },
      }),
    );
  }

  // Export from the server (Phase 3) -----------------------------------------------------------------

  /**
   * The workspace's export as the server makes it (owners and admins): every page the requester
   * may read, written by the worker; asked for, waited on, then read by its signed URL.
   */
  async exportWorkspace(
    workspaceId: Id,
    { timeoutMs = 120_000, pollMs = 1000 }: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<Uint8Array> {
    let current = await data(
      this.api.POST('/api/v1/workspaces/{workspaceId}/exports', {
        params: { path: { workspaceId } },
      }),
    );
    const deadline = Date.now() + timeoutMs;
    while (current.status === 'pending') {
      if (Date.now() > deadline) throw new Error('The export is taking too long');
      await new Promise((done) => setTimeout(done, pollMs));
      current = await data(
        this.api.GET('/api/v1/exports/{exportId}', { params: { path: { exportId: current.id } } }),
      );
    }
    if (current.status !== 'ready' || !current.url) throw new Error('The export failed');
    const response = await getSigned(current.url);
    if (!response.ok) throw new Error('The export could not be read');
    return new Uint8Array(await response.arrayBuffer());
  }

  // Search (M2.7) ------------------------------------------------------------------------------------

  /** Server search over every page this account may read in the workspace, normalised alike. */
  async search(q: string, limit: number) {
    const workspace = this.session.current;
    if (!this.account_ || !workspace || workspace.localOnly) return [];
    try {
      const answer = await data(
        this.api.GET('/api/v1/workspaces/{workspaceId}/search', {
          params: { path: { workspaceId: workspace.id }, query: { q, limit } },
        }),
      );
      return answer.hits.map((hit) => ({
        pageId: hit.pageId,
        title: hit.title,
        snippet: hit.snippet,
        score: Number(hit.score),
      }));
    } catch {
      return [];
    }
  }

  // Assets and previews ----------------------------------------------------------------------------

  /** An asset's bytes from the server, by a fresh signed URL (a device that did not upload it). */
  async assetBytes(assetId: Id): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const url = await data(
        this.api.GET('/api/v1/assets/{assetId}/url', { params: { path: { assetId } } }),
      );
      const response = await getSigned(url.url);
      if (!response.ok) return null;
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: url.contentType };
    } catch {
      return null;
    }
  }

  /**
   * An asset this device does not hold, from the server: its record (for name, size and type)
   * and its bytes, kept in the local store as uploaded so it opens offline next time.
   */
  async fetchAsset(assetId: Id): Promise<Uint8Array | null> {
    if (!this.account_) return null;
    try {
      const record = await this.asset(assetId);
      const got = await this.assetBytes(assetId);
      if (!got) return null;
      const workspaceId = this.session.workspaceId;
      if (!workspaceId) return got.bytes;
      const asset = {
        id: record.id,
        workspaceId,
        fileName: record.fileName,
        contentType: record.contentType,
        sizeBytes: Number(record.sizeBytes),
        sha256: '',
        width: record.width === null || record.width === undefined ? null : Number(record.width),
        height:
          record.height === null || record.height === undefined ? null : Number(record.height),
        createdAt: record.createdAt,
        uploaded: true,
      };
      await this.session.store.putAsset(asset, got.bytes);
      this.session.mirror.putAsset(asset);
      return got.bytes;
    } catch {
      return null;
    }
  }

  asset(assetId: Id) {
    return data(this.api.GET('/api/v1/assets/{assetId}', { params: { path: { assetId } } }));
  }

  /** A bookmark's preview, for the open workspace if it syncs; null otherwise or when there is none. */
  async preview(url: string) {
    const workspace = this.session.current;
    if (!this.account_ || !workspace || workspace.localOnly) return null;
    try {
      const preview = await this.linkPreview(workspace.id, url);
      if (preview.status !== 'ok') return null;
      return {
        title: preview.title ?? null,
        description: preview.description ?? null,
        siteName: preview.siteName ?? null,
        imageAssetId: preview.imageAssetId ?? null,
      };
    } catch {
      return null;
    }
  }

  linkPreview(workspaceId: Id, url: string) {
    return data(
      this.api.GET('/api/v1/workspaces/{workspaceId}/link-preview', {
        params: { path: { workspaceId }, query: { url } },
      }),
    );
  }
}
