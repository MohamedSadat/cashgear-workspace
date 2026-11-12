// What this device keeps for offline use, as the interface shows it (M3.1; SYNC_DESIGN.md,
// Offline availability): the open workspace's pins and the pages whose document this device
// holds, read from the sync engine when they change (its `offline` events) and when the
// workspace switches, never per render; and whether the server is out of reach (offline or
// signed out), which is when the sidebar marks the pages that would not open.
import type { Id, PinRecord, SyncState } from '@cgw/workspace';
import type { WorkspaceSession } from '../session';
import type { Cloud } from './cloud';

/** The pin that keeps a page offline: its own, or a subtree pin of a page above it. */
export interface PinOf {
  pin: PinRecord;
  inherited: boolean;
}

/** States in which a page this device does not hold cannot be opened. */
const CUT: ReadonlySet<SyncState> = new Set(['offline', 'signedOut']);
/** `offline` events come once a pass while pinned pages are fetched: read them at most this often. */
const RELOAD_MS = 250;

export class OfflineState {
  private workspace: Id | null = null;
  private pins = new Map<Id, PinRecord>();
  private available: ReadonlySet<Id> = new Set();
  private cut = false;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;
  private again = false;
  private disposed = false;
  /** Pages in the mirror at the last look: a page made here (held at once) is read again. */
  private pageCount = -1;
  private readonly listeners = new Set<() => void>();
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly cloud: Cloud,
    private readonly session: WorkspaceSession,
  ) {
    this.offs.push(cloud.subscribe(() => this.statusChanged()));
    this.offs.push(session.onSwitch(() => void this.reload()));
    this.offs.push(session.mirror.subscribe(() => this.mirrorChanged()));
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const off of this.offs) off();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getRevision = () => this.revision;

  /**
   * What the tree marks: the pages this device holds, while the server is out of reach and the
   * open workspace syncs; null otherwise (nothing is marked). The same object until it changes,
   * so a component that reads it renders again only when the marks do.
   */
  marks = (): ReadonlySet<Id> | null => (this.cut && this.syncs() ? this.available : null);

  private syncs(): boolean {
    const workspace = this.session.current;
    return !!workspace && !workspace.localOnly && workspace.id === this.workspace;
  }

  private bump() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private statusChanged() {
    const cut = this.cloud.account !== undefined && CUT.has(this.cloud.status.state);
    if (cut === this.cut) return;
    this.cut = cut;
    this.bump();
  }

  /**
   * The records changed: a workspace may have arrived or gone, or (offline) a page been made here,
   * which this device holds from its first keystroke. Not on every change: titles change as typed.
   */
  private mirrorChanged() {
    if (this.session.workspaceId !== this.workspace) return void this.reload();
    const count = this.session.mirror.pages.size;
    if (count === this.pageCount) return;
    this.pageCount = count;
    if (this.cut && this.workspace) this.changed(this.workspace);
  }

  /** The engine's `offline` event: pins or held pages of a workspace changed. */
  changed(workspaceId: Id) {
    if (workspaceId !== this.session.workspaceId || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, RELOAD_MS);
  }

  /** Reads the open workspace's pins and held pages again (one read at a time). */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.again = false;
        const workspaceId = this.session.workspaceId;
        const workspace = workspaceId ? this.session.mirror.workspaces.get(workspaceId) : undefined;
        try {
          const [pins, available] =
            workspace && !workspace.localOnly
              ? await Promise.all([
                  this.session.store.pins(workspace.id),
                  this.cloud.engine.availableOffline(workspace.id),
                ])
              : [[], new Set<Id>()];
          if (this.disposed) return;
          const pinsChanged =
            pins.length !== this.pins.size ||
            pins.some((pin) => {
              const old = this.pins.get(pin.pageId);
              return !old || old.subtree !== pin.subtree;
            });
          const availableChanged =
            available.size !== this.available.size ||
            [...available].some((id) => !this.available.has(id));
          if (!pinsChanged && !availableChanged && workspaceId === this.workspace) continue;
          this.workspace = workspaceId;
          this.pageCount = this.session.mirror.pages.size;
          if (pinsChanged) this.pins = new Map(pins.map((pin) => [pin.pageId, pin]));
          // Kept the same object when unchanged, so what reads `marks` renders again only on change.
          if (availableChanged) this.available = available;
          this.bump();
        } catch (error) {
          console.warn('Could not read what is kept offline:', error);
        }
      } while (this.again && !this.disposed);
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  /** The open workspace's pins, as last read. */
  pinList(): PinRecord[] {
    return [...this.pins.values()];
  }

  isAvailable(pageId: Id): boolean {
    return this.available.has(pageId);
  }

  /** The page's own pin, else the nearest subtree pin above it; null if none. */
  pinOf(pageId: Id): PinOf | null {
    const own = this.pins.get(pageId);
    if (own) return { pin: own, inherited: false };
    const ancestors = this.session.mirror.ancestors(pageId);
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const pin = this.pins.get(ancestors[i].id);
      if (pin?.subtree) return { pin, inherited: true };
    }
    return null;
  }

  async pin(pageId: Id, subtree: boolean): Promise<void> {
    await this.cloud.engine.pin(pageId, subtree);
    await this.reload();
  }

  async unpin(pageId: Id): Promise<void> {
    await this.cloud.engine.unpin(pageId);
    await this.reload();
  }
}
