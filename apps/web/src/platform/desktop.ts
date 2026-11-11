import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WorkspacePlatform } from '@cgw/shell';

export const desktopPlatform: WorkspacePlatform = {
  kind: 'desktop',
  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
  // M1.9 opens links in the system browser through the opener plugin.
  openExternal: async () => {},
};
