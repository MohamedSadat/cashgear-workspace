// What a third-party plugin's block is drawn with (`./frame-view`): the plugin as the workspace has
// it, where the block is (a workspace, a share link, offline), and the frame's address, all given by
// the shell, which asks the server for them. Nothing here calls the network or touches a store.
import type { i18n as I18n } from 'i18next';
import type { PluginData } from '../types';

/** A plugin a workspace has, as its block needs it (the server's `WorkspacePlugin`). */
export interface InstalledPlugin {
  id: string;
  type: string;
  version: number;
  name: { en: string; ar: string };
  reads: { rows: boolean };
  /** The frame's first height, CSS px. */
  height: number;
  enabled: boolean;
}

/**
 * Whether a block of a type can be drawn here, and if not, why: the workspace's list not read yet,
 * the plugin on (`online` says whether a frame's address can be asked for now; a frame already
 * drawn goes on without the network), not installed, turned off, no connection before the list
 * was read, signed out, the list not readable, a local workspace, a share link, a page of another
 * workspace.
 */
export type PluginAvailability =
  | { kind: 'loading' }
  | { kind: 'installed'; plugin: InstalledPlugin; online: boolean }
  | { kind: 'missing' }
  | { kind: 'disabled'; plugin: InstalledPlugin }
  | { kind: 'offline' }
  | { kind: 'signedOut' }
  | { kind: 'failed' }
  | { kind: 'local' }
  | { kind: 'shared' }
  | { kind: 'otherWorkspace' };

/** Why a frame's address could not be had: no connection, the plugin is not there or not on. */
export class FrameUrlError extends Error {
  constructor(readonly code: 'offline' | 'notFound' | 'failed') {
    super(code);
    this.name = 'FrameUrlError';
  }
}

export interface ThirdPartySource {
  /** The same object while it is unchanged (a `useSyncExternalStore` snapshot). */
  availability(type: string): PluginAvailability;
  subscribe(listener: () => void): () => void;
  /** Reads the workspace's list if it has not been read: a block of a plugin type is drawn. */
  ensure(): void;
  /** Reads the list again (Try again, or a frame address the server refused). */
  refresh(): void;
  /**
   * A frame address for the plugin (a ticket of a few minutes on the plugins origin), asked for
   * each time a frame is made; rejects with a `FrameUrlError`.
   */
  frameUrl(pluginId: string): Promise<string>;
}

export interface ThirdPartyDeps {
  source: ThirdPartySource;
  /** The build's plugins origin (`VITE_CGW_PLUGINS`); without it no frame is made. */
  pluginsOrigin: string | null;
  /** The app's theme; else the document's `data-cg-theme`. */
  theme?: { readonly theme: 'light' | 'dark'; subscribe(listener: () => void): () => void };
  /** The workspace's databases (a view's rows) and the linked-view picker. */
  data: PluginData;
  i18n: I18n;
}
