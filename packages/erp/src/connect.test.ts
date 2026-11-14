import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectState,
  connectUrl,
  deepLinkConnect,
  isErpDeepLink,
  parseErpDeepLink,
  popupConnect,
  type MessageTarget,
  type PopupWindow,
} from './connect';
import { ErpError } from './contract';

const CLIENT = 'http://127.0.0.1:4284';
const TICKET = 'K'.repeat(42) + '-';
const OTHER_TICKET = 'Q'.repeat(43);

/** The window: hears `message` and delivers what a test posts. */
function window() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const messages: MessageTarget = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const post = (data: unknown, origin: string, source: unknown) => {
    for (const listener of [...listeners]) listener({ data, origin, source } as MessageEvent);
  };
  return { messages, post, listeners };
}

function popup(): PopupWindow & { closed: boolean; closes: number } {
  const w = {
    closed: false,
    closes: 0,
    close() {
      w.closes++;
      w.closed = true;
    },
  };
  return w;
}

function start(options: { signal?: AbortSignal } = {}) {
  const win = window();
  const opened = popup();
  const urls: string[] = [];
  const result = popupConnect({
    clientOrigin: CLIENT,
    workspaceId: 'ws-1',
    erpLinkId: 'erp-kit',
    open: (url) => {
      urls.push(url);
      return opened;
    },
    messages: win.messages,
    signal: options.signal,
    pollMs: 100,
    closeGraceMs: 300,
  });
  const url = new URL(urls[0]!);
  const state = url.searchParams.get('state')!;
  const settled = vi.fn();
  result.then(settled, settled);
  return { ...win, opened, url, state, result, settled };
}

