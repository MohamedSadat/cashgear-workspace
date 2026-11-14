// Workbooks in the shell (Phase 5): the block's states (jsdom, a stand-in for SheetEmbed and for
// the workbook routes), its live embed and pictures, the picture cache on this device, the frame's
// mount, update and destroy, the view picker, the workbook list's calls (over the real API client
// and a fake fetch), the routes' request shapes, and the block on a page shared by link.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createApi } = await import('@cgw/api');
const { MemoryStore, SyncHttpError } = await import('@cgw/workspace');
const { viewHash } = await import('@cgw/editor');
const { createI18n } = await import('../i18n');
const { ShellContext } = await import('../context');
const { mountWorkbook } = await import('./mount');
const { WorkbookPictures, pictureAssetId, picturePref } = await import('./pictures');
const { blockView, drawnIs, previewRequest } = await import('./view');
const { workbookApi } = await import('./api');
const { noAccessWorkbooks } = await import('./shared');
const { WorkbooksView } = await import('./WorkbooksView');
type WorkbookApi = import('./api').WorkbookApi;
type Workbook = import('./api').Workbook;
type EmbedFactory = import('./SheetBlock').EmbedFactory;
type SheetEmbedEvents = import('@cgw/editor').SheetEmbedEvents;
type SheetEmbedOptions = import('@cgw/editor').SheetEmbedOptions;
type SheetMountOptions = import('@cgw/editor').SheetMountOptions;
type SheetView = import('@cgw/editor').SheetView;
type WorkspaceSession = import('../session').WorkspaceSession;

const WS = '01936f6e-0000-7000-8000-00000000a001';
const WORKBOOK = '01936f6e-0000-7000-8000-00000000a002';
const ORIGIN = 'http://127.0.0.1:4283';
const LAUNCH = `${ORIGIN}/cloud#launch=${'a'.repeat(43)}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const book = (over: Partial<Workbook> = {}): Workbook => ({
  id: WORKBOOK,
  workspaceId: WS,
  name: 'Budget 2026',
  version: 3,
  versionId: 'v1',
  etag: '"v1"',
  size: 1000,
  savedAt: '2026-11-14T10:00:00Z',
  savedBy: { id: 'u1', name: 'Ada' },
  createdBy: 'u1',
  createdAt: '2026-11-01T10:00:00Z',
  trashedAt: null,
  access: 'edit',
  ...over,
});

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 400 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const fakeSession = (over: Record<string, unknown> = {}) =>
  ({
    current: { localOnly: false, role: 'member' },
    workspaceId: WS,
    mirror: { subscribe: () => () => {} },
    ...over,
  }) as unknown as WorkspaceSession;

function fakeCloud(state = 'synced', account: unknown = { id: 'u1' }, api: unknown = null) {
  const listeners = new Set<() => void>();
  const cloud = {
    account,
    status: { state },
    api,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signIn: vi.fn(async () => {}),
    members: vi.fn(async () => []),
    change(next: { account?: unknown; state?: string }) {
      if ('account' in next) cloud.account = next.account;
      if (next.state) cloud.status = { state: next.state };
      for (const listener of listeners) listener();
    },
  };
  return cloud;
}

function fakeApi(over: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async () => book()),
    content: vi.fn(async () => ({
      readUrl: `http://127.0.0.1:10000/devstoreaccount1/v1.xlsx?sig=${Math.random()}`,
      etag: '"v1"',
      versionId: 'v1',
      size: 1000,
      expiresAt: null,
    })),
    picture: vi.fn(async () => null),
    putPicture: vi.fn(async () => {}),
    launch: vi.fn(async () => LAUNCH),
    update: vi.fn(async (_id: string, change: { trashed?: boolean }) =>
      book({ trashedAt: change.trashed ? '2026-11-14T11:00:00Z' : null, version: 4 }),
    ),
    sheets: vi.fn(async () => [{ name: 'Budget', usedRange: 'A1:D9', hidden: false }]),
    ...over,
  };
}

