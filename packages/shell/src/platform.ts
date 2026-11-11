// What differs between the browser and the desktop (ARCHITECTURE.md, "Platform interface").
// apps/web picks the implementation; nothing else asks which platform it is on.
import type { LocalStore } from '@cgw/workspace';

export type Theme = 'light' | 'dark';

export interface WorkspacePlatform {
  kind: 'web' | 'desktop';
  /** Gives the window's own frame a theme, or the system's with null; a no-op in a browser. */
  setWindowTheme(theme: Theme | null): Promise<void>;
  /** Opens a link outside the app, in the system browser on the desktop. */
  openExternal(url: string): Promise<void>;
  /** The local store: IndexedDB in a browser, SQLite on the desktop (D11). */
  openStore(): Promise<LocalStore>;
  /** Asks to keep local data from eviction; false when refused. The desktop always keeps it. */
  requestPersistence?(): Promise<boolean>;
  /** Saves bytes to a file the user picks (a download in a browser). */
  saveFile(suggestedName: string, bytes: Uint8Array, type: string): Promise<void>;
  /** The desktop window is closing: `flush` runs first. */
  onCloseRequested?(flush: () => Promise<void>): () => void;
  /** Desktop updates from the release feed. */
  updates?: PlatformUpdates;
  /**
   * Desktop deep links (`cashgear-workspace://p/{pageId}`): `open` gets the route's hash, the
   * link the app started with first. Returns the unsubscribe.
   */
  onDeepLink?(open: (hash: string) => void): () => void;
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

export interface PlatformUpdates {
  /** The installed version, as the updater compares it. */
  version(): Promise<string>;
  /** The newer version the feed offers, or null. */
  check(): Promise<UpdateInfo | null>;
  /**
   * Downloads the update, checks its signature against the app's public key and installs it; the
   * installer closes the app and starts the new version.
   */
  install(progress: (received: number, total: number | null) => void): Promise<void>;
}
