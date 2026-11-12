// The LocalStore conformance suite (SYNC_DESIGN.md, "Tests that guard this design"): the same
// cases run against every store, so the browser's IndexedDB store and the desktop's SQLite store
// behave the same. Call it from a test file with a factory that returns an empty store.
import { describe, expect, it } from 'vitest';
import { uuidv7, type Id } from '../ids';
import { keyBetween } from '../order';
import { normaliseText } from '../search';
import type { LocalStore, Operation, PageRecord, SectionRecord, WorkspaceRecord } from '../types';

export type StoreFactory = () => Promise<LocalStore>;

const at = () => new Date().toISOString();

export function op<T extends Operation['type']>(
  type: T,
  workspaceId: Id,
  entityId: Id,
  payload: Extract<Operation, { type: T }>['payload'],
  baseVersion: number | null = null,
): Operation {
  return {
    opId: uuidv7(),
    type,
    workspaceId,
    entityId,
    baseVersion,
    payload,
    createdAt: at(),
  } as Operation;
}

export function workspaceRecord(name = 'Test'): WorkspaceRecord {
  return {
    id: uuidv7(),
    name,
    icon: null,
    createdAt: at(),
    version: 1,
    localOnly: true,
    deletedAt: null,
  };
}

export function sectionRecord(workspaceId: Id, name = 'Pages', orderKey = 'a0'): SectionRecord {
  return {
    id: uuidv7(),
    workspaceId,
    name,
    orderKey,
    visibility: 'workspace',
    version: 1,
    createdAt: at(),
  };
}

export function pageRecord(
  workspaceId: Id,
  sectionId: Id,
  parentPageId: Id | null,
  title: string,
  orderKey = 'a0',
): PageRecord {
  return {
    id: uuidv7(),
    workspaceId,
    sectionId,
    parentPageId,
    orderKey,
    kind: 'page',
    title,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: at(),
    updatedAt: at(),
    trashedAt: null,
    trashRootId: null,
  };
}

/** A workspace with one section and a small tree: A > (B > D), C. */
export async function seedTree(store: LocalStore) {
  const ws = workspaceRecord();
  const section = sectionRecord(ws.id);
  const a = pageRecord(ws.id, section.id, null, 'Alpha', 'a0');
  const b = pageRecord(ws.id, section.id, a.id, 'Beta', 'a0');
  const c = pageRecord(ws.id, section.id, null, 'Gamma', 'a1');
  const d = pageRecord(ws.id, section.id, b.id, 'Delta', 'a0');
  await store.applyLocalOps([
    op('workspace.create', ws.id, ws.id, ws),
    op('section.create', ws.id, section.id, section),
    ...[a, b, c, d].map((p) => op('page.create', ws.id, p.id, p)),
  ]);
  return { ws, section, a, b, c, d };
}

const bytes = (...values: number[]) => new Uint8Array(values);

