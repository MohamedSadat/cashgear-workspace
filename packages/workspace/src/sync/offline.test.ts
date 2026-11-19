// Phase 3's sync loop against the fake server: signed in with no network, 401 pauses, backoff
// with `Retry-After`, resume after sleep, long outboxes in batches, the feed past its retention,
// the state-hash repair path, updates the worker refuses (repaired, or kept aside), and pins;
// from Phase 12 the pinned databases' rows' documents, by the batch pull.
import { describe, expect, it, vi } from 'vitest';
import { newOp } from '../build';
import { uuidv7, type Id } from '../ids';
import { MemoryStore } from '../memory';
import { decode, fakeCodec, fakeUpdate, FakeServer } from '../testing/fakeServer';
import {
  ALICE,
  device,
  localWorkspace,
  makeDatabase,
  PROP,
  mirrorShape,
  pageRecord,
  serverShape,
  sharedWorkspace,
  VirtualClock,
  type Device,
} from '../testing/syncHarness';
import type { StoredUpdate } from '../types';
import { OfflineError, SyncHttpError, type DocCodec, type SyncApi } from './api';
import { ACCOUNT_PREF, pushBatches, PUSH_LIMITS } from './engine';

const update = (bytes: number, client = 7) => {
  // A fake update of about `bytes` bytes.
  const head = fakeUpdate(client, '');
  return bytes > head.byteLength ? fakeUpdate(client, 'x'.repeat(bytes - head.byteLength)) : head;
};

const append = (store: MemoryStore, pageId: Id, data: Uint8Array[]) =>
  store.appendDocUpdates(
    pageId,
    data.map((d) => ({ updateId: uuidv7(), data: d })),
  );

