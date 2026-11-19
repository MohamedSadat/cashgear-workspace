// Phase 11, M11.1: groups in the client. The group routes' and the access lists' request shapes
// (`?principals=group` on a read, `principals: ["group"]` on a save, `If-Match` on a group's
// changes); the one picker that merges the workspace, groups and people; the share dialog and a
// workbook's access with groups (a group's row with its number of people, a group added and saved,
// a guest shown and sent no group, a group deleted meanwhile taken out); and Settings → Members →
// Groups: who sees and changes what, deleting asks first, and every refusal said in words, in
// English and Arabic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createApi } = await import('@cgw/api');
const { SyncHttpError } = await import('@cgw/workspace');
const { createI18n } = await import('../i18n');
const { Cloud } = await import('./cloud');
const { candidatesOf, entriesOf, refusalOf } = await import('./principals');
const { ShareDialog } = await import('./ShareDialog');
const { GroupsSettings, refusalKey } = await import('./GroupsSettings');
const { WorkbookPermissions } = await import('../sheet/WorkbookPermissions');
const { workbookApi } = await import('../sheet/api');
type ShareCloud = import('./ShareDialog').ShareCloud;
type GroupsApi = import('./GroupsSettings').GroupsApi;
type GroupMember = import('./GroupsSettings').GroupMember;
type WorkbookAccessCloud = import('../sheet/WorkbookPermissions').WorkbookAccessCloud;
type PageRecord = import('@cgw/workspace').PageRecord;
type Workbook = import('../sheet/api').Workbook;

const WS = '01936f6e-0000-7000-8000-0000000000ff';
const PAGE = '01936f6e-0000-7000-8000-00000000a001';
const BOOK = '01936f6e-0000-7000-8000-00000000b001';
const ADA = '01936f6e-0000-7000-8000-00000000d001';
const BEN = '01936f6e-0000-7000-8000-00000000d002';
const CY = '01936f6e-0000-7000-8000-00000000d003';
const GUEST = '01936f6e-0000-7000-8000-00000000d004';
const DESIGNERS = '01936f6e-0000-7000-8000-00000000e001';
const WRITERS = '01936f6e-0000-7000-8000-00000000e002';

const MEMBERS: GroupMember[] = [
  { userId: ADA, displayName: 'Ada', email: 'ada@example.test', role: 'owner' },
  { userId: BEN, displayName: 'Ben', email: 'ben@example.test', role: 'member' },
  { userId: CY, displayName: 'Cy', email: 'cy@example.test', role: 'admin' },
  { userId: GUEST, displayName: 'Gus', email: 'gus@example.test', role: 'guest' },
];

const person = (m: GroupMember) => ({
  userId: m.userId,
  displayName: m.displayName,
  email: m.email,
});
const groupDto = (id: string, name: string, people: GroupMember[], version = 1) => ({
  id,
  name,
  version: String(version),
  people: people.map(person),
  createdAt: '2026-11-19T10:00:00Z',
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

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A checkbox by the name its label starts with. */
const checkbox = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(name))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;

const options = () => [...document.querySelectorAll('[role="option"]')];
const rows = (testId: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"] > li`),
];

/** Chooses a candidate in the picker by typing part of its name, then Add. */
async function pick(inputId: string, query: string, option: string) {
  const input = document.getElementById(inputId) as HTMLInputElement;
  await act(async () => type(input, query));
  await until(() => options().some((o) => o.textContent?.startsWith(option)), `option ${option}`);
  const chosen = options().find((o) => o.textContent?.startsWith(option)) as HTMLElement;
  await act(async () => chosen.click());
  const add = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Add' && !b.disabled,
  )!;
  act(() => add.click());
}

