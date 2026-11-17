// Phase 9, M9.1: publishing in the client. The slug's rules as the server checks them, the slug
// proposed from a title (an Arabic one gives `page-` and the page id's last 8 hex digits), the
// routes' request shapes, the share dialog's "Publish to the web" (what will be published listed
// first, the slug checked before it is sent, publish, a taken slug, the live site's address and
// Unpublish, why a page cannot be published), and Settings' switch (off asks first and takes every
// site down; only owners and admins may change it), in English and Arabic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createApi } = await import('@cgw/api');
const { SyncHttpError } = await import('@cgw/workspace');
const { createI18n } = await import('../i18n');
const { defaultSlug, publishingApi, slugProblem, RESERVED_SLUGS } = await import('./publishing');
const { PublishSection } = await import('./PublishSection');
const { PublishingSection } = await import('./PublishingSettings');
type PublishingApi = import('./publishing').PublishingApi;
type SiteState = import('./publishing').SiteState;
type Site = import('./publishing').Site;
type Publishing = import('./publishing').Publishing;
type PageRecord = import('@cgw/workspace').PageRecord;

const PAGE = '01936f6e-0000-7000-8000-00000000c001';
const CHILD = '01936f6e-0000-7000-8000-00000000c002';
const GRANDCHILD = '01936f6e-0000-7000-8000-00000000c003';
const WS = '01936f6e-0000-7000-8000-00000000c0ff';

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

function render(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(h(I18nextProvider, { i18n: createI18n(language) }, node)));
  return container;
}

const page = (title: string): PageRecord =>
  ({ id: PAGE, workspaceId: WS, title, kind: 'page' }) as unknown as PageRecord;

const site = (over: Partial<Site> = {}): Site => ({
  id: '01936f6e-0000-7000-8000-00000000c100',
  pageId: PAGE,
  slug: 'handbook',
  url: 'http://localhost:5290/handbook',
  indexing: false,
  language: 'en',
  version: 4,
  publishedAt: '2026-11-17T10:00:00Z',
  publishedBy: { id: 'u1', name: 'Ada' },
  updatedAt: '2026-11-17T10:00:00Z',
  ...over,
});

const ready = (over: Partial<SiteState> = {}): SiteState => ({
  site: null,
  publishable: true,
  reason: null,
  pages: [
    { id: PAGE, title: 'Handbook', icon: '📘', parentPageId: null },
    { id: CHILD, title: 'Leave', icon: null, parentPageId: PAGE },
    { id: GRANDCHILD, title: 'Sick days', icon: null, parentPageId: CHILD },
  ],
  leftOut: 2,
  ...over,
});

