// A third-party plugin's block (`./frame-view`) in jsdom, over a source the test controls and
// `@cgw/database`'s in-memory host: a placeholder for every case (each naming the plugin or its
// type, in English and Arabic), the frame made from the address the source gives, its init (props
// without the host's keys, read-only for a reader and for a block a later version wrote), the
// plugin's writes merged as one setProps with the host's keys kept, the `$view` picker, a view's
// rows without a person's values and at most 500 of them, and a frame that stops or fails.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../testing/dom';

installDom();
const { act } = await import('react');
const { en: databaseEn, ar: databaseAr } = await import('@cgw/database/i18n');
const { seed, P } = await import('@cgw/database/testing');
const { mountThirdParty, FrameUrlError } = await import('./view');
const { createPluginsI18n } = await import('../i18n');
const { parseHostMessage } = await import('./contract');
type PluginFrameOptions = import('../types').PluginFrameOptions;
type PluginData = import('../types').PluginData;
type PluginAvailability = import('./types').PluginAvailability;
type InstalledPlugin = import('./types').InstalledPlugin;
type InitMessage = import('./contract').InitMessage;

const ORIGIN = 'http://localhost:5291';
const plugin = (extra: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: '0193a1c0-0000-7000-8000-0000000p0001',
  type: 'vendor.notes',
  version: 2,
  name: { en: 'Notes', ar: 'ملاحظات' },
  reads: { rows: false },
  height: 200,
  enabled: true,
  ...extra,
});

/** A source the test sets: what availability says, and the frame addresses it hands out. */
class FakeSource {
  current: PluginAvailability = { kind: 'loading' };
  readonly listeners = new Set<() => void>();
  readonly asked: string[] = [];
  ensured = 0;
  refreshed = 0;
  answer: () => Promise<string> = async () => `${ORIGIN}/f/ticket-${this.asked.length}/index.html`;
  availability = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  ensure = () => void this.ensured++;
  refresh = () => void this.refreshed++;
  frameUrl = (pluginId: string) => {
    this.asked.push(pluginId);
    return this.answer();
  };
  async set(next: PluginAvailability) {
    this.current = next;
    await act(async () => {
      for (const listener of [...this.listeners]) listener();
    });
    await flush();
  }
}

/** Stands in for the frame's window: takes what the host posts. */
class FakeFrameWindow {
  readonly posts: { data: unknown; port: MessagePort | undefined }[] = [];
  postMessage(data: unknown, _origin: string, transfer: Transferable[] = []): void {
    const port = transfer.find((t): t is MessagePort => t instanceof MessagePort);
    this.posts.push({ data: structuredClone(data), port });
  }
}

let container: HTMLElement;
let frames: { destroy(): void }[] = [];
const ports: MessagePort[] = [];
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => {
    for (const frame of frames) frame.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  frames = [];
  for (const port of ports.splice(0)) port.close();
  document.body.innerHTML = '';
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = (times = 4) =>
  act(async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  });

interface Mounted {
  source: FakeSource;
  writes: { props: string; version: number }[];
  update(next: Partial<PluginFrameOptions>): Promise<void>;
}

async function mount(
  options: Partial<PluginFrameOptions>,
  availability: PluginAvailability,
  extra: { data?: PluginData; origin?: string | null; language?: 'en' | 'ar' } = {},
): Promise<Mounted> {
  const i18n = createPluginsI18n(extra.language ?? 'en', { en: databaseEn, ar: databaseAr });
  const source = new FakeSource();
  source.current = availability;
  const writes: { props: string; version: number }[] = [];
  let current: PluginFrameOptions = {
    type: 'vendor.notes',
    version: 2,
    props: null,
    blockId: 'Blk0000000001',
    editable: true,
    setProps: (props, version) => {
      writes.push({ props, version });
      current = { ...current, props, version };
      frame.update(current);
    },
    ...options,
  };
  let frame!: ReturnType<typeof mountThirdParty>;
  await act(async () => {
    frame = mountThirdParty(container, current, {
      source,
      pluginsOrigin: extra.origin === undefined ? ORIGIN : extra.origin,
      data: extra.data ?? { databases: null },
      i18n,
    });
  });
  frames.push(frame);
  await flush();
  return {
    source,
    writes,
    update: async (next) => {
      current = { ...current, ...next };
      await act(async () => frame.update(current));
      await flush();
    },
  };
}

