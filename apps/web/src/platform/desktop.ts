import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { WorkspacePlatform } from '@cgw/shell';
import { DesktopStore } from '@cgw/store-desktop';

const bytes = (answer: ArrayBuffer | Uint8Array | number[]) =>
  answer instanceof Uint8Array
    ? answer
    : answer instanceof ArrayBuffer
      ? new Uint8Array(answer)
      : new Uint8Array(answer);

export const desktopPlatform: WorkspacePlatform = {
  kind: 'desktop',
  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
  // External links open in the system browser, never inside the app's window.
  openExternal: (url) => openUrl(url),
  // The SQLite store, through one typed command; requests and answers are binary frames.
  openStore: () =>
    DesktopStore.open(async (frame) => bytes(await invoke<ArrayBuffer>('store', frame))),
  saveFile: async (name, data) => {
    await invoke('save_file', data, { headers: { 'x-file-name': encodeURIComponent(name) } });
  },
  // Pending saves are written before the window goes; then it closes.
  onCloseRequested: (flush) => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWindow()
      .onCloseRequested(async () => {
        await flush();
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else off = unlisten;
      });
    return () => {
      cancelled = true;
      off?.();
    };
  },
};
