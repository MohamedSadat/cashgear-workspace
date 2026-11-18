// Phase 10, M10.4 and M10.5: third-party plugins in the client. The routes' requests and answers
// (the zip as the body, a refused bundle's problems, no answer at all), the workspace's list (read
// once, forced, the same object until it changes), the bundle read on the device by the server's
// rules (every refusal, nothing unpacked but the manifest), each block's availability (installed,
// off, missing, offline, signed out, a local workspace, another workspace's page, a share link)
// and its frame's address, the slash menu's entries by the manifests' names, the editor host for
// both kinds of plugin, and Settings' section (the list, add after review, update, on and off,
// remove after asking, members read-only), in English and Arabic.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { zipSync, strToU8 } = await import('fflate');
const { createApi } = await import('@cgw/api');
const { createI18n } = await import('../i18n');
const { CommandRegistry } = await import('../commands');
const { pluginApi, PluginRequestError } = await import('./api');
const { PluginsStore } = await import('./store');
const { readBundle } = await import('./bundle');
const { PluginServices, SHARED_SOURCE } = await import('./services');
const { registerThirdPartyCommands } = await import('./commands');
const { pluginsHost, pluginsOriginOf, SHARED_THIRD_PARTY } = await import('./host');
const { PluginsSection } = await import('./PluginsSettings');
type WorkspacePlugin = import('./api').WorkspacePlugin;
type PluginApi = import('./api').PluginApi;
type WorkspaceSession = import('../session').WorkspaceSession;
type Cloud = import('../cloud/cloud').Cloud;
type ShellServices = import('../context').ShellServices;

const WS = '01936f6e-0000-7000-8000-0000000a0001';
const OTHER_WS = '01936f6e-0000-7000-8000-0000000a0002';
const PLUGIN = '01936f6e-0000-7000-8000-0000000b0001';

const plugin = (extra: Partial<WorkspacePlugin> = {}): WorkspacePlugin => ({
  id: PLUGIN,
  type: 'vendor.notes',
  version: 1,
  name: { en: 'Notes', ar: 'ملاحظات' },
  description: null,
  reads: { rows: false },
  height: 240,
  keywords: ['memo'],
  enabled: true,
  sizeBytes: 12_800,
  addedBy: { id: 'u1', name: 'Mona Adel' },
  addedAt: '2026-11-18T09:00:00Z',
  updatedAt: '2026-11-18T09:00:00Z',
  ...extra,
});

const manifest = (extra: Record<string, unknown> = {}) => ({
  contract: 'plugin-frame.1',
  type: 'vendor.notes',
  version: 2,
  name: { en: 'Notes', ar: 'ملاحظات' },
  reads: { rows: true },
  ...extra,
});

/** Text that does not compress (a bomb check would refuse a repeated one first). */
function noise(length: number) {
  let state = 7;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out += String.fromCharCode(97 + ((state >>> 16) % 26));
  }
  return out;
}

/** A bundle's bytes: the files given, by name. */
const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        typeof body === 'string' ? strToU8(body) : body,
      ]),
    ),
  );
const bundle = (extra: Record<string, string | Uint8Array> = {}, m: object = manifest()) =>
  zip({
    'manifest.json': JSON.stringify(m),
    'index.html': '<!doctype html><script src="main.js"></script>',
    'main.js': 'parent.postMessage({type:"ready",contracts:["plugin-frame.1"]},"*")',
    ...extra,
  });

// ---- The routes ----------------------------------------------------------------------------------

