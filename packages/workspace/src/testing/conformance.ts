// The LocalStore conformance suite (SYNC_DESIGN.md, "Tests that guard this design"): the same
// cases run against every store, so the browser's IndexedDB store and the desktop's SQLite store
// behave the same. Call it from a test file with a factory that returns an empty store.
import { describe, expect, it } from 'vitest';
import type { DatabaseRecord, PropertyDef, Value, ViewRecord } from '../db/types';
import { isId, uuidv7, type Id } from '../ids';
import { keyBetween } from '../order';
import { uploadOps } from '../remote';
import { normaliseText } from '../search';
import {
  STORE_SCHEMA_VERSION,
  type DbHold,
  type LocalStore,
  type Operation,
  type PageCreate,
  type PageRecord,
  type PinRecord,
  type RowRecord,
  type SectionRecord,
  type WorkspaceRecord,
} from '../types';

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

/** `seedTree` made a synced workspace, with an empty outbox. */
export async function syncedTree(store: LocalStore) {
  const tree = await seedTree(store);
  await store.beginUpload(tree.ws.id, ACCOUNT, []);
  return tree;
}

// Databases (store schema 4) -------------------------------------------------------------------

/** Property ids the database cases use (8 characters of base 62). */
export const P = {
  text: 'Text0001',
  number: 'Numb0001',
  done: 'Done0001',
  status: 'Stag0001',
  relation: 'Rela0001',
  back: 'Back0001',
  self: 'Self0001',
  selfBack: 'Self0002',
  formula: 'Form0001',
} as const;

export const OPTION_OPEN = 'Open0001';

/** A database's first properties, as `page.create` carries them (the title is added). */
export const DB_PROPS: PropertyDef[] = [
  { id: P.text, name: 'Notes', type: 'text' },
  { id: P.number, name: 'Count', type: 'number', number: { format: 'number', decimals: null } },
  { id: P.done, name: 'Done', type: 'checkbox' },
  {
    id: P.status,
    name: 'Stage',
    type: 'select',
    options: [
      { id: OPTION_OPEN, name: 'Open', colour: 'blue' },
      { id: 'Shut0001', name: 'Closed', colour: 'green' },
    ],
  },
];

export function databasePage(
  workspaceId: Id,
  sectionId: Id,
  parentPageId: Id | null,
  title: string,
  orderKey = 'a5',
): PageRecord {
  return { ...pageRecord(workspaceId, sectionId, parentPageId, title, orderKey), kind: 'database' };
}

export function viewRecord(
  workspaceId: Id,
  databaseId: Id,
  name = 'Table',
  orderKey = 'a0',
): ViewRecord {
  return {
    id: uuidv7(),
    workspaceId,
    databaseId,
    name,
    type: 'table',
    orderKey,
    config: {
      filter: null,
      sorts: [],
      group: null,
      properties: { order: [], hidden: [], widths: {} },
    },
    version: 1,
    createdAt: at(),
  };
}

/** A row as `page.create` makes one, with its first values. */
export function rowCreate(
  workspaceId: Id,
  sectionId: Id,
  databaseId: Id | null,
  title: string,
  values: Record<string, Value> = {},
  orderKey = 'a0',
): PageCreate {
  return {
    ...pageRecord(workspaceId, sectionId, databaseId, title, orderKey),
    kind: 'row',
    row: { values },
  };
}

/** A row as the server sends one. */
export function rowRecord(
  workspaceId: Id,
  sectionId: Id,
  databaseId: Id,
  title: string,
  values: Record<string, Value> = {},
  orderKey = 'a0',
): RowRecord {
  return {
    ...pageRecord(workspaceId, sectionId, databaseId, title, orderKey),
    kind: 'row',
    databaseId,
    values,
    versions: {},
    computed: {},
    computedVersion: null,
    createdBy: null,
    updatedBy: null,
  };
}

/** `seedTree` (or `syncedTree`) with a database under A: its first view and two rows. */
export async function seedDatabase(store: LocalStore, synced = false) {
  const tree = synced ? await syncedTree(store) : await seedTree(store);
  const { ws, section, a } = tree;
  const db = databasePage(ws.id, section.id, a.id, 'Tasks');
  const view = viewRecord(ws.id, db.id);
  const r1 = rowCreate(ws.id, section.id, db.id, 'One', { [P.text]: 'first', [P.number]: 1 }, 'a0');
  const r2 = rowCreate(
    ws.id,
    section.id,
    db.id,
    'Two',
    { [P.number]: 2, [P.status]: OPTION_OPEN },
    'a1',
  );
  await store.applyLocalOps([
    op('page.create', ws.id, db.id, { ...db, database: { properties: DB_PROPS } }),
    op('view.upsert', ws.id, view.id, view),
    op('page.create', ws.id, r1.id, r1),
    op('page.create', ws.id, r2.id, r2),
  ]);
  return { ...tree, db, view, r1, r2 };
}

/** Every operation of the workspace answered as applied, with no entity. */
export async function settleAll(store: LocalStore, workspaceId: Id) {
  await store.settleOps(
    (await store.nextOutboxBatch(10_000, workspaceId)).map((o) => ({
      opId: o.opId,
      status: 'applied' as const,
    })),
  );
}

