// Third-party plugins for the pages of a session (Phase 10): the plugin list per connection
// (store.ts), and per page's workspace a `ThirdPartySource` that says whether a block of a type
// can be drawn here (and why not), reads the list when a block needs it, and asks the server for
// a frame's address. The sources are made once per session and workspace and read the connection
// as it is now, so a block drawn before the connection came reads it once it comes.
import {
  FrameUrlError,
  type InstalledPlugin,
  type PluginAvailability,
  type ThirdPartySource,
} from '@cgw/plugins/frame';
import type { Id } from '@cgw/workspace';
import type { Cloud } from '../cloud/cloud';
import type { WorkspaceSession } from '../session';
import { PluginRequestError, pluginApi, type WorkspacePlugin } from './api';
import { PluginsStore } from './store';

const stores = new WeakMap<Cloud, PluginsStore>();

/** The connection's plugin lists: forgotten when the account changes. */
export function pluginsStoreOf(cloud: Cloud): PluginsStore {
  let store = stores.get(cloud);
  if (!store) {
    const made = new PluginsStore(pluginApi(cloud.api));
    let account = cloud.account?.id ?? null;
    cloud.subscribe(() => {
      const now = cloud.account?.id ?? null;
      if (now === account) return;
      account = now;
      made.clear();
    });
    stores.set(cloud, made);
    store = made;
  }
  return store;
}

/** Whether the server can be asked now. */
export const reachable = (cloud: Cloud | null) => {
  if (!cloud?.account) return false;
  const state = cloud.status.state;
  return state === 'syncing' || state === 'synced' || state === 'error';
};

const frozen = <T extends PluginAvailability>(value: T): T => Object.freeze(value);
const LOADING = frozen({ kind: 'loading' });
const MISSING = frozen({ kind: 'missing' });
const OFFLINE = frozen({ kind: 'offline' });
const SIGNED_OUT = frozen({ kind: 'signedOut' });
const FAILED = frozen({ kind: 'failed' });
const LOCAL = frozen({ kind: 'local' });
const OTHER = frozen({ kind: 'otherWorkspace' });

const installed = (plugin: WorkspacePlugin): InstalledPlugin => ({
  id: plugin.id,
  type: plugin.type,
  version: plugin.version,
  name: plugin.name,
  reads: plugin.reads,
  height: plugin.height,
  enabled: plugin.enabled,
});

export class PluginServices {
  private cloud: Cloud | null = null;
  private off: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly sources = new Map<Id, ThirdPartySource>();

  constructor(readonly session: WorkspaceSession) {
    // The workspace may become synced (uploaded) while its pages are open.
    session.mirror.subscribe(() => this.emit());
  }

  /** The connection, when the app has one; null for a build without the server. */
  setCloud(cloud: Cloud | null) {
    if (cloud === this.cloud) return;
    for (const off of this.off.splice(0)) off();
    this.cloud = cloud;
    if (cloud) {
      const store = pluginsStoreOf(cloud);
      let wasReachable = reachable(cloud);
      this.off.push(
        store.subscribe(() => this.emit()),
        cloud.subscribe(() => {
          const now = reachable(cloud);
          // The server can be reached (again): the open workspace's list is read if it was not,
          // or could not be.
          const id = this.session.current?.id;
          if (now && !wasReachable && id && this.storeFor(id)) {
            const status = store.state(id).status;
            if (status === 'idle' || status === 'failed') void store.load(id, true);
          }
          wasReachable = now;
          this.emit();
        }),
      );
    }
    this.emit();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  /** The store, when the workspace of `workspaceId` is the open one and synced. */
  private storeFor(workspaceId: Id): PluginsStore | null {
    const current = this.session.current;
    if (!this.cloud || !current || current.localOnly !== false || current.id !== workspaceId)
      return null;
    return pluginsStoreOf(this.cloud);
  }

  /** Reads the workspace's list if it has not been read and the server can be asked. */
  ensure(workspaceId: Id) {
    const store = this.storeFor(workspaceId);
    if (!store || !reachable(this.cloud)) return;
    if (store.state(workspaceId).status === 'idle') void store.load(workspaceId);
  }

  /** The workspace's plugins that are on (the slash menu), as known now. */
  enabled(workspaceId: Id): readonly WorkspacePlugin[] {
    return (this.storeFor(workspaceId)?.plugins(workspaceId) ?? []).filter((p) => p.enabled);
  }

  /** The source for the blocks of pages in a workspace: one object per workspace. */
  sourceFor(workspaceId: Id): ThirdPartySource {
    let source = this.sources.get(workspaceId);
    if (!source) {
      source = this.makeSource(workspaceId);
      this.sources.set(workspaceId, source);
    }
    return source;
  }

  private makeSource(workspaceId: Id): ThirdPartySource {
    const cache = new Map<string, { key: string; value: PluginAvailability }>();
    /** The same object as last time when nothing in it changed. */
    const kept = (type: string, value: PluginAvailability): PluginAvailability => {
      const key = JSON.stringify(value);
      const before = cache.get(type);
      if (before && before.key === key) return before.value;
      cache.set(type, { key, value: Object.freeze(value) });
      return value;
    };
    const availability = (type: string): PluginAvailability => {
      const cloud = this.cloud;
      const current = this.session.current;
      if (!cloud || !current || current.localOnly !== false) return LOCAL;
      if (current.id !== workspaceId) return OTHER;
      const account = cloud.account;
      if (account === undefined) return LOADING;
      if (!account) return SIGNED_OUT;
      const store = pluginsStoreOf(cloud);
      const state = store.state(workspaceId);
      const plugins = store.plugins(workspaceId);
      if (!plugins) {
        if (state.status === 'failed') return state.code === 'offline' ? OFFLINE : FAILED;
        return reachable(cloud) ? LOADING : OFFLINE;
      }
      const plugin = plugins.find((p) => p.type === type);
      if (!plugin) return MISSING;
      if (!plugin.enabled) return kept(type, { kind: 'disabled', plugin: installed(plugin) });
      return kept(type, { kind: 'installed', plugin: installed(plugin), online: reachable(cloud) });
    };
    return {
      availability,
      subscribe: this.subscribe,
      ensure: () => this.ensure(workspaceId),
      refresh: () => {
        const store = this.storeFor(workspaceId);
        if (store) void store.load(workspaceId, true);
      },
      frameUrl: async (pluginId) => {
        const store = this.storeFor(workspaceId);
        if (!store) throw new FrameUrlError('failed');
        try {
          return (await store.api.frame(workspaceId, pluginId)).url;
        } catch (error) {
          if (error instanceof PluginRequestError) {
            if (error.code === 'offline') throw new FrameUrlError('offline');
            if (error.status === 404) throw new FrameUrlError('notFound');
          }
          throw new FrameUrlError('failed');
        }
      },
    };
  }
}

const services = new WeakMap<WorkspaceSession, PluginServices>();

export function pluginServices(session: WorkspaceSession): PluginServices {
  let found = services.get(session);
  if (!found) {
    found = new PluginServices(session);
    services.set(session, found);
  }
  return found;
}

const SHARED = frozen({ kind: 'shared' });

/** The source for a page shared by link: no member, so no frame; the block names its type. */
export const SHARED_SOURCE: ThirdPartySource = Object.freeze({
  availability: () => SHARED,
  subscribe: () => () => {},
  ensure: () => {},
  refresh: () => {},
  frameUrl: () => Promise.reject(new FrameUrlError('failed')),
});