// ------------------------------------------------------------------------------------- the routes

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
    const text = input.method === 'GET' || input.method === 'DELETE' ? '' : await input.text();
    requests.push({
      method: input.method,
      url,
      headers: input.headers,
      body: text ? JSON.parse(text) : null,
    });
    if (url.pathname === '/api/v1/account/antiforgery') return json({ token: 'csrf' });
    if (url.pathname.endsWith('/permissions') && input.method === 'GET')
      return json({ restricted: true, yourLevel: 'full', entries: [] });
    if (url.pathname.endsWith('/permissions') && input.method === 'PUT')
      return json({ restricted: true, yourLevel: 'full', entries: [] });
    if (url.pathname === `/api/v1/workspaces/${WS}/groups` && input.method === 'GET')
      return json({ groups: [groupDto(DESIGNERS, 'Designers', [MEMBERS[1]])] });
    if (input.method === 'DELETE') return new Response(null, { status: 204 });
    return json(
      groupDto(DESIGNERS, 'Designers', [MEMBERS[1]], 2),
      input.method === 'POST' ? 201 : 200,
    );
  };
  const api = createApi({
    baseUrl: 'http://api.test',
    auth: { kind: 'cookie' },
    fetch: fetch as never,
  });
  return { api, requests };
}

describe('the group routes and the access lists', () => {
  it('ask for groups on a read and say so on a save, and send If-Match on a group’s changes', async () => {
    const server = fakeServer();
    const cloud = { api: server.api } as unknown as InstanceType<typeof Cloud>;
    const call = <K extends keyof InstanceType<typeof Cloud>>(name: K, ...args: unknown[]) =>
      (Cloud.prototype[name] as (...a: unknown[]) => Promise<unknown>).call(cloud, ...args);

    await call('permissions', PAGE);
    expect(server.requests.at(-1)!.url.searchParams.getAll('principals')).toEqual(['group']);
    await call('setPermissions', PAGE, { restricted: true, entries: [] });
    expect(server.requests.at(-1)!.body).toEqual({
      restricted: true,
      entries: [],
      principals: ['group'],
    });
    // Without groups (a guest): the list as 0.10.0 read and saved it.
    await call('permissions', PAGE, false);
    expect(server.requests.at(-1)!.url.search).toBe('');
    await call('setPermissions', PAGE, { restricted: false, entries: [] }, false);
    expect(server.requests.at(-1)!.body).toEqual({ restricted: false, entries: [] });

    expect(await call('groups', WS)).toMatchObject({ groups: [{ name: 'Designers' }] });
    await call('createGroup', WS, 'Designers', [BEN]);
    expect(server.requests.at(-1)).toMatchObject({
      method: 'POST',
      body: { name: 'Designers', people: [BEN] },
    });
    expect(server.requests.at(-1)!.url.pathname).toBe(`/api/v1/workspaces/${WS}/groups`);
    await call('renameGroup', WS, DESIGNERS, 'Design', 3);
    expect(server.requests.at(-1)).toMatchObject({ method: 'PATCH', body: { name: 'Design' } });
    expect(server.requests.at(-1)!.headers.get('If-Match')).toBe('"3"');
    expect(server.requests.at(-1)!.headers.get('X-CSRF-TOKEN')).toBe('csrf');
    await call('setGroupPeople', WS, DESIGNERS, [BEN, CY], 4);
    expect(server.requests.at(-1)).toMatchObject({ method: 'PUT', body: { people: [BEN, CY] } });
    expect(server.requests.at(-1)!.url.pathname).toBe(
      `/api/v1/workspaces/${WS}/groups/${DESIGNERS}/people`,
    );
    expect(server.requests.at(-1)!.headers.get('If-Match')).toBe('"4"');
    await call('deleteGroup', WS, DESIGNERS);
    expect(server.requests.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(server.requests.at(-1)!.url.pathname).toBe(
      `/api/v1/workspaces/${WS}/groups/${DESIGNERS}`,
    );

    // A workbook's list the same way.
    const books = workbookApi(server.api);
    await books.permissions(BOOK);
    expect(server.requests.at(-1)!.url.pathname).toBe(`/api/v1/workbooks/${BOOK}/permissions`);
    expect(server.requests.at(-1)!.url.searchParams.getAll('principals')).toEqual(['group']);
    await books.setPermissions(BOOK, { restricted: true, entries: [] });
    expect(server.requests.at(-1)!.body).toMatchObject({ principals: ['group'] });
    await books.permissions(BOOK, false);
    expect(server.requests.at(-1)!.url.search).toBe('');
    await books.setPermissions(BOOK, { restricted: true, entries: [] }, false);
    expect(server.requests.at(-1)!.body).not.toHaveProperty('principals');
  });
});

// ------------------------------------------------------------------------------------- the picker

describe('the picker', () => {
  const entries = entriesOf(
    [
      { principalType: 'user', principalId: ADA, level: 'full', displayName: 'Ada', email: null },
      {
        principalType: 'group',
        principalId: DESIGNERS,
        level: 'view',
        displayName: 'Designers',
        email: null,
        peopleCount: '3',
      },
      // A kind this build does not know is not drawn (the server keeps it).
      { principalType: 'team', principalId: CY, level: 'view' },
    ],
    'Everyone in the workspace',
    true,
  );

  it('reads the server’s rows, a group with its number of people', () => {
    expect(entries).toEqual([
      { principalType: 'user', principalId: ADA, level: 'full', name: 'Ada', peopleCount: null },
      {
        principalType: 'group',
        principalId: DESIGNERS,
        level: 'view',
        name: 'Designers',
        peopleCount: 3,
      },
    ]);
    // Someone not told of groups is shown none.
    expect(
      entriesOf(
        [{ principalType: 'group', principalId: DESIGNERS, level: 'view', displayName: 'D' }],
        'Everyone',
        false,
      ),
    ).toEqual([]);
  });

  it('merges the workspace, the groups and the people not listed yet, in that order', () => {
    const groups = [
      { id: DESIGNERS, name: 'Designers', people: 3 },
      { id: WRITERS, name: 'Writers', people: 2 },
    ];
    const list = candidatesOf(entries, MEMBERS.map(person), groups, WS, 'Everyone');
    expect(list.map((c) => `${c.type}:${c.name}`)).toEqual([
      'workspace:Everyone',
      'group:Writers',
      'user:Ben',
      'user:Cy',
      'user:Gus',
    ]);
    expect(list[1]).toMatchObject({ id: WRITERS, people: 2, email: null });
    expect(list[2]).toMatchObject({ id: BEN, email: 'ben@example.test', people: null });
    // The workspace is offered once only.
    const withEveryone = [
      ...entries,
      {
        principalType: 'workspace' as const,
        principalId: WS,
        level: 'view' as const,
        name: 'Everyone',
        peopleCount: null,
      },
    ];
    expect(candidatesOf(withEveryone, [], groups, WS, 'Everyone').map((c) => c.type)).toEqual([
      'group',
    ]);
  });

  it('takes a group deleted meanwhile out of the list after a refused save', async () => {
    const read = vi.fn(async () => [{ id: WRITERS, name: 'Writers', people: 2 }]);
    const refusal = await refusalOf('request.invalid', true, entries, read);
    expect(refusal.message).toBe('share.groupGone');
    expect([...refusal.drop!]).toEqual([DESIGNERS]);
    expect(await refusalOf('access.denied', true, entries, read)).toEqual({
      message: 'share.readOnly',
    });
    // Someone not told of groups is never asked to read them.
    expect((await refusalOf('request.invalid', false, entries, read)).message).toBe(
      'cloud.requestFailed',
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------------- the share dialog

const page = { id: PAGE, workspaceId: WS, title: 'Plans', kind: 'page' } as unknown as PageRecord;

function shareCloud({ knows = true, groups = [] as ReturnType<typeof groupDto>[] } = {}) {
  let held = groups;
  const cloud = {
    api: {},
    knowsGroups: vi.fn(() => knows),
    permissions: vi.fn(async () => ({
      restricted: true,
      yourLevel: 'full',
      entries: [
        { principalType: 'user', principalId: ADA, level: 'full', displayName: 'Ada', email: 'a' },
        // The server never sends a guest a group's row; this one shows the client drops it too.
        {
          principalType: 'group',
          principalId: DESIGNERS,
          level: 'view',
          displayName: 'Designers',
          email: null,
          peopleCount: '3',
        },
      ],
    })),
    setPermissions: vi.fn(async () => ({ restricted: true, yourLevel: 'full', entries: [] })),
    members: vi.fn(async () => MEMBERS),
    groups: vi.fn(async () => ({ groups: held })),
    shareLinks: vi.fn(async () => []),
    createShareLink: vi.fn(),
    revokeShareLink: vi.fn(),
    shareUrl: vi.fn(),
  };
  return {
    cloud: cloud as unknown as ShareCloud,
    fake: cloud,
    hold: (next: ReturnType<typeof groupDto>[]) => (held = next),
  };
}

describe('the share dialog with groups', () => {
  it('lists a group with its people, adds another from the one picker, and saves with groups', async () => {
    const { cloud, fake } = shareCloud({
      groups: [
        groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 3)),
        groupDto(WRITERS, 'Writers', MEMBERS.slice(1, 3)),
      ],
    });
    render(h(ShareDialog, { cloud, page, onClose: () => {} }));
    await until(() => rows('share-entries').length === 2, 'the list');
    expect(fake.permissions).toHaveBeenCalledWith(PAGE, true);
    const group = rows('share-entries')[1];
    expect(group.dataset.principal).toBe('group');
    expect(group.querySelector('.cgw-principal-name')!.textContent).toBe('Designers');
    expect(group.textContent).toContain('Group · People: 3');
    expect(group.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(group.querySelector('select')!.getAttribute('aria-label')).toBe('Access of Designers');
    await until(() => fake.groups.mock.calls.length > 0, 'the groups');

    // The picker is named, and lists the workspace, the groups not listed and the people.
    const input = document.getElementById('cgw-share-person') as HTMLInputElement;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(document.querySelector('label[for="cgw-share-person"]')!.textContent).toBe(
      'Person or group',
    );
    await act(async () => type(input, 'e'));
    await until(() => options().length > 0, 'the options');
    expect(options().map((o) => o.textContent)).toEqual([
      'Everyone in the workspace',
      'WritersGroup · People: 2',
      'Benben@example.test',
      'Cycy@example.test',
      'Gusgus@example.test',
    ]);
    expect(options()[1].querySelector('[data-principal="group"] svg')).not.toBeNull();
    await act(async () => type(input, ''));
    await pick('cgw-share-person', 'Wri', 'Writers');
    await until(() => rows('share-entries').length === 3, 'the added group');
    expect(rows('share-entries')[2].textContent).toContain('Group · People: 2');

    await act(async () => button(document, 'Save')!.click());
    expect(fake.setPermissions).toHaveBeenCalledWith(
      PAGE,
      {
        restricted: true,
        entries: [
          { principalType: 'user', principalId: ADA, level: 'full' },
          { principalType: 'group', principalId: DESIGNERS, level: 'view' },
          { principalType: 'group', principalId: WRITERS, level: 'view' },
        ],
      },
      true,
    );
    await until(() => document.body.textContent!.includes('Sharing saved.'), 'saved');
  });

  it('shows a guest no group, never asks for them, and saves saying nothing of groups', async () => {
    const { cloud, fake } = shareCloud({ knows: false });
    render(h(ShareDialog, { cloud, page, onClose: () => {} }));
    await until(() => rows('share-entries').length === 1, 'the list');
    await settle();
    expect(fake.permissions).toHaveBeenCalledWith(PAGE, false);
    expect(fake.groups).not.toHaveBeenCalled();
    expect(document.querySelector('[data-principal="group"]')).toBeNull();
    const input = document.getElementById('cgw-share-person') as HTMLInputElement;
    await act(async () => type(input, 'e'));
    await until(() => options().length > 0, 'the options');
    expect(document.querySelector('[role="option"] [data-principal="group"]')).toBeNull();
    await act(async () => button(document, 'Save')!.click());
    expect(fake.setPermissions).toHaveBeenCalledWith(
      PAGE,
      { restricted: true, entries: [{ principalType: 'user', principalId: ADA, level: 'full' }] },
      false,
    );
  });

  it('takes out a group deleted meanwhile when the save is refused, and says so', async () => {
    const { cloud, fake, hold } = shareCloud({
      groups: [groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 3))],
    });
    fake.setPermissions.mockRejectedValueOnce(new SyncHttpError(400, 'request.invalid', 'No'));
    render(h(ShareDialog, { cloud, page, onClose: () => {} }));
    await until(() => rows('share-entries').length === 2, 'the list');
    hold([]);
    await act(async () => button(document, 'Save')!.click());
    await until(() => rows('share-entries').length === 1, 'the group taken out');
    expect(document.body.textContent).toContain(
      'A group in the list was deleted meanwhile, so it was taken out. Save again.',
    );
  });
});

// ---------------------------------------------------------------------------- a workbook's access

describe('a workbook’s access with groups', () => {
  it('reads and saves with groups through the workbook routes', async () => {
    const server = fakeServer();
    const cloud = {
      api: server.api,
      knowsGroups: () => true,
      members: async () => MEMBERS,
      groups: async () => ({ groups: [groupDto(WRITERS, 'Writers', MEMBERS.slice(1, 3))] }),
    } as unknown as WorkbookAccessCloud;
    const workbook = { id: BOOK, name: 'Budget', workspaceId: WS } as unknown as Workbook;
    render(h(WorkbookPermissions, { cloud, workspaceId: WS, workbook, onClose: () => {} }));
    await until(
      () => server.requests.some((r) => r.url.pathname.endsWith('/permissions')),
      'the read',
    );
    const read = server.requests.find((r) => r.url.pathname.endsWith('/permissions'))!;
    expect(read.url.searchParams.getAll('principals')).toEqual(['group']);
    await until(() => !!button(document, 'Save'), 'full access');
    await pick('cgw-workbook-person', 'Wri', 'Writers');
    await until(() => rows('workbook-entries').length === 1, 'the group added');
    await act(async () => button(document, 'Save')!.click());
    await until(() => server.requests.some((r) => r.method === 'PUT'), 'the save');
    expect(server.requests.find((r) => r.method === 'PUT')!.body).toEqual({
      restricted: true,
      entries: [{ principalType: 'group', principalId: WRITERS, level: 'view' }],
      principals: ['group'],
    });
  });
});

// ------------------------------------------------------------------------ Settings → Groups

function groupsApi(initial: ReturnType<typeof groupDto>[] = []) {
  let held = initial;
  const api = {
    groups: vi.fn(async () => ({ groups: held })),
    createGroup: vi.fn(async (_ws: string, name: string, people: string[]) => {
      const made = groupDto(
        WRITERS,
        name,
        MEMBERS.filter((m) => people.includes(m.userId)),
      );
      held = [...held, made];
      return made;
    }),
    renameGroup: vi.fn(async (_ws: string, id: string, name: string, version: number) => {
      held = held.map((g) => (g.id === id ? { ...g, name, version: String(version + 1) } : g));
      return held.find((g) => g.id === id)!;
    }),
    setGroupPeople: vi.fn(async (_ws: string, id: string) => held.find((g) => g.id === id)!),
    deleteGroup: vi.fn(async (_ws: string, id: string) => {
      held = held.filter((g) => g.id !== id);
      return null;
    }),
  };
  return {
    api: api as unknown as GroupsApi,
    fake: api,
    hold: (next: ReturnType<typeof groupDto>[]) => (held = next),
  };
}

const settings = (
  api: GroupsApi,
  role: 'owner' | 'admin' | 'member' | 'guest',
  language: 'en' | 'ar' = 'en',
) => render(h(GroupsSettings, { api, workspaceId: WS, role, members: MEMBERS }), language);

const status = () => document.querySelector('[data-testid="groups-status"]')?.textContent ?? '';

describe('Settings → Members → Groups', () => {
  it('shows a guest nothing and never asks', async () => {
    const { api, fake } = groupsApi([groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 2))]);
    const container = settings(api, 'guest');
    await settle();
    expect(container.innerHTML).toBe('');
    expect(fake.groups).not.toHaveBeenCalled();
  });

  it('lets a member read the groups and their people, and change nothing', async () => {
    const { api } = groupsApi([groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 2))]);
    const container = settings(api, 'member');
    await until(() => !!container.querySelector('[data-group-id]'), 'the groups');
    const row = container.querySelector('[data-group-id]')!;
    expect(row.textContent).toContain('Designers');
    expect(row.textContent).toContain('People: 2');
    expect(row.querySelector('.cgw-groups-names')!.textContent).toBe('Ada and Ben');
    expect(container.textContent).toContain('Only owners and admins can make and change groups.');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('lets an owner make a group of members, never guests', async () => {
    const { api, fake } = groupsApi();
    const container = settings(api, 'owner');
    await until(() => container.textContent!.includes('No groups yet.'), 'the empty list');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="group-new"]')!.click());
    const form = container.querySelector('[data-testid="group-form"]')!;
    expect(checkbox(form, 'Gus')).toBeNull();
    expect(button(form, 'Create the group')!.disabled).toBe(true);
    act(() => type(form.querySelector<HTMLInputElement>('#cgw-group-new-name')!, '  Writers '));
    act(() => checkbox(form, 'Ben')!.click());
    act(() => checkbox(form, 'Cy')!.click());
    await act(async () => button(form, 'Create the group')!.click());
    expect(fake.createGroup).toHaveBeenCalledWith(WS, 'Writers', [BEN, CY]);
    await until(() => status() === '“Writers” is made.', 'made');
    await until(() => !!container.querySelector('[data-group-id]'), 'the new group');
    expect(container.querySelector('[data-group-id]')!.textContent).toContain('People: 2');
  });

  it('renames and sets people with the version read; a stale one reads the group again', async () => {
    const { api, fake, hold } = groupsApi([
      groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 2), 3),
    ]);
    const container = settings(api, 'admin');
    await until(() => !!named(container, 'Edit Designers'), 'the group');
    act(() => named(container, 'Edit Designers')!.click());
    const form = container.querySelector('[data-testid="group-edit"]')!;
    expect(form.querySelector('legend')!.textContent).toBe('People in Designers');
    act(() =>
      type(form.querySelector<HTMLInputElement>(`#cgw-group-${DESIGNERS}-name`)!, 'Design'),
    );
    act(() => checkbox(form, 'Ben')!.click());
    await act(async () => button(form, 'Save')!.click());
    expect(fake.renameGroup).toHaveBeenCalledWith(WS, DESIGNERS, 'Design', 3);
    expect(fake.setGroupPeople).toHaveBeenCalledWith(WS, DESIGNERS, [ADA], 4);
    await until(() => status() === '“Design” is saved.', 'saved');

    // Someone else changed it meanwhile: refused, read again, said.
    const reads = fake.groups.mock.calls.length;
    fake.renameGroup.mockRejectedValueOnce(new SyncHttpError(409, 'version.conflict', 'Stale'));
    await until(() => !!named(container, 'Edit Design'), 'the renamed group');
    act(() => named(container, 'Edit Design')!.click());
    hold([groupDto(DESIGNERS, 'Design team', MEMBERS.slice(0, 3), 9)]);
    act(() =>
      type(container.querySelector<HTMLInputElement>(`#cgw-group-${DESIGNERS}-name`)!, 'Studio'),
    );
    await act(async () => button(container, 'Save')!.click());
    await until(() => status().startsWith('“Design” was changed meanwhile'), 'the stale notice');
    await until(() => fake.groups.mock.calls.length > reads, 'read again');
    await until(() => container.textContent!.includes('Design team'), 'the group as it is now');
    expect(container.querySelector('[data-testid="group-edit"]')).toBeNull();
  });

  it('says each refusal in words', async () => {
    expect(refusalKey('access.denied')).toBe('groups.denied');
    expect(refusalKey('request.invalid')).toBe('groups.invalid');
    expect(refusalKey('conflict')).toBe('groups.nameTaken');
    expect(refusalKey('version.conflict')).toBe('groups.stale');
    expect(refusalKey('not.found')).toBe('groups.gone');
    expect(refusalKey('offline')).toBe('cloud.requestFailed');
    const { api, fake } = groupsApi([groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 2))]);
    const container = settings(api, 'owner');
    await until(() => !!container.querySelector('[data-group-id]'), 'the group');
    const tryCreate = async (code: string, status: number) => {
      fake.createGroup.mockRejectedValueOnce(new SyncHttpError(status, code, 'No'));
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="group-new"]')!.click());
      act(() =>
        type(container.querySelector<HTMLInputElement>('#cgw-group-new-name')!, 'Designers'),
      );
      await act(async () => button(container, 'Create the group')!.click());
      await settle();
      const said = document.querySelector('[data-testid="groups-status"]')!.textContent;
      act(() => button(container, 'Cancel')?.click());
      return said;
    };
    expect(await tryCreate('conflict', 409)).toBe('Another group is already called “Designers”.');
    expect(await tryCreate('request.invalid', 400)).toBe(
      'The server did not take that: a name is 1 to 100 characters, a workspace has at most 200 groups, and only its members can be in one.',
    );
    expect(await tryCreate('access.denied', 403)).toBe('Only an owner or admin can change groups.');
    expect(await tryCreate('server.error', 500)).toBe('The server did not take that. Try again.');
  });

  it('asks before deleting, saying how many people and what they lose', async () => {
    const { api, fake } = groupsApi([groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 2))]);
    const container = settings(api, 'owner');
    await until(() => !!named(container, 'Delete Designers'), 'the group');
    act(() => named(container, 'Delete Designers')!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Delete the group “Designers”?');
    expect(dialog.textContent).toContain('People in it: 2. They lose the access the group gives');
    expect(fake.deleteGroup).not.toHaveBeenCalled();
    await act(async () => button(dialog, 'Delete the group')!.click());
    expect(fake.deleteGroup).toHaveBeenCalledWith(WS, DESIGNERS);
    await until(() => status() === '“Designers” is deleted.', 'deleted');
    await until(() => container.textContent!.includes('No groups yet.'), 'the empty list');
  });

  it('says a group someone else deleted first is gone, and reads the groups again', async () => {
    const { api, fake } = groupsApi([groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 2))]);
    const container = settings(api, 'owner');
    await until(() => !!named(container, 'Delete Designers'), 'the group');
    const reads = fake.groups.mock.calls.length;
    fake.deleteGroup.mockRejectedValueOnce(new SyncHttpError(404, 'not.found', 'Gone'));
    act(() => named(container, 'Delete Designers')!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    await act(async () => button(dialog, 'Delete the group')!.click());
    await until(() => status() === 'That group was deleted meanwhile.', 'the notice');
    await until(() => fake.groups.mock.calls.length > reads, 'read again');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('reads in Arabic, numbers too', async () => {
    const { api } = groupsApi([groupDto(DESIGNERS, 'Designers', MEMBERS.slice(0, 2))]);
    const container = settings(api, 'owner', 'ar');
    await until(() => !!container.querySelector('[data-group-id]'), 'the group');
    expect(container.querySelector('h3')!.textContent).toBe('المجموعات');
    // In the interface language's digits (Intl's, whichever its data gives Arabic).
    expect(container.querySelector('[data-group-id]')!.textContent).toMatch(
      new RegExp(`الأشخاص: ${new Intl.NumberFormat('ar').format(2)}`),
    );
    expect(named(container, 'تعديل Designers')).not.toBeNull();
  });
});