/** The frame's handshake, as its document would make it: its init, and its end of the port. */
async function connect() {
  const iframe = container.querySelector('iframe');
  expect(iframe, 'a frame').not.toBeNull();
  const fake = new FakeFrameWindow();
  Object.defineProperty(iframe!, 'contentWindow', { configurable: true, get: () => fake });
  const event = new window.MessageEvent('message', {
    data: { type: 'ready', contracts: ['plugin-frame.1'] },
    origin: 'null',
  });
  Object.defineProperty(event, 'source', { value: fake });
  window.dispatchEvent(event);
  const init = parseHostMessage(fake.posts[0]?.data) as InitMessage;
  expect(init?.type).toBe('init');
  const port = fake.posts[0]!.port!;
  ports.push(port);
  const received: unknown[] = [];
  port.onmessage = (e) => received.push(e.data);
  return { iframe: iframe!, init, port, received };
}

const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}

describe('a third-party block’s placeholders', () => {
  const cases: [PluginAvailability, string, string][] = [
    [
      { kind: 'missing' },
      'The plugin vendor.notes isn’t installed in this workspace.',
      'الإضافة vendor.notes غير مثبّتة في مساحة العمل هذه.',
    ],
    [
      { kind: 'disabled', plugin: plugin({ enabled: false }) },
      'Notes is turned off in this workspace.',
      'ملاحظات متوقفة في مساحة العمل هذه.',
    ],
    [
      { kind: 'offline' },
      'The plugin vendor.notes needs a connection.',
      'تحتاج الإضافة vendor.notes إلى اتصال.',
    ],
    [
      { kind: 'signedOut' },
      'Sign in to see the plugin vendor.notes.',
      'سجّل الدخول لترى الإضافة vendor.notes.',
    ],
    [
      { kind: 'local' },
      'Plugins need a workspace that syncs (vendor.notes).',
      'تحتاج الإضافات إلى مساحة عمل متزامنة (vendor.notes).',
    ],
    [
      { kind: 'shared' },
      'Plugins aren’t shown on a shared page (vendor.notes).',
      'لا تُعرض الإضافات في صفحة مشتركة (vendor.notes).',
    ],
    [
      { kind: 'otherWorkspace' },
      'This plugin block (vendor.notes) belongs to another workspace.',
      'كتلة الإضافة هذه (vendor.notes) تخص مساحة عمل أخرى.',
    ],
  ];
  for (const [availability, english, arabic] of cases) {
    it(`says why for ${availability.kind}, in English and Arabic, and makes no frame`, async () => {
      const block = await mount({}, availability);
      expect(text()).toBe(english);
      expect(container.querySelector('[role="note"]')).not.toBeNull();
      expect(container.querySelector('iframe')).toBeNull();
      expect(block.source.asked).toEqual([]);
      expect(block.source.ensured).toBe(1);
      for (const frame of frames.splice(0)) frame.destroy();
      container.replaceChildren();
      await mount({}, availability, { language: 'ar' });
      expect(text()).toBe(arabic);
      expect(container.querySelector('.cgw-plugin-root')!.getAttribute('dir')).toBe('rtl');
    });
  }

  it('says it is loading, then draws once the list is read; a failed list offers to try again', async () => {
    const block = await mount({}, { kind: 'loading' });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await block.source.set({ kind: 'failed' });
    expect(text()).toContain('Couldn’t load this workspace’s plugins (vendor.notes).');
    await click(button('Try again'));
    expect(block.source.refreshed).toBe(1);
    await block.source.set({ kind: 'installed', plugin: plugin(), online: true });
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(block.source.asked).toEqual([plugin().id]);
  });

  it('never changes the block while it draws a placeholder', async () => {
    const block = await mount(
      { props: '{"note":"kept","$view":{"databaseId":"d1"}}' },
      {
        kind: 'missing',
      },
    );
    expect(block.writes).toEqual([]);
  });
});

