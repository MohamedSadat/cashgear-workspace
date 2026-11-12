// What differs between the browser and the desktop (ARCHITECTURE.md, "Platform interface").
// apps/web picks the implementation; nothing else asks which platform it is on.
import type { LocalStore } from '@cgw/workspace';

export type Theme = 'light' | 'dark';

/**
 * How the app proves to the Workspace API who is signed in (D16; ARCHITECTURE.md,
 * Authentication). No credential is ever in JavaScript storage.
 */
export type AuthPlatform =
  /**
   * The browser: the API's own sign-in pages set an HttpOnly cookie on the API's host, which the
   * browser sends with every request; writes carry an antiforgery header.
   */
  | { kind: 'cookie' }
  /**
   * The desktop: authorisation code with PKCE in the system browser, back to a loopback listener
   * on the native side, which exchanges the code and keeps the refresh token in the OS keychain.
   * The webview only ever holds a short-lived access token, in memory.
   */
  | {
      kind: 'bearer';
      /** Opens the system browser to sign in; resolves true once signed in, false if abandoned. */
      signIn(language: 'en' | 'ar'): Promise<boolean>;
      /** A current access token (refreshed on the native side when needed), or null when signed out. */
      token(): Promise<string | null>;
      /** Revokes the refresh token at the server and removes it from the keychain. */
      signOut(): Promise<void>;
    };

/** A platform that reaches the Workspace API. */
export type CloudPlatform = WorkspacePlatform & { apiBase: string; auth: AuthPlatform };

export const hasCloud = (platform: WorkspacePlatform): platform is CloudPlatform =>
  !!platform.apiBase && !!platform.auth;

export interface WorkspacePlatform {
  kind: 'web' | 'desktop';
  /**
   * The Workspace API's origin, e.g. `https://workspace-api.cashgearerp.com` (Q5), and how to
   * sign in to it. Without them the app works on this device only, as in Phase 1 (benchmarks).
   */
  apiBase?: string;
  auth?: AuthPlatform;
  /** The web app's address, for share links made on the desktop; the browser uses its own. */
  webBase?: string;
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
