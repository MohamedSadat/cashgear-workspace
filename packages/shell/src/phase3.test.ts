// Phase 3 in the shell: signed in while offline, recovered pages (idempotent across runs, tabs
// and restarts), what is kept offline, and a notice for every code the engine and the document
// layer report.
import { PageDocument, docCodec, fragmentToJSON, newDocumentUpdate, plainText } from '@cgw/doc';
import {
  ACCOUNT_PREF,
  MemoryStore,
  keyBetween,
  newOp,
  uuidv7,
  type Id,
  type PageRecord,
  type SectionRecord,
} from '@cgw/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cloud } from './cloud/cloud';
import { OfflineState } from './cloud/offline';
import { Recovery, recoveredPageId } from './cloud/recovery';
import { ar, en, flatten } from './i18n';
import { RECOVERY_CODES, noticeTarget, noticeText, targetLabel } from './notices';
import type { CloudPlatform } from './platform';
import { parseRoute, routeHash } from './route';
import { WorkspaceSession, canEditPage } from './session';

const now = () => new Date().toISOString();

function pageRecord(id: Id, workspaceId: Id, sectionId: Id, title: string, orderKey = 'a0') {
  return {
    id,
    workspaceId,
    sectionId,
    parentPageId: null,
    orderKey,
    kind: 'page',
    title,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    trashedAt: null,
    trashRootId: null,
  } satisfies PageRecord;
}

const section = (
  id: Id,
  workspaceId: Id,
  visibility: SectionRecord['visibility'],
  orderKey: string,
): SectionRecord => ({
  id,
  workspaceId,
  name: visibility,
  orderKey,
  visibility,
  version: 1,
  createdAt: now(),
});

const paragraph = (text: string) => ({
  type: 'doc',
  content: [
    {
      type: 'block',
      attrs: { id: 'AbCdEfGhIjKl' },
      content: [
        { type: 'textBody', attrs: { kind: 'paragraph' }, content: [{ type: 'text', text }] },
      ],
    },
  ],
});

/** A synced workspace with a page whose unsent edit was set aside (as a 409 epoch change does). */
async function setAside({ privateSection = true } = {}) {
  const store = new MemoryStore();
  const workspaceId = uuidv7();
  const shared = uuidv7();
  const personal = uuidv7();
  const pageId = uuidv7();
  const existing = uuidv7();
  await store.applyRemote({
    workspaceId,
    cursor: 1,
    workspaces: [
      {
        id: workspaceId,
        name: 'Team',
        icon: null,
        createdAt: now(),
        version: 1,
        localOnly: false,
        deletedAt: null,
        accountId: 'account',
      },
    ],
    sections: [
      section(shared, workspaceId, 'workspace', 'a0'),
      ...(privateSection ? [section(personal, workspaceId, 'private', 'a1')] : []),
    ],
    pages: [
      pageRecord(pageId, workspaceId, shared, 'Minutes'),
      ...(privateSection ? [pageRecord(existing, workspaceId, personal, 'Already here')] : []),
    ],
  });
  await store.appendDocUpdates(pageId, [
    { updateId: uuidv7(), data: newDocumentUpdate(pageId, paragraph('Typed offline')) },
  ]);
  const entry = (await store.setAsideDoc(pageId, 'doc.epochMismatch'))!;
  expect(entry).not.toBeNull();
  const session = await WorkspaceSession.start(store);
  return { store, session, workspaceId, personal, pageId, existing, entry };
}

const title = (t: string) => `Recovered: ${t}`;

async function textOf(store: MemoryStore, pageId: Id) {
  const doc = await PageDocument.open(pageId, store, { canEdit: false });
  const text = plainText(fragmentToJSON(doc.fragment));
  await doc.close();
  return text;
}