describe('signed in with no network', () => {
  it('keeps the account (no credential) for the next start, and forgets it on sign-out', async () => {
    const server = new FakeServer();
    const one = device(server);
    await one.engine.idle();
    await one.store.close();
    expect(await one.engine.cachedAccount()).toEqual(ALICE);
    expect(Object.keys((await one.store.getPref<object>(ACCOUNT_PREF))!).sort()).toEqual([
      'deviceId',
      'displayName',
      'email',
      'id',
    ]);
    one.engine.setAccount(null);
    await one.store.close();
    expect(await one.engine.cachedAccount()).toBeNull();
  });

  it('never shows a report that a later one overtook (signed out at start, then signed in)', async () => {
    const server = new FakeServer();
    server.offline = true;
    // The first read of the mirror is slow: the sign-out's report finishes after the sign-in's.
    let slow = true;
    class SlowStore extends MemoryStore {
      override async readMirror(...args: Parameters<MemoryStore['readMirror']>) {
        if (slow) {
          slow = false;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return super.readMirror(...args);
      }
    }
    const again = device(server, ALICE, { store: new SlowStore(), signIn: false });
    const seen: string[] = [];
    again.engine.onStatus((s) => seen.push(s.state));
    again.engine.setAccount(null);
    again.engine.setAccount(ALICE, { offline: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await again.engine.idle();
    expect(again.engine.status.state).toBe('offline');
    expect(seen).not.toContain('signedOut');
  });

  it('starts offline with the cached account, says what waits, then syncs with no action', async () => {
    const server = new FakeServer();
    const { one, ws, a } = await sharedWorkspace(server);
    // The app closes; the network goes; the app starts again on the same store.
    server.offline = true;
    const again = device(server, ALICE, { store: one.store, signIn: false });
    const cached = await again.engine.cachedAccount();
    expect(cached).toEqual(ALICE);
    // Offline: a page is created and a document edited.
    const made = pageRecord(ws.id, a.sectionId, 'Made offline', null, 'a5');
    await again.store.applyLocalOps([newOp('page.create', ws.id, made.id, made)]);
    await append(again.store, made.id, [fakeUpdate(41, 'typed offline')]);
    await append(again.store, a.id, [fakeUpdate(41, 'more')]);
    again.engine.setAccount(cached, { offline: true });
    await again.store.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(again.engine.status).toMatchObject({ state: 'offline', waiting: 3 });
    await expect(again.engine.syncOnce()).rejects.toThrow();
    expect(again.engine.status).toMatchObject({ state: 'offline', waiting: 3 });
    // Another edit while offline: the count goes up at once.
    again.engine.changed();
    expect(again.engine.status).toMatchObject({ state: 'offline', waiting: 4 });

    server.offline = false;
    await again.engine.syncOnce();
    await again.engine.syncOnce();
    expect(again.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    expect(server.docs.get(made.id)!.rows).toHaveLength(1);
    expect(await mirrorShape(again.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
  });

  it('pauses on 401 with the waiting count still given, discards nothing, and resumes on sign-in', async () => {
    const server = new FakeServer();
    const clock = new VirtualClock();
    const { one, ws, a } = await sharedWorkspace(server);
    const two = device(server, ALICE, { store: one.store, ...clock });
    two.engine.start();
    await clock.advance(two.engine, 0);
    await two.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Renamed' })]);
    await append(two.store, a.id, [fakeUpdate(42, 'x'), fakeUpdate(42, 'y')]);
    server.expire(ALICE.id);
    two.engine.kick(0);
    await clock.advance(two.engine, 0);
    expect(two.engine.status).toMatchObject({ state: 'signedOut', waiting: 3 });
    expect(two.engine.signedIn).toBeNull();
    // Paused: no pass is scheduled, and a local change does not start one.
    const calls = server.calls.length;
    two.engine.changed();
    expect(two.engine.status).toMatchObject({ state: 'signedOut', waiting: 4 });
    await clock.advance(two.engine, 10 * 60_000);
    expect(server.calls.length).toBe(calls);
    expect(await two.store.nextOutboxBatch(10, ws.id)).toHaveLength(1);
    expect((await two.store.unsentDocUpdates(10))[0].updates).toHaveLength(2);
    expect(await two.engine.cachedAccount()).toEqual(ALICE);

    server.renew(ALICE.id);
    two.engine.setAccount(ALICE);
    await clock.advance(two.engine, 1000);
    expect(two.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    expect(server.spaces.get(ws.id)!.mirror.pages.get(a.id)!.title).toBe('Renamed');
    two.engine.stop();
  });
});

describe('backoff and sleep', () => {
  it('backs off exponentially with jitter, capped at 5 minutes', async () => {
    const server = new FakeServer();
    const clock = new VirtualClock();
    const { one } = await sharedWorkspace(server);
    const two = device(server, ALICE, { store: one.store, ...clock });
    server.offline = true;
    two.engine.start();
    const gaps: number[] = [];
    let last = clock.t;
    let calls = server.calls.length;
    for (let i = 0; i < 12; i++) {
      // Fire timers until a pass reaches the server again.
      while (server.calls.length === calls) await clock.fireNext(two.engine);
      calls = server.calls.length;
      gaps.push(clock.t - last);
      last = clock.t;
    }
    // Jitter 0.5 + random() with random 0.5: exactly 1 s, 2 s, 4 s, ... up to 5 minutes.
    expect(gaps.slice(1)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
    ]);
    two.engine.stop();
  });

  it("waits at least the server's Retry-After, even when kicked", async () => {
    const server = new FakeServer();
    const clock = new VirtualClock();
    const { one, a } = await sharedWorkspace(server);
    const two = device(server, ALICE, { store: one.store, ...clock });
    two.engine.start();
    await clock.advance(two.engine, 0);
    await append(two.store, a.id, [fakeUpdate(43, 'x')]);
    server.throttle('pushDoc', 45_000);
    two.engine.kick(0);
    await clock.advance(two.engine, 0);
    expect(two.engine.status.state).toBe('error');
    const pushes = () => server.calls.filter((c) => c === 'pushDoc').length;
    const tried = pushes();
    // The network returns, the window gains focus: still not before 45 s.
    two.engine.kick(0);
    await clock.advance(two.engine, 44_000);
    expect(pushes()).toBe(tried);
    await clock.advance(two.engine, 2000);
    expect(pushes()).toBe(tried + 1);
    expect(two.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    expect(server.docs.get(a.id)!.rows.length).toBeGreaterThan(0);
    two.engine.stop();
  });

  it('runs a pass at once, with the backoff reset, when a timer fires long after it was set (sleep)', async () => {
    const server = new FakeServer();
    const clock = new VirtualClock();
    const { one, a } = await sharedWorkspace(server);
    const two = device(server, ALICE, { store: one.store, ...clock });
    server.offline = true;
    two.engine.start();
    // Offline long enough for a five-minute backoff.
    while (clock.t < Date.UTC(2026, 10, 12, 9, 20)) await clock.fireNext(two.engine);
    await append(two.store, a.id, [fakeUpdate(44, 'typed before sleeping')]);
    // The lid closes for three hours; the network is back when it opens.
    clock.jump(3 * 3600_000);
    server.offline = false;
    const calls = server.calls.length;
    await clock.fireNext(two.engine);
    expect(server.calls.length).toBeGreaterThan(calls);
    expect(two.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    // The backoff was reset: the next pass is the ordinary interval away.
    expect(clock.next! - clock.t).toBe(1500);
    two.engine.stop();
  });
});

describe('long outboxes', () => {
  it('splits a page into batches the server takes: 200 updates, 4 MB, an update over 1 MB alone', () => {
    const at = (size: number, i: number): StoredUpdate => ({
      updateId: `u${i}`,
      data: new Uint8Array(size),
      localSeq: i,
      seq: null,
    });
    const small = Array.from({ length: 450 }, (_, i) => at(10, i));
    expect(pushBatches(small).map((b) => b.length)).toEqual([200, 200, 50]);
    const big = Array.from({ length: 10 }, (_, i) => at(900 * 1024, i));
    expect(pushBatches(big).map((b) => b.length)).toEqual([4, 4, 2]);
    const mixed = [at(10, 1), at(PUSH_LIMITS.alone + 1, 2), at(10, 3), at(10, 4)];
    expect(pushBatches(mixed).map((b) => b.map((u) => u.localSeq))).toEqual([[1], [2], [3, 4]]);
    for (const batch of pushBatches([...big, ...small, ...mixed]))
      expect(
        batch.length === 1 ||
          (batch.length <= 200 && batch.reduce((n, u) => n + u.data.byteLength, 0) <= 4 << 20),
      ).toBe(true);
  });

  it('sends 1,000 waiting updates across 50 pages in batches on reconnect, nothing twice', async () => {
    const server = new FakeServer();
    // The 30th push's answer is lost: what was answered before it stays answered.
    let pushes = 0;
    let lostBatch = 0;
    const one = device(server, ALICE, {
      api: (base) => ({
        pushDoc: async (pageId, request) => {
          if (++pushes === 30) {
            lostBatch = request.updates.length;
            server.lose('pushDoc');
          }
          return base.pushDoc(pageId, request);
        },
      }),
    });
    const { ws, section } = await localWorkspace(one.store);
    const pages = Array.from({ length: 50 }, (_, i) =>
      pageRecord(ws.id, section.id, `P${i}`, null, `b${String(i).padStart(2, '0')}`),
    );
    await one.store.applyLocalOps(pages.map((p) => newOp('page.create', ws.id, p.id, p)));
    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    expect(pushes).toBe(0);
    // Offline for a while: 20 updates on each of 50 pages, six of them large on every tenth page.
    for (const [i, page] of pages.entries())
      await append(
        one.store,
        page.id,
        Array.from({ length: 20 }, (_, j) => update(i % 10 === 0 && j < 6 ? 700_000 : 2000)),
      );
    const started = performance.now();
    await expect(one.engine.syncOnce()).rejects.toThrow();
    const waiting = (await one.store.unsentDocUpdates(5000)).reduce(
      (n, d) => n + d.updates.length,
      0,
    );
    expect(waiting).toBeGreaterThan(0);
    expect(waiting).toBeLessThan(1000);
    await one.engine.syncOnce();
    const elapsed = performance.now() - started;
    expect(await one.store.unsentDocUpdates(5000)).toEqual([]);
    expect(pages.reduce((n, p) => n + server.docs.get(p.id)!.rows.length, 0)).toBe(1000);
    // Requests the server takes; a page's large updates went in more than one.
    for (const push of server.pushes) {
      expect(push.count).toBeLessThanOrEqual(200);
      expect(push.bytes).toBeLessThanOrEqual(4 << 20);
    }
    expect(server.pushes.length).toBe(45 + 5 * 2 + 1);
    // Nothing restarted from zero: only the batch whose answer was lost went twice.
    expect(server.pushes.reduce((n, p) => n + p.count, 0)).toBe(1000 + lostBatch);
    expect(elapsed).toBeLessThan(30_000);
    expect(one.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
  });

  it('refuses only an update over 1 MB, alone, and sends the rest', async () => {
    const server = new FakeServer();
    const { one, a } = await sharedWorkspace(server);
    await append(one.store, a.id, [update(1000), update(PUSH_LIMITS.alone + 10), update(1000)]);
    await one.engine.syncOnce();
    expect(one.notices()).toContain('limit.size');
    expect(server.docs.get(a.id)!.rows).toHaveLength(2);
    expect(one.store.corruptUpdates().map((c) => c.reason)).toEqual(['limit.size']);
    expect(await one.store.unsentDocUpdates(10)).toEqual([]);
  });

  it('a long outbox goes on from where it stopped, pass after pass', async () => {
    const server = new FakeServer();
    const { one, a } = await sharedWorkspace(server);
    await append(
      one.store,
      a.id,
      Array.from({ length: 2400 }, () => update(50)),
    );
    await one.engine.syncOnce();
    // One pass sends at most ten reads' worth; the rest waits for the next, which comes soon.
    const left = (await one.store.unsentDocUpdates(5000)).reduce((n, d) => n + d.updates.length, 0);
    expect(left).toBe(400);
    await one.engine.syncOnce();
    expect(await one.store.unsentDocUpdates(10)).toEqual([]);
    expect(server.docs.get(a.id)!.rows).toHaveLength(2400);
    expect(Math.max(...server.pushes.map((p) => p.count))).toBe(200);
  });
});

describe('the feed past its retention', () => {
  it('takes the whole tree with its cursor on 410 feed.expired, keeping and sending the outbox', async () => {
    const server = new FakeServer();
    const { one, ws, a, b, c, section } = await sharedWorkspace(server);
    const two = device(server);
    await two.engine.syncOnce();
    // One is away; two renames, creates, trashes and deletes; the feed is pruned past one's cursor.
    await two.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'From two' })]);
    const made = pageRecord(ws.id, section.id, 'Two made', null, 'a6');
    await two.store.applyLocalOps([newOp('page.create', ws.id, made.id, made)]);
    await two.store.applyLocalOps([
      newOp('page.trash', ws.id, c.id, {}, (await two.store.getPage(c.id))!.version),
    ]);
    await two.engine.syncOnce();
    await two.store.applyLocalOps([newOp('page.delete', ws.id, c.id, {})]);
    await two.engine.syncOnce();
    server.pruneFeed(ws.id);

    // Meanwhile one made a page and renamed one, written while the feed answers 410.
    const mine = pageRecord(ws.id, section.id, 'One made', null, 'a7');
    const late = device(server, ALICE, {
      store: one.store,
      api: (base) => ({
        changes: async (...args) => {
          if (!(await one.store.getPage(mine.id))) {
            await one.store.applyLocalOps([newOp('page.create', ws.id, mine.id, mine)]);
            await one.store.applyLocalOps([
              newOp('page.update', ws.id, b.id, { title: 'From one' }),
            ]);
          }
          return base.changes(...args);
        },
      }),
    });
    const calls = server.calls.length;
    await late.engine.syncOnce();
    expect(server.calls.slice(calls)).toContain('tree');
    // The whole tree came, and what one wrote is kept, waiting to be sent.
    expect((await one.store.getPage(made.id))?.title).toBe('Two made');
    expect(await one.store.getPage(c.id)).toBeNull();
    expect((await one.store.getPage(mine.id))?.title).toBe('One made');
    expect((await one.store.getPage(b.id))?.title).toBe('From one');
    expect(await one.store.nextOutboxBatch(10, ws.id)).toHaveLength(2);
    await late.engine.syncOnce();
    expect(await one.store.nextOutboxBatch(10, ws.id)).toEqual([]);
    expect(await mirrorShape(one.store, ws.id)).toEqual(await serverShape(server, ALICE, ws.id));
    expect(server.spaces.get(ws.id)!.mirror.pages.get(b.id)!.title).toBe('From one');
    // Later passes read the feed from the tree's cursor.
    await two.engine.syncOnce();
    await late.engine.syncOnce();
    expect(await mirrorShape(two.store, ws.id)).toEqual(await mirrorShape(one.store, ws.id));
  });
});

/** A codec whose server-side hash can be made wrong, for a repair that does not help. */
function hashCodec(wrong: () => boolean): DocCodec {
  return {
    ...fakeCodec,
    stateHash: async (parts) => (wrong() ? 'wrong' : fakeCodec.stateHash(parts)),
  };
}

describe('repair', () => {
  async function twoOnAPage(server: FakeServer) {
    const shared = await sharedWorkspace(server);
    await append(shared.one.store, shared.a.id, [fakeUpdate(51, 'one'), fakeUpdate(51, 'two')]);
    await shared.one.engine.syncOnce();
    const two = device(server);
    await two.engine.syncOnce();
    await two.engine.pullPage(shared.a.id);
    return { ...shared, two };
  }

  it('checks a page once a session when it opens, and finds nothing wrong', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { two, a } = await twoOnAPage(server);
    await two.engine.syncOnce();
    await two.engine.pullPage(a.id);
    await two.engine.syncOnce();
    expect(server.calls.filter((c) => c === 'docStateHash')).toHaveLength(1);
    expect(server.calls).not.toContain('repairDoc');
    expect(await two.store.repairState(a.id)).toMatchObject({ repairs: 0, epoch: 0 });
  });

  it('repairs a page whose state differs from the server at the same head, and says so', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { two, a } = await twoOnAPage(server);
    await two.engine.syncOnce();
    // An update this device acknowledged is missing from its log (say, a bug).
    const lost = (await two.store.loadDoc(a.id)).updates.find((u) => u.seq !== null)!;
    await two.store.quarantineUpdates(a.id, [lost.localSeq], 'test');
    two.engine.suspect(a.id);
    await two.engine.syncOnce();
    expect(server.calls.filter((c) => c === 'repairDoc')).toHaveLength(1);
    // The pull from the start brought it back; the next check, at the repair's head, says so.
    const ids = (await two.store.loadDoc(a.id)).updates.map((u) => u.updateId);
    expect(ids).toContain(lost.updateId);
    expect(await two.store.repairState(a.id)).toMatchObject({ repairs: 1 });
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(two.notices()).toContain('doc.repaired');
    expect(await two.store.repairState(a.id)).toMatchObject({ repairs: 0 });
    expect(server.calls.filter((c) => c === 'repairDoc')).toHaveLength(1);
    const local = await fakeCodec.stateHash(
      (await two.store.loadDoc(a.id)).updates.map((u) => u.data),
    );
    expect(local).toBe(await fakeCodec.stateHash(server.docParts(a.id)));
  });

  it('reports a repair that did not help, and does not repair again', async () => {
    let wrong = false;
    const server = new FakeServer({ codec: hashCodec(() => wrong) });
    const { two, a } = await twoOnAPage(server);
    await two.engine.syncOnce();
    wrong = true;
    two.engine.suspect(a.id);
    for (let i = 0; i < 4; i++) await two.engine.syncOnce();
    expect(server.calls.filter((c) => c === 'repairDoc')).toHaveLength(1);
    expect(two.notices().filter((n) => n === 'doc.repairFailed')).toHaveLength(1);
    // Asked again (the document layer still finds something missing): reported, not repaired.
    two.engine.suspect(a.id);
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(server.calls.filter((c) => c === 'repairDoc')).toHaveLength(1);
    expect(two.notices().filter((n) => n === 'doc.repairFailed')).toHaveLength(2);
  });

  it('a reader repairs by pulling only', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { two, a, ws } = await twoOnAPage(server);
    server.demote(ws.id, ALICE.id);
    await two.engine.syncOnce();
    expect((await two.store.getPage(a.id))?.access).toBe('view');
    const lost = (await two.store.loadDoc(a.id)).updates.find((u) => u.seq !== null)!;
    await two.store.quarantineUpdates(a.id, [lost.localSeq], 'test');
    const sent: (Uint8Array | null)[] = [];
    const reader = device(server, ALICE, {
      store: two.store,
      api: (base) => ({
        repairDoc: async (pageId, request) => {
          sent.push(request.update?.data ?? null);
          return base.repairDoc(pageId, request);
        },
      }),
    });
    await reader.engine.syncOnce();
    reader.engine.suspect(a.id);
    await reader.engine.syncOnce();
    await reader.engine.syncOnce();
    expect(sent).toEqual([null]);
    expect(reader.notices()).toContain('doc.repaired');
  });

  it('waits for the server to compute its hash, and for the heads to meet', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { two, a } = await twoOnAPage(server);
    server.hashPending.add(a.id);
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(await two.store.repairState(a.id)).toBeNull();
    server.hashPending.delete(a.id);
    await two.engine.syncOnce();
    expect(await two.store.repairState(a.id)).toMatchObject({ repairs: 0 });
  });

  it('checks a pinned page after it is refreshed with others’ edits', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { one, two, a } = await twoOnAPage(server);
    await two.engine.syncOnce();
    await two.engine.pin(a.id);
    const before = server.calls.filter((c) => c === 'docStateHash').length;
    await append(one.store, a.id, [fakeUpdate(52, 'three')]);
    await one.engine.syncOnce();
    await two.engine.syncOnce();
    expect(server.calls.filter((c) => c === 'docStateHash').length).toBe(before + 1);
  });
});