function fakePublishing(state: SiteState) {
  let held = state;
  const calls: { kind: string; args: unknown[] }[] = [];
  let refuse: string | null = null;
  const api = {
    site: vi.fn(async () => held),
    publish: vi.fn(async (pageId: string, settings: Record<string, unknown>, version?: number) => {
      calls.push({ kind: 'publish', args: [pageId, settings, version] });
      if (refuse) throw new SyncHttpError(409, refuse, 'No');
      const made = site({ ...(settings as Partial<Site>), version: (version ?? 0) + 1 });
      held = { ...held, site: made };
      return made;
    }),
    unpublish: vi.fn(async (pageId: string) => {
      calls.push({ kind: 'unpublish', args: [pageId] });
      held = { ...held, site: null };
    }),
    publishing: vi.fn(),
    setPublishing: vi.fn(),
  } as unknown as PublishingApi;
  return { api, calls, refuse: (code: string | null) => (refuse = code) };
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('a site’s slug', () => {
  it('follows the server’s rules', () => {
    for (const ok of ['abc', 'handbook', 'q3-2026-report', 'a-b-c', '123', 'x'.repeat(63)])
      expect(slugProblem(ok), ok).toBeNull();
    expect(slugProblem('ab')).toBe('length');
    expect(slugProblem('x'.repeat(64))).toBe('length');
    expect(slugProblem('Handbook')).toBe('characters');
    expect(slugProblem('hand book')).toBe('characters');
    expect(slugProblem('دليل-الموظف')).toBe('characters');
    expect(slugProblem('-abc')).toBe('edges');
    expect(slugProblem('abc-')).toBe('edges');
    expect(slugProblem('ab--cd')).toBe('dashes');
    expect(slugProblem('_private')).toBe('reserved');
    for (const word of RESERVED_SLUGS) expect(slugProblem(word), word).not.toBeNull();
    expect(slugProblem('robots-txt')).toBe('reserved');
  });

  it('is proposed from the title, else from the page id', () => {
    expect(defaultSlug('Staff handbook', PAGE)).toBe('staff-handbook');
    expect(defaultSlug('  Q3 — Report: 2026!  ', PAGE)).toBe('q3-report-2026');
    expect(defaultSlug('Café Résumé', PAGE)).toBe('cafe-resume');
    // An Arabic title, too short a title, a reserved word: `page-` and the id's last 8 hex.
    expect(defaultSlug('دليل الموظف', PAGE)).toBe('page-0000c001');
    expect(defaultSlug('Q3', PAGE)).toBe('page-0000c001');
    expect(defaultSlug('Admin', PAGE)).toBe('page-0000c001');
    expect(defaultSlug('', PAGE)).toBe('page-0000c001');
    // At most 63 characters, never ending on a dash.
    const long = defaultSlug(`${'word '.repeat(30)}end`, PAGE);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(slugProblem(long)).toBeNull();
    for (const title of ['Staff handbook', 'دليل الموظف', 'Q3', 'Admin', 'a'.repeat(100)])
      expect(slugProblem(defaultSlug(title, PAGE)), title).toBeNull();
  });
});

describe('the publishing routes', () => {
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
      const text = input.method === 'GET' ? '' : await input.text();
      requests.push({
        method: input.method,
        url,
        headers: input.headers,
        body: text ? JSON.parse(text) : null,
      });
      if (url.pathname === '/api/v1/account/antiforgery') return json({ token: 'csrf' });
      if (url.pathname === `/api/v1/pages/${PAGE}/site` && input.method === 'GET')
        return json({ ...ready(), site: { ...site(), version: '4' }, leftOut: '2' });
      if (url.pathname === `/api/v1/pages/${PAGE}/site` && input.method === 'PUT') {
        const body = JSON.parse(text) as { slug: string };
        if (body.slug === 'taken') return json({ code: 'slug.taken', title: 'Taken' }, 409);
        return json(site({ slug: body.slug, version: 5 }));
      }
      if (url.pathname === `/api/v1/pages/${PAGE}/site` && input.method === 'DELETE')
        return new Response(null, { status: 204 });
      if (url.pathname === `/api/v1/workspaces/${WS}/publishing`)
        return json({
          enabled:
            input.method === 'PUT' ? (JSON.parse(text) as { enabled: boolean }).enabled : true,
          sites: [{ ...site(), pageTitle: 'Handbook', pageIcon: null }],
        });
      return json({ code: 'not.found', title: 'No' }, 404);
    };
    return { fetch, requests };
  }

  it('read, publish with the site’s version, unpublish and switch', async () => {
    const server = fakeServer();
    const api = publishingApi(
      createApi({
        baseUrl: 'http://api.test',
        auth: { kind: 'cookie' },
        fetch: server.fetch as never,
      }),
    );
    const state = await api.site(PAGE);
    expect(state.site).toMatchObject({ slug: 'handbook', version: 4, language: 'en' });
    expect(state.leftOut).toBe(2);
    expect(state.pages.map((p) => p.parentPageId)).toEqual([null, PAGE, CHILD]);

    const made = await api.publish(PAGE, { slug: 'staff', indexing: true, language: 'ar' }, 4);
    expect(made).toMatchObject({ slug: 'staff', version: 5 });
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect(put.body).toEqual({ slug: 'staff', indexing: true, language: 'ar' });
    expect(put.headers.get('If-Match')).toBe('"4"');
    expect(put.headers.get('X-CSRF-TOKEN')).toBe('csrf');
    // A first publish names no version.
    await api.publish(PAGE, { slug: 'staff', indexing: false, language: 'en' });
    expect(
      server.requests
        .filter((r) => r.method === 'PUT')
        .at(-1)!
        .headers.get('If-Match'),
    ).toBeNull();
    await expect(
      api.publish(PAGE, { slug: 'taken', indexing: false, language: 'en' }),
    ).rejects.toMatchObject({ status: 409, code: 'slug.taken' });

    await api.unpublish(PAGE);
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(true);

    expect((await api.publishing(WS)).sites[0]).toMatchObject({ pageTitle: 'Handbook' });
    expect((await api.setPublishing(WS, false)).enabled).toBe(false);
    expect(
      server.requests.filter((r) => r.url.pathname.endsWith('/publishing')).at(-1)!.body,
    ).toEqual({
      enabled: false,
    });
  });
});

