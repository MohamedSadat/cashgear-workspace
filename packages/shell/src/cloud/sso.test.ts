// Phase 11, M11.3: single sign-on in the client. The owners' routes' request shapes (the provider
// with If-Match, and its secret: a string sets, null removes, left out keeps); Settings → Single
// sign-on: owners only, the provider's form and its secret, the session's hours, a domain from
// added to proven to required (asked first) and removed (asked first), every refusal in words, the
// redirect address and the record copied; Settings → Account's "Set a password" by the reset mail,
// or the organisation's words when its domain requires sign-on; and Arabic.
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
const { passwordHost, providerBody, ssoHost } = await import('./sso');
const { SsoSection, SsoSettings, changeOf, draftOf, hoursOf, ssoRefusalKey } =
  await import('./SsoSettings');
const { PasswordSettings } = await import('./PasswordSettings');
type Settings = import('./sso').SsoSettings;
type SsoDomain = import('./sso').SsoDomain;
type SsoProvider = import('./sso').SsoProvider;
type SsoHost = import('./sso').SsoHost;
type PasswordHost = import('./sso').PasswordHost;
type AccountSignIn = import('./sso').AccountSignIn;
type Cloud = import('./cloud').Cloud;
type WorkspaceSession = import('../session').WorkspaceSession;

const WS = '01936f6e-0000-7000-8000-0000000000ff';
const API = 'http://api.test';
const REDIRECT = `${API}/account/sso/callback`;
const ISSUER = 'https://login.acme.test/realms/acme';

const PROVIDER: SsoProvider = {
  issuer: ISSUER,
  clientId: 'workspace',
  hasSecret: true,
  joinAsMember: true,
  sessionHours: 24,
  testedAt: null,
  version: 3,
};
const domainOf = (domain: string, verified = false, required = false): SsoDomain => ({
  domain,
  record: { name: `_cashgear-workspace.${domain}`, value: `cgw-verify=token-${domain}` },
  verifiedAt: verified ? '2026-11-19T09:00:00Z' : null,
  required,
});

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

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;
const named = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) ?? null;
const byId = <T extends HTMLElement = HTMLInputElement>(id: string) =>
  document.getElementById(id) as T;
const testId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const row = (domain: string) =>
  document.querySelector<HTMLElement>(`[data-sso-domain="${domain}"]`)!;
const ask = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const switchOf = (domain: string) =>
  row(domain).querySelector<HTMLInputElement>('input[role="switch"]')!;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A host holding the settings as the server would; each method a spy. */
function fakeHost(initial: Partial<Settings> = {}) {
  let stored: Settings = {
    domains: [],
    provider: null,
    redirectUri: REDIRECT,
    ...structuredClone(initial),
  };
  const find = (domain: string) => {
    const found = stored.domains.find((d) => d.domain === domain);
    if (!found) throw new SyncHttpError(404, 'not.found');
    return found;
  };
  const host = {
    read: vi.fn(async () => structuredClone(stored)),
    addDomain: vi.fn(async (domain: string) => {
      const added = domainOf(domain.toLowerCase());
      stored.domains.push(added);
      return structuredClone(added);
    }),
    verifyDomain: vi.fn(async (domain: string) => {
      const found = find(domain);
      found.verifiedAt = '2026-11-19T11:00:00Z';
      return structuredClone(found);
    }),
    requireDomain: vi.fn(async (domain: string, required: boolean) => {
      const found = find(domain);
      found.required = required;
      return structuredClone(found);
    }),
    removeDomain: vi.fn(async (domain: string) => {
      find(domain);
      stored.domains = stored.domains.filter((d) => d.domain !== domain);
    }),
    setProvider: vi.fn<SsoHost['setProvider']>(async (change) => {
      const before = stored.provider;
      const hasSecret =
        change.clientSecret === undefined ? !!before?.hasSecret : change.clientSecret !== null;
      stored.provider = {
        issuer: change.issuer,
        clientId: change.clientId,
        hasSecret,
        joinAsMember: change.joinAsMember,
        sessionHours: change.sessionHours,
        testedAt: null,
        version: (before?.version ?? 0) + 1,
      };
      return structuredClone(stored.provider);
    }),
    removeProvider: vi.fn(async () => {
      if (!stored.provider) throw new SyncHttpError(404, 'not.found');
      stored.provider = null;
      stored.domains = stored.domains.map((d) => ({ ...d, required: false }));
    }),
    set(next: Partial<Settings>) {
      stored = { ...stored, ...structuredClone(next) };
    },
  };
  return host satisfies SsoHost;
}

const english = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

// ------------------------------------------------------------------------------------- the routes

