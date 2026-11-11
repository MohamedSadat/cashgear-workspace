import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WorkspacePlatform } from '@cgw/shell';
import { MemoryStore } from '@cgw/workspace';

export const desktopPlatform: WorkspacePlatform = {
  kind: 'desktop',
  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
  // M1.9 opens links in the system browser through the opener plugin.
  openExternal: async () => {},
  // M1.7 replaces this with the SQLite store behind typed commands.
  openStore: async () => new MemoryStore(),
};