function fakeServer() {
  const requests: { method: string; url: URL; headers: Headers; body: Uint8Array | null }[] = [];
  let offline = false;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetch = async (given: Request | string, init?: RequestInit) => {
    if (offline) throw new TypeError('Failed to fetch');
    const input = typeof given === 'string' ? new Request(given, init) : given;
    const url = new URL(input.url);
    const body = input.method === 'GET' ? null : new Uint8Array(await input.arrayBuffer());
    requests.push({ method: input.method, url, headers: input.headers, body });
    if (url.pathname === '/api/v1/account/antiforgery') return json({ token: 'csrf' });
    const base = `/api/v1/workspaces/${WS}/plugins`;
    if (url.pathname === base && input.method === 'GET')
      return json({ plugins: [{ ...plugin(), version: '1', sizeBytes: '12800' }] });
    if (url.pathname === base && input.method === 'POST') {
      const text = new TextDecoder().decode(body!);
      if (text.includes('bad'))
        return json(
          {
            code: 'plugin.invalid',
            title: 'No',
            errors: [{ code: 'file.type', path: 'run.exe' }, { code: 'nonsense' }],
          },
          400,
        );
      if (body!.length > 100_000) return new Response('Too large', { status: 413 });
      return json(plugin({ version: 2 }), text.includes('new') ? 201 : 200);
    }
    if (url.pathname === `${base}/${PLUGIN}` && input.method === 'PATCH')
      return json(plugin({ enabled: false }));
    if (url.pathname === `${base}/${PLUGIN}` && input.method === 'DELETE')
      return new Response(null, { status: 204 });
    if (url.pathname === `${base}/${PLUGIN}/frames`)
      return json({
        url: 'http://localhost:5291/f/ticket/index.html',
        expiresAt: '2026-11-18T09:10:00Z',
      });
    return json({ code: 'not.found', title: 'No' }, 404);
  };
  return {
    fetch,
    requests,
    goOffline: () => (offline = true),
    api: () =>
      pluginApi(
        createApi({ baseUrl: 'http://api.test', auth: { kind: 'cookie' }, fetch: fetch as never }),
      ),
  };
}

describe('the plugin routes', () => {
  it('list, add by the zip, turn off, remove and ask for a frame', async () => {
    const server = fakeServer();
    const api = server.api();
    expect(await api.list(WS)).toEqual([plugin()]);
    const bytes = strToU8('new zip bytes');
    expect(await api.add(WS, bytes)).toEqual({ plugin: plugin({ version: 2 }), created: true });
    const post = server.requests.find(
      (r) => r.method === 'POST' && r.url.pathname.endsWith('/plugins'),
    )!;
    expect(post.headers.get('Content-Type')).toBe('application/zip');
    expect(post.headers.get('X-CSRF-TOKEN')).toBe('csrf');
    expect([...post.body!]).toEqual([...bytes]);
    expect((await api.add(WS, strToU8('an update'))).created).toBe(false);
    expect((await api.setEnabled(WS, PLUGIN, false)).enabled).toBe(false);
    const patch = server.requests.find((r) => r.method === 'PATCH')!;
    expect(JSON.parse(new TextDecoder().decode(patch.body!))).toEqual({ enabled: false });
    await api.remove(WS, PLUGIN);
    expect(await api.frame(WS, PLUGIN)).toEqual({
      url: 'http://localhost:5291/f/ticket/index.html',
      expiresAt: '2026-11-18T09:10:00Z',
    });
  });

  it('refuses with the server’s code and a bundle’s known problems; no answer is offline', async () => {
    const server = fakeServer();
    const api = server.api();
    const invalid = await api.add(WS, strToU8('a bad bundle')).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(PluginRequestError);
    expect(invalid).toMatchObject({
      status: 400,
      code: 'plugin.invalid',
      errors: [{ code: 'file.type', path: 'run.exe' }],
    });
    await expect(api.add(WS, new Uint8Array(200_000))).rejects.toMatchObject({
      status: 413,
      code: 'bundle.tooLarge',
    });
    await expect(api.frame(OTHER_WS, PLUGIN)).rejects.toMatchObject({ status: 404 });
    server.goOffline();
    await expect(api.list(WS)).rejects.toMatchObject({ code: 'offline' });
  });
});

// ---- The list ------------------------------------------------------------------------------------

