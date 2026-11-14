// The tab's ERP services (INTEGRATIONS.md, "Cash Gear ERP"): the workspace's links to ERP
// companies, read from Workspace's API and kept in memory; one `ErpSessions` for the tab, made the
// first time a block or the settings need it, over the build's two ERP origins (never one read
// from a link or a document); the connect flow (a pop-up opened inside the click in a browser,
// the system browser and the `cashgear-workspace://erp#…` return on the desktop); and whether ERP
// data can be used here at all. ERP answers never pass through here: the views ask the sessions.
import type { Account, Id } from '@cgw/workspace';
import {
  ErpSessions,
  RecordLinkError,
  createErpClient,
  deepLinkFlow,
  isErpDeepLink,
  popupFlow,
  type ActivityTarget,
  type ConnectFlow,
  type ErpAvailability,
  type ErpClient,
  type ErpConnection,
  type ErpLinkInfo,
  type ErpLinksState,
  type LinkRedeemResponse,
  type LinkableWorkspace,
} from '@cgw/erp';
import type { Cloud } from '../cloud/cloud';
import type { WorkspacePlatform } from '../platform';
import type { WorkspaceSession } from '../session';

/** What the ERP services need of Workspace's API (the cloud), so tests can stand in for it. */
export interface ErpCloud {
  /** Who is signed in; undefined while the first check runs. */
  account(): Account | null | undefined;
  subscribe(listener: () => void): () => void;
  listLinks(workspaceId: Id): Promise<ErpLinkInfo[]>;
  /** `created`, or `exists` for the same link already recorded. Throws a `RecordLinkError`. */
  createLink(
    workspaceId: Id,
    body: { erpLinkId: string; erpBaseUrl: string; company: string; companyName: string },
  ): Promise<'created' | 'exists'>;
  deleteLink(workspaceId: Id, linkId: Id): Promise<void>;
}

const adapters = new WeakMap<Cloud, ErpCloud>();

/** Workspace's erp-links routes (`listErpLinks`, `createErpLink`, `deleteErpLink`), one per cloud. */
export function cloudErp(cloud: Cloud): ErpCloud {
  let found = adapters.get(cloud);
  if (!found) adapters.set(cloud, (found = makeCloudErp(cloud)));
  return found;
}

function makeCloudErp(cloud: Cloud): ErpCloud {
  const list = async (workspaceId: Id): Promise<ErpLinkInfo[]> => {
    const answer = await cloud.api.GET('/api/v1/workspaces/{workspaceId}/erp-links', {
      params: { path: { workspaceId } },
    });
    if (!answer.response.ok || !answer.data)
      throw new Error(`erp-links: ${answer.response.status}`);
    return answer.data.links.map((link) => ({
      id: link.id,
      erpLinkId: link.erpLinkId,
      workspaceId,
      company: link.company,
      companyName: link.companyName,
      linkedBy: link.linkedBy ? { id: link.linkedBy.id, name: link.linkedBy.name } : null,
      linkedAt: link.linkedAt,
    }));
  };
  return {
    account: () => cloud.account,
    subscribe: (listener) => cloud.subscribe(listener),
    listLinks: list,
    async createLink(workspaceId, body) {
      let answer;
      try {
        answer = await cloud.api.POST('/api/v1/workspaces/{workspaceId}/erp-links', {
          params: { path: { workspaceId } },
          body,
        });
      } catch {
        throw new RecordLinkError('network');
      }
      const status = answer.response.status;
      if (answer.response.ok) return 'created';
      if (status === 409) {
        // One live link per company: the same ERP link is already here, or an earlier one is.
        const links = await list(workspaceId).catch(() => []);
        const same = links.find((link) => link.company === body.company);
        if (same?.erpLinkId === body.erpLinkId) return 'exists';
        throw new RecordLinkError('stale');
      }
      if (status === 403) throw new RecordLinkError('forbidden');
      if (status === 400) throw new RecordLinkError('invalid');
      throw new RecordLinkError('failed');
    },
    async deleteLink(workspaceId, linkId) {
      const answer = await cloud.api.DELETE('/api/v1/workspaces/{workspaceId}/erp-links/{linkId}', {
        params: { path: { workspaceId, linkId } },
      });
      if (!answer.response.ok) throw new Error(`erp-links: ${answer.response.status}`);
    },
  };
}

export interface ShellErpOptions {
  /** For tests: the ERP's fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** For tests: the connect flow (else the platform's). */
  flow?: ConnectFlow;
  /** Where the sessions hear activity and `pagehide`; the window by default. */
  target?: ActivityTarget | null;
  /** The clock, for tests. */
  now?: () => number;
}

