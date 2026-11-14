// "Open in Cash Gear Sheet" (docs/INTEGRATIONS.md, "Opening the full editor"): the server makes a
// one-time launch link (`{Sheet}/cloud#launch=<ticket>`, two minutes), opened in a new tab with
// `noopener` in a browser and in the system browser on the desktop (Sheet's desktop deep link for
// Workspace is not built yet: decisions, 2026-11-14). Only a link on the build's own Sheet origin
// is opened. Also what the database views' "Export to a workbook" is given.
import type { Id } from '@cgw/workspace';
import type { Cloud } from '../cloud/cloud';
import type { WorkbookSync } from '../database/host';
import type { WorkspacePlatform } from '../platform';
import { workbookApi, type WorkbookApi } from './api';

export type SheetPlatform = Pick<WorkspacePlatform, 'kind' | 'openExternal' | 'sheetOrigin'>;

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

const newTab = (url: string) => void window.open(url, '_blank', 'noopener');

export async function openInSheet(
  api: WorkbookApi,
  workbookId: Id,
  platform: SheetPlatform,
  openTab: (url: string) => void = newTab,
): Promise<void> {
  const url = await api.launch(workbookId);
  const origin = sheetOriginOf(platform);
  if (!origin || !url.startsWith(`${origin}/`)) throw new Error('The launch link is not on Sheet');
  if (platform.kind === 'desktop') await platform.openExternal(url);
  else openTab(url);
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