const bytes = (...values: number[]) => new Uint8Array(values);
const plain = (parts: Uint8Array[]) => parts.map((p) => [...p]);
const byPage = (a: { pageId: Id }, b: { pageId: Id }) => (a.pageId < b.pageId ? -1 : 1);

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

    it('goes on loading the rest of a log whose undecodable updates were moved aside', async () => {
      const store = await factory();
      const page = uuidv7();
      const seqs = await store.appendDocUpdates(
        page,
        [1, 2, 3, 4].map((v) => ({ updateId: uuidv7(), data: bytes(v) })),
      );
      // The first and the last fail to decode; moving one twice, or one never held, is harmless.
      await store.quarantineUpdates(page, [seqs[0], seqs[3]], 'doc.undecodable');
      await store.quarantineUpdates(page, [seqs[0], 999], 'doc.undecodable');
      let loaded = await store.loadDoc(page);
      expect(loaded.updates.map((u) => [u.localSeq, [...u.data]])).toEqual([
        [seqs[1], [2]],
        [seqs[2], [3]],
      ]);
      // The log goes on after them: a moved update's sequence is never given again.
      const [next] = await store.appendDocUpdates(page, [{ updateId: uuidv7(), data: bytes(5) }]);
      expect(next).toBe(seqs[3] + 1);
      await store.compactDoc(page, bytes(9), seqs[2]);
      loaded = await store.loadDoc(page);
      expect([...loaded.snapshot!]).toEqual([9]);
      expect(loaded.updates.map((u) => [...u.data])).toEqual([[5]]);
      expect(await store.docLogLength(page)).toBe(1);
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
    const synced = syncedTree;

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

    it('reports schema version 4', async () => {
      const store = await factory();
      expect(STORE_SCHEMA_VERSION).toBe(4);
      expect(await store.schemaVersion()).toBe(4);
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

  describe(`LocalStore conformance, offline (schema 3): ${name}`, () => {
    const synced = syncedTree;
    const pinOf = (workspaceId: Id, pageId: Id, subtree: boolean): PinRecord => ({
      workspaceId,
      pageId,
      subtree,
      pinnedAt: at(),
    });
    /** Appends unsent updates, one byte each; returns their ids. */
    const append = async (store: LocalStore, pageId: Id, ...values: number[]) => {
      const updates = values.map((v) => ({ updateId: uuidv7(), data: bytes(v) }));
      await store.appendDocUpdates(pageId, updates);
      return updates.map((u) => u.updateId);
    };
    /** Appends updates the server has acknowledged, at sequences from `seq`. */
    const appendSent = async (store: LocalStore, pageId: Id, seq: number, ...values: number[]) => {
      const ids = await append(store, pageId, ...values);
      await store.ackDocUpdates(
        pageId,
        ids.map((updateId, i) => ({ updateId, seq: seq + i })),
      );
      return ids;
    };

    it('pins pages: an upsert by page, listed by workspace, gone when unpinned', async () => {
      const store = await factory();
      const one = await synced(store);
      const two = await synced(store);
      const c = pinOf(one.ws.id, one.c.id, true);
      const other = pinOf(two.ws.id, two.a.id, false);
      await store.pin(pinOf(one.ws.id, one.a.id, false));
      await store.pin(c);
      await store.pin(other);
      // Pinning again replaces the pin: here, the page now keeps its subtree too.
      const a = pinOf(one.ws.id, one.a.id, true);
      await store.pin(a);
      expect(await store.pins(one.ws.id)).toEqual([a, c].sort(byPage));
      expect(await store.pins(two.ws.id)).toEqual([other]);
      expect(await store.pins(uuidv7())).toEqual([]);
      await store.unpin(one.a.id);
      await store.unpin(uuidv7());
      expect(await store.pins(one.ws.id)).toEqual([c]);
      await store.close();
    });

    it('keeps the last repair state of a page', async () => {
      const store = await factory();
      const { a, c } = await synced(store);
      expect(await store.repairState(a.id)).toBeNull();
      const first = { pageId: a.id, epoch: 1, checkedSeq: 5, at: at(), repairs: 0 };
      await store.setRepairState(first);
      expect(await store.repairState(a.id)).toEqual(first);
      const second = { ...first, checkedSeq: 9, repairs: 1, at: at() };
      await store.setRepairState(second);
      expect(await store.repairState(a.id)).toEqual(second);
      expect(await store.repairState(c.id)).toBeNull();
      await store.close();
    });

    it("drops a page's pin and repair state with the page, however it goes", async () => {
      const store = await factory();
      const { ws, a, b, c, d } = await synced(store);
      const lost = await synced(store);
      for (const page of [a, b, c, d]) {
        await store.pin(pinOf(ws.id, page.id, page.id === a.id));
        await store.setRepairState({
          pageId: page.id,
          epoch: 0,
          checkedSeq: 1,
          at: at(),
          repairs: 0,
        });
      }
      await store.pin(pinOf(lost.ws.id, lost.a.id, true));
      await store.setRepairState({
        pageId: lost.a.id,
        epoch: 0,
        checkedSeq: 1,
        at: at(),
        repairs: 0,
      });
      // The user deletes a (and with it b and d) for good.
      await store.applyLocalOps([op('page.trash', ws.id, a.id, {}, 1)]);
      await store.applyLocalOps([op('page.delete', ws.id, a.id, {})]);
      expect((await store.pins(ws.id)).map((p) => p.pageId)).toEqual([c.id]);
      for (const page of [a, b, d]) expect(await store.repairState(page.id)).toBeNull();
      expect(await store.repairState(c.id)).not.toBeNull();
      // The server deletes c.
      await store.applyRemote({ workspaceId: ws.id, deletePages: [c.id] });
      expect(await store.pins(ws.id)).toEqual([]);
      expect(await store.repairState(c.id)).toBeNull();
      // The account loses a workspace.
      await store.applyRemote({ workspaceId: lost.ws.id, deleteWorkspace: true });
      expect(await store.pins(lost.ws.id)).toEqual([]);
      expect(await store.repairState(lost.a.id)).toBeNull();
      await store.close();
    });

    it('lists the pages whose document it holds: a log, a snapshot, or only a cursor', async () => {
      const store = await factory();
      const { ws, a, b, c, d } = await synced(store);
      const other = await seedTree(store);
      await append(store, a.id, 1);
      // b keeps only a snapshot: what it covers was on the server.
      await appendSent(store, b.id, 1, 2);
      await store.compactDoc(b.id, bytes(9), 1);
      expect((await store.loadDoc(b.id)).updates).toEqual([]);
      // c was pulled while the server held nothing yet.
      await store.applyRemoteDocUpdates(c.id, { epoch: 0, headSeq: 0, updates: [] });
      // d's only update failed to decode: its log is empty.
      await append(store, d.id, 4);
      await store.quarantineUpdates(d.id, [1], 'doc.undecodable');
      await append(store, other.a.id, 5);
      expect(await store.heldPages(ws.id)).toEqual([a.id, b.id, c.id].sort());
      expect(await store.heldPages(other.ws.id)).toEqual([other.a.id]);
      expect(await store.heldPages(uuidv7())).toEqual([]);
      await store.close();
    });

    it('measures what a workspace takes up on this device', async () => {
      const store = await factory();
      const { ws, a, b, c } = await synced(store);
      const other = await seedTree(store);
      await store.appendDocUpdates(a.id, [
        { updateId: uuidv7(), data: bytes(1, 2, 3) },
        { updateId: uuidv7(), data: bytes(4) },
      ]);
      await appendSent(store, b.id, 1, 5, 6);
      await store.compactDoc(b.id, bytes(7, 7, 7), 2);
      await store.appendDocUpdates(c.id, [{ updateId: uuidv7(), data: bytes(8, 8) }]);
      expect(await store.setAsideDoc(c.id, 'doc.epochMismatch')).not.toBeNull();
      await store.addHistory(a.id, bytes(1, 2, 3, 4, 5, 6), 5);
      const asset = (workspaceId: Id, sizeBytes: number) => ({
        id: uuidv7(),
        workspaceId,
        fileName: 'a.png',
        contentType: 'image/png',
        sizeBytes,
        sha256: 'x',
        width: null,
        height: null,
        createdAt: at(),
      });
      await store.putAsset(asset(ws.id, 10), new Uint8Array(10));
      // Another workspace's take up nothing of this one's.
      await store.putAsset(asset(other.ws.id, 3), new Uint8Array(3));
      await append(store, other.a.id, 1, 2);
      await store.addHistory(other.a.id, bytes(1), 5);
      expect(await store.storageUsage(ws.id)).toEqual({
        pages: 2,
        docBytes: 4 + 3,
        assetBytes: 10,
        historyBytes: 6,
        quarantineBytes: 2,
      });
      expect(await store.storageUsage(uuidv7())).toEqual({
        pages: 0,
        docBytes: 0,
        assetBytes: 0,
        historyBytes: 0,
        quarantineBytes: 0,
      });
      await store.close();
    });

    it("sets a page's log aside: its snapshot, then every update in order; the unsent ones leave the log", async () => {
      const store = await factory();
      const { ws, a } = await synced(store);
      await appendSent(store, a.id, 1, 1, 2);
      await store.compactDoc(a.id, bytes(9, 9), 1);
      await store.appendDocUpdates(a.id, [
        { updateId: uuidv7(), data: bytes(3) },
        { updateId: uuidv7(), data: bytes(4, 4) },
      ]);
      // Then one from another device.
      await store.applyRemoteDocUpdates(a.id, {
        epoch: 0,
        headSeq: 3,
        updates: [{ seq: 3, data: bytes(5) }],
      });
      const entry = (await store.setAsideDoc(a.id, 'doc.epochMismatch'))!;
      expect(entry).toMatchObject({
        workspaceId: ws.id,
        pageId: a.id,
        title: 'Alpha',
        reason: 'doc.epochMismatch',
        status: 'pending',
        recoveredPageId: null,
      });
      expect(isId(entry.id)).toBe(true);
      expect(new Date(entry.at).toISOString()).toBe(entry.at);
      expect(plain(entry.parts)).toEqual([[9, 9], [2], [3], [4, 4], [5]]);
      // The acknowledged updates, the snapshot and the cursor stay; nothing is left to push.
      const doc = await store.loadDoc(a.id);
      expect([...doc.snapshot!]).toEqual([9, 9]);
      expect(doc.updates.map((u) => [u.seq, [...u.data]])).toEqual([
        [2, [2]],
        [3, [5]],
      ]);
      expect(await store.unsentDocUpdates(10)).toEqual([]);
      expect(await store.docCursor(a.id)).toEqual({ headSeq: 3, epoch: 0 });
      expect(await store.quarantine(ws.id)).toEqual([entry]);
      // The log goes on.
      const [next] = await store.appendDocUpdates(a.id, [{ updateId: uuidv7(), data: bytes(6) }]);
      expect(next).toBeGreaterThan(Math.max(...doc.updates.map((u) => u.localSeq)));
      await store.close();
    });

    it('sets nothing aside, and changes nothing, when nothing is unsent', async () => {
      const store = await factory();
      const { a, c } = await synced(store);
      await appendSent(store, a.id, 1, 1);
      const before = await store.loadDoc(a.id);
      expect(await store.setAsideDoc(a.id, 'page.gone')).toBeNull();
      expect(await store.setAsideDoc(c.id, 'page.gone')).toBeNull();
      expect(await store.setAsideDoc(uuidv7(), 'page.gone')).toBeNull();
      expect(await store.loadDoc(a.id)).toEqual(before);
      expect(await store.quarantine(null)).toEqual([]);
      await store.close();
    });

    it('sets aside a page the server deletes while it holds unsent updates, then lets it go', async () => {
      const store = await factory();
      const { ws, b, c } = await synced(store);
      await appendSent(store, b.id, 1, 1);
      await append(store, b.id, 2);
      // c holds only what the server has: it goes with nothing set aside.
      await appendSent(store, c.id, 1, 3);
      await store.applyRemote({ workspaceId: ws.id, deletePages: [b.id, c.id] });
      const entries = await store.quarantine(ws.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        workspaceId: ws.id,
        pageId: b.id,
        title: 'Beta',
        reason: 'page.removed',
        status: 'pending',
        recoveredPageId: null,
      });
      expect(plain(entries[0].parts)).toEqual([[1], [2]]);
      expect(await store.getPage(b.id)).toBeNull();
      expect((await store.loadDoc(b.id)).updates).toEqual([]);
      expect(await store.unsentDocUpdates(10)).toEqual([]);
      await store.close();
    });

    it('sets aside the pages a replaced tree or subtree drops, under the title they had', async () => {
      const store = await factory();
      const { ws, section, a, c, d } = await synced(store);
      await append(store, d.id, 4);
      await append(store, c.id, 3);
      await store.applyRemote({
        workspaceId: ws.id,
        pages: [{ ...d, title: 'Delta 2', version: 2 }],
      });
      // A subtree under a without b (and so without d).
      await store.applyRemote({ workspaceId: ws.id, pages: [a], replace: { root: a.id } });
      // The whole tree, without c.
      await store.applyRemote({
        workspaceId: ws.id,
        sections: [section],
        pages: [a],
        replace: { root: null },
      });
      expect(
        (await store.quarantine(ws.id)).map((e) => [e.pageId, e.title, e.reason, plain(e.parts)]),
      ).toEqual([
        [c.id, 'Gamma', 'page.removed', [[3]]],
        [d.id, 'Delta 2', 'page.removed', [[4]]],
      ]);
      await store.close();
    });

    it('sets aside a page whose create the server refused, with no entity, in the same answer', async () => {
      const store = await factory();
      const { ws, section } = await synced(store);
      const page = pageRecord(ws.id, section.id, null, 'Refused', 'a5');
      const create = op('page.create', ws.id, page.id, page);
      await store.applyLocalOps([create]);
      await append(store, page.id, 7);
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
      const entries = await store.quarantine(ws.id);
      expect(entries.map((e) => [e.pageId, e.title, e.reason, plain(e.parts)])).toEqual([
        [page.id, 'Refused', 'page.removed', [[7]]],
      ]);
      expect(await store.nextOutboxBatch(10, ws.id)).toEqual([]);
      await store.close();
    });

    it('sets aside the pages of a workspace the account lost; the entries outlive it', async () => {
      const store = await factory();
      const { ws, a, b, c } = await synced(store);
      await append(store, a.id, 1);
      await append(store, c.id, 3);
      await appendSent(store, b.id, 1, 2);
      await store.applyRemote({ workspaceId: ws.id, deleteWorkspace: true });
      expect((await store.readMirror(ws.id)).workspaces).toEqual([]);
      const entries = await store.quarantine(ws.id);
      expect(entries.map((e) => [e.pageId, e.workspaceId, e.reason]).sort()).toEqual(
        [
          [a.id, ws.id, 'page.removed'],
          [c.id, ws.id, 'page.removed'],
        ].sort(),
      );
      expect(await store.quarantine(null)).toEqual(entries);
      expect((await store.storageUsage(ws.id)).quarantineBytes).toBe(2);
      await store.close();
    });

    it('sets nothing aside when the user deletes a page, or the trash is purged', async () => {
      const store = await factory();
      const { ws, a, c } = await synced(store);
      await append(store, a.id, 1);
      await append(store, c.id, 3);
      await store.applyLocalOps([op('page.trash', ws.id, a.id, {}, 1)]);
      await store.applyLocalOps([op('page.delete', ws.id, a.id, {})]);
      await store.applyLocalOps([op('page.trash', ws.id, c.id, {}, 1)]);
      expect(await store.purgeTrash(ws.id, '9999-01-01T00:00:00.000Z')).toContain(c.id);
      expect(await store.getPage(a.id)).toBeNull();
      expect(await store.getPage(c.id)).toBeNull();
      expect(await store.quarantine(null)).toEqual([]);
      await store.close();
    });

    it('lists set-aside entries newest first, of one workspace or of all, outliving their page', async () => {
      const store = await factory();
      const one = await synced(store);
      const two = await synced(store);
      await append(store, one.a.id, 1);
      await append(store, two.a.id, 2);
      await append(store, one.c.id, 3);
      const first = (await store.setAsideDoc(one.a.id, 'doc.epochMismatch'))!;
      const second = (await store.setAsideDoc(two.a.id, 'access.denied'))!;
      const third = (await store.setAsideDoc(one.c.id, 'page.gone'))!;
      expect((await store.quarantine(one.ws.id)).map((e) => e.id)).toEqual([third.id, first.id]);
      expect(await store.quarantine(two.ws.id)).toEqual([second]);
      expect((await store.quarantine(null)).map((e) => e.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
      expect(await store.quarantine(uuidv7())).toEqual([]);
      // The user deletes c for good: what was set aside from it stays.
      await store.applyLocalOps([op('page.trash', one.ws.id, one.c.id, {}, 1)]);
      await store.applyLocalOps([op('page.delete', one.ws.id, one.c.id, {})]);
      expect(await store.getPage(one.c.id)).toBeNull();
      expect((await store.quarantine(one.ws.id))[0]).toEqual(third);
      await store.close();
    });

    it('settles an entry as recovered, with its page, or dismissed', async () => {
      const store = await factory();
      const { ws, a, c } = await synced(store);
      await append(store, a.id, 1);
      await append(store, c.id, 3);
      const recovered = (await store.setAsideDoc(a.id, 'page.gone'))!;
      const dismissed = (await store.setAsideDoc(c.id, 'access.denied'))!;
      const made = uuidv7();
      await store.settleQuarantine(recovered.id, 'recovered', made);
      await store.settleQuarantine(dismissed.id, 'dismissed');
      await store.settleQuarantine(uuidv7(), 'dismissed');
      let byId = new Map((await store.quarantine(ws.id)).map((e) => [e.id, e]));
      expect(byId.get(recovered.id)).toEqual({
        ...recovered,
        status: 'recovered',
        recoveredPageId: made,
      });
      expect(byId.get(dismissed.id)).toEqual({ ...dismissed, status: 'dismissed' });
      // Dismissed later, it still names the page made from it.
      await store.settleQuarantine(recovered.id, 'dismissed');
      byId = new Map((await store.quarantine(ws.id)).map((e) => [e.id, e]));
      expect(byId.get(recovered.id)).toMatchObject({ status: 'dismissed', recoveredPageId: made });
      await store.close();
    });
  });

  describe(`LocalStore conformance, databases (schema 4): ${name}`, () => {
    const sorted = (ids: Id[]) => [...ids].sort();
    const rowIds = async (store: LocalStore, databaseId: Id) =>
      sorted((await store.readRows(databaseId)).map((r) => r.id));
    const row = async (store: LocalStore, id: Id) => (await store.getPage(id)) as RowRecord | null;
    const dbOf = async (store: LocalStore, ws: Id, id: Id) =>
      (await store.readMirror(ws)).databases.find((d) => d.id === id);
    const update = (ws: Id, id: Id, values: Record<string, Value | null>) =>
      op('row.update', ws, id, { values });

    it('makes a database page with its record, a title property and a full hold; rows stay out of the tree', async () => {
      const store = await factory();
      const { ws, a, db, view, r1, r2 } = await seedDatabase(store);
      const mirror = await store.readMirror(ws.id);
      expect(mirror.pages.find((p) => p.id === db.id)).toMatchObject({
        kind: 'database',
        parentPageId: a.id,
        version: 1,
      });
      expect(mirror.pages.some((p) => p.kind === 'row')).toBe(false);
      expect(mirror.databases).toHaveLength(1);
      const record = mirror.databases[0];
      expect(record).toMatchObject({ id: db.id, workspaceId: ws.id, version: 1, rowCount: 2 });
      expect(record.properties.map((p) => p.id)).toEqual(['title', ...DB_PROPS.map((p) => p.id)]);
      expect(record.properties[0].type).toBe('title');
      expect(mirror.views).toEqual([{ ...view, version: 1 }]);
      expect(await row(store, r1.id)).toMatchObject({
        id: r1.id,
        kind: 'row',
        databaseId: db.id,
        parentPageId: db.id,
        title: 'One',
        values: { [P.text]: 'first', [P.number]: 1 },
        versions: {},
        computed: {},
        computedVersion: null,
        version: 1,
        trashedAt: null,
      });
      expect(await rowIds(store, db.id)).toEqual(sorted([r1.id, r2.id]));
      const hold = await store.dbHold(db.id);
      expect(hold).toMatchObject({
        databaseId: db.id,
        workspaceId: ws.id,
        mode: 'full',
        complete: true,
        after: null,
      });
      expect(await store.dbHolds(ws.id)).toEqual([hold]);
      expect(await store.dbHold(uuidv7())).toBeNull();
      expect((await store.nextOutboxBatch(100, ws.id)).slice(-4).map((o) => o.type)).toEqual([
        'page.create',
        'view.upsert',
        'page.create',
        'page.create',
      ]);
      await store.close();
    });

    it('keeps rows in their database and nothing but rows under a database', async () => {
      const store = await factory();
      const { ws, section, a, c, db, r1, r2 } = await seedDatabase(store);
      const refused = async (operation: Operation, code: string) =>
        expect(store.applyLocalOp(operation)).rejects.toMatchObject({ code });
      const under = pageRecord(ws.id, section.id, db.id, 'Under a database');
      await refused(op('page.create', ws.id, under.id, under), 'invalid');
      const underRow = pageRecord(ws.id, section.id, r1.id, 'Under a row');
      await refused(op('page.create', ws.id, underRow.id, underRow), 'invalid');
      const inner = databasePage(ws.id, section.id, db.id, 'Inner');
      await refused(
        op('page.create', ws.id, inner.id, { ...inner, database: { properties: [] } }),
        'invalid',
      );
      const stray = rowCreate(ws.id, section.id, a.id, 'Stray');
      await refused(op('page.create', ws.id, stray.id, stray), 'invalid');
      const top = rowCreate(ws.id, section.id, null, 'Top');
      await refused(op('page.create', ws.id, top.id, top), 'invalid');
      const move = (id: Id, parentPageId: Id | null, orderKey = 'a0') =>
        op('page.move', ws.id, id, { sectionId: section.id, parentPageId, orderKey });
      await refused(move(c.id, db.id), 'invalid');
      await refused(move(c.id, r1.id), 'invalid');
      await refused(move(r1.id, a.id), 'invalid');
      await refused(move(r1.id, null), 'invalid');
      // A row's move reorders it among its database's rows.
      await store.applyLocalOp(move(r1.id, db.id, 'a2'));
      expect(await row(store, r1.id)).toMatchObject({
        orderKey: 'a2',
        parentPageId: db.id,
        version: 2,
      });
      expect(await rowIds(store, db.id)).toEqual(sorted([r1.id, r2.id]));
      // A database page itself moves as any page does.
      await store.applyLocalOp(move(db.id, c.id));
      expect((await store.getPage(db.id))!.parentPageId).toBe(c.id);
      await store.close();
    });

    it('writes row values merged per property, coerced to their types; null clears one', async () => {
      const store = await factory();
      const { ws, r1 } = await seedDatabase(store);
      const before = (await row(store, r1.id))!;
      await store.applyLocalOp(update(ws.id, r1.id, { [P.number]: 5, [P.done]: true }));
      let after = (await row(store, r1.id))!;
      expect(after.values).toEqual({ [P.text]: 'first', [P.number]: 5, [P.done]: true });
      expect(after.version).toBe(2);
      expect(after.updatedAt >= before.updatedAt).toBe(true);
      // Null clears; an empty text is no value; a value that cannot be coerced is cleared.
      await store.applyLocalOp(
        update(ws.id, r1.id, {
          [P.text]: null,
          [P.done]: null,
          [P.number]: { start: '2026-01-01' },
        }),
      );
      after = (await row(store, r1.id))!;
      expect(after.values).toEqual({});
      await store.applyLocalOp(update(ws.id, r1.id, { [P.text]: '' }));
      expect((await row(store, r1.id))!.values).toEqual({});
      // Only stored properties the database has are written.
      await expect(
        store.applyLocalOp(update(ws.id, r1.id, { NoSuch01: 'x' })),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(store.applyLocalOp(update(ws.id, r1.id, { title: 'x' }))).rejects.toMatchObject({
        code: 'invalid',
      });
      await expect(
        store.applyLocalOp(update(ws.id, uuidv7(), { [P.text]: 'x' })),
      ).rejects.toMatchObject({ code: 'not.found' });
      await store.close();
    });

    it('trashes a row on its own; rows read as trashed while their database is', async () => {
      const store = await factory();
      const { ws, a, db, r1, r2 } = await seedDatabase(store);
      await store.applyLocalOp(op('page.trash', ws.id, r1.id, {}, 1));
      const trashed = (await row(store, r1.id))!;
      expect(trashed.trashRootId).toBe(r1.id);
      expect((await store.trashedRows(ws.id)).map((r) => r.id)).toEqual([r1.id]);
      await expect(
        store.applyLocalOp(update(ws.id, r1.id, { [P.text]: 'x' })),
      ).rejects.toMatchObject({ code: 'page.trashed' });
      await store.applyLocalOp(op('page.restore', ws.id, r1.id, {}));
      expect((await row(store, r1.id))!.trashedAt).toBeNull();
      expect(await store.trashedRows(ws.id)).toEqual([]);
      // Trashing the database's page (here, with its parent) does not touch its rows.
      await store.applyLocalOp(op('page.trash', ws.id, a.id, {}, 1));
      expect((await store.getPage(db.id))!.trashRootId).toBe(a.id);
      expect((await row(store, r2.id))!.trashedAt).toBeNull();
      expect(await store.trashedRows(ws.id)).toEqual([]);
      await expect(
        store.applyLocalOp(update(ws.id, r2.id, { [P.text]: 'x' })),
      ).rejects.toMatchObject({ code: 'page.trashed' });
      await expect(
        store.applyLocalOp(op('page.update', ws.id, r2.id, { title: 'x' })),
      ).rejects.toMatchObject({ code: 'page.trashed' });
      await expect(
        store.applyLocalOp(op('db.update', ws.id, db.id, { properties: [] })),
      ).rejects.toMatchObject({ code: 'page.trashed' });
      await store.applyLocalOp(op('page.restore', ws.id, a.id, {}));
      await store.applyLocalOp(update(ws.id, r2.id, { [P.text]: 'back' }));
      expect((await row(store, r2.id))!.values[P.text]).toBe('back');
      await store.close();
    });

    it('deletes a database for good with its record, views, rows and hold', async () => {
      const store = await factory();
      const { ws, a, c, db, r1, r2 } = await seedDatabase(store);
      await store.appendDocUpdates(r1.id, [{ updateId: uuidv7(), data: bytes(1) }]);
      await store.addHistory(r1.id, bytes(2), 5);
      await store.putSearchEntry({ pageId: r1.id, workspaceId: ws.id, title: 'one', text: 'kept' });
      await store.pin({ workspaceId: ws.id, pageId: r1.id, subtree: false, pinnedAt: at() });
      await store.setRepairState({ pageId: r1.id, epoch: 0, checkedSeq: 1, at: at(), repairs: 0 });
      await store.applyLocalOp(
        op('favourite.set', ws.id, r2.id, { favourite: true, orderKey: 'a0' }),
      );
      await store.applyLocalOp(op('page.trash', ws.id, a.id, {}, 1));
      await store.applyLocalOp(op('page.delete', ws.id, a.id, {}));
      const mirror = await store.readMirror(ws.id);
      expect(mirror.databases).toEqual([]);
      expect(mirror.views).toEqual([]);
      expect(mirror.favourites).toEqual([]);
      expect(mirror.pages.map((p) => p.id)).toEqual([c.id]);
      for (const id of [db.id, r1.id, r2.id]) expect(await store.getPage(id)).toBeNull();
      expect(await store.readRows(db.id)).toEqual([]);
      expect(await store.dbHold(db.id)).toBeNull();
      expect(await store.dbHolds(ws.id)).toEqual([]);
      expect(await store.loadDoc(r1.id)).toEqual({
        snapshot: null,
        snapshotCovers: 0,
        updates: [],
      });
      expect(await store.listHistory(r1.id)).toEqual([]);
      expect(await store.search(ws.id, 'kept', 10)).toEqual([]);
      expect(await store.pins(ws.id)).toEqual([]);
      expect(await store.repairState(r1.id)).toBeNull();
      await store.close();
    });

    it('deletes a trashed row for good, and purges trashed rows with the trash', async () => {
      const store = await factory();
      const { ws, db, r1, r2 } = await seedDatabase(store);
      await store.appendDocUpdates(r1.id, [{ updateId: uuidv7(), data: bytes(1) }]);
      await expect(store.applyLocalOp(op('page.delete', ws.id, r1.id, {}))).rejects.toMatchObject({
        code: 'page.notTrashed',
      });
      await store.applyLocalOp(op('page.trash', ws.id, r1.id, {}, 1));
      await store.applyLocalOp(op('page.delete', ws.id, r1.id, {}));
      expect(await store.getPage(r1.id)).toBeNull();
      expect((await store.loadDoc(r1.id)).updates).toEqual([]);
      expect(await rowIds(store, db.id)).toEqual([r2.id]);
      await store.applyLocalOp(op('page.trash', ws.id, r2.id, {}, 1));
      expect(await store.purgeTrash(ws.id, '2000-01-01T00:00:00.000Z')).toEqual([]);
      expect(await store.purgeTrash(ws.id, '9999-01-01T00:00:00.000Z')).toEqual([r2.id]);
      expect(await store.readRows(db.id)).toEqual([]);
      expect(await store.trashedRows(ws.id)).toEqual([]);
      await store.close();
    });

    it('moves a database to another section with its rows', async () => {
      const store = await factory();
      const { ws, a, db, r1, r2 } = await seedDatabase(store);
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
      expect((await store.getPage(db.id))!.sectionId).toBe(other.id);
      for (const id of [r1.id, r2.id])
        expect(await row(store, id)).toMatchObject({ sectionId: other.id, version: 2 });
      await store.close();
    });

    it("merges a database's properties per property; deleting one or an option rewrites no row", async () => {
      const store = await factory();
      const { ws, db, r1, r2 } = await seedDatabase(store);
      const added: PropertyDef = { id: 'Added001', name: 'Added', type: 'text' };
      await store.applyLocalOp(op('db.update', ws.id, db.id, { properties: [added] }));
      let record = (await dbOf(store, ws.id, db.id))!;
      expect(record.version).toBe(2);
      expect(record.properties.map((p) => p.id)).toEqual([
        'title',
        ...DB_PROPS.map((p) => p.id),
        added.id,
      ]);
      await store.applyLocalOp(op('db.update', ws.id, db.id, { order: [P.number, 'title'] }));
      record = (await dbOf(store, ws.id, db.id))!;
      expect(record.properties.map((p) => p.id)).toEqual([
        P.number,
        'title',
        ...DB_PROPS.map((p) => p.id).filter((id) => id !== P.number),
        added.id,
      ]);
      // A rename replaces the def in place.
      const notes = DB_PROPS.find((p) => p.id === P.text)!;
      await store.applyLocalOp(
        op('db.update', ws.id, db.id, { properties: [{ ...notes, name: 'Remarks' }] }),
      );
      record = (await dbOf(store, ws.id, db.id))!;
      expect(record.properties.find((p) => p.id === P.text)?.name).toBe('Remarks');
      // Deleting a property and an option leaves every row as it was.
      const rowsBefore = await store.readRows(db.id);
      const stage = DB_PROPS.find((p) => p.id === P.status)!;
      await store.applyLocalOp(
        op('db.update', ws.id, db.id, {
          properties: [
            { ...notes, name: 'Remarks', trashedAt: at() },
            { ...stage, options: stage.options!.slice(1) },
          ],
        }),
      );
      record = (await dbOf(store, ws.id, db.id))!;
      expect(record.properties.find((p) => p.id === P.text)?.trashedAt).toBeTruthy();
      expect(record.properties.find((p) => p.id === P.status)?.options).toHaveLength(1);
      expect(await store.readRows(db.id)).toEqual(rowsBefore);
      expect((await row(store, r1.id))!.values[P.text]).toBe('first');
      expect((await row(store, r2.id))!.values[P.status]).toBe(OPTION_OPEN);
      // Restored, it reads again.
      await store.applyLocalOp(
        op('db.update', ws.id, db.id, { properties: [{ ...notes, trashedAt: null }] }),
      );
      expect(
        (await dbOf(store, ws.id, db.id))!.properties.find((p) => p.id === P.text)?.trashedAt,
      ).toBeNull();
      // The title stays the one title.
      for (const properties of [
        [{ id: 'title', name: 'Name', type: 'text' }],
        [{ id: 'title', name: 'Name', type: 'title', trashedAt: at() }],
        [{ id: 'Second01', name: 'Second', type: 'title' }],
        [{ id: 'bad id', name: 'Bad', type: 'text' }],
      ] as PropertyDef[][])
        await expect(
          store.applyLocalOp(op('db.update', ws.id, db.id, { properties })),
        ).rejects.toMatchObject({ code: 'invalid' });
      await store.close();
    });

    it('converts every held row when a property changes type', async () => {
      const store = await factory();
      const { ws, db, r1, r2 } = await seedDatabase(store);
      const count = DB_PROPS.find((p) => p.id === P.number)!;
      await store.applyLocalOp(
        op('db.update', ws.id, db.id, {
          properties: [{ id: count.id, name: count.name, type: 'text' }],
        }),
      );
      expect(
        (await dbOf(store, ws.id, db.id))!.properties.find((p) => p.id === P.number)?.type,
      ).toBe('text');
      expect(await row(store, r1.id)).toMatchObject({ values: { [P.number]: '1' }, version: 2 });
      expect(await row(store, r2.id)).toMatchObject({ values: { [P.number]: '2' }, version: 2 });
      // And back: the text reads as numbers again.
      await store.applyLocalOp(op('db.update', ws.id, db.id, { properties: [count] }));
      expect((await row(store, r1.id))!.values[P.number]).toBe(1);
      await store.close();
    });

    it('keeps relations two-way on held rows and adds the reverse property to the target', async () => {
      const store = await factory();
      const { ws, section, c, db, r1, r2 } = await seedDatabase(store);
      const people = databasePage(ws.id, section.id, c.id, 'People');
      const p1 = rowCreate(ws.id, section.id, people.id, 'Ann', {}, 'a0');
      const p2 = rowCreate(ws.id, section.id, people.id, 'Bob', {}, 'a1');
      await store.applyLocalOps([
        op('page.create', ws.id, people.id, { ...people, database: { properties: [] } }),
        op('page.create', ws.id, p1.id, p1),
        op('page.create', ws.id, p2.id, p2),
      ]);
      const relation: PropertyDef = {
        id: P.relation,
        name: 'Owners',
        type: 'relation',
        relation: { databaseId: people.id, reversePropertyId: P.back },
      };
      await store.applyLocalOp(op('db.update', ws.id, db.id, { properties: [relation] }));
      const target = (await dbOf(store, ws.id, people.id))!;
      expect(target.version).toBe(2);
      expect(target.properties.find((p) => p.id === P.back)).toMatchObject({
        type: 'relation',
        relation: { databaseId: db.id, reversePropertyId: P.relation },
      });
      const back = async (id: Id) => (await row(store, id))!.values[P.back];
      await store.applyLocalOp(update(ws.id, r1.id, { [P.relation]: [p1.id, p2.id] }));
      expect(await back(p1.id)).toEqual([r1.id]);
      expect(await back(p2.id)).toEqual([r1.id]);
      expect((await row(store, p1.id))!.version).toBe(2);
      await store.applyLocalOp(update(ws.id, r1.id, { [P.relation]: [p2.id] }));
      expect(await back(p1.id)).toBeUndefined();
      await store.applyLocalOp(update(ws.id, r2.id, { [P.relation]: [p2.id] }));
      expect(await back(p2.id)).toEqual([r1.id, r2.id]);
      // A new row's relations reach the rows it names.
      const r3 = rowCreate(ws.id, section.id, db.id, 'Three', { [P.relation]: [p1.id] }, 'a2');
      await store.applyLocalOp(op('page.create', ws.id, r3.id, r3));
      expect(await back(p1.id)).toEqual([r3.id]);
      // Cleared, the reverse goes too.
      await store.applyLocalOp(update(ws.id, r2.id, { [P.relation]: null }));
      expect(await back(p2.id)).toEqual([r1.id]);
      // A self-relation's reverse is a second property in the same database.
      await store.applyLocalOp(
        op('db.update', ws.id, db.id, {
          properties: [
            {
              id: P.self,
              name: 'Blocks',
              type: 'relation',
              relation: { databaseId: db.id, reversePropertyId: P.selfBack },
            },
          ],
        }),
      );
      const own = (await dbOf(store, ws.id, db.id))!;
      expect(own.properties.find((p) => p.id === P.selfBack)?.relation).toEqual({
        databaseId: db.id,
        reversePropertyId: P.self,
      });
      await store.applyLocalOp(update(ws.id, r1.id, { [P.self]: [r2.id, r1.id] }));
      expect((await row(store, r2.id))!.values[P.selfBack]).toEqual([r1.id]);
      expect((await row(store, r1.id))!.values).toMatchObject({
        [P.self]: [r2.id, r1.id],
        [P.selfBack]: [r1.id],
      });
      await store.close();
    });

    it('keeps views: upserts with rising versions, and deletes', async () => {
      const store = await factory();
      const { ws, section, c, db, view } = await seedDatabase(store);
      await store.applyLocalOp(op('view.upsert', ws.id, view.id, { ...view, name: 'All tasks' }));
      const board = { ...viewRecord(ws.id, db.id, 'Board', 'a1'), type: 'board' as const };
      await store.applyLocalOp(op('view.upsert', ws.id, board.id, board));
      let views = (await store.readMirror(ws.id)).views;
      expect(views.find((v) => v.id === view.id)).toEqual({
        ...view,
        name: 'All tasks',
        version: 2,
      });
      expect(views.find((v) => v.id === board.id)?.version).toBe(1);
      await store.applyLocalOp(op('view.delete', ws.id, view.id, {}));
      views = (await store.readMirror(ws.id)).views;
      expect(views.map((v) => v.id)).toEqual([board.id]);
      const other = databasePage(ws.id, section.id, c.id, 'Other');
      await store.applyLocalOp(
        op('page.create', ws.id, other.id, { ...other, database: { properties: [] } }),
      );
      await expect(
        store.applyLocalOp(op('view.upsert', ws.id, board.id, { ...board, databaseId: other.id })),
      ).rejects.toMatchObject({ code: 'invalid' });
      const lost = viewRecord(ws.id, uuidv7());
      await expect(
        store.applyLocalOp(op('view.upsert', ws.id, lost.id, lost)),
      ).rejects.toMatchObject({ code: 'not.found' });
      await store.close();
    });

    it("counts a local-only database's rows; a synced one's count is the server's", async () => {
      const store = await factory();
      const { ws, db, r1, r2 } = await seedDatabase(store);
      const count = async (workspaceId: Id, id: Id) =>
        (await dbOf(store, workspaceId, id))!.rowCount;
      expect(await count(ws.id, db.id)).toBe(2);
      await store.applyLocalOp(op('page.trash', ws.id, r1.id, {}, 1));
      expect(await count(ws.id, db.id)).toBe(1);
      await store.applyLocalOp(op('page.update', ws.id, r2.id, { isTemplate: true }));
      expect(await count(ws.id, db.id)).toBe(0);
      await store.applyLocalOp(op('page.restore', ws.id, r1.id, {}));
      expect(await count(ws.id, db.id)).toBe(1);
      const synced = await seedDatabase(store, true);
      expect(await count(synced.ws.id, synced.db.id)).toBe(0);
      await store.close();
    });

    it("takes the server's databases and views, unless an operation on them waits", async () => {
      const store = await factory();
      const { ws, db, view } = await seedDatabase(store, true);
      const record = (await dbOf(store, ws.id, db.id))!;
      await settleAll(store, ws.id);
      await store.applyRemote({
        workspaceId: ws.id,
        databases: [{ ...record, version: 5, rowCount: 7 }],
        views: [{ ...view, name: 'Remote', version: 4 }],
      });
      expect(await dbOf(store, ws.id, db.id)).toMatchObject({ version: 5, rowCount: 7 });
      expect((await store.readMirror(ws.id)).views[0]).toMatchObject({
        name: 'Remote',
        version: 4,
      });
      await store.applyLocalOps([
        op('db.update', ws.id, db.id, { order: [P.text] }),
        op('view.upsert', ws.id, view.id, { ...view, name: 'Mine', version: 4 }),
      ]);
      await store.applyRemote({
        workspaceId: ws.id,
        databases: [{ ...record, version: 9 }],
        views: [{ ...view, name: 'Theirs', version: 9 }],
      });
      expect((await dbOf(store, ws.id, db.id))!.version).toBe(6);
      expect((await store.readMirror(ws.id)).views[0].name).toBe('Mine');
      await store.close();
    });

    it('writes rows only for a database it holds, or one the batch holds, unless an edit waits', async () => {
      const store = await factory();
      const { ws, section, c, db, r1, r2 } = await seedDatabase(store, true);
      const remote = databasePage(ws.id, section.id, c.id, 'From elsewhere');
      const remoteRecord: DatabaseRecord = {
        id: remote.id,
        workspaceId: ws.id,
        properties: [{ id: 'title', name: 'Name', type: 'title' }],
        version: 1,
        rowCount: 1,
        createdAt: at(),
      };
      const theirs = rowRecord(ws.id, section.id, remote.id, 'Not held');
      await settleAll(store, ws.id);
      const mine = { ...(await row(store, r1.id))!, title: 'Remote one', version: 9 };
      await store.applyLocalOp(update(ws.id, r2.id, { [P.text]: 'waiting' }));
      await store.applyRemote({
        workspaceId: ws.id,
        pages: [remote],
        databases: [remoteRecord],
        rows: [mine, theirs, { ...(await row(store, r2.id))!, title: 'Remote two', version: 9 }],
      });
      expect(await row(store, r1.id)).toMatchObject({ title: 'Remote one', version: 9 });
      expect((await row(store, r2.id))!.title).toBe('Two');
      expect(await store.getPage(theirs.id)).toBeNull();
      expect(await store.dbHold(remote.id)).toBeNull();
      // The batch that holds it writes its rows.
      const hold: DbHold = {
        databaseId: remote.id,
        workspaceId: ws.id,
        mode: 'partial',
        complete: false,
        after: theirs.id,
        heldAt: at(),
      };
      await store.applyRemote({ workspaceId: ws.id, rows: [theirs], holds: [hold] });
      expect(await row(store, theirs.id)).toEqual(theirs);
      expect(await store.dbHold(remote.id)).toEqual(hold);
      expect(await rowIds(store, remote.id)).toEqual([theirs.id]);
      // Deletes always apply.
      await store.appendDocUpdates(r2.id, [{ updateId: uuidv7(), data: bytes(1) }]);
      await store.applyRemote({ workspaceId: ws.id, deleteRows: [r2.id, theirs.id] });
      expect(await store.getPage(r2.id)).toBeNull();
      expect(await rowIds(store, db.id)).toEqual([r1.id]);
      expect(await store.readRows(remote.id)).toEqual([]);
      expect((await store.quarantine(ws.id)).map((e) => [e.pageId, e.title, e.reason])).toEqual([
        [r2.id, 'Two', 'page.removed'],
      ]);
      await store.close();
    });

    it('holds databases: a hold started, replaced and listed by workspace', async () => {
      const store = await factory();
      const { ws, db } = await seedDatabase(store, true);
      const other = await syncedTree(store);
      const ids = [uuidv7(), uuidv7()];
      const hold = (databaseId: Id, workspaceId: Id, mode: DbHold['mode']): DbHold => ({
        databaseId,
        workspaceId,
        mode,
        complete: false,
        after: null,
        heldAt: at(),
      });
      await store.holdDatabase(hold(ids[0], ws.id, 'partial'));
      const replaced = { ...hold(ids[0], ws.id, 'full'), after: uuidv7() };
      await store.holdDatabase(replaced);
      await store.holdDatabase(hold(ids[1], other.ws.id, 'partial'));
      expect(await store.dbHold(ids[0])).toEqual(replaced);
      expect((await store.dbHolds(ws.id)).map((h) => h.databaseId)).toEqual(
        sorted([db.id, ids[0]]),
      );
      expect((await store.dbHolds(other.ws.id)).map((h) => h.databaseId)).toEqual([ids[1]]);
      await store.close();
    });

    it('removes a database page the server deletes with all it holds, setting aside unsent row edits', async () => {
      const store = await factory();
      const { ws, db, r1, r2 } = await seedDatabase(store, true);
      await store.appendDocUpdates(r1.id, [{ updateId: uuidv7(), data: bytes(1) }]);
      const sent = uuidv7();
      await store.appendDocUpdates(r2.id, [{ updateId: sent, data: bytes(2) }]);
      await store.ackDocUpdates(r2.id, [{ updateId: sent, seq: 1 }]);
      await store.applyRemote({ workspaceId: ws.id, deletePages: [db.id] });
      const mirror = await store.readMirror(ws.id);
      expect(mirror.databases).toEqual([]);
      expect(mirror.views).toEqual([]);
      expect(await store.readRows(db.id)).toEqual([]);
      expect(await store.getPage(r1.id)).toBeNull();
      expect(await store.dbHold(db.id)).toBeNull();
      expect((await store.loadDoc(r2.id)).updates).toEqual([]);
      const entries = await store.quarantine(ws.id);
      expect(entries.map((e) => [e.pageId, e.title, e.reason, plain(e.parts)])).toEqual([
        [r1.id, 'One', 'page.removed', [[1]]],
      ]);
      await store.close();
    });

    it('removes a database a tree or a subtree no longer holds, and views the whole tree does not', async () => {
      const store = await factory();
      const tree = await seedDatabase(store, true);
      const { ws, section, a, b, c, d, db, view, r1 } = tree;
      const extra = viewRecord(ws.id, db.id, 'Extra', 'a1');
      await store.applyLocalOp(op('view.upsert', ws.id, extra.id, extra));
      await settleAll(store, ws.id);
      const record = (await dbOf(store, ws.id, db.id))!;
      const pages = (await store.readMirror(ws.id)).pages;
      await store.applyRemote({
        workspaceId: ws.id,
        sections: [section],
        pages,
        databases: [record],
        views: [{ ...view, version: 1 }],
        replace: { root: null },
      });
      let mirror = await store.readMirror(ws.id);
      expect(mirror.views.map((v) => v.id)).toEqual([view.id]);
      expect(mirror.databases.map((x) => x.id)).toEqual([db.id]);
      // Rows are never removed by a replace: a tree holds none.
      expect(await rowIds(store, db.id)).toHaveLength(2);
      // A subtree under a without the database page: it goes with its rows.
      await store.applyRemote({
        workspaceId: ws.id,
        pages: pages.filter((p) => [a.id, b.id, d.id].includes(p.id)),
        replace: { root: a.id },
      });
      mirror = await store.readMirror(ws.id);
      expect(mirror.databases).toEqual([]);
      expect(mirror.views).toEqual([]);
      expect(mirror.pages.map((p) => p.id).sort()).toEqual(sorted([a.id, b.id, c.id, d.id]));
      expect(await store.getPage(r1.id)).toBeNull();
      expect(await store.dbHold(db.id)).toBeNull();
      await store.close();
    });

    it('removes the databases, views, rows and holds of a workspace the account lost', async () => {
      const store = await factory();
      const { ws, db, r1 } = await seedDatabase(store, true);
      await store.appendDocUpdates(r1.id, [{ updateId: uuidv7(), data: bytes(1) }]);
      await store.applyRemote({ workspaceId: ws.id, deleteWorkspace: true });
      const mirror = await store.readMirror(ws.id);
      expect([mirror.databases, mirror.views, mirror.pages]).toEqual([[], [], []]);
      expect(await store.readRows(db.id)).toEqual([]);
      expect(await store.dbHolds(ws.id)).toEqual([]);
      expect(await store.getPage(r1.id)).toBeNull();
      expect((await store.quarantine(ws.id)).map((e) => e.pageId)).toEqual([r1.id]);
      await store.close();
    });

    it('settles database, view and row answers, and drops a row the server refused', async () => {
      const store = await factory();
      const { ws, section, db, view, r1 } = await seedDatabase(store, true);
      await settleAll(store, ws.id);
      const edit = update(ws.id, r1.id, { [P.number]: 3 });
      const order = op('db.update', ws.id, db.id, { order: [P.text] });
      const rename = op('view.upsert', ws.id, view.id, { ...view, name: 'Local' });
      const refusedRow = rowCreate(ws.id, section.id, db.id, 'Refused', {}, 'a9');
      const create = op('page.create', ws.id, refusedRow.id, refusedRow);
      await store.applyLocalOps([edit, order, rename, create]);
      await store.appendDocUpdates(refusedRow.id, [{ updateId: uuidv7(), data: bytes(4) }]);
      const server = (await row(store, r1.id))!;
      const record = (await dbOf(store, ws.id, db.id))!;
      await store.settleOps([
        {
          opId: edit.opId,
          status: 'applied',
          entityType: 'row',
          entity: { ...server, values: { [P.number]: 4 }, versions: { [P.number]: 2 }, version: 5 },
        },
        {
          opId: order.opId,
          status: 'applied',
          entityType: 'database',
          entity: { ...record, version: 11 },
        },
        {
          opId: rename.opId,
          status: 'applied',
          entityType: 'view',
          entity: { ...view, name: 'Server', version: 8 },
        },
        {
          opId: create.opId,
          status: 'rejected',
          error: { code: 'invalid' },
          entityType: 'row',
          entity: null,
        },
      ]);
      expect(await row(store, r1.id)).toMatchObject({
        values: { [P.number]: 4 },
        versions: { [P.number]: 2 },
        version: 5,
      });
      expect((await dbOf(store, ws.id, db.id))!.version).toBe(11);
      expect((await store.readMirror(ws.id)).views[0]).toMatchObject({
        name: 'Server',
        version: 8,
      });
      expect(await store.getPage(refusedRow.id)).toBeNull();
      expect((await store.quarantine(ws.id)).map((e) => [e.pageId, e.title])).toEqual([
        [refusedRow.id, 'Refused'],
      ]);
      expect(await store.nextOutboxBatch(10, ws.id)).toEqual([]);
      await store.close();
    });

    it('gives a held row whose edit waits the type the server changed, coerced', async () => {
      const store = await factory();
      const { ws, db, r1, r2 } = await seedDatabase(store, true);
      await settleAll(store, ws.id);
      await store.applyLocalOp(update(ws.id, r1.id, { [P.number]: 7 }));
      const record = (await dbOf(store, ws.id, db.id))!;
      const server = (await row(store, r2.id))!;
      await store.applyRemote({
        workspaceId: ws.id,
        databases: [
          {
            ...record,
            version: record.version + 1,
            properties: record.properties.map((p) =>
              p.id === P.number ? { id: p.id, name: p.name, type: 'text' } : p,
            ),
          },
        ],
        rows: [{ ...server, values: { [P.number]: '2' }, version: 4 }],
      });
      expect((await row(store, r1.id))!.values[P.number]).toBe('7');
      expect((await row(store, r2.id))!.values[P.number]).toBe('2');
      await store.close();
    });

    it("holds rows' documents as pages', and finds rows in search unless they read as trashed", async () => {
      const store = await factory();
      const { ws, a, r1, r2 } = await seedDatabase(store, true);
      await store.appendDocUpdates(r1.id, [{ updateId: uuidv7(), data: bytes(1, 2) }]);
      await store.applyRemoteDocUpdates(r2.id, { epoch: 0, headSeq: 0, updates: [] });
      expect(await store.heldPages(ws.id)).toEqual(sorted([r1.id, r2.id]));
      expect((await store.storageUsage(ws.id)).docBytes).toBe(2);
      expect(Object.keys(await store.docCursors(ws.id))).toEqual([r2.id]);
      expect((await store.unsentDocUpdates(10)).map((u) => u.pageId)).toEqual([r1.id]);
      await store.putSearchEntry({
        pageId: r1.id,
        workspaceId: ws.id,
        title: normaliseText('One'),
        text: normaliseText('Quarterly figures'),
      });
      expect(
        (await store.search(ws.id, normaliseText('quarter'), 10)).map((h) => h.pageId),
      ).toEqual([r1.id]);
      expect((await store.search(ws.id, normaliseText('one'), 10))[0].title).toBe('One');
      await store.applyLocalOp(op('page.trash', ws.id, a.id, {}, 1));
      expect(await store.search(ws.id, normaliseText('quarter'), 10)).toEqual([]);
      // Set aside like a page's: the row's own title.
      expect((await store.setAsideDoc(r1.id, 'access.denied'))?.title).toBe('One');
      await store.close();
    });

    it("uploads a local workspace's databases: records, views, then rows, relations after", async () => {
      const store = await factory();
      const tree = await seedDatabase(store);
      const { ws, section, c, db, view, r1, r2 } = tree;
      const people = databasePage(ws.id, section.id, c.id, 'People');
      const p1 = rowCreate(ws.id, section.id, people.id, 'Ann');
      const relation: PropertyDef = {
        id: P.relation,
        name: 'Owners',
        type: 'relation',
        relation: { databaseId: people.id, reversePropertyId: P.back },
      };
      const formula: PropertyDef = {
        id: P.formula,
        name: 'Twice',
        type: 'formula',
        formula: { expression: `prop("${P.number}") * 2` },
      };
      await store.applyLocalOps([
        op('page.create', ws.id, people.id, { ...people, database: { properties: [] } }),
        op('page.create', ws.id, p1.id, p1),
        op('db.update', ws.id, db.id, { properties: [relation, formula] }),
        update(ws.id, r1.id, { [P.relation]: [p1.id] }),
        op('page.trash', ws.id, r2.id, {}, 1),
        op('favourite.set', ws.id, r1.id, { favourite: true, orderKey: 'a0' }),
      ]);
      const mirror = await store.readMirror(ws.id);
      const databases = {
        databases: mirror.databases,
        views: mirror.views,
        rows: [] as RowRecord[],
      };
      for (const record of mirror.databases)
        databases.rows.push(...(await store.readRows(record.id)));
      const ops = uploadOps(
        mirror.workspaces[0],
        mirror.sections,
        mirror.pages,
        mirror.favourites,
        uuidv7,
        databases,
      );
      const kinds = ops.map((o) => `${o.type}:${o.entityId}`);
      const index = (type: string, id: Id) => kinds.indexOf(`${type}:${id}`);
      const createDb = ops[index('page.create', db.id)] as Extract<
        Operation,
        { type: 'page.create' }
      >;
      expect(createDb.payload.database?.properties.map((p) => p.id)).toEqual([
        'title',
        ...DB_PROPS.map((p) => p.id),
      ]);
      const later = ops[index('db.update', db.id)] as Extract<Operation, { type: 'db.update' }>;
      expect(later.payload.properties?.map((p) => p.id)).toEqual([P.relation, P.formula]);
      expect(later.payload.order).toEqual(
        (await dbOf(store, ws.id, db.id))!.properties.map((p) => p.id),
      );
      // The reverse side, already in People's record, comes the same way.
      expect(index('db.update', people.id)).toBeGreaterThan(index('page.create', people.id));
      expect(index('db.update', db.id)).toBeGreaterThan(index('page.create', people.id));
      expect(index('view.upsert', view.id)).toBeGreaterThan(index('db.update', db.id));
      const createRow = ops[index('page.create', r1.id)] as Extract<
        Operation,
        { type: 'page.create' }
      >;
      expect(createRow.payload).toMatchObject({ kind: 'row', parentPageId: db.id, version: 1 });
      expect(createRow.payload.row?.values).toEqual({ [P.text]: 'first', [P.number]: 1 });
      expect(createRow.payload).not.toHaveProperty('values');
      expect(index('page.create', r1.id)).toBeGreaterThan(index('view.upsert', view.id));
      const relate = ops[index('row.update', r1.id)] as Extract<Operation, { type: 'row.update' }>;
      expect(relate.payload.values).toEqual({ [P.relation]: [p1.id] });
      expect(index('row.update', r1.id)).toBeGreaterThan(index('page.create', p1.id));
      expect(index('page.trash', r2.id)).toBeGreaterThan(index('row.update', r1.id));
      expect(index('favourite.set', r1.id)).toBeGreaterThan(index('page.trash', r2.id));
      // They plan, in order, on an empty store as they will on the server.
      const fresh = await factory();
      await fresh.applyLocalOps([
        op('workspace.create', ws.id, ws.id, mirror.workspaces[0]),
        ...ops,
      ]);
      const again = await fresh.readMirror(ws.id);
      expect(sorted(again.pages.map((p) => p.id))).toEqual(sorted(mirror.pages.map((p) => p.id)));
      for (const record of mirror.databases) {
        expect((await dbOf(fresh, ws.id, record.id))!.properties).toEqual(record.properties);
        const rows = (await fresh.readRows(record.id)).map((r) => [r.id, r.values, !!r.trashedAt]);
        expect(rows).toEqual(
          (await store.readRows(record.id)).map((r) => [r.id, r.values, !!r.trashedAt]),
        );
      }
      expect(again.views.map((v) => v.id)).toEqual([view.id]);
      expect(again.favourites.map((f) => f.pageId)).toEqual([r1.id]);
      // The upload keeps the databases held here.
      await store.beginUpload(ws.id, ACCOUNT, ops);
      expect((await store.dbHolds(ws.id)).map((h) => [h.databaseId, h.mode, h.complete])).toEqual(
        sorted([db.id, people.id]).map((id) => [id, 'full', true]),
      );
      await fresh.close();
      await store.close();
    });
  });
}

/** The account a synced workspace in these tests belongs to. */
const ACCOUNT = '0193a1b2-c3d4-7e5f-8a9b-000000000001';
