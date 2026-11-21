// Workspaces on a shared device (2026-11-21): a signed-in account is shown its own synced
// workspaces and those kept "on this device only", never another account's left by a sign-out;
// signed out, only the local ones.
import { ACCOUNT_PREF, MemoryStore } from '@cgw/workspace';
import { describe, expect, it } from 'vitest';
import { ALICE, BOB, localWorkspace } from '../../workspace/src/testing/syncHarness';
import { shownTo, WorkspaceSession } from './session';

async function device() {
  const store = new MemoryStore();
  const local = (await localWorkspace(store)).ws;
  const alice = (await localWorkspace(store)).ws;
  await store.beginUpload(alice.id, ALICE.id, []);
  const bob = (await localWorkspace(store)).ws;
  await store.beginUpload(bob.id, BOB.id, []);
  return { store, local: local.id, alice: alice.id, bob: bob.id };
}

const ids = (session: WorkspaceSession) =>
  session
    .workspaces()
    .map((w) => w.id)
    .sort();

describe('whose workspaces are shown', () => {
  it('shows the account signed in last from the start, and follows the account after', async () => {
    const { store, local, alice, bob } = await device();
    await store.setPref(ACCOUNT_PREF, ALICE);
    const session = await WorkspaceSession.start(store);
    expect(ids(session)).toEqual([local, alice].sort());
    expect([local, alice]).toContain(session.workspaceId);

    // Bob's workspace is not opened, by the switcher or a link.
    const before = session.workspaceId;
    session.switchTo(bob);
    expect(session.workspaceId).toBe(before);
    expect(session.shows(bob)).toBe(false);

    // Bob signs in here: his workspace and the local one; Alice's goes from view.
    session.switchTo(alice);
    session.setViewer(BOB.id);
    expect(ids(session)).toEqual([local, bob].sort());
    expect(session.workspaceId).not.toBe(alice);
    expect(session.current?.id).not.toBe(alice);

    // Signed out: only what is kept on this device only.
    session.setViewer(null);
    expect(ids(session)).toEqual([local]);
    expect(session.workspaceId).toBe(local);
  });

  it('shows nobody a synced workspace when no one is signed in, and nobody a deleted one', async () => {
    const { store, local, alice } = await device();
    const session = await WorkspaceSession.start(store);
    expect(ids(session)).toEqual([local]);
    const record = session.mirror.workspaces.get(alice)!;
    expect(shownTo(record, ALICE.id)).toBe(true);
    expect(shownTo(record, null)).toBe(false);
    expect(shownTo({ ...record, deletedAt: new Date().toISOString() }, ALICE.id)).toBe(false);
  });
});
