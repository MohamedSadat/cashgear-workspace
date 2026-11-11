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
}