/** A fake API the test steers: the list it answers, and what it was asked. */
function fakeApi(initial: WorkspacePlugin[] = [plugin()]) {
  let list = initial;
  const calls: string[] = [];
  let failWith: string | null = null;
  const api: PluginApi = {
    list: async () => {
      calls.push('list');
      if (failWith) throw new PluginRequestError(failWith === 'offline' ? 0 : 500, failWith);
      return list;
    },
    add: async (_ws, bytes) => {
      calls.push(`add ${bytes.length}`);
      if (failWith)
        throw new PluginRequestError(400, failWith, [{ code: 'file.name', path: 'a b' }]);
      const added = plugin({ version: 2, reads: { rows: true } });
      list = [added];
      return { plugin: added, created: !initial.length };
    },
    setEnabled: async (_ws, id, enabled) => {
      calls.push(`enabled ${id} ${enabled}`);
      const changed = { ...list.find((p) => p.id === id)!, enabled };
      list = list.map((p) => (p.id === id ? changed : p));
      return changed;
    },
    remove: async (_ws, id) => {
      calls.push(`remove ${id}`);
      list = list.filter((p) => p.id !== id);
    },
    frame: async (ws, id) => {
      calls.push(`frame ${id}`);
      if (failWith) throw new PluginRequestError(failWith === 'offline' ? 0 : 404, failWith);
      return { url: `http://localhost:5291/f/${ws}-${id}/index.html`, expiresAt: '' };
    },
  };
  return {
    api,
    calls,
    set: (next: WorkspacePlugin[]) => (list = next),
    fail: (code: string | null) => (failWith = code),
  };
}

describe('the workspace’s plugin list', () => {
  it('is read once, again when forced, and is the same object until it changes', async () => {
    const fake = fakeApi();
    const store = new PluginsStore(fake.api);
    const idle = store.state(WS);
    expect(idle).toBe(store.state(OTHER_WS));
    expect(idle.status).toBe('idle');
    await Promise.all([store.load(WS), store.load(WS)]);
    expect(fake.calls).toEqual(['list']);
    const ready = store.state(WS);
    expect(ready).toEqual({ status: 'ready', plugins: [plugin()] });
    expect(store.state(WS)).toBe(ready);
    await store.load(WS);
    expect(fake.calls).toEqual(['list']);
    await store.load(WS, true);
    expect(fake.calls).toEqual(['list', 'list']);
    fake.fail('offline');
    await store.load(WS, true);
    // A failed read keeps what was known.
    expect(store.state(WS)).toMatchObject({
      status: 'failed',
      code: 'offline',
      plugins: [plugin()],
    });
    store.put(WS, plugin({ enabled: false }));
    expect(store.plugins(WS)).toEqual([plugin({ enabled: false })]);
    store.drop(WS, PLUGIN);
    expect(store.plugins(WS)).toEqual([]);
    store.clear();
    expect(store.state(WS)).toBe(idle);
  });
});

// ---- The bundle ----------------------------------------------------------------------------------

