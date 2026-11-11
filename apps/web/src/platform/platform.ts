/** What differs between the browser and the desktop. Phase 1 grows it (ARCHITECTURE.md). */
export type Theme = 'light' | 'dark';

export interface WorkspacePlatform {
  kind: 'web' | 'desktop';
  /** Gives the window's own frame the page's theme; a no-op in a browser. */
  setWindowTheme(theme: Theme | null): Promise<void>;
}