export function describeLocalStore(name: string, factory: StoreFactory) {
  describe(`LocalStore conformance: ${name}`, () => {
    it('keeps document updates in order, byte for byte, with rising local sequences', async () => {
      const store = await factory();
      const page = uuidv7();
      const first = await store.appendDocUpdates(page, [
        { updateId: uuidv7(), data: bytes(0, 1, 2, 255, 0) },
        { updateId: uuidv7(), data: bytes() },
      ]);
      const second = await store.appendDocUpdates(page, [{ updateId: uuidv7(), data: bytes(7) }]);
      expect(first[1]).toBe(first[0] + 1);
      expect(second[0]).toBe(first[1] + 1);
      const loaded = await store.loadDoc(page);
      expect(loaded.snapshot).toBeNull();
      expect(loaded.updates.map((u) => [...u.data])).toEqual([[0, 1, 2, 255, 0], [], [7]]);
      expect(loaded.updates.map((u) => u.localSeq)).toEqual([...first, ...second]);
      expect(loaded.updates.every((u) => u.seq === null)).toBe(true);
      expect(await store.docLogLength(page)).toBe(3);
      expect((await store.loadDoc(uuidv7())).updates).toEqual([]);
      await store.close();
    });

    it('gives concurrent appends distinct sequences and loses none', async () => {
      const store = await factory();
      const page = uuidv7();
      const seqs = (
        await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            store.appendDocUpdates(page, [{ updateId: uuidv7(), data: bytes(i) }]),
          ),
        )
      ).flat();
      expect(new Set(seqs).size).toBe(20);
      const loaded = await store.loadDoc(page);
      expect(loaded.updates.map((u) => u.data[0]).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i),
      );
      await store.close();
    });

    it('compacts: the snapshot replaces the updates it covers, later ones stay', async () => {
      const store = await factory();
      const page = uuidv7();
      const seqs = await store.appendDocUpdates(
        page,
        [1, 2, 3].map((v) => ({ updateId: uuidv7(), data: bytes(v) })),
      );
      await store.compactDoc(page, bytes(9, 9), seqs[1]);
      const loaded = await store.loadDoc(page);
      expect([...loaded.snapshot!]).toEqual([9, 9]);
      expect(loaded.snapshotCovers).toBe(seqs[1]);
      expect(loaded.updates.map((u) => [...u.data])).toEqual([[3]]);
      const next = await store.appendDocUpdates(page, [{ updateId: uuidv7(), data: bytes(4) }]);
      expect(next[0]).toBeGreaterThan(seqs[2]);
      expect(await store.docLogLength(page)).toBe(2);
      await store.close();
    });

    it('moves undecodable updates out of the log', async () => {
      const store = await factory();
      const page = uuidv7();
      const seqs = await store.appendDocUpdates(
        page,
        [1, 2, 3].map((v) => ({ updateId: uuidv7(), data: bytes(v) })),
      );
      await store.quarantineUpdates(page, [seqs[1]], 'test');
      expect((await store.loadDoc(page)).updates.map((u) => u.data[0])).toEqual([1, 3]);
      await store.close();
    });

    it('keeps local history, newest first, up to the limit', async () => {
      const store = await factory();
      const page = uuidv7();
      const entries = [];
      for (let i = 0; i < 4; i++) entries.push(await store.addHistory(page, bytes(i, i), 3));
      const listed = await store.listHistory(page);
      expect(listed.map((e) => e.id)).toEqual(
        entries
          .slice(1)
          .reverse()
          .map((e) => e.id),
      );
      expect([...(await store.getHistory(listed[0].id))!]).toEqual([3, 3]);
      expect(await store.getHistory(entries[0].id)).toBeNull();
      expect(listed[0].sizeBytes).toBe(2);
      await store.close();
    });

    it('applies operations to the mirror and the outbox together, in order', async () => {
      const store = await factory();
      const { ws, section, a, b, c, d } = await seedTree(store);
      const mirror = await store.readMirror(ws.id);
      expect(mirror.workspaces.map((w) => w.id)).toEqual([ws.id]);
      expect(mirror.sections.map((s) => s.id)).toEqual([section.id]);
      expect(mirror.pages.map((p) => p.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
      const outbox = await store.nextOutboxBatch(100);
      expect(outbox.map((o) => o.type)).toEqual([
        'workspace.create',
        'section.create',
        'page.create',
        'page.create',
        'page.create',
        'page.create',
      ]);
      expect((await store.nextOutboxBatch(2)).length).toBe(2);
      await store.settleOps(outbox.slice(0, 2).map((o) => ({ opId: o.opId, status: 'applied' })));
      expect((await store.nextOutboxBatch(100)).map((o) => o.opId)).toEqual(
        outbox.slice(2).map((o) => o.opId),
      );
      await store.close();
    });

    it('renames, refusing nothing; versions rise', async () => {
      const store = await factory();
      const { ws, a } = await seedTree(store);
      await store.applyLocalOp(op('page.update', ws.id, a.id, { title: 'Alpha 2', icon: '📘' }));
      const page = await store.getPage(a.id);
      expect(page).toMatchObject({ title: 'Alpha 2', icon: '📘', version: 2 });
      await store.close();
    });

    it('moves a page, refuses a cycle, and changes nothing when a batch fails', async () => {
      const store = await factory();
      const { ws, section, a, b, c, d } = await seedTree(store);
      await store.applyLocalOp(
        op(
          'page.move',
          ws.id,
          b.id,
          { sectionId: section.id, parentPageId: c.id, orderKey: 'a0' },
          1,
        ),
      );
      expect((await store.getPage(b.id))!.parentPageId).toBe(c.id);
      await expect(
        store.applyLocalOp(
          op(
            'page.move',
            ws.id,
            c.id,
            { sectionId: section.id, parentPageId: d.id, orderKey: 'a0' },
            1,
          ),
        ),
      ).rejects.toMatchObject({ code: 'tree.cycle' });
      await expect(
        store.applyLocalOp(
          op(
            'page.move',
            ws.id,
            a.id,
            { sectionId: section.id, parentPageId: null, orderKey: 'a5' },
            99,
          ),
        ),
      ).rejects.toMatchObject({ code: 'version.conflict' });
      const before = await store.nextOutboxBatch(100);
      await expect(
        store.applyLocalOps([
          op('page.update', ws.id, a.id, { title: 'Changed' }),
          op(
            'page.move',
            ws.id,
            c.id,
            { sectionId: section.id, parentPageId: d.id, orderKey: 'a0' },
            1,
          ),
        ]),
      ).rejects.toMatchObject({ code: 'tree.cycle' });
      expect((await store.getPage(a.id))!.title).toBe('Alpha');
      expect((await store.nextOutboxBatch(100)).length).toBe(before.length);
      await store.close();
    });

    it('moves a subtree to another section with its descendants', async () => {
      const store = await factory();
      const { ws, a, b, d } = await seedTree(store);
      const other = sectionRecord(ws.id, 'Private', 'a1');
      await store.applyLocalOp(op('section.create', ws.id, other.id, other));
      await store.applyLocalOp(
        op(
          'page.move',
          ws.id,
          a.id,
          { sectionId: other.id, parentPageId: null, orderKey: 'a0' },
          1,
        ),
      );
      for (const id of [a.id, b.id, d.id])
        expect((await store.getPage(id))!.sectionId).toBe(other.id);
      await store.close();
    });

    it('trashes a subtree as one unit and restores the same unit', async () => {
      const store = await factory();
      const { ws, a, b, c, d } = await seedTree(store);
      await store.applyLocalOp(op('page.trash', ws.id, d.id, {}, 1));
      await store.applyLocalOp(op('page.trash', ws.id, a.id, {}, 1));
      const trashed = await store.readMirror(ws.id);
      const byId = new Map(trashed.pages.map((p) => [p.id, p]));
      expect(byId.get(a.id)!.trashRootId).toBe(a.id);
      expect(byId.get(b.id)!.trashRootId).toBe(a.id);
      expect(byId.get(d.id)!.trashRootId).toBe(d.id);
      expect(byId.get(c.id)!.trashedAt).toBeNull();
      await expect(
        store.applyLocalOp(op('page.update', ws.id, b.id, { title: 'x' })),
      ).rejects.toMatchObject({ code: 'page.trashed' });
      await expect(store.applyLocalOp(op('page.restore', ws.id, b.id, {}))).rejects.toMatchObject({
        code: 'page.notTrashed',
      });
      await store.applyLocalOp(op('page.restore', ws.id, a.id, {}));
      expect((await store.getPage(b.id))!.trashedAt).toBeNull();
      // D was trashed on its own before A, so it stays in the trash.
      expect((await store.getPage(d.id))!.trashRootId).toBe(d.id);
      await store.close();
    });

    it('restores a page whose parent is gone at the top of its section', async () => {
      const store = await factory();
      const { ws, a, b } = await seedTree(store);
      await store.applyLocalOp(op('page.trash', ws.id, b.id, {}, 1));
      await store.applyLocalOp(op('page.trash', ws.id, a.id, {}, 1));
      await store.applyLocalOp(op('page.restore', ws.id, b.id, {}));
      const page = (await store.getPage(b.id))!;
      expect(page.parentPageId).toBeNull();
      expect(page.trashedAt).toBeNull();
      await store.close();
    });

    it('deletes for good only from the trash, with descendants and their documents', async () => {
      const store = await factory();
      const { ws, a, b, d } = await seedTree(store);
      await store.appendDocUpdates(d.id, [{ updateId: uuidv7(), data: bytes(1) }]);
      await store.putSearchEntry({
        pageId: d.id,
        workspaceId: ws.id,
        title: 'delta',
        text: 'kept text',
      });
      await expect(store.applyLocalOp(op('page.delete', ws.id, a.id, {}))).rejects.toMatchObject({
        code: 'page.notTrashed',
      });
      await store.applyLocalOp(
        op('favourite.set', ws.id, b.id, { favourite: true, orderKey: 'a0' }),
      );
      await store.applyLocalOp(op('page.trash', ws.id, a.id, {}, 1));
      await store.applyLocalOp(op('page.delete', ws.id, a.id, {}));
      for (const id of [a.id, b.id, d.id]) expect(await store.getPage(id)).toBeNull();
      expect((await store.loadDoc(d.id)).updates).toEqual([]);
      expect(await store.search(ws.id, 'kept', 10)).toEqual([]);
      expect((await store.readMirror(ws.id)).favourites).toEqual([]);
      await store.close();
    });

    it('purges the trash older than the retention', async () => {
      const store = await factory();
      const { ws, a, c } = await seedTree(store);
      await store.applyLocalOp(op('page.trash', ws.id, a.id, {}, 1));
      expect(await store.purgeTrash(ws.id, '2000-01-01T00:00:00.000Z')).toEqual([]);
      const gone = await store.purgeTrash(ws.id, new Date(Date.now() + 1000).toISOString());
      expect(gone).toContain(a.id);
      expect(await store.getPage(a.id)).toBeNull();
      expect(await store.getPage(c.id)).not.toBeNull();
      await store.close();
    });

    it('keeps favourites and visits', async () => {
      const store = await factory();
      const { ws, a, c } = await seedTree(store);
      await store.applyLocalOp(
        op('favourite.set', ws.id, a.id, { favourite: true, orderKey: keyBetween(null, null) }),
      );
      await store.applyLocalOp(
        op('favourite.set', ws.id, c.id, { favourite: true, orderKey: keyBetween('a0', null) }),
      );
      await store.applyLocalOp(
        op('favourite.set', ws.id, a.id, { favourite: false, orderKey: null }),
      );
      await store.applyLocalOp(op('visit.record', ws.id, c.id, { at: at() }));
      const mirror = await store.readMirror(ws.id);
      expect(mirror.favourites.map((f) => f.pageId)).toEqual([c.id]);
      expect(mirror.visits.map((v) => v.pageId)).toEqual([c.id]);
      await store.close();
    });

    it('refuses a page under a parent in another section, and a section that is not empty', async () => {
      const store = await factory();
      const { ws, section, a } = await seedTree(store);
      const other = sectionRecord(ws.id, 'Other', 'a1');
      await store.applyLocalOp(op('section.create', ws.id, other.id, other));
      const stray = pageRecord(ws.id, other.id, a.id, 'Stray');
      await expect(
        store.applyLocalOp(op('page.create', ws.id, stray.id, stray)),
      ).rejects.toMatchObject({ code: 'tree.section' });
      await expect(
        store.applyLocalOp(op('section.delete', ws.id, section.id, {})),
      ).rejects.toMatchObject({ code: 'section.notEmpty' });
      await store.applyLocalOp(op('section.delete', ws.id, other.id, {}));
      expect((await store.readMirror(ws.id)).sections.map((s) => s.id)).toEqual([section.id]);
      await store.close();
    });

    it('searches normalised titles and text, Arabic and English, leaving out the trash', async () => {
      const store = await factory();
      const { ws, a, b, c } = await seedTree(store);
      const entry = (pageId: Id, title: string, text: string) =>
        store.putSearchEntry({
          pageId,
          workspaceId: ws.id,
          title: normaliseText(title),
          text: normaliseText(text),
        });
      await entry(a.id, 'Alpha', 'The quarterly report for the north region');
      await entry(b.id, 'Beta', 'تقرير المبيعات الشهري للمنطقة الشمالية');
      await entry(c.id, 'Gamma', 'Nothing here');
      expect(
        (await store.search(ws.id, normaliseText('Quarter'), 10)).map((h) => h.pageId),
      ).toEqual([a.id]);
      // A query with tashkeel and a different alef finds text without them.
      expect(
        (await store.search(ws.id, normaliseText('المَبيعات'), 10)).map((h) => h.pageId),
      ).toEqual([b.id]);
      expect((await store.search(ws.id, normaliseText('gam'), 10)).map((h) => h.pageId)).toEqual([
        c.id,
      ]);
      expect(await store.search(ws.id, normaliseText('zzz'), 10)).toEqual([]);
      const hit = (await store.search(ws.id, normaliseText('report'), 10))[0];
      expect(hit.title).toBe('Alpha');
      await store.applyLocalOp(op('page.trash', ws.id, a.id, {}, 1));
      expect(await store.search(ws.id, normaliseText('quarterly'), 10)).toEqual([]);
      await store.deleteSearchEntries([c.id]);
      expect(await store.search(ws.id, normaliseText('gamma'), 10)).toEqual([]);
      await store.close();
    });

    it('keeps asset bytes and records', async () => {
      const store = await factory();
      const { ws } = await seedTree(store);
      const asset = {
        id: uuidv7(),
        workspaceId: ws.id,
        fileName: 'تقرير.png',
        contentType: 'image/png',
        sizeBytes: 3,
        sha256: 'abc',
        width: 1,
        height: 1,
        createdAt: at(),
      };
      await store.putAsset(asset, bytes(137, 80, 0));
      expect([...(await store.getAssetBytes(asset.id))!]).toEqual([137, 80, 0]);
      expect(await store.getAssetBytes(uuidv7())).toBeNull();
      expect((await store.readMirror(ws.id)).assets).toEqual([asset]);
      await store.close();
    });

    it('keeps preferences', async () => {
      const store = await factory();
      await store.setPref('toggles', { a: true });
      expect(await store.getPref('toggles')).toEqual({ a: true });
      expect(await store.getPref('missing')).toBeUndefined();
      await store.close();
    });
  });

  describe(`LocalStore conformance, sync (schema 2): ${name}`, () => {
    /** A seeded workspace made a synced one, with an empty outbox. */
    async function synced(store: LocalStore) {
      const tree = await seedTree(store);
      await store.beginUpload(tree.ws.id, ACCOUNT, []);
      return tree;
    }

    it('purges a trash root that lies inside another one', async () => {
      const store = await factory();
      const { ws, a, d } = await seedTree(store);
      await store.applyLocalOps([op('page.trash', ws.id, d.id, {}, 1)]);
      const trashedD = (await store.getPage(d.id))!;
      await store.applyLocalOps([op('page.trash', ws.id, a.id, {}, 1)]);
      expect((await store.getPage(d.id))?.trashRootId).toBe(trashedD.trashRootId);
      const gone = await store.purgeTrash(ws.id, '9999-01-01T00:00:00.000Z');
      expect(gone).toContain(d.id);
      expect(gone).toContain(a.id);
      expect(await store.getPage(d.id)).toBeNull();
      await store.close();
    });

    it('drops the favourite of a page the server deleted', async () => {
      const store = await factory();
      const { ws, a } = await synced(store);
      await store.applyRemote({
        workspaceId: ws.id,
        favourites: [{ workspaceId: ws.id, pageId: a.id, orderKey: 'a0' }],
      });
      await store.applyRemote({ workspaceId: ws.id, deletePages: [a.id] });
      expect((await store.readMirror(ws.id)).favourites).toEqual([]);
      await store.close();
    });

    it('reports schema version 2', async () => {
      const store = await factory();
      expect(await store.schemaVersion()).toBe(2);
      await store.close();
    });

    it("gives one workspace's outbox, oldest first", async () => {
      const store = await factory();
      const one = await seedTree(store);
      const two = await seedTree(store);
      const all = await store.nextOutboxBatch(100);
      const mine = await store.nextOutboxBatch(100, two.ws.id);
      expect(all.length).toBeGreaterThan(mine.length);
      expect(mine.every((o) => o.workspaceId === two.ws.id)).toBe(true);
      expect(mine.map((o) => o.opId)).toEqual(
        all.filter((o) => o.workspaceId === two.ws.id).map((o) => o.opId),
      );
      expect((await store.nextOutboxBatch(2, one.ws.id)).length).toBe(2);
      await store.close();
    });

    it('begins an upload: the outbox is replaced and the workspace syncs for an account', async () => {
      const store = await factory();
      const { ws, a } = await seedTree(store);
      const create = op('page.update', ws.id, a.id, { title: 'Upload' });
      await store.beginUpload(ws.id, ACCOUNT, [create]);
      expect((await store.nextOutboxBatch(100, ws.id)).map((o) => o.opId)).toEqual([create.opId]);
      const record = (await store.readMirror(ws.id)).workspaces[0];
      expect(record.localOnly).toBe(false);
      expect(record.accountId).toBe(ACCOUNT);
      await store.close();
    });

    it('an upload keeps operations written while it was prepared, after its creates', async () => {
      const store = await factory();
      const { ws, a, c } = await seedTree(store);
      const before = (await store.nextOutboxBatch(1000, ws.id)).map((o) => o.opId);
      // Written after the upload read the workspace: not in its creates.
      const later = op('page.update', ws.id, c.id, { title: 'Typed meanwhile' });
      await store.applyLocalOps([later]);
      const create = op('page.update', ws.id, a.id, { title: 'Upload' });
      await store.beginUpload(ws.id, ACCOUNT, [create], before);
      expect((await store.nextOutboxBatch(100, ws.id)).map((o) => o.opId)).toEqual([
        create.opId,
        later.opId,
      ]);
      await store.close();
    });

    it("settles operations and takes the server's entity, unless more wait for it", async () => {
      const store = await factory();
      const { ws, a, c } = await synced(store);
      const rename = op('page.update', ws.id, a.id, { title: 'Local' });
      const renameC = op('page.update', ws.id, c.id, { title: 'C local' });
      const renameCAgain = op('page.update', ws.id, c.id, { title: 'C again' });
      await store.applyLocalOps([rename, renameC, renameCAgain]);
      await store.settleOps([
        {
          opId: rename.opId,
          status: 'applied',
          entityType: 'page',
          entity: { ...a, title: 'Server', version: 7, access: 'edit' },
        },
        {
          opId: renameC.opId,
          status: 'applied',
          entityType: 'page',
          entity: { ...c, title: 'C server', version: 5 },
        },
      ]);
      const pages = new Map((await store.readMirror(ws.id)).pages.map((p) => [p.id, p]));
      expect(pages.get(a.id)?.title).toBe('Server');
      expect(pages.get(a.id)?.version).toBe(7);
      expect(pages.get(a.id)?.access).toBe('edit');
      // c still has an operation waiting: it keeps its local state.
      expect(pages.get(c.id)?.title).toBe('C again');
      expect((await store.nextOutboxBatch(100, ws.id)).map((o) => o.opId)).toEqual([
        renameCAgain.opId,
      ]);
      await store.close();
    });

    it('drops a record the server refused with no entity', async () => {
      const store = await factory();
      const { ws, section } = await synced(store);
      const page = pageRecord(ws.id, section.id, null, 'Refused', 'a5');
      const create = op('page.create', ws.id, page.id, page);
      await store.applyLocalOps([create]);
      await store.appendDocUpdates(page.id, [{ updateId: uuidv7(), data: bytes(1) }]);
      await store.settleOps([
        {
          opId: create.opId,
          status: 'rejected',
          error: { code: 'invalid' },
          entityType: 'page',
          entity: null,
        },
      ]);
      expect(await store.getPage(page.id)).toBeNull();
      expect((await store.loadDoc(page.id)).updates).toEqual([]);
      await store.close();
    });

    it('applies a remote batch: upserts, deletes, the cursor, and skips what waits locally', async () => {
      const store = await factory();
      const { ws, section, a, b, c } = await synced(store);
      const pending = op('page.update', ws.id, c.id, { title: 'Mine' });
      await store.applyLocalOps([pending]);
      await store.appendDocUpdates(b.id, [{ updateId: uuidv7(), data: bytes(5) }]);
      const fresh = pageRecord(ws.id, section.id, null, 'From another device', 'a9');
      await store.applyRemote({
        workspaceId: ws.id,
        cursor: 42,
        pages: [
          { ...a, title: 'Remote A', version: 3 },
          { ...c, title: 'Remote C', version: 4 },
          fresh,
        ],
        deletePages: [b.id],
        favourites: [{ workspaceId: ws.id, pageId: a.id, orderKey: 'a0' }],
      });
      const mirror = await store.readMirror(ws.id);
      const pages = new Map(mirror.pages.map((p) => [p.id, p]));
      expect(pages.get(a.id)?.title).toBe('Remote A');
      expect(pages.get(c.id)?.title).toBe('Mine');
      expect(pages.get(fresh.id)?.title).toBe('From another device');
      expect(pages.has(b.id)).toBe(false);
      expect((await store.loadDoc(b.id)).updates).toEqual([]);
      expect(mirror.favourites.map((f) => f.pageId)).toEqual([a.id]);
      expect(await store.syncCursor(ws.id)).toBe(42);
      expect(await store.syncCursor(uuidv7())).toBeNull();
      await store.applyRemote({ workspaceId: ws.id, deleteFavourites: [a.id] });
      expect((await store.readMirror(ws.id)).favourites).toEqual([]);
      expect(await store.syncCursor(ws.id)).toBe(42);
      await store.close();
    });

    it('replaces the whole tree, or one subtree, with what the server sent', async () => {
      const store = await factory();
      const { ws, section, a, c, d } = await synced(store);
      // A subtree under a: b and d are not sent, so they go; c is outside it and stays.
      await store.applyRemote({ workspaceId: ws.id, pages: [a], replace: { root: a.id } });
      let ids = (await store.readMirror(ws.id)).pages.map((p) => p.id).sort();
      expect(ids).toEqual([a.id, c.id].sort());
      // The whole tree: only c, and the section, are left; a page waiting in the outbox stays.
      const local = pageRecord(ws.id, section.id, null, 'Not pushed', 'b0');
      await store.applyLocalOps([op('page.create', ws.id, local.id, local)]);
      await store.applyRemote({
        workspaceId: ws.id,
        sections: [section],
        pages: [c],
        replace: { root: null },
        cursor: 7,
      });
      ids = (await store.readMirror(ws.id)).pages.map((p) => p.id).sort();
      expect(ids).toEqual([c.id, local.id].sort());
      expect((await store.readMirror(ws.id)).sections.map((s) => s.id)).toEqual([section.id]);
      expect(d).toBeTruthy();
      await store.close();
    });

    it('removes a workspace the account lost, with all it holds', async () => {
      const store = await factory();
      const { ws, a } = await synced(store);
      await store.appendDocUpdates(a.id, [{ updateId: uuidv7(), data: bytes(1) }]);
      await store.applyLocalOps([op('page.update', ws.id, a.id, { title: 'x' })]);
      await store.applyRemote({ workspaceId: ws.id, deleteWorkspace: true });
      const mirror = await store.readMirror(ws.id);
      expect(mirror.workspaces).toEqual([]);
      expect(mirror.pages).toEqual([]);
      expect(await store.nextOutboxBatch(100, ws.id)).toEqual([]);
      expect((await store.loadDoc(a.id)).updates).toEqual([]);
      await store.close();
    });

    it('lists unsent updates of synced workspaces only, and acknowledges them', async () => {
      const store = await factory();
      const local = await seedTree(store);
      const { a, b } = await synced(store);
      await store.appendDocUpdates(local.a.id, [{ updateId: uuidv7(), data: bytes(9) }]);
      const [u1, u2] = [uuidv7(), uuidv7()];
      await store.appendDocUpdates(a.id, [
        { updateId: u1, data: bytes(1) },
        { updateId: u2, data: bytes(2) },
      ]);
      await store.appendDocUpdates(b.id, [{ updateId: uuidv7(), data: bytes(3) }]);
      const unsent = await store.unsentDocUpdates(100);
      expect(unsent.map((d) => d.pageId).sort()).toEqual([a.id, b.id].sort());
      expect(unsent.find((d) => d.pageId === a.id)!.updates.map((u) => [...u.data])).toEqual([
        [1],
        [2],
      ]);
      expect((await store.unsentDocUpdates(1)).flatMap((d) => d.updates).length).toBe(1);
      await store.ackDocUpdates(a.id, [{ updateId: u1, seq: 11 }]);
      const after = await store.unsentDocUpdates(100);
      expect(after.find((d) => d.pageId === a.id)!.updates.map((u) => u.updateId)).toEqual([u2]);
      expect((await store.loadDoc(a.id)).updates.find((u) => u.updateId === u1)?.seq).toBe(11);
      await store.close();
    });

    it('stores pulled updates once, acknowledges its own, and moves the page cursor', async () => {
      const store = await factory();
      const { ws, a, c } = await synced(store);
      const mine = uuidv7();
      await store.appendDocUpdates(a.id, [{ updateId: mine, data: bytes(1) }]);
      const added = await store.applyRemoteDocUpdates(a.id, {
        epoch: 0,
        headSeq: 3,
        updates: [
          { seq: 1, updateId: mine, data: bytes(1) },
          { seq: 2, updateId: uuidv7(), data: bytes(2) },
          { seq: 3, data: bytes(3) },
        ],
      });
      expect(added.map((u) => [u.seq, [...u.data]])).toEqual([
        [2, [2]],
        [3, [3]],
      ]);
      expect(await store.unsentDocUpdates(100)).toEqual([]);
      // The same pull again adds nothing.
      expect(
        await store.applyRemoteDocUpdates(a.id, {
          epoch: 0,
          headSeq: 3,
          updates: [{ seq: 3, data: bytes(3) }],
        }),
      ).toEqual([]);
      expect(await store.docCursor(a.id)).toEqual({ headSeq: 3, epoch: 0 });
      expect(await store.docCursor(c.id)).toBeNull();
      expect(await store.docCursors(ws.id)).toEqual({ [a.id]: { headSeq: 3, epoch: 0 } });
      expect((await store.loadDoc(a.id)).updates.map((u) => u.seq)).toEqual([1, 2, 3]);
      await store.close();
    });

    it('keeps unsent updates of a synced page when it compacts', async () => {
      const store = await factory();
      const local = await seedTree(store);
      const { a } = await synced(store);
      const seqs = await store.appendDocUpdates(
        a.id,
        [1, 2, 3].map((v) => ({ updateId: uuidv7(), data: bytes(v) })),
      );
      await store.ackDocUpdates(a.id, [
        { updateId: (await store.loadDoc(a.id)).updates[0].updateId, seq: 1 },
      ]);
      await store.compactDoc(a.id, bytes(9), seqs[2]);
      expect((await store.loadDoc(a.id)).updates.map((u) => u.data[0])).toEqual([2, 3]);
      // A local-only page drops what the snapshot covers, as in schema 1.
      const localSeqs = await store.appendDocUpdates(
        local.a.id,
        [1, 2].map((v) => ({ updateId: uuidv7(), data: bytes(v) })),
      );
      await store.compactDoc(local.a.id, bytes(9), localSeqs[1]);
      expect((await store.loadDoc(local.a.id)).updates).toEqual([]);
      await store.close();
    });

    it("replaces a page's log with one unsent update and forgets its cursor", async () => {
      const store = await factory();
      const { a } = await synced(store);
      await store.applyRemoteDocUpdates(a.id, {
        epoch: 0,
        headSeq: 2,
        updates: [{ seq: 2, data: bytes(2) }],
      });
      await store.compactDoc(a.id, bytes(8), 1);
      const id = uuidv7();
      await store.replaceDoc(a.id, { updateId: id, data: bytes(7, 7) });
      const loaded = await store.loadDoc(a.id);
      expect(loaded.snapshot).toBeNull();
      expect(loaded.updates.map((u) => [u.updateId, u.seq, [...u.data]])).toEqual([
        [id, null, [7, 7]],
      ]);
      expect(await store.docCursor(a.id)).toBeNull();
      await store.close();
    });

    it('replaces only what was merged: later updates stay, after the merged one', async () => {
      const store = await factory();
      const { a } = await seedTree(store);
      await store.appendDocUpdates(a.id, [
        { updateId: uuidv7(), data: bytes(1) },
        { updateId: uuidv7(), data: bytes(2) },
      ]);
      const merged = await store.loadDoc(a.id);
      const upTo = Math.max(merged.snapshotCovers, ...merged.updates.map((u) => u.localSeq));
      // Typed while the upload merged the log.
      const typed = uuidv7();
      await store.appendDocUpdates(a.id, [{ updateId: typed, data: bytes(3) }]);
      const id = uuidv7();
      await store.replaceDoc(a.id, { updateId: id, data: bytes(1, 2) }, upTo);
      const loaded = await store.loadDoc(a.id);
      expect(loaded.updates.map((u) => [u.updateId, u.seq, [...u.data]])).toEqual([
        [id, null, [1, 2]],
        [typed, null, [3]],
      ]);
      // And the next append still comes after them.
      const next = await store.appendDocUpdates(a.id, [{ updateId: uuidv7(), data: bytes(4) }]);
      expect(next[0]).toBeGreaterThan(loaded.updates[1].localSeq);
      await store.close();
    });

    it('refuses to replace what a compaction has covered since', async () => {
      const store = await factory();
      const { a } = await seedTree(store);
      const appended = await store.appendDocUpdates(a.id, [
        { updateId: uuidv7(), data: bytes(1) },
        { updateId: uuidv7(), data: bytes(2) },
      ]);
      await store.compactDoc(a.id, bytes(9), appended[1]);
      await expect(
        store.replaceDoc(a.id, { updateId: uuidv7(), data: bytes(1) }, appended[0]),
      ).rejects.toThrow();
      expect((await store.loadDoc(a.id)).snapshot).not.toBeNull();
      await store.close();
    });

    it('lists assets to upload in synced workspaces and marks them uploaded', async () => {
      const store = await factory();
      const local = await seedTree(store);
      const { ws } = await synced(store);
      const asset = (workspaceId: Id) => ({
        id: uuidv7(),
        workspaceId,
        fileName: 'a.png',
        contentType: 'image/png',
        sizeBytes: 1,
        sha256: 'x',
        width: null,
        height: null,
        createdAt: at(),
      });
      const mine = asset(ws.id);
      await store.putAsset(mine, bytes(1));
      await store.putAsset(asset(local.ws.id), bytes(2));
      await store.putAsset({ ...asset(ws.id), uploaded: true }, bytes(3));
      expect((await store.pendingAssets(10)).map((a) => a.id)).toEqual([mine.id]);
      await store.markAssetUploaded(mine.id);
      expect(await store.pendingAssets(10)).toEqual([]);
      expect((await store.readMirror(ws.id)).assets.find((a) => a.id === mine.id)?.uploaded).toBe(
        true,
      );
      await store.close();
    });
  });
}

/** The account a synced workspace in these tests belongs to. */
const ACCOUNT = '0193a1b2-c3d4-7e5f-8a9b-000000000001';
