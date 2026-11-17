// PluginFrameHost in jsdom: a fake frame window stands in for the plugin's document and real
// MessageChannels carry the port, so every message is cloned as a browser clones it. What the
// frame is made with, the handshake's checks, the props the plugin writes (checked, throttled,
// refused when read-only), resize, a second load stopping it, and nothing ever logged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../testing/dom';

installDom();
const { PluginFrameHost, WRITE_INTERVAL_MS, isFrameUrl, pluginsOriginOf } = await import('./host');
const { parseHostMessage } = await import('./contract');
type Options = import('./host').PluginFrameHostOptions;
type Events = import('./host').PluginFrameEvents;
type Host = import('./host').PluginFrameHost;

const ORIGIN = 'http://localhost:5291';
const URL_OK = `${ORIGIN}/f/ticket-1/index.html`;

const options = (extra: Partial<Options> = {}): Options => ({
  pluginsOrigin: ORIGIN,
  url: URL_OK,
  title: 'Notes (plugin)',
  plugin: { type: 'vendor.notes', version: 2 },
  block: { version: 2, editable: true, newer: false },
  props: { note: 'hello' },
  look: { theme: 'light', direction: 'ltr', language: 'en' },
  rows: null,
  height: 240,
  timeoutMs: 5000,
  ...extra,
});

/** Stands in for the frame's window: takes what the host posts, as a browser would. */
class FakeFrameWindow {
  readonly posts: { data: unknown; origin: string; port: MessagePort | undefined }[] = [];
  postMessage(data: unknown, origin: string, transfer: Transferable[] = []): void {
    const port = transfer.find((t): t is MessagePort => t instanceof MessagePort);
    this.posts.push({ data: structuredClone(data), origin, port });
  }
}

const ports: MessagePort[] = [];
const hosts: Host[] = [];
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
    vi.spyOn(console, name),
  );
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.destroy();
  for (const port of ports.splice(0)) port.close();
  // Nothing of any message is ever written to a console.
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mount(extra: Partial<Options> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const calls = {
    setProps: [] as unknown[],
    resize: [] as number[],
    error: [] as string[],
    stopped: [] as string[],
    connected: 0,
  };
  let answer: 'saved' | 'props.readOnly' = 'saved';
  const events: Events = {
    setProps: (props) => {
      calls.setProps.push(props);
      return answer;
    },
    resize: (h) => calls.resize.push(h),
    error: (code) => calls.error.push(code),
    stopped: (why) => calls.stopped.push(why),
    connected: () => calls.connected++,
  };
  const host = new PluginFrameHost(container, options(extra), events);
  hosts.push(host);
  const iframe = container.querySelector('iframe')!;
  const fake = new FakeFrameWindow();
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fake });
  return {
    host,
    iframe,
    fake,
    calls,
    container,
    answer: (next: typeof answer) => (answer = next),
  };
}

/** A message on the page's window, as the frame (or another) would post it. */
function post(data: unknown, origin: string, source: unknown): void {
  const event = new window.MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: source });
  window.dispatchEvent(event);
}

const ready = (contracts = ['plugin-frame.1']) => ({ type: 'ready', contracts });