describe('updates the worker refuses', () => {
  /**
   * Alice's page as Phase 6's compaction bug left a device: its snapshot holds a key no update
   * carries, so the server never had it, and the worker refuses what refers to it (here, anything
   * that does not carry it, until the server holds it).
   */
  async function broken(server: FakeServer) {
    const shared = await sharedWorkspace(server);
    const { one, a } = shared;
    await append(one.store, a.id, [fakeUpdate(51, 'one')]);
    await one.engine.syncOnce();
    const doc = await one.store.loadDoc(a.id);
    const lost = fakeUpdate(51, ' lost');
    const top = Math.max(doc.snapshotCovers, ...doc.updates.map((u) => u.localSeq));
    const parts = [...(doc.snapshot ? [doc.snapshot] : []), ...doc.updates.map((u) => u.data)];
    await one.store.compactDoc(a.id, fakeCodec.merge([...parts, lost]), top);
    const key = decode(lost).items![0]!;
    const holds = (pageId: Id) =>
      server.docParts(pageId).some((p) => decode(p).items?.includes(key));
    server.refuse((u) => !holds(u.pageId) && !decode(u.data).items?.includes(key));
    return shared;
  }

  /** Whether the server holds everything the device does (the state hash is over items). */
  async function same(server: FakeServer, store: MemoryStore, pageId: Id) {
    const doc = await store.loadDoc(pageId);
    const parts = [...(doc.snapshot ? [doc.snapshot] : []), ...doc.updates.map((u) => u.data)];
    return (
      (await fakeCodec.stateHash(parts)) === (await fakeCodec.stateHash(server.docParts(pageId)))
    );
  }

  it('repairs over HTTP, so what was typed reaches the server, after a stop too', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { one, a } = await broken(server);
    // The first repair finds no network, and the app stops before another pass.
    const first = device(server, ALICE, {
      store: one.store,
      api: () => ({
        repairDoc: async () => {
          throw new OfflineError();
        },
      }),
    });
    await append(one.store, a.id, [fakeUpdate(51, ' after')]);
    await expect(first.engine.syncOnce()).rejects.toThrow(OfflineError);
    const row = server.docs.get(a.id)!.rows.at(-1)!;
    expect([decode(row.data).text, row.refused]).toEqual([' after', true]);
    expect(await same(server, one.store, a.id)).toBe(false);
    // Started again: the refusal was kept, and the repair goes.
    const again = device(server, ALICE, { store: one.store });
    await again.engine.syncOnce();
    expect(server.calls.filter((c) => c === 'repairDoc')).toHaveLength(1);
    expect(await same(server, one.store, a.id)).toBe(true);
    expect(one.store.corruptUpdates()).toEqual([]);
    expect([...first.notices(), ...again.notices()]).toEqual([]);
    expect(again.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    // The next words refer to what the server now holds, and are taken.
    await append(one.store, a.id, [fakeUpdate(51, ' next')]);
    await again.engine.syncOnce();
    expect(server.docs.get(a.id)!.rows.at(-1)!.refused).toBeUndefined();
    expect(await same(server, one.store, a.id)).toBe(true);
    expect(server.calls.filter((c) => c === 'repairDoc')).toHaveLength(1);
  });

  it('counts refused updates as waiting until their repair is taken', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { one, a } = await broken(server);
    // The server answers the repair before its worker has passed it (as the real one does): the
    // answer's validated head is below it, and it is not served yet.
    const late = device(server, ALICE, {
      store: one.store,
      api: (base) => ({
        repairDoc: async (pageId, request) => {
          const answer = await base.repairDoc(pageId, request);
          const head = answer.ack!.seq - 1;
          const updates = answer.pull.updates.filter((u) => u.seq <= head);
          return { ...answer, pull: { ...answer.pull, headSeq: head, cursor: head, updates } };
        },
      }),
    });
    await append(one.store, a.id, [fakeUpdate(51, ' after')]);
    await late.engine.syncOnce();
    expect(late.engine.status).toMatchObject({ state: 'syncing', waiting: 1 });
    // The next pass pulls past the repair, which the worker took: nothing waits.
    await late.engine.syncOnce();
    expect(late.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    expect(server.calls.filter((c) => c === 'repairDoc')).toHaveLength(1);
  });

  it('sends a repair whose answer was lost again under the same id, and the server keeps one', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { one, a } = await broken(server);
    await append(one.store, a.id, [fakeUpdate(51, ' after')]);
    server.lose('repairDoc');
    await expect(one.engine.syncOnce()).rejects.toThrow(OfflineError);
    const again = device(server, ALICE, { store: one.store });
    await again.engine.syncOnce();
    expect(server.calls.filter((c) => c === 'repairDoc')).toHaveLength(2);
    const repairs = server.docs
      .get(a.id)!
      .rows.filter((r) => !r.refused && decode(r.data).text.includes(' lost'));
    expect(repairs).toHaveLength(1);
    expect(await same(server, one.store, a.id)).toBe(true);
    expect(again.notices()).toEqual([]);
  });

  it('keeps aside, as before, what no repair can carry (edit access gone meanwhile)', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const { one, a, ws } = await broken(server);
    const reader = device(server, ALICE, {
      store: one.store,
      api: (base) => ({
        repairDoc: async (pageId, request) => {
          server.demote(ws.id, ALICE.id);
          return base.repairDoc(pageId, request);
        },
      }),
    });
    await append(one.store, a.id, [fakeUpdate(51, ' after')]);
    await reader.engine.syncOnce();
    expect(reader.notices()).toEqual(['doc.refused']);
    expect(one.store.corruptUpdates()).toEqual([
      expect.objectContaining({ pageId: a.id, reason: 'doc.refused' }),
    ]);
    expect(reader.engine.status).toMatchObject({ waiting: 0 });
  });
});

