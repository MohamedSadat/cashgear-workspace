// Which entities have operations waiting in the outbox: what the remote planners ask
// (RemoteReader.pending). The desktop plans in TypeScript against its in-memory mirror, so it keeps
// this beside the mirror: loaded at open (the store's outboxIndex request) and moved with every
// write that adds, settles or replaces operations.
import type { Id } from '@cgw/workspace';

export interface OutboxEntry {
  opId: Id;
  workspaceId: Id;
  entityId: Id;
}

export class OutboxIndex {
  private readonly ops = new Map<Id, OutboxEntry>();
  private readonly byEntity = new Map<Id, Set<Id>>();

  constructor(entries: Iterable<OutboxEntry> = []) {
    this.add(entries);
  }

  add(entries: Iterable<OutboxEntry>) {
    for (const { opId, workspaceId, entityId } of entries) {
      this.ops.set(opId, { opId, workspaceId, entityId });
      let ids = this.byEntity.get(entityId);
      if (!ids) this.byEntity.set(entityId, (ids = new Set()));
      ids.add(opId);
    }
  }

  remove(opIds: Iterable<Id>) {
    for (const opId of opIds) {
      const entry = this.ops.get(opId);
      if (!entry) continue;
      this.ops.delete(opId);
      const ids = this.byEntity.get(entry.entityId);
      ids?.delete(opId);
      if (ids && !ids.size) this.byEntity.delete(entry.entityId);
    }
  }

  removeWorkspace(workspaceId: Id) {
    this.remove(
      [...this.ops.values()].filter((e) => e.workspaceId === workspaceId).map((e) => e.opId),
    );
  }

  /** Whether an operation on this entity waits, leaving out the ones in `except`. */
  pending(entityId: Id, except?: ReadonlySet<Id>): boolean {
    for (const opId of this.byEntity.get(entityId) ?? []) if (!except?.has(opId)) return true;
    return false;
  }
}