describe('recovered pages', () => {
  it('make a page at the top of the private section with what was set aside, once', async () => {
    const { store, session, personal, existing, entry } = await setAside();
    const recovery = new Recovery(session, title);
    await recovery.run();
    const made = [...session.mirror.pages.values()].filter((p) => p.title === 'Recovered: Minutes');
    expect(made).toHaveLength(1);
    expect(made[0].id).toBe(await recoveredPageId(entry.id));
    expect(made[0].sectionId).toBe(personal);
    expect(session.mirror.topPages(personal).map((p) => p.id)).toEqual([made[0].id, existing]);
    expect(await textOf(store, made[0].id)).toContain('Typed offline');
    const [settled] = await store.quarantine(null);
    expect(settled.status).toBe('recovered');
    expect(settled.recoveredPageId).toBe(made[0].id);
    expect(recovery.visible().map((i) => i.id)).toEqual([entry.id]);
    expect(recovery.latestFor(entry.pageId)?.recoveredPageId).toBe(made[0].id);

    // Every pass says `recover` while anything is pending; another tab, a restart: still one.
    await recovery.run(true);
    await new Recovery(await WorkspaceSession.start(store), title).run();
    const reloaded = await WorkspaceSession.start(store);
    expect(
      [...reloaded.mirror.pages.values()].filter((p) => p.title === 'Recovered: Minutes'),
    ).toHaveLength(1);
  });

  it('finish a page made before the app stopped, without making another', async () => {
    const { store, session, workspaceId, personal, entry } = await setAside();
    // The page was made, then the app stopped before its document or the settle.
    const id = await recoveredPageId(entry.id);
    const record = pageRecord(
      id,
      workspaceId,
      personal,
      'Recovered: Minutes',
      keyBetween(null, 'a0'),
    );
    await session.apply([newOp('page.create', workspaceId, id, record)]);
    await new Recovery(await WorkspaceSession.start(store), title).run();
    expect(await textOf(store, id)).toContain('Typed offline');
    expect((await store.quarantine(null))[0]).toMatchObject({
      status: 'recovered',
      recoveredPageId: id,
    });
    const after = await WorkspaceSession.start(store);
    expect(
      [...after.mirror.pages.values()].filter((p) => p.title.startsWith('Recovered')),
    ).toHaveLength(1);
  });

  it('wait while no private section can take them, then go to the open workspace', async () => {
    const { store, session, entry } = await setAside({ privateSection: false });
    const recovery = new Recovery(session, title);
    await recovery.run();
    expect((await store.quarantine(null))[0].status).toBe('pending');
    expect(recovery.visible()[0]).toMatchObject({ id: entry.id, status: 'pending' });
    // A local workspace with a private section opens: the entry's page goes there.
    const { personal } = await session.createWorkspace('Mine', { shared: 'W', private: 'P' });
    await recovery.run(true);
    const [settled] = await store.quarantine(null);
    expect(settled.status).toBe('recovered');
    expect(session.mirror.pages.get(settled.recoveredPageId!)?.sectionId).toBe(personal.id);
  });

  it('can be dismissed from the list once recovered; the page stays', async () => {
    const { store, session, entry } = await setAside();
    const recovery = new Recovery(session, title);
    await recovery.run();
    await recovery.dismiss(entry.id);
    expect(recovery.visible()).toEqual([]);
    const [dismissed] = await store.quarantine(null);
    expect(dismissed.status).toBe('dismissed');
    expect(session.mirror.pages.has(dismissed.recoveredPageId!)).toBe(true);
  });

  it('get ids that are UUIDv7 and the same for the same entry', async () => {
    const id = uuidv7();
    const page = await recoveredPageId(id);
    expect(page).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(page.slice(0, 13)).toBe(id.slice(0, 13));
    expect(await recoveredPageId(id)).toBe(page);
    expect(await recoveredPageId(uuidv7())).not.toBe(page);
  });
});

describe('signed in while offline', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const platform = {
    kind: 'web',
    apiBase: 'http://127.0.0.1:9',
    auth: { kind: 'cookie' },
    setWindowTheme: async () => {},
    openExternal: async () => {},
    openStore: async () => new MemoryStore(),
    saveFile: async () => {},
  } as CloudPlatform;
  const ada = { id: uuidv7(), email: 'ada@example.test', displayName: 'Ada', deviceId: null };

  async function until(check: () => boolean) {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  }

  it('uses the account last signed in here when the server cannot be reached', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const store = new MemoryStore();
    await store.setPref(ACCOUNT_PREF, ada);
    const cloud = new Cloud(platform, await WorkspaceSession.start(store), docCodec);
    try {
      expect((await cloud.refreshAccount())?.id).toBe(ada.id);
      expect(cloud.account?.displayName).toBe('Ada');
      await until(() => cloud.status.state === 'offline');
      // Never forgotten for want of a network.
      expect(await store.getPref(ACCOUNT_PREF)).toMatchObject({ id: ada.id });
    } finally {
      cloud.dispose();
    }
  });

  it('is signed out only when the server says so', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ account: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const store = new MemoryStore();
    await store.setPref(ACCOUNT_PREF, ada);
    const cloud = new Cloud(platform, await WorkspaceSession.start(store), docCodec);
    try {
      expect(await cloud.refreshAccount()).toBeNull();
      expect(cloud.account).toBeNull();
      await until(() => cloud.status.state === 'signedOut');
    } finally {
      cloud.dispose();
    }
  });
});