describe('pins', () => {
  it('fetches a pinned page in the background, keeps it fresh, and says what is held', async () => {
    const server = new FakeServer();
    const { one, ws, a, c } = await sharedWorkspace(server);
    await append(one.store, c.id, [fakeUpdate(61, 'gamma')]);
    await one.engine.syncOnce();
    const two = device(server);
    await two.engine.syncOnce();
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ pinned: 0, available: 0 });
    await two.engine.pin(c.id);
    expect(two.events.at(-1)).toEqual({ kind: 'offline', workspaceId: ws.id });
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({
      pinned: 1,
      held: 0,
      toFetch: 1,
    });
    await two.engine.syncOnce();
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({
      pinned: 1,
      held: 1,
      toFetch: 0,
      available: 1,
    });
    expect((await two.engine.availableOffline(ws.id)).has(c.id)).toBe(true);
    expect((await two.engine.availableOffline(ws.id)).has(a.id)).toBe(false);
    expect(
      decode(fakeCodec.merge((await two.store.loadDoc(c.id)).updates.map((u) => u.data))).text,
    ).toBe('gamma');
    // Kept fresh: another device's edit is pulled on the next pass.
    await append(one.store, c.id, [fakeUpdate(61, '!')]);
    await one.engine.syncOnce();
    await two.engine.syncOnce();
    expect(
      decode(fakeCodec.merge((await two.store.loadDoc(c.id)).updates.map((u) => u.data))).text,
    ).toBe('gamma!');
    await two.engine.unpin(c.id);
    expect(await two.engine.pinOf(c.id)).toBeNull();
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ pinned: 0, available: 1 });
  });

  it('holds a 500-page subtree within 2 minutes of passes, in bounded passes, later pages too', async () => {
    const server = new FakeServer();
    const { one, ws, a, section } = await sharedWorkspace(server);
    // 500 pages under Alpha (with Beta, 502 in the subtree), each with a document.
    const pages = Array.from({ length: 500 }, (_, i) =>
      pageRecord(
        ws.id,
        section.id,
        `Under ${i}`,
        i < 20 ? a.id : null,
        `c${String(i).padStart(3, '0')}`,
      ),
    );
    for (let i = 20; i < pages.length; i++) pages[i].parentPageId = pages[i % 20].id;
    await one.store.applyLocalOps(pages.map((p) => newOp('page.create', ws.id, p.id, p)));
    for (const page of pages) await append(one.store, page.id, [fakeUpdate(62, page.title)]);
    for (let i = 0; i < 8; i++) await one.engine.syncOnce();
    expect(await one.store.unsentDocUpdates(10)).toEqual([]);

    const two = device(server);
    await two.engine.syncOnce();
    await two.engine.pin(a.id, true);
    const offline: number[] = [];
    two.engine.on((e) => e.kind === 'offline' && offline.push(1));
    let passes = 0;
    let most = 0;
    while ((await two.engine.offlineProgress(ws.id)).toFetch > 0) {
      const before = server.batchPulls.length;
      await two.engine.syncOnce();
      const requests = server.batchPulls.slice(before);
      most = Math.max(most, requests.length);
      for (const request of requests) expect(request.pages).toBeLessThanOrEqual(100);
      passes++;
      expect(passes).toBeLessThan(80);
    }
    // 2 minutes at a pass every 1.5 s is 80 passes; each pass fetches a bounded number: from
    // Phase 12 two batch pulls of 100 pages, none of them one by one.
    expect(passes).toBeLessThanOrEqual(Math.ceil(502 / 200));
    expect(most).toBeLessThanOrEqual(2);
    expect(server.calls.filter((c) => c === 'pullDoc')).toEqual([]);
    expect(offline.length).toBeGreaterThan(0);
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ pinned: 502, held: 502 });
    expect(await two.engine.pinOf(pages[499].id)).toMatchObject({ inherited: true });

    // A page added under the pinned subtree later is fetched too; a trashed one is not.
    const later = pageRecord(ws.id, section.id, 'Later', pages[3].id, 'a9');
    await one.store.applyLocalOps([newOp('page.create', ws.id, later.id, later)]);
    await append(one.store, later.id, [fakeUpdate(62, 'later')]);
    await one.store.applyLocalOps([
      newOp('page.trash', ws.id, pages[7].id, {}, (await one.store.getPage(pages[7].id))!.version),
    ]);
    await one.engine.syncOnce();
    await one.engine.syncOnce();
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect((await two.engine.availableOffline(ws.id)).has(later.id)).toBe(true);
    // 502 and the later one, less the trashed page and the 24 under it.
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ pinned: 478, toFetch: 0 });
  });
});