/** Runs the handshake and gives back the plugin's end of the port. */
function handshake(frame: ReturnType<typeof mount>) {
  const before = frame.fake.posts.length;
  post(ready(), 'null', frame.fake);
  expect(frame.fake.posts.length).toBe(before + 1);
  const port = frame.fake.posts.at(-1)!.port!;
  ports.push(port);
  const received: unknown[] = [];
  port.onmessage = (event) => received.push(event.data);
  return { port, received, send: (message: unknown) => port.postMessage(message) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const settleFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PluginFrameHost', () => {
  it('makes a sandboxed frame with scripts only, no referrer, no features, a title and no name', () => {
    const { iframe } = mount();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe.getAttribute('allow')).toBe('');
    expect(iframe.title).toBe('Notes (plugin)');
    expect(iframe.hasAttribute('name')).toBe(false);
    expect(iframe.getAttribute('src')).toBe(URL_OK);
    expect(iframe.style.blockSize).toBe('240px');
  });

  it('refuses an address that is not on the plugins origin, or an origin that is not one', () => {
    const container = document.createElement('div');
    document.body.append(container);
    for (const url of [
      'https://evil.test/f/t/index.html',
      'http://localhost:5290/f/t/index.html',
      'http://user:pw@localhost:5291/f/t/index.html',
      `${ORIGIN}/elsewhere/index.html`,
      'javascript:alert(1)',
      'data:text/html,hi',
    ])
      expect(() => new PluginFrameHost(container, options({ url }))).toThrow(TypeError);
    for (const origin of ['http://plugins.test', 'https://plugins.test/path', 'ftp://x', ''])
      expect(() => pluginsOriginOf(origin)).toThrow(TypeError);
    expect(pluginsOriginOf('https://plugins.cashgearerp.com/')).toBe(
      'https://plugins.cashgearerp.com',
    );
    expect(isFrameUrl(URL_OK, `${ORIGIN}/`)).toBe(true);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('takes a ready only from its frame, from an opaque origin, once; and sends init with the port', async () => {
    const frame = mount();
    // Not its frame's window, or not an opaque origin: nothing.
    post(ready(), 'null', {});
    post(ready(), 'http://localhost:5291', frame.fake);
    post(ready(), 'http://127.0.0.1:4273', frame.fake);
    post({ type: 'ready', contracts: [] }, 'null', frame.fake);
    expect(frame.fake.posts).toHaveLength(0);
    const plugin = handshake(frame);
    expect(frame.calls.connected).toBe(1);
    const init = frame.fake.posts[0]!;
    expect(init.origin).toBe('*');
    expect(parseHostMessage(init.data)).toEqual({
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
    // A second ready (from the same document) is not answered.
    post(ready(), 'null', frame.fake);
    expect(frame.fake.posts).toHaveLength(1);
    expect(frame.host.state).toBe('connected');
    void plugin;
  });

  it('stops a frame that speaks no contract in common', () => {
    const frame = mount();
    post(ready(['plugin-frame.2']), 'null', frame.fake);
    expect(frame.calls.stopped).toEqual(['contract']);
    expect(frame.iframe.isConnected).toBe(false);
    expect(frame.fake.posts).toHaveLength(0);
  });

  it('stops a frame that says nothing in time', () => {
    vi.useFakeTimers();
    const frame = mount({ timeoutMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(frame.calls.stopped).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(frame.calls.stopped).toEqual(['timeout']);
    expect(frame.iframe.isConnected).toBe(false);
  });

  it('stops a frame that navigates itself (its second load), and closes the port', async () => {
    const frame = mount();
    const plugin = handshake(frame);
    frame.iframe.dispatchEvent(new window.Event('load'));
    expect(frame.calls.stopped).toEqual([]);
    frame.iframe.dispatchEvent(new window.Event('load'));
    expect(frame.calls.stopped).toEqual(['navigated']);
    expect(frame.iframe.isConnected).toBe(false);
    expect(frame.host.state).toBe('stopped');
    // Nothing more is taken from the old port.
    plugin.send({ type: 'resize', height: 300 });
    plugin.send({ type: 'setProps', props: { note: 'late' } });
    await settle();
    expect(frame.calls.resize).toEqual([]);
    expect(frame.calls.setProps).toEqual([]);
  });

  it('sizes the frame from resize, within 48 to 1,200 CSS px', async () => {
    const frame = mount();
    const plugin = handshake(frame);
    for (const height of [300, 10, 5000, 600]) plugin.send({ type: 'resize', height });
    plugin.send({ type: 'resize', height: 320.5 });
    plugin.send({ type: 'resize', height: '400' });
    await settle();
    expect(frame.calls.resize).toEqual([300, 48, 1200, 600]);
    expect(frame.iframe.style.blockSize).toBe('600px');
  });

  it('writes props the plugin sends, checked, without the host keys, and answers saved', async () => {
    const frame = mount();
    const plugin = handshake(frame);
    plugin.send({ type: 'setProps', props: { note: 'changed', $view: { databaseId: 'd' } } });
    await settle();
    expect(frame.calls.setProps).toEqual([{ note: 'changed' }]);
    expect(plugin.received).toEqual([{ type: 'saved' }]);
    // Its own write comes back as the block's props: not sent to it again.
    frame.host.setProps({ note: 'changed' });
    await settle();
    expect(plugin.received).toEqual([{ type: 'saved' }]);
    // A change made elsewhere is.
    frame.host.setProps({ note: 'undone' });
    await settle();
    expect(plugin.received.at(-1)).toEqual({ type: 'props', props: { note: 'undone' } });
  });

  it('refuses props that are not JSON data, too large, or when read-only', async () => {
    const frame = mount();
    const plugin = handshake(frame);
    plugin.send({ type: 'setProps', props: [1] });
    await settleFor(WRITE_INTERVAL_MS);
    plugin.send({ type: 'setProps', props: { when: new Date(0) } });
    await settleFor(WRITE_INTERVAL_MS);
    plugin.send({ type: 'setProps', props: { big: 'x'.repeat(17000) } });
    await settleFor(WRITE_INTERVAL_MS);
    expect(plugin.received).toEqual([
      { type: 'refused', code: 'props.invalid' },
      { type: 'refused', code: 'props.invalid' },
      { type: 'refused', code: 'props.tooLarge' },
    ]);
    frame.host.setBlock({ version: 2, editable: false, newer: false });
    plugin.send({ type: 'setProps', props: { note: 'x' } });
    await settle();
    expect(plugin.received.slice(-2)).toEqual([
      { type: 'editable', editable: false, newer: false },
      { type: 'refused', code: 'props.readOnly' },
    ]);
    expect(frame.calls.setProps).toEqual([]);
    // The host may refuse too (the page is no longer editable there).
    frame.host.setBlock({ version: 2, editable: true, newer: false });
    frame.answer('props.readOnly');
    plugin.send({ type: 'setProps', props: { note: 'y' } });
    await settleFor(WRITE_INTERVAL_MS + 10);
    expect(plugin.received.at(-1)).toEqual({ type: 'refused', code: 'props.readOnly' });
  });

  it('writes at most one set of props each interval, the latest, answering each', async () => {
    const frame = mount();
    const plugin = handshake(frame);
    for (let i = 1; i <= 5; i++) plugin.send({ type: 'setProps', props: { n: i } });
    await settleFor(50);
    expect(frame.calls.setProps).toEqual([{ n: 1 }]);
    await settleFor(WRITE_INTERVAL_MS + 50);
    expect(frame.calls.setProps).toEqual([{ n: 1 }, { n: 5 }]);
    expect(plugin.received.filter((m) => (m as { type: string }).type === 'saved')).toHaveLength(5);
  });

  it('passes on the plugin’s error by its code only', async () => {
    const frame = mount();
    const plugin = handshake(frame);
    plugin.send({ type: 'error', code: 'rows.missing', message: 'secret text from the frame' });
    plugin.send({ type: 'error', code: 'bad code', message: '' });
    await settle();
    expect(frame.calls.error).toEqual(['rows.missing']);
  });

  it('sends theme, editable and rows changes, and only real ones; init carries what came before', async () => {
    const frame = mount();
    // Before the handshake: held for init.
    frame.host.setLook({ theme: 'dark', direction: 'rtl', language: 'ar' });
    frame.host.setProps({ note: 'before' });
    const plugin = handshake(frame);
    expect(parseHostMessage(frame.fake.posts[0]!.data)).toMatchObject({
      theme: 'dark',
      direction: 'rtl',
      language: 'ar',
      props: { note: 'before' },
    });
    frame.host.setLook({ theme: 'dark', direction: 'rtl', language: 'ar' });
    frame.host.setBlock({ version: 2, editable: true, newer: false });
    frame.host.setRows(null);
    await settle();
    expect(plugin.received).toEqual([]);
    const rows = {
      databaseId: 'db1',
      viewId: 'v1',
      properties: [{ id: 'title', name: 'Name', type: 'title' as const }],
      rows: [{ id: 'r1', title: 'One', values: {} }],
      total: 1,
      complete: true,
    };
    frame.host.setRows(rows);
    frame.host.setRows({ ...rows });
    frame.host.setLook({ theme: 'light', direction: 'rtl', language: 'ar' });
    frame.host.setBlock({ version: 3, editable: false, newer: true });
    await settle();
    expect(plugin.received).toEqual([
      { type: 'rows', rows },
      { type: 'theme', theme: 'light', direction: 'rtl', language: 'ar' },
      { type: 'editable', editable: false, newer: true },
    ]);
  });

  it('takes nothing on the port before the handshake or after destroy, and removes the frame', async () => {
    const frame = mount();
    const plugin = handshake(frame);
    frame.host.destroy();
    expect(frame.iframe.isConnected).toBe(false);
    expect(frame.host.state).toBe('destroyed');
    plugin.send({ type: 'resize', height: 400 });
    await settle();
    expect(frame.calls.resize).toEqual([]);
    // A ready after destroy is not answered.
    post(ready(), 'null', frame.fake);
    expect(frame.fake.posts).toHaveLength(1);
  });

  it('throws for a message the plugin would drop (props the host must never send)', () => {
    const frame = mount();
    handshake(frame);
    expect(() => frame.host.setProps({ $view: 'x' } as never)).toThrow(TypeError);
    expect(() => new PluginFrameHost(frame.container, options({ props: { a: NaN } }))).toThrow(
      TypeError,
    );
  });
});