const message = (state: string, ticket = TICKET) => ({ type: 'cgw-erp-connect', ticket, state });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the state', () => {
  it('is 128 random bits in base64url', () => {
    const states = new Set(Array.from({ length: 50 }, connectState));
    expect(states.size).toBe(50);
    for (const state of states) expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('popupConnect', () => {
  it('opens the ERP client’s connect page at once', () => {
    const { url, state } = start();
    expect(url.origin).toBe(CLIENT);
    expect(url.pathname).toBe('/workspace-connect');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      workspace: 'ws-1',
      link: 'erp-kit',
      state,
      return: 'web',
    });
  });

  it('takes the ticket from the pop-up, with its state, and closes it', async () => {
    const { post, opened, state, result, listeners } = start();
    post(message(state), CLIENT, opened);
    await expect(result).resolves.toBe(TICKET);
    expect(opened.closes).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it('ignores a message from another origin, another window, or with another state', async () => {
    const { post, opened, state, settled, result } = start();
    post(message(state, OTHER_TICKET), 'http://127.0.0.1:4285', opened);
    post(message(state, OTHER_TICKET), 'https://evil.example', opened);
    post(message(state, OTHER_TICKET), CLIENT, popup());
    post(message(state, OTHER_TICKET), CLIENT, null);
    post(message('S'.repeat(22), OTHER_TICKET), CLIENT, opened);
    post({ ...message(state, OTHER_TICKET), type: 'cgw-erp-link' }, CLIENT, opened);
    post(message(state, 'not-a-ticket'), CLIENT, opened);
    post(JSON.stringify(message(state, OTHER_TICKET)), CLIENT, opened);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    post(message(state), CLIENT, opened);
    await expect(result).resolves.toBe(TICKET);
  });

  it('takes one ticket only', async () => {
    const { post, opened, state, result } = start();
    post(message(state), CLIENT, opened);
    post(message(state, OTHER_TICKET), CLIENT, opened);
    await expect(result).resolves.toBe(TICKET);
  });

  it('gives a fresh state to each connect', () => {
    expect(start().state).not.toBe(start().state);
  });

  it('fails as connect.blocked when the pop-up does not open', async () => {
    const win = window();
    const run = (open: () => PopupWindow | null) =>
      popupConnect({
        clientOrigin: CLIENT,
        workspaceId: 'w',
        erpLinkId: 'l',
        open,
        messages: win.messages,
      });
    await expect(run(() => null)).rejects.toMatchObject({ code: 'connect.blocked' });
    await expect(
      run(() => {
        throw new Error('blocked');
      }),
    ).rejects.toMatchObject({ code: 'connect.blocked' });
    expect(win.listeners.size).toBe(0);
  });

  it('fails as connect.cancelled when the person closes the pop-up', async () => {
    const { opened, result, settled } = start();
    opened.closed = true;
    await vi.advanceTimersByTimeAsync(150);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).rejects.toMatchObject({ code: 'connect.cancelled' });
  });

  it('still takes a message that arrives as the pop-up closes', async () => {
    const { opened, post, state, result } = start();
    opened.closed = true;
    await vi.advanceTimersByTimeAsync(150);
    post(message(state), CLIENT, opened);
    await expect(result).resolves.toBe(TICKET);
  });

  it('stops, and closes the pop-up, when aborted', async () => {
    const controller = new AbortController();
    const { opened, post, state, result } = start({ signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'aborted' });
    expect(opened.closes).toBe(1);
    post(message(state), CLIENT, opened);
    const open = vi.fn();
    await expect(
      popupConnect({
        clientOrigin: CLIENT,
        workspaceId: 'w',
        erpLinkId: 'l',
        open,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ErpError);
    expect(open).not.toHaveBeenCalled();
  });

  it('takes only an origin for the ERP client', async () => {
    for (const clientOrigin of [
      'http://127.0.0.1:4284/',
      'http://127.0.0.1:4284/x',
      'javascript:x',
    ]) {
      const open = vi.fn();
      await expect(
        popupConnect({
          clientOrigin,
          workspaceId: 'w',
          erpLinkId: 'l',
          open,
          messages: window().messages,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(open).not.toHaveBeenCalled();
    }
  });
});

describe('deep links', () => {
  const link = (ticket: string, state: string) =>
    `cashgear-workspace://erp#ticket=${ticket}&state=${state}`;

  it('reads the ERP’s return, and nothing else', () => {
    const state = 'S'.repeat(22);
    expect(parseErpDeepLink(link(TICKET, state))).toEqual({ ticket: TICKET, state });
    expect(parseErpDeepLink(`cashgear-workspace://erp/#ticket=${TICKET}&state=${state}`)).toEqual({
      ticket: TICKET,
      state,
    });
    expect(parseErpDeepLink(`cashgear-workspace://erp?ticket=${TICKET}&state=${state}`)).toBeNull();
    expect(
      parseErpDeepLink(`cashgear-workspace://erpx#ticket=${TICKET}&state=${state}`),
    ).toBeNull();
    expect(
      parseErpDeepLink(`cashgear-workspace://page/abc#ticket=${TICKET}&state=${state}`),
    ).toBeNull();
    expect(parseErpDeepLink(link('short', state))).toBeNull();
    expect(parseErpDeepLink(link(TICKET, 'short'))).toBeNull();
    expect(isErpDeepLink(link(TICKET, state))).toBe(true);
    expect(isErpDeepLink('cashgear-workspace://erp')).toBe(true);
    expect(isErpDeepLink('cashgear-workspace://erpx')).toBe(false);
    expect(isErpDeepLink('cashgear-workspace://page/abc')).toBe(false);
  });

  function startDesktop(
    options: { openExternal?: (url: string) => void | Promise<void>; signal?: AbortSignal } = {},
  ) {
    const listeners = new Set<(url: string) => void>();
    const urls: string[] = [];
    const result = deepLinkConnect({
      clientUrl: CLIENT,
      workspaceId: 'ws-1',
      erpLinkId: 'erp-kit',
      openExternal: options.openExternal ?? ((url) => void urls.push(url)),
      onDeepLink: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      signal: options.signal,
    });
    const deliver = (url: string) => [...listeners].forEach((l) => l(url));
    return { result, urls, listeners, deliver };
  }

  it('opens the connect page for the desktop and takes the ticket back once', async () => {
    const { result, urls, deliver, listeners } = startDesktop();
    await vi.advanceTimersByTimeAsync(0);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get('return')).toBe('desktop');
    const state = url.searchParams.get('state')!;
    deliver(link(OTHER_TICKET, 'S'.repeat(22)));
    deliver('cashgear-workspace://page/abc');
    deliver(link(TICKET, state));
    deliver(link(OTHER_TICKET, state));
    await expect(result).resolves.toBe(TICKET);
    expect(listeners.size).toBe(0);
  });

  it('fails as connect.blocked when the browser does not open, and aborted when stopped', async () => {
    await expect(
      startDesktop({ openExternal: () => Promise.reject(new Error('no')) }).result,
    ).rejects.toMatchObject({
      code: 'connect.blocked',
    });
    const controller = new AbortController();
    const { result, listeners } = startDesktop({ signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'aborted' });
    expect(listeners.size).toBe(0);
  });
});

describe('connectUrl', () => {
  it('encodes what it is given', () => {
    const url = connectUrl(CLIENT, {
      workspaceId: 'a&b',
      erpLinkId: 'l=1',
      state: 'S'.repeat(22),
      return: 'web',
    });
    expect(new URL(url).searchParams.get('workspace')).toBe('a&b');
    expect(new URL(url).searchParams.get('link')).toBe('l=1');
  });
});
