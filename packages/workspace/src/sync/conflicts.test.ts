// Every row of SYNC_DESIGN.md's Metadata and "Across the two models" tables, and Epoch change, as
// a script that ends in the stated result with the notice the user is shown; then access granted
// and revoked while a device is offline. (The Yjs table is the document layer's: S1's fuzz.)
//
// Rows with no script here: "a permission change" (not an operation: the shell calls the
// permissions API, whose version check is the server's own tests'). Phase 4 adds the database
// rows of the Metadata table and the database rules of contract section 2, the same way.
import { describe, expect, it } from 'vitest';
import { newOp } from '../build';
import { queryRows } from '../db/query';
import type { PropertyDef } from '../db/types';
import { cellValue } from '../db/values';
import { uuidv7, type Id } from '../ids';
import { MemoryStore } from '../memory';
import { fakeCodec, fakeUpdate, FakeServer } from '../testing/fakeServer';
import {
  ALICE,
  BOB,
  PROP,
  STAGE,
  TASK_PROPS,
  device,
  heldRows,
  makeDatabase,
  mirrorShape,
  pageRecord,
  rowCreate,
  serverRow,
  serverRows,
  serverShape,
  sharedWorkspace,
  type Device,
} from '../testing/syncHarness';
import { STORE_SCHEMA_VERSION, type RowRecord } from '../types';

const type = (store: MemoryStore, pageId: Id, text: string, client = 71) =>
  store.appendDocUpdates(pageId, [{ updateId: uuidv7(), data: fakeUpdate(client, text) }]);

const version = async (d: Device, pageId: Id) => (await d.store.getPage(pageId))!.version;

const hashOf = async (d: Device, pageId: Id) => {
  const doc = await d.store.loadDoc(pageId);
  return fakeCodec.stateHash([
    ...(doc.snapshot ? [doc.snapshot] : []),
    ...doc.updates.map((u) => u.data),
  ]);
};

/** Alice's workspace on the server, held by her device, and Bob, a member, synced. */
async function twoPeople(server = new FakeServer({ codec: fakeCodec })) {
  const shared = await sharedWorkspace(server);
  server.addMember(shared.ws.id, BOB.id);
  const bob = device(server, BOB);
  await bob.engine.syncOnce();
  return { server, ...shared, bob };
}

async function sync(...devices: Device[]) {
  for (const d of devices) await d.engine.syncOnce();
}