function fakeServer(answers: (request: { method: string; url: URL }) => Response | undefined) {
  const requests: { method: string; url: URL; headers: Headers; body: unknown; text: string }[] =
    [];
  const fetch = async (given: Request | string, init?: RequestInit) => {
    const input = typeof given === 'string' ? new Request(given, init) : given;
    const url = new URL(input.url);
    const text = input.method === 'GET' || input.method === 'DELETE' ? '' : await input.text();
    requests.push({
      method: input.method,
      url,
      headers: input.headers,
      body: text ? JSON.parse(text) : null,
      text,
    });
    if (url.pathname === '/api/v1/account/antiforgery') return json({ token: 'csrf' });
    return answers({ method: input.method, url }) ?? new Response(null, { status: 204 });
  };
  const api = createApi({ baseUrl: API, auth: { kind: 'cookie' }, fetch: fetch as never });
  return { api, requests, last: () => requests.at(-1)! };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('the single sign-on routes', () => {
  it('read the settings, and add, verify, require and remove a domain by its name', async () => {
    const pending = domainOf('acme.test');
    const { api, requests, last } = fakeServer(({ method, url }) => {
      if (method === 'GET')
        return json({
          domains: [pending],
          provider: { ...PROVIDER, sessionHours: '24', version: '3' },
          redirectUri: REDIRECT,
        });
      if (url.pathname.endsWith('/domains') && method === 'POST') return json(pending, 201);
      if (method === 'POST' || method === 'PATCH') return json(domainOf('acme.test', true));
      if (url.pathname.endsWith('/domains/missing.test'))
        return json({ code: 'sso.dnsNotFound', title: 'No record' }, 400);
      return undefined;
    });
    const host = ssoHost({ api } as unknown as Cloud, WS);

    expect(await host.read()).toEqual({
      domains: [pending],
      provider: PROVIDER,
      redirectUri: REDIRECT,
    });
    expect(last().url.pathname).toBe(`/api/v1/workspaces/${WS}/sso`);

    await host.addDomain('acme.test');
    expect(last()).toMatchObject({ method: 'POST', body: { domain: 'acme.test' } });
    expect(last().url.pathname).toBe(`/api/v1/workspaces/${WS}/sso/domains`);
    expect(last().headers.get('X-CSRF-TOKEN')).toBe('csrf');

    expect((await host.verifyDomain('acme.test')).verifiedAt).not.toBeNull();
    expect(last()).toMatchObject({ method: 'POST' });
    expect(last().url.pathname).toBe(`/api/v1/workspaces/${WS}/sso/domains/acme.test/verify`);

    await host.requireDomain('acme.test', true);
    expect(last()).toMatchObject({ method: 'PATCH', body: { required: true } });
    expect(last().url.pathname).toBe(`/api/v1/workspaces/${WS}/sso/domains/acme.test`);

    await host.removeDomain('acme.test');
    expect(last()).toMatchObject({ method: 'DELETE' });
    expect(last().url.pathname).toBe(`/api/v1/workspaces/${WS}/sso/domains/acme.test`);
    expect(last().headers.get('X-CSRF-TOKEN')).toBe('csrf');

    // A refusal carries the server's code.
    const refused = await host.removeDomain('missing.test').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SyncHttpError);
    expect(refused).toMatchObject({ status: 400, code: 'sso.dnsNotFound' });
    expect(requests.some((r) => r.method === 'GET' && r.url.pathname.includes('dns'))).toBe(false);
  });

  it('save the provider with If-Match: a secret typed sets it, null removes it, none keeps it', async () => {
    const { api, last } = fakeServer(({ method }) =>
      method === 'PUT' ? json({ ...PROVIDER, version: '4' }) : undefined,
    );
    const host = ssoHost({ api } as unknown as Cloud, WS);
    const base = { issuer: ISSUER, clientId: 'workspace', joinAsMember: false, sessionHours: 8 };

    expect(await host.setProvider({ ...base, clientSecret: 's3cret' }, 3)).toMatchObject({
      version: 4,
      sessionHours: 24,
    });
    expect(last()).toMatchObject({ method: 'PUT', body: { ...base, clientSecret: 's3cret' } });
    expect(last().url.pathname).toBe(`/api/v1/workspaces/${WS}/sso/provider`);
    expect(last().headers.get('If-Match')).toBe('"3"');

    await host.setProvider({ ...base, clientSecret: null }, 4);
    expect(last().body).toEqual({ ...base, clientSecret: null });
    expect(last().text).toContain('"clientSecret":null');

    await host.setProvider(base, 4);
    expect(last().body).toEqual(base);
    expect(last().text).not.toContain('clientSecret');

    // A first provider has no version to send.
    await host.setProvider(base);
    expect(last().headers.get('If-Match')).toBeNull();

    await host.removeProvider();
    expect(last()).toMatchObject({ method: 'DELETE' });
    expect(last().url.pathname).toBe(`/api/v1/workspaces/${WS}/sso/provider`);

    expect('clientSecret' in providerBody(base)).toBe(false);
    expect(providerBody({ ...base, clientSecret: null })).toHaveProperty('clientSecret', null);
  });

  it('read the account’s password from the session, and ask for the reset mail that sets one', async () => {
    const me = {
      id: 'u1',
      email: 'ada@acme.test',
      displayName: 'Ada',
      deviceId: null,
      hasPassword: false,
      ssoRequired: false,
      locale: 'en',
      signInUrl: '',
    };
    const { api, last } = fakeServer(({ method }) =>
      method === 'GET' ? json({ account: me }) : new Response(null, { status: 202 }),
    );
    const web = passwordHost({ api, platform: { kind: 'web' } } as unknown as Cloud);
    expect(await web.read()).toEqual({
      email: 'ada@acme.test',
      hasPassword: false,
      ssoRequired: false,
    });
    expect(last().url.pathname).toBe('/api/v1/account/session');

    await web.sendLink('ada@acme.test', 'ar');
    expect(last()).toMatchObject({
      method: 'POST',
      body: { email: 'ada@acme.test', locale: 'ar', returnUrl: 'http://127.0.0.1/' },
    });
    expect(last().url.pathname).toBe('/api/v1/account/password/forgot');
    expect(last().headers.get('X-CSRF-TOKEN')).toBe('csrf');

    const desktop = passwordHost({ api, platform: { kind: 'desktop' } } as unknown as Cloud);
    await desktop.sendLink('ada@acme.test', 'en');
    expect(last().body).toMatchObject({ locale: 'en', returnUrl: null });

    const signedOut = fakeServer(() => json({ account: null }));
    expect(
      await passwordHost({
        api: signedOut.api,
        platform: { kind: 'web' },
      } as unknown as Cloud).read(),
    ).toBeNull();
  });
});

