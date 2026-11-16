// Phase 8: an operation the server refuses is named in its notice (`refused`: the operation's type,
// and the fields an update set), so the app can say what was undone; a page's document refused
// for lost access carries no such name (its edits are set aside as a recovered page).
import { describe, expect, it } from 'vitest';
import { newOp } from '../build';
import { uuidv7 } from '../ids';
import { FakeServer } from '../testing/fakeServer';
import { ALICE, sharedWorkspace } from '../testing/syncHarness';
import type { SyncEvent } from './engine';

const notices = (events: SyncEvent[]) => events.flatMap((e) => (e.kind === 'notice' ? [e] : []));

describe('a refused operation, named in its notice', () => {
  it("a cover the server does not hold: the page, and the update's fields", async () => {
    const server = new FakeServer();
    const { one, ws, a } = await sharedWorkspace(server);
    const page = (await one.store.readMirror(ws.id)).pages.find((p) => p.id === a.id)!;
    // An asset id this device does not hold either, so nothing uploads it first.
    await one.store.applyLocalOps([
      newOp('page.update', ws.id, a.id, { coverAssetId: uuidv7() }, page.version),
    ]);
    await one.engine.syncOnce();
    expect(notices(one.events)).toEqual([
      {
        kind: 'notice',
        code: 'access.denied',
        workspaceId: ws.id,
        pageId: a.id,
        refused: { type: 'page.update', fields: ['coverAssetId'] },
      },
    ]);
    // Taken back: the page as the server has it.
    const after = (await one.store.readMirror(ws.id)).pages.find((p) => p.id === a.id)!;
    expect(after.coverAssetId).toBeNull();
  });

  it("a reader's changes: each named, a move without fields", async () => {
    const server = new FakeServer();
    const { one, ws, a, c } = await sharedWorkspace(server);
    const mirror = await one.store.readMirror(ws.id);
    const alpha = mirror.pages.find((p) => p.id === a.id)!;
    const gamma = mirror.pages.find((p) => p.id === c.id)!;
    // Alice made a reader of her workspace: every edit is refused for access.
    server.spaces.get(ws.id)!.readers.add(ALICE.id);
    await one.store.applyLocalOps([
      newOp('page.update', ws.id, a.id, { title: 'Renamed' }, alpha.version),
      newOp(
        'page.move',
        ws.id,
        c.id,
        { sectionId: gamma.sectionId, parentPageId: a.id, orderKey: 'a5' },
        gamma.version,
      ),
    ]);
    await one.engine.syncOnce();
    const refused = notices(one.events).map((n) => [n.code, n.pageId, n.refused]);
    expect(refused).toContainEqual([
      'access.denied',
      a.id,
      { type: 'page.update', fields: ['title'] },
    ]);
    expect(refused).toContainEqual(['access.denied', c.id, { type: 'page.move' }]);
  });
});
