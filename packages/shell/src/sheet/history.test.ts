// Phase 9, M9.3: a workbook's history and the desktop's Sheet link in the shell. The history lists
// the kept versions newest first with when and by whom, shows one read-only in the embed by its own
// signed URL, and restores an older one (after asking) with `If-Match` on the current content for
// an editor, never offering it to a reader; a conflict reads the list again. The routes' request
// shapes (versions, a version's content, restore, an upload as Sheet's first save, the desktop
// launch target). "Open in Cash Gear Sheet" opens Sheet's desktop app by its deep link when the
// system has it, else Sheet's web app as before, and refuses any other link.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createApi } = await import('@cgw/api');
const { SyncHttpError } = await import('@cgw/workspace');
const { createI18n } = await import('../i18n');
const { WorkbookHistory, etagOf } = await import('./WorkbookHistory');
const { workbookApi, XLSX_TYPE } = await import('./api');
const { isDesktopLaunch, openInSheet } = await import('./launch');
type Workbook = import('./api').Workbook;
type WorkbookApi = import('./api').WorkbookApi;
type WorkbookVersion = import('./api').WorkbookVersion;
type EmbedFactory = import('./SheetBlock').EmbedFactory;
type SheetEmbedOptions = import('@cgw/editor').SheetEmbedOptions;
type SheetEmbedEvents = import('@cgw/editor').SheetEmbedEvents;

const WS = '01936f6e-0000-7000-8000-00000000e001';
const WORKBOOK = '01936f6e-0000-7000-8000-00000000e002';
const ORIGIN = 'http://127.0.0.1:4283';
const TICKET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 200 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const book = (over: Partial<Workbook> = {}): Workbook => ({
  id: WORKBOOK,
  workspaceId: WS,
  name: 'Budget 2026',
  version: 3,
  versionId: 'v3',
  etag: '"v3"',
  size: 1000,
  savedAt: '2026-11-16T10:00:00Z',
  savedBy: { id: 'u1', name: 'Ada' },
  createdBy: 'u1',
  createdAt: '2026-11-01T10:00:00Z',
  trashedAt: null,
  access: 'edit',
  ...over,
});

const versions = (): WorkbookVersion[] => [
  {
    id: 'v3',
    size: 1200,
    sha256: 'c'.repeat(64),
    savedAt: '2026-11-16T10:00:00Z',
    savedBy: { id: 'u1', name: 'Ada' },
    current: true,
  },
  {
    id: 'v2',
    size: 1100,
    sha256: 'b'.repeat(64),
    savedAt: '2026-11-15T09:00:00Z',
    savedBy: { id: 'u2', name: 'Grace' },
    current: false,
  },
  {
    id: 'v1',
    size: 1000,
    sha256: 'a'.repeat(64),
    savedAt: '2026-11-14T08:00:00Z',
    savedBy: null,
    current: false,
  },
];

function fakeApi(over: Partial<Record<keyof WorkbookApi, unknown>> = {}) {
  return {
    versions: vi.fn(async () => versions()),
    versionContent: vi.fn(async (_id: string, versionId: string) => ({
      readUrl: `http://127.0.0.1:10000/devstoreaccount1/${versionId}.xlsx?sig=x`,
      etag: `"${versionId}"`,
      versionId,
      size: 1000,
      expiresAt: null,
    })),
    restoreVersion: vi.fn(async () => ({ versionId: 'v4', etag: '"v4"' })),
    ...over,
  } as unknown as WorkbookApi;
}

function fakeEmbeds() {
  const made: { options: SheetEmbedOptions; events: SheetEmbedEvents; destroyed: boolean }[] = [];
  const factory: EmbedFactory = (container, options, events) => {
    const frame = document.createElement('iframe');
    frame.title = options.title;
    container.append(frame);
    const entry = { options, events, destroyed: false };
    made.push(entry);
    return {
      frame,
      setView: () => {},
      setTheme: () => {},
      refresh: () => {},
      requestPreview: () => Promise.reject(new Error('none')),
      destroy: () => {
        entry.destroyed = true;
        frame.remove();
      },
    };
  };
  return { made, factory };
}

function render(props: Parameters<typeof WorkbookHistory>[0], language: 'en' | 'ar' = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(h(I18nextProvider, { i18n: createI18n(language) }, h(WorkbookHistory, props))),
  );
  return document.body;
}

const button = (root: HTMLElement, label: string) =>
  root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
  [...root.querySelectorAll('button')].find((b) => b.textContent === label) ??
  null;