// Phase 12 (M12.4): a pinned database holds each of its rows' documents, through the batch pull.
const text = async (store: MemoryStore, pageId: Id) =>
  decode(fakeCodec.merge((await store.loadDoc(pageId)).updates.map((u) => u.data))).text;

/** A document pushed to a page as another device of Alice's would (the feed then says so). */
const pushElsewhere = (server: FakeServer, pageId: Id, words: string) =>
  server.api(ALICE).pushDoc(pageId, {
    epoch: 0,
    clientSchemaVersion: 1,
    updates: [{ updateId: uuidv7(), data: fakeUpdate(70, words) }],
  });

/**
 * Alice's workspace with a database under Alpha whose `count` rows the server made (as an import
 * does), each with a document unless `bare` says not; and a second device of hers that knows the
 * workspace and holds nothing of the database yet.
 */
async function databaseOfRows(
  count: number,
  options: {
    bare?: (i: number) => boolean;
    server?: FakeServer;
    device?: Parameters<typeof device>[2];
  } = {},
) {
  const server = options.server ?? new FakeServer();
  const shared = await sharedWorkspace(server);
  const { ws, section, a, one } = shared;
  const { db } = await makeDatabase(one.store, ws.id, section.id, a.id, []);
  await one.engine.syncOnce();
  const rows = server.seedRows(db.id, count);
  for (const [i, row] of rows.entries())
    if (!options.bare?.(i)) await pushElsewhere(server, row.id, `row ${i}`);
  const two = device(server, ALICE, options.device ?? {});
  await two.engine.syncOnce();
  return { ...shared, server, db: db.id, rows, two };
}