describe('Metadata conflicts (SYNC_DESIGN.md)', () => {
  it('two people rename a page: the last to reach the server wins, and no one is told', async () => {
    const { server, one, bob, ws, a } = await twoPeople();
    await one.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Alice' })]);
    await bob.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Bob' })]);
    await sync(one, bob, one);
    expect(server.spaces.get(ws.id)!.mirror.pages.get(a.id)!.title).toBe('Bob');
    expect((await one.store.getPage(a.id))!.title).toBe('Bob');
    expect((await bob.store.getPage(a.id))!.title).toBe('Bob');
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it('two people change different fields of one page: both stand', async () => {
    const { one, bob, ws, a } = await twoPeople();
    await one.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Titled' })]);
    await bob.store.applyLocalOps([newOp('page.update', ws.id, a.id, { icon: '🌙' })]);
    await sync(one, bob, one);
    for (const d of [one, bob])
      expect(await d.store.getPage(a.id)).toMatchObject({ title: 'Titled', icon: '🌙' });
    expect(await mirrorShape(one.store, ws.id)).toEqual(await mirrorShape(bob.store, ws.id));
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it('a move on a changed page is refused (version.conflict) and the current state is shown', async () => {
    const { server, one, bob, ws, a, c } = await twoPeople();
    const base = await version(one, c.id);
    await bob.store.applyLocalOps([newOp('page.update', ws.id, c.id, { title: 'Changed' })]);
    await sync(bob);
    await one.store.applyLocalOps([
      newOp(
        'page.move',
        ws.id,
        c.id,
        { sectionId: c.sectionId, parentPageId: a.id, orderKey: 'a9' },
        base,
      ),
    ]);
    expect((await one.store.getPage(c.id))!.parentPageId).toBe(a.id);
    await sync(one);
    expect(one.notices()).toEqual(['version.conflict']);
    expect(await one.store.getPage(c.id)).toMatchObject({ parentPageId: null, title: 'Changed' });
    expect(await mirrorShape(one.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
  });

  it('a trash on a changed page is refused (version.conflict) and the current state is shown', async () => {
    const { server, one, bob, ws, a, b } = await twoPeople();
    const base = await version(one, a.id);
    await bob.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Changed' })]);
    await sync(bob);
    await one.store.applyLocalOps([newOp('page.trash', ws.id, a.id, {}, base)]);
    await sync(one);
    expect(one.notices()).toEqual(['version.conflict']);
    expect((await one.store.getPage(a.id))!.trashedAt).toBeNull();
    expect((await one.store.getPage(b.id))!.trashedAt).toBeNull();
    expect(await mirrorShape(one.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
  });

  it('a permanent delete raced by a restore is refused and the current state is shown', async () => {
    // As built, a delete carries no base version; the server refuses it because the page is not
    // in the trash any more (`page.notTrashed`), which is the same outcome: never merged silently.
    const { server, one, bob, ws, c } = await twoPeople();
    await one.store.applyLocalOps([newOp('page.trash', ws.id, c.id, {}, await version(one, c.id))]);
    await sync(one, bob);
    await one.store.applyLocalOps([newOp('page.delete', ws.id, c.id, {})]);
    expect(await one.store.getPage(c.id)).toBeNull();
    await bob.store.applyLocalOps([newOp('page.restore', ws.id, c.id, {})]);
    await sync(bob, one);
    expect(one.notices()).toEqual(['page.notTrashed']);
    expect(await one.store.getPage(c.id)).toMatchObject({ trashedAt: null });
    expect(await mirrorShape(one.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
  });

  it('a trash that races a move out of the subtree leaves nothing trashed that the server did not trash', async () => {
    // Found by the simulator: the local planner trashes the subtree as it saw it, the server as
    // it is; a page under the one moved away gets no feed change, so the engine takes the tree.
    const { server, one, bob, ws, a, b, c, section } = await twoPeople();
    const d = pageRecord(ws.id, section.id, 'Delta', b.id, 'a0');
    await one.store.applyLocalOps([newOp('page.create', ws.id, d.id, d)]);
    await sync(one, bob);
    await bob.store.applyLocalOps([
      newOp(
        'page.move',
        ws.id,
        b.id,
        { sectionId: b.sectionId, parentPageId: c.id, orderKey: 'a0' },
        await version(bob, b.id),
      ),
    ]);
    await sync(bob);
    await one.store.applyLocalOps([newOp('page.trash', ws.id, a.id, {}, await version(one, a.id))]);
    expect((await one.store.getPage(d.id))!.trashedAt).not.toBeNull();
    await sync(one);
    expect((await one.store.getPage(d.id))!.trashedAt).toBeNull();
    expect((await one.store.getPage(a.id))!.trashedAt).not.toBeNull();
    expect(await mirrorShape(one.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
    expect(one.notices()).toEqual([]);
  });

  it('a move that would make a cycle is refused (tree.cycle) and the page goes back', async () => {
    const { server, one, bob, ws, a, b, c } = await twoPeople();
    // Bob puts Gamma under Beta (which is under Alpha); Alice, not knowing, puts Alpha under Gamma.
    await bob.store.applyLocalOps([
      newOp(
        'page.move',
        ws.id,
        c.id,
        { sectionId: c.sectionId, parentPageId: b.id, orderKey: 'a0' },
        await version(bob, c.id),
      ),
    ]);
    await sync(bob);
    await one.store.applyLocalOps([
      newOp(
        'page.move',
        ws.id,
        a.id,
        { sectionId: a.sectionId, parentPageId: c.id, orderKey: 'a0' },
        await version(one, a.id),
      ),
    ]);
    await sync(one);
    expect(one.notices()).toEqual(['tree.cycle']);
    expect(await one.store.getPage(a.id)).toMatchObject({ parentPageId: null });
    expect(await one.store.getPage(c.id)).toMatchObject({ parentPageId: b.id });
    expect(await mirrorShape(one.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
  });

  it('two offline people create pages under one parent with one key: both exist, the later re-keyed', async () => {
    const { server, one, bob, ws, a, section } = await twoPeople();
    const mine = pageRecord(ws.id, section.id, 'Alice’s', a.id, 'a5');
    const theirs = pageRecord(ws.id, section.id, 'Bob’s', a.id, 'a5');
    await one.store.applyLocalOps([newOp('page.create', ws.id, mine.id, mine)]);
    await bob.store.applyLocalOps([newOp('page.create', ws.id, theirs.id, theirs)]);
    await sync(one, bob, one);
    const keys = [
      (await one.store.getPage(mine.id))!.orderKey,
      (await one.store.getPage(theirs.id))!.orderKey,
    ];
    expect(keys[0]).toBe('a5');
    expect(keys[1] > keys[0]).toBe(true);
    expect(await mirrorShape(one.store, ws.id)).toEqual(await mirrorShape(bob.store, ws.id));
    expect(await mirrorShape(one.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it('a page created under a parent deleted meanwhile goes to the top of its section, and the user is told', async () => {
    const { server, one, bob, ws, c, section } = await twoPeople();
    await bob.store.applyLocalOps([newOp('page.trash', ws.id, c.id, {}, await version(bob, c.id))]);
    await bob.store.applyLocalOps([newOp('page.delete', ws.id, c.id, {})]);
    await sync(bob);
    const child = pageRecord(ws.id, section.id, 'Under Gamma', c.id, 'a0');
    await one.store.applyLocalOps([newOp('page.create', ws.id, child.id, child)]);
    await type(one.store, child.id, 'kept');
    await sync(one, one);
    expect(one.notices()).toEqual(['tree.parentMissing']);
    expect(await one.store.getPage(child.id)).toMatchObject({ parentPageId: null });
    expect(await one.store.getPage(c.id)).toBeNull();
    expect(server.docs.get(child.id)!.rows).toHaveLength(1);
    expect(await mirrorShape(one.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
  });
});

describe('Across the two models (SYNC_DESIGN.md)', () => {
  it('a page edited offline and trashed on the server: the edits go into the trashed page, and the user is told', async () => {
    const { server, one, bob, ws, a } = await twoPeople();
    await bob.store.applyLocalOps([newOp('page.trash', ws.id, a.id, {}, await version(bob, a.id))]);
    await sync(bob);
    await type(one.store, a.id, 'written offline');
    await sync(one);
    expect(one.notices()).toEqual(['page.trashed']);
    expect(server.docs.get(a.id)!.rows).toHaveLength(1);
    expect((await one.store.getPage(a.id))!.trashedAt).not.toBeNull();
    expect(await one.store.unsentDocUpdates(10)).toEqual([]);
    // On restore, the edits are there.
    await bob.store.applyLocalOps([newOp('page.restore', ws.id, a.id, {})]);
    await sync(bob, one);
    await bob.engine.pullPage(a.id);
    expect(await hashOf(bob, a.id)).toBe(await hashOf(one, a.id));
    await sync(one);
    expect(one.notices()).toEqual(['page.trashed']);
  });

  it('a page edited offline and deleted for good: 410, and the edits are set aside for a recovered page', async () => {
    const { one, bob, ws, a, b } = await twoPeople();
    await bob.store.applyLocalOps([newOp('page.trash', ws.id, a.id, {}, await version(bob, a.id))]);
    await bob.store.applyLocalOps([newOp('page.delete', ws.id, a.id, {})]);
    await sync(bob);
    await type(one.store, a.id, 'written offline');
    await sync(one);
    expect(one.notices()).toEqual(['page.gone']);
    expect(one.events).toContainEqual({ kind: 'recover', workspaceId: ws.id });
    const [entry] = await one.store.quarantine(ws.id);
    expect(entry).toMatchObject({ pageId: a.id, title: 'Alpha', reason: 'page.gone' });
    expect(entry.status).toBe('pending');
    expect(entry.parts.map((p) => new TextDecoder().decode(p)).join()).toContain('written offline');
    expect(await one.store.getPage(a.id)).toBeNull();
    expect(await one.store.getPage(b.id)).toBeNull();
    // Until the shell makes the recovered page, every pass asks again.
    one.events.length = 0;
    await sync(one);
    expect(one.events).toContainEqual({ kind: 'recover', workspaceId: ws.id });
    await one.store.settleQuarantine(entry.id, 'recovered', uuidv7());
    one.events.length = 0;
    await sync(one, one);
    expect(one.events.filter((e) => e.kind === 'recover')).toEqual([]);
  });

  it('a page moved on the server: no conflict, documents are keyed by page id', async () => {
    const { server, one, bob, ws, a, c } = await twoPeople();
    await bob.store.applyLocalOps([
      newOp(
        'page.move',
        ws.id,
        c.id,
        { sectionId: c.sectionId, parentPageId: a.id, orderKey: 'a5' },
        await version(bob, c.id),
      ),
    ]);
    await sync(bob);
    await type(one.store, c.id, 'written offline');
    await sync(one);
    expect(one.notices()).toEqual([]);
    expect(server.docs.get(c.id)!.rows).toHaveLength(1);
    expect((await one.store.getPage(c.id))!.parentPageId).toBe(a.id);
  });

  it('edit access removed while offline: 403, the edits set aside, the page as the server has it', async () => {
    const { server, one, bob, ws, a } = await twoPeople();
    await type(one.store, a.id, 'before');
    await sync(one);
    await bob.engine.pullPage(a.id);
    await type(bob.store, a.id, 'written offline', 72);
    server.demote(ws.id, BOB.id);
    await sync(bob);
    expect(bob.notices()).toEqual(['access.denied']);
    expect(bob.events).toContainEqual({ kind: 'docReset', pageId: a.id });
    expect(bob.events).toContainEqual({ kind: 'recover', workspaceId: ws.id });
    expect(await bob.store.quarantine(ws.id)).toMatchObject([
      { pageId: a.id, reason: 'access.denied', status: 'pending' },
    ]);
    // Nothing of Bob's reached the server; his copy is the server's, and he may read it.
    expect(server.docs.get(a.id)!.rows).toHaveLength(1);
    expect(await bob.store.unsentDocUpdates(10)).toEqual([]);
    expect(await hashOf(bob, a.id)).toBe(await fakeCodec.stateHash(server.docParts(a.id)));
    expect((await bob.store.getPage(a.id))!.access).toBe('view');
  });

  it('read access removed too: the edits set aside, and the copy of the page dropped', async () => {
    const { server, one, bob, ws, a, b } = await twoPeople();
    await type(one.store, a.id, 'before');
    await sync(one);
    await bob.engine.pullPage(a.id);
    await type(bob.store, a.id, 'written offline', 72);
    server.revoke(ws.id, a.id, BOB.id);
    await sync(bob);
    expect(bob.notices()).toEqual(['access.denied']);
    expect(bob.events).toContainEqual({ kind: 'recover', workspaceId: ws.id });
    expect(await bob.store.getPage(a.id)).toBeNull();
    expect(await bob.store.getPage(b.id)).toBeNull();
    expect(await bob.store.quarantine(ws.id)).toMatchObject([
      { pageId: a.id, title: 'Alpha', reason: 'access.denied' },
    ]);
    expect(server.docs.get(a.id)!.rows).toHaveLength(1);
    expect(await mirrorShape(bob.store, ws.id)).toEqual(await serverShape(server, BOB, ws.id));
  });

  it('a version restored (hard) while offline: 409, the edits set aside, the new epoch pulled', async () => {
    const { server, one, ws, a } = await twoPeople();
    await type(one.store, a.id, 'old epoch');
    await sync(one);
    server.hardRestore(a.id, fakeUpdate(1, 'restored'));
    await type(one.store, a.id, 'written offline');
    await sync(one);
    expect(one.notices()).toEqual(['doc.epochMismatch']);
    expect(one.events).toContainEqual({ kind: 'docReset', pageId: a.id });
    expect(one.events).toContainEqual({ kind: 'recover', workspaceId: ws.id });
    const [entry] = await one.store.quarantine(ws.id);
    expect(entry).toMatchObject({ reason: 'doc.epochMismatch', pageId: a.id });
    const text = entry.parts.map((p) => new TextDecoder().decode(p)).join();
    expect(text).toContain('old epoch');
    expect(text).toContain('written offline');
    expect(await one.store.docCursor(a.id)).toMatchObject({ epoch: 1 });
    expect(await hashOf(one, a.id)).toBe(await fakeCodec.stateHash(server.docParts(a.id)));
    expect(server.docs.get(a.id)!.rows).toHaveLength(1);
  });

  it('a hard restore found by a pull (nothing unsent): the page starts again from the new epoch', async () => {
    const { server, one, bob, a } = await twoPeople();
    await type(one.store, a.id, 'old epoch');
    await sync(one);
    await bob.engine.pullPage(a.id);
    server.hardRestore(a.id, fakeUpdate(1, 'restored'));
    await sync(bob);
    expect(bob.notices()).toEqual(['doc.epochMismatch']);
    expect(await bob.store.quarantine(null)).toEqual([]);
    expect(await hashOf(bob, a.id)).toBe(await fakeCodec.stateHash(server.docParts(a.id)));
  });

  it('the app older than the document’s schema: nothing is pushed, the edits stay here, the user is told', async () => {
    const { server, one, ws, a } = await twoPeople();
    await type(one.store, a.id, 'pushed');
    await sync(one);
    server.raiseSchema(a.id, 2);
    await type(one.store, a.id, 'held');
    await sync(one);
    expect(one.notices()).toEqual(['client.tooOld']);
    expect(server.docs.get(a.id)!.rows).toHaveLength(1);
    // Kept, unsent, and not tried again this session; the status does not count it as waiting.
    expect((await one.store.unsentDocUpdates(10))[0].updates).toHaveLength(1);
    const pushes = server.calls.filter((c) => c === 'pushDoc').length;
    await sync(one);
    expect(server.calls.filter((c) => c === 'pushDoc')).toHaveLength(pushes);
    expect(one.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    expect(await one.store.quarantine(ws.id)).toEqual([]);
  });

  it('the app older than the local store: the engine sends nothing from it and discards nothing', async () => {
    const server = new FakeServer();
    const { one, ws, a } = await sharedWorkspace(server);
    await one.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Waiting' })]);
    class NewerStore extends MemoryStore {
      override schemaVersion() {
        return Promise.resolve(STORE_SCHEMA_VERSION + 1);
      }
    }
    const store = new NewerStore();
    await store.applyRemote({
      workspaceId: ws.id,
      workspaces: [(await one.store.readMirror(ws.id)).workspaces[0]],
    });
    const old = device(server, ALICE, { store });
    const calls = server.calls.length;
    await old.engine.syncOnce();
    expect(server.calls.length).toBe(calls);
    expect(old.engine.status.state).toBe('error');
  });

  it('a remote delete of a page with unsent edits: the store sets them aside, and the user is told', async () => {
    const { server, bob, one, ws, a } = await twoPeople();
    await bob.store.applyLocalOps([newOp('page.trash', ws.id, a.id, {}, await version(bob, a.id))]);
    await bob.store.applyLocalOps([newOp('page.delete', ws.id, a.id, {})]);
    await sync(bob);
    // Typed while the pass is under way, after the push and before the feed is read.
    let typed = false;
    const typing = device(server, ALICE, {
      store: one.store,
      api: (base) => ({
        changes: async (...args) => {
          if (!typed) {
            typed = true;
            await type(one.store, a.id, 'typed during the pass');
          }
          return base.changes(...args);
        },
      }),
    });
    await typing.engine.syncOnce();
    expect(typing.notices()).toEqual(['page.removed']);
    expect(typing.events).toContainEqual({ kind: 'recover', workspaceId: ws.id });
    expect(await one.store.quarantine(ws.id)).toMatchObject([
      { pageId: a.id, reason: 'page.removed', status: 'pending' },
    ]);
  });

  it('a subtree lost to a revoke with unsent edits: set aside, and the user is told', async () => {
    const { server, bob, ws, a } = await twoPeople();
    await bob.engine.pullPage(a.id);
    let typed = false;
    const typing = device(server, BOB, {
      store: bob.store,
      api: (base) => ({
        changes: async (...args) => {
          if (!typed) {
            typed = true;
            server.revoke(ws.id, a.id, BOB.id);
            await type(bob.store, a.id, 'typed during the pass', 72);
          }
          return base.changes(...args);
        },
      }),
    });
    await typing.engine.syncOnce();
    expect(typing.notices()).toEqual(['page.removed']);
    expect(await bob.store.getPage(a.id)).toBeNull();
    expect(await bob.store.quarantine(ws.id)).toMatchObject([
      { pageId: a.id, reason: 'page.removed' },
    ]);
  });
});

describe('access granted and revoked while a device is offline', () => {
  it('granted: the subtree arrives, nothing missing', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { one, ws, a, b, section } = await sharedWorkspace(server);
    server.addMember(ws.id, BOB.id);
    server.revoke(ws.id, a.id, BOB.id);
    const bob = device(server, BOB);
    await bob.engine.syncOnce();
    expect(await bob.store.getPage(a.id)).toBeNull();
    // Bob is away; Alice works in the subtree, then gives Bob access to it.
    await one.store.applyLocalOps([newOp('page.update', ws.id, b.id, { title: 'Beta renamed' })]);
    const child = pageRecord(ws.id, section.id, 'New under Alpha', a.id, 'a5');
    await one.store.applyLocalOps([newOp('page.create', ws.id, child.id, child)]);
    await type(one.store, child.id, 'hello');
    await sync(one);
    server.grant(ws.id, a.id, BOB.id);
    await sync(bob);
    expect((await bob.store.getPage(b.id))!.title).toBe('Beta renamed');
    expect(await bob.store.getPage(child.id)).not.toBeNull();
    expect(await mirrorShape(bob.store, ws.id)).toEqual(await serverShape(server, BOB, ws.id));
    await bob.engine.pullPage(child.id);
    expect(await hashOf(bob, child.id)).toBe(await fakeCodec.stateHash(server.docParts(child.id)));
  });

  it('revoked: the subtree goes, its unsent edits set aside, nothing stale, nothing of it sent', async () => {
    const { server, one, bob, ws, a, b } = await twoPeople();
    await type(one.store, a.id, 'before');
    await sync(one);
    await bob.engine.pullPage(a.id);
    // Offline, Bob types in Alpha and renames Beta; meanwhile his access to Alpha goes.
    await type(bob.store, a.id, 'written offline', 72);
    await bob.store.applyLocalOps([newOp('page.update', ws.id, b.id, { title: 'Bob’s Beta' })]);
    server.revoke(ws.id, a.id, BOB.id);
    await sync(bob);
    expect(await mirrorShape(bob.store, ws.id)).toEqual(await serverShape(server, BOB, ws.id));
    expect(await bob.store.getPage(a.id)).toBeNull();
    expect(await bob.store.getPage(b.id)).toBeNull();
    expect(bob.notices()).toContain('access.denied');
    expect(await bob.store.quarantine(ws.id)).toMatchObject([
      { pageId: a.id, reason: 'access.denied', status: 'pending' },
    ]);
    expect(await bob.store.nextOutboxBatch(10, ws.id)).toEqual([]);
    expect(server.spaces.get(ws.id)!.mirror.pages.get(b.id)!.title).toBe('Beta');
    expect(server.docs.get(a.id)!.rows).toHaveLength(1);
  });

  it('granted then revoked, and revoked then granted, while away: what the server shows, exactly', async () => {
    const { server, one, bob, ws, a, c } = await twoPeople();
    server.revoke(ws.id, a.id, BOB.id);
    server.grant(ws.id, a.id, BOB.id);
    server.revoke(ws.id, c.id, BOB.id);
    await one.store.applyLocalOps([newOp('page.update', ws.id, c.id, { title: 'Gamma renamed' })]);
    await sync(one);
    server.grant(ws.id, c.id, BOB.id);
    server.revoke(ws.id, a.id, BOB.id);
    await sync(bob);
    expect(await mirrorShape(bob.store, ws.id)).toEqual(await serverShape(server, BOB, ws.id));
    expect(await bob.store.getPage(a.id)).toBeNull();
    expect((await bob.store.getPage(c.id))!.title).toBe('Gamma renamed');
    server.grant(ws.id, a.id, BOB.id);
    await sync(bob);
    expect(await mirrorShape(bob.store, ws.id)).toEqual(await serverShape(server, BOB, ws.id));
    expect(await mirrorShape(bob.store, ws.id)).toEqual(await mirrorShape(one.store, ws.id));
  });
});

// Databases (Phase 4) ------------------------------------------------------------------------------

/** `twoPeople` with Alice's tasks database under Alpha (its view, three rows), held by both. */
async function twoOnTasks() {
  const people = await twoPeople();
  const made = await makeDatabase(people.one.store, people.ws.id, people.section.id, people.a.id);
  await sync(people.one, people.bob);
  await people.bob.engine.holdDatabase(made.db.id);
  await sync(people.bob);
  return { ...people, ...made };
}

const rowOf = async (d: Device, id: Id) => (await d.store.getPage(id)) as RowRecord;

const recordOf = async (d: Device, workspaceId: Id, databaseId: Id) =>
  (await d.store.readMirror(workspaceId)).databases.find((x) => x.id === databaseId)!;

const defOf = (id: Id) => TASK_PROPS.find((p) => p.id === id)!;

const rowUpdate = (ws: Id, rowId: Id, values: Record<string, unknown>) =>
  newOp('row.update', ws, rowId, { values } as never);

/** Each device holds exactly what the server holds of the database: its record and its rows. */
async function converged(server: FakeServer, ws: Id, db: Id, ...devices: Device[]) {
  const rows = await serverRows(server, ALICE, db);
  const record = server.spaces.get(ws)!.mirror.databases.get(db)!;
  for (const d of devices) {
    expect(await heldRows(d.store, db)).toEqual(rows);
    expect(await recordOf(d, ws, db)).toEqual(record);
  }
}

describe('Database rows (SYNC_DESIGN.md, Metadata; contract section 2)', () => {
  it('two edits to different properties of one row: both stand, and no one is told', async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    const r = rows[0].id;
    await one.store.applyLocalOps([rowUpdate(ws.id, r, { [PROP.notes]: 'Alice' })]);
    await bob.store.applyLocalOps([rowUpdate(ws.id, r, { [PROP.done]: true })]);
    await sync(one, bob, one);
    expect(serverRow(server, r)).toMatchObject({
      values: { [PROP.count]: 1, [PROP.notes]: 'Alice', [PROP.done]: true },
      versions: { [PROP.count]: 1, [PROP.notes]: 1, [PROP.done]: 1 },
      version: 3,
    });
    await converged(server, ws.id, db.id, one, bob);
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it("two edits to the same property: the last to reach the server wins, and the property's version rises", async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    const r = rows[0].id;
    await one.store.applyLocalOps([rowUpdate(ws.id, r, { [PROP.count]: 10 })]);
    await bob.store.applyLocalOps([rowUpdate(ws.id, r, { [PROP.count]: 20 })]);
    await sync(one, bob, one);
    expect(serverRow(server, r)).toMatchObject({
      values: { [PROP.count]: 20 },
      versions: { [PROP.count]: 3 },
    });
    expect((await rowOf(one, r)).values[PROP.count]).toBe(20);
    await converged(server, ws.id, db.id, one, bob);
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it('a type change racing an offline edit: the edit lands converted', async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    await one.store.applyLocalOps([rowUpdate(ws.id, rows[1].id, { [PROP.notes]: 'abc' })]);
    await sync(one, bob);
    // Bob, offline, writes "42" as text; Alice meanwhile makes Notes a number.
    await bob.store.applyLocalOps([rowUpdate(ws.id, rows[0].id, { [PROP.notes]: '42' })]);
    const number: PropertyDef = {
      ...defOf(PROP.notes),
      type: 'number',
      number: { format: 'number', decimals: null },
    };
    await one.store.applyLocalOps([newOp('db.update', ws.id, db.id, { properties: [number] })]);
    await sync(one, bob, one);
    expect(serverRow(server, rows[0].id)!.values[PROP.notes]).toBe(42);
    // Every row the server has was converted: text that is no number is cleared.
    expect(serverRow(server, rows[1].id)!.values[PROP.notes]).toBeUndefined();
    const notes = (await recordOf(bob, ws.id, db.id)).properties.find((p) => p.id === PROP.notes);
    expect(notes).toMatchObject({ type: 'number' });
    await converged(server, ws.id, db.id, one, bob);
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it('a property deleted while another person edits it: the row and its value stay, hidden until restored', async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    const r = rows[0].id;
    const notes = defOf(PROP.notes);
    await one.store.applyLocalOps([
      newOp('db.update', ws.id, db.id, {
        properties: [{ ...notes, trashedAt: new Date().toISOString() }],
      }),
    ]);
    await sync(one);
    await bob.store.applyLocalOps([rowUpdate(ws.id, r, { [PROP.notes]: 'kept', [PROP.count]: 7 })]);
    await sync(bob, one);
    expect(serverRow(server, r)!.values).toMatchObject({ [PROP.notes]: 'kept', [PROP.count]: 7 });
    await converged(server, ws.id, db.id, one, bob);
    const row = await rowOf(bob, r);
    expect(cellValue(await recordOf(bob, ws.id, db.id), row, PROP.notes)).toBeNull();
    expect(cellValue(await recordOf(bob, ws.id, db.id), row, PROP.count)).toBe(7);
    await one.store.applyLocalOps([
      newOp('db.update', ws.id, db.id, { properties: [{ ...notes, trashedAt: null }] }),
    ]);
    await sync(one, bob);
    const restored = await recordOf(bob, ws.id, db.id);
    expect(cellValue(restored, await rowOf(bob, r), PROP.notes)).toBe('kept');
    await converged(server, ws.id, db.id, one, bob);
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it('an option deleted while another person sets it: the value reads as empty', async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    await one.store.applyLocalOps([rowUpdate(ws.id, rows[1].id, { [PROP.stage]: STAGE.open })]);
    await sync(one, bob);
    const stage = defOf(PROP.stage);
    await one.store.applyLocalOps([
      newOp('db.update', ws.id, db.id, {
        properties: [{ ...stage, options: stage.options!.filter((o) => o.id !== STAGE.open) }],
      }),
    ]);
    await bob.store.applyLocalOps([rowUpdate(ws.id, rows[0].id, { [PROP.stage]: STAGE.open })]);
    await sync(one, bob, one);
    // Written after the delete: coerced away. Written before: the id stays, and reads as empty.
    expect(serverRow(server, rows[0].id)!.values[PROP.stage]).toBeUndefined();
    expect(serverRow(server, rows[1].id)!.values[PROP.stage]).toBe(STAGE.open);
    await converged(server, ws.id, db.id, one, bob);
    const record = await recordOf(bob, ws.id, db.id);
    const held = await bob.store.readRows(db.id);
    for (const row of held) expect(cellValue(record, row, PROP.stage)).toBeNull();
    const empty = queryRows(
      record,
      held,
      {
        filter: {
          kind: 'group',
          op: 'and',
          children: [{ kind: 'condition', propertyId: PROP.stage, operator: 'isEmpty' }],
        },
        sorts: [],
        group: null,
      },
      { today: '2026-11-12', offsetMinutes: 0, me: null },
    );
    expect(empty.rows).toHaveLength(3);
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it('relations are kept in step across people, both ways, offline edits included', async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    const [r0, r1, r2] = rows.map((r) => r.id);
    await one.store.applyLocalOps([rowUpdate(ws.id, r0, { [PROP.link]: [r1] })]);
    await bob.store.applyLocalOps([rowUpdate(ws.id, r2, { [PROP.link]: [r1] })]);
    await sync(one, bob, one);
    expect(serverRow(server, r1)!.values[PROP.back]).toEqual([r0, r2]);
    await converged(server, ws.id, db.id, one, bob);
    // Bob points One at Three instead; Alice, offline, unlinks Three from Two.
    await bob.store.applyLocalOps([rowUpdate(ws.id, r0, { [PROP.link]: [r2] })]);
    await one.store.applyLocalOps([rowUpdate(ws.id, r2, { [PROP.link]: null })]);
    await sync(bob, one, bob);
    expect(serverRow(server, r0)!.values[PROP.link]).toEqual([r2]);
    expect(serverRow(server, r2)!.values[PROP.back]).toEqual([r0]);
    expect(serverRow(server, r1)!.values[PROP.back]).toBeUndefined();
    expect(serverRow(server, r2)!.values[PROP.link]).toBeUndefined();
    await converged(server, ws.id, db.id, one, bob);
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });

  it("a row edit the server refuses (the row was trashed) takes the server's row, and the user is told", async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    const r = rows[1].id;
    await one.store.applyLocalOps([
      newOp('page.trash', ws.id, r, {}, (await rowOf(one, r)).version),
    ]);
    await sync(one);
    await bob.store.applyLocalOps([rowUpdate(ws.id, r, { [PROP.count]: 9 })]);
    await sync(bob);
    expect(bob.notices()).toEqual(['page.trashed']);
    expect(await rowOf(bob, r)).toMatchObject({ trashRootId: r, values: { [PROP.count]: 2 } });
    await converged(server, ws.id, db.id, one, bob);
  });

  it("a database change the server refuses (the database was trashed) takes the server's record; its rows went with it", async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    await one.store.applyLocalOps([
      newOp('page.trash', ws.id, db.id, {}, (await one.store.getPage(db.id))!.version),
    ]);
    await sync(one);
    await bob.store.applyLocalOps([
      newOp('db.update', ws.id, db.id, {
        properties: [{ id: 'Extra001', name: 'Extra', type: 'text' }],
      }),
    ]);
    await sync(bob);
    expect(bob.notices()).toEqual(['page.trashed']);
    const record = await recordOf(bob, ws.id, db.id);
    expect(record.properties.map((p) => p.id)).not.toContain('Extra001');
    expect((await bob.store.getPage(db.id))!.trashedAt).not.toBeNull();
    // On the server the rows were trashed with their database, and come back with it.
    for (const r of rows) expect(serverRow(server, r.id)).toMatchObject({ trashRootId: db.id });
    await sync(one);
    await converged(server, ws.id, db.id, one, bob);
    await one.store.applyLocalOps([newOp('page.restore', ws.id, db.id, {})]);
    await sync(one, bob);
    for (const r of rows) expect(serverRow(server, r.id)).toMatchObject({ trashedAt: null });
    await converged(server, ws.id, db.id, one, bob);
  });

  // Found by the simulator: a refused operation's answer carries its own entity only, but the
  // planner here had already changed other records with it.
  it('a refused relation edit: the rows it relinked here are taken again from the server', async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    // One goes to the trash; Bob, offline, makes One block Two.
    await one.store.applyLocalOps([
      newOp('page.trash', ws.id, rows[0].id, {}, (await rowOf(one, rows[0].id)).version),
    ]);
    await sync(one);
    await bob.store.applyLocalOps([rowUpdate(ws.id, rows[0].id, { [PROP.link]: [rows[1].id] })]);
    // Kept in step here at once: Two is blocked by One.
    expect((await rowOf(bob, rows[1].id)).values[PROP.back]).toEqual([rows[0].id]);
    await sync(bob);
    expect(bob.notices()).toEqual(['page.trashed']);
    expect((await rowOf(bob, rows[1].id)).values[PROP.back]).toBeUndefined();
    await converged(server, ws.id, db.id, one, bob);
  });

  it('a refused type change: the rows it converted here are taken again from the server', async () => {
    const { server, one, bob, ws, db, rows } = await twoOnTasks();
    // The rows go to the trash one by one, Bob sees that; then the database (which then trashes
    // no row), which Bob does not see before he changes a type.
    await one.store.applyLocalOps(
      await Promise.all(
        rows.map(async (r) =>
          newOp('page.trash', ws.id, r.id, {}, (await rowOf(one, r.id)).version),
        ),
      ),
    );
    await sync(one, bob);
    await one.store.applyLocalOps([
      newOp('page.trash', ws.id, db.id, {}, (await one.store.getPage(db.id))!.version),
    ]);
    await sync(one);
    await bob.store.applyLocalOps([
      newOp('db.update', ws.id, db.id, { properties: [{ ...defOf(PROP.count), type: 'text' }] }),
    ]);
    expect((await rowOf(bob, rows[0].id)).values[PROP.count]).toBe('1');
    await sync(bob);
    expect(bob.notices()).toEqual(['page.trashed']);
    for (const [i, r] of rows.entries())
      expect((await rowOf(bob, r.id)).values[PROP.count]).toBe(i + 1);
    await converged(server, ws.id, db.id, one, bob);
  });

  it('a refused relation to another database: the reverse property made there is taken back', async () => {
    const { server, one, bob, ws, section, db } = await twoOnTasks();
    const projects = await makeDatabase(one.store, ws.id, section.id, null, ['P'], 'Projects');
    await sync(one, bob);
    await one.store.applyLocalOps([
      newOp('page.trash', ws.id, db.id, {}, (await one.store.getPage(db.id))!.version),
    ]);
    await sync(one);
    const relation: PropertyDef = {
      id: 'Proj0001',
      name: 'Project',
      type: 'relation',
      relation: { databaseId: projects.db.id, reversePropertyId: 'Task0001' },
    };
    await bob.store.applyLocalOps([newOp('db.update', ws.id, db.id, { properties: [relation] })]);
    const ids = async () =>
      (await recordOf(bob, ws.id, projects.db.id)).properties.map((p) => p.id);
    expect(await ids()).toContain('Task0001');
    await sync(bob);
    expect(bob.notices()).toEqual(['page.trashed']);
    expect(await ids()).not.toContain('Task0001');
    expect(await recordOf(bob, ws.id, projects.db.id)).toEqual(
      server.spaces.get(ws.id)!.mirror.databases.get(projects.db.id),
    );
  });

  it('a row made offline in a database trashed meanwhile: refused, removed here, and the user is told', async () => {
    const { server, one, bob, ws, section, db } = await twoOnTasks();
    await one.store.applyLocalOps([
      newOp('page.trash', ws.id, db.id, {}, (await one.store.getPage(db.id))!.version),
    ]);
    await sync(one);
    const late = rowCreate(ws.id, section.id, db.id, 'Late', { [PROP.count]: 4 }, 'b0');
    await bob.store.applyLocalOps([newOp('page.create', ws.id, late.id, late)]);
    await sync(bob);
    expect(bob.notices()).toEqual(['page.trashed']);
    expect(await bob.store.getPage(late.id)).toBeNull();
    expect(serverRow(server, late.id)).toBeUndefined();
    await converged(server, ws.id, db.id, one, bob);
  });

  it('two people change one view: the last to reach the server wins', async () => {
    const { server, one, bob, ws, view } = await twoOnTasks();
    await one.store.applyLocalOps([
      newOp('view.upsert', ws.id, view.id, { ...view, name: 'By Alice' }),
    ]);
    await bob.store.applyLocalOps([
      newOp('view.upsert', ws.id, view.id, { ...view, name: 'By Bob' }),
    ]);
    await sync(one, bob, one);
    const there = server.spaces.get(ws.id)!.mirror.views.get(view.id)!;
    expect(there).toMatchObject({ name: 'By Bob', version: 3 });
    for (const d of [one, bob])
      expect((await d.store.readMirror(ws.id)).views.find((v) => v.id === view.id)).toEqual(there);
    expect([...one.notices(), ...bob.notices()]).toEqual([]);
  });
});

describe('access to a database granted and revoked while a device is offline', () => {
  it('revoked: the database, its views and rows go, an offline edit of a row is not sent; granted, it all comes back', async () => {
    const { server, one, bob, ws, db, view, rows } = await twoOnTasks();
    await bob.store.applyLocalOps([rowUpdate(ws.id, rows[0].id, { [PROP.notes]: 'Bob offline' })]);
    server.revoke(ws.id, db.id, BOB.id);
    await sync(bob);
    expect(await bob.store.getPage(db.id)).toBeNull();
    expect(await bob.store.readRows(db.id)).toEqual([]);
    expect(await bob.store.dbHold(db.id)).toBeNull();
    expect((await bob.store.readMirror(ws.id)).databases).toEqual([]);
    expect((await bob.store.readMirror(ws.id)).views).toEqual([]);
    expect(await bob.store.nextOutboxBatch(10, ws.id)).toEqual([]);
    expect(bob.notices()).toEqual(['not.found']);
    expect(serverRow(server, rows[0].id)!.values[PROP.notes]).toBeUndefined();
    expect(await mirrorShape(bob.store, ws.id)).toEqual(await serverShape(server, BOB, ws.id));

    // Alice works in it meanwhile; then Bob may see it again.
    await one.store.applyLocalOps([rowUpdate(ws.id, rows[1].id, { [PROP.notes]: 'while away' })]);
    await sync(one);
    server.grant(ws.id, db.id, BOB.id);
    await sync(bob);
    expect((await bob.store.readMirror(ws.id)).views.map((v) => v.id)).toEqual([view.id]);
    await bob.engine.holdDatabase(db.id);
    await sync(bob);
    expect(await heldRows(bob.store, db.id)).toEqual(await serverRows(server, BOB, db.id));
    await converged(server, ws.id, db.id, one, bob);
  });

  it("edit access removed while offline: the row edit is refused with the server's row, and held rows come again at the new level", async () => {
    const { server, bob, ws, db, rows } = await twoOnTasks();
    await bob.store.applyLocalOps([rowUpdate(ws.id, rows[0].id, { [PROP.count]: 99 })]);
    server.demote(ws.id, BOB.id);
    const fetched = server.calls.filter((c) => c === 'rows').length;
    await sync(bob);
    expect(bob.notices()).toEqual(['access.denied']);
    expect((await rowOf(bob, rows[0].id)).values[PROP.count]).toBe(1);
    expect(server.calls.filter((c) => c === 'rows').length).toBeGreaterThan(fetched);
    expect(await bob.store.dbHold(db.id)).toMatchObject({ mode: 'full', complete: true });
    for (const row of await bob.store.readRows(db.id)) expect(row.access).toBe('view');
    expect(await bob.store.nextOutboxBatch(10, ws.id)).toEqual([]);
  });
});
