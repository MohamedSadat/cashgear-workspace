// Phase 9: a database's own page on a share link is drawn by its first view, read only, over the
// link's database routes; it asks for no document, every request carries the token in a header
// and sends no cookie, and the views offer nothing that changes anything.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
// The views load lazily in the app: loaded first here, so Suspense resolves at once.
await import('@cgw/database');
const { createI18n } = await import('../i18n');
const { SharedView } = await import('./SharedView');

const DB = '01936f6e-0000-7000-8000-00000000ab01';
const VIEW = '01936f6e-0000-7000-8000-00000000ab02';
const TOKEN = 'share-token';

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 400 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

describe('a database page shared by link', () => {
  it('is drawn by its first view, read only, from the link’s routes', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        if (path === '/api/v1/shared')
          return json({
            page: { id: DB, title: 'Tasks', icon: null },
            pages: [{ id: DB, title: 'Tasks', icon: null, parentPageId: null, kind: 'database' }],
          });
        if (path === `/api/v1/shared/databases/${DB}`)
          return json({
            database: {
              id: DB,
              title: 'Tasks',
              icon: null,
              properties: [{ id: 'title', name: 'Name', type: 'title' }],
            },
            views: [
              {
                id: VIEW,
                name: 'All tasks',
                type: 'table',
                orderKey: 'a0',
                config: {
                  filter: null,
                  sorts: [],
                  group: null,
                  properties: { order: [], hidden: [], widths: {} },
                },
              },
            ],
          });
        if (path === `/api/v1/shared/databases/${DB}/query`)
          return json({
            rows: [
              { id: `${DB.slice(0, -2)}r1`, databaseId: DB, title: 'Write the plan', values: {} },
              { id: `${DB.slice(0, -2)}r2`, databaseId: DB, title: 'Ship it', values: {} },
            ],
            groups: null,
            total: 2,
            next: null,
          });
        return new Response('{}', { status: 404 });
      }),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        h(
          I18nextProvider,
          { i18n: createI18n('en') },
          h(SharedView, { apiBase: 'http://api.test', token: TOKEN, pageId: null }),
        ),
      ),
    );
    await until(() => container.textContent!.includes('Ship it'), 'the rows');
    expect(container.querySelector('[data-testid="shared-database"]')).not.toBeNull();
    expect(container.textContent).toContain('All tasks');
    expect(container.textContent).toContain('Write the plan');
    // No document asked for a database's page; the query names the view and nothing else.
    expect(calls.some((c) => c.url.includes('/json'))).toBe(false);
    const query = calls.find((c) => c.url.endsWith('/query'))!;
    expect(JSON.parse(query.init!.body as string)).toEqual({
      viewId: VIEW,
      limit: 100,
      context: { today: expect.any(String), offsetMinutes: expect.any(Number) },
    });
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>)['X-Share-Token']).toBe(TOKEN);
      expect(call.init?.credentials).toBe('omit');
    }
    // Read only: no "New" row and the view says so.
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'New')).toBe(
      false,
    );
  });
});