interface LinkEntry {
  state: ErpLinksState;
  at: number;
  loading: Promise<void> | null;
}

const LOADING: ErpLinksState = Object.freeze({ status: 'loading' });
/** A block naming a link this tab does not know reads the list again at most this often. */
const RELOAD_MS = 30_000;

/** The pop-up's name and size: one ERP window, reused if the person asks again. */
const POPUP_NAME = 'cgw-erp-connect';
const POPUP_FEATURES = 'popup,width=520,height=720';

export class ShellErp implements ErpConnection {
  readonly connectKind: 'popup' | 'browser';
  private cloud: ErpCloud | null = null;
  private client_: ErpClient | null = null;
  private sessions_: ErpSessions | null = null;
  private readonly entries = new Map<Id, LinkEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly deepLinkListeners = new Set<(url: string) => void>();
  private online_ = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  private accountId: Id | null | undefined = undefined;
  private detach: (() => void) | null = null;
  private offCloud: (() => void) | null = null;
  private readonly now: () => number;

  constructor(
    private readonly session: WorkspaceSession,
    private readonly platform: WorkspacePlatform,
    private readonly options: ShellErpOptions = {},
  ) {
    this.connectKind = platform.kind === 'desktop' ? 'browser' : 'popup';
    this.now = options.now ?? Date.now;
  }

  /** Whether this build names the ERP's origins. */
  get configured(): boolean {
    return !!this.platform.erp?.apiBase && !!this.platform.erp.clientOrigin;
  }

  /** Workspace's API, once the app has it (signed in or not). */
  setCloud(cloud: ErpCloud | null): void {
    if (cloud === this.cloud) return;
    this.cloud = cloud;
    this.offCloud?.();
    this.offCloud = null;
    if (this.detach && cloud) this.offCloud = cloud.subscribe(this.onCloud);
    this.onCloud();
  }

  // ErpConnection ----------------------------------------------------------------------------------

  availability = (): ErpAvailability => {
    if (!this.cloud) return 'signedOut';
    const account = this.cloud.account();
    if (account === undefined) return 'checking';
    if (account === null) return 'signedOut';
    const workspace = this.session.current;
    if (!workspace) return 'noWorkspace';
    if (workspace.localOnly) return 'localWorkspace';
    return 'ready';
  };

  online = (): boolean => this.online_;

  links = (): ErpLinksState => {
    const id = this.session.workspaceId;
    return (id && this.entries.get(id)?.state) || LOADING;
  };

  loadLinks = (): void => {
    const id = this.session.workspaceId;
    if (!id || this.availability() !== 'ready') return;
    const entry = this.entries.get(id);
    if (entry && (entry.loading || entry.state.status !== 'loading')) return;
    void this.fetchLinks(id);
  };

