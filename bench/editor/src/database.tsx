// The database views in a browser, over the in-memory host and generated rows of every type
// (@cgw/database/testing). Chosen by the URL:
//   ?rows=50000      rows in the Tasks database (default 200)
//   &lang=ar         the interface language (en, ar)
//   &theme=dark      light or dark
//   &page=500        the host gives rows a page at a time, as the server's query does
//   &embedded=1      as a block inside a page (its own scroll, a limited height)
//   &readonly=1      the person may not edit
//   &group=status    grouped by status (or priority, tags, owner, due, done)
//   &wrap=1          cell text wrapped
//   &row=1           also the first row's properties panel
// `window.__db` holds the host and ids for the measuring scripts.
import '@cashgear/ui/styles.css';
import { DatabaseView, RowProperties } from '@cgw/database';
import { P, StringsProvider, seed } from '@cgw/database/testing';
import { newOp } from '@cgw/workspace';
import { createRoot } from 'react-dom/client';
import { addViews } from './database-views';

const params = new URLSearchParams(location.search);
const rows = Math.max(0, Math.min(200_000, Number(params.get('rows') ?? 200) || 0));
const language = params.get('lang') === 'ar' ? 'ar' : 'en';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const pageSize = params.get('page') ? Number(params.get('page')) : null;
const embedded = params.get('embedded') === '1';
const readonly = params.get('readonly') === '1';
const groupBy = params.get('group');
const wrap = params.get('wrap') === '1';
const showRow = params.get('row') === '1';

const html = document.documentElement;
html.lang = language;
html.dir = language === 'ar' ? 'rtl' : 'ltr';
html.dataset.cgTheme = theme;

const started = performance.now();
const seeded = seed(rows, { pageSize, canEdit: !readonly });
const seededMs = performance.now() - started;
const { host, tasksId, viewId } = seeded;

const groups: Record<string, string> = {
  status: P.status,
  priority: P.priority,
  tags: P.tags,
  owner: P.owner,
  due: P.due,
  done: P.done,
};
if (groupBy || wrap) {
  const view = host.views(tasksId)[0];
  void host.apply([
    newOp('view.upsert', view.workspaceId, viewId, {
      ...view,
      config: {
        ...view.config,
        wrap,
        group: groupBy && groups[groupBy] ? { propertyId: groups[groupBy] } : null,
      },
    }),
  ]);
}

// The board, list, calendar and gallery views (`&view=` shows one first): database-views.ts.
const viewIds = addViews(host, tasksId);

const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; block-size: 100%; background: var(--cg-page-bg, var(--cg-surface)); }
  body { font-family: 'Segoe UI', 'Noto Sans Arabic', system-ui, sans-serif; color: var(--cg-text); }
  #root { box-sizing: border-box; block-size: 100%; display: flex; flex-direction: column; padding: 12px 16px; gap: 12px; }
  .harness-page { max-inline-size: 60rem; margin-inline: auto; inline-size: 100%; }
  .harness-full { flex: 1; min-block-size: 0; display: flex; flex-direction: column; }
`;
document.head.append(style);

const firstRow = host.rowsOf(tasksId)[0];
const app = (
  <StringsProvider language={language}>
    {showRow && firstRow ? (
      <div className="harness-page">
        <RowProperties host={host} rowId={firstRow.id} />
      </div>
    ) : null}
    <div className={embedded ? 'harness-page' : 'harness-full'}>
      <DatabaseView host={host} databaseId={tasksId} embedded={embedded} showTitle />
    </div>
  </StringsProvider>
);

createRoot(document.getElementById('root')!).render(app);

(window as unknown as Record<string, unknown>).__db = {
  host,
  tasksId,
  viewId,
  viewIds,
  seededMs,
  ready: () => document.querySelector('[role="grid"] .cgw-tbody [role="row"]') !== null,
};