describe('what is kept offline', () => {
  it('knows a page covered by a parent’s pin, and marks pages only while cut off', async () => {
    const store = new MemoryStore();
    const workspaceId = uuidv7();
    const sectionId = uuidv7();
    const [parent, child, other] = [uuidv7(), uuidv7(), uuidv7()];
    await store.applyRemote({
      workspaceId,
      workspaces: [
        {
          id: workspaceId,
          name: 'Team',
          icon: null,
          createdAt: now(),
          version: 1,
          localOnly: false,
          deletedAt: null,
          accountId: 'account',
        },
      ],
      sections: [section(sectionId, workspaceId, 'workspace', 'a0')],
      pages: [
        pageRecord(parent, workspaceId, sectionId, 'Parent'),
        { ...pageRecord(child, workspaceId, sectionId, 'Child'), parentPageId: parent },
        pageRecord(other, workspaceId, sectionId, 'Other', 'a1'),
      ],
    });
    await store.pin({ workspaceId, pageId: parent, subtree: true, pinnedAt: now() });
    const session = await WorkspaceSession.start(store);
    let notify = () => {};
    const status = { state: 'synced' as string };
    const cloud = {
      account: { id: 'account' },
      get status() {
        return status;
      },
      subscribe: (listener: () => void) => ((notify = listener), () => {}),
      engine: { availableOffline: async () => new Set([parent]) },
    } as unknown as Cloud;
    const offline = new OfflineState(cloud, session);
    await offline.reload();
    expect(offline.pinOf(parent)).toMatchObject({ inherited: false });
    expect(offline.pinOf(child)).toMatchObject({ inherited: true, pin: { pageId: parent } });
    expect(offline.pinOf(other)).toBeNull();
    expect(offline.marks()).toBeNull();
    status.state = 'offline';
    notify();
    expect(offline.marks()).toEqual(new Set([parent]));
    // The same object until it changes: the tree renders again only then.
    expect(offline.marks()).toBe(offline.marks());
    offline.dispose();
  });
});

describe('notices', () => {
  const codes = [
    'doc.epochMismatch',
    'page.gone',
    'access.denied',
    'page.removed',
    'page.trashed',
    'tree.parentMissing',
    'tree.cycle',
    'version.conflict',
    'client.tooOld',
    'doc.refused',
    'doc.clientTaken',
    'doc.repaired',
    'doc.repairFailed',
    'limit.size',
    'asset.typeNotAllowed',
    'workspace.lost',
    'doc.moveConflict',
  ];
  const english = flatten(en);
  const arabic = flatten(ar);

  it('word every code in both languages, each its own text', () => {
    const keys = codes.map((code) => noticeText({ code, pageId: uuidv7() }));
    expect(new Set(keys).size).toBe(codes.length);
    const variants = [
      noticeText({ code: 'doc.moveConflict', reason: 'movedTwice' }),
      noticeText({ code: 'doc.epochMismatch', setAside: false }),
    ];
    expect(variants.filter((key) => keys.includes(key))).toEqual([]);
    for (const key of [...keys, ...variants]) {
      expect(english.get(key), key).toBeTruthy();
      expect(arabic.get(key), key).toBeTruthy();
    }
  });

  it('say only what happened when a restore set nothing aside', () => {
    const pageId = uuidv7();
    expect(noticeTarget({ code: 'doc.epochMismatch', pageId, setAside: false })).toEqual({
      kind: 'history',
      pageId,
    });
  });

  it('lead to where the work is', () => {
    const pageId = uuidv7();
    const recovered = uuidv7();
    for (const code of RECOVERY_CODES)
      expect(noticeTarget({ code, pageId }, recovered)).toEqual({
        kind: 'recovered',
        pageId: recovered,
      });
    expect(noticeTarget({ code: 'page.gone', pageId })).toEqual({
      kind: 'recovered',
      pageId: null,
    });
    expect(noticeTarget({ code: 'page.trashed', pageId })).toEqual({ kind: 'trash' });
    expect(noticeTarget({ code: 'doc.refused', pageId })).toEqual({ kind: 'history', pageId });
    expect(
      noticeTarget({
        code: 'doc.moveConflict',
        pageId,
        blockId: 'AbCdEfGhIjKl',
        reason: 'editLost',
      }),
    ).toEqual({ kind: 'history', pageId });
    expect(
      noticeTarget({
        code: 'doc.moveConflict',
        pageId,
        blockId: 'AbCdEfGhIjKl',
        reason: 'movedTwice',
      }),
    ).toEqual({ kind: 'block', pageId, blockId: 'AbCdEfGhIjKl' });
    for (const target of [
      { kind: 'recovered', pageId: null },
      { kind: 'recovered', pageId },
      { kind: 'trash' },
      { kind: 'history', pageId },
      { kind: 'page', pageId },
      { kind: 'block', pageId, blockId: 'x' },
    ] as const) {
      expect(english.get(targetLabel(target))).toBeTruthy();
      expect(arabic.get(targetLabel(target))).toBeTruthy();
    }
  });
});