describe('a workbook’s history', () => {
  it('lists the kept versions with when and by whom, and shows one read-only', async () => {
    const api = fakeApi();
    const embeds = fakeEmbeds();
    const root = render({
      api,
      workbook: book(),
      sheetOrigin: ORIGIN,
      theme: 'dark',
      onClose: () => {},
      embed: embeds.factory,
    });
    await until(() => root.querySelectorAll('[data-version]').length === 3, 'the versions');
    const lines = [...root.querySelectorAll('[data-version]')].map((li) => li.textContent);
    expect(lines[0]).toContain('Ada');
    expect(lines[0]).toContain('Current');
    expect(lines[1]).toContain('Grace');
    expect(lines[2]).not.toContain('by');
    // The current one is not restored; the older ones are.
    const v2 = root.querySelector('[data-version="v2"]')!;
    const v3 = root.querySelector('[data-version="v3"]')!;
    expect([...v3.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Show']);
    expect([...v2.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Show',
      'Restore',
    ]);
    await act(async () => v2.querySelector<HTMLButtonElement>('button')!.click());
    await until(() => embeds.made.length === 1, 'the embed');
    expect(api.versionContent).toHaveBeenCalledWith(WORKBOOK, 'v2');
    const made = embeds.made[0];
    expect(made.options).toMatchObject({
      sheetOrigin: ORIGIN,
      source: { kind: 'url', url: expect.stringContaining('/v2.xlsx'), etag: '"v2"' },
      view: { kind: 'range', sheet: null, range: null },
      theme: 'dark',
      direction: 'ltr',
      locale: 'en',
    });
    act(() =>
      made.events.loaded?.({
        contract: 'sheet-embed.1',
        etag: '"v2"',
        view: { kind: 'range', sheet: 'Budget', range: 'A1:B2' },
        size: { width: 400, height: 200 },
        sheets: [{ name: 'Budget', direction: 'ltr' }],
        charts: [],
      } as never),
    );
    const frame = root.querySelector<HTMLElement>('.cgw-workbook-frame')!;
    expect(frame.hasAttribute('data-shown')).toBe(true);
    expect(frame.hidden).toBe(false);
    // Hidden again: the embed goes.
    await act(async () => v2.querySelector<HTMLButtonElement>('button')!.click());
    expect(made.destroyed).toBe(true);
  });

  it('restores an older version for an editor after asking, with the current content’s tag', async () => {
    const api = fakeApi();
    const onRestored = vi.fn();
    const root = render({
      api,
      workbook: book(),
      sheetOrigin: ORIGIN,
      theme: 'light',
      onClose: () => {},
      onRestored,
    });
    await until(() => root.querySelectorAll('[data-version]').length === 3, 'the versions');
    const v1 = root.querySelector('[data-version="v1"]')!;
    await act(async () =>
      [...v1.querySelectorAll('button')].find((b) => b.textContent === 'Restore')!.click(),
    );
    expect(api.restoreVersion).not.toHaveBeenCalled();
    await act(async () => button(root, 'Restore it')!.click());
    expect(api.restoreVersion).toHaveBeenCalledWith(WORKBOOK, 'v1', '"v3"');
    expect(etagOf('v3')).toBe('"v3"');
    await until(() => !!root.querySelector('[data-testid="workbook-history-message"]'), 'done');
    expect(root.querySelector('[data-testid="workbook-history-message"]')!.textContent).toContain(
      'newest version now',
    );
    expect(onRestored).toHaveBeenCalled();
    // The list is read again.
    expect((api.versions as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('says so when someone saved meanwhile, and offers no restore to a reader', async () => {
    const api = fakeApi({
      restoreVersion: vi.fn(async () => {
        throw new SyncHttpError(409, 'version.conflict', 'Stale');
      }),
    });
    const root = render({
      api,
      workbook: book(),
      sheetOrigin: ORIGIN,
      theme: 'light',
      onClose: () => {},
    });
    await until(() => root.querySelectorAll('[data-version]').length === 3, 'the versions');
    const v2 = root.querySelector('[data-version="v2"]')!;
    await act(async () =>
      [...v2.querySelectorAll('button')].find((b) => b.textContent === 'Restore')!.click(),
    );
    await act(async () => button(root, 'Restore it')!.click());
    await until(() => !!root.querySelector('[role="alert"]'), 'the refusal');
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('saved the workbook');
    act(() => roots.splice(0).forEach((r) => r.unmount()));
    document.body.replaceChildren();

    const reader = render(
      {
        api: fakeApi(),
        workbook: book({ access: 'view' }),
        sheetOrigin: ORIGIN,
        theme: 'light',
        onClose: () => {},
      },
      'ar',
    );
    await until(() => reader.querySelectorAll('[data-version]').length === 3, 'the versions');
    expect(reader.querySelectorAll('[data-version] button')).toHaveLength(3);
    expect(reader.querySelector('[data-testid="workbook-history-reader"]')!.textContent).toBe(
      'لا يستعيد الإصدارات إلا من يستطيع تعديل المصنف.',
    );
    expect(reader.querySelector('#cgw-dialog-title')!.textContent).toBe('إصدارات Budget 2026');
  });
});

describe('the workbook routes of Phase 9', () => {
  function fakeServer() {
    const requests: { method: string; url: URL; headers: Headers; body: unknown }[] = [];
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const fetch = async (given: Request | string, init?: RequestInit) => {
      const input = typeof given === 'string' ? new Request(given, init) : given;
      const url = new URL(input.url);
      const raw = input.method === 'GET' ? null : new Uint8Array(await input.arrayBuffer());
      const type = input.headers.get('Content-Type') ?? '';
      const body =
        raw && raw.length && type.includes('json')
          ? JSON.parse(new TextDecoder().decode(raw))
          : raw;
      requests.push({ method: input.method, url, headers: input.headers, body });
      if (url.pathname === '/api/v1/account/antiforgery') return json({ token: 'csrf' });
      const base = `/api/v1/workbooks/${WORKBOOK}`;
      if (url.pathname === `${base}/versions` && input.method === 'GET')
        return json({
          versions: versions().map((v) => ({ ...v, size: String(v.size) })),
        });
      if (url.pathname === `${base}/versions/v2/content`)
        return json({
          readUrl: 'http://blob/v2',
          etag: '"v2"',
          size: '1100',
          versionId: 'v2',
          expiresAt: null,
        });
      if (url.pathname === `${base}/versions/v2/restore`)
        return json({ versionId: 'v4', etag: '"v4"' }, 201);
      if (url.pathname === `${base}/versions` && input.method === 'POST')
        return json({ versionId: 'v1', etag: '"v1"' }, 201);
      if (url.pathname === `${base}/launch`) {
        const desktop = (body as { target?: string } | null)?.target === 'desktop';
        return json({
          url: desktop
            ? `cashgear-sheet://workspace/launch#ticket=${TICKET}`
            : `${ORIGIN}/cloud#launch=${TICKET}`,
          expiresAt: null,
        });
      }
      return json({ code: 'not.found', title: 'No' }, 404);
    };
    return { fetch, requests };
  }

  it('read versions and a version’s content, restore with If-Match, upload as a first save', async () => {
    const server = fakeServer();
    const api = workbookApi(
      createApi({
        baseUrl: 'http://api.test',
        auth: { kind: 'cookie' },
        fetch: server.fetch as never,
      }),
    );
    const listed = await api.versions(WORKBOOK);
    expect(listed.map((v) => [v.id, v.size, v.current])).toEqual([
      ['v3', 1200, true],
      ['v2', 1100, false],
      ['v1', 1000, false],
    ]);
    expect(await api.versionContent(WORKBOOK, 'v2')).toEqual({
      readUrl: 'http://blob/v2',
      etag: '"v2"',
      versionId: 'v2',
      size: 1100,
      expiresAt: null,
    });
    expect(await api.restoreVersion(WORKBOOK, 'v2', '"v3"')).toEqual({
      versionId: 'v4',
      etag: '"v4"',
    });
    const restore = server.requests.find((r) => r.url.pathname.endsWith('/restore'))!;
    expect(restore.method).toBe('POST');
    expect(restore.headers.get('If-Match')).toBe('"v3"');
    expect(restore.headers.get('X-CSRF-TOKEN')).toBe('csrf');
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 9]);
    await api.uploadVersion(WORKBOOK, bytes, null);
    const upload = server.requests.find(
      (r) => r.method === 'POST' && r.url.pathname.endsWith('/versions'),
    )!;
    expect(upload.headers.get('Content-Type')).toBe(XLSX_TYPE);
    expect(upload.headers.get('If-None-Match')).toBe('*');
    expect(upload.headers.get('If-Match')).toBeNull();
    expect([...(upload.body as Uint8Array)]).toEqual([...bytes]);
    await api.uploadVersion(WORKBOOK, bytes, '"v1"');
    const later = server.requests
      .filter((r) => r.method === 'POST' && r.url.pathname.endsWith('/versions'))
      .at(-1)!;
    expect(later.headers.get('If-Match')).toBe('"v1"');
    expect(later.headers.get('If-None-Match')).toBeNull();
  });

  it('ask the desktop target by name, and the web link with no body as before', async () => {
    const server = fakeServer();
    const api = workbookApi(
      createApi({
        baseUrl: 'http://api.test',
        auth: { kind: 'cookie' },
        fetch: server.fetch as never,
      }),
    );
    expect(await api.launch(WORKBOOK, 'desktop')).toBe(
      `cashgear-sheet://workspace/launch#ticket=${TICKET}`,
    );
    expect(server.requests.at(-1)!.body).toEqual({ target: 'desktop' });
    expect(await api.launch(WORKBOOK)).toBe(`${ORIGIN}/cloud#launch=${TICKET}`);
    const web = server.requests.at(-1)!;
    expect(web.body === null || (web.body as Uint8Array).length === 0).toBe(true);
  });
});

describe('Open in Cash Gear Sheet', () => {
  const DESKTOP_LINK = `cashgear-sheet://workspace/launch#ticket=${TICKET}`;
  const WEB_LINK = `${ORIGIN}/cloud#launch=${TICKET}`;
  const apiWith = (desktop = DESKTOP_LINK) =>
    ({
      launch: vi.fn(async (_id: string, target = 'web') =>
        target === 'desktop' ? desktop : WEB_LINK,
      ),
    }) as unknown as WorkbookApi;

  it('knows the desktop link’s exact shape', () => {
    expect(isDesktopLaunch(DESKTOP_LINK)).toBe(true);
    for (const link of [
      WEB_LINK,
      `${DESKTOP_LINK}&x=1`,
      `cashgear-sheet://workspace/launch#ticket=${TICKET.slice(1)}`,
      `cashgear-sheet://erp/launch#ticket=${TICKET}`,
      `CASHGEAR-SHEET://workspace/launch#ticket=${TICKET}`,
    ])
      expect(isDesktopLaunch(link), link).toBe(false);
  });

  it('opens Sheet’s desktop app when the system has it', async () => {
    const api = apiWith();
    const open = vi.fn(async () => {});
    const openExternal = vi.fn(async () => {});
    await openInSheet(api, WORKBOOK, {
      kind: 'desktop',
      sheetOrigin: ORIGIN,
      openExternal,
      sheetApp: { installed: async () => true, open },
    });
    expect(api.launch).toHaveBeenCalledWith(WORKBOOK, 'desktop');
    expect(open).toHaveBeenCalledWith(DESKTOP_LINK);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens Sheet’s web app when it is missing, or the server answers a web link', async () => {
    for (const installed of [false, 'throws'] as const) {
      const api = apiWith();
      const open = vi.fn(async () => {});
      const openExternal = vi.fn(async () => {});
      await openInSheet(api, WORKBOOK, {
        kind: 'desktop',
        sheetOrigin: ORIGIN,
        openExternal,
        sheetApp: {
          installed: async () => {
            if (installed === 'throws') throw new Error('no');
            return installed;
          },
          open,
        },
      });
      expect(api.launch).toHaveBeenCalledWith(WORKBOOK);
      expect(openExternal).toHaveBeenCalledWith(WEB_LINK);
      expect(open).not.toHaveBeenCalled();
    }
    // A server that knows no desktop target answers its web link: opened in the browser.
    const older = apiWith(WEB_LINK);
    const openExternal = vi.fn(async () => {});
    const open = vi.fn(async () => {});
    await openInSheet(older, WORKBOOK, {
      kind: 'desktop',
      sheetOrigin: ORIGIN,
      openExternal,
      sheetApp: { installed: async () => true, open },
    });
    expect(openExternal).toHaveBeenCalledWith(WEB_LINK);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses any other link, and opens a tab in a browser as before', async () => {
    const wrong = apiWith('https://evil.example/cloud#launch=x');
    const open = vi.fn(async () => {});
    await expect(
      openInSheet(wrong, WORKBOOK, {
        kind: 'desktop',
        sheetOrigin: ORIGIN,
        openExternal: vi.fn(async () => {}),
        sheetApp: { installed: async () => true, open },
      }),
    ).rejects.toThrow('not on Sheet');
    expect(open).not.toHaveBeenCalled();
    const tab = vi.fn();
    const sheetApp = { installed: vi.fn(async () => true), open };
    await openInSheet(
      apiWith(),
      WORKBOOK,
      { kind: 'web', sheetOrigin: ORIGIN, openExternal: vi.fn(async () => {}), sheetApp },
      tab,
    );
    expect(tab).toHaveBeenCalledWith(WEB_LINK);
    // A browser never asks for the desktop app.
    expect(sheetApp.installed).not.toHaveBeenCalled();
  });
});
