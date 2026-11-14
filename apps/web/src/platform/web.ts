import type { WorkspacePlatform } from '@cgw/shell';
import { DATABASE, IndexedDbStore, workerIndex } from '@cgw/store-web';
import { erpFor } from './erp';
import { sheetOriginFor } from './sheet';

/** The API's origin, from the build (`VITE_CGW_API`); a sibling host of the web app (Q5). */
export const apiBase =
  (import.meta.env.VITE_CGW_API as string | undefined) ?? 'http://127.0.0.1:5280';

export const webPlatform: WorkspacePlatform = {
  kind: 'web',
  apiBase,
  sheetOrigin: sheetOriginFor(apiBase),
  // Cash Gear ERP's API and client; its connect page opens in a pop-up with its opener.
  erp: erpFor(apiBase),
  // The API's sign-in pages set an HttpOnly cookie; nothing here holds a credential.
  auth: { kind: 'cookie' },
  setWindowTheme: async () => {},
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  // Text search runs in a worker, from an index built out of the store (D25).
  openStore: () => IndexedDbStore.open(indexedDB, DATABASE, { index: workerIndex() }),
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