describe('a bundle read on the device', () => {
  it('passes a whole bundle, with its manifest read', () => {
    const read = readBundle(bundle({ 'img/logo.svg': '<svg/>', 'pages/help.htm': '<p>' }));
    expect(read).toMatchObject({
      ok: true,
      summary: {
        manifest: {
          type: 'vendor.notes',
          version: 2,
          name: { en: 'Notes', ar: 'ملاحظات' },
          reads: { rows: true },
          entry: 'index.html',
          height: 240,
        },
        files: 5,
      },
    });
  });

  it('refuses by the server’s rules and codes', () => {
    const cases: [string, Uint8Array, unknown][] = [
      ['not a zip', strToU8('not a zip at all, just text'), [{ code: 'bundle.zip' }]],
      ['over 5 MB', new Uint8Array(5 * 1024 * 1024 + 1), [{ code: 'bundle.tooLarge' }]],
      [
        'more than 200 files',
        bundle(Object.fromEntries(Array.from({ length: 199 }, (_, i) => [`f${i}.txt`, `${i}`]))),
        [{ code: 'bundle.tooLarge' }],
      ],
      [
        'an entry unpacking to over 100 times its size',
        bundle({ 'big.txt': new Uint8Array(1024 * 1024) }),
        [{ code: 'bundle.tooLarge', path: 'big.txt' }],
      ],
      [
        'a file out of the bundle and one of a kind it may not hold',
        bundle({ '../evil.js': 'x', 'run.exe': 'MZ' }),
        [
          { code: 'file.name', path: '../evil.js' },
          { code: 'file.type', path: 'run.exe' },
        ],
      ],
      [
        'a name repeated in another case',
        bundle({ 'Main.js': 'x' }),
        [{ code: 'file.name', path: 'Main.js' }],
      ],
      [
        'no manifest',
        zip({ 'index.html': '<p>' }),
        [{ code: 'manifest.missing', path: 'manifest.json' }],
      ],
      [
        'a manifest that is not JSON',
        zip({ 'manifest.json': '{nope', 'index.html': '<p>' }),
        [{ code: 'manifest.invalid', path: 'manifest.json' }],
      ],
      [
        'a manifest over 16 KB',
        zip({
          'manifest.json': JSON.stringify({ ...manifest(), pad: noise(17000) }),
          'index.html': 'x',
        }),
        [{ code: 'manifest.invalid', path: 'manifest.json' }],
      ],
      [
        'a reserved type',
        bundle({}, manifest({ type: 'cashgear.notes' })),
        [{ code: 'type.reserved', path: 'type' }],
      ],
      [
        'no entry page',
        bundle({}, manifest({ entry: 'app.html' })),
        [{ code: 'entry.missing', path: 'app.html' }],
      ],
    ];
    for (const [name, bytes, errors] of cases)
      expect(readBundle(bytes), name).toEqual({ ok: false, errors });
  });

  it('passes the reference plugin the specs install (tests/fixtures/plugins), both versions', async () => {
    const { bundleOf } = await import('../../../../tests/fixtures/plugins/make.mjs');
    for (const [bytes, version] of [
      [bundleOf('reference'), 1],
      [bundleOf('reference', { version: 2 }), 2],
    ] as const) {
      const read = readBundle(bytes);
      expect(read).toMatchObject({
        ok: true,
        summary: {
          manifest: { type: 'vendor.notes', version, reads: { rows: true }, height: 160 },
        },
      });
    }
  });

  it('reads a manifest with a byte order mark', () => {
    const read = readBundle(
      zip({ 'manifest.json': `\uFEFF${JSON.stringify(manifest())}`, 'index.html': '<p>' }),
    );
    expect(read.ok).toBe(true);
  });
});

// ---- Where a block is, and its frame's address ----------------------------------------------------

function fakeSession(current: { id: string; localOnly: boolean; role?: string } | null) {
  const listeners = new Set<() => void>();
  return {
    session: {
      current,
      mirror: { subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) },
    } as unknown as WorkspaceSession,
  };
}

