import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { UpdateInfo, WorkspacePlatform } from '@cgw/shell';
import { erpFor } from './erp';
import { pluginsOriginFor } from './plugins';
import { shareInFlight } from './shared';
import { sheetOriginFor } from './sheet';

const bytes = (answer: ArrayBuffer | Uint8Array | number[]) =>
  answer instanceof Uint8Array
    ? answer
    : answer instanceof ArrayBuffer
      ? new Uint8Array(answer)
      : new Uint8Array(answer);

/**
 * The API's origin, from the build (`VITE_CGW_API`). The native side signs in only to the bases
 * it was built to allow (`CGW_API_BASES`, apps/desktop/src-tauri/src/auth.rs), and the window's CSP
 * lists the same ones.
 */
export const apiBase =
  (import.meta.env.VITE_CGW_API as string | undefined) ?? 'http://127.0.0.1:5280';

/**
 * A sign-in command's failure (`{ code, message }`, crates/cgw-native/src/auth.rs). An unreachable
 * server becomes a TypeError, as fetch reports one, so the API client counts it as offline rather
 * than as signed out.
 */
const authFailure = (error: unknown): Error => {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const message = typeof failure.message === 'string' ? failure.message : String(error);
  return failure.code === 'network' ? new TypeError(message) : new Error(message);
};

const authCommand = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
  try {
    return await invoke<T>(command, { apiBase, ...args });
  } catch (error) {
    throw authFailure(error);
  }
};

/** Asked before the window closes (`onCloseAsk`); false keeps it open. */
let closeAsk: (() => Promise<boolean>) | null = null;

export const desktopPlatform: WorkspacePlatform = {
  kind: 'desktop',
  apiBase,
  // The embed loads from Sheet's web origin; the window's CSP lists it in `frame-src`.
  sheetOrigin: sheetOriginFor(apiBase),
  // Phase 10: third-party plugins' frames, from their own origin; the window's CSP lists it in
  // `frame-src`.
  pluginsOrigin: pluginsOriginFor(apiBase),
  // Phase 9 (Track S6): Sheet's desktop app, when the system has something for its scheme
  // (apps/desktop/src-tauri/src/sheet.rs): its launch link goes to the system, never a browser.
  sheetApp: {
    installed: () => invoke<boolean>('sheet_app_installed').catch(() => false),
    open: (url) => invoke<void>('sheet_app_open', { url }),
  },
  // Cash Gear ERP's API (in the window's CSP) and its client, whose connect page opens in the
  // system browser and comes back by deep link (`onDeepLink`, crates/cgw-native).
  erp: erpFor(apiBase),
  // PKCE in the system browser, back to a loopback listener on the native side, which keeps the
  // refresh token in the OS keychain (D16). Only short-lived access tokens reach this page, and
  // only in memory; the device's name is the computer's.
  auth: {
    kind: 'bearer',
    signIn: (language) => authCommand<boolean>('auth_sign_in', { language, deviceName: null }),
    // Callers at once share one ask (shared.ts): the native side answers them one at a time, and
    // offline each would wait out the refresh before it.
    token: shareInFlight(() => authCommand<string | null>('auth_token', {})),
    signOut: () => authCommand<void>('auth_sign_out', {}),
  },
  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
  // External links open in the system browser, never inside the app's window.
  openExternal: (url) => openUrl(url),
  // The SQLite store, through one typed command; requests and answers are binary frames. Loaded
  // when the desktop opens it (Phase 17): the web app, which shares this module, never fetches it.
  openStore: async () => {
    const { DesktopStore } = await import('@cgw/store-desktop');
    return DesktopStore.open(async (frame) => bytes(await invoke<ArrayBuffer>('store', frame)));
  },
  saveFile: async (name, data) => {
    await invoke('save_file', data, { headers: { 'x-file-name': encodeURIComponent(name) } });
  },
  // Phase 19 (apps/desktop/src-tauri/src/print.rs): Save as PDF straight to a file, by WebView2's
  // PrintToPdf on Windows and an NSPrintOperation on the Mac; Print is WebView2's own dialog on
  // Windows, AppKit's print panel on the Mac (WKWebView ignores `window.print()`).
  print: async (job) => {
    const answer = await invoke<'printed' | 'saved' | 'cancelled' | 'dialog'>('print_page', {
      job,
    });
    if (answer === 'dialog') window.print();
    return answer;
  },
  // WKWebView draws no `@page` margin boxes: the Mac app's print view is cut into pages by script.
  printMode: /Mac OS X|Macintosh/.test(navigator.userAgent) ? 'paged' : 'css',
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
  // Phase 7: the asker (ERP changes not committed) may keep the window open; else pending saves
  // are written before the window goes, then it closes.
  onCloseAsk: (ask) => {
    closeAsk = ask;
    return () => {
      if (closeAsk === ask) closeAsk = null;
    };
  },
  onCloseRequested: (flush) => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        const ask = closeAsk;
        if (ask && !(await ask().catch(() => true))) {
          event.preventDefault();
          return;
        }
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
