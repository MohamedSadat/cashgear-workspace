// The database host's part in a paste (Phase 8, M8.3): the batch the views send (here sixty rows
// added with their titles, as a paste past the last row adds them) goes through the session as one
// change, the rows show at once, and their titles are put in the search index afterwards, one at a
// time, without the paste waiting for it.
import { MemoryStore, type Operation } from '@cgw/workspace';
import { describe, expect, it, vi } from 'vitest';
import { localWorkspace } from '../../../workspace/src/testing/syncHarness';
import { WorkspaceSession } from '../session';
import { ShellDatabaseHost } from './host';
import { emptyRowsOps, newDatabaseOps } from './make';

describe('a paste through the database host', { timeout: 30_000 }, () => {
  it('is one change of the session, and its titles are indexed after it', async () => {
    const store = new MemoryStore();
    const made = await localWorkspace(store);
    const session = await WorkspaceSession.start(store);
    session.switchTo(made.ws.id);
    const host = new ShellDatabaseHost({ session });
    const database = newDatabaseOps(
      { workspaceId: made.ws.id, sectionId: made.section.id, parentPageId: null, orderKey: 'a5' },
      { title: 'Name', table: 'Table' },
    );
    await host.apply(database.ops);
    const rows = emptyRowsOps(
      { id: database.databaseId, workspaceId: made.ws.id, sectionId: made.section.id },
      60,
      { after: host.rowOrderKey(database.databaseId, 'end') },
    ).map(
      (op, i) =>
        ({
          ...op,
          payload: { ...(op.payload as object), title: `Pasted ${i}` },
        }) as Operation,
    );
    const apply = vi.spyOn(session, 'apply');
    const index = vi.spyOn(session, 'indexPage').mockResolvedValue(undefined);
    await host.apply(rows);
    expect(apply).toHaveBeenCalledTimes(1);
    // Shown at once: every row is in the mirror once the change resolved.
    const titles = new Set(host.rowList(database.databaseId).map((r) => r.title));
    for (let i = 0; i < 60; i++) expect(titles.has(`Pasted ${i}`)).toBe(true);
    // The titles go to the search index afterwards, every one of them, one at a time.
    expect(index).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(index).toHaveBeenCalledTimes(60), { timeout: 10_000 });
    expect(new Set(index.mock.calls.map(([id]) => id))).toEqual(
      new Set(rows.map((op) => op.entityId)),
    );
    host.dispose();
  });
});
