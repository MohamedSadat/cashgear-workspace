// The shell's ERP wiring: the link ticket out of the address before any route, the route without
// it, the tab's services (availability, links read once and again not too often, the desktop's
// return taken before routing), and the block's frame (a root per block, kept across a remount,
// in the interface direction).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
// The address and its history, as a page has them (the DOM helper leaves them on its window).
for (const name of ['history', 'location'] as const)
  Object.defineProperty(globalThis, name, { value: window[name], configurable: true });
const { act } = await import('react');
const { MemoryStore } = await import('@cgw/workspace');
const { localWorkspace } = await import('../../../workspace/src/testing/syncHarness');
const { createI18n } = await import('../i18n');
const { parseRoute, routeHash } = await import('../route');
const { WorkspaceSession } = await import('../session');
const {
  ERP_LINK_HASH,
  captureErpLinkTicket,
  forgetErpLinkTicket,
  heldErpLinkTicket,
  installErpLinkCapture,
} = await import('./linkTicket');
const { ShellErp } = await import('./services');
const { mountErp } = await import('./mount');

const TICKET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const STATE = '0123456789abcdefABCD-_';

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 400 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const platform = {
  kind: 'web' as const,
  erp: { apiBase: 'http://127.0.0.1:4282', clientOrigin: 'http://127.0.0.1:4284' },
  setWindowTheme: async () => {},
  openExternal: vi.fn(async () => {}),
  openStore: async () => new MemoryStore(),
  saveFile: async () => {},
};

afterEach(() => {
  forgetErpLinkTicket();
  history.replaceState(null, '', '/');
});

describe('the link ticket in the address', () => {
  it('is taken out at once: the address and its history entry hold only #/erp-link', () => {
    history.replaceState(null, '', '/');
    const before = history.length;
    location.hash = `#/erp-link/${TICKET}`;
    expect(history.length).toBe(before + 1);
    expect(captureErpLinkTicket()).toBe(true);
    expect(location.hash).toBe(ERP_LINK_HASH);
    expect(location.href).not.toContain(TICKET);
    // The entry was replaced, not added to: going back never shows the ticket either.
    expect(history.length).toBe(before + 1);
    expect(heldErpLinkTicket()).toBe(TICKET);
    // The route holds no ticket, whatever the hash has.
    expect(parseRoute(location.hash)).toEqual({ kind: 'erpLink' });
    expect(parseRoute(`#/erp-link/${TICKET}`)).toEqual({ kind: 'erpLink' });
    expect(routeHash({ kind: 'erpLink' })).toBe('#/erp-link');
  });

  it('is forgotten when used, and after its 120 seconds', () => {
    const now = Date.now();
    expect(
      captureErpLinkTicket(
        { hash: `#/erp-link/${TICKET}`, pathname: '/', search: '' },
        history,
        now,
      ),
    ).toBe(true);
    expect(heldErpLinkTicket(now + 119_000)).toBe(TICKET);
    expect(heldErpLinkTicket(now + 120_000)).toBeNull();
    forgetErpLinkTicket();
    expect(heldErpLinkTicket(now)).toBeNull();
  });

  it('is taken before the router hears the hash change', async () => {
    installErpLinkCapture(window);
    const heard: string[] = [];
    const router = () => heard.push(location.hash);
    window.addEventListener('hashchange', router);
    location.hash = `#/erp-link/${TICKET}`;
    await until(() => heard.length > 0, 'the hash change');
    window.removeEventListener('hashchange', router);
    // Whatever hash changes it heard (one may be an earlier test's, delivered late), the router
    // never saw a ticket.
    expect(heard.every((hash) => hash === ERP_LINK_HASH)).toBe(true);
    expect(heldErpLinkTicket()).toBe(TICKET);
  });

  it('is not taken from anything else', () => {
    for (const hash of [
      '#/erp-link',
      `#/erp-link/${TICKET}x`,
      `#/erp-link/${TICKET}/more`,
      '#/p/x',
    ])
      expect(captureErpLinkTicket({ hash, pathname: '/', search: '' })).toBe(false);
    expect(heldErpLinkTicket()).toBeNull();
  });
});

