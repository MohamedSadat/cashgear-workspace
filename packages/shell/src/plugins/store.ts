// A workspace's third-party plugins as this tab knows them (Phase 10): the server's list, read
// once a page of the workspace is open (and again after Settings changes it, after a frame's
// address is refused, and when the server can be reached again after a failed read), kept in
// memory only. One store per connection; every read is the same object until it changes.
import type { Id } from '@cgw/workspace';
import { PluginRequestError, type PluginApi, type WorkspacePlugin } from './api';

export type PluginListState =
  | { status: 'idle' }
  | { status: 'loading'; plugins: readonly WorkspacePlugin[] | null }
  | { status: 'ready'; plugins: readonly WorkspacePlugin[] }
  | { status: 'failed'; plugins: readonly WorkspacePlugin[] | null; code: string };

/** One frozen object: a snapshot must be the same object until it changes (Phase 7's lesson). */
const IDLE: PluginListState = Object.freeze({ status: 'idle' as const });

export class PluginsStore {
  private readonly states = new Map<Id, PluginListState>();
  private readonly reading = new Map<Id, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(readonly api: PluginApi) {}

  state(workspaceId: Id): PluginListState {
    return this.states.get(workspaceId) ?? IDLE;
  }

  /** The plugins known for the workspace, or null before the first answer. */
  plugins(workspaceId: Id): readonly WorkspacePlugin[] | null {
    const state = this.state(workspaceId);
    return 'plugins' in state ? state.plugins : null;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Reads the list, unless it was read (or `force`) or a read is under way. */
  load(workspaceId: Id, force = false): Promise<void> {
    const under = this.reading.get(workspaceId);
    if (under) return under;
    const state = this.state(workspaceId);
    if (!force && state.status === 'ready') return Promise.resolve();
    this.set(workspaceId, { status: 'loading', plugins: this.plugins(workspaceId) });
    const read = this.api.list(workspaceId).then(
      (plugins) => this.set(workspaceId, { status: 'ready', plugins: sorted(plugins) }),
      (error: unknown) =>
        this.set(workspaceId, {
          status: 'failed',
          plugins: this.plugins(workspaceId),
          code: error instanceof PluginRequestError ? error.code : 'server.error',
        }),
    );
    const done = read.finally(() => this.reading.delete(workspaceId));
    this.reading.set(workspaceId, done);
    return done;
  }

  /** A plugin added, updated, turned on or off (Settings): the list as it now is. */
  put(workspaceId: Id, plugin: WorkspacePlugin) {
    const others = (this.plugins(workspaceId) ?? []).filter(
      (p) => p.id !== plugin.id && p.type !== plugin.type,
    );
    this.set(workspaceId, { status: 'ready', plugins: sorted([...others, plugin]) });
  }

  /** A plugin removed (Settings). */
  drop(workspaceId: Id, pluginId: Id) {
    const kept = (this.plugins(workspaceId) ?? []).filter((p) => p.id !== pluginId);
    this.set(workspaceId, { status: 'ready', plugins: kept });
  }

  /** Forgets every list (signed out, another account). */
  clear() {
    if (!this.states.size) return;
    this.states.clear();
    this.emit();
  }

  private set(workspaceId: Id, state: PluginListState) {
    this.states.set(workspaceId, Object.freeze(state));
    this.emit();
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }
}

/** By English name, then type: the order Settings and the slash menu list them in. */
const sorted = (plugins: readonly WorkspacePlugin[]) =>
  Object.freeze(
    [...plugins].sort(
      (a, b) =>
        a.name.en.localeCompare(b.name.en, 'en') ||
        (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
    ),
  );
