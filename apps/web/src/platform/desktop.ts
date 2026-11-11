import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { UpdateInfo, WorkspacePlatform } from '@cgw/shell';
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
  // The release feed, through the app's own commands (apps/desktop/src-tauri/src/updates.rs).
  updates: {
    version: async () => (await invoke<{ version: string }>('app_info')).version,
    check: () => invoke<UpdateInfo | null>('update_check'),
    install: async (progress) => {
      const off = await listen<[number, number | null]>('update-progress', (event) =>
        progress(event.payload[0], event.payload[1]),
      );
      try {
        await invoke('update_install');
      } finally {
        off();
      }
    },
  },
  // Listening first, then asking for the link the app started with: none is missed between.
  onDeepLink: (open) => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void listen<string>('deep-link', (event) => open(event.payload)).then(async (unlisten) => {
      if (cancelled) return unlisten();
      off = unlisten;
      const first = await invoke<string | null>('take_deep_link');
      if (first && !cancelled) open(first);
    });
    return () => {
      cancelled = true;
      off?.();
    };
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