async function setup(options: { signedIn?: boolean; localOnly?: boolean } = {}) {
  const store = new MemoryStore();
  const made = await localWorkspace(store);
  const session = await WorkspaceSession.start(store);
  session.switchTo(made.ws.id);
  if (!options.localOnly)
    Object.assign(session.mirror.workspaces.get(made.ws.id)!, { localOnly: false, role: 'owner' });
  const lists: string[] = [];
  const listeners = new Set<() => void>();
  const cloud = {
    account: () =>
      options.signedIn === false
        ? null
        : { id: 'u-1', email: 'a@example.test', displayName: 'Alice', deviceId: 'd-1' },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    listLinks: vi.fn(async (workspaceId: string) => {
      lists.push(workspaceId);
      return [
        {
          id: 'wl-1',
          erpLinkId: 'erp-1',
          workspaceId,
          company: 'Kit',
          companyName: 'Kit Trading',
          linkedBy: { id: 'u-9', name: 'Dana' },
          linkedAt: '2026-11-14T09:00:00Z',
        },
      ];
    }),
    createLink: vi.fn(async () => 'created' as const),
    deleteLink: vi.fn(async () => undefined),
  };
  let now = 1_000_000;
  const services = new ShellErp(session, platform, {
    target: null,
    now: () => now,
    flow: async () => TICKET,
  });
  services.setCloud(cloud as never);
  return { session, made, services, cloud, lists, advance: (ms: number) => (now += ms) };
}

describe('the tab’s ERP services', () => {
  it('say whether ERP data can be used here', async () => {
    expect((await setup()).services.availability()).toBe('ready');
    expect((await setup({ signedIn: false })).services.availability()).toBe('signedOut');
    expect((await setup({ localOnly: true })).services.availability()).toBe('localWorkspace');
    const { session, services } = await setup();
    services.setCloud(null);
    expect(services.availability()).toBe('signedOut');
    expect(services.connectKind).toBe('popup');
    void session;
  });

  it('read the links once, and again only after a while', async () => {
    const { services, lists, advance } = await setup();
    const heard = vi.fn();
    const off = services.subscribe(heard);
    expect(services.links()).toEqual({ status: 'loading' });
    services.loadLinks();
    services.loadLinks();
    await until(() => services.links().status === 'ready', 'the links');
    expect(lists.length).toBe(1);
    const first = services.links();
    // Stable between changes (the views read it with useSyncExternalStore).
    expect(services.links()).toBe(first);
    services.reloadLinks();
    expect(lists.length).toBe(1);
    advance(31_000);
    services.reloadLinks();
    await until(() => lists.length === 2, 'the second read');
    expect(heard).toHaveBeenCalled();
    off();
  });

  it('take the desktop’s ERP return before any route, and nothing else', async () => {
    const { services } = await setup();
    expect(services.takeDeepLink('#/p/01933b5e-7c2a-7d4e-9f00-1a2b3c4d5e6f')).toBe(false);
    expect(services.takeDeepLink(`cashgear-workspace://erp#ticket=${TICKET}&state=${STATE}`)).toBe(
      true,
    );
  });
});

describe('an ERP block’s frame', { timeout: 30_000 }, () => {
  const options = (over: Record<string, unknown> = {}) => ({
    linkId: null,
    connectorId: null,
    filter: null,
    fields: null,
    sort: null,
    pageSize: null,
    blockId: 'AbCdEfGhIjKl',
    editable: true,
    setAttrs: vi.fn(),
    ...over,
  });

  it('draws the view in its own root, in the interface direction, kept across a remount', async () => {
    const { services } = await setup({ signedIn: false });
    const i18n = createI18n('en');
    const first = document.createElement('div');
    document.body.append(first);
    let frame = mountErp(first, options(), { services, i18n });
    const container = first.firstElementChild as HTMLElement;
    expect(container.className).toBe('cgw-erp-block');
    await until(() => !!container.querySelector('[data-testid="erp-signed-out"]'), 'the view');
    expect(container.dir).toBe('ltr');
    expect(container.textContent).toBe(i18n.t('erp.signIn'));

    // The block chose its link: the editor mounts again; the same root is moved.
    frame.destroy();
    const second = document.createElement('div');
    document.body.append(second);
    frame = mountErp(second, options({ linkId: 'wl-1' }), { services, i18n });
    expect(second.firstElementChild).toBe(container);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(container.isConnected).toBe(true);

    // Arabic: drawn right to left, in Arabic.
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    expect(container.dir).toBe('rtl');
    expect(container.lang).toBe('ar');
    expect(container.textContent).toBe(i18n.t('erp.signIn'));

    frame.destroy();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(second.childElementCount).toBe(0);
  });

  it('passes setting changes to the view by update, and writes only when editable', async () => {
    const { services } = await setup();
    const i18n = createI18n('en');
    const element = document.createElement('div');
    document.body.append(element);
    const setAttrs = vi.fn();
    const frame = mountErp(element, options({ linkId: 'wl-1', setAttrs, editable: false }), {
      services,
      i18n,
    });
    await until(
      () => !!element.querySelector('[data-testid="erp-not-connected"]'),
      'not connected',
    );
    frame.update(options({ linkId: 'wl-gone', setAttrs, editable: false }));
    await until(() => !!element.querySelector('[data-testid="erp-link-gone"]'), 'link gone');
    expect(setAttrs).not.toHaveBeenCalled();
    frame.destroy();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  });
});
