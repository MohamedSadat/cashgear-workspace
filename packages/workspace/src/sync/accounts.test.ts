// An account's data on a shared device (2026-11-21): a sign-out may remove the account's synced
// workspaces from the device, but only once nothing of theirs waits to be sent, never while it is
// signed in, and never anything kept "on this device only" or another account's.
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../ids';
import { fakeUpdate, FakeServer } from '../testing/fakeServer';
import {
  ALICE,
  BOB,
  device,
  localWorkspace,
  sharedWorkspace,
  VirtualClock,
} from '../testing/syncHarness';

describe("removing an account's workspaces from this device", () => {
  it('waits for what is unsent, refuses while signed in, and leaves the rest', async () => {
    const server = new FakeServer();
    const { one, ws, a } = await sharedWorkspace(server);
    const mine = await localWorkspace(one.store);
    // Bob signed in on the same device before, with a workspace of his own.
    const bob = device(server, BOB, { store: one.store });
    const theirs = await localWorkspace(one.store);
    await bob.engine.upload(theirs.ws.id);
    await bob.engine.syncOnce();
    bob.engine.setAccount(null);

    // Typed and not sent yet: nothing is removed.
    await one.store.appendDocUpdates(a.id, [{ updateId: uuidv7(), data: fakeUpdate(7, 'x') }]);
    one.engine.setAccount(null);
    expect(await one.engine.accountWaiting(ALICE.id)).toBe(1);
    expect(await one.engine.removeAccountData(ALICE.id)).toEqual({ removed: [], waiting: 1 });
    expect((await one.store.readMirror(null)).workspaces.map((w) => w.id)).toContain(ws.id);

    // Sent, and still signed in: refused.
    one.engine.setAccount(ALICE);
    await one.engine.syncOnce();
    expect(await one.engine.accountWaiting(ALICE.id)).toBe(0);
    await expect(one.engine.removeAccountData(ALICE.id)).rejects.toThrow();

    one.engine.setAccount(null);
    expect(await one.engine.removeAccountData(ALICE.id)).toEqual({ removed: [ws.id], waiting: 0 });
    const after = await one.store.readMirror(null);
    expect(after.workspaces.map((w) => w.id).sort()).toEqual([mine.ws.id, theirs.ws.id].sort());
    expect(after.pages.some((p) => p.workspaceId === ws.id)).toBe(false);
    const doc = await one.store.loadDoc(a.id);
    expect(doc.snapshot).toBeNull();
    expect(doc.updates).toEqual([]);
    // On the server it is all still there.
    expect(server.spaces.get(ws.id)!.mirror.pages.get(a.id)).toBeDefined();

    // Signing in again brings it back at the first pass.
    one.engine.setAccount(ALICE);
    await one.engine.syncOnce();
    expect((await one.store.readMirror(null)).workspaces.map((w) => w.id)).toContain(ws.id);
  });

  it('remembers the account through a 401 (its workspaces stay shown), and forgets it at a sign-out', async () => {
    const server = new FakeServer();
    const clock = new VirtualClock();
    const { one } = await sharedWorkspace(server);
    const two = device(server, ALICE, { store: one.store, ...clock });
    two.engine.start();
    await clock.advance(two.engine, 0);
    server.expire(ALICE.id);
    two.engine.kick(0);
    await clock.advance(two.engine, 0);
    expect(two.engine.signedIn).toBeNull();
    expect(two.engine.remembered).toEqual(ALICE);
    two.engine.setAccount(null);
    expect(two.engine.remembered).toBeNull();
    two.engine.stop();
  });
});
