// Phase 11, M11.2: the account's passkeys in Settings → Account. The routes' request shapes (list,
// rename with its antiforgery header, remove); "Add a passkey"'s address (the API's page, back to
// this app's Settings on the web, the system browser and no address to come back to on the
// desktop); and the section: the list with when each was added and last used, rename in place,
// remove asking first, each refusal in words, the list read again as the desktop's window comes
// back, the 20 at most, and Arabic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
// jsdom's `location` is not a global after installDom (CLAUDE.md, Phase 6).
Object.defineProperty(globalThis, 'location', {
  value: window.location,
  configurable: true,
  writable: true,
});
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createApi } = await import('@cgw/api');
const { SyncHttpError } = await import('@cgw/workspace');
const { createI18n } = await import('../i18n');
const { PASSKEY_LIMIT, passkeyPageUrl, passkeysHost } = await import('./passkeys');
const { PasskeysSettings, passkeyRefusalKey } = await import('./PasskeysSettings');
type Passkey = import('./passkeys').Passkey;
type PasskeysHost = import('./passkeys').PasskeysHost;
type Cloud = import('./cloud').Cloud;

const LAPTOP: Passkey = {
  id: 'cred-laptop_1',
  name: 'Chrome on Windows',
  createdAt: '2026-11-19T10:00:00Z',
  lastUsedAt: '2026-11-19T12:30:00Z',
};
const PHONE: Passkey = {
  id: 'cred-phone_2',
  name: 'Phone',
  createdAt: '2026-11-18T08:15:00Z',
  lastUsedAt: null,
};

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(h(I18nextProvider, { i18n: createI18n(language) }, node)));
  return container;
}

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 200 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;
const named = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) ?? null;
const rows = () => [
  ...document.querySelectorAll<HTMLElement>('[data-testid="passkeys-list"] > li'),
];
const status = () => document.querySelector('[data-testid="passkeys-status"]')?.textContent;
const addButton = () => document.querySelector<HTMLButtonElement>('[data-testid="passkey-add"]')!;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A host holding `stored`, as the server would; each method a spy. */
function fakeHost(initial: Passkey[], where: 'left' | 'browser' = 'left') {
  let stored = initial.map((p) => ({ ...p }));
  const host = {
    list: vi.fn(async () => stored.map((p) => ({ ...p }))),
    rename: vi.fn(async (id: string, name: string) => {
      const found = stored.find((p) => p.id === id);
      if (!found) throw new SyncHttpError(404, 'not.found');
      found.name = name;
      return { ...found };
    }),
    remove: vi.fn(async (id: string) => {
      stored = stored.filter((p) => p.id !== id);
    }),
    add: vi.fn(async () => where),
    set(next: Passkey[]) {
      stored = next.map((p) => ({ ...p }));
    },
  };
  return host satisfies PasskeysHost;
}

const english = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

// ------------------------------------------------------------------------------------- the routes

describe('the passkey routes', () => {
  it('list, rename with the antiforgery header, and remove by the credential id', async () => {
    const requests: { method: string; url: URL; headers: Headers; body: unknown }[] = [];
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const fetch = async (given: Request | string, init?: RequestInit) => {
      const input = typeof given === 'string' ? new Request(given, init) : given;
      const url = new URL(input.url);
      const text = input.method === 'GET' || input.method === 'DELETE' ? '' : await input.text();
      requests.push({
        method: input.method,
        url,
        headers: input.headers,
        body: text ? JSON.parse(text) : null,
      });
      if (url.pathname === '/api/v1/account/antiforgery') return json({ token: 'csrf' });
      if (input.method === 'GET') return json({ passkeys: [LAPTOP, PHONE] });
      if (input.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/gone'))
        return json({ code: 'not.found', title: 'No such passkey' }, 404);
      return json({ ...LAPTOP, name: 'Work laptop' });
    };
    const api = createApi({
      baseUrl: 'http://api.test',
      auth: { kind: 'cookie' },
      fetch: fetch as never,
    });
    const host = passkeysHost({ api, platform: { kind: 'web' } } as unknown as Cloud);

    expect(await host.list()).toEqual([LAPTOP, PHONE]);
    expect(requests.at(-1)).toMatchObject({ method: 'GET' });
    expect(requests.at(-1)!.url.pathname).toBe('/api/v1/account/passkeys');

    expect(await host.rename(LAPTOP.id, 'Work laptop')).toMatchObject({ name: 'Work laptop' });
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: { name: 'Work laptop' } });
    expect(requests.at(-1)!.url.pathname).toBe(`/api/v1/account/passkeys/${LAPTOP.id}`);
    expect(requests.at(-1)!.headers.get('X-CSRF-TOKEN')).toBe('csrf');

    await host.remove(PHONE.id);
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(requests.at(-1)!.url.pathname).toBe(`/api/v1/account/passkeys/${PHONE.id}`);
    expect(requests.at(-1)!.headers.get('X-CSRF-TOKEN')).toBe('csrf');

    // A refusal carries the server's code.
    const refused = await host.rename('gone', 'x').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SyncHttpError);
    expect(refused).toMatchObject({ status: 404, code: 'not.found' });
  });
});