describe('the share dialog’s “Publish to the web”', () => {
  it('lists what will be published, proposes a slug and publishes', async () => {
    const fake = fakePublishing(ready());
    const container = render(h(PublishSection, { api: fake.api, page: page('Staff handbook') }));
    await until(() => !!container.querySelector('[data-testid="publish-pages"]'), 'the list');
    const items = [...container.querySelectorAll('[data-testid="publish-pages"] li')];
    expect(items.map((li) => li.textContent)).toEqual(['📘 Handbook', 'Leave', 'Sick days']);
    // Nested by depth under the root.
    expect((items[2] as HTMLElement).style.paddingInlineStart).toBe('32px');
    expect(container.querySelector('[data-testid="publish-left-out"]')!.textContent).toContain('2');
    const slug = container.querySelector<HTMLInputElement>('#cgw-publish-slug')!;
    expect(slug.value).toBe('staff-handbook');
    // A slug the server would refuse is said here, and not sent.
    act(() => type(slug, 'ab'));
    expect(container.querySelector('#cgw-publish-slug-help')!.textContent).toContain('3 to 63');
    expect(button(container, 'Publish')!.disabled).toBe(true);
    act(() => type(slug, 'staff'));
    expect(button(container, 'Publish')!.disabled).toBe(false);
    await act(async () => button(container, 'Publish')!.click());
    expect(fake.calls[0]).toEqual({
      kind: 'publish',
      args: [PAGE, { slug: 'staff', indexing: false, language: 'en' }, undefined],
    });
    await until(() => !!container.querySelector('[data-testid="site-url"]'), 'the live site');
    expect(container.querySelector('[data-testid="publish-message"]')!.textContent).toContain(
      'Published',
    );
  });

  it('says a taken slug, and changes or takes down a live site', async () => {
    const fake = fakePublishing(ready({ site: site() }));
    const container = render(h(PublishSection, { api: fake.api, page: page('Handbook') }));
    await until(() => !!container.querySelector('[data-testid="site-url"]'), 'the live site');
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="site-url"]')!;
    expect(link.href).toBe('http://localhost:5290/handbook');
    expect(link.rel).toBe('noopener noreferrer');
    expect(container.textContent).toContain('Published by Ada');
    // Nothing changed: nothing to save.
    expect(button(container, 'Save changes')!.disabled).toBe(true);
    const slug = container.querySelector<HTMLInputElement>('#cgw-publish-slug')!;
    act(() => type(slug, 'taken'));
    fake.refuse('slug.taken');
    await act(async () => button(container, 'Save changes')!.click());
    expect(fake.calls[0].args[2]).toBe(4);
    await until(() => !!container.querySelector('[data-testid="publish-message"]'), 'the refusal');
    expect(container.querySelector('[data-testid="publish-message"]')!.textContent).toBe(
      'That address is taken: choose another.',
    );
    fake.refuse(null);
    // Unpublish asks first.
    await act(async () => button(container, 'Unpublish')!.click());
    expect(fake.calls.some((c) => c.kind === 'unpublish')).toBe(false);
    await act(async () => button(container, 'Unpublish now')!.click());
    expect(fake.calls.at(-1)).toEqual({ kind: 'unpublish', args: [PAGE] });
    await until(() => !container.querySelector('[data-testid="site-url"]'), 'the site gone');
    expect(button(container, 'Publish')).not.toBeNull();
  });

  it('says why a page cannot be published, and is not offered without full access', async () => {
    for (const [reason, words] of [
      ['private', 'private section'],
      ['off', 'turned off'],
      ['local', 'this device only'],
      ['trashed', 'trash'],
    ] as const) {
      const fake = fakePublishing(ready({ publishable: false, reason }));
      const container = render(h(PublishSection, { api: fake.api, page: page('Notes') }));
      await until(() => !!container.querySelector('[data-testid="publish-reason"]'), reason);
      expect(container.querySelector('[data-testid="publish-reason"]')!.textContent).toContain(
        words,
      );
      expect(button(container, 'Publish')).toBeNull();
    }
    const denied = fakePublishing(ready());
    (denied.api.site as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SyncHttpError(403, 'access.denied', 'No'),
    );
    const container = render(h(PublishSection, { api: denied.api, page: page('Notes') }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(container.querySelector('[data-testid="publish-section"]')).toBeNull();
  });

  it('reads in Arabic, an Arabic title proposing the page id', async () => {
    const fake = fakePublishing(ready());
    const container = render(h(PublishSection, { api: fake.api, page: page('دليل الموظف') }), 'ar');
    await until(() => !!container.querySelector('#cgw-publish-slug'), 'the form');
    expect(container.querySelector<HTMLInputElement>('#cgw-publish-slug')!.value).toBe(
      'page-0000c001',
    );
    expect(container.querySelector<HTMLSelectElement>('#cgw-publish-language')!.value).toBe('ar');
    expect(container.querySelector('#cgw-publish-title')!.textContent).toBe('النشر على الويب');
    expect(button(container, 'نشر')).not.toBeNull();
  });
});

describe('Settings → Publishing', () => {
  function fakeSwitch(initial: Publishing) {
    let held = initial;
    const api = {
      publishing: vi.fn(async () => held),
      setPublishing: vi.fn(async (_ws: string, enabled: boolean) => {
        held = { enabled, sites: enabled ? held.sites : [] };
        return held;
      }),
      unpublish: vi.fn(async (pageId: string) => {
        held = { ...held, sites: held.sites.filter((s) => s.pageId !== pageId) };
      }),
    };
    return api;
  }
  const live: Publishing = {
    enabled: true,
    sites: [{ ...site(), pageTitle: 'Handbook', pageIcon: '📘' }],
  };
  const checkbox = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

  it('turns publishing off for an owner only after asking, which takes every site down', async () => {
    const api = fakeSwitch(live);
    const container = render(h(PublishingSection, { api, workspaceId: WS, manages: true }));
    await until(() => !!container.querySelector('[data-testid="publishing-sites"]'), 'the sites');
    expect(container.querySelector('[data-site="handbook"]')!.textContent).toContain('Handbook');
    expect(checkbox(container).checked).toBe(true);
    await act(async () => checkbox(container).click());
    expect(api.setPublishing).not.toHaveBeenCalled();
    expect(container.textContent).toContain('sites: 1');
    await act(async () => button(container, 'Turn publishing off')!.click());
    expect(api.setPublishing).toHaveBeenCalledWith(WS, false);
    await until(() => !!container.querySelector('[data-testid="publishing-none"]'), 'no sites');
    expect(checkbox(container).checked).toBe(false);
    // On again: at once, and no site comes back.
    await act(async () => checkbox(container).click());
    expect(api.setPublishing).toHaveBeenLastCalledWith(WS, true);
    await until(() => checkbox(container).checked, 'on');
    expect(container.querySelector('[data-testid="publishing-none"]')).not.toBeNull();
  });

  it('unpublishes one site from the list, and shows a member the switch only', async () => {
    const api = fakeSwitch(live);
    const container = render(h(PublishingSection, { api, workspaceId: WS, manages: true }));
    await until(() => !!container.querySelector('[data-site="handbook"]'), 'the site');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Unpublish Handbook"]')!
        .click(),
    );
    expect(api.unpublish).toHaveBeenCalledWith(PAGE);
    await until(() => !container.querySelector('[data-site="handbook"]'), 'the site gone');

    const member = render(
      h(PublishingSection, {
        api: fakeSwitch({ enabled: true, sites: [] }),
        workspaceId: WS,
        manages: false,
      }),
      'ar',
    );
    await until(() => !!member.querySelector('input[type="checkbox"]'), 'the switch');
    expect(checkbox(member).disabled).toBe(true);
    expect(member.textContent).toContain('النشر مفعّل في مساحة العمل هذه');
    expect(member.querySelector('[data-testid="publishing-sites"]')).toBeNull();
  });
});