// ----------------------------------------------------------------------------- the form's rules

describe('the provider’s form', () => {
  it('sends a typed secret, null after “Remove the secret”, and nothing to keep the one set', () => {
    const draft = draftOf(PROVIDER);
    expect(draft).toMatchObject({ issuer: ISSUER, secret: '', removeSecret: false, hours: '24' });
    expect('clientSecret' in changeOf(draft)).toBe(false);
    expect(changeOf({ ...draft, secret: '  n3w  ' }).clientSecret).toBe('n3w');
    expect(changeOf({ ...draft, removeSecret: true }).clientSecret).toBeNull();
    // A typed secret wins over a removal pressed before it.
    expect(changeOf({ ...draft, secret: 'n3w', removeSecret: true }).clientSecret).toBe('n3w');
    expect(draftOf(null)).toMatchObject({ issuer: '', joinAsMember: true, hours: '24' });
  });

  it('takes whole hours from 1 to 720', () => {
    expect(hoursOf('1')).toBe(1);
    expect(hoursOf(' 720 ')).toBe(720);
    for (const bad of ['0', '721', '1.5', '-3', '', 'abc', '1e2']) expect(hoursOf(bad)).toBeNull();
  });
});

// ------------------------------------------------------------------------------- the section

describe('Settings → Single sign-on', () => {
  it('shows admins, members and guests nothing and never asks; a local workspace has none', async () => {
    for (const role of ['admin', 'member', 'guest'] as const) {
      const host = fakeHost({ provider: PROVIDER });
      const container = render(h(SsoSettings, { host, role }));
      await settle();
      expect(container.innerHTML).toBe('');
      expect(host.read).not.toHaveBeenCalled();
    }

    const { api, requests } = fakeServer(() =>
      json({ domains: [], provider: null, redirectUri: REDIRECT }),
    );
    const cloud = {
      api,
      account: { id: 'u1', email: 'o@acme.test', displayName: 'O', deviceId: null },
      subscribe: () => () => {},
    } as unknown as Cloud;
    const session = (localOnly: boolean, role = 'owner') =>
      ({ current: { id: WS, name: 'Acme', localOnly, role } }) as unknown as WorkspaceSession;
    const local = render(h(SsoSection, { cloud, session: session(true) }));
    const admin = render(h(SsoSection, { cloud, session: session(false, 'admin') }));
    await settle();
    expect(local.innerHTML).toBe('');
    expect(admin.innerHTML).toBe('');
    expect(requests).toHaveLength(0);

    const synced = render(h(SsoSection, { cloud, session: session(false) }));
    await until(() => !!synced.querySelector('[data-testid="sso-provider-form"]'), 'the form');
    expect(synced.querySelector('h2')!.textContent).toBe('Single sign-on');
    expect(requests.map((r) => r.url.pathname)).toEqual([`/api/v1/workspaces/${WS}/sso`]);
  });

  it('shows the redirect address to register, and copies it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const host = fakeHost();
      const container = render(h(SsoSettings, { host, role: 'owner' }));
      await until(() => !!testId('sso-redirect'), 'the redirect address');
      expect(testId('sso-redirect')!.textContent).toBe(REDIRECT);
      expect(testId('sso-redirect')!.getAttribute('dir')).toBe('ltr');
      const copy = named(container, 'Copy the redirect address')!;
      expect(copy.textContent).toBe('Copy');
      await act(async () => copy.click());
      expect(writeText).toHaveBeenCalledWith(REDIRECT);
      expect(named(container, 'Copied the redirect address')!.textContent).toBe('Copied');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('saves a first provider with its secret, never shows it again, and says a secret is set', async () => {
    const host = fakeHost();
    const container = render(h(SsoSettings, { host, role: 'owner' }));
    await until(() => !!testId('sso-provider-form'), 'the form');
    expect(testId('sso-secret-state')!.textContent).toBe('No secret is set.');
    expect(byId('cgw-sso-secret').type).toBe('password');
    expect(byId('cgw-sso-hours').value).toBe('24');
    expect(testId('sso-tested')).toBeNull();
    expect(button(container, 'Remove the provider')).toBeNull();
    const save = testId('sso-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    act(() => type(byId('cgw-sso-issuer'), `  ${ISSUER} `));
    act(() => type(byId('cgw-sso-client'), 'workspace'));
    act(() => type(byId('cgw-sso-secret'), 's3cret'));
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(host.setProvider).toHaveBeenCalledWith(
      {
        issuer: ISSUER,
        clientId: 'workspace',
        clientSecret: 's3cret',
        joinAsMember: true,
        sessionHours: 24,
      },
      undefined,
    );
    await until(() => testId('sso-provider-status')?.textContent === 'The provider is saved.');
    expect(byId('cgw-sso-secret').value).toBe('');
    expect(testId('sso-secret-state')!.textContent).toBe(
      'A secret is set. It is never shown again: type a new one to replace it.',
    );
    expect(container.textContent).not.toContain('s3cret');
    expect(testId('sso-tested')!.textContent).toContain('Not tested yet.');
    expect(testId('sso-tested')!.textContent).toContain(
      "“Sign in with your organisation's account”",
    );
    expect(button(container, 'Remove the provider')).not.toBeNull();
  });

  it('keeps the secret unless a new one is typed or it is removed, and sends the version read', async () => {
    const host = fakeHost({ provider: PROVIDER });
    const container = render(h(SsoSettings, { host, role: 'owner' }));
    await until(() => byId('cgw-sso-issuer')?.value === ISSUER, 'the provider');
    const save = testId('sso-save') as HTMLButtonElement;

    // Nothing typed in the secret: kept (left out of the change).
    await act(async () => save.click());
    expect(host.setProvider).toHaveBeenLastCalledWith(
      { issuer: ISSUER, clientId: 'workspace', joinAsMember: true, sessionHours: 24 },
      3,
    );
    await until(() => testId('sso-provider-status')?.textContent === 'The provider is saved.');

    // Removed: says so before the save, and sends null with the new version.
    act(() => button(container, 'Remove the secret')!.click());
    expect(testId('sso-secret-state')!.textContent).toBe('The secret is removed when you save.');
    act(() => button(container, 'Keep the secret')!.click());
    expect(testId('sso-secret-state')!.textContent).toContain('A secret is set.');
    act(() => button(container, 'Remove the secret')!.click());
    await act(async () => save.click());
    expect(host.setProvider.mock.calls.at(-1)![0]).toHaveProperty('clientSecret', null);
    expect(host.setProvider.mock.calls.at(-1)![1]).toBe(4);
    await until(() => testId('sso-secret-state')!.textContent === 'No secret is set.');

    // A new one typed, with the other choices.
    act(() => type(byId('cgw-sso-secret'), 'another'));
    act(() =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]:not([role])')!.click(),
    );
    act(() => type(byId('cgw-sso-hours'), '0'));
    expect(save.disabled).toBe(true);
    expect(byId('cgw-sso-hours').getAttribute('aria-invalid')).toBe('true');
    expect(byId('cgw-sso-hours-note' as string).textContent).toBe(
      'A session lasts from 1 to 720 whole hours.',
    );
    act(() => type(byId('cgw-sso-hours'), '721'));
    expect(save.disabled).toBe(true);
    act(() => type(byId('cgw-sso-hours'), '48'));
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(host.setProvider).toHaveBeenLastCalledWith(
      {
        issuer: ISSUER,
        clientId: 'workspace',
        clientSecret: 'another',
        joinAsMember: false,
        sessionHours: 48,
      },
      5,
    );
  });

  it('says when an owner tested the provider, and asks before removing it', async () => {
    const host = fakeHost({
      provider: { ...PROVIDER, testedAt: '2026-11-19T10:30:00Z' },
      domains: [domainOf('acme.test', true, true)],
    });
    const container = render(h(SsoSettings, { host, role: 'owner' }));
    await until(() => !!testId('sso-tested'), 'the provider');
    expect(testId('sso-tested')!.textContent).toBe(
      `Tested ${english.format(new Date('2026-11-19T10:30:00Z'))}: an owner signed in through it.`,
    );
    act(() => button(container, 'Remove the provider')!.click());
    expect(ask()!.querySelector('h2')!.textContent).toBe('Remove the provider?');
    expect(ask()!.textContent).toContain('sign-on required for a domain turns off');
    act(() => button(ask()!, 'Cancel')!.click());
    expect(ask()).toBeNull();
    expect(host.removeProvider).not.toHaveBeenCalled();

    act(() => button(container, 'Remove the provider')!.click());
    await act(async () => button(ask()!, 'Remove the provider')!.click());
    expect(host.removeProvider).toHaveBeenCalledOnce();
    await until(() => testId('sso-secret-state')?.textContent === 'No secret is set.', 'reset');
    expect(testId('sso-provider-status')!.textContent).toBe(
      'The provider is removed. Sign-on is no longer required for any domain.',
    );
    expect(byId('cgw-sso-issuer').value).toBe('');
    expect(switchOf('acme.test').checked).toBe(false);
  });

  it('takes a domain from added, to its record shown, to proven, to required (asked first)', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const host = fakeHost({ provider: { ...PROVIDER, testedAt: '2026-11-19T10:30:00Z' } });
      const container = render(h(SsoSettings, { host, role: 'owner' }));
      await until(() => container.textContent!.includes('No domains yet.'), 'the empty list');
      const add = button(container, 'Add the domain')!;
      expect(add.disabled).toBe(true);
      act(() => type(byId('cgw-sso-domain'), ' Acme.test '));
      await act(async () => add.click());
      expect(host.addDomain).toHaveBeenCalledWith('Acme.test');
      await until(() => !!row('acme.test'), 'the domain');
      expect(testId('sso-domains-status')!.textContent).toBe(
        'acme.test is added. Create its record, then press Verify.',
      );
      expect(byId('cgw-sso-domain').value).toBe('');
      expect(row('acme.test').textContent).toContain('Not verified yet');
      expect(row('acme.test').querySelector('[data-testid="sso-record-name"]')!.textContent).toBe(
        '_cashgear-workspace.acme.test',
      );
      expect(row('acme.test').querySelector('[data-testid="sso-record-value"]')!.textContent).toBe(
        'cgw-verify=token-acme.test',
      );
      expect(row('acme.test').querySelector('input[role="switch"]')).toBeNull();
      await act(async () =>
        named(row('acme.test'), 'Copy the record value for acme.test')!.click(),
      );
      expect(writeText).toHaveBeenCalledWith('cgw-verify=token-acme.test');
      await act(async () => named(row('acme.test'), 'Copy the record name for acme.test')!.click());
      expect(writeText).toHaveBeenLastCalledWith('_cashgear-workspace.acme.test');
      expect(named(row('acme.test'), 'Copied the record name for acme.test')).not.toBeNull();
      expect(named(row('acme.test'), 'Copy the record value for acme.test')).not.toBeNull();

      // Not in DNS yet: said in words; then found.
      host.verifyDomain.mockRejectedValueOnce(new SyncHttpError(400, 'sso.dnsNotFound'));
      await act(async () => named(row('acme.test'), 'Verify acme.test')!.click());
      await until(() => !!testId('sso-domains-status')?.textContent?.includes('not found yet'));
      expect(testId('sso-domains-status')!.textContent).toBe(
        'The record for acme.test was not found yet. DNS can take a while to show a new record: try again in a few minutes.',
      );
      await act(async () => named(row('acme.test'), 'Verify acme.test')!.click());
      await until(() => !!row('acme.test').querySelector('input[role="switch"]'), 'the switch');
      expect(testId('sso-domains-status')!.textContent).toBe('acme.test is verified.');
      expect(row('acme.test').textContent).toContain(
        `Verified ${english.format(new Date('2026-11-19T11:00:00Z'))}`,
      );
      expect(row('acme.test').querySelector('[data-testid="sso-record-name"]')).toBeNull();
      const on = switchOf('acme.test');
      expect(on.checked).toBe(false);
      expect(on.getAttribute('aria-label')).toBe(
        'Require sign-in through the provider for acme.test',
      );
      const note = document.getElementById(on.getAttribute('aria-describedby')!.split(' ').at(-1)!);
      expect(note!.textContent).toContain('the workspace’s owners keep their password');

      // On: asked first, saying who is signed out and that owners are not.
      act(() => on.click());
      expect(host.requireDomain).not.toHaveBeenCalled();
      expect(switchOf('acme.test').checked).toBe(false);
      expect(ask()!.querySelector('h2')!.textContent).toBe('Require sign-on for acme.test?');
      expect(ask()!.textContent).toContain(
        'those signed in with a password or a passkey are signed out now',
      );
      expect(ask()!.textContent).toContain('The workspace’s owners are not');
      act(() => button(ask()!, 'Cancel')!.click());
      expect(host.requireDomain).not.toHaveBeenCalled();
      act(() => switchOf('acme.test').click());
      await act(async () => button(ask()!, 'Require sign-on')!.click());
      expect(host.requireDomain).toHaveBeenCalledWith('acme.test', true);
      await until(() => switchOf('acme.test').checked, 'required');
      expect(testId('sso-domains-status')!.textContent).toBe(
        'Sign-on is now required for acme.test.',
      );
      expect(ask()).toBeNull();

      // Off: at once, nothing to ask.
      await act(async () => switchOf('acme.test').click());
      expect(ask()).toBeNull();
      expect(host.requireDomain).toHaveBeenLastCalledWith('acme.test', false);
      await until(() => !switchOf('acme.test').checked, 'not required');
      expect(testId('sso-domains-status')!.textContent).toBe(
        'Sign-on is no longer required for acme.test.',
      );
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('asks before removing a domain, saying what its people lose', async () => {
    const host = fakeHost({ provider: PROVIDER, domains: [domainOf('acme.test', true)] });
    const container = render(h(SsoSettings, { host, role: 'owner' }));
    await until(() => !!row('acme.test'), 'the domain');
    act(() => named(container, 'Remove acme.test')!.click());
    expect(ask()!.querySelector('h2')!.textContent).toBe('Remove acme.test?');
    expect(ask()!.textContent).toContain('can no longer sign in through your provider');
    act(() => button(ask()!, 'Cancel')!.click());
    expect(host.removeDomain).not.toHaveBeenCalled();
    act(() => named(container, 'Remove acme.test')!.click());
    await act(async () => button(ask()!, 'Remove the domain')!.click());
    expect(host.removeDomain).toHaveBeenCalledWith('acme.test');
    await until(() => container.textContent!.includes('No domains yet.'), 'removed');
    expect(testId('sso-domains-status')!.textContent).toBe('acme.test is removed.');
  });

  it('says each refusal in words, and reads the settings again when they changed meanwhile', async () => {
    const host = fakeHost({ provider: PROVIDER, domains: [domainOf('acme.test', true)] });
    const container = render(h(SsoSettings, { host, role: 'owner' }));
    await until(() => !!row('acme.test'), 'the settings');
    const providerStatus = () => testId('sso-provider-status')?.textContent;
    const domainsStatus = () => testId('sso-domains-status')?.textContent;
    const save = testId('sso-save') as HTMLButtonElement;

    host.setProvider.mockRejectedValueOnce(new SyncHttpError(400, 'sso.discoveryFailed'));
    await act(async () => save.click());
    await until(() => !!providerStatus());
    expect(providerStatus()).toBe(
      `The provider’s settings could not be read from ${ISSUER}. Check the issuer, and that the provider can be reached.`,
    );

    host.setProvider.mockRejectedValueOnce(new SyncHttpError(400, 'request.invalid'));
    await act(async () => save.click());
    await until(() => !!providerStatus()?.startsWith('The server did not take these values.'));

    // Another owner saved meanwhile: read again, the form filled from what is there now.
    host.set({ provider: { ...PROVIDER, clientId: 'changed', version: 9 } });
    const reads = host.read.mock.calls.length;
    host.setProvider.mockRejectedValueOnce(new SyncHttpError(409, 'version.conflict'));
    await act(async () => save.click());
    await until(() => byId('cgw-sso-client').value === 'changed', 'read again');
    expect(host.read.mock.calls.length).toBe(reads + 1);
    expect(providerStatus()).toBe(
      'Single sign-on was changed meanwhile: it is shown again as it is now. Make your change again.',
    );

    host.setProvider.mockRejectedValueOnce(new SyncHttpError(403, 'access.denied'));
    await act(async () => save.click());
    await until(
      () => providerStatus() === 'Only the workspace’s owners can change single sign-on.',
    );

    // Required before an owner signed in through the provider: refused, and how to do it.
    act(() => switchOf('acme.test').click());
    host.requireDomain.mockRejectedValueOnce(new SyncHttpError(400, 'sso.notTested'));
    await act(async () => button(ask()!, 'Require sign-on')!.click());
    await until(() => !!domainsStatus());
    expect(domainsStatus()).toBe(
      "Sign-on cannot be required yet: an owner must first sign in through the provider. Sign out, then on the sign-in page choose “Sign in with your organisation's account”.",
    );
    expect(switchOf('acme.test').checked).toBe(false);
    expect(ask()).toBeNull();

    act(() => type(byId('cgw-sso-domain'), 'other.test'));
    host.addDomain.mockRejectedValueOnce(new SyncHttpError(409, 'sso.domainTaken'));
    await act(async () => button(container, 'Add the domain')!.click());
    await until(() => !!domainsStatus()?.startsWith('other.test'));
    expect(domainsStatus()).toBe(
      'other.test is proven by another workspace already. A domain belongs to one workspace: it must be removed there first.',
    );
    expect(byId('cgw-sso-domain').value).toBe('other.test');

    host.addDomain.mockRejectedValueOnce(new SyncHttpError(400, 'request.invalid'));
    await act(async () => button(container, 'Add the domain')!.click());
    await until(() => !!domainsStatus()?.startsWith('That is not a domain name'));

    host.addDomain.mockRejectedValueOnce(new SyncHttpError(409, 'conflict'));
    await act(async () => button(container, 'Add the domain')!.click());
    await until(() => domainsStatus() === 'other.test is added already.');

    // Removed meanwhile elsewhere: said, and the list read again.
    host.set({ domains: [] });
    await act(async () => named(container, 'Remove acme.test')!.click());
    await act(async () => button(ask()!, 'Remove the domain')!.click());
    await until(() => domainsStatus() === 'acme.test was removed meanwhile.');
    await until(() => container.textContent!.includes('No domains yet.'), 'read again');

    host.setProvider.mockRejectedValueOnce(new SyncHttpError(500, 'server.error'));
    await act(async () => save.click());
    await until(() => providerStatus() === 'The server did not take that. Try again.');

    expect(ssoRefusalKey('not.found', 'provider')).toBe('sso.providerGone');
    expect(ssoRefusalKey('request.invalid', 'domain')).toBe('sso.invalidDomain');
    expect(ssoRefusalKey('anything.else', 'domain')).toBe('cloud.requestFailed');
  });

  it('says when the settings could not be read', async () => {
    const host = fakeHost();
    host.read.mockRejectedValueOnce(new SyncHttpError(503, 'server.error'));
    const container = render(h(SsoSettings, { host, role: 'owner' }));
    await until(() => container.textContent!.includes('could not be read'), 'the failure');
    expect(testId('sso-provider-form')).toBeNull();
  });

  it('reads in Arabic, with only the addresses, names and records as they are', async () => {
    const host = fakeHost({
      provider: { ...PROVIDER, testedAt: '2026-11-19T10:30:00Z' },
      domains: [domainOf('acme.test', true, true), domainOf('pending.test')],
    });
    const container = render(h(SsoSettings, { host, role: 'owner' }), 'ar');
    await until(() => !!row('pending.test'), 'the settings');
    expect(container.querySelector('h2')!.textContent).toBe('تسجيل الدخول الموحّد');
    expect(button(container, 'حفظ المزوّد')).not.toBeNull();
    expect(named(container, 'تحقّق من pending.test')!.textContent).toBe('تحقّق');
    expect(switchOf('acme.test').getAttribute('aria-label')).toBe(
      'إلزام تسجيل الدخول عبر المزوّد للنطاق acme.test',
    );
    const arabic = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' });
    expect(testId('sso-tested')!.textContent).toBe(
      `جُرّب ${arabic.format(new Date('2026-11-19T10:30:00Z'))}: سجّل أحد المالكين دخوله عبره.`,
    );
    const hoursNote = new Intl.NumberFormat('ar');
    expect(byId('cgw-sso-hours-note').textContent).toContain(hoursNote.format(720));

    // No Latin letter but theirs: the protocol's name, the domains, the addresses and records, each
    // marked as written in English (which the e2e Arabic walks leave out, as a screen reader would
    // read them).
    const values = [...container.querySelectorAll('.cgw-sso-value, .cgw-sso-name')];
    expect(values.map((v) => v.textContent)).toEqual([
      REDIRECT,
      'acme.test',
      'pending.test',
      '_cashgear-workspace.pending.test',
      'cgw-verify=token-pending.test',
    ]);
    for (const value of values) expect(value.getAttribute('lang')).toBe('en');
    const copy = container.cloneNode(true) as HTMLElement;
    for (const value of copy.querySelectorAll('[lang="en"]')) value.remove();
    expect(copy.textContent).not.toMatch(/[A-Za-z]/);
    expect(
      container.querySelector('[lang="en"]:not(.cgw-sso-value, .cgw-sso-name)')!.textContent,
    ).toBe('OpenID Connect');
    for (const el of container.querySelectorAll('[aria-label]'))
      expect(
        el.getAttribute('aria-label')!.replace(/(acme|pending)\.test/g, ''),
        el.outerHTML,
      ).not.toMatch(/[A-Za-z]/);
  });
});

// --------------------------------------------------------------------- Settings → Account

describe('Settings → Account → Password', () => {
  const passwordFake = (state: AccountSignIn | null) => {
    const host = {
      read: vi.fn(async () => state),
      sendLink: vi.fn(async () => {}),
    };
    return host satisfies PasswordHost;
  };

  it('offers an account with no password to set one by the reset mail', async () => {
    const host = passwordFake({ email: 'ada@acme.test', hasPassword: false, ssoRequired: false });
    const container = render(h(PasswordSettings, { host }));
    await until(() => !!testId('password-set'), 'the offer');
    expect(container.querySelector('h3')!.textContent).toBe('Password');
    expect(container.textContent).toContain(
      'This account has no password: it signs in through your organisation’s account. You can set one too, by a link sent to ada@acme.test.',
    );
    await act(async () => testId('password-set')!.click());
    expect(host.sendLink).toHaveBeenCalledWith('ada@acme.test', 'en');
    await until(() => !!testId('password-status'));
    expect(testId('password-status')!.textContent).toBe(
      'A link to set a password is on its way to ada@acme.test. Open it, choose a password, then sign in with it whenever you like.',
    );

    host.sendLink.mockRejectedValueOnce(new SyncHttpError(429, 'rate.limited'));
    await act(async () => testId('password-set')!.click());
    await until(
      () => testId('password-status')!.textContent === 'The server did not take that. Try again.',
    );
  });

  it('says the organisation signs the account in when its domain requires it, and offers nothing', async () => {
    for (const hasPassword of [false, true]) {
      const host = passwordFake({ email: 'pat@acme.test', hasPassword, ssoRequired: true });
      const container = render(h(PasswordSettings, { host }));
      await until(() => !!container.querySelector('[data-testid="password-organisation"]'));
      expect(container.textContent).toContain(
        'Your organisation signs this account in through its own sign-in: a password does not sign it in.',
      );
      expect(container.querySelector('button')).toBeNull();
    }
  });

  it('shows nothing for an account with a password, signed out, or when the server cannot say', async () => {
    const withPassword = render(
      h(PasswordSettings, {
        host: passwordFake({ email: 'o@acme.test', hasPassword: true, ssoRequired: false }),
      }),
    );
    const signedOut = render(h(PasswordSettings, { host: passwordFake(null) }));
    const failing = passwordFake(null);
    failing.read.mockRejectedValueOnce(new Error('offline'));
    const offline = render(h(PasswordSettings, { host: failing }));
    await settle();
    expect(withPassword.innerHTML).toBe('');
    expect(signedOut.innerHTML).toBe('');
    expect(offline.innerHTML).toBe('');
  });

  it('reads in Arabic, and asks for the mail in Arabic', async () => {
    const host = passwordFake({ email: 'omar@acme.test', hasPassword: false, ssoRequired: false });
    const container = render(h(PasswordSettings, { host }), 'ar');
    await until(() => !!testId('password-set'), 'the offer');
    expect(testId('password-set')!.textContent).toBe('تعيين كلمة مرور');
    await act(async () => testId('password-set')!.click());
    expect(host.sendLink).toHaveBeenCalledWith('omar@acme.test', 'ar');
    await until(() => !!testId('password-status'));
    expect(container.textContent!.replace(/omar@acme\.test/g, '')).not.toMatch(/[A-Za-z]/);
  });
});
