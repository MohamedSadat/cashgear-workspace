// The app's connection to the Workspace API (Phase 2): the typed client, signed in by the
// platform's own means (the API's cookie in a browser, a bearer token from the native side on the
// desktop), and the sync engine that keeps this device's store and the server in step. The
// workspace layer does the syncing; this wires it to the session and the interface.
import { createApi, getSigned, type ApiClient } from '@cgw/api';
import {
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
import type { CloudPlatform } from '../platform';
import type { WorkspaceSession } from '../session';

export type CloudNotice = { code: string; pageId?: Id; workspaceId?: Id };

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
  private account_: Account | null = null;
  private checked = false;
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: CloudNotice) => void>();
  private offEngine: (() => void) | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    readonly platform: CloudPlatform,
    private readonly session: WorkspaceSession,
    codec: DocCodec,
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
    session.connect({
      clientIdFor: (workspaceId) => this.engine.clientIdFor(workspaceId),
      pullPage: (pageId) => (this.account_ ? this.engine.pullPage(pageId) : Promise.resolve()),
      changed: () => this.engine.kick(),
      // A workspace made while signed in goes to the account at once.
      created: (workspaceId) => {
        if (this.account_)
          void this.upload(workspaceId).catch((error: unknown) =>
            console.warn('Upload failed:', error),
          );
      },
    });
    this.session.remoteAssets = (assetId) => this.fetchAsset(assetId);
    this.session.remotePreview = (url) => this.preview(url);
    this.session.remoteSearch = (q, limit) => this.search(q, limit);
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
        this.emit();
        break;
    }
  }

  /** Asks the server who is signed in, then starts (or pauses) the loop. */
  async start(): Promise<void> {
    await this.refreshAccount();
    this.engine.start();
    const kick = () => this.engine.kick(0);
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

  async refreshAccount(): Promise<Account | null> {
    let account: Account | null;
    try {
      account = await this.sync.me();
    } catch {
      // Offline or the server is down: signed-out until it answers, nothing local is touched.
      account = null;
    }
    this.account_ = account;
    this.checked = true;
    this.api.resetCsrf();
    this.engine.setAccount(account);
    this.emit();
    return account;
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

  nameVersion(pageId: Id, name: string | null, kind: 'named' | 'preRestore' = 'named') {
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
