// SheetEmbed in jsdom: a fake frame window stands in for Sheet's `/embed` document and real
// MessageChannels carry the port, so every message is cloned as a browser clones it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../testing';

installDom();
const { SheetEmbed, SheetEmbedError } = await import('./embed');
const { parseParentMessage } = await import('./contract');
type SheetEmbedOptions = import('./embed').SheetEmbedOptions;
type SheetEmbedEvents = import('./embed').SheetEmbedEvents;
type SheetEmbedInstance = import('./embed').SheetEmbed;

const ORIGIN = 'https://sheet.test';
const ETAG = '"v1"';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const view = { kind: 'range', sheet: 'Budget', range: 'A1:D20' } as const;
const options = (extra: Partial<SheetEmbedOptions> = {}): SheetEmbedOptions => ({
  sheetOrigin: ORIGIN,
  source: { kind: 'url', url: 'https://blob.test/b1.xlsx?sig=x', etag: ETAG },
  view: { kind: 'range', sheet: null, range: null },
  theme: 'light',
  direction: 'ltr',
  locale: 'en',
  title: 'Budget workbook',
  ...extra,
});
const loaded = {
  type: 'loaded',
  etag: ETAG,
  view,
  sheets: [{ name: 'Budget', direction: 'ltr' }],
  charts: [],
  size: { width: 640, height: 420 },
  capped: false,
};

/** Stands in for the frame's window: takes what the parent posts, as a browser would. */
class FakeFrameWindow {
  readonly posts: { data: unknown; origin: string; port: MessagePort | undefined }[] = [];
  postMessage(data: unknown, origin: string, transfer: Transferable[] = []): void {
    const port = transfer.find((t): t is MessagePort => t instanceof MessagePort);
    const rest = transfer.filter((t) => t !== port);
    this.posts.push({ data: structuredClone(data, { transfer: rest }), origin, port });
  }
}

/** The embed's end of one handshake: what it received on the port, and a way to answer. */
interface EmbedSide {
  port: MessagePort;
  received: unknown[];
  answer(message: unknown, transfer?: Transferable[]): void;
}

const ports: MessagePort[] = [];
const embeds: SheetEmbedInstance[] = [];
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
    vi.spyOn(console, name),
  );
});

afterEach(() => {
  for (const embed of embeds.splice(0)) embed.destroy();
  for (const port of ports.splice(0)) port.close();
  // Nothing of any message is ever written to a console.
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mount(extra: Partial<SheetEmbedOptions> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const calls = {
    loaded: [] as unknown[],
    resize: [] as unknown[],
    error: [] as unknown[],
    openRequested: 0,
  };
  const events: SheetEmbedEvents = {
    loaded: (x) => calls.loaded.push(x),
    resize: (x) => calls.resize.push(x),
    error: (x) => calls.error.push(x),
    openRequested: () => calls.openRequested++,
  };
  const embed = new SheetEmbed(container, options(extra), events);
  embeds.push(embed);
  const iframe = container.querySelector('iframe')!;
  const fake = new FakeFrameWindow();
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fake });
  return { embed, iframe, fake, calls, container };
}

/** A message on the parent's window, as the frame (or another) would post it. */
function post(data: unknown, origin: string, source: unknown): void {
  const event = new window.MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: source });
  window.dispatchEvent(event);
}

const ready = (contracts = ['sheet-embed.1']) => ({ type: 'ready', contracts });

