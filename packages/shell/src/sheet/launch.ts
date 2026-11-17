// "Open in Cash Gear Sheet" (docs/INTEGRATIONS.md, "Opening the full editor"): the server makes a
// one-time launch link (two minutes, one use). In a browser it is Sheet's web app
// (`{Sheet}/cloud#launch=<ticket>`), opened in a new tab with `noopener`; only a link on the
// build's own Sheet origin is opened. On the desktop (Phase 9, Track S6, "Opening Sheet's desktop
// app"), when the system has something that opens `cashgear-sheet` links, it is Sheet's desktop
// app by its deep link (`cashgear-sheet://workspace/launch#ticket=…`), handed to the system by the
// native side, which refuses any other link; else Sheet's web app in the system browser, as
// before. Also what the database views' "Export to a workbook" is given.
import type { Id } from '@cgw/workspace';
import type { Cloud } from '../cloud/cloud';
import type { WorkbookSync } from '../database/host';
import type { WorkspacePlatform } from '../platform';
import { workbookApi, type WorkbookApi } from './api';

export type SheetPlatform = Pick<
  WorkspacePlatform,
  'kind' | 'openExternal' | 'sheetOrigin' | 'sheetApp'
>;

/** The origin of the build's Sheet (`https://host[:port]`), or null without one. */
export function sheetOriginOf(platform: Pick<WorkspacePlatform, 'sheetOrigin'>): string | null {
  if (!platform.sheetOrigin) return null;
  try {
    const url = new URL(platform.sheetOrigin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Sheet's desktop launch link, exactly: its path and one ticket of 43 base64url characters. */
const DESKTOP_LAUNCH = /^cashgear-sheet:\/\/workspace\/launch#ticket=[A-Za-z0-9_-]{43}$/;

export const isDesktopLaunch = (url: string) => DESKTOP_LAUNCH.test(url);

const newTab = (url: string) => void window.open(url, '_blank', 'noopener');

/** The web link checked against the build's Sheet origin, then opened. */
async function openWeb(url: string, platform: SheetPlatform, openTab: (url: string) => void) {
  const origin = sheetOriginOf(platform);
  if (!origin || !url.startsWith(`${origin}/`)) throw new Error('The launch link is not on Sheet');
  if (platform.kind === 'desktop') await platform.openExternal(url);
  else openTab(url);
}

/** Whether Sheet's desktop app is there to open (asked of the system each time). */
async function desktopApp(platform: SheetPlatform): Promise<boolean> {
  if (platform.kind !== 'desktop' || !platform.sheetApp) return false;
  return platform.sheetApp.installed().catch(() => false);
}

export async function openInSheet(
  api: WorkbookApi,
  workbookId: Id,
  platform: SheetPlatform,
  openTab: (url: string) => void = newTab,
): Promise<void> {
  if (await desktopApp(platform)) {
    const url = await api.launch(workbookId, 'desktop');
    if (isDesktopLaunch(url)) return platform.sheetApp!.open(url);
    // A server that does not know the desktop target answers its web link: opened as before.
    return openWeb(url, platform, openTab);
  }
  return openWeb(await api.launch(workbookId), platform, openTab);
}

/** The database views' workbook export and "Open in Cash Gear Sheet", over the connection. */
export function workbookSync(cloud: Cloud, platform: SheetPlatform): WorkbookSync {
  const api = workbookApi(cloud.api);
  return {
    exportView: async (databaseId, viewId, name) => {
      const made = await api.exportView(databaseId, viewId, name);
      return { workbookId: made.id, name: made.name };
    },
    open: (workbookId) =>
      openInSheet(api, workbookId, platform).catch((error: unknown) =>
        console.warn('Cash Gear Sheet could not be opened:', error),
      ),
  };
}