describe('the recovered view', () => {
  it('has a route', () => {
    expect(parseRoute('#/recovered')).toEqual({ kind: 'recovered' });
    expect(routeHash({ kind: 'recovered' })).toBe('#/recovered');
  });
});

describe('the flush before hiding, closing or uploading', () => {
  it('writes a title still waiting on its pause, and resolves once it is stored', async () => {
    const store = new MemoryStore();
    const session = await WorkspaceSession.start(store);
    const { shared } = await session.createWorkspace('W', { shared: 'S', private: 'P' });
    const page = await session.createPage({ sectionId: shared.id, parentPageId: null });
    // As the title field does: a value typed, its 400 ms pause not over yet.
    let waiting: string | null = 'Typed just before closing';
    const off = session.onFlush(() => {
      if (waiting === null) return;
      const title = waiting;
      waiting = null;
      return session.updatePage(page.id, { title });
    });
    await session.flushAll();
    expect((await store.getPage(page.id))?.title).toBe('Typed just before closing');
    off();
    await session.flushAll();
    expect(waiting).toBeNull();
  });
});

describe('a page the account may only view', () => {
  it('is not editable, and its open document opens again when access changes', async () => {
    expect(canEditPage(undefined)).toBe(true);
    for (const access of ['full', 'edit'] as const)
      expect(canEditPage({ ...pageRecord(uuidv7(), 'w', 's', 'T'), access })).toBe(true);
    for (const access of ['comment', 'view', 'none'] as const)
      expect(canEditPage({ ...pageRecord(uuidv7(), 'w', 's', 'T'), access })).toBe(false);

    const store = new MemoryStore();
    const workspaceId = uuidv7();
    const sectionId = uuidv7();
    const pageId = uuidv7();
    const workspace = {
      id: workspaceId,
      name: 'Team',
      icon: null,
      createdAt: now(),
      version: 1,
      localOnly: false,
      deletedAt: null,
      accountId: 'account',
    };
    const remote = (access: 'edit' | 'view') =>
      store.applyRemote({
        workspaceId,
        workspaces: [workspace],
        sections: [section(sectionId, workspaceId, 'workspace', 'a0')],
        pages: [{ ...pageRecord(pageId, workspaceId, sectionId, 'Shared'), access }],
      });
    await remote('edit');
    await store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: newDocumentUpdate(pageId, paragraph('Shared text')) },
    ]);
    const session = await WorkspaceSession.start(store);
    const reset: Id[] = [];
    session.onDocReset((id) => reset.push(id));
    const first = await session.openDoc(pageId);
    // The same access after a resync: nothing to do.
    await session.reloadMirror();
    expect(reset).toEqual([]);
    // Edit taken away: opened again (to read, writing nothing on open).
    await remote('view');
    await session.reloadMirror();
    expect(reset).toEqual([pageId]);
    const second = await session.openDoc(pageId);
    expect(second).not.toBe(first);
    expect(plainText(fragmentToJSON(second.fragment))).toContain('Shared text');
    // And back.
    await remote('edit');
    await session.reloadMirror();
    expect(reset).toEqual([pageId, pageId]);
    await session.close();
  });
});