interface Made {
  container: HTMLElement;
  options: SheetEmbedOptions;
  events: SheetEmbedEvents;
  setView: SheetView[];
  refresh: unknown[];
  setTheme: unknown[];
  previews: unknown[];
  destroyed: boolean;
}

function fakeEmbeds() {
  const made: Made[] = [];
  const factory: EmbedFactory = (container, options, events) => {
    const frame = document.createElement('iframe');
    frame.title = options.title;
    container.append(frame);
    const entry: Made = {
      container,
      options,
      events,
      setView: [],
      refresh: [],
      setTheme: [],
      previews: [],
      destroyed: false,
    };
    made.push(entry);
    return {
      frame,
      setView: (view) => void entry.setView.push(view),
      setTheme: (look) => void entry.setTheme.push(look),
      refresh: (source) => void entry.refresh.push(source),
      requestPreview: async (request) => {
        entry.previews.push(request);
        return {
          bytes: PNG.slice().buffer,
          width: request.maxWidth,
          height: 100,
          etag: '"v1"',
          view: { kind: 'range', sheet: 'Budget', range: 'A1:D9' },
        };
      },
      destroy: () => {
        entry.destroyed = true;
        frame.remove();
      },
    };
  };
  return { factory, made };
}

const LOADED = {
  etag: '"v1"',
  view: { kind: 'range', sheet: 'Budget', range: 'A1:D9' } as SheetView,
  sheets: [
    { name: 'Budget', direction: 'ltr' as const },
    { name: 'الميزانية', direction: 'rtl' as const },
  ],
  charts: [],
  size: { width: 600, height: 900 },
  capped: false,
};

