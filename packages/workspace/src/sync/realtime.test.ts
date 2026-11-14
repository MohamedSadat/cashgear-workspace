// Phase 6's real-time sync against the in-memory hub (testing/fakeHub.ts) over the fake server: a
// save of an open page goes through the hub and reaches the other device by a relay, with no HTTP
// either way; a gap, an epoch change or an incomplete frame pulls over HTTP; a refusal through the
// hub is the HTTP push's; the socket cut while typing falls back to HTTP with nothing lost; a
// reconnect rejoins and catches up; a reconnect storm spreads out and costs no HTTP when nothing
// changed; the feed's comments and notifications become events and are never stored. Also the
// transport's own half (HubTransport): its reconnect loop, answers and frames.
import { describe, expect, it } from 'vitest';
import { newOp } from '../build';
import { uuidv7, type Id } from '../ids';
import type { MemoryStore } from '../memory';
import { FakeHub } from '../testing/fakeHub';
import { decode, fakeCodec, fakeUpdate, FakeServer } from '../testing/fakeServer';
import {
  ALICE,
  BOB,
  device,
  settle,
  sharedWorkspace,
  VirtualClock,
  type Device,
} from '../testing/syncHarness';
import { OfflineError, SyncHttpError, type Account, type SyncApi } from './api';
import { SyncEngine } from './engine';
import {
  HUB,
  HubTransport,
  answerValue,
  relayFrame,
  wireFrame,
  type HubSocket,
  type RealtimeTransport,
} from './realtime';

const text = async (store: MemoryStore, pageId: Id) => {
  const doc = await store.loadDoc(pageId);
  return [...(doc.snapshot ? [doc.snapshot] : []), ...doc.updates.map((u) => u.data)]
    .map((u) => decode(u).text)
    .join('');
};

const type = async (d: Device, pageId: Id, words: string, client = 501) => {
  const updateId = uuidv7();
  await d.store.appendDocUpdates(pageId, [{ updateId, data: fakeUpdate(client, words) }]);
  d.engine.saved(pageId);
  return updateId;
};

const people = (n: number): Account[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `0193a1b2-c3d4-7e5f-8a9b-1000000000${String(i).padStart(2, '0')}`,
    email: `p${i}@x.test`,
    displayName: `P${i}`,
    deviceId: null,
  }));

/** Counts a device's HTTP calls of each kind. */
function counted(calls: Map<string, number>) {
  return (base: SyncApi): Partial<SyncApi> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(base) as (keyof SyncApi)[]) {
      const method = base[key] as (...args: unknown[]) => Promise<unknown>;
      out[key] = (...args: unknown[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return method(...args);
      };
    }
    return out as Partial<SyncApi>;
  };
}

/**
 * Alice's workspace (Alpha, Beta, Gamma) on the server, Bob a member holding Alpha, each with a
 * transport over one hub, connected and with Alpha open. With a clock, both engines run on it.
 */
async function team(clock?: VirtualClock) {
  const server = new FakeServer({ codec: fakeCodec });
  const hub = new FakeHub(server);
  const timers = clock
    ? { setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now }
    : {};
  const made = await sharedWorkspace(server);
  const aliceCalls = new Map<string, number>();
  const bobCalls = new Map<string, number>();
  const one = device(server, ALICE, {
    store: made.one.store,
    ...timers,
    api: counted(aliceCalls),
  });
  server.addMember(made.ws.id, BOB.id);
  // Alice wrote Alpha's first words earlier: the Yjs client id she types as is registered.
  await one.store.appendDocUpdates(made.a.id, [
    { updateId: uuidv7(), data: fakeUpdate(501, 'Alpha') },
  ]);
  const two = device(server, BOB, { ...timers, api: counted(bobCalls) });
  for (const d of [one, two]) {
    await d.engine.syncOnce();
    await d.engine.pullPage(made.a.id);
  }
  const transports = [one, two].map((d, i) => {
    const transport = hub.transport(i ? BOB : ALICE, { ...timers, random: () => 0.5 });
    d.engine.setRealtime(transport);
    transport.start();
    return transport;
  });
  const engines = [one.engine, two.engine];
  const flush = () => hub.flush(engines);
  await flush();
  for (const d of [one, two]) d.engine.live(made.a.id, true);
  await flush();
  aliceCalls.clear();
  bobCalls.clear();
  server.calls = [];
  server.pushes = [];
  hub.calls = [];
  return { server, hub, ...made, one, two, transports, engines, flush, aliceCalls, bobCalls };
}