  reloadLinks = (): void => {
    const id = this.session.workspaceId;
    if (!id || this.availability() !== 'ready') return;
    const entry = this.entries.get(id);
    if (entry?.loading) return;
    if (entry?.state.status === 'ready' && this.now() - entry.at < RELOAD_MS) return;
    void this.fetchLinks(id);
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.detach) this.attach();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.detach?.();
        this.detach = null;
      }
    };
  };

  // Sessions ---------------------------------------------------------------------------------------

  /** The ERP API's client over the build's origin. */
  client(): ErpClient {
    const erp = this.platform.erp;
    if (!erp) throw new Error('This build names no Cash Gear ERP.');
    return (this.client_ ??= createErpClient(erp.apiBase, this.options.fetch));
  }

  /** The tab's sessions, made the first time they are needed. */
  sessions(): ErpSessions {
    return (this.sessions_ ??= new ErpSessions({
      client: this.client(),
      flow: this.options.flow ?? this.flow(),
      ...(this.options.target !== undefined ? { target: this.options.target } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    }));
  }

  /** The sessions if any were made. */
  peekSessions(): ErpSessions | null {
    return this.sessions_;
  }

  private flow(): ConnectFlow {
    const erp = this.platform.erp!;
    if (this.platform.kind === 'desktop')
      return deepLinkFlow({
        clientUrl: erp.clientOrigin,
        openExternal: (url) => this.platform.openExternal(url),
        onDeepLink: (listener) => {
          this.deepLinkListeners.add(listener);
          return () => void this.deepLinkListeners.delete(listener);
        },
      });
    // Opened inside the click, with its opener (no `noopener`): the ERP client posts the ticket to
    // it. The app sends no Cross-Origin-Opener-Policy, which would cut that tie.
    return popupFlow({
      clientOrigin: erp.clientOrigin,
      open: (url) => window.open(url, POPUP_NAME, POPUP_FEATURES),
    });
  }

  /**
   * A desktop deep link the shell takes before any route: the ERP's return
   * (`cashgear-workspace://erp#ticket=…&state=…`) goes to the waiting connect, never to the
   * router or the history. True when it was the ERP's.
   */
  takeDeepLink(url: string): boolean {
    if (!isErpDeepLink(url)) return false;
    for (const listener of [...this.deepLinkListeners]) listener(url);
    return true;
  }

  // Links ------------------------------------------------------------------------------------------

  /** `WorkspaceLink/Redeem` at the ERP, for the link screen. */
  redeemLink(ticket: string, workspace: LinkableWorkspace): Promise<LinkRedeemResponse> {
    return this.client().redeemLink(ticket, workspace.id, workspace.name);
  }

  /** Records the ERP's link at Workspace (`createErpLink`), then reads the list again. */
  async recordLink(workspaceId: Id, link: LinkRedeemResponse): Promise<'created' | 'exists'> {
    if (!this.cloud) throw new RecordLinkError('network');
    const outcome = await this.cloud.createLink(workspaceId, {
      erpLinkId: link.linkId,
      erpBaseUrl: this.client().apiBase,
      company: link.company,
      companyName: link.companyName,
    });
    await this.fetchLinks(workspaceId);
    return outcome;
  }

  /** Unlinks here (`deleteErpLink`); the ERP's own record stays until its admin ends it. */
  async unlink(link: ErpLinkInfo): Promise<void> {
    if (!this.cloud) throw new Error('Not connected to Workspace.');
    await this.cloud.deleteLink(link.workspaceId, link.id);
    this.sessions_?.disconnect(link.id);
    await this.fetchLinks(link.workspaceId);
  }

  dispose(): void {
    this.sessions_?.dispose();
    this.sessions_ = null;
    this.detach?.();
    this.detach = null;
    this.offCloud?.();
    this.offCloud = null;
    this.listeners.clear();
    this.deepLinkListeners.clear();
  }

  // ------------------------------------------------------------------------------------------------

  private async fetchLinks(workspaceId: Id): Promise<void> {
    const cloud = this.cloud;
    if (!cloud) return;
    const entry: LinkEntry = this.entries.get(workspaceId) ?? {
      state: LOADING,
      at: 0,
      loading: null,
    };
    this.entries.set(workspaceId, entry);
    const task = (async () => {
      try {
        const links = await cloud.listLinks(workspaceId);
        entry.state = Object.freeze({ status: 'ready', links: Object.freeze(links) });
        entry.at = this.now();
      } catch {
        // A list read before stays: it is what this tab last knew.
        if (entry.state.status !== 'ready') entry.state = Object.freeze({ status: 'failed' });
      } finally {
        entry.loading = null;
      }
    })();
    entry.loading = task;
    if (entry.state.status === 'failed') entry.state = LOADING;
    this.emit();
    await task;
    // Another account may have signed in meanwhile: its list is read afresh.
    if (this.entries.get(workspaceId) === entry) this.emit();
  }

  private attach() {
    const onOnline = () => {
      if (this.online_) return;
      this.online_ = true;
      this.emit();
    };
    const onOffline = () => {
      if (!this.online_) return;
      this.online_ = false;
      this.emit();
    };
    const hasWindow = typeof window !== 'undefined';
    if (hasWindow) {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    }
    const offSwitch = this.session.onSwitch(() => this.emit());
    const offMirror = this.session.mirror.subscribe(() => this.emit());
    if (this.cloud) this.offCloud = this.cloud.subscribe(this.onCloud);
    this.detach = () => {
      if (hasWindow) {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
      offSwitch();
      offMirror();
      this.offCloud?.();
      this.offCloud = null;
    };
  }

  private readonly onCloud = () => {
    const account = this.cloud?.account();
    const id = account === undefined ? undefined : (account?.id ?? null);
    if (id !== this.accountId) {
      // Another person, or nobody: what the last one could see is forgotten, sessions too.
      if (this.accountId !== undefined) {
        this.entries.clear();
        this.sessions_?.endAll({ keepalive: true });
      }
      this.accountId = id;
    }
    this.emit();
  };

  private emit() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

const held = new WeakMap<WorkspaceSession, ShellErp>();

/** The tab's ERP services: one per session (a tab has one), made the first time they are asked. */
export function erpServices(session: WorkspaceSession, platform: WorkspacePlatform): ShellErp {
  let found = held.get(session);
  if (!found) {
    found = new ShellErp(session, platform);
    held.set(session, found);
  }
  return found;
}
