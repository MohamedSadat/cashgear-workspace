import type { WorkspacePlatform } from '@cgw/shell';
import { MemoryStore } from '@cgw/workspace';

export const webPlatform: WorkspacePlatform = {
  kind: 'web',
  setWindowTheme: async () => {},
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  // M1.7 replaces this with the IndexedDB store.
  openStore: async () => new MemoryStore(),
};