/** Runs the handshake and gives back the embed's end of the port. */
function handshake(frame: ReturnType<typeof mount>): EmbedSide {
  const before = frame.fake.posts.length;
  post(ready(), ORIGIN, frame.fake);
  expect(frame.fake.posts.length).toBe(before + 1);
  const port = frame.fake.posts.at(-1)!.port!;
  ports.push(port);
  const received: unknown[] = [];
  port.onmessage = (event) => received.push(event.data);
  return {
    port,
    received,
    answer: (message, transfer = []) => port.postMessage(message, transfer),
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await turn();
  expect(check()).toBe(true);
}

describe('SheetEmbed', () => {
  it('draws the frame the contract names', () => {
    const { iframe, embed } = mount();
    expect(iframe.getAttribute('src')).toBe('https://sheet.test/embed');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe.getAttribute('allow')).toBe('');
    expect(iframe.title).toBe('Budget workbook');
    expect(iframe.hasAttribute('name')).toBe(false);
    expect(embed.frame).toBe(iframe);
    expect(embed.state).toBe('connecting');
  });

  it('takes the origin without a trailing slash and refuses anything else', () => {
    const { iframe } = mount({ sheetOrigin: 'https://sheet.test/' });
    expect(iframe.getAttribute('src')).toBe('https://sheet.test/embed');
    const container = document.createElement('div');
    for (const sheetOrigin of ['https://sheet.test/app', 'ftp://sheet.test', 'sheet.test', '']) {
      expect(() => new SheetEmbed(container, options({ sheetOrigin }))).toThrow(TypeError);
    }
    expect(container.childElementCount).toBe(0);
  });

  it('refuses options that would make an invalid init', () => {
    const container = document.createElement('div');
    const bad = { kind: 'range', sheet: 'a/b', range: null } as const;
    expect(() => new SheetEmbed(container, options({ view: bad }))).toThrow(TypeError);
    expect(container.childElementCount).toBe(0);
  });

  it('answers ready with init on a new port, to the Sheet origin only', async () => {
    const frame = mount({ theme: 'dark', direction: 'rtl', locale: 'ar' });
    const side = handshake(frame);
    const init = frame.fake.posts[0]!;
    expect(init.origin).toBe(ORIGIN);
    expect(init.port).toBeInstanceOf(MessagePort);
    expect(parseParentMessage(init.data)).toEqual({
      type: 'init',
      contract: 'sheet-embed.1',
      source: options().source,
      view: { kind: 'range', sheet: null, range: null },
      theme: 'dark',
      direction: 'rtl',
      locale: 'ar',
    });
    expect(frame.embed.state).toBe('loading');

    side.answer(loaded);
    await until(() => frame.calls.loaded.length === 1);
    expect(frame.calls.loaded[0]).toEqual({
      etag: ETAG,
      view,
      sheets: loaded.sheets,
      charts: [],
      size: loaded.size,
      capped: false,
    });
    expect(frame.embed.state).toBe('loaded');
  });

  it('ignores a ready from another origin', () => {
    const frame = mount();
    for (const origin of [
      'https://evil.test',
      'http://sheet.test',
      'https://sheet.test:444',
      'null',
    ]) {
      post(ready(), origin, frame.fake);
    }
    expect(frame.fake.posts).toHaveLength(0);
    expect(frame.embed.state).toBe('connecting');
  });

  it('ignores a ready from another window', () => {
    const frame = mount();
    post(ready(), ORIGIN, new FakeFrameWindow());
    post(ready(), ORIGIN, window);
    post(ready(), ORIGIN, null);
    expect(frame.fake.posts).toHaveLength(0);
  });

  it('ignores window messages that are not a valid ready', () => {
    const frame = mount();
    post({ type: 'ready', contracts: 'sheet-embed.1' }, ORIGIN, frame.fake);
    post({ type: 'ready', contracts: ['sheet-embed.1'], extra: 1 }, ORIGIN, frame.fake);
    post(loaded, ORIGIN, frame.fake);
    post('ready', ORIGIN, frame.fake);
    expect(frame.fake.posts).toHaveLength(0);
  });

  it('takes one ready per frame load', async () => {
    const frame = mount();
    const first = handshake(frame);
    post(ready(), ORIGIN, frame.fake);
    frame.iframe.dispatchEvent(new window.Event('load'));
    post(ready(), ORIGIN, frame.fake);
    expect(frame.fake.posts).toHaveLength(1);
    first.answer(loaded);
    await until(() => frame.calls.loaded.length === 1);
  });

  it('runs the handshake again when the frame loads a new document', async () => {
    const frame = mount();
    const first = handshake(frame);
    frame.iframe.dispatchEvent(new window.Event('load'));
    first.answer(loaded);
    await until(() => frame.calls.loaded.length === 1);

    // The new document's ready comes before its load event.
    post(ready(), ORIGIN, frame.fake);
    expect(frame.fake.posts).toHaveLength(1);
    frame.iframe.dispatchEvent(new window.Event('load'));
    expect(frame.fake.posts).toHaveLength(2);
    expect(frame.embed.state).toBe('loading');
    const second = frame.fake.posts[1]!.port!;
    ports.push(second);
    expect(second).not.toBe(first.port);

    // The old port is closed: what comes on it is not heard.
    first.answer({ type: 'resize', size: { width: 1, height: 1 } });
    second.postMessage({ type: 'resize', size: { width: 2, height: 2 } });
    await until(() => frame.calls.resize.length === 1);
    expect(frame.calls.resize).toEqual([{ width: 2, height: 2 }]);

    // A later document whose ready comes after its load event.
    frame.iframe.dispatchEvent(new window.Event('load'));
    expect(frame.embed.state).toBe('connecting');
    post(ready(), ORIGIN, frame.fake);
    expect(frame.fake.posts).toHaveLength(3);
    ports.push(frame.fake.posts[2]!.port!);
  });

  it('reports contract.unsupported when the embed speaks no contract in common', () => {
    const frame = mount();
    post(ready(['sheet-embed.2']), ORIGIN, frame.fake);
    expect(frame.fake.posts).toHaveLength(0);
    expect(frame.calls.error).toEqual([
      { code: 'contract.unsupported', message: 'No contract in common' },
    ]);
    expect(frame.embed.state).toBe('error');
  });

  it('drops malformed answers on the port and keeps listening', async () => {
    const frame = mount();
    const side = handshake(frame);
    side.answer({ ...loaded, etag: 'v1' });
    side.answer({ ...loaded, view: { kind: 'range', sheet: null, range: null } });
    side.answer({ ...loaded, extra: true });
    side.answer(ready());
    side.answer({ type: 'error', code: 'nope', message: '' });
    side.answer({ type: 'resize', size: { width: 0, height: 1 } });
    side.answer({ type: 'openRequested', now: true });
    side.answer(JSON.parse('{"type":"openRequested","__proto__":{"x":1}}'));
    side.answer(null);
    side.answer([loaded]);
    side.answer({ type: 'resize', size: { width: 700, height: 300 } });
    await until(() => frame.calls.resize.length === 1);
    expect(frame.calls.loaded).toHaveLength(0);
    expect(frame.calls.error).toHaveLength(0);
    expect(frame.calls.openRequested).toBe(0);
    expect(frame.embed.state).toBe('loading');
    side.answer({ type: 'openRequested' });
    await until(() => frame.calls.openRequested === 1);
  });

  it('passes on an error and its code', async () => {
    const frame = mount();
    const side = handshake(frame);
    side.answer({ type: 'error', code: 'source.forbidden', message: 'HTTP 403' });
    await until(() => frame.calls.error.length === 1);
    expect(frame.calls.error[0]).toEqual({ code: 'source.forbidden', message: 'HTTP 403' });
    expect(frame.embed.state).toBe('error');

    // The shell asks for a new URL and sends refresh: on the port, waiting for loaded again.
    const source = { kind: 'url', url: 'https://blob.test/b1.xlsx?sig=y', etag: ETAG } as const;
    frame.embed.refresh(source);
    expect(frame.embed.state).toBe('loading');
    await until(() => side.received.length === 1);
    expect(side.received[0]).toEqual({ type: 'refresh', source });
    side.answer(loaded);
    await until(() => frame.calls.loaded.length === 1);
    expect(frame.embed.state).toBe('loaded');
  });

  it('times out as source.unavailable without a ready or a loaded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const silent = mount({ timeoutMs: 5000 });
    vi.advanceTimersByTime(4999);
    expect(silent.calls.error).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(silent.calls.error).toEqual([
      { code: 'source.unavailable', message: 'No answer in time' },
    ]);
    expect(silent.embed.state).toBe('error');

    const slow = mount({ timeoutMs: 5000 });
    vi.advanceTimersByTime(3000);
    const side = handshake(slow);
    vi.advanceTimersByTime(4999);
    expect(slow.calls.error).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(slow.calls.error).toHaveLength(1);

    // A loaded that comes late is still drawn.
    side.answer(loaded);
    await until(() => slow.calls.loaded.length === 1);
    expect(slow.embed.state).toBe('loaded');
    vi.advanceTimersByTime(10_000);
    expect(slow.calls.error).toHaveLength(1);

    // setView waits for its own answer.
    slow.embed.setView({ kind: 'chart', sheet: null, chartId: 'Chart 1' });
    vi.advanceTimersByTime(5000);
    expect(slow.calls.error).toHaveLength(2);
  });

  it('pairs previews with their answers by id', async () => {
    const frame = mount();
    const side = handshake(frame);
    side.answer(loaded);
    await until(() => frame.calls.loaded.length === 1);

    const first = frame.embed.requestPreview({ maxWidth: 800, maxHeight: 600, scale: 2 });
    const second = frame.embed.requestPreview({ maxWidth: 400, maxHeight: 300, scale: 1 });
    await until(() => side.received.length === 2);
    const [a, b] = side.received as { id: string; maxWidth: number }[];
    expect(a!.id).not.toBe(b!.id);
    expect(a).toMatchObject({ type: 'requestPreview', maxWidth: 800, maxHeight: 600, scale: 2 });

    const picture = (id: string, width: number) => {
      const bytes = PNG.slice().buffer;
      side.answer({ type: 'preview', id, bytes, width, height: 10, etag: ETAG, view }, [bytes]);
    };
    picture('preview-999', 1);
    picture(b!.id, 400);
    picture(a!.id, 800);
    const [one, two] = await Promise.all([first, second]);
    expect(one.width).toBe(800);
    expect(two.width).toBe(400);
    expect(new Uint8Array(one.bytes)).toEqual(PNG);
    expect(one).toEqual({ bytes: one.bytes, width: 800, height: 10, etag: ETAG, view });

    // An error with an id fails that preview only; the view stays drawn.
    const third = frame.embed.requestPreview({ maxWidth: 16, maxHeight: 16, scale: 3 });
    await until(() => side.received.length === 3);
    const { id } = side.received[2] as { id: string };
    side.answer({ type: 'error', code: 'range.tooLarge', message: '', id });
    await expect(third).rejects.toMatchObject({ name: 'SheetEmbedError', code: 'range.tooLarge' });
    expect(frame.embed.state).toBe('loaded');
    expect(frame.calls.error).toHaveLength(0);
  });

  it('times a preview out, and drops one that is not a PNG', async () => {
    const frame = mount({ timeoutMs: 200 });
    const side = handshake(frame);
    const pending = frame.embed.requestPreview({ maxWidth: 100, maxHeight: 100, scale: 1 });
    await until(() => side.received.length === 1);
    const { id } = side.received[0] as { id: string };
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
    side.answer({ type: 'preview', id, bytes: jpeg, width: 10, height: 10, etag: ETAG, view });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SheetEmbedError);
    expect(error).toMatchObject({ code: 'source.unavailable', message: 'No preview in time' });
  });

  it('refuses a preview before the handshake, and an invalid request', async () => {
    const frame = mount();
    await expect(
      frame.embed.requestPreview({ maxWidth: 100, maxHeight: 100, scale: 1 }),
    ).rejects.toMatchObject({ code: 'source.unavailable' });
    handshake(frame);
    expect(() => frame.embed.requestPreview({ maxWidth: 8, maxHeight: 100, scale: 1 })).toThrow(
      TypeError,
    );
  });

  it('keeps changes made before the handshake for init, and sends later ones on the port', async () => {
    const frame = mount();
    const chart = { kind: 'chart', sheet: 'Budget', chartId: 'Chart 1' } as const;
    frame.embed.setView(chart);
    frame.embed.setTheme({ theme: 'dark', direction: 'rtl', locale: 'ar' });
    expect(frame.embed.state).toBe('connecting');
    const side = handshake(frame);
    expect(frame.fake.posts[0]!.data).toMatchObject({
      view: chart,
      theme: 'dark',
      direction: 'rtl',
      locale: 'ar',
    });

    frame.embed.setTheme({ theme: 'light', direction: 'ltr', locale: 'en' });
    frame.embed.setView(view);
    await until(() => side.received.length === 2);
    expect(side.received).toEqual([
      { type: 'setTheme', theme: 'light', direction: 'ltr', locale: 'en' },
      { type: 'setView', view },
    ]);
    expect(() => frame.embed.setView({ kind: 'range', sheet: null, range: 'a1' })).toThrow(
      TypeError,
    );
    expect(() =>
      frame.embed.refresh({ kind: 'url', url: 'http://evil.test/b.xlsx', etag: ETAG }),
    ).toThrow(TypeError);
  });

  it('transfers a copy of a bytes source', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4]).buffer;
    const frame = mount({ source: { kind: 'bytes', bytes, etag: ETAG } });
    handshake(frame);
    expect(bytes.byteLength).toBe(4);
    const sent = frame.fake.posts[0]!.data as { source: { bytes: ArrayBuffer } };
    expect(new Uint8Array(sent.source.bytes)).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
  });

  it('closes the port and removes the frame when destroyed', async () => {
    const frame = mount();
    const side = handshake(frame);
    const closed = new Promise<void>((resolve) =>
      (side.port as unknown as { once(name: string, f: () => void): void }).once('close', resolve),
    );
    const pending = expect(
      frame.embed.requestPreview({ maxWidth: 100, maxHeight: 100, scale: 1 }),
    ).rejects.toMatchObject({ code: 'source.unavailable', message: 'The embed was destroyed' });
    frame.embed.destroy();
    await closed;
    await pending;
    expect(frame.iframe.isConnected).toBe(false);
    expect(frame.container.childElementCount).toBe(0);
    expect(frame.embed.state).toBe('destroyed');

    // Nothing is heard or sent after it.
    side.answer(loaded);
    post(ready(), ORIGIN, frame.fake);
    frame.embed.setView(view);
    frame.embed.destroy();
    await turn();
    await turn();
    expect(frame.calls.loaded).toHaveLength(0);
    expect(frame.fake.posts).toHaveLength(1);
    await expect(
      frame.embed.requestPreview({ maxWidth: 100, maxHeight: 100, scale: 1 }),
    ).rejects.toBeInstanceOf(SheetEmbedError);
  });
});
