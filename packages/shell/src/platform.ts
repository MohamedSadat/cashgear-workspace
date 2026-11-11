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
  /** The desktop window is closing: `flush` runs first. */
  onCloseRequested?(flush: () => Promise<void>): () => void;
}