function fakeCloud(server = fakeServer()) {
  const listeners = new Set<() => void>();
  const cloud = {
    api: createApi({
      baseUrl: 'http://api.test',
      auth: { kind: 'cookie' },
      fetch: server.fetch as never,
    }),
    account: { id: 'u1' } as { id: string } | null | undefined,
    status: { state: 'synced' as string },
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  };
  return {
    cloud: cloud as unknown as Cloud,
    server,
    set(change: { account?: { id: string } | null | undefined; state?: string }) {
      if ('account' in change) cloud.account = change.account;
      if (change.state) cloud.status.state = change.state;
      for (const l of [...listeners]) l();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('a block’s availability', () => {
  it('reads the list when a block needs it, and says installed, off or missing', async () => {
    const { session } = fakeSession({ id: WS, localOnly: false });
    const services = new PluginServices(session);
    const c = fakeCloud();
    services.setCloud(c.cloud);
    const source = services.sourceFor(WS);
    expect(source).toBe(services.sourceFor(WS));
    expect(source.availability('vendor.notes')).toEqual({ kind: 'loading' });
    source.ensure();
    await settle();
    const installed = source.availability('vendor.notes');
    expect(installed).toMatchObject({
      kind: 'installed',
      online: true,
      plugin: { id: PLUGIN, version: 1 },
    });
    // The same object while nothing changes.
    expect(source.availability('vendor.notes')).toBe(installed);
    expect(source.availability('vendor.other')).toEqual({ kind: 'missing' });
    expect(await source.frameUrl(PLUGIN)).toBe('http://localhost:5291/f/ticket/index.html');
    await expect(source.frameUrl('01936f6e-0000-7000-8000-0000000b0009')).rejects.toMatchObject({
      code: 'notFound',
    });
    c.set({ state: 'offline' });
    expect(source.availability('vendor.notes')).toMatchObject({ kind: 'installed', online: false });
    c.server.goOffline();
    await expect(source.frameUrl(PLUGIN)).rejects.toMatchObject({ code: 'offline' });
  });

  it('says why a block cannot be drawn elsewhere', async () => {
    const local = new PluginServices(fakeSession({ id: WS, localOnly: true }).session);
    local.setCloud(fakeCloud().cloud);
    expect(local.sourceFor(WS).availability('vendor.notes')).toEqual({ kind: 'local' });
    const services = new PluginServices(fakeSession({ id: WS, localOnly: false }).session);
    expect(services.sourceFor(WS).availability('vendor.notes')).toEqual({ kind: 'local' });
    const c = fakeCloud();
    services.setCloud(c.cloud);
    expect(services.sourceFor(OTHER_WS).availability('vendor.notes')).toEqual({
      kind: 'otherWorkspace',
    });
    c.set({ account: undefined });
    expect(services.sourceFor(WS).availability('vendor.notes')).toEqual({ kind: 'loading' });
    c.set({ account: null });
    expect(services.sourceFor(WS).availability('vendor.notes')).toEqual({ kind: 'signedOut' });
    c.set({ account: { id: 'u1' }, state: 'offline' });
    expect(services.sourceFor(WS).availability('vendor.notes')).toEqual({ kind: 'offline' });
    expect(SHARED_SOURCE.availability('vendor.notes')).toEqual({ kind: 'shared' });
    expect(SHARED_SOURCE.availability('vendor.notes')).toBe(SHARED_SOURCE.availability('x.y'));
  });

  it('reads the list once the server can be reached again', async () => {
    const services = new PluginServices(fakeSession({ id: WS, localOnly: false }).session);
    const c = fakeCloud();
    c.set({ state: 'offline' });
    services.setCloud(c.cloud);
    services.ensure(WS);
    await settle();
    expect(c.server.requests.filter((r) => r.url.pathname.endsWith('/plugins'))).toHaveLength(0);
    c.set({ state: 'synced' });
    await settle();
    expect(services.sourceFor(WS).availability('vendor.notes')).toMatchObject({
      kind: 'installed',
    });
  });
});

// ---- The slash menu and the editor host -----------------------------------------------------------

function fakeShell(editable = true): ShellServices {
  return {
    commands: new CommandRegistry(),
    editor: {
      current: {
        editor: { isEditable: editable },
        host: () => ({ plugins: { has: () => true } }),
      },
    },
  } as unknown as ShellServices;
}

describe('the slash menu’s plugins', () => {
  beforeEach(() => (document.documentElement.lang = 'en'));
  afterEach(() => (document.documentElement.lang = 'en'));

  it('lists the workspace’s plugins that are on, by their names in the interface language', async () => {
    const services = new PluginServices(fakeSession({ id: WS, localOnly: false }).session);
    const c = fakeCloud();
    services.setCloud(c.cloud);
    const shell = fakeShell();
    const off = registerThirdPartyCommands(shell, services, WS);
    await settle();
    const context = { services: shell, toggleSidebar: () => {} };
    const listed = shell.commands.list(context, '', ['block']);
    expect(listed.map((c) => c.id)).toEqual(['block.plugin:vendor.notes']);
    expect(listed[0]!.label()).toBe('Notes');
    document.documentElement.lang = 'ar';
    expect(listed[0]!.label()).toBe('ملاحظات');
    // Found by either name, its type and its keywords.
    for (const query of ['ملاح', 'notes', 'vendor', 'memo'])
      expect(
        shell.commands.list(context, query, ['block']).map((c) => c.id),
        query,
      ).toContain('block.plugin:vendor.notes');
    // Not offered where the page cannot be edited.
    const reader = fakeShell(false);
    const offReader = registerThirdPartyCommands(reader, services, WS);
    expect(
      reader.commands.list({ services: reader, toggleSidebar: () => {} }, '', ['block']),
    ).toEqual([]);
    offReader();
    off();
    expect(shell.commands.list(context, '', ['block'])).toEqual([]);
  });

  it('leaves out a plugin that is off, and follows the list', async () => {
    const services = new PluginServices(fakeSession({ id: WS, localOnly: false }).session);
    const c = fakeCloud();
    services.setCloud(c.cloud);
    const shell = fakeShell();
    const off = registerThirdPartyCommands(shell, services, WS);
    await settle();
    const store = (await import('./services')).pluginsStoreOf(c.cloud);
    store.put(WS, plugin({ enabled: false }));
    const context = { services: shell, toggleSidebar: () => {} };
    expect(shell.commands.list(context, '', ['block'])).toEqual([]);
    store.put(WS, plugin({ type: 'vendor.board', id: 'other', name: { en: 'Board', ar: 'لوحة' } }));
    expect(shell.commands.list(context, '', ['block']).map((c) => c.id)).toEqual([
      'block.plugin:vendor.board',
    ]);
    off();
  });
});

describe('the editor host for plugin blocks', () => {
  const i18n = createI18n('en');

  it('has the first-party types, any other plugin type with third-party plugins, and no unknown first-party one', () => {
    const plain = pluginsHost({ databases: null, i18n });
    expect(plain.has('cashgear.chart')).toBe(true);
    expect(plain.has('vendor.notes')).toBe(false);
    const withThem = pluginsHost({ databases: null, i18n, thirdParty: SHARED_THIRD_PARTY });
    expect(withThem.has('cashgear.chart')).toBe(true);
    expect(withThem.has('vendor.notes')).toBe(true);
    expect(withThem.has('cashgear.timeline')).toBe(false);
    expect(withThem.has('Not A Type')).toBe(false);
  });

  it('draws a shared page’s third-party block as a placeholder naming its type', async () => {
    // The frame's view loads lazily (as in the app); a cold run loads it late, so it is imported
    // first and the wait is bounded by time, not by a count of ticks.
    await import('@cgw/plugins/frame-view');
    const host = pluginsHost({ databases: null, i18n, thirdParty: SHARED_THIRD_PARTY });
    const element = document.createElement('div');
    document.body.append(element);
    let frame!: ReturnType<NonNullable<typeof host.mount>>;
    await act(async () => {
      frame = host.mount!(element, {
        type: 'vendor.notes',
        version: 1,
        props: '{"note":"a"}',
        blockId: 'Blk1',
        editable: true,
        setProps: () => {},
      });
    });
    await until(() => !!element.textContent, 'the placeholder');
    expect(element.textContent).toBe('Plugins aren’t shown on a shared page (vendor.notes).');
    expect(element.querySelector('iframe')).toBeNull();
    await act(async () => frame.destroy());
  });

  it('takes only an https plugins origin, or http on this machine', () => {
    expect(pluginsOriginOf({ pluginsOrigin: 'https://plugins.cashgearerp.com/' })).toBe(
      'https://plugins.cashgearerp.com',
    );
    expect(pluginsOriginOf({ pluginsOrigin: 'http://localhost:5291' })).toBe(
      'http://localhost:5291',
    );
    expect(pluginsOriginOf({ pluginsOrigin: 'http://plugins.test' })).toBeNull();
    expect(pluginsOriginOf({ pluginsOrigin: 'nonsense' })).toBeNull();
    expect(pluginsOriginOf({})).toBeNull();
  });
});

// ---- Settings ------------------------------------------------------------------------------------

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(
  store: InstanceType<typeof PluginsStore>,
  manages: boolean,
  language: 'en' | 'ar' = 'en',
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      h(
        I18nextProvider,
        { i18n: createI18n(language) },
        h(PluginsSection, { store, workspaceId: WS, manages }),
      ),
    ),
  );
  return container;
}

/** Waits for `check`, bounded by time (5 s): Windows rounds each short timer up, CI runs cold. */
async function until(check: () => boolean, what = 'the condition') {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const buttonIn = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent === name,
  );

async function press(target: Element | undefined) {
  if (!target) throw new Error('No such button');
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

async function chooseFile(container: HTMLElement, bytes: Uint8Array) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="plugins-file"]')!;
  const file = new File([bytes as Uint8Array<ArrayBuffer>], 'notes.zip', {
    type: 'application/zip',
  });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Settings → Plugins', () => {
  it('lists the plugins with their name, type, version, size, who added them and their state', async () => {
    const fake = fakeApi();
    const container = render(new PluginsStore(fake.api), true);
    await until(() => !!container.querySelector('[data-testid="plugins-list"]'), 'the list');
    const row = container.querySelector('[data-plugin="vendor.notes"]')!;
    expect(row.textContent).toContain('Notes');
    expect(row.textContent).toContain('vendor.notes');
    expect(row.textContent).toContain('12.5');
    expect(row.textContent).toContain('Mona Adel');
    expect(row.querySelector('[data-testid="plugin-state"]')!.textContent).toBe('On');
    expect(buttonIn(row, 'Turn off Notes')).toBeDefined();
    expect(buttonIn(row, 'Update Notes…')).toBeDefined();
    expect(buttonIn(row, 'Remove Notes')).toBeDefined();
  });

  it('shows members the list read-only', async () => {
    const container = render(new PluginsStore(fakeApi().api), false);
    await until(() => !!container.querySelector('[data-testid="plugins-list"]'), 'the list');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toContain(
      'Only the workspace’s owners and admins can add or change plugins.',
    );
    expect(container.querySelector('[data-testid="plugins-file"]')).toBeNull();
  });

  it('reads a bundle on the device first, shows what it is and what it reads, then sends it', async () => {
    const fake = fakeApi([]);
    const container = render(new PluginsStore(fake.api), true);
    await until(() => !!container.querySelector('[data-testid="plugins-none"]'), 'no plugins');
    const bytes = bundle();
    await chooseFile(container, bytes);
    await until(() => !!document.querySelector('[data-testid="plugins-review"]'), 'the review');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Add Notes');
    expect(dialog.textContent).toContain('vendor.notes');
    expect(dialog.textContent).toContain('The rows of a database view its block names');
    expect(dialog.textContent).toContain('could copy what it is shown into its block’s settings');
    expect(dialog.textContent).toContain('no network');
    // Nothing was sent before the person said so.
    expect(fake.calls).toEqual(['list']);
    await press(document.querySelector('[data-testid="plugins-confirm"]')!);
    await until(() => !!container.querySelector('[data-testid="plugins-message"]'), 'the message');
    expect(fake.calls).toEqual(['list', `add ${bytes.length}`]);
    expect(container.querySelector('[data-testid="plugins-message"]')!.textContent).toBe(
      'Notes was added.',
    );
    expect(container.querySelector('[data-plugin="vendor.notes"]')).not.toBeNull();
  });

  it('refuses a bundle the server would refuse without sending it, and shows the server’s refusals', async () => {
    const fake = fakeApi([]);
    const container = render(new PluginsStore(fake.api), true);
    await until(() => !!container.querySelector('[data-testid="plugins-none"]'), 'no plugins');
    await chooseFile(container, bundle({ 'run.exe': 'MZ' }));
    await until(() => !!container.querySelector('[data-testid="plugins-problem"]'), 'the problem');
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      'The bundle holds a kind of file it may not hold (run.exe).',
    );
    expect(fake.calls).toEqual(['list']);
    fake.fail('plugin.invalid');
    await chooseFile(container, bundle());
    await until(() => !!document.querySelector('[data-testid="plugins-confirm"]'), 'the review');
    await press(document.querySelector('[data-testid="plugins-confirm"]')!);
    await until(
      () =>
        !!container.querySelector('[data-testid="plugins-problem"]')?.textContent?.includes('a b'),
      'the server’s problem',
    );
    expect(container.querySelector('[data-testid="plugins-problem"]')!.textContent).toBe(
      'A file’s name in the bundle isn’t allowed (a b).',
    );
  });

  it('updates a plugin from a later bundle of its type, and refuses an older one or another type', async () => {
    const fake = fakeApi();
    const container = render(new PluginsStore(fake.api), true);
    await until(() => !!container.querySelector('[data-testid="plugins-list"]'), 'the list');
    await press(buttonIn(container, 'Update Notes…'));
    await chooseFile(container, bundle({}, manifest({ type: 'vendor.other' })));
    await until(() => !!container.querySelector('[data-testid="plugins-problem"]'), 'the problem');
    expect(container.querySelector('[data-testid="plugins-problem"]')!.textContent).toBe(
      'This bundle is another plugin (vendor.other).',
    );
    await press(buttonIn(container, 'Update Notes…'));
    await chooseFile(container, bundle({}, manifest({ version: 2 })));
    await until(() => !!document.querySelector('[data-testid="plugins-review"]'), 'the review');
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('Update Notes');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('2 (now 1)');
    await press(document.querySelector('[data-testid="plugins-confirm"]')!);
    await until(() => !!container.querySelector('[data-testid="plugins-message"]'), 'the message');
    expect(container.querySelector('[data-testid="plugins-message"]')!.textContent).toBe(
      'Notes is now version 2.',
    );
  });

  it('turns a plugin off, and removes one only after asking', async () => {
    const fake = fakeApi();
    const container = render(new PluginsStore(fake.api), true);
    await until(() => !!container.querySelector('[data-testid="plugins-list"]'), 'the list');
    await press(buttonIn(container, 'Turn off Notes'));
    await until(
      () => container.querySelector('[data-testid="plugin-state"]')?.textContent === 'Off',
      'off',
    );
    expect(fake.calls).toContain(`enabled ${PLUGIN} false`);
    await press(buttonIn(container, 'Remove Notes'));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Its blocks stay in their pages');
    expect(fake.calls.some((c) => c.startsWith('remove'))).toBe(false);
    await press(buttonIn(dialog, 'Remove'));
    await until(() => !!container.querySelector('[data-testid="plugins-none"]'), 'removed');
    expect(fake.calls).toContain(`remove ${PLUGIN}`);
  });

  it('reads in Arabic', async () => {
    const container = render(new PluginsStore(fakeApi().api), true, 'ar');
    await until(() => !!container.querySelector('[data-testid="plugins-list"]'), 'the list');
    expect(container.querySelector('h2')!.textContent).toBe('الإضافات');
    const row = container.querySelector('[data-plugin="vendor.notes"]')!;
    expect(row.textContent).toContain('ملاحظات');
    expect(buttonIn(row, 'إيقاف ملاحظات')).toBeDefined();
    expect(row.querySelector('[data-testid="plugin-state"]')!.textContent).toBe('تعمل');
  });
});
