import type { WorkspacePlatform } from '@cgw/shell';
import { IndexedDbStore } from '@cgw/store-web';

export const webPlatform: WorkspacePlatform = {
  kind: 'web',
  setWindowTheme: async () => {},
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  openStore: () => IndexedDbStore.open(),
  // The browser may evict this origin's data unless it agrees to keep it (SYNC_DESIGN.md).
  requestPersistence: () => IndexedDbStore.persist(),
  saveFile: async (name, bytes, type) => {
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