/** Fires every timer due within `ms` on the clock, letting the hub and every engine settle. */
async function advance(clock: VirtualClock, hub: FakeHub, engines: SyncEngine[], ms: number) {
  const end = clock.t + ms;
  await hub.flush(engines);
  while (clock.next !== null && clock.next <= end) {
    await clock.fireNext(engines[0]);
    await hub.flush(engines);
  }
  clock.t = end;
}

describe('real-time sync through the hub', () => {
  it('sends a save through the hub at once, and the other device takes it from a relay', async () => {
    const t = await team();
    await type(t.one, t.a.id, ' live');
    await t.flush();
    expect(t.server.pushes.map((p) => p.via)).toEqual(['hub']);
    expect(t.hub.calls).toContain(HUB.pushUpdates);
    // Neither device used HTTP for it: no push, no pull, no pass.
    expect([...t.aliceCalls.keys(), ...t.bobCalls.keys()]).toEqual([]);
    expect(await text(t.two.store, t.a.id)).toContain(' live');
    expect(t.two.events.some((e) => e.kind === 'doc' && e.pageId === t.a.id)).toBe(true);
    expect(await t.one.store.unsentDocUpdates(10)).toEqual([]);
    // Both hold the server's head: Alice's own update came back as hers (its sequence recorded).
    const head = t.server.docs.get(t.a.id)!.rows.at(-1)!.seq;
    expect((await t.one.store.docCursor(t.a.id))!.headSeq).toBe(head);
    expect((await t.two.store.docCursor(t.a.id))!.headSeq).toBe(head);
    expect(t.one.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
    expect(t.one.notices()).toEqual([]);
  });

  it('pulls over HTTP when a frame continues past what the device holds (a gap)', async () => {
    const t = await team();
    t.hub.faults.drop = 1;
    await type(t.one, t.a.id, ' lost');
    await t.flush();
    t.hub.faults.drop = 0;
    expect(await text(t.two.store, t.a.id)).not.toContain(' lost');
    await type(t.one, t.a.id, ' next');
    await t.flush();
    expect(t.bobCalls.get('pullDoc')).toBe(1);
    expect(await text(t.two.store, t.a.id)).toContain(' lost');
    expect(await text(t.two.store, t.a.id)).toContain(' next');
  });

  it('takes duplicated, late and reordered frames as harmless', async () => {
    const t = await team();
    t.hub.faults = { drop: 0, duplicate: 0.5, reorder: 0.3, maxDelay: 6, loseAnswer: 0 };
    for (let i = 0; i < 12; i++) await type(t.one, t.a.id, ` w${i}`);
    await t.flush();
    const server = t.server.docParts(t.a.id).map((p) => decode(p).text);
    const held = await t.two.store.loadDoc(t.a.id);
    // Every update once, each with its sequence, and the cursor at the head.
    expect(held.updates.map((u) => decode(u.data).text).sort()).toEqual([...server].sort());
    expect(new Set(held.updates.map((u) => u.seq)).size).toBe(held.updates.length);
    const head = t.server.docs.get(t.a.id)!.rows.at(-1)!.seq;
    expect((await t.two.store.docCursor(t.a.id))!.headSeq).toBe(head);
  });

  it('pulls a page whose epoch changed, and one whose frame says rows are missing', async () => {
    const t = await team();
    t.server.hardRestore(t.a.id, fakeUpdate(900, 'restored'));
    await t.flush();
    expect(t.bobCalls.get('pullDoc')).toBeGreaterThanOrEqual(1);
    expect(t.two.events.some((e) => e.kind === 'docReset' && e.pageId === t.a.id)).toBe(true);
    expect(await text(t.two.store, t.a.id)).toBe('restored');
    expect(await t.two.store.docCursor(t.a.id)).toMatchObject({ epoch: 1 });

    t.bobCalls.clear();
    t.hub.incomplete(t.a.id);
    await type(t.one, t.a.id, ' after');
    await t.flush();
    expect(t.bobCalls.get('pullDoc')).toBe(1);
    expect(await text(t.two.store, t.a.id)).toContain(' after');
  });

  it("keeps aside the device's own update the worker refused, and never shows it to the other", async () => {
    const t = await team();
    t.server.refuse((u) => decode(u.data).text === ' bad');
    const bad = await type(t.one, t.a.id, ' bad');
    await type(t.one, t.a.id, ' good');
    await t.flush();
    expect(t.one.notices()).toEqual(['doc.refused']);
    expect(t.one.store.corruptUpdates()).toEqual([
      expect.objectContaining({ pageId: t.a.id, reason: 'doc.refused' }),
    ]);
    expect(t.server.docs.get(t.a.id)!.rows.find((r) => r.updateId === bad)?.refused).toBe(true);
    expect(await text(t.one.store, t.a.id)).not.toContain(' bad');
    expect(await text(t.two.store, t.a.id)).toContain(' good');
    expect(await text(t.two.store, t.a.id)).not.toContain(' bad');
    expect(t.two.notices()).toEqual([]);
  });

  it('handles a push the hub refuses as the same refusal over HTTP (edit access gone)', async () => {
    const t = await team();
    t.server.demote(t.ws.id, ALICE.id);
    await type(t.one, t.a.id, ' as a reader');
    await t.flush();
    expect(t.server.pushes).toEqual([]);
    expect(t.one.notices()).toEqual(['access.denied']);
    expect(t.one.events.some((e) => e.kind === 'docReset' && e.pageId === t.a.id)).toBe(true);
    const entries = await t.one.store.quarantine(t.ws.id);
    expect(entries.map((e) => [e.pageId, e.reason])).toEqual([[t.a.id, 'access.denied']]);
    expect(await t.one.store.unsentDocUpdates(10)).toEqual([]);
  });

  it('falls back to HTTP when the socket is cut mid-typing, with nothing lost and no error', async () => {
    const t = await team();
    const ids = [await type(t.one, t.a.id, ' one')];
    await t.flush();
    // The next push is carried out and its answer lost with the socket.
    t.hub.faults.loseAnswer = 1;
    ids.push(await type(t.one, t.a.id, ' two'));
    await t.flush();
    t.hub.faults.loseAnswer = 0;
    t.hub.cut(t.transports[0]);
    await t.flush();
    expect(t.transports[0].state).toBe('disconnected');
    ids.push(await type(t.one, t.a.id, ' three'));
    ids.push(await type(t.one, t.a.id, ' four'));
    // What the loop does next (a pass soon): over HTTP.
    await t.one.engine.syncOnce();
    await t.flush();
    const rows = t.server.docs.get(t.a.id)!.rows;
    // Every update once: the one whose answer was lost was sent again and taken as the same.
    for (const id of ids) expect(rows.filter((r) => r.updateId === id)).toHaveLength(1);
    expect(t.server.pushes.map((p) => p.via)).toEqual(['hub', 'hub', 'http']);
    expect(await t.one.store.unsentDocUpdates(10)).toEqual([]);
    expect(t.one.notices()).toEqual([]);
    expect(t.one.engine.status.state).toBe('synced');
    // Bob saw all of it: by the relay, or by pulling when it skipped what the lost frame had.
    await t.two.engine.syncOnce();
    for (const word of [' one', ' two', ' three', ' four'])
      expect(await text(t.two.store, t.a.id)).toContain(word);
  });

  it('rejoins after a cut and catches up at once, on its own loop', async () => {
    const clock = new VirtualClock();
    const t = await team(clock);
    for (const engine of t.engines) engine.start();
    await advance(clock, t.hub, t.engines, 0);
    t.hub.cut(t.transports[1]);
    await advance(clock, t.hub, t.engines, 0);
    expect(t.transports[1].state).toBe('disconnected');
    for (const word of [' x', ' y', ' z']) await type(t.one, t.a.id, word);
    await t.one.store.applyLocalOps([
      newOp('page.update', t.ws.id, t.c.id, { title: 'Gamma renamed' }),
    ]);
    t.one.engine.changed();
    await advance(clock, t.hub, t.engines, 1000);
    expect(await text(t.two.store, t.a.id)).not.toContain(' x');
    t.hub.restore(t.transports[1]);
    t.hub.calls = [];
    // The retry comes 1 s × the jitter after the cut, then joins the workspace and the page.
    await advance(clock, t.hub, t.engines, 2000);
    expect(t.transports[1].state).toBe('connected');
    expect(t.hub.calls.filter((c) => c === HUB.joinPage)).toHaveLength(1);
    expect(t.hub.calls).toContain(HUB.joinWorkspaces);
    for (const word of [' x', ' y', ' z']) expect(await text(t.two.store, t.a.id)).toContain(word);
    expect((await t.two.store.getPage(t.c.id))!.title).toBe('Gamma renamed');
    for (const engine of t.engines) engine.stop();
  });

  it('runs a pass at once for feed news and access lost, and slows the periodic pass to 30 s', async () => {
    const clock = new VirtualClock();
    const t = await team(clock);
    for (const engine of t.engines) engine.start();
    await advance(clock, t.hub, t.engines, 0);
    // Connected: the next periodic pass is 30 s away.
    const feeds = () => t.bobCalls.get('changes') ?? 0;
    const passes = feeds();
    await advance(clock, t.hub, t.engines, 29_000);
    expect(feeds()).toBe(passes);
    await advance(clock, t.hub, t.engines, 1500);
    expect(feeds()).toBe(passes + 1);
    await t.one.store.applyLocalOps([newOp('page.update', t.ws.id, t.b.id, { title: 'Beta 2' })]);
    t.one.engine.changed();
    await advance(clock, t.hub, t.engines, 1000);
    // Bob's pass came from the hub's ChangesAvailable, not from its timer.
    expect((await t.two.store.getPage(t.b.id))!.title).toBe('Beta 2');

    t.server.revoke(t.ws.id, t.a.id, BOB.id);
    await advance(clock, t.hub, t.engines, 1000);
    expect(t.hub.stats.revoked).toBeGreaterThan(0);
    expect(await t.two.store.getPage(t.a.id)).toBeNull();

    // Disconnected: exactly Phase 3, a pass every 1.5 s.
    t.hub.cut();
    await advance(clock, t.hub, t.engines, 2000);
    expect(t.transports.every((tr) => tr.state === 'disconnected')).toBe(true);
    expect(clock.next! - clock.t).toBeLessThanOrEqual(1500);
    for (const engine of t.engines) engine.stop();
  });

  it('never runs two pushes of one page at once, through the hub or in a pass', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const hub = new FakeHub(server);
    const { one, ws, a } = await sharedWorkspace(server);
    let inFlight = 0;
    let most = 0;
    const slow = async <T>(push: () => Promise<T>): Promise<T> => {
      most = Math.max(most, ++inFlight);
      try {
        for (let i = 0; i < 20; i++) await Promise.resolve();
        return await push();
      } finally {
        inFlight--;
      }
    };
    const d = device(server, ALICE, {
      store: one.store,
      api: (base) => ({ pushDoc: (...args) => slow(() => base.pushDoc(...args)) }),
    });
    const transport = hub.transport(ALICE);
    const wrapped: RealtimeTransport = {
      get state() {
        return transport.state;
      },
      on: (event, listener) => transport.on(event, listener),
      joinWorkspaces: (ids) => transport.joinWorkspaces(ids),
      joinPage: (pageId) => transport.joinPage(pageId),
      leavePage: (pageId) => transport.leavePage(pageId),
      pushDoc: (pageId, request) => slow(() => transport.pushDoc(pageId, request)),
      awareness: (pageId, state) => transport.awareness(pageId, state),
    };
    await d.engine.syncOnce();
    d.engine.setRealtime(wrapped);
    transport.start();
    await hub.flush([d.engine]);
    d.engine.live(a.id, true);
    await hub.flush([d.engine]);
    const passes: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      await d.store.appendDocUpdates(a.id, [{ updateId: uuidv7(), data: fakeUpdate(7, `${i}`) }]);
      d.engine.saved(a.id);
      // While that push is on its way, another save, and a pass that pushes the page over HTTP.
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      await d.store.appendDocUpdates(a.id, [{ updateId: uuidv7(), data: fakeUpdate(7, `+${i}`) }]);
      passes.push(d.engine.syncOnce());
    }
    await Promise.all(passes);
    await hub.flush([d.engine]);
    await d.engine.syncOnce();
    // Both ways were used, and never at once for the page.
    expect(new Set(server.pushes.map((p) => p.via))).toEqual(new Set(['hub', 'http']));
    expect(most).toBe(1);
    expect(await d.store.unsentDocUpdates(10)).toEqual([]);
    expect(server.docs.get(a.id)!.rows.length).toBe(
      new Set(server.docs.get(a.id)!.rows.map((r) => r.updateId)).size,
    );
    expect(ws.id).toBeTruthy();
  });

  it('spreads a reconnect storm out, rejoins everyone, and costs no HTTP when nothing changed', async () => {
    const clock = new VirtualClock();
    const server = new FakeServer({ codec: fakeCodec });
    const hub = new FakeHub(server);
    const { ws, a } = await sharedWorkspace(server);
    const crowd = people(16);
    const calls = new Map<string, number>();
    const devices = [];
    let seed = 1;
    for (const person of crowd) {
      server.addMember(ws.id, person.id);
      const d = device(server, person, {
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        now: clock.now,
        api: counted(calls),
      });
      await d.engine.syncOnce();
      await d.engine.pullPage(a.id);
      // Each device's own jitter.
      const r = seed++ / (crowd.length + 1);
      const transport = hub.transport(person, {
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        random: () => r,
      });
      d.engine.setRealtime(transport);
      transport.start();
      devices.push({ d, transport });
    }
    const engines = devices.map((x) => x.d.engine);
    await hub.flush(engines);
    for (const { d } of devices) d.engine.live(a.id, true);
    await hub.flush(engines);
    for (const engine of engines) engine.start();
    await advance(clock, hub, engines, 0);
    expect(hub.presence(a.id)).toHaveLength(crowd.length);

    calls.clear();
    const connectedAt: number[] = [];
    for (const { transport } of devices)
      transport.on('state', (state) => state === 'connected' && connectedAt.push(clock.t));
    const before = clock.t;
    hub.storm();
    await advance(clock, hub, engines, 2000);
    expect(devices.every(({ transport }) => transport.state === 'connected')).toBe(true);
    expect(hub.presence(a.id)).toHaveLength(crowd.length);
    // Back between 0.5 and 1 s after the drop, each at its own moment.
    expect(new Set(connectedAt).size).toBe(crowd.length);
    expect(Math.min(...connectedAt) - before).toBeGreaterThanOrEqual(500);
    expect(Math.max(...connectedAt) - before).toBeLessThanOrEqual(1000);
    // Nothing had changed: no device asked the server anything over HTTP.
    expect([...calls.values()].reduce((n, c) => n + c, 0)).toBe(0);

    // Then one types: everyone has it from the relay, still with no HTTP.
    await devices[0].d.store.appendDocUpdates(a.id, [
      { updateId: uuidv7(), data: fakeUpdate(11, ' after the storm') },
    ]);
    devices[0].d.engine.saved(a.id);
    await advance(clock, hub, engines, 100);
    for (const { d } of devices) expect(await text(d.store, a.id)).toContain(' after the storm');
    expect(calls.get('pullDoc') ?? 0).toBe(0);
    expect(calls.get('pushDoc') ?? 0).toBe(0);

    // A storm while something changed: everyone catches up when they are back.
    hub.cut();
    await advance(clock, hub, engines, 100);
    await server.api(ALICE).pushDoc(a.id, {
      epoch: 0,
      clientSchemaVersion: 1,
      updates: [{ updateId: uuidv7(), data: fakeUpdate(12, ' while away') }],
    });
    hub.restore();
    await advance(clock, hub, engines, 3000);
    for (const { d } of devices) expect(await text(d.store, a.id)).toContain(' while away');
    for (const engine of engines) engine.stop();
  });

  it('tells of comments and notifications from the feed, and never stores them', async () => {
    const t = await team();
    const before = await t.two.store.readMirror(t.ws.id);
    t.server.commentsChanged(t.ws.id, t.a.id);
    t.server.commentsChanged(t.ws.id, t.a.id);
    t.server.notified(t.ws.id, BOB.id);
    t.server.notified(t.ws.id, ALICE.id);
    t.server.revoke(t.ws.id, t.c.id, BOB.id);
    t.server.commentsChanged(t.ws.id, t.c.id);
    await t.two.engine.syncOnce();
    const told = t.two.events.filter((e) => e.kind === 'comments' || e.kind === 'notifications');
    expect(told).toEqual([
      { kind: 'comments', workspaceId: t.ws.id, pageId: t.a.id },
      { kind: 'notifications', workspaceId: t.ws.id },
    ]);
    const after = await t.two.store.readMirror(t.ws.id);
    expect(after.pages.filter((p) => p.id !== t.c.id)).toEqual(
      before.pages.filter((p) => p.id !== t.c.id),
    );
    expect(t.two.events.some((e) => e.kind === 'members')).toBe(false);
  });

  it('is the Phase 3 engine while the transport is disconnected: saves go over HTTP', async () => {
    const server = new FakeServer({ codec: fakeCodec });
    const hub = new FakeHub(server);
    const { one, a } = await sharedWorkspace(server);
    hub.cut();
    const transport = hub.transport(ALICE, { setTimer: () => null });
    one.engine.setRealtime(transport);
    transport.start();
    await hub.flush([one.engine]);
    one.engine.live(a.id, true);
    await type(one, a.id, ' offline hub');
    expect(one.engine.status.state).toBe('syncing');
    await one.engine.syncOnce();
    expect(server.pushes.map((p) => p.via)).toEqual(['http']);
    expect(hub.calls).toEqual([]);
    expect(one.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
  });

  it('joins a page made here once the server has it, and leaves a page closed', async () => {
    const t = await team();
    const made = {
      ...(await t.one.store.getPage(t.c.id))!,
      id: uuidv7(),
      title: 'New',
      orderKey: 'a9',
    };
    await t.one.store.applyLocalOps([newOp('page.create', t.ws.id, made.id, made)]);
    await t.one.store.appendDocUpdates(made.id, [
      { updateId: uuidv7(), data: fakeUpdate(501, 'first') },
    ]);
    t.one.engine.live(made.id, true);
    await t.flush();
    // Not on the server yet: not joined (nothing was asked of the hub for it).
    expect(t.hub.presence(made.id)).toEqual([]);
    await t.one.engine.syncOnce();
    await t.flush();
    expect(t.hub.presence(made.id)).toEqual([ALICE.id]);
    t.one.engine.live(made.id, false);
    await t.flush();
    expect(t.hub.presence(made.id)).toEqual([]);
    expect(t.hub.calls).toContain(HUB.leavePage);
  });
});

