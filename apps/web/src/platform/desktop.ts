import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WorkspacePlatform } from './platform';

export const desktopPlatform: WorkspacePlatform = {
  kind: 'desktop',
  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
};