const roots: { destroy(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function options(over: Partial<SheetMountOptions> = {}): SheetMountOptions {
  return {
    workbookId: WORKBOOK,
    sheet: null,
    range: null,
    chartId: null,
    height: null,
    blockId: 'AbCdEfGhIjKl',
    editable: true,
    setAttrs: vi.fn(),
    ...over,
  };
}

async function draw(
  setup: {
    api?: ReturnType<typeof fakeApi>;
    cloud?: ReturnType<typeof fakeCloud>;
    session?: WorkspaceSession;
    store?: InstanceType<typeof MemoryStore>;
    language?: 'en' | 'ar';
    sheetOrigin?: string;
    options?: Partial<SheetMountOptions>;
  } = {},
) {
  const api = setup.api ?? fakeApi();
  const cloud = setup.cloud ?? fakeCloud();
  const store = setup.store ?? new MemoryStore();
  const embeds = fakeEmbeds();
  const openTab = vi.fn();
  const platform = {
    kind: 'web' as const,
    sheetOrigin: setup.sheetOrigin ?? ORIGIN,
    openExternal: vi.fn(async () => {}),
  };
  const i18n = createI18n(setup.language ?? 'en');
  const element = document.createElement('div');
  document.body.append(element);
  const first = options(setup.options);
  let frame!: ReturnType<typeof mountWorkbook>;
  await act(async () => {
    frame = mountWorkbook(element, first, {
      session: setup.session ?? fakeSession(),
      cloud: { get: () => cloud as never, subscribe: () => () => {} },
      platform,
      theme: { theme: 'light', subscribe: () => () => {} },
      pictures: new WorkbookPictures(store),
      pageId: null,
      api: api as unknown as WorkbookApi,
      embed: embeds.factory,
      openTab,
      i18n,
    });
  });
  roots.push(frame);
  const block = () => element.querySelector<HTMLElement>('.cgw-sheet')!;
  const state = () => block()?.dataset.state;
  const text = () => block()?.textContent ?? '';
  const button = (label: string) =>
    [...element.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
  return {
    api,
    cloud,
    store,
    embeds,
    openTab,
    platform,
    element,
    frame,
    first,
    block,
    state,
    text,
    button,
  };
}

describe('previews and views', () => {
  it('asks for the frame at the screen density, at most 2, within 4,096 device pixels', () => {
    expect(previewRequest(800, 400, 2)).toEqual({ maxWidth: 800, maxHeight: 400, scale: 2 });
    expect(previewRequest(800, 400, 3)).toEqual({ maxWidth: 800, maxHeight: 400, scale: 2 });
    expect(previewRequest(2500, 480, 2)).toEqual({ maxWidth: 2500, maxHeight: 480, scale: 1.5 });
    expect(previewRequest(3000, 480, 2)).toEqual({ maxWidth: 3000, maxHeight: 480, scale: 1 });
    expect(previewRequest(900, 2100, 2)).toEqual({ maxWidth: 900, maxHeight: 2100, scale: 1.5 });
    expect(previewRequest(9000, 9000, 1)).toEqual({ maxWidth: 4096, maxHeight: 4096, scale: 1 });
    expect(previewRequest(0, 3.4, 1.5)).toEqual({ maxWidth: 16, maxHeight: 16, scale: 1.5 });
    for (const [w, hgt, dpr] of [
      [4096, 4096, 3],
      [2049, 10, 2],
      [100, 2731, 1.5],
    ]) {
      const r = previewRequest(w, hgt, dpr);
      expect(r.maxWidth * r.scale).toBeLessThanOrEqual(4096);
      expect(r.maxHeight * r.scale).toBeLessThanOrEqual(4096);
    }
  });

  it("knows the block's view in what the embed drew", () => {
    const range = blockView({ sheet: null, range: null, chartId: null });
    expect(range).toEqual({ kind: 'range', sheet: null, range: null });
    expect(blockView({ sheet: 'S', range: 'A1', chartId: 'Chart 1' })).toEqual({
      kind: 'chart',
      sheet: 'S',
      chartId: 'Chart 1',
    });
    const drawn: SheetView = { kind: 'range', sheet: 'Budget', range: 'A1:D9' };
    expect(drawnIs(drawn, range)).toBe(true);
    expect(drawnIs(drawn, { kind: 'range', sheet: 'budget', range: 'D9:A1' })).toBe(true);
    expect(drawnIs(drawn, { kind: 'range', sheet: 'Other', range: null })).toBe(false);
    expect(drawnIs(drawn, { kind: 'range', sheet: null, range: 'A1:D8' })).toBe(false);
    expect(drawnIs(drawn, { kind: 'chart', sheet: null, chartId: 'Chart 1' })).toBe(false);
  });
});

describe('the picture cache', () => {
  it('keeps one picture per block view as an uploaded asset with a derived id, and a pref', async () => {
    const store = new MemoryStore();
    const pictures = new WorkbookPictures(store);
    const hash = await viewHash({ kind: 'range', sheet: null, range: null });
    const id = await pictureAssetId(WORKBOOK, hash);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await pictureAssetId(WORKBOOK, hash)).toBe(id);
    expect(await pictureAssetId(WORKBOOK, hash.replace(/.$/, '0'))).not.toBe(id);
    expect(await pictures.get(WORKBOOK, hash)).toBeNull();
    const meta = await pictures.put({ id: WORKBOOK, workspaceId: WS }, hash, PNG, {
      madeAt: '2026-11-14T10:00:00.000Z',
      versionId: 'v1',
      etag: '"v1"',
      width: 600,
      height: 100,
    });
    expect(meta.assetId).toBe(id);
    expect(await store.getPref(picturePref(WORKBOOK, hash))).toEqual({
      assetId: id,
      madeAt: '2026-11-14T10:00:00.000Z',
      versionId: 'v1',
      etag: '"v1"',
      width: 600,
      height: 100,
    });
    const snapshot = await store.readMirror(WS);
    const asset = snapshot.assets.find((a) => a.id === id)!;
    expect(asset).toMatchObject({ uploaded: true, contentType: 'image/png', workspaceId: WS });
    // A newer picture of the same view replaces it in place.
    await pictures.put({ id: WORKBOOK, workspaceId: WS }, hash, PNG.slice(0, 10), {
      madeAt: '2026-11-14T11:00:00.000Z',
      versionId: 'v2',
      etag: '"v2"',
    });
    const kept = (await pictures.get(WORKBOOK, hash))!;
    expect(kept.meta.etag).toBe('"v2"');
    expect(kept.bytes).toHaveLength(10);
    expect((await store.readMirror(WS)).assets.filter((a) => a.id === id)).toHaveLength(1);
  });
});

describe('a workbook block', { timeout: 30_000 }, () => {
  it('shows the live embed from the Sheet origin, sized to its view, and sends a picture', async () => {
    const view = await draw();
    await until(() => view.embeds.made.length === 1, 'the embed');
    const made = view.embeds.made[0];
    expect(made.options).toMatchObject({
      sheetOrigin: ORIGIN,
      source: { kind: 'url', etag: '"v1"' },
      view: { kind: 'range', sheet: null, range: null },
      theme: 'light',
      direction: 'ltr',
      locale: 'en',
    });
    expect(made.options.title).toContain('Budget 2026');
    expect(view.state()).toBe('connecting');
    expect(view.text()).toContain('Budget 2026');
    expect(view.text()).toContain('Saved');
    expect(view.text()).toContain('by Ada');
    const live = view.element.querySelector<HTMLElement>('.cgw-sheet-live')!;
    expect(live.dataset.shown).toBeUndefined();
    await act(async () => made.events.loaded!(LOADED));
    expect(view.state()).toBe('loaded');
    expect(live.dataset.shown).toBe('true');
    // Up to the block's height (480 by default), the embed scrolls inside past it.
    expect(live.style.blockSize).toBe('480px');
    await act(async () => made.events.resize!({ width: 600, height: 200 }));
    expect(live.style.blockSize).toBe('200px');
    // An editor of the workbook sends the picture of the version and keeps it here.
    await until(() => view.api.putPicture.mock.calls.length === 1, 'the picture');
    expect(made.previews).toEqual([{ maxWidth: 600, maxHeight: 480, scale: 1 }]);
    const hash = await viewHash({ kind: 'range', sheet: null, range: null });
    expect(view.api.putPicture.mock.calls[0]).toEqual([WORKBOOK, hash, PNG, 'v1']);
    const pref = await view.store.getPref<{ etag: string }>(picturePref(WORKBOOK, hash));
    expect(pref?.etag).toBe('"v1"');
    // The same version and view again: no second picture.
    await act(async () => made.events.loaded!(LOADED));
    expect(made.previews).toHaveLength(1);
  });

  it('sends another view to the same embed, and asks a reader for a picture it only keeps', async () => {
    const api = fakeApi({ get: vi.fn(async () => book({ access: 'view' })) });
    const view = await draw({ api });
    await until(() => view.embeds.made.length === 1, 'the embed');
    const made = view.embeds.made[0];
    await act(async () => made.events.loaded!(LOADED));
    await until(() => made.previews.length === 1, 'the preview');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(api.putPicture).not.toHaveBeenCalled();
    const hash = await viewHash({ kind: 'range', sheet: null, range: null });
    expect(await view.store.getPref(picturePref(WORKBOOK, hash))).toBeTruthy();
    await act(async () => view.frame.update(options({ sheet: 'Budget', range: 'B2:C5' })));
    expect(made.setView).toEqual([{ kind: 'range', sheet: 'Budget', range: 'B2:C5' }]);
    expect(view.embeds.made).toHaveLength(1);
    expect(view.state()).toBe('connecting');
  });

  it('says when the reader has no access, and shows no picture, even one this device kept', async () => {
    const store = new MemoryStore();
    const hash = await viewHash({ kind: 'range', sheet: null, range: null });
    await new WorkbookPictures(store).put({ id: WORKBOOK, workspaceId: WS }, hash, PNG, {
      madeAt: '2026-11-13T10:00:00Z',
      versionId: 'v1',
      etag: '"v1"',
    });
    const api = fakeApi({
      get: vi.fn(async () => {
        throw new SyncHttpError(404, 'not.found', 'No such workbook');
      }),
    });
    const view = await draw({ api, store });
    await until(() => view.state() === 'noAccess', 'no access');
    expect(view.text()).toContain("You don't have access to this workbook");
    expect(view.element.querySelector('img')).toBeNull();
    expect(view.embeds.made).toHaveLength(0);
    expect(api.content).not.toHaveBeenCalled();
  });

  it('in the trash: says so and restores for an editor; empty: only "Open in Cash Gear Sheet"', async () => {
    const api = fakeApi({
      get: vi.fn(async () => book({ trashedAt: '2026-11-14T09:00:00Z' })),
    });
    const trashed = await draw({ api });
    await until(() => trashed.state() === 'trashed', 'the trash');
    expect(trashed.text()).toContain('This workbook is in the trash.');
    expect(trashed.button('Open in Cash Gear Sheet')).toBeUndefined();
    await act(async () => trashed.button('Restore')!.click());
    expect(api.update).toHaveBeenCalledWith(WORKBOOK, { trashed: false }, 3);
    await until(() => trashed.embeds.made.length === 1, 'the embed after restoring');

    const empty = await draw({
      api: fakeApi({
        get: vi.fn(async () => book({ versionId: null, etag: null, savedAt: null, savedBy: null })),
      }),
    });
    await until(() => empty.state() === 'empty', 'empty');
    expect(empty.text()).toContain('This workbook is empty.');
    expect(empty.text()).toContain('Empty workbook');
    expect(empty.button('Refresh')).toBeUndefined();
    await act(async () => empty.button('Open in Cash Gear Sheet')!.click());
    await until(() => empty.openTab.mock.calls.length === 1, 'the launch');
    expect(empty.openTab).toHaveBeenCalledWith(LAUNCH);
    expect(empty.embeds.made).toHaveLength(0);
  });

  it('opens Sheet only on its own origin; the desktop opens the system browser', async () => {
    const api = fakeApi({ launch: vi.fn(async () => 'https://evil.example/cloud#launch=x') });
    const view = await draw({ api });
    await until(() => !!view.button('Open in Cash Gear Sheet'), 'the button');
    await act(async () => view.button('Open in Cash Gear Sheet')!.click());
    await until(() => view.text().includes('could not be opened'), 'the refusal');
    expect(view.openTab).not.toHaveBeenCalled();
  });

  it('local workspace, signed out, offline: each says so; offline shows the kept picture', async () => {
    const local = await draw({ session: fakeSession({ current: { localOnly: true } }) });
    expect(local.state()).toBe('local');
    expect(local.text()).toContain('sign in and upload this workspace');
    expect(local.api.get).not.toHaveBeenCalled();

    const signedOut = await draw({ cloud: fakeCloud('signedOut', null) });
    expect(signedOut.state()).toBe('signedOut');
    expect(signedOut.text()).toContain('Sign in to use them');
    await act(async () => signedOut.button('Sign in')!.click());
    expect(signedOut.cloud.signIn).toHaveBeenCalledWith('en');

    const none = await draw({ cloud: fakeCloud('offline') });
    expect(none.text()).toContain('Workbooks need a connection.');
    expect(none.api.get).not.toHaveBeenCalled();

    const store = new MemoryStore();
    const hash = await viewHash({ kind: 'range', sheet: null, range: null });
    await new WorkbookPictures(store).put({ id: WORKBOOK, workspaceId: WS }, hash, PNG, {
      madeAt: '2026-11-13T10:00:00Z',
      versionId: 'v1',
      etag: '"v1"',
      name: 'Budget 2026',
    });
    const offline = await draw({ cloud: fakeCloud('offline'), store });
    await until(() => !!offline.element.querySelector('img'), 'the picture');
    expect(offline.text()).toContain('Offline: the picture from');
    // The name kept with the picture, as the server last said it.
    expect(offline.text()).toContain('Budget 2026');
    expect(offline.text()).not.toContain('Workbooks need a connection.');
    expect(offline.element.querySelector('img')!.getAttribute('alt')).toContain('Picture');
    // Back online: the record, then the live embed.
    await act(async () => offline.cloud.change({ state: 'synced' }));
    await until(() => offline.embeds.made.length === 1, 'the embed once online');
  });

  it('asks for one new URL when the old one expired, then says the live view failed', async () => {
    const view = await draw();
    await until(() => view.embeds.made.length === 1, 'the embed');
    const made = view.embeds.made[0];
    await act(async () => made.events.error!({ code: 'source.forbidden', message: '' }));
    await until(() => made.refresh.length === 1, 'the refresh');
    expect(view.api.content).toHaveBeenCalledTimes(2);
    await act(async () => made.events.error!({ code: 'source.forbidden', message: '' }));
    expect(made.refresh).toHaveLength(1);
    expect(view.state()).toBe('error:source.unavailable');
    expect(view.text()).toContain("Couldn't load the live view.");
    // Refresh: the record and a fresh URL again.
    await act(async () => view.button('Refresh')!.click());
    await until(() => made.refresh.length === 2, 'the second refresh');
    expect(view.api.get).toHaveBeenCalledTimes(2);
  });

  it('each embed error has its own words; a missing view offers the view picker', async () => {
    const view = await draw();
    await until(() => view.embeds.made.length === 1, 'the embed');
    const made = view.embeds.made[0];
    const say = async (code: string) =>
      act(async () => made.events.error!({ code: code as never, message: '' }));
    await say('workbook.tooLarge');
    expect(view.text()).toContain('too large to show here (20 MB at most)');
    await say('contract.unsupported');
    expect(view.text()).toContain('This version of Cash Gear Sheet cannot be shown here.');
    await say('range.tooLarge');
    expect(view.text()).toContain('5,000 cells at most');
    await say('view.notFound');
    expect(view.text()).toContain('This sheet or chart is no longer in the workbook.');
    await act(async () => view.button('Change the view')!.click());
    const form = view.element.querySelector<HTMLFormElement>('.cgw-sheet-picker')!;
    expect(form).not.toBeNull();
    await until(() => view.api.sheets.mock.calls.length === 1, 'the sheets');
    const range = form.querySelector<HTMLInputElement>('input[placeholder="A1:D20"]')!;
    const height = form.querySelector<HTMLInputElement>('input[type="number"]')!;
    const type = async (input: HTMLInputElement, value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await type(range, 'ZZ');
    await act(async () => view.button('Show')!.click());
    expect(view.text()).toContain('Write the range in A1 notation');
    await type(range, 'a1:zz200');
    await act(async () => view.button('Show')!.click());
    expect(view.text()).toContain('at most 5,000 cells');
    await type(range, 'b2:c5');
    await type(height, '300');
    await act(async () => view.button('Show')!.click());
    expect(view.first.setAttrs).toHaveBeenCalledWith({
      sheet: null,
      range: 'B2:C5',
      chartId: null,
      height: 300,
    });
  });

  it('is drawn right to left in Arabic, and the embed is told the page’s language', async () => {
    const view = await draw({ language: 'ar' });
    await until(() => view.embeds.made.length === 1, 'the embed');
    const container = view.element.querySelector<HTMLElement>('.cgw-sheet-block')!;
    expect(container.dir).toBe('rtl');
    expect(container.lang).toBe('ar');
    expect(view.embeds.made[0].options).toMatchObject({ direction: 'rtl', locale: 'ar' });
    expect(view.button('فتح في Cash Gear Sheet')).toBeDefined();
  });

  it('is gone from the page at once when the editor destroys it', async () => {
    const view = await draw();
    await until(() => view.embeds.made.length === 1, 'the embed');
    view.frame.destroy();
    expect(view.element.childElementCount).toBe(0);
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(view.embeds.made[0].destroyed).toBe(true);
    // Twice is harmless.
    view.frame.destroy();
  });
});

describe('a workbook on a page shared by link', () => {
  it('says the reader has no access, with no picture', () => {
    const element = document.createElement('div');
    const host = noAccessWorkbooks("You don't have access to this workbook");
    const frame = host.mount!(element, options());
    expect(element.textContent).toBe("You don't have access to this workbook");
    expect(element.querySelector('img, iframe')).toBeNull();
    frame.destroy();
    expect(element.childElementCount).toBe(0);
  });
});

/** The Workspace API as a fake fetch: answers by method and path, and records each request. */
function fakeServer(workbooks: Workbook[]) {
  const requests: { method: string; url: URL; headers: Headers; body: unknown }[] = [];
  const fetch = async (given: Request | string, init?: RequestInit) => {
    const input = typeof given === 'string' ? new Request(given, init) : given;
    const url = new URL(input.url);
    const raw = input.method === 'GET' ? null : new Uint8Array(await input.arrayBuffer());
    const type = input.headers.get('Content-Type') ?? '';
    const body = raw && type.includes('json') ? JSON.parse(new TextDecoder().decode(raw)) : raw;
    requests.push({ method: input.method, url, headers: input.headers, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.pathname === '/api/v1/account/antiforgery') return json({ token: 'csrf' });
    if (url.pathname === `/api/v1/workspaces/${WS}/workbooks`)
      return json({
        workbooks: workbooks.filter((w) =>
          url.searchParams.get('trashed') === 'true' ? w.trashedAt : !w.trashedAt,
        ),
      });
    const one = /^\/api\/v1\/workbooks\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (one && input.method === 'PATCH') {
      const found = workbooks.find((w) => w.id === one[1])!;
      const change = body as { name: string | null; trashed: boolean | null };
      if (change.name) found.name = change.name;
      if (change.trashed !== null)
        found.trashedAt = change.trashed ? new Date().toISOString() : null;
      found.version++;
      return json(found);
    }
    if (one && one[2]?.startsWith('/previews/') && input.method === 'PUT')
      return new Response(null, { status: 204 });
    return json({ code: 'not.found', title: 'No' }, 404);
  };
  return { fetch, requests };
}

describe('the workbook routes', () => {
  it('send a picture as PNG with its version, and changes with the record version', async () => {
    const server = fakeServer([book()]);
    const api = workbookApi(
      createApi({
        baseUrl: 'http://api.test',
        auth: { kind: 'cookie' },
        fetch: server.fetch as never,
      }),
    );
    await api.putPicture(WORKBOOK, 'a'.repeat(64), PNG, 'v1');
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect(put.url.pathname).toBe(`/api/v1/workbooks/${WORKBOOK}/previews/${'a'.repeat(64)}`);
    expect(put.headers.get('Content-Type')).toBe('image/png');
    expect(put.headers.get('X-Workbook-Version')).toBe('v1');
    expect([...(put.body as Uint8Array)]).toEqual([...PNG]);
    const renamed = await api.update(WORKBOOK, { name: 'Plan' }, 3);
    const patch = server.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.headers.get('If-Match')).toBe('"3"');
    expect(patch.body).toEqual({ name: 'Plan', trashed: null });
    expect(renamed).toMatchObject({ name: 'Plan', version: 4 });
    await expect(api.get('01936f6e-0000-7000-8000-00000000ffff')).rejects.toMatchObject({
      status: 404,
      code: 'not.found',
    });
  });
});

describe('the workbook list', { timeout: 30_000 }, () => {
  it('lists, renames, trashes and restores by the routes', async () => {
    const books = [
      book(),
      book({ id: '01936f6e-0000-7000-8000-00000000a003', name: 'Stock', access: 'view' }),
    ];
    const server = fakeServer(books);
    const api = createApi({
      baseUrl: 'http://api.test',
      auth: { kind: 'cookie' },
      fetch: server.fetch as never,
    });
    const cloud = fakeCloud('synced', { id: 'u1' }, api);
    const i18n = createI18n('en');
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    roots.push({ destroy: () => root.unmount() });
    const services = {
      platform: { kind: 'web', sheetOrigin: ORIGIN, openExternal: vi.fn() },
    } as never;
    await act(async () =>
      root.render(
        h(
          I18nextProvider,
          { i18n },
          h(
            ShellContext.Provider,
            { value: services },
            h(WorkbooksView, { session: fakeSession(), cloud: cloud as never }),
          ),
        ),
      ),
    );
    await until(() => !!element.querySelector('[data-testid="workbooks-table"]'), 'the list');
    const rows = () => [...element.querySelectorAll('tbody tr')].map((r) => r.textContent);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain('Budget 2026');
    expect(rows()[0]).toContain('Can edit');
    // A reader may open and see the access list, but not rename or trash.
    const stock = element.querySelector('[data-workbook="01936f6e-0000-7000-8000-00000000a003"]')!;
    expect(stock.querySelectorAll('button')).toHaveLength(2);
    const byLabel = (label: string) =>
      element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    await act(async () => byLabel('Move to the trash: Budget 2026').click());
    await until(() => rows().length === 1, 'the list without it');
    const patch = server.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.url.pathname).toBe(`/api/v1/workbooks/${WORKBOOK}`);
    expect(patch.headers.get('If-Match')).toBe('"3"');
    expect(patch.body).toEqual({ name: null, trashed: true });
    expect(patch.headers.get('X-CSRF-TOKEN')).toBe('csrf');
    // The trash, and back.
    const trashTab = [...element.querySelectorAll('button')].find(
      (b) => b.textContent === 'Trash',
    )!;
    await act(async () => trashTab.click());
    await until(() => rows().length === 1 && rows()[0]!.includes('Budget 2026'), 'the trash');
    expect(
      server.requests.some(
        (r) => r.method === 'GET' && r.url.searchParams.get('trashed') === 'true',
      ),
    ).toBe(true);
    await act(async () => byLabel('Restore Budget 2026').click());
    await until(() => !books[0].trashedAt, 'restored');
    expect(server.requests.filter((r) => r.method === 'PATCH').at(-1)!.body).toEqual({
      name: null,
      trashed: false,
    });
    // Search filters by name.
    const live = [...element.querySelectorAll('button')].find(
      (b) => b.textContent === 'Workbooks',
    )!;
    await act(async () => live.click());
    await until(() => rows().length === 2, 'both again');
    const search = element.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'sto',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Stock');
  });

  // WCAG 2.5.3 (Axe's label-content-name-mismatch, found by tests/e2e/a11y.spec.ts): a button
  // named for its row says what it shows, so a person who says its words reaches it.
  it.each(['en', 'ar'] as const)(
    "names each row's buttons by their visible words, then the workbook (%s)",
    async (language) => {
      const books = [book()];
      const api = createApi({
        baseUrl: 'http://api.test',
        auth: { kind: 'cookie' },
        fetch: fakeServer(books).fetch as never,
      });
      const cloud = fakeCloud('synced', { id: 'u1' }, api);
      const element = document.createElement('div');
      document.body.append(element);
      const root = createRoot(element);
      roots.push({ destroy: () => root.unmount() });
      const services = {
        platform: { kind: 'web', sheetOrigin: ORIGIN, openExternal: vi.fn() },
      } as never;
      await act(async () =>
        root.render(
          h(
            I18nextProvider,
            { i18n: createI18n(language) },
            h(
              ShellContext.Provider,
              { value: services },
              h(WorkbooksView, { session: fakeSession(), cloud: cloud as never }),
            ),
          ),
        ),
      );
      await until(() => !!element.querySelector('tbody tr button'), 'the row');
      const buttons = [...element.querySelectorAll<HTMLButtonElement>('tbody tr button')];
      expect(buttons.length).toBeGreaterThanOrEqual(4);
      for (const button of buttons) {
        const label = button.getAttribute('aria-label')!;
        expect(label.startsWith(button.textContent!), `${label} / ${button.textContent}`).toBe(
          true,
        );
        expect(label).toContain('Budget 2026');
      }
    },
  );
});
