import type { WorkspacePlatform } from '@cgw/shell';

export const webPlatform: WorkspacePlatform = {
  kind: 'web',
  setWindowTheme: async () => {},
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};