describe('“Add a passkey”', () => {
  it('goes to the API’s page in this tab on the web, back to this app’s Settings', async () => {
    const assign = vi.fn();
    const openExternal = vi.fn();
    const host = passkeysHost(
      {
        api: { baseUrl: 'http://api.test' },
        platform: { kind: 'web', openExternal },
      } as unknown as Cloud,
      assign,
    );
    expect(await host.add('en')).toBe('left');
    expect(openExternal).not.toHaveBeenCalled();
    const back = `${location.origin}${location.pathname}#/settings`;
    expect(back).toBe('http://127.0.0.1/#/settings');
    expect(assign).toHaveBeenCalledWith(
      `http://api.test/account/passkeys/new?lang=en&return=${encodeURIComponent(back)}`,
    );
    const url = new URL(assign.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('http://api.test/account/passkeys/new');
    expect(url.searchParams.get('return')).toBe('http://127.0.0.1/#/settings');
    expect(url.searchParams.get('lang')).toBe('en');
  });

  it('opens it in the system browser on the desktop, in the interface language, with no return', async () => {
    const assign = vi.fn();
    const openExternal = vi.fn(async () => {});
    const host = passkeysHost(
      {
        api: { baseUrl: 'https://workspace-api.cashgearerp.com' },
        platform: { kind: 'desktop', openExternal },
      } as unknown as Cloud,
      assign,
    );
    expect(await host.add('ar')).toBe('browser');
    expect(assign).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(
      'https://workspace-api.cashgearerp.com/account/passkeys/new?lang=ar',
    );
    expect(passkeyPageUrl('http://api.test', 'en', 'http://app.test/#/settings')).toBe(
      'http://api.test/account/passkeys/new?lang=en&return=http%3A%2F%2Fapp.test%2F%23%2Fsettings',
    );
  });
});

// ------------------------------------------------------------------------------------ the section

describe('Settings → Account → Passkeys', () => {
  it('lists each passkey with when it was added and last used, and offers to add one', async () => {
    const host = fakeHost([LAPTOP, PHONE]);
    render(h(PasskeysSettings, { host }));
    expect(addButton().disabled).toBe(true);
    await until(() => rows().length === 2, 'the list');
    const [laptop, phone] = rows();
    expect(laptop.querySelector('strong')!.textContent).toBe('Chrome on Windows');
    expect(laptop.querySelector('strong')!.getAttribute('dir')).toBe('auto');
    expect(laptop.textContent).toContain(`Added ${english.format(new Date(LAPTOP.createdAt))}`);
    expect(laptop.textContent).toContain(
      `Last used ${english.format(new Date(LAPTOP.lastUsedAt!))}`,
    );
    expect(phone.textContent).toContain(`Added ${english.format(new Date(PHONE.createdAt))}`);
    expect(phone.textContent).toContain('Not used yet');
    expect(named(laptop, 'Rename Chrome on Windows')!.textContent).toBe('Rename');
    expect(named(phone, 'Remove Phone')!.textContent).toBe('Remove');
    expect(addButton().textContent).toBe('Add a passkey');
    expect(addButton().disabled).toBe(false);
    expect(document.querySelector('[data-testid="passkeys-settings"] h3')!.textContent).toBe(
      'Passkeys',
    );
  });

  it('says when there is none, and when the list could not be read (no add then)', async () => {
    render(h(PasskeysSettings, { host: fakeHost([]) }));
    await until(() => !addButton().disabled, 'the list');
    expect(document.body.textContent).toContain('No passkeys yet.');
    act(() => document.body.replaceChildren());

    const failing = fakeHost([]);
    failing.list.mockRejectedValue(new TypeError('Failed to fetch'));
    render(h(PasskeysSettings, { host: failing }));
    await until(
      () => !!document.body.textContent?.includes('The passkeys could not be read.'),
      'the failure',
    );
    expect(addButton().disabled).toBe(true);
  });

  it('renames in place, the name trimmed, and gives the focus back to Rename', async () => {
    const host = fakeHost([LAPTOP, PHONE]);
    render(h(PasskeysSettings, { host }));
    await until(() => rows().length === 2, 'the list');
    act(() => named(rows()[0], 'Rename Chrome on Windows')!.click());
    const input = document.getElementById('cgw-passkey-name') as HTMLInputElement;
    expect(input.value).toBe('Chrome on Windows');
    expect(input.maxLength).toBe(60);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('label[for="cgw-passkey-name"]')!.textContent).toBe(
      'Name of the passkey',
    );
    act(() => type(input, '   '));
    expect(button(rows()[0], 'Save')!.disabled).toBe(true);
    act(() => type(input, '  Work laptop '));
    await act(async () => button(rows()[0], 'Save')!.click());
    await until(() => !document.getElementById('cgw-passkey-name'), 'the form to close');
    expect(host.rename).toHaveBeenCalledWith(LAPTOP.id, 'Work laptop');
    expect(rows()[0].querySelector('strong')!.textContent).toBe('Work laptop');
    expect(status()).toBe('The passkey is now called “Work laptop”.');
    expect(document.activeElement).toBe(named(rows()[0], 'Rename Work laptop'));

    // Cancel and an unchanged name change nothing.
    act(() => named(rows()[1], 'Rename Phone')!.click());
    act(() => button(rows()[1], 'Cancel')!.click());
    act(() => named(rows()[1], 'Rename Phone')!.click());
    await act(async () => button(rows()[1], 'Save')!.click());
    expect(host.rename).toHaveBeenCalledTimes(1);
  });

  it('asks before removing, saying it no longer signs in and its sessions stay', async () => {
    const host = fakeHost([LAPTOP, PHONE]);
    render(h(PasskeysSettings, { host }));
    await until(() => rows().length === 2, 'the list');
    act(() => named(rows()[1], 'Remove Phone')!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Remove the passkey “Phone”?');
    expect(dialog.textContent).toContain('You can no longer sign in with it.');
    expect(dialog.textContent).toContain(
      'Sessions it signed in stay signed in until you sign them out under “Devices signed in”.',
    );
    act(() => button(dialog, 'Cancel')!.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.remove).not.toHaveBeenCalled();

    act(() => named(rows()[1], 'Remove Phone')!.click());
    await act(async () =>
      button(document.querySelector('[role="alertdialog"]')!, 'Remove the passkey')!.click(),
    );
    await until(() => rows().length === 1, 'the row to go');
    expect(host.remove).toHaveBeenCalledWith(PHONE.id);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(rows()[0].querySelector('strong')!.textContent).toBe('Chrome on Windows');
    expect(status()).toBe('“Phone” is removed.');
  });

  it('says each refusal in words, and reads the list again for one removed meanwhile', async () => {
    expect(passkeyRefusalKey('request.invalid')).toBe('passkeys.invalid');
    expect(passkeyRefusalKey('not.found')).toBe('passkeys.gone');
    expect(passkeyRefusalKey('access.denied')).toBe('cloud.requestFailed');

    const host = fakeHost([LAPTOP, PHONE]);
    render(h(PasskeysSettings, { host }));
    await until(() => rows().length === 2, 'the list');

    // A name the server does not take: said, the form kept for another try.
    host.rename.mockRejectedValueOnce(new SyncHttpError(400, 'request.invalid'));
    act(() => named(rows()[0], 'Rename Chrome on Windows')!.click());
    act(() => type(document.getElementById('cgw-passkey-name') as HTMLInputElement, 'Laptop'));
    await act(async () => button(rows()[0], 'Save')!.click());
    await until(() => !!status(), 'the refusal');
    expect(status()).toBe('A passkey’s name is 1 to 60 characters.');
    expect(document.getElementById('cgw-passkey-name')).not.toBeNull();

    // Removed meanwhile elsewhere: said, and the list read again as it is now.
    host.set([PHONE]);
    host.rename.mockRejectedValueOnce(new SyncHttpError(404, 'not.found'));
    const before = host.list.mock.calls.length;
    await act(async () => button(rows()[0], 'Save')!.click());
    await until(() => host.list.mock.calls.length > before, 'the list read again');
    await until(() => rows()[0]?.querySelector('strong')?.textContent === 'Phone', 'the new list');
    expect(status()).toBe('That passkey was removed meanwhile.');
    expect(document.getElementById('cgw-passkey-name')).toBeNull();

    // Anything else: the usual words.
    host.remove.mockRejectedValueOnce(new SyncHttpError(500, 'server.error'));
    act(() => named(rows()[0], 'Remove Phone')!.click());
    await act(async () =>
      button(document.querySelector('[role="alertdialog"]')!, 'Remove the passkey')!.click(),
    );
    await until(() => status() === 'The server did not take that. Try again.', 'the refusal');
    expect(rows()).toHaveLength(1);
  });

  it('opens the page on the web as it is, and on the desktop reads the list again on coming back', async () => {
    const web = fakeHost([]);
    render(h(PasskeysSettings, { host: web }));
    await until(() => !addButton().disabled, 'the list');
    await act(async () => addButton().click());
    expect(web.add).toHaveBeenCalledWith('en');
    expect(status()).toBeUndefined();
    act(() => document.body.replaceChildren());

    const desktop = fakeHost([], 'browser');
    render(h(PasskeysSettings, { host: desktop }));
    await until(() => !addButton().disabled, 'the list');
    // The window's focus reads nothing again until the browser was opened.
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(desktop.list).toHaveBeenCalledTimes(1);
    await act(async () => addButton().click());
    expect(status()).toBe(
      'Add the passkey in your browser, then come back here: the list is read again when you do.',
    );
    desktop.set([LAPTOP]);
    act(() => void window.dispatchEvent(new Event('focus')));
    await until(() => rows().length === 1, 'the list read again');
    expect(desktop.list).toHaveBeenCalledTimes(2);
  });

  it('offers no more than the account may have', async () => {
    const many = Array.from({ length: PASSKEY_LIMIT }, (_, i) => ({
      ...PHONE,
      id: `cred-${i}`,
      name: `Key ${i + 1}`,
    }));
    render(h(PasskeysSettings, { host: fakeHost(many) }));
    await until(() => rows().length === PASSKEY_LIMIT, 'the list');
    expect(addButton().disabled).toBe(true);
    expect(document.body.textContent).toContain(
      'An account has at most 20 passkeys. Remove one to add another.',
    );
  });

  it('reads in Arabic, dates and numbers too', async () => {
    const many = Array.from({ length: PASSKEY_LIMIT }, (_, i) => ({ ...LAPTOP, id: `cred-${i}` }));
    render(h(PasskeysSettings, { host: fakeHost(many) }), 'ar');
    await until(() => rows().length === PASSKEY_LIMIT, 'the list');
    const arabic = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' });
    expect(document.querySelector('[data-testid="passkeys-settings"] h3')!.textContent).toBe(
      'مفاتيح المرور',
    );
    expect(rows()[0].textContent).toContain(`أُضيف ${arabic.format(new Date(LAPTOP.createdAt))}`);
    expect(rows()[0].textContent).toContain(
      `آخر استخدام ${arabic.format(new Date(LAPTOP.lastUsedAt!))}`,
    );
    expect(named(rows()[0], 'إعادة تسمية Chrome on Windows')!.textContent).toBe('إعادة تسمية');
    expect(addButton().textContent).toBe('إضافة مفتاح مرور');
    expect(document.body.textContent).toContain(
      `للحساب ${new Intl.NumberFormat('ar').format(20)} مفتاح مرور على الأكثر.`,
    );
  });
});
