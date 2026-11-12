// The harness's board, list, calendar and gallery views (views stream): added to the generated
// Tasks database beside its table, and the one named by `?view=` put first so it shows at once:
//   &view=board|list|calendar|gallery   the view shown first (default: the table)
// Some rows get a page cover (a generated picture) so the gallery has pictures to show.
import { VIEW_TYPES } from '@cgw/database';
import type { MemoryDatabaseHost } from '@cgw/database/testing';
import { P } from '@cgw/database/testing';
import { newOp, type Id, type ViewRecord, type ViewType } from '@cgw/workspace';

const COLOURS = ['#2f7a4a', '#1f6fbf', '#b35600', '#7a4fbf', '#b8407f', '#8c6a00'];

function coverUrl(i: number): string {
  const a = COLOURS[i % COLOURS.length];
  const b = COLOURS[(i + 2) % COLOURS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="${60 + ((i * 37) % 200)}" cy="90" r="40" fill="rgba(255,255,255,.25)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Adds the four views; the one `?view=` names comes first. Returns the views' ids by type. */
export function addViews(host: MemoryDatabaseHost, databaseId: Id): Partial<Record<ViewType, Id>> {
  const database = host.database(databaseId);
  const table = host.views(databaseId)[0];
  if (!database || !table) return {};
  const first = new URLSearchParams(location.search).get('view') as ViewType | null;

  // Pictures for a third of the rows, through the host's files.
  const urls = new Map<Id, string>();
  let n = 0;
  for (const row of host.rowsOf(databaseId)) {
    if (n % 3 === 0) {
      const id = `0190a000-0000-7000-8000-c0${String(n).padStart(10, '0')}`;
      urls.set(id, coverUrl(n));
      host.rowRecords.set(row.id, { ...row, coverAssetId: id });
    }
    n++;
  }
  const url = host.assets.url;
  host.assets = { ...host.assets, url: async (id) => urls.get(id) ?? url(id) };

  const show = (...ids: string[]) => ({
    order: ids,
    hidden: database.properties
      .filter((p) => p.id !== 'title' && !ids.includes(p.id))
      .map((p) => p.id),
    widths: {},
  });
  const views: { type: ViewType; name: string; config: Partial<ViewRecord['config']> }[] = [
    { type: 'board', name: 'Board', config: { properties: show(P.priority, P.owner, P.due) } },
    { type: 'list', name: 'List', config: { properties: show(P.status, P.owner, P.due) } },
    { type: 'calendar', name: 'Calendar', config: { calendarBy: P.due } },
    {
      type: 'gallery',
      name: 'Gallery',
      config: {
        cover: { kind: 'pageCover' },
        cardSize: 'medium',
        properties: show(P.status, P.amount),
      },
    },
  ];
  const ids: Partial<Record<ViewType, Id>> = {};
  const ops = views.map((v, i) => {
    const id = host.newId();
    ids[v.type] = id;
    const record: ViewRecord = {
      ...table,
      id,
      name: v.name,
      type: v.type,
      // `a1`… after the table, or before it (`Zz`) for the view asked for.
      orderKey: v.type === first ? 'Zz' : `a${i + 1}`,
      config: { ...VIEW_TYPES[v.type].defaultConfig(database), ...v.config },
      version: 1,
    };
    return newOp('view.upsert', table.workspaceId, id, record);
  });
  void host.apply(ops);
  return ids;
}