/** Passes until every pinned page and row document is held; the batch pulls each pass made. */
async function untilHeld(two: Device, server: FakeServer, workspaceId: Id) {
  const passes: number[][] = [];
  for (;;) {
    const before = server.batchPulls.length;
    await two.engine.syncOnce();
    passes.push(server.batchPulls.slice(before).map((b) => b.pages));
    const progress = await two.engine.offlineProgress(workspaceId);
    if (!progress.toFetch && !progress.rowsToFetch) return { passes, progress };
    if (passes.length > 200) throw new Error('Never held');
  }
}

/** A device's batch pulls as asked: the pages of each request, in order. */
function askedOf(asked: Id[][]) {
  return (base: SyncApi): Partial<SyncApi> => ({
    pullDocs: async (workspaceId, pages) => {
      asked.push(pages.map((p) => p.pageId));
      return base.pullDocs(workspaceId, pages);
    },
  });
}

describe("pins: a database's rows' documents", { timeout: 60_000 }, () => {
  it('holds every row document of a pinned 5,000-row database in batches of 100, two a pass, rows without one skipped, and caps it at 5,000', async () => {
    const asked: Id[][] = [];
    const bare = (i: number) => i % 50 === 7;
    const { server, ws, db, rows, two } = await databaseOfRows(5000, {
      bare,
      device: { api: askedOf(asked) },
    });
    await two.engine.pin(db);
    const { passes, progress } = await untilHeld(two, server, ws.id);
    expect(progress).toMatchObject({ pinned: 1, held: 1, rows: 4900, rowsHeld: 4900 });
    // The database's own page first (it is pinned), then 4,900 documents: 50 requests of at most
    // 100 pages, at most two a pass, nothing one by one, nothing twice.
    expect(asked[0][0]).toBe(db);
    expect(asked.flat()).toHaveLength(4901);
    expect(new Set(asked.flat()).size).toBe(4901);
    expect(asked).toHaveLength(50);
    expect(Math.max(...asked.map((a) => a.length))).toBe(100);
    expect(Math.max(...passes.map((p) => p.length))).toBeLessThanOrEqual(2);
    expect(passes.length).toBeLessThanOrEqual(26);
    expect(server.calls.filter((c) => c === 'pullDoc')).toEqual([]);
    // Rows without a document are never asked for, and are not held.
    const without = rows.filter((_, i) => bare(i)).map((r) => r.id);
    expect(asked.flat().filter((id) => without.includes(id))).toEqual([]);
    const held = await two.engine.availableOffline(ws.id);
    expect(without.filter((id) => held.has(id))).toEqual([]);
    // In the database's row order.
    expect(asked[0].slice(1, 4)).toEqual(rows.slice(0, 3).map((r) => r.id));
    // Offline, each opens from the store.
    server.offline = true;
    expect(await text(two.store, rows[0].id)).toBe('row 0');
    expect(await text(two.store, rows[4999].id)).toBe('row 4999');
    server.offline = false;

    // Past 5,000 rows the database is held in part, and its documents are capped: those of its
    // first 5,000 rows with one, in its order, that this device holds. 110 more rows with
    // documents come last: the first 100 are fetched, the last ten are not.
    const more = server.seedRows(db, 110);
    for (const row of more) await pushElsewhere(server, row.id, 'later');
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(await two.store.dbHold(db)).toMatchObject({ mode: 'partial' });
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({
      rows: 5000,
      rowsHeld: 5000,
      rowsToFetch: 0,
    });
    const after = await two.engine.availableOffline(ws.id);
    expect(more.slice(0, 100).every((r) => after.has(r.id))).toBe(true);
    expect(more.slice(100).filter((r) => after.has(r.id))).toEqual([]);
  });

  it('keeps them fresh (moved heads in one batch), fetches a row given a document later, and after an unpin fetches nothing more and keeps what is held', async () => {
    const asked: Id[][] = [];
    const { server, ws, db, rows, two } = await databaseOfRows(30, {
      bare: (i) => i % 10 === 0,
      device: { api: askedOf(asked) },
    });
    // A subtree pin over the database's page holds them too.
    await two.engine.pin((await two.store.getPage(db))!.parentPageId!, true);
    await untilHeld(two, server, ws.id);
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rows: 27, rowsHeld: 27 });

    // Three held rows edited elsewhere, and a row without a document given one.
    for (const i of [1, 2, 3]) await pushElsewhere(server, rows[i].id, ' edited');
    await pushElsewhere(server, rows[10].id, 'now with words');
    asked.length = 0;
    const singles = server.calls.filter((c) => c === 'pullDoc').length;
    await two.engine.syncOnce();
    expect(asked).toEqual([[rows[1].id, rows[2].id, rows[3].id]]);
    // The one new document alone, by its own route.
    expect(server.calls.filter((c) => c === 'pullDoc').length).toBe(singles + 1);
    expect(await text(two.store, rows[2].id)).toBe('row 2 edited');
    expect(await text(two.store, rows[10].id)).toBe('now with words');
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rows: 28, rowsToFetch: 0 });

    // Unpinned: not counted, nothing new fetched; what is held stays, and is still kept fresh.
    await two.engine.unpin((await two.store.getPage(db))!.parentPageId!);
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ pinned: 0, rows: 0 });
    await pushElsewhere(server, rows[20].id, 'after the unpin');
    await pushElsewhere(server, rows[4].id, ' again');
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    const held = await two.engine.availableOffline(ws.id);
    expect(held.has(rows[20].id)).toBe(false);
    expect(held.has(rows[1].id)).toBe(true);
    expect(await text(two.store, rows[4].id)).toBe('row 4 again');
  });

  it('once every document is held, reads the database whole again only when a changed row lacks its document', async () => {
    class Counting extends MemoryStore {
      reads = 0;
      override readRows(...args: Parameters<MemoryStore['readRows']>) {
        this.reads++;
        return super.readRows(...args);
      }
    }
    const store = new Counting();
    const { server, ws, one, db, rows, two } = await databaseOfRows(40, {
      bare: (i) => i === 39,
      device: { store },
    });
    await two.engine.pin(db);
    await untilHeld(two, server, ws.id);
    await two.engine.syncOnce();
    const settled = store.reads;
    // Values edited elsewhere, and held rows' documents moved: nothing lacks a document.
    await one.engine.syncOnce();
    await one.store.applyLocalOps(
      rows
        .slice(0, 5)
        .map((r) => newOp('row.update', ws.id, r.id, { values: { [PROP.notes]: 'edited' } })),
    );
    await one.engine.syncOnce();
    await pushElsewhere(server, rows[6].id, ' moved');
    await two.engine.syncOnce();
    expect(await text(two.store, rows[6].id)).toBe('row 6 moved');
    expect(store.reads).toBe(settled);
    // A row given its first document: read whole, and fetched; read once more in the next pass,
    // which finds every document held; then nothing again.
    await pushElsewhere(server, rows[39].id, 'first words');
    await two.engine.syncOnce();
    expect(store.reads).toBe(settled + 1);
    expect(await text(two.store, rows[39].id)).toBe('first words');
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(store.reads).toBe(settled + 2);
  });

  it('takes the rest of a batch when one page in it is refused, and asks for that one again only once its record comes anew', async () => {
    const asked: Id[][] = [];
    let victim: Id | null = null;
    const { server, ws, db, rows, two } = await databaseOfRows(6, {
      device: {
        api: (base) => ({
          pullDocs: async (workspaceId, pages) => {
            asked.push(pages.map((p) => p.pageId));
            const answer = await base.pullDocs(workspaceId, pages);
            return answer.map((item) =>
              item.pageId === victim
                ? { pageId: item.pageId, status: 403, code: 'access.denied' }
                : item,
            );
          },
        }),
      },
    });
    victim = rows[2].id;
    await two.engine.pin(db);
    await two.engine.syncOnce();
    expect(two.engine.status.state).toBe('synced');
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rows: 6, rowsHeld: 5 });
    expect((await two.engine.availableOffline(ws.id)).has(victim)).toBe(false);
    // Not asked for again pass after pass.
    asked.length = 0;
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(asked).toEqual([]);
    // Its record comes anew (here, its document moved): asked again (alone, by its own route),
    // and taken.
    victim = null;
    await pushElsewhere(server, rows[2].id, ' and more');
    const singles = server.calls.filter((c) => c === 'pullDoc').length;
    await two.engine.syncOnce();
    expect(asked).toEqual([]);
    expect(server.calls.filter((c) => c === 'pullDoc').length).toBe(singles + 1);
    expect(await text(two.store, rows[2].id)).toBe('row 2 and more');
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rowsToFetch: 0 });
  });

  it('asks again first for the pages an answer deferred (its size cap)', async () => {
    const asked: Id[][] = [];
    // A cap so small that each answer carries one page's updates: the first is always answered.
    const { server, ws, db, rows, two } = await databaseOfRows(5, {
      server: new FakeServer({ pullDocsBytes: 1 }),
      device: { api: askedOf(asked) },
    });
    await two.engine.pin(db);
    await two.engine.syncOnce();
    const ids = rows.map((r) => r.id);
    // Two requests this pass (the database's own page, with no updates, and the first row, then
    // the rest): the second starts with the first's deferred pages, in order.
    expect(asked).toEqual([[db, ...ids], ids.slice(1)]);
    expect(server.batchPulls.slice(0, 2)).toEqual([
      { pages: 6, deferred: 4 },
      { pages: 4, deferred: 3 },
    ]);
    await untilHeld(two, server, ws.id);
    // Each later request starts with what the one before deferred; the last page, alone, by its
    // own route.
    expect(asked.map((a) => a[0])).toEqual([db, ...ids.slice(1, 4)]);
    for (const [i, row] of rows.entries()) expect(await text(two.store, row.id)).toBe(`row ${i}`);
  });

  it("backs off the pins alone for a 429's Retry-After: the rest of the loop syncs meanwhile", async () => {
    const clock = new VirtualClock();
    const { server, ws, a, db, two } = await databaseOfRows(8, { device: { ...clock } });
    await two.engine.pin(db);
    server.throttle('pullDocs', 30_000);
    await two.engine.syncOnce();
    expect(two.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rows: 8, rowsHeld: 0 });
    const asks = () => server.calls.filter((c) => c === 'pullDocs').length;
    const tried = asks();
    // Typing still goes up while the pins wait.
    await append(two.store, a.id, [fakeUpdate(71, 'typed meanwhile')]);
    clock.jump(29_000);
    await two.engine.syncOnce();
    expect(asks()).toBe(tried);
    expect(server.docs.get(a.id)!.rows.some((r) => decode(r.data).text === 'typed meanwhile')).toBe(
      true,
    );
    clock.jump(2000);
    await two.engine.syncOnce();
    expect(asks()).toBe(tried + 1);
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rowsHeld: 8, rowsToFetch: 0 });
  });

  it('goes on from where it stopped when the network goes in the middle, nothing asked twice', async () => {
    let calls = 0;
    const box: { server: FakeServer | null } = { server: null };
    const server = new FakeServer();
    box.server = server;
    const { ws, db, two } = await databaseOfRows(450, {
      server,
      device: {
        api: (base) => ({
          pullDocs: async (workspaceId, pages) => {
            if (++calls === 2) box.server!.offline = true;
            return base.pullDocs(workspaceId, pages);
          },
        }),
      },
    });
    await two.engine.pin(db);
    await expect(two.engine.syncOnce()).rejects.toThrow(OfflineError);
    // The first request: the database's own page and 99 rows.
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rows: 450, rowsHeld: 99 });
    server.offline = false;
    await untilHeld(two, server, ws.id);
    // The request the network took never reached the server: every page was served once.
    expect(server.batchPulls.reduce((n, b) => n + b.pages, 0)).toBe(451);
    expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rowsHeld: 450 });
  });

  it('pulls page by page from a server without the batch route, and never takes its 404 for the workspace gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { server, ws, db, two } = await databaseOfRows(30, {
        device: {
          api: () => ({
            pullDocs: async () => {
              throw new SyncHttpError(404, 'not.found');
            },
          }),
        },
      });
      await two.engine.pin(db);
      await untilHeld(two, server, ws.id);
      expect((await two.store.readMirror(ws.id)).workspaces).toHaveLength(1);
      expect(two.notices()).toEqual([]);
      expect(await two.engine.offlineProgress(ws.id)).toMatchObject({ rows: 30, rowsHeld: 30 });
      // Asked once; from then on one by one (24 a pass), as before Phase 12.
      expect(server.calls.filter((c) => c === 'pullDoc').length).toBeGreaterThanOrEqual(30);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