describe('the hub transport', () => {
  /** A socket the test drives. */
  function socket() {
    const handlers = new Map<string, (payload: unknown) => void>();
    let close: (() => void) | null = null;
    const invoked: { method: string; args: unknown[] }[] = [];
    let answer: (method: string, args: unknown[]) => unknown = () => ({ ok: true, value: {} });
    const s: HubSocket = {
      invoke: async (method, ...args) => {
        invoked.push({ method, args });
        return answer(method, args);
      },
      on: (event, handler) => void handlers.set(event, handler),
      onClose: (handler) => void (close = handler),
      close: async () => close?.(),
    };
    return {
      s,
      invoked,
      emit: (event: string, payload: unknown) => handlers.get(event)?.(payload),
      drop: () => close?.(),
      answer: (fn: typeof answer) => (answer = fn),
    };
  }

  it('waits 1 s doubling to 30 s between failures, with jitter, and tries at once when asked', async () => {
    const waits: number[] = [];
    let fire: (() => void) | null = null;
    let opens = 0;
    for (const jitter of [0, 0.999]) {
      waits.length = 0;
      const transport = new HubTransport({
        open: async () => {
          opens++;
          throw new OfflineError();
        },
        setTimer: (fn, ms) => {
          waits.push(ms);
          fire = fn;
          return fn;
        },
        clearTimer: () => undefined,
        random: () => jitter,
      });
      transport.start();
      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
        await Promise.resolve();
        fire!();
      }
      await Promise.resolve();
      transport.stop();
      const expected = [1, 2, 4, 8, 16, 30, 30, 30].map((s) => s * 1000 * (0.5 + 0.5 * jitter));
      expect(waits.slice(0, 8).map(Math.round)).toEqual(expected.map(Math.round));
    }
    expect(opens).toBeGreaterThan(8);

    // `retryNow` opens at once; a 429's Retry-After is the least wait.
    const sockets: ReturnType<typeof socket>[] = [];
    let refuse = true;
    const timers: number[] = [];
    const transport = new HubTransport({
      open: async () => {
        if (refuse) throw new SyncHttpError(429, 'limit.rate', undefined, 45_000);
        const made = socket();
        sockets.push(made);
        return made.s;
      },
      setTimer: (_fn, ms) => timers.push(ms),
      clearTimer: () => undefined,
      random: () => 0,
    });
    const states: string[] = [];
    transport.on('state', (s) => states.push(s));
    transport.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(timers).toEqual([45_000]);
    refuse = false;
    transport.retryNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.state).toBe('connected');
    expect(states).toEqual(['connecting', 'disconnected', 'connecting', 'connected']);
    // A drop: disconnected, and the backoff starts again at 1 s.
    sockets[0].drop();
    expect(transport.state).toBe('disconnected');
    expect(timers.at(-1)).toBe(500);
    transport.stop();
  });

  it('turns answers into values or SyncHttpError, and carries bytes as base64', async () => {
    const made = socket();
    const transport = new HubTransport({ open: async () => made.s });
    transport.start();
    await Promise.resolve();
    await Promise.resolve();
    made.answer((method) =>
      method === HUB.pushUpdates
        ? { ok: true, value: { acks: [{ updateId: 'u1', seq: '7' }], headSeq: 7 } }
        : { ok: false, status: 409, code: 'doc.epochMismatch', title: 'Epoch', retryAfterMs: 5 },
    );
    const answer = await transport.pushDoc('p', {
      epoch: 0,
      clientSchemaVersion: 5,
      updates: [{ updateId: 'u1', data: new Uint8Array([1, 2, 255]) }],
    });
    expect(answer).toEqual({ acks: [{ updateId: 'u1', seq: 7 }], headSeq: 7 });
    expect(made.invoked[0]).toEqual({
      method: HUB.pushUpdates,
      args: [
        'p',
        { epoch: 0, clientSchemaVersion: 5, updates: [{ updateId: 'u1', data: 'AQL/' }] },
      ],
    });
    const refusal = await transport.joinPage('p').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SyncHttpError);
    expect(refusal).toMatchObject({ status: 409, code: 'doc.epochMismatch', retryAfterMs: 5 });
    expect(() => answerValue({ nonsense: true })).toThrow(SyncHttpError);

    // Frames arrive decoded; a malformed one is dropped.
    const frames: unknown[] = [];
    transport.on('updates', (f) => frames.push(f));
    const frame = {
      pageId: 'p',
      epoch: 0,
      after: 1,
      cursor: 2,
      headSeq: 2,
      updates: [{ seq: 2, updateId: 'u2', data: new Uint8Array([9, 8]) }],
      rejected: [],
      complete: true,
    };
    made.emit(HUB.updates, wireFrame(frame));
    made.emit(HUB.updates, { ...wireFrame(frame), cursor: 'x' });
    expect(frames).toEqual([frame]);
    expect(
      relayFrame({ ...wireFrame(frame), updates: [{ seq: 2, updateId: 'u', data: '%%' }] }),
    ).toBe(null);
    // Not connected: calls fail as unreachable; awareness is dropped.
    transport.stop();
    await expect(transport.joinPage('p')).rejects.toBeInstanceOf(OfflineError);
    const sent = made.invoked.length;
    transport.awareness('p', null);
    expect(made.invoked.length).toBe(sent);
  });

  it('settles a device that typed while connected when its last update is sent', async () => {
    const t = await team();
    t.one.engine.saved(t.a.id);
    await settle(t.one.engine);
    expect(t.one.engine.status.state).toBe('synced');
  });
});