describe('a third-party block’s frame', () => {
  it('makes the frame from the address it is given, titled by the plugin, and sends init', async () => {
    const block = await mount(
      { props: JSON.stringify({ note: 'hello', $view: { databaseId: 'd1', viewId: null } }) },
      { kind: 'installed', plugin: plugin(), online: true },
    );
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('src')).toBe(`${ORIGIN}/f/ticket-1/index.html`);
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.title).toBe('Notes (plugin)');
    expect(iframe.style.blockSize).toBe('200px');
    const { init } = await connect();
    expect(init).toEqual({
      type: 'init',
      contract: 'plugin-frame.1',
      plugin: { type: 'vendor.notes', version: 2 },
      block: { version: 2, editable: true, newer: false },
      props: { note: 'hello' },
      theme: 'light',
      direction: 'ltr',
      language: 'en',
      rows: null,
    });
    expect(block.writes).toEqual([]);
  });

  it('writes what the plugin sends as one setProps, keeping the host’s keys and the keys it did not send', async () => {
    const block = await mount(
      {
        props: JSON.stringify({ note: 'a', later: [1], $view: { databaseId: 'd1', viewId: 'v1' } }),
        version: 1,
      },
      { kind: 'installed', plugin: plugin(), online: true },
    );
    const { port, received } = await connect();
    port.postMessage({ type: 'setProps', props: { note: 'b', $view: { databaseId: 'evil' } } });
    await flush();
    expect(block.writes).toHaveLength(1);
    expect(JSON.parse(block.writes[0]!.props)).toEqual({
      note: 'b',
      later: [1],
      $view: { databaseId: 'd1', viewId: 'v1' },
    });
    // Written by the installed version.
    expect(block.writes[0]!.version).toBe(2);
    // The block now holds a key the plugin did not send: it is told the props as they are.
    expect(received).toEqual([
      { type: 'saved' },
      { type: 'props', props: { note: 'b', later: [1] } },
    ]);
    // An Undo elsewhere reaches the plugin as props.
    await block.update({ props: JSON.stringify({ note: 'a', later: [1] }) });
    expect(received.at(-1)).toEqual({ type: 'props', props: { note: 'a', later: [1] } });
  });

  it('draws a block a later version wrote read-only, and a reader’s too', async () => {
    const block = await mount(
      { props: '{"note":"from v3"}', version: 3 },
      { kind: 'installed', plugin: plugin(), online: true },
    );
    expect(text()).toContain('Made by a newer version of Notes: shown read-only.');
    const { init, port, received } = await connect();
    expect(init.block).toEqual({ version: 3, editable: false, newer: true });
    port.postMessage({ type: 'setProps', props: { note: 'x' } });
    await flush();
    expect(received).toEqual([{ type: 'refused', code: 'props.readOnly' }]);
    expect(block.writes).toEqual([]);
    for (const frame of frames.splice(0)) frame.destroy();
    container.replaceChildren();
    await mount({ editable: false }, { kind: 'installed', plugin: plugin(), online: true });
    expect((await connect()).init.block).toEqual({ version: 2, editable: false, newer: false });
  });

  it('says it could not be loaded when the server refuses the address, reads the list again, and reloads', async () => {
    const block = await mount({}, { kind: 'loading' });
    block.source.answer = () => Promise.reject(new FrameUrlError('notFound'));
    await block.source.set({ kind: 'installed', plugin: plugin(), online: true });
    expect(text()).toContain('Notes couldn’t be loaded.');
    expect(block.source.refreshed).toBe(1);
    expect(container.querySelector('iframe')).toBeNull();
    block.source.answer = async () => `${ORIGIN}/f/ticket-again/index.html`;
    await click(button('Reload'));
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe(
      `${ORIGIN}/f/ticket-again/index.html`,
    );
  });

  it('asks again once back online after the address could not be had offline', async () => {
    const block = await mount({}, { kind: 'loading' });
    block.source.answer = () => Promise.reject(new FrameUrlError('offline'));
    await block.source.set({ kind: 'installed', plugin: plugin(), online: false });
    expect(text()).toContain('Notes needs a connection.');
    block.source.answer = async () => `${ORIGIN}/f/ticket-online/index.html`;
    await block.source.set({ kind: 'installed', plugin: plugin(), online: true });
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe(
      `${ORIGIN}/f/ticket-online/index.html`,
    );
  });

  it('makes no frame without the build’s plugins origin, or for an address off it', async () => {
    await mount({}, { kind: 'installed', plugin: plugin(), online: true }, { origin: null });
    expect(text()).toContain('Notes can’t be shown here.');
    expect(container.querySelector('iframe')).toBeNull();
    for (const frame of frames.splice(0)) frame.destroy();
    container.replaceChildren();
    const block = await mount({}, { kind: 'loading' });
    block.source.answer = async () => 'https://evil.test/f/ticket/index.html';
    await block.source.set({ kind: 'installed', plugin: plugin(), online: true });
    expect(text()).toContain('Notes can’t be shown here.');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('says the plugin stopped when its frame navigates itself, and Reload makes a new one', async () => {
    const block = await mount({}, { kind: 'installed', plugin: plugin(), online: true });
    const { iframe } = await connect();
    await act(async () => {
      iframe.dispatchEvent(new window.Event('load'));
      iframe.dispatchEvent(new window.Event('load'));
    });
    await flush();
    expect(text()).toContain('Notes stopped.');
    expect(container.querySelector('iframe')).toBeNull();
    await click(button('Reload'));
    expect(block.source.asked).toHaveLength(2);
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe(
      `${ORIGIN}/f/ticket-2/index.html`,
    );
  });

  it('says the plugin could not draw when it says so', async () => {
    await mount({}, { kind: 'installed', plugin: plugin(), online: true });
    const { port } = await connect();
    port.postMessage({ type: 'error', code: 'rows.missing', message: 'never shown' });
    await flush();
    expect(text()).toContain('Notes couldn’t draw this block.');
    expect(text()).not.toContain('never shown');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('speaks Arabic and right to left to the plugin, and says so again when the language changes', async () => {
    await mount({}, { kind: 'installed', plugin: plugin(), online: true }, { language: 'ar' });
    const { init } = await connect();
    expect(init).toMatchObject({ language: 'ar', direction: 'rtl' });
    expect(container.querySelector('iframe')!.title).toBe('ملاحظات (إضافة)');
  });
});

describe('a third-party block’s rows', () => {
  const rowsPlugin = plugin({ reads: { rows: true } });

  it('asks for a view, and writes `$view` keeping the plugin’s props', async () => {
    const s = seed(5);
    let asked = 0;
    const block = await mount(
      { props: '{"note":"kept"}' },
      { kind: 'installed', plugin: rowsPlugin, online: true },
      {
        data: {
          databases: s.host,
          pickDatabase: async () => {
            asked++;
            return { databaseId: s.tasksId, viewId: s.viewId };
          },
        },
      },
    );
    expect(text()).toContain('Choose a database for Notes to show.');
    const { init } = await connect();
    expect(init.rows).toBeNull();
    await click(button('Choose a database'));
    expect(asked).toBe(1);
    expect(JSON.parse(block.writes[0]!.props)).toEqual({
      note: 'kept',
      $view: { databaseId: s.tasksId, viewId: s.viewId },
    });
  });

  it('shows the view’s rows without a person’s values, and at most 500', async () => {
    const s = seed(620);
    await mount(
      { props: JSON.stringify({ $view: { databaseId: s.tasksId, viewId: s.viewId } }) },
      { kind: 'installed', plugin: rowsPlugin, online: true },
      { data: { databases: s.host } },
    );
    expect(text()).toContain('Rows from Tasks');
    const { init } = await connect();
    const rows = init.rows!;
    expect(rows.databaseId).toBe(s.tasksId);
    expect(rows.viewId).toBe(s.viewId);
    expect(rows.rows).toHaveLength(500);
    expect(rows.total).toBe(620);
    expect(rows.complete).toBe(false);
    const ids = rows.properties.map((p) => p.id);
    expect(ids[0]).toBe('title');
    for (const person of [P.owner, P.creator, P.editor]) expect(ids).not.toContain(person);
    expect(ids).toEqual(expect.arrayContaining([P.status, P.amount, P.double, P.created]));
    for (const row of rows.rows) {
      for (const person of [P.owner, P.creator, P.editor])
        expect(row.values).not.toHaveProperty(person);
    }
    expect(JSON.stringify(rows)).not.toMatch(/0000000000p[123]/);
    const status = rows.properties.find((p) => p.id === P.status)!;
    expect(status.options?.[0]).toEqual({
      id: 'stTodo01',
      name: 'Not started',
      colour: 'gray',
      group: 'todo',
    });
  });

  it('leaves out a formula that reads a person, and sends rows again when they change', async () => {
    const s = seed(3);
    const database = s.host.database(s.tasksId)!;
    database.properties.push({
      id: 'frmOwner',
      name: 'Owner text',
      type: 'formula',
      formula: { expression: `prop("${P.owner}")` },
    });
    await mount(
      { props: JSON.stringify({ $view: { databaseId: s.tasksId, viewId: null } }) },
      { kind: 'installed', plugin: rowsPlugin, online: true },
      { data: { databases: s.host } },
    );
    const { init } = await connect();
    expect(init.rows!.properties.map((p) => p.id)).not.toContain('frmOwner');
    expect(init.rows!.rows).toHaveLength(3);
  });
});
